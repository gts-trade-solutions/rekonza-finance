// Zoho Books' bank matching: Best Matches and Possible Matches scored from the
// amount, the party a narration names, a document number and the date
// (lib/bank-match-score.ts); matching one line to several documents with the
// difference posted; Categorize Manually by Zoho's categories; and unmatching
// taking back exactly what was done (lib/server/services/bank-match.ts).
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/bank-match.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { verifyLedgerBalances } from '../../lib/server/ledger/posting';
import { createInvoice } from '../../lib/server/services/sales';
import { createBill } from '../../lib/server/services/purchases';
import { receivePayment } from '../../lib/server/services/payments';
import { importStatement, unmatchTransaction } from '../../lib/server/services/banking';
import { categoriseAs, findMatches, matchLine, bestMatchesFor } from '../../lib/server/services/bank-match';
import { toPaiseFromSql } from '../../lib/server/money-sql';
import { carries, groupMatches, modeFromNarration, nameStrength, rankCandidates, scoreCandidate, type Candidate } from '../../lib/bank-match-score';
import { BANK_CATEGORIES, categoriesFor } from '../../lib/bank-categories';

test.after(() => db.destroy());

// ── Scoring, without a database ──────────────────────────────────────────────

const line = { date: '2026-08-31', amountPaise: 700_000, direction: 'in' as const,
  narration: 'NEFT-BARBT26243366117-BONITAA SKIN AND HAIR CARE--35530500001444-BARB0TRICOI', reference: null };
const inv = (id: number, amount: number, extra: Partial<Candidate> = {}): Candidate => ({
  key: `invoice:${id}`, type: 'invoice', id: String(id), number: `INV/26-27/000${id}`, party: 'bonita', contactId: '54',
  date: '2026-08-20', amountPaise: amount, names: ['bonita'], ...extra,
});

test('a narration names a party by a word that starts with its name, ignoring the bank’s words', () => {
  assert.equal(nameStrength(line.narration, ['bonita']), 1, '"BONITAA" names "bonita"');
  assert.equal(nameStrength(line.narration, ['Bonita Skin Care Pvt Ltd']), 1);
  assert.equal(nameStrength('UPI/662593749824/aug 24/XX09-1@okicici/INDIAN OVERSEAS', ['Indian Overseas Traders']), 1);
  assert.equal(nameStrength(line.narration, ['Sharma Traders']), 0);
  assert.equal(nameStrength('NEFT CR RACEAUTOSPARES 9921', ['Race Auto Spares']), 1, 'the name run together');
  assert.ok(nameStrength('IMPS/631612/KOCHI MOTOR MART/FDRL0001', ['Apex Motors Pvt Ltd']) < 0.5, 'a shared trade word is not the party');
  assert.equal(nameStrength('IMPS/631612/KOCHI MOTOR MART/FDRL0001', ['Kochi Motor Mart']), 1);
  assert.equal(carries('UPI INV2627 0007 PAID', 'INV/26-27/0007'), true);
  assert.equal(carries('UPI INV2627 00071 PAID', 'INV/26-27/0007'), false, 'part of a longer number');
  assert.equal(modeFromNarration('UPI/62253692/UPI/x'), 'upi');
  assert.equal(modeFromNarration('MMT/IMPS/623618251442/pay'), 'imps');
  assert.equal(modeFromNarration('NEFT-AXODH255'), 'neft');
});

test('the same amount from the party the narration names is a best match; the amount alone is only possible', () => {
  const named = scoreCandidate(line, inv(1, 700_000));
  assert.equal(named.best, true);
  assert.ok(named.reasons.includes('Same amount') && named.reasons.some((r) => /names bonita/.test(r)), named.reasons.join(', '));
  const stranger = scoreCandidate(line, inv(2, 700_000, { party: 'Sharma Traders', names: ['Sharma Traders'], contactId: '9' }));
  assert.equal(stranger.best, false);
  const ranked = rankCandidates(line, [inv(1, 700_000), inv(2, 700_000, { party: 'Sharma Traders', names: ['Sharma Traders'], contactId: '9' }), inv(3, 50_000, { party: 'Sharma', names: ['Sharma'], contactId: '9' })]);
  assert.deepEqual(ranked.best.map((c) => c.id), ['1']);
  assert.ok(ranked.possible.some((c) => c.id === '2'), 'the same amount is still worth a look');
  // Something already recorded, from the named party but months away and for another amount, is not offered.
  const old: Candidate = { key: 'payment:9', type: 'payment', id: '9', number: 'RCPT/26-27/0007', party: 'bonita', contactId: '54', date: '2026-06-01', amountPaise: 123_00, names: ['bonita'] };
  assert.equal(rankCandidates(line, [old]).possible.length, 0);
  // An invoice raised a month after the money arrived is unlikely to be it.
  assert.equal(scoreCandidate(line, inv(4, 700_000, { date: '2026-10-01' })).best, false);
});

test('a recorded payment is a best match by amount and nearness of date', () => {
  const pay: Candidate = { key: 'payment:5', type: 'payment', id: '5', number: 'RCPT/26-27/0005', party: 'X', contactId: '1', date: '2026-08-30', amountPaise: 700_000, names: ['Zed'] };
  assert.equal(scoreCandidate(line, pay).best, true, 'a day apart');
  assert.equal(scoreCandidate(line, { ...pay, date: '2026-07-01' }).best, false, 'two months apart');
});

test('two open invoices of the named party that add up to the line are offered together', () => {
  const pool = [inv(1, 300_000), inv(2, 400_000, { date: '2026-08-25' }), inv(3, 999_00)];
  const { best, possible } = rankCandidates(line, pool);
  assert.equal(best.length, 0);
  const groups = groupMatches(line, possible);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].members.map((m) => m.id).sort(), ['1', '2']);
});

test('the categories follow Zoho’s, money in and money out', () => {
  assert.deepEqual(categoriesFor('in').map((c) => c.label).slice(0, 3), ['Customer Payment', 'Customer Advance', 'Transfer From Another Account']);
  assert.ok(categoriesFor('out').some((c) => c.label === 'Owner Drawings'));
  assert.equal(new Set(BANK_CATEGORIES.map((c) => c.key)).size, BANK_CATEGORIES.length);
});

// ── In the books ─────────────────────────────────────────────────────────────

interface Fixture { trx: Trx; orgId: number; branchId: number; customerId: number; vendorId: number; itemId: number; bankId: number; cashId: number; acc: Record<string, number> }

async function withFixture(fn: (f: Fixture) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Bank Match Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1 }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const acc = await accountIds(trx, orgId);
      const mk = async (v: Record<string, unknown>) => Number((await trx.insertInto('contacts').values(v as never).executeTakeFirstOrThrow()).insertId);
      const customerId = await mk({ org_id: orgId, kind: 'customer', display_name: 'Bonita Skin Care', gst_treatment: 'registered', state_code: '33' });
      const vendorId = await mk({ org_id: orgId, kind: 'vendor', display_name: 'Seoulful Supplies', gst_treatment: 'registered', state_code: '33' });
      const bankId = Number((await trx.insertInto('bank_accounts').values({
        org_id: orgId, kind: 'bank', name: 'ICICI Current', ledger_account_id: acc[CODE.BANK_DEFAULT], opening_balance: '0.0000', is_primary: 1,
      }).executeTakeFirstOrThrow()).insertId);
      const cashId = Number((await trx.insertInto('bank_accounts').values({
        org_id: orgId, kind: 'cash', name: 'Cash in Hand', ledger_account_id: acc[CODE.CASH], opening_balance: '0.0000',
      }).executeTakeFirstOrThrow()).insertId);
      const itemId = Number((await trx.insertInto('items').values({
        org_id: orgId, kind: 'goods', name: 'Widget', sku: 'W-1', hsn_sac: '8708', uqc: 'NOS', sale_price: '1000.0000', purchase_price: '600.0000',
        gst_rate_pct: 18, sale_account_id: acc[CODE.SALES], purchase_account_id: acc[CODE.PURCHASES],
      }).executeTakeFirstOrThrow()).insertId);
      await trx.insertInto('hsn_codes').values({ org_id: orgId, code: '8708', kind: 'hsn', description: 'Motor vehicle parts', gst_rate_pct: '18' }).execute();
      await fn({ trx, orgId, branchId, customerId, vendorId, itemId, bankId, cashId, acc });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

const invoice = (f: Fixture, ratePaise: number, date = '2026-08-20') => createInvoice(f.trx, f.orgId, null, {
  branchId: f.branchId, customerId: f.customerId, date, dueDate: '2026-09-30', status: 'approved', lines: [{ itemId: f.itemId, qty: 1, ratePaise }],
});
const lineIds = async (f: Fixture) => (await f.trx.selectFrom('bank_transactions').select(['id', 'narration', 'status']).where('org_id', '=', f.orgId).orderBy('id').execute());
const balanceOf = async (f: Fixture, accountId: number) => {
  const r = await f.trx.selectFrom('journal_lines as l').innerJoin('journal_entries as e', 'e.id', 'l.entry_id')
    .select((eb) => eb.fn.sum<string>(eb.ref('l.debit')).as('d')).select((eb) => eb.fn.sum<string>(eb.ref('l.credit')).as('c'))
    .where('e.org_id', '=', f.orgId).where('l.account_id', '=', accountId).executeTakeFirst();
  return toPaiseFromSql(r?.d ?? '0') - toPaiseFromSql(r?.c ?? '0');
};

test('a line from the customer the narration names is matched to their open invoice, and unmatching opens it again', async () => {
  await withFixture(async (f) => {
    const a = await invoice(f, 593_220); // 5,932.20 + 18% = 7,000.00
    assert.equal(a.totalPaise, 700_000);
    await importStatement(f.trx, f.orgId, null, f.bankId, 'aug.csv', [{ date: '2026-08-31', narration: line.narration, depositPaise: 700_000 }]);
    const [l] = await lineIds(f);
    assert.equal(l.status, 'unmatched', 'nothing names the invoice number, so the import leaves it for a person');

    const found = await findMatches(f.trx, f.orgId, l.id);
    assert.deepEqual(found.best.map((c) => c.key), [`invoice:${a.id}`]);
    const listed = await bestMatchesFor(f.trx, f.orgId, [l.id]);
    assert.equal(listed.get(l.id)?.length, 1, 'the row says a match was found');

    const r = await matchLine(f.trx, f.orgId, null, l.id, [{ type: 'invoice', id: a.id }]);
    assert.equal(r.created.length, 1, 'a receipt was recorded');
    const after = await f.trx.selectFrom('invoices').select(['status', 'amount_paid']).where('id', '=', a.id).executeTakeFirstOrThrow();
    assert.equal(after.status, 'paid');
    assert.equal(await balanceOf(f, f.acc[CODE.BANK_DEFAULT]), 700_000);
    assert.equal((await verifyLedgerBalances(f.trx, f.orgId)).balanced, true);
    await assert.rejects(matchLine(f.trx, f.orgId, null, l.id, [{ type: 'invoice', id: a.id }]), /already matched/);

    await unmatchTransaction(f.trx, f.orgId, null, l.id);
    const back = await f.trx.selectFrom('invoices').select(['status', 'amount_paid']).where('id', '=', a.id).executeTakeFirstOrThrow();
    assert.notEqual(back.status, 'paid', 'the receipt the match recorded is voided');
    assert.equal(toPaiseFromSql(back.amount_paid), 0);
    assert.equal(await balanceOf(f, f.acc[CODE.BANK_DEFAULT]), 0);
    const [l2] = await lineIds(f);
    assert.equal(l2.status, 'unmatched');
    assert.equal((await f.trx.selectFrom('bank_transaction_links').select('id').where('bank_transaction_id', '=', l.id).execute()).length, 0);
  });
});

test('one line pays two invoices less the bank’s charge: refused until the difference has a home', async () => {
  await withFixture(async (f) => {
    const a = await invoice(f, 254_238);
    const b = await invoice(f, 338_983);
    const both = a.totalPaise + b.totalPaise;
    await importStatement(f.trx, f.orgId, null, f.bankId, 'aug.csv', [{ date: '2026-08-31', narration: 'NEFT CR BONITA SKIN CARE', depositPaise: both - 50 }]);
    const [l] = await lineIds(f);
    const picks = [{ type: 'invoice' as const, id: a.id }, { type: 'invoice' as const, id: b.id }];
    await assert.rejects(matchLine(f.trx, f.orgId, null, l.id, picks), /Say where the difference/);
    await matchLine(f.trx, f.orgId, null, l.id, picks, { differenceAccountId: f.acc[CODE.BANK_CHARGES] });
    assert.equal(await balanceOf(f, f.acc[CODE.BANK_DEFAULT]), both - 50, 'the bank holds what the statement says');
    assert.equal(await balanceOf(f, f.acc[CODE.BANK_CHARGES]), 50);
    const docs = await f.trx.selectFrom('invoices').select('status').where('id', 'in', [a.id, b.id]).execute();
    assert.deepEqual(docs.map((d) => d.status), ['paid', 'paid']);
    const pays = await f.trx.selectFrom('payments').select('id').where('org_id', '=', f.orgId).execute();
    assert.equal(pays.length, 1, 'one receipt for both invoices of one customer');
    await unmatchTransaction(f.trx, f.orgId, null, l.id);
    assert.equal(await balanceOf(f, f.acc[CODE.BANK_DEFAULT]), 0);
    assert.equal(await balanceOf(f, f.acc[CODE.BANK_CHARGES]), 0);
    assert.equal((await verifyLedgerBalances(f.trx, f.orgId)).balanced, true);
  });
});

test('a payment already recorded is linked, not recorded again, and stays when unmatched', async () => {
  await withFixture(async (f) => {
    const a = await invoice(f, 593_220);
    const pay = await receivePayment(f.trx, f.orgId, null, {
      branchId: f.branchId, contactId: f.customerId, date: '2026-08-26', mode: 'neft', amountPaise: 700_000, bankAccountId: f.bankId,
      allocations: [{ targetType: 'invoice', targetId: a.id, amountPaise: 700_000 }],
    });
    // Five days apart: too far for the import to match it on its own.
    await importStatement(f.trx, f.orgId, null, f.bankId, 'aug.csv', [{ date: '2026-08-31', narration: 'NEFT CR BONITA SKIN CARE', depositPaise: 700_000 }]);
    const [l] = await lineIds(f);
    const found = await findMatches(f.trx, f.orgId, l.id);
    assert.deepEqual(found.best.map((c) => c.key), [`payment:${pay.id}`], 'the invoice is paid, so the receipt is what it was');
    await matchLine(f.trx, f.orgId, null, l.id, [{ type: 'payment', id: pay.id }]);
    assert.equal(await balanceOf(f, f.acc[CODE.BANK_DEFAULT]), 700_000, 'nothing posted twice');
    await unmatchTransaction(f.trx, f.orgId, null, l.id);
    const p = await f.trx.selectFrom('payments').select('status').where('id', '=', pay.id).executeTakeFirstOrThrow();
    assert.equal(p.status, 'cleared', 'a payment the match did not record is only let go');
    // And another line cannot take a payment one line holds.
    await matchLine(f.trx, f.orgId, null, l.id, [{ type: 'payment', id: pay.id }]);
    await importStatement(f.trx, f.orgId, null, f.bankId, 'aug2.csv', [{ date: '2026-08-31', narration: 'NEFT CR BONITA AGAIN', depositPaise: 700_000 }]);
    const second = (await lineIds(f))[1];
    await assert.rejects(matchLine(f.trx, f.orgId, null, second.id, [{ type: 'payment', id: pay.id }]), /cannot be matched/);
  });
});

test('categorised by hand: customer payment, expense with GST, transfer, drawings, a sale without an invoice', async () => {
  await withFixture(async (f) => {
    const a = await invoice(f, 593_220);
    const bill = await createBill(f.trx, f.orgId, null, {
      branchId: f.branchId, vendorId: f.vendorId, vendorInvoiceNo: 'SS-77', date: '2026-08-10', dueDate: '2026-09-10', status: 'open',
      lines: [{ accountId: f.acc[CODE.OFFICE], qty: 1, ratePaise: 100_000, gstRatePct: 0, description: 'Stationery' }],
    } as never);
    await importStatement(f.trx, f.orgId, null, f.bankId, 'aug.csv', [
      { date: '2026-08-31', narration: 'IMPS CR SOMEONE', depositPaise: 700_000 },
      { date: '2026-08-31', narration: 'POS AMAZON OFFICE', withdrawalPaise: 11_800 },
      { date: '2026-09-01', narration: 'SELF TRANSFER CASH', withdrawalPaise: 50_000 },
      { date: '2026-09-02', narration: 'OWNER UPI', withdrawalPaise: 20_000 },
      { date: '2026-09-03', narration: 'COUNTER SALE', depositPaise: 11_800 },
      { date: '2026-09-04', narration: 'NEFT DR SEOULFUL', withdrawalPaise: 100_000 },
    ]);
    const ls = await lineIds(f);
    const id = (re: RegExp) => ls.find((l) => re.test(l.narration))!.id;

    await assert.rejects(categoriseAs(f.trx, f.orgId, null, id(/SOMEONE/), { category: 'expense', accountId: f.acc[CODE.OFFICE] }), /for money out/);
    await categoriseAs(f.trx, f.orgId, null, id(/SOMEONE/), { category: 'customer_payment', contactId: f.customerId, allocations: [{ targetId: a.id, amountPaise: 700_000 }] });
    assert.equal((await f.trx.selectFrom('invoices').select('status').where('id', '=', a.id).executeTakeFirstOrThrow()).status, 'paid');

    await categoriseAs(f.trx, f.orgId, null, id(/AMAZON/), { category: 'expense', accountId: f.acc[CODE.OFFICE], gstRatePct: 18 });
    const exp = await f.trx.selectFrom('expenses').select(['total', 'amount']).where('org_id', '=', f.orgId).executeTakeFirstOrThrow();
    assert.equal(toPaiseFromSql(exp.total), 11_800);
    assert.equal(toPaiseFromSql(exp.amount), 10_000, 'the GST came out of what was paid');

    await categoriseAs(f.trx, f.orgId, null, id(/SELF TRANSFER/), { category: 'transfer_to', otherBankAccountId: f.cashId });
    assert.equal(await balanceOf(f, f.acc[CODE.CASH]), 50_000);
    await categoriseAs(f.trx, f.orgId, null, id(/OWNER/), { category: 'owner_drawings', accountId: f.acc[CODE.DRAWINGS] });
    assert.equal(await balanceOf(f, f.acc[CODE.DRAWINGS]), 20_000);
    const salesBefore = await balanceOf(f, f.acc[CODE.SALES]);
    const gstBefore = await balanceOf(f, f.acc[CODE.GST_CGST]) + await balanceOf(f, f.acc[CODE.GST_SGST]);
    await categoriseAs(f.trx, f.orgId, null, id(/COUNTER/), { category: 'sales_without_invoice', accountId: f.acc[CODE.SALES], gstRatePct: 18 });
    assert.equal(await balanceOf(f, f.acc[CODE.SALES]) - salesBefore, -10_000);
    assert.equal(await balanceOf(f, f.acc[CODE.GST_CGST]) + await balanceOf(f, f.acc[CODE.GST_SGST]) - gstBefore, -1_800, 'GST owed on the sale');
    await categoriseAs(f.trx, f.orgId, null, id(/SEOULFUL/), { category: 'vendor_payment', contactId: f.vendorId, allocations: [{ targetId: bill.id, amountPaise: 100_000 }] });
    assert.equal((await f.trx.selectFrom('bills').select('status').where('id', '=', bill.id).executeTakeFirstOrThrow()).status, 'paid');

    // Bank: +7,000 −118 −500 −200 +118 −1,000 = 5,300.
    assert.equal(await balanceOf(f, f.acc[CODE.BANK_DEFAULT]), 530_000);
    assert.equal((await verifyLedgerBalances(f.trx, f.orgId)).balanced, true);
    assert.equal((await lineIds(f)).filter((l) => l.status === 'unmatched').length, 0);

    // Uncategorising each takes back what it recorded.
    for (const l of ls) await unmatchTransaction(f.trx, f.orgId, null, l.id);
    assert.equal(await balanceOf(f, f.acc[CODE.BANK_DEFAULT]), 0);
    assert.equal(await balanceOf(f, f.acc[CODE.CASH]), 0);
    assert.equal((await f.trx.selectFrom('expenses').select('status').where('org_id', '=', f.orgId).executeTakeFirstOrThrow()).status, 'void');
    assert.equal((await f.trx.selectFrom('bank_transfers').select('id').where('org_id', '=', f.orgId).execute()).length, 0);
    assert.notEqual((await f.trx.selectFrom('invoices').select('status').where('id', '=', a.id).executeTakeFirstOrThrow()).status, 'paid');
    assert.equal((await verifyLedgerBalances(f.trx, f.orgId)).balanced, true);
  });
});

test('an advance received, then partly refunded from the bank, and the refund taken back', async () => {
  await withFixture(async (f) => {
    await importStatement(f.trx, f.orgId, null, f.bankId, 'aug.csv', [
      { date: '2026-08-01', narration: 'NEFT CR BONITA ADVANCE', depositPaise: 500_000 },
      { date: '2026-08-15', narration: 'NEFT DR REFUND BONITA', withdrawalPaise: 200_000 },
    ]);
    const [adv, ref] = await lineIds(f);
    await categoriseAs(f.trx, f.orgId, null, adv.id, { category: 'customer_advance', contactId: f.customerId });
    const pay = await f.trx.selectFrom('payments').select(['id', 'unapplied_amount']).where('org_id', '=', f.orgId).executeTakeFirstOrThrow();
    assert.equal(toPaiseFromSql(pay.unapplied_amount), 500_000, 'kept as the customer’s credit');
    await assert.rejects(categoriseAs(f.trx, f.orgId, null, ref.id, { category: 'payment_refund', contactId: f.vendorId, paymentId: pay.id }), /another party/);
    await categoriseAs(f.trx, f.orgId, null, ref.id, { category: 'payment_refund', contactId: f.customerId, paymentId: pay.id });
    const left = await f.trx.selectFrom('payments').select('unapplied_amount').where('id', '=', pay.id).executeTakeFirstOrThrow();
    assert.equal(toPaiseFromSql(left.unapplied_amount), 300_000);
    assert.equal(await balanceOf(f, f.acc[CODE.AR]), -300_000, 'the customer still holds 3,000 of credit');
    await unmatchTransaction(f.trx, f.orgId, null, ref.id);
    const back = await f.trx.selectFrom('payments').select('unapplied_amount').where('id', '=', pay.id).executeTakeFirstOrThrow();
    assert.equal(toPaiseFromSql(back.unapplied_amount), 500_000);
    assert.equal((await verifyLedgerBalances(f.trx, f.orgId)).balanced, true);
  });
});
