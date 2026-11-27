// GST return filing reports (status review 7, item 11).
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/gst-return-filing.test.ts
//
// What the auditors test, from the books' side:
//   · GSTR-1 carries every table, deemed exports as DE, the e-commerce tables,
//     and ties to the sales register and the output-tax ledger to the paisa;
//   · its file is the portal's: fp MMYYYY, dates dd-mm-yyyy, two decimals;
//   · a document of a filed return changed afterwards is reported as an
//     amendment (9A) in the next one, and GSTR-3B declares its difference;
//   · marking a return filed keeps it as filed, can lock the period, and the
//     posting engine then refuses a document dated in it;
//   · GSTR-2B claim decisions move credit between months, in the form and in
//     the summary alike, and are refused against a filed GSTR-3B;
//   · table 6.1 posted as set-off and cash clears the GST ledgers, and the
//     GSTR-3B tie-out with the ledger has nothing unexplained;
//   · the late fee and interest are estimated once a return is late.

import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { createInvoice, updateInvoice, type CreateInvoiceInput } from '../../lib/server/services/sales';
import { createBill } from '../../lib/server/services/purchases';
import { gstr1Build, gstr1PortalFile } from '../../lib/server/gst/gstr1-json';
import { gstr1Amendments } from '../../lib/server/gst/gstr1-amendments';
import { gstr1Report } from '../../lib/server/gst/gstr1-report';
import { gstr3bForm, gstr3bPortalJson } from '../../lib/server/gst/gstr3b-form';
import { gstr3b } from '../../lib/server/gst/returns';
import { gstr3bChecks, reconciliation } from '../../lib/server/gst/gstr3b-checks';
import { deleteGstr3bPayment, gstr3bPaymentFor, recordGstr3bPayment } from '../../lib/server/gst/gstr3b-payment';
import { setClaimDecision } from '../../lib/server/gst/itc-claims';
import { filingStatus, markFiled, unmarkFiled } from '../../lib/server/gst/filing';
import { monthlyLateFee, periodEnd } from '../../lib/gst/filing';
import { toPaiseFromSql } from '../../lib/server/money-sql';
import { gstinCheckChar } from '../../lib/gst/withholding';

const gstin = (first14: string) => first14 + gstinCheckChar(first14);
const TODAY = '2026-11-27';

interface Fixture {
  trx: Trx; orgId: number; branchId: number; bankId: number;
  buyer: number; consumer: number; eou: number; vendor: number; vendor2: number;
  acc: Record<string, number>;
}

test.after(() => db.destroy());

async function withFixture(fn: (f: Fixture) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Return Filing Test Co', aato_above_5cr: 0 }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1, gstin: gstin('33AABCR1234R1Z') }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const acc = await accountIds(trx, orgId);
      const bankId = Number((await trx.insertInto('bank_accounts').values({ org_id: orgId, kind: 'bank', name: 'Current', ledger_account_id: acc[CODE.BANK_DEFAULT], opening_balance: '0.0000' }).executeTakeFirstOrThrow()).insertId);
      const mk = async (values: Record<string, unknown>) =>
        Number((await trx.insertInto('contacts').values({ org_id: orgId, ...values } as never).executeTakeFirstOrThrow()).insertId);
      await fn({
        trx, orgId, branchId, bankId, acc,
        buyer: await mk({ kind: 'customer', display_name: 'Local Buyer', gst_treatment: 'registered', state_code: '33', gstin: gstin('33AAACL1111L1Z') }),
        consumer: await mk({ kind: 'customer', display_name: 'Walk-in', gst_treatment: 'consumer', state_code: '33' }),
        eou: await mk({ kind: 'customer', display_name: 'An EOU', gst_treatment: 'deemed_export', state_code: '33', gstin: gstin('33AAACE2222E1Z') }),
        vendor: await mk({ kind: 'vendor', display_name: 'Supplier', gst_treatment: 'registered', state_code: '33', gstin: gstin('33AAACS3333S1Z') }),
        vendor2: await mk({ kind: 'vendor', display_name: 'Supplier Two', gst_treatment: 'registered', state_code: '33', gstin: gstin('33AAACT4444T1Z') }),
      });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

const line = (rupees: number, rate = 18, qty = 1) => ({ description: 'Brake pad set', hsnSac: '870830', qty, ratePaise: (rupees / qty) * 100, gstRatePct: rate });
const sell = (f: Fixture, customerId: number, date: string, lines: CreateInvoiceInput['lines'], extra: Partial<CreateInvoiceInput> = {}) =>
  createInvoice(f.trx, f.orgId, null, { branchId: f.branchId, customerId, date, dueDate: date, status: 'approved', lines, ...extra });
const buy = (f: Fixture, vendorId: number, no: string, date: string, rupees: number) =>
  createBill(f.trx, f.orgId, null, { branchId: f.branchId, vendorId, vendorInvoiceNo: no, date, dueDate: date, lines: [{ description: 'Stock', hsnSac: '870830', qty: 1, ratePaise: rupees * 100, gstRatePct: 18 }] });
const ledger = async (f: Fixture, codes: string[], from: string, to: string) => {
  const { rows: [r] } = await sql<{ v: string }>`
    SELECT COALESCE(SUM(jl.credit - jl.debit), 0) AS v FROM journal_lines jl JOIN journal_entries e ON e.id = jl.entry_id JOIN accounts a ON a.id = jl.account_id
     WHERE e.org_id = ${f.orgId} AND a.code IN (${sql.join(codes)}) AND e.entry_date BETWEEN ${from} AND ${to}`.execute(f.trx);
  return toPaiseFromSql(r.v);
};

/** Every number in a JSON tree has at most two decimals. */
const twoDecimals = (v: unknown): boolean => {
  if (typeof v === 'number') return Math.abs(v * 100 - Math.round(v * 100)) < 1e-6;
  if (Array.isArray(v)) return v.every(twoDecimals);
  if (v && typeof v === 'object') return Object.values(v).every(twoDecimals);
  return true;
};
const dates = (v: unknown, out: string[] = []): string[] => {
  if (Array.isArray(v)) v.forEach((x) => dates(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (/dt$/.test(k) && typeof x === 'string') out.push(x); else dates(x, out); }
  return out;
};

test('GSTR-1: deemed export as DE, the e-commerce tables, and the portal file\'s formats', async () => {
  await withFixture(async (f) => {
    await sell(f, f.eou, '2026-09-04', [line(10_000)]);
    await sell(f, f.consumer, '2026-09-05', [line(2_000)], { eco: { gstin: gstin('29AAICM9032Q1C'), section: '52' } });
    await sell(f, f.consumer, '2026-09-06', [{ ...line(5_000), hsnSac: '998533' }], { eco: { gstin: gstin('29AAFCU5512R1C'), section: '9_5' } });

    const { file, docs } = await gstr1Build(f.trx, f.orgId, '2026-09');
    const b2b = file.b2b as { ctin: string; inv: { inv_typ: string; idt: string }[] }[];
    assert.equal(b2b.length, 1);
    assert.equal(b2b[0].inv[0].inv_typ, 'DE', 'a supply to an EOU is a deemed export');
    const supeco = file.supeco as { clttx: { suppval: number; cgst: number }[]; paytx: { suppval: number; cgst: number; sgst: number }[] };
    assert.equal(supeco.clttx[0].suppval, 2_000, '14(a): the operator collected TCS');
    assert.equal(supeco.paytx[0].suppval, 5_000, '14(b): the operator pays the tax');
    assert.equal(supeco.paytx[0].cgst + supeco.paytx[0].sgst, 900, 'the tax the operator pays, at the line rate');
    assert.equal(docs.find((d) => d.section === 'eco95')?.taxablePaise, 5_000_00, 'a s.9(5) supply is in table 14(b) only');
    const inv95 = await f.trx.selectFrom('invoices').select(['cgst', 'sgst', 'total']).where('org_id', '=', f.orgId).where('eco_section', '=', '9_5').executeTakeFirstOrThrow();
    assert.equal(toPaiseFromSql(inv95.cgst) + toPaiseFromSql(inv95.sgst), 0, 'the s.9(5) invoice charges no GST');

    assert.equal(file.fp, '092026', 'fp is MMYYYY');
    assert.ok(dates(file).every((d) => /^\d{2}-\d{2}-\d{4}$/.test(d)), 'every date is dd-mm-yyyy');
    assert.ok(twoDecimals(file), 'every amount to two decimals');

    const form = await gstr3bForm(f.trx, f.orgId, '2026-09', { today: TODAY });
    assert.equal(form.rows['3.1.1ii'].taxablePaise, 5_000_00, 'GSTR-3B 3.1.1(ii)');
    assert.equal(form.rows['3.1a'].taxablePaise, 12_000_00, 'the s.9(5) supply is not in 3.1(a)');
    assert.equal(gstr3bPortalJson(form).ret_period, '092026');
  });
});

test('GSTR-1 ties to the sales register and the output-tax ledger to the paisa', async () => {
  await withFixture(async (f) => {
    await sell(f, f.buyer, '2026-08-03', [line(10_000)]);
    await sell(f, f.consumer, '2026-08-04', [line(3_000, 5)]);
    await sell(f, f.buyer, '2026-08-05', [line(1_000)], { reverseCharge: true });
    const r = await gstr1Report(f.trx, f.orgId, '2026-08');
    assert.equal(r.tables.b2b.rows.length, 2);
    assert.equal(r.tables.b2cs.rows.length, 1);
    assert.ok(r.tables.b2b.rows.some((x) => x.reverseCharge), 'reverse charge marked');
    assert.equal(r.tieOut.register[0].differencePaise, 0, 'taxable value agrees');
    // Reverse charge: the return carries the tax the buyer pays, the invoice none — named as the reason.
    assert.equal(r.tieOut.register[2].differencePaise, 90_00);
    assert.equal(r.tieOut.registerReasons.length, 1);
    assert.match(r.tieOut.registerReasons[0].reason, /Reverse charge/);
    assert.ok(r.tieOut.ledger.every((l) => l.differencePaise === 0), 'output tax in the ledger agrees head by head');
    assert.equal(r.tieOut.tied, true);
  });
});

test('a filed GSTR-1 invoice changed afterwards is an amendment next month, and GSTR-3B declares the difference', async () => {
  await withFixture(async (f) => {
    const inv = await sell(f, f.buyer, '2026-08-10', [line(10_000)]);
    const r = await markFiled(f.trx, f.orgId, null, { returnType: 'gstr1', period: '2026-08', filedOn: '2026-09-10', arn: 'AA330826000001A' }, TODAY);
    assert.equal(r.kept, 1, 'its document kept as filed');
    assert.equal((await gstr1Amendments(f.trx, f.orgId, '2026-09')).rows.length, 0, 'nothing changed yet');

    await updateInvoice(f.trx, f.orgId, null, inv.id, { branchId: f.branchId, customerId: f.buyer, date: '2026-08-10', dueDate: '2026-08-10', status: 'approved', lines: [line(12_000)] });
    const a = await gstr1Amendments(f.trx, f.orgId, '2026-09');
    assert.equal(a.rows.length, 1);
    assert.equal(a.rows[0].kind, 'b2ba');
    assert.equal(a.rows[0].before.taxablePaise, 10_000_00);
    assert.equal(a.rows[0].after.taxablePaise, 12_000_00);
    const file = await gstr1PortalFile(f.trx, f.orgId, '2026-09');
    const b2ba = file.b2ba as { ctin: string; inv: { oinum: string; oidt: string; inum: string; itms: { itm_det: { txval: number } }[] }[] }[];
    assert.equal(b2ba[0].inv[0].oinum, inv.number);
    assert.equal(b2ba[0].inv[0].oidt, '10-08-2026');
    assert.equal(b2ba[0].inv[0].itms[0].itm_det.txval, 12_000);

    const sep = await gstr3bForm(f.trx, f.orgId, '2026-09', { today: TODAY });
    assert.equal(sep.rows['3.1a'].taxablePaise, 2_000_00, 'September declares the ₹2,000 difference');
    assert.equal(sep.rows['3.1a'].cgstPaise, 180_00);
    const old = await gstr3b(f.trx, f.orgId, '2026-09');
    assert.equal(old.outward.cgstPaise, sep.rows['3.1a'].cgstPaise, 'the summary agrees with the form');

    // Once September is filed, the amendment is part of what was filed: October has none.
    await markFiled(f.trx, f.orgId, null, { returnType: 'gstr1', period: '2026-09', filedOn: '2026-10-10', arn: 'AA330926000002B' }, TODAY);
    assert.equal((await gstr1Amendments(f.trx, f.orgId, '2026-10')).rows.length, 0);
    assert.equal((await gstr1Amendments(f.trx, f.orgId, '2026-09')).rows.length, 1, 'September still shows what it carried');
  });
});

test('marking a return filed: ARN and date checked, the lock after filing, the mark taken off', async () => {
  await withFixture(async (f) => {
    await sell(f, f.buyer, '2026-07-10', [line(5_000)]);
    await assert.rejects(markFiled(f.trx, f.orgId, null, { returnType: 'gstr1', period: '2026-07', filedOn: '2026-08-11', arn: 'X1' }, TODAY), /ARN/);
    await assert.rejects(markFiled(f.trx, f.orgId, null, { returnType: 'gstr1', period: '2026-07', filedOn: '2026-12-01', arn: 'AA330726000003C' }, TODAY), /future/);
    const r = await markFiled(f.trx, f.orgId, null, { returnType: 'gstr1', period: '2026-07', filedOn: '2026-08-14', arn: 'AA330726000003C', lock: ['sales'] }, TODAY);
    assert.deepEqual(r.locked, [{ module: 'sales', lockedUpto: '2026-07-31' }]);
    await assert.rejects(sell(f, f.buyer, '2026-07-20', [line(1_000)]), /locked/i, 'nothing can be dated in a filed, locked period');
    await sell(f, f.buyer, '2026-08-01', [line(1_000)]);

    const s = await filingStatus(f.trx, f.orgId, 'gstr1', '2026-07', TODAY);
    assert.equal(s.status, 'filed_late', 'due on the 11th, filed on the 14th');
    assert.equal(s.daysLate, 3);
    assert.equal(s.estimate.lateFeeCgstPaise + s.estimate.lateFeeSgstPaise, 150_00, '₹50 a day');
    assert.equal(s.gsp.configured, false, 'no GSP on a test server');
    assert.ok(s.offlineSteps.some((x) => /Offline/i.test(x)));

    await unmarkFiled(f.trx, f.orgId, 'gstr1', '2026-07');
    const kept = await f.trx.selectFrom('gst_filed_documents').select('id').where('org_id', '=', f.orgId).where('period', '=', '2026-07').execute();
    assert.equal(kept.length, 0, 'not filed: not kept as filed');
    assert.equal((await filingStatus(f.trx, f.orgId, 'gstr1', '2026-07', TODAY)).status, 'overdue');
  });
  assert.deepEqual(monthlyLateFee(400, { nil: false, turnoverPaise: 0 }).cgstPaise, 1_000_00, 'capped at ₹2,000 up to ₹1.5 crore');
  assert.equal(periodEnd('2026-Q3'), '2026-12-31');
  assert.equal(periodEnd('2025'), '2026-03-31');
});

test('GSTR-2B decisions move credit between months, in the form and the summary alike', async () => {
  await withFixture(async (f) => {
    const a = await buy(f, f.vendor, 'S/1', '2026-08-05', 10_000);
    await buy(f, f.vendor2, 'T/1', '2026-08-06', 5_000);
    const before = await gstr3bForm(f.trx, f.orgId, '2026-08', { today: TODAY });
    assert.equal(before.itcNet.cgstPaise, 1_350_00);

    await setClaimDecision(f.trx, f.orgId, null, { billIds: [a.id], decision: 'claim_later', claimPeriod: '2026-09' });
    const aug = await gstr3bForm(f.trx, f.orgId, '2026-08', { today: TODAY });
    const sep = await gstr3bForm(f.trx, f.orgId, '2026-09', { today: TODAY });
    assert.equal(aug.itcNet.cgstPaise, 450_00, 'held back from August');
    assert.equal(sep.itcNet.cgstPaise, 900_00, 'claimed in September');
    assert.equal((await gstr3b(f.trx, f.orgId, '2026-08')).itc.cgstPaise, 450_00, 'the summary follows');
    assert.ok(sep.documents.some((d) => d.row === '4A5' && /Claimed now/.test(d.note ?? '')), 'the drill-down says why');

    // The ledger still has it in August: the tie-out names the decision as the reason.
    const checks = await gstr3bChecks(f.trx, f.orgId, '2026-08', TODAY);
    const input = checks.tieOut.find((l) => l.key === 'input')!;
    assert.equal(input.differencePaise, -1_800_00);
    assert.equal(input.unexplainedPaise, 0);

    await setClaimDecision(f.trx, f.orgId, null, { billIds: [a.id], decision: 'defer' });
    assert.equal((await gstr3bForm(f.trx, f.orgId, '2026-09', { today: TODAY })).itcNet.cgstPaise, 0, 'deferred: claimed nowhere');
    await setClaimDecision(f.trx, f.orgId, null, { billIds: [a.id], decision: 'accept' });
    assert.equal((await gstr3bForm(f.trx, f.orgId, '2026-08', { today: TODAY })).itcNet.cgstPaise, 1_350_00, 'accepted: its own month again');

    await markFiled(f.trx, f.orgId, null, { returnType: 'gstr3b', period: '2026-08', filedOn: '2026-09-18', arn: 'AB330826000004D' }, TODAY);
    await assert.rejects(setClaimDecision(f.trx, f.orgId, null, { billIds: [a.id], decision: 'defer' }), /filed/, 'a filed GSTR-3B is not revised');
  });
});

test('table 6.1 posted as set-off and cash clears the GST ledgers; Delete reverses it', async () => {
  await withFixture(async (f) => {
    await sell(f, f.buyer, '2026-08-10', [line(20_000)]);
    await buy(f, f.vendor, 'S/9', '2026-08-12', 5_000);
    // Filed on time, so 6.1 carries no interest or late fee.
    await markFiled(f.trx, f.orgId, null, { returnType: 'gstr3b', period: '2026-08', filedOn: '2026-09-18', arn: 'AB330826000009Z' }, TODAY);
    const pay = await recordGstr3bPayment(f.trx, f.orgId, null, { period: '2026-08', paidOn: '2026-09-18', cpin: '33082600011111', bankAccountId: f.bankId }, TODAY);
    assert.equal(pay.creditUsedPaise, 900_00, 'CGST and SGST credit set off');
    assert.equal(pay.cashPaise, 2_700_00, 'the rest in cash');
    const all = ['2026-08-01', '2026-09-30'] as const;
    assert.equal(await ledger(f, [CODE.GST_CGST, CODE.GST_SGST, CODE.GST_IGST], ...all), 0, 'output tax back to nil');
    assert.equal(await ledger(f, [CODE.ITC_CGST, CODE.ITC_SGST, CODE.ITC_IGST], ...all), 0, 'input tax back to nil');
    assert.equal(await ledger(f, ['1210'], ...all), 2_700_00, 'cash out of the bank (credited)');
    const view = await gstr3bPaymentFor(f.trx, f.orgId, '2026-08', TODAY);
    assert.equal(view?.setoff.CGST.CGST, 450_00, 'kept by the head of the credit and the head it met');
    assert.equal(view?.stale, false);
    await assert.rejects(recordGstr3bPayment(f.trx, f.orgId, null, { period: '2026-08', paidOn: '2026-09-18', bankAccountId: f.bankId }, TODAY), /already recorded/);

    const checks = await gstr3bChecks(f.trx, f.orgId, '2026-08', TODAY);
    assert.ok(checks.tieOut.every((l) => l.unexplainedPaise === 0), 'the tie-out has nothing unexplained');

    await deleteGstr3bPayment(f.trx, f.orgId, null, pay.id, 'entered twice');
    assert.equal(await ledger(f, ['1210'], ...all), 0, 'reversed');
    assert.equal(await gstr3bPaymentFor(f.trx, f.orgId, '2026-08', TODAY), null);
  });
});

test('GSTR-1 against GSTR-3B against the books, month by month', async () => {
  await withFixture(async (f) => {
    await sell(f, f.buyer, '2026-04-10', [line(8_000)]);
    await sell(f, f.consumer, '2026-05-10', [line(2_000)]);
    const r = await reconciliation(f.trx, f.orgId, 2026, '2026-06-15');
    assert.equal(r.months.length, 3, 'April to June, the months begun');
    assert.equal(r.months[0].gstr1.taxablePaise, 8_000_00);
    assert.equal(r.months[0].gstr3b.taxablePaise, 8_000_00);
    assert.equal(r.months[0].books.taxablePaise, 8_000_00);
    assert.equal(r.months[0].ledgerTaxPaise, 1_440_00);
    assert.ok(r.months.every((m) => m.differences.every((d) => d.explained)), 'all three agree');
    assert.equal(r.totals.gstr1.taxPaise, 1_800_00);
  });
});
