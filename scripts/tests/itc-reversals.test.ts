// Input tax credit taken back: Rule 37 (suppliers unpaid after 180 days, and
// the credit taken again on payment), Rules 42 and 43 (the exempt share of
// common credit), and where each shows in GSTR-3B.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/itc-reversals.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { createInvoice } from '../../lib/server/services/sales';
import { createBill } from '../../lib/server/services/purchases';
import { makePayment } from '../../lib/server/services/payments';
import { gstr3b } from '../../lib/server/gst/returns';
import { commonCredit, commonCreditYear, postCommonCredit, postCommonCreditYear, postRule37, reclaimRule37, rule37 } from '../../lib/server/gst/itc-reversals';
import { toPaiseFromSql } from '../../lib/server/money-sql';

const R = (rupees: number) => Math.round(rupees * 100);
interface Fixture { trx: Trx; orgId: number; branchId: number; bankId: number; acc: Record<string, number>; vendor: number; customer: number }

async function withFixture(fn: (f: Fixture) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Reversal Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', gstin: '33AAACR1111R1Z1', is_primary: 1 }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const acc = await accountIds(trx, orgId);
      await trx.insertInto('hsn_codes').values([
        { org_id: orgId, code: '8708', kind: 'hsn', description: 'Parts', gst_rate_pct: 18, is_active: 1 },
        { org_id: orgId, code: '0401', kind: 'hsn', description: 'Milk', gst_rate_pct: 0, is_active: 1 },
        { org_id: orgId, code: '8457', kind: 'hsn', description: 'Machine', gst_rate_pct: 18, is_active: 1 },
      ]).execute();
      const bankId = Number((await trx.insertInto('bank_accounts').values({
        org_id: orgId, kind: 'bank', name: 'Bank', ledger_account_id: acc[CODE.BANK_DEFAULT], opening_balance: '0.0000',
      }).executeTakeFirstOrThrow()).insertId);
      const contact = async (v: Record<string, unknown>) =>
        Number((await trx.insertInto('contacts').values({ org_id: orgId, state_code: '33', ...v } as never).executeTakeFirstOrThrow()).insertId);
      await fn({
        trx, orgId, branchId, bankId, acc,
        vendor: await contact({ kind: 'vendor', display_name: 'Supplier', gst_treatment: 'registered', gstin: '33AAACS2222S1Z2' }),
        customer: await contact({ kind: 'customer', display_name: 'Buyer', gst_treatment: 'consumer' }),
      });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

const balance = async (f: Fixture, code: string) => toPaiseFromSql((await sql<{ b: string }>`
  SELECT COALESCE(SUM(debit - credit), 0) AS b FROM journal_lines WHERE account_id = ${f.acc[code]}
`.execute(f.trx)).rows[0].b);
const bill = (f: Fixture, no: string, date: string, ratePaise: number, hsn = '8708', itcEligibility: 'eligible' | 'capital_goods' = 'eligible') => createBill(f.trx, f.orgId, null, {
  branchId: f.branchId, vendorId: f.vendor, vendorInvoiceNo: no, date, dueDate: date, status: 'open',
  lines: [{ description: no, hsnSac: hsn, qty: 1, ratePaise, gstRatePct: 18, itcEligibility }],
} as never);
const pay = (f: Fixture, billId: number, date: string, amountPaise: number) => makePayment(f.trx, f.orgId, null, {
  branchId: f.branchId, contactId: f.vendor, date, mode: 'neft', amountPaise, bankAccountId: f.bankId,
  allocations: [{ targetType: 'bill', targetId: billId, amountPaise }],
});

test('Rule 37: the unpaid share reversed after 180 days, and taken again as it is paid', async () => {
  await withFixture(async (f) => {
    const b = await bill(f, 'S-1', '2026-01-10', R(10_000));
    await pay(f, b.id, '2026-03-01', R(2_950));
    assert.deepEqual(await rule37(f.trx, f.orgId, '2026-07-08'), [], 'not yet 180 days');

    const [due] = await rule37(f.trx, f.orgId, '2026-07-31');
    assert.equal(due.status, 'due');
    assert.equal(due.dueBy, '2026-07-09');
    assert.deepEqual(due.reverse, { cgst: R(675), sgst: R(675), igst: 0, cess: 0 }, 'three quarters is unpaid');

    const itcBefore = await balance(f, CODE.ITC_CGST);
    assert.deepEqual(await postRule37(f.trx, f.orgId, null, '2026-07'), { bills: 1, totalPaise: R(1_350) });
    assert.equal(await balance(f, CODE.ITC_CGST), itcBefore - R(675));
    assert.equal(await balance(f, CODE.ITC_RECLAIMABLE), R(1_350));
    assert.equal((await gstr3b(f.trx, f.orgId, '2026-07')).itc.reversedRule37Paise, R(1_350));
    await assert.rejects(postRule37(f.trx, f.orgId, null, '2026-07'), /No bill passed/);

    await pay(f, b.id, '2026-08-20', R(8_850));
    const [paid] = await rule37(f.trx, f.orgId, '2026-08-31');
    assert.equal(paid.status, 'reclaimable');
    assert.equal(paid.reclaim.cgst + paid.reclaim.sgst, R(1_350));
    await reclaimRule37(f.trx, f.orgId, null, '2026-08');
    assert.equal(await balance(f, CODE.ITC_RECLAIMABLE), 0);
    assert.equal(await balance(f, CODE.ITC_CGST), itcBefore);
    assert.equal((await gstr3b(f.trx, f.orgId, '2026-08')).itc.reclaimedPaise, R(1_350));
    assert.equal((await rule37(f.trx, f.orgId, '2026-09-30'))[0].status, 'reclaimed');
  });
});

test('Rules 42 and 43: the exempt share of common credit, inputs and capital goods', async () => {
  await withFixture(async (f) => {
    await createInvoice(f.trx, f.orgId, null, {
      branchId: f.branchId, customerId: f.customer, date: '2026-06-10', dueDate: '2026-06-10', status: 'approved',
      lines: [
        { description: 'Parts', hsnSac: '8708', qty: 1, ratePaise: R(75_000), gstRatePct: 18 },
        { description: 'Milk', hsnSac: '0401', qty: 1, ratePaise: R(25_000), gstRatePct: 0 },
      ],
    });
    await bill(f, 'IN-1', '2026-06-05', R(10_000));
    await bill(f, 'CG-1', '2026-04-05', R(60_000), '8457', 'capital_goods');
    assert.equal(await balance(f, CODE.ITC_CGST), R(900 + 5_400), 'credit on capital goods is taken, not added to cost');

    const c = await commonCredit(f.trx, f.orgId, '2026-06');
    assert.equal(c.ratio, 0.25);
    assert.deepEqual(c.rule42, { cgst: R(225), sgst: R(225), igst: 0, cess: 0 });
    assert.deepEqual(c.capitalMonthly, { cgst: R(90), sgst: R(90), igst: 0, cess: 0 }, 'a sixtieth of ₹10,800');
    assert.deepEqual(c.rule43, { cgst: R(22.5), sgst: R(22.5), igst: 0, cess: 0 });

    await postCommonCredit(f.trx, f.orgId, null, '2026-06');
    assert.equal(await balance(f, CODE.ITC_REVERSED_EXEMPT), R(495));
    assert.equal((await gstr3b(f.trx, f.orgId, '2026-06')).itc.reversedRule42Paise, R(495));
    await assert.rejects(postCommonCredit(f.trx, f.orgId, null, '2026-06'), /already posted/);

    const year = await commonCreditYear(f.trx, f.orgId, 2026);
    assert.deepEqual(year.difference, { cgst: 0, sgst: 0, igst: 0, cess: 0 }, 'the year’s share is what the month reversed');
    await assert.rejects(postCommonCreditYear(f.trx, f.orgId, null, 2026), /once the year has ended/);
  });
});

test('reverse charge from an unregistered supplier carries our own self-invoice', async () => {
  await withFixture(async (f) => {
    const lorry = Number((await f.trx.insertInto('contacts').values({ org_id: f.orgId, kind: 'vendor', display_name: 'Lorry Owner', state_code: '33', gst_treatment: 'unregistered' } as never).executeTakeFirstOrThrow()).insertId);
    const rcm = (vendorId: number, no: string) => createBill(f.trx, f.orgId, null, {
      branchId: f.branchId, vendorId, vendorInvoiceNo: no, date: '2026-06-01', dueDate: '2026-06-01', status: 'open', isRcm: true,
      lines: [{ description: 'Freight', qty: 1, ratePaise: R(1_000), gstRatePct: 5 }],
    } as never);
    const own = await rcm(lorry, 'GR-1');
    const registered = await rcm(f.vendor, 'S-9');
    const no = async (id: number) => (await f.trx.selectFrom('bills').select('self_invoice_no').where('id', '=', id).executeTakeFirstOrThrow()).self_invoice_no;
    assert.equal(await no(own.id), 'RCM/26-27/0001');
    assert.equal(await no(registered.id), null, 'a registered supplier issues the invoice themselves');
  });
});

test.after(async () => {
  await db.destroy();
});
