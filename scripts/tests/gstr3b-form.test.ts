// GSTR-3B laid out table by table (lib/server/gst/gstr3b-form.ts).
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/gstr3b-form.test.ts
//
// What is pinned down: each supply lands on the portal's row; the documents
// behind every figure add up to it; the net credit and the cash agree exactly
// with gstr3b(), which the AI and GSTR-9 read; blocked credit is shown in 4(A)
// and reversed in 4(B)(1); IGST credit spills where it saves cash; late fee
// and interest follow the filing date; and the JSON is the GSTN's schema.

import test from 'node:test';
import assert from 'node:assert/strict';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { createInvoice } from '../../lib/server/services/sales';
import { createBill, createExpense } from '../../lib/server/services/purchases';
import { createCreditNote } from '../../lib/server/services/sales-documents';
import { gstr3b } from '../../lib/server/gst/returns';
import { gstr3bForm, gstr3bPeriod, gstr3bPortalJson } from '../../lib/server/gst/gstr3b-form';
import { setOffCredit, creditUsedFor } from '../../lib/server/gst/set-off';
import type { Gstr3bRowKey } from '../../lib/gst/gstr3b-layout';

test.after(() => db.destroy());

interface Fixture {
  trx: Trx; orgId: number; branchId: number; bankId: number; acc: Record<string, number>;
  local: number; kerala: number; consumerKa: number; compositionKa: number; vendor: number; unregisteredVendor: number;
}

async function withFixture(fn: (f: Fixture) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'GSTR-3B Form Test Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({
        org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1, gstin: '33AABCZ3030B1Z3',
      }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const acc = await accountIds(trx, orgId);
      const mk = async (values: Record<string, unknown>) =>
        Number((await trx.insertInto('contacts').values({ org_id: orgId, ...values } as never).executeTakeFirstOrThrow()).insertId);
      await fn({
        trx, orgId, branchId, acc,
        bankId: Number((await trx.insertInto('bank_accounts').values({
          org_id: orgId, kind: 'bank', name: 'Bank', ledger_account_id: acc[CODE.BANK_DEFAULT], opening_balance: '0.0000',
        }).executeTakeFirstOrThrow()).insertId),
        local: await mk({ kind: 'customer', display_name: 'Local Co', gst_treatment: 'registered', state_code: '33', gstin: '33AAACL1111L1Z1' }),
        kerala: await mk({ kind: 'customer', display_name: 'Kerala Co', gst_treatment: 'registered', state_code: '32', gstin: '32AAACK2222K1Z2' }),
        consumerKa: await mk({ kind: 'customer', display_name: 'Bengaluru walk-in', gst_treatment: 'unregistered', state_code: '29' }),
        compositionKa: await mk({ kind: 'customer', display_name: 'Mysuru composition dealer', gst_treatment: 'registered_composition', state_code: '29', gstin: '29AAACM4444M1Z4' }),
        vendor: await mk({ kind: 'vendor', display_name: 'Supplier', gst_treatment: 'registered', state_code: '33', gstin: '33AAACS3333S1Z3' }),
        unregisteredVendor: await mk({ kind: 'vendor', display_name: 'Lorry owner', gst_treatment: 'unregistered', state_code: '33' }),
      });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

const sell = (f: Fixture, customerId: number, date: string, lines: { rupees: number; rate: number }[]) =>
  createInvoice(f.trx, f.orgId, null, {
    branchId: f.branchId, customerId, date, dueDate: date, status: 'approved',
    lines: lines.map((l) => ({ description: 'Goods', qty: 1, ratePaise: l.rupees * 100, gstRatePct: l.rate })),
  });

async function book(f: Fixture) {
  await sell(f, f.local, '2026-08-05', [{ rupees: 10_000, rate: 18 }, { rupees: 2_000, rate: 0 }]); // 3.1a + 3.1c
  await sell(f, f.kerala, '2026-08-06', [{ rupees: 5_000, rate: 18 }]);                               // 3.1a, inter, registered
  await sell(f, f.consumerKa, '2026-08-07', [{ rupees: 3_000, rate: 18 }]);                           // 3.1a and 3.2 unregistered
  await sell(f, f.compositionKa, '2026-08-08', [{ rupees: 4_000, rate: 12 }]);                        // 3.1a and 3.2 composition
  await createCreditNote(f.trx, f.orgId, null, {
    branchId: f.branchId, customerId: f.local, date: '2026-08-20', reason: 'Short supply',
    lines: [{ description: 'Goods', qty: 1, ratePaise: 1_000_00, gstRatePct: 18 }],
  });
  await createBill(f.trx, f.orgId, null, {
    branchId: f.branchId, vendorId: f.vendor, vendorInvoiceNo: 'S-1', date: '2026-08-10', dueDate: '2026-08-10',
    lines: [
      { description: 'Stock', qty: 1, ratePaise: 8_000_00, gstRatePct: 18 },
      { description: 'Staff lunch', qty: 1, ratePaise: 1_000_00, gstRatePct: 5, itcEligibility: 'ineligible' },
      { description: 'Fresh vegetables', qty: 1, ratePaise: 500_00, gstRatePct: 0 },
    ],
  });
  await createBill(f.trx, f.orgId, null, {
    branchId: f.branchId, vendorId: f.unregisteredVendor, vendorInvoiceNo: 'R-1', date: '2026-08-11', dueDate: '2026-08-11', isRcm: true,
    lines: [{ description: 'Freight', qty: 1, ratePaise: 2_000_00, gstRatePct: 5 }],
  });
  await createExpense(f.trx, f.orgId, null, {
    branchId: f.branchId, date: '2026-08-12', accountId: f.acc[CODE.RENT],
    paidThroughBankAccountId: f.bankId, amountPaise: 1_180_00, gstRatePct: 18,
  });
}

const today = '2026-09-05';

test('each supply lands on the portal row, and the documents add up to every figure', async () => {
  await withFixture(async (f) => {
    await book(f);
    const form = await gstr3bForm(f.trx, f.orgId, '2026-08', { today });

    // 3.1(a): 10,000 + 5,000 + 3,000 + 4,000 less the 1,000 credit note.
    assert.equal(form.rows['3.1a'].taxablePaise, 21_000_00);
    assert.equal(form.rows['3.1a'].cgstPaise, 900_00 - 90_00, 'local sale less the note');
    assert.equal(form.rows['3.1a'].igstPaise, 900_00 + 540_00 + 480_00, 'the three inter-state sales');
    assert.equal(form.rows['3.1c'].taxablePaise, 2_000_00, 'the nil-rated line');
    assert.equal(form.rows['3.1c'].cgstPaise, 0);
    assert.equal(form.rows['3.1d'].taxablePaise, 2_000_00, 'the reverse-charge freight');
    assert.equal(form.rows['3.1d'].cgstPaise, 50_00);

    // 3.2: the inter-state supplies to the unregistered and composition buyers in Karnataka.
    assert.deepEqual(form.interState.unregistered, [{ pos: '29', taxablePaise: 3_000_00, igstPaise: 540_00 }]);
    assert.deepEqual(form.interState.composition, [{ pos: '29', taxablePaise: 4_000_00, igstPaise: 480_00 }]);
    assert.deepEqual(form.interState.uin, []);

    // 4: the bill's blocked credit is in 4(A)(5) and reversed in 4(B)(1).
    assert.equal(form.rows['4A3'].cgstPaise, 50_00, 'reverse-charge credit');
    assert.equal(form.rows['4A5'].cgstPaise, 720_00 + 25_00 + 90_00, 'stock, the blocked lunch and the rent expense');
    assert.equal(form.rows['4B1'].cgstPaise, 25_00, 'the lunch, blocked under 17(5)');
    assert.equal(form.itcNet.cgstPaise, 720_00 + 90_00 + 50_00);

    // 5: the untaxed vegetables, intra-state.
    assert.equal(form.inward.gst.intra, 500_00);
    assert.equal(form.inward.gst.inter, 0);

    // Every row's documents sum to its figure.
    for (const [key, row] of Object.entries(form.rows) as [Gstr3bRowKey, (typeof form.rows)[Gstr3bRowKey]][]) {
      const docs = form.documents.filter((d) => d.row === key);
      for (const k of ['taxablePaise', 'igstPaise', 'cgstPaise', 'sgstPaise', 'cessPaise'] as const) {
        assert.equal(docs.reduce((t, d) => t + d[k], 0), row[k], `${key} ${k}`);
      }
    }
  });
});

test('the net credit and the cash agree with gstr3b()', async () => {
  await withFixture(async (f) => {
    await book(f);
    const form = await gstr3bForm(f.trx, f.orgId, '2026-08', { today });
    const old = await gstr3b(f.trx, f.orgId, '2026-08');
    assert.equal(form.itcNet.igstPaise, old.itc.igstPaise);
    assert.equal(form.itcNet.cgstPaise, old.itc.cgstPaise);
    assert.equal(form.itcNet.sgstPaise, old.itc.sgstPaise);
    assert.equal(form.itcNet.cessPaise, old.itc.cessPaise);
    assert.equal(form.totals.cashPaise, old.totalCashPaise);
    const out = ['3.1a', '3.1b', '3.1c', '3.1e'] as const;
    assert.equal(out.reduce((t, k) => t + form.rows[k].cgstPaise, 0), old.outward.cgstPaise);
    assert.equal(out.reduce((t, k) => t + form.rows[k].igstPaise, 0), old.outward.igstPaise);
    // Reverse-charge tax is always cash.
    const rcm = form.payment.filter((p) => p.kind === 'rcm');
    assert.equal(rcm.find((p) => p.head === 'CGST')!.cashPaise, 50_00);
    assert.ok(rcm.every((p) => Object.values(p.itc).every((v) => v === 0)));
  });
});

test('IGST credit spills first where a head’s own credit falls short', () => {
  // CGST 1,000 and SGST 1,000 owed; credit IGST 1,000 and CGST 1,000.
  const s = setOffCredit({ IGST: 0, CGST: 1_000_00, SGST: 1_000_00, CESS: 0 }, { IGST: 1_000_00, CGST: 1_000_00, SGST: 0, CESS: 0 });
  assert.equal(s.used.SGST.IGST, 1_000_00, 'the IGST credit covers SGST, which has none of its own');
  assert.equal(s.used.CGST.CGST, 1_000_00);
  assert.equal(s.cash.CGST + s.cash.SGST, 0, 'no cash at all');
  // CGST and SGST credit never cross, and IGST credit goes first.
  const t = setOffCredit({ IGST: 500_00, CGST: 0, SGST: 800_00, CESS: 0 }, { IGST: 200_00, CGST: 900_00, SGST: 0, CESS: 0 });
  assert.equal(t.used.IGST.IGST, 200_00);
  assert.equal(t.used.IGST.CGST, 300_00, 'CGST credit meets the IGST left');
  assert.equal(t.used.SGST.CGST, 0, 'CGST credit never meets SGST');
  assert.equal(t.cash.SGST, 800_00);
  assert.equal(creditUsedFor(t, 'IGST'), 500_00);
});

test('late fee and interest follow the filing date', async () => {
  await withFixture(async (f) => {
    await book(f);
    const onTime = await gstr3bForm(f.trx, f.orgId, '2026-08', { today: '2026-09-19' });
    assert.equal(onTime.status.dueDate, '2026-09-20');
    assert.equal(onTime.totals.interestPaise + onTime.totals.lateFeePaise, 0);
    assert.equal(onTime.status.overdue, false);

    await f.trx.insertInto('compliance_filings').values({ org_id: f.orgId, item_key: 'gstr3b', period: '2026-08', done_on: '2026-09-30', reference: 'AA330826000001Z' }).execute();
    const late = await gstr3bForm(f.trx, f.orgId, '2026-08', { today: '2026-11-01' });
    assert.equal(late.status.filed, true);
    assert.equal(late.status.arn, 'AA330826000001Z');
    assert.equal(late.interestLateFee.daysLate, 10, 'filed ten days late; today does not matter once filed');
    assert.equal(late.interestLateFee.lateFee.cgstPaise, 250_00, '₹50 a day, half CGST');
    assert.equal(late.interestLateFee.lateFee.sgstPaise, 250_00);
    const cash = late.payment.filter((p) => p.kind === 'forward').find((p) => p.head === 'IGST')!.cashPaise
      + late.payment.find((p) => p.kind === 'rcm' && p.head === 'IGST')!.cashPaise;
    assert.equal(late.interestLateFee.interest.igstPaise, Math.round((cash * 18 * 10) / 36500 / 100) * 100);
  });
});

test('quarters run April to June through January to March', () => {
  assert.deepEqual(gstr3bPeriod('2026-Q1').months, ['2026-04', '2026-05', '2026-06']);
  assert.deepEqual(gstr3bPeriod('2026-Q3').months, ['2026-10', '2026-11', '2026-12']);
  const q4 = gstr3bPeriod('2026-Q4');
  assert.deepEqual(q4.months, ['2027-01', '2027-02', '2027-03']);
  assert.equal(q4.from, '2027-01-01');
  assert.equal(q4.to, '2027-03-31');
});

test('the return file follows the GSTN schema', async () => {
  await withFixture(async (f) => {
    await book(f);
    const form = await gstr3bForm(f.trx, f.orgId, '2026-08', { today });
    const j = gstr3bPortalJson(form);
    assert.equal(j.gstin, '33AABCZ3030B1Z3');
    assert.equal(j.ret_period, '082026');
    assert.equal(j.sup_details.osup_det.txval, 21_000);
    assert.equal(j.sup_details.osup_nil_exmp.txval, 2_000);
    assert.equal(j.sup_details.isup_rev.camt, 50);
    assert.deepEqual(j.inter_sup.unreg_details, [{ pos: '29', txval: 3_000, iamt: 540 }]);
    assert.deepEqual(j.itc_elg.itc_avl.map((x) => x.ty), ['IMPG', 'IMPS', 'ISRC', 'ISD', 'OTH']);
    assert.equal(j.itc_elg.itc_rev[0].camt, 25);
    assert.equal(j.itc_elg.itc_net.camt, 860);
    assert.deepEqual(j.inward_sup.isup_details[0], { ty: 'GST', inter: 0, intra: 500 });
  });
});
