// GSTR-9C: what reaches the books without a GST document is what fails to
// reconcile, and the statement says so.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/gstr9c.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { postEntry } from '../../lib/server/ledger/posting';
import { createInvoice } from '../../lib/server/services/sales';
import { createBill } from '../../lib/server/services/purchases';
import { receivePayment } from '../../lib/server/services/payments';
import { gstr9 } from '../../lib/server/gst/gstr9';
import { gstr9c } from '../../lib/server/gst/gstr9c';

interface Fixture { trx: Trx; orgId: number; branchId: number; customer: number; vendor: number; bankId: number; acc: Record<string, number> }

async function withFixture(fn: (f: Fixture) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: '9C Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({
        org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1, gstin: '33AAAAA0000A1Z5',
      }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const acc = await accountIds(trx, orgId);
      const mk = async (v: Record<string, unknown>) =>
        Number((await trx.insertInto('contacts').values({ org_id: orgId, state_code: '33', ...v } as never).executeTakeFirstOrThrow()).insertId);
      const bankId = Number((await trx.insertInto('bank_accounts').values({
        org_id: orgId, kind: 'bank', name: 'Current', ledger_account_id: acc[CODE.BANK_DEFAULT], opening_balance: '0.0000',
      }).executeTakeFirstOrThrow()).insertId);
      await fn({
        trx, orgId, branchId, acc, bankId,
        customer: await mk({ kind: 'customer', display_name: 'Buyer', gst_treatment: 'unregistered' }),
        vendor: await mk({ kind: 'vendor', display_name: 'Supplier', gst_treatment: 'registered', gstin: '33BBBBB0000B1Z5' }),
      });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

const line = (rows: { ref: string; paise: number }[], ref: string) => rows.find((r) => r.ref === ref)!.paise;

test('documents alone reconcile to nil', async () => {
  await withFixture(async (f) => {
    await createInvoice(f.trx, f.orgId, null, {
      branchId: f.branchId, customerId: f.customer, date: '2026-06-01', dueDate: '2026-06-30', status: 'approved',
      lines: [{ description: 'Goods', qty: 2, ratePaise: 50_000_00, gstRatePct: 18 }],
    });
    await createBill(f.trx, f.orgId, null, {
      branchId: f.branchId, vendorId: f.vendor, vendorInvoiceNo: 'S-1', date: '2026-06-02', dueDate: '2026-07-02',
      lines: [{ description: 'Stock', qty: 1, ratePaise: 40_000_00, gstRatePct: 18 }],
    });
    const r = await gstr9c(f.trx, f.orgId, 2026);
    assert.equal(line(r.table5, '5A'), 1_00_000_00);
    assert.equal(line(r.table5, '5Q'), 1_00_000_00);
    assert.deepEqual(r.unreconciled, { turnoverPaise: 0, taxableTurnoverPaise: 0, taxPaise: 0, itcPaise: 0 });
    assert.equal(r.table6.length, 0);
    assert.equal(r.table9.byRate[0].ratePct, 18);
    assert.equal(r.table9.heads.find((h) => h.head === 'CGST')!.booksPaise, 9_000_00);
    assert.equal(line(r.table12, '12A'), 7_200_00);
  });
});

test('a manual journal to sales, and shipping outside the taxable value, are the reasons', async () => {
  await withFixture(async (f) => {
    await createInvoice(f.trx, f.orgId, null, {
      branchId: f.branchId, customerId: f.customer, date: '2026-06-01', dueDate: '2026-06-30', status: 'approved',
      shippingChargePaise: 500_00,
      lines: [{ description: 'Goods', qty: 1, ratePaise: 10_000_00, gstRatePct: 18 }],
    });
    await postEntry(f.trx, {
      orgId: f.orgId, branchId: f.branchId, date: '2026-09-30', sourceType: 'manual', memo: 'Sale booked by journal',
      lines: [
        { accountId: f.acc[CODE.CASH], debit: 2_000_00 },
        { accountId: f.acc[CODE.SALES], credit: 2_000_00 },
      ],
    });
    const r = await gstr9c(f.trx, f.orgId, 2026);
    assert.equal(line(r.table5, '5A'), 12_500_00, 'books: 10,000 + 500 shipping + 2,000 by journal');
    assert.equal(line(r.table5, '5Q'), 10_000_00);
    assert.equal(r.unreconciled.turnoverPaise, -2_500_00);
    const reasons = Object.fromEntries(r.table6.map((x) => [x.source, x.paise]));
    assert.equal(reasons.manual, 2_000_00);
    assert.equal(reasons.invoice_charges, 500_00);
    assert.equal(r.table6.reduce((t, x) => t + x.paise, 0), -r.unreconciled.turnoverPaise, 'the reasons explain it all');
  });
});

test('an advance taxed and not invoiced by year end is in 4F, and 5C/5I carry it', async () => {
  await withFixture(async (f) => {
    await receivePayment(f.trx, f.orgId, null, {
      branchId: f.branchId, contactId: f.customer, date: '2027-02-10', mode: 'neft', amountPaise: 11_800_00,
      bankAccountId: f.bankId, advanceGst: { ratePct: 18 },
    });
    const nine = await gstr9(f.trx, f.orgId, 2026);
    assert.equal(nine.table4.advances.taxablePaise, 10_000_00);
    assert.equal(nine.table4.advances.cgstPaise + nine.table4.advances.sgstPaise, 1_800_00);

    const r = await gstr9c(f.trx, f.orgId, 2026);
    assert.equal(line(r.table5, '5C'), 10_000_00);
    assert.equal(line(r.table5, '5I'), 0);
    assert.equal(r.unreconciled.turnoverPaise, 0, 'the advance is in both');
    assert.equal(r.unreconciled.taxPaise, 0);

    // The next year starts with it outstanding.
    const next = await gstr9c(f.trx, f.orgId, 2027);
    assert.equal(line(next.table5, '5I'), -10_000_00);
  });
});

test.after(async () => {
  await db.destroy();
});
