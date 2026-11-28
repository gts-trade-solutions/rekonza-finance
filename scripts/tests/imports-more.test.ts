// Imports for the rest of Zoho's list: quotes, sales orders, credit notes,
// purchase orders, expenses, and payments received and made — all or nothing,
// with every failing row named.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/imports-more.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { runImport, type ImportContext } from '../../lib/server/imports/run';
import { IMPORT_KINDS, TEMPLATES } from '../../lib/imports/templates';
import { EXPORT_MODULE_FOR } from '../../lib/imports/json';

async function withBook(fn: (trx: Trx, ctx: ImportContext) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Import Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1, gstin: '33AABCI3131I1Z2' }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const acc = await accountIds(trx, orgId);
      await trx.insertInto('bank_accounts').values({ org_id: orgId, kind: 'bank', name: 'HDFC Current', ledger_account_id: acc[CODE.BANK_DEFAULT], opening_balance: '0.0000' }).execute();
      const ctx: ImportContext = { orgId, userId: null, branchId, onDuplicate: 'error' };
      const parties = await runImport(trx, ctx, 'contacts', [
        { name: 'Sri Murugan Motors', type: 'customer', state: '33' }, { name: 'Lakshmi Auto', type: 'vendor', state: '33' },
      ]);
      assert.equal(parties.created, 2);
      await fn(trx, ctx);
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

const line = (qty: string, rate: string) => ({ description: 'Brake pad set', hsn_sac: '8708', qty, rate, gst_rate: '18' });

test('every import kind has a template, a permission module and an export it reads back', () => {
  for (const k of IMPORT_KINDS) {
    assert.ok(TEMPLATES[k].columns.length, k);
    assert.ok(EXPORT_MODULE_FOR[k], k);
  }
  assert.ok(IMPORT_KINDS.includes('payments-received') && IMPORT_KINDS.includes('purchase-orders'));
});

test('quotes, sales orders, credit notes and purchase orders: rows grouped by number into documents', async () => {
  await withBook(async (trx, ctx) => {
    const q = await runImport(trx, ctx, 'estimates', [
      { number: 'EST-1', date: '2026-09-01', customer: 'Sri Murugan Motors', ...line('2', '850') },
      { number: 'EST-1', date: '2026-09-01', customer: 'Sri Murugan Motors', ...line('1', '300') },
      { number: 'EST-2', date: '2026-09-02', expiry_date: '2026-09-30', customer: 'Sri Murugan Motors', ...line('1', '100') },
    ]);
    assert.deepEqual([q.created, q.errors], [2, []]);
    const est = await trx.selectFrom('estimates').select(['number', 'status', 'subtotal', 'expiry_date']).where('org_id', '=', ctx.orgId).orderBy('number').execute();
    assert.deepEqual(est.map((e) => [e.number, e.status, Number(e.subtotal)]), [['EST-1', 'sent', 2000], ['EST-2', 'sent', 100]]);
    assert.equal(String(est[0].expiry_date).slice(0, 10), '2026-10-01', 'valid for 30 days when not given');

    const so = await runImport(trx, ctx, 'sales-orders', [{ number: 'SO-1', date: '2026-09-03', customer: 'Sri Murugan Motors', ...line('3', '850') }]);
    assert.equal(so.created, 1);
    const po = await runImport(trx, ctx, 'purchase-orders', [{ number: 'PO-1', date: '2026-09-03', vendor: 'Lakshmi Auto', ...line('10', '600') }]);
    assert.equal(po.created, 1);
    assert.equal((await trx.selectFrom('purchase_orders').select('status').where('number', '=', 'PO-1').where('org_id', '=', ctx.orgId).executeTakeFirstOrThrow()).status, 'open');

    const inv = await runImport(trx, ctx, 'invoices', [{ invoice_no: 'INV-1', date: '2026-09-04', customer: 'Sri Murugan Motors', ...line('2', '850') }]);
    assert.equal(inv.created, 1);
    const cn = await runImport(trx, ctx, 'credit-notes', [
      { number: 'CN-1', date: '2026-09-10', customer: 'Sri Murugan Motors', reason: 'Goods returned', against_invoice: 'INV-1', ...line('1', '850') },
    ]);
    assert.deepEqual([cn.created, cn.errors], [1, []]);
    const bad = await runImport(trx, ctx, 'credit-notes', [
      { number: 'CN-2', date: '2026-09-10', customer: 'Sri Murugan Motors', reason: 'x', against_invoice: 'INV-404', ...line('1', '10') },
      { number: 'CN-3', date: '2026-09-10', customer: 'Lakshmi Auto', reason: 'x', ...line('1', '10') },
    ]);
    assert.equal(bad.errors.length, 2);
    assert.match(bad.errors[0].message, /INV-404 is not in your books/);
    assert.match(bad.errors[1].message, /set up as a vendor, not a customer/);
  });
});

test('expenses and payments: posted, settling the named invoice or bill; bad rows named', async () => {
  await withBook(async (trx, ctx) => {
    const ex = await runImport(trx, ctx, 'expenses', [
      { date: '2026-09-05', account_code: '6500', paid_through: 'HDFC Current', total: '1180', gst_rate: '18', vendor: 'Lakshmi Auto', notes: 'Diesel' },
      { date: '2026-09-06', account_code: 'Office Supplies', paid_through: 'hdfc current', total: '250', customer: 'Sri Murugan Motors' },
      { date: '2026-09-06', account_code: '9999', paid_through: 'HDFC Current', total: '1' },
      { date: '2026-09-06', account_code: '6500', paid_through: 'Petty cash tin', total: '1' },
    ]);
    assert.equal(ex.created, 2);
    assert.deepEqual(ex.errors.map((e) => e.row), [4, 5]);
    assert.match(ex.errors[0].message, /Account 9999 is not in your chart/);
    assert.match(ex.errors[1].message, /not one of your bank or cash accounts/);
    const rows = await trx.selectFrom('expenses').select(['amount', 'total', 'is_billable']).where('org_id', '=', ctx.orgId).orderBy('id').execute();
    assert.deepEqual(rows.map((r) => [Number(r.amount), Number(r.total), r.is_billable]), [[1000, 1180, 0], [250, 250, 1]]);

    await runImport(trx, ctx, 'invoices', [{ invoice_no: 'INV-9', date: '2026-09-04', customer: 'Sri Murugan Motors', ...line('2', '1000') }]);
    await runImport(trx, ctx, 'bills', [{ bill_no: 'LA/77', date: '2026-09-04', vendor: 'Lakshmi Auto', ...line('5', '600') }]);
    const rec = await runImport(trx, ctx, 'payments-received', [
      { date: '2026-09-15', customer: 'Sri Murugan Motors', amount: '1000', mode: 'upi', account: 'HDFC Current', reference: 'UTR 1', invoice: 'INV-9' },
      { date: '2026-09-15', customer: 'Sri Murugan Motors', amount: '500', account: 'HDFC Current' },
      { date: '2026-09-15', customer: 'Sri Murugan Motors', amount: '5', account: 'HDFC Current', mode: 'barter' },
    ]);
    assert.equal(rec.created, 2);
    assert.match(rec.errors[0].message, /"barter" should be one of/);
    const invRow = await trx.selectFrom('invoices').select(['amount_paid', 'status']).where('number', '=', 'INV-9').where('org_id', '=', ctx.orgId).executeTakeFirstOrThrow();
    assert.equal(Number(invRow.amount_paid), 1000, 'the named invoice is settled by the receipt');
    const onAccount = await trx.selectFrom('payments').select('unapplied_amount').where('org_id', '=', ctx.orgId).where('kind', '=', 'received').where('amount', '=', '500.0000').executeTakeFirstOrThrow();
    assert.equal(Number(onAccount.unapplied_amount), 500, 'no invoice named: kept on account');

    const paid = await runImport(trx, ctx, 'payments-made', [
      { date: '2026-09-16', vendor: 'Lakshmi Auto', amount: '3540', mode: 'neft', account: 'HDFC Current', bill: 'LA/77' },
      { date: '2026-09-16', vendor: 'Lakshmi Auto', amount: '10', account: 'HDFC Current', bill: 'LA/404' },
    ]);
    assert.equal(paid.created, 1);
    assert.match(paid.errors[0].message, /Bill LA\/404 is not one of Lakshmi Auto's/);
    assert.equal((await trx.selectFrom('bills').select('status').where('vendor_invoice_no', '=', 'LA/77').where('org_id', '=', ctx.orgId).executeTakeFirstOrThrow()).status, 'paid');
  });
});

test('payments as banks and Zoho write them: RTGS, "Bank Transfer", two-digit years, 1,200 Cr; a file imported twice is skipped; problems name the file line', async () => {
  await withBook(async (trx, ctx) => {
    const rows = [
      { date: '15/09/26', customer: 'Sri Murugan Motors', amount: '1,200.00 Cr', mode: 'RTGS', account: 'HDFC Current', reference: 'UTR 77', __line: '7' },
      { date: '16-Sep-26', customer: 'Sri Murugan Motors', amount: '800', mode: 'Bank Transfer', account: 'HDFC Current', __line: '9' },
      { date: '17/09/2026', customer: 'Sri Murugan Motors', amount: '5', mode: 'barter', account: 'HDFC Current', __line: '12' },
    ];
    const first = await runImport(trx, ctx, 'payments-received', rows);
    assert.equal(first.created, 2);
    assert.deepEqual(first.errors.map((e) => e.row), [12], 'the line in the file, not the count of rows read');
    const modes = await trx.selectFrom('payments').select(['mode', 'payment_date', 'amount']).where('org_id', '=', ctx.orgId).orderBy('id').execute();
    assert.deepEqual(modes.map((m) => [m.mode, String(m.payment_date).slice(0, 10), Number(m.amount)]), [['rtgs', '2026-09-15', 1200], ['neft', '2026-09-16', 800]]);
    // The same file again: skipped with "skip duplicates", refused by name otherwise.
    const again = await runImport(trx, { ...ctx, onDuplicate: 'skip' }, 'payments-received', rows.slice(0, 2));
    assert.equal(again.created, 0);
    assert.equal(again.skipped, 2);
    const strict = await runImport(trx, ctx, 'payments-received', rows.slice(0, 1));
    assert.match(strict.errors[0].message, /already in your books/);
  });
});

test('a supplier’s bill entered twice: refused by name; skipped on import; a voided one frees its number; look-alikes flagged', async () => {
  const { findBillDuplicates, billKey } = await import('../../lib/server/services/bill-duplicates');
  await withBook(async (trx, ctx) => {
    await runImport(trx, ctx, 'bills', [{ bill_no: 'LA/77', date: '2026-09-04', vendor: 'Lakshmi Auto', ...line('5', '600') }]);
    const vendorId = Number((await trx.selectFrom('contacts').select('id').where('org_id', '=', ctx.orgId).where('display_name', '=', 'Lakshmi Auto').executeTakeFirstOrThrow()).id);
    // The same bill again: refused with the bill it repeats, or skipped.
    const again = await runImport(trx, ctx, 'bills', [{ bill_no: 'LA/77', date: '2026-09-04', vendor: 'Lakshmi Auto', ...line('5', '600') }]);
    assert.match(again.errors[0].message, /already in your books as BILL/);
    const skipped = await runImport(trx, { ...ctx, onDuplicate: 'skip' }, 'bills', [{ bill_no: 'la/77', date: '2026-09-04', vendor: 'Lakshmi Auto', ...line('5', '600') }]);
    assert.equal(skipped.skipped, 1, 'the number in another case is the same number');
    // Look-alikes: written differently, or the same amount on the same day.
    assert.equal(billKey('INV-001'), billKey('inv1'));
    const bill = await trx.selectFrom('bills').select(['id', 'total']).where('org_id', '=', ctx.orgId).where('vendor_invoice_no', '=', 'LA/77').executeTakeFirstOrThrow();
    const look = await findBillDuplicates(trx, ctx.orgId, { vendorId, vendorInvoiceNo: 'LA-077' });
    assert.equal(look.exact, null);
    assert.match(look.likely[0].why, /same bill number but for leading zeros, written as LA\/77/);
    const sameDay = await findBillDuplicates(trx, ctx.orgId, { vendorId, vendorInvoiceNo: 'ZZ-1', totalPaise: Math.round(Number(bill.total) * 100), date: '2026-09-04' });
    assert.match(sameDay.likely[0].why, /same amount on the same day/);
    // Voided, the number is free for the corrected bill.
    await trx.updateTable('bills').set({ status: 'void' }).where('id', '=', bill.id).execute();
    const fresh = await runImport(trx, ctx, 'bills', [{ bill_no: 'LA/77', date: '2026-09-05', vendor: 'Lakshmi Auto', ...line('4', '600') }]);
    assert.equal(fresh.created, 1, fresh.errors.map((e) => e.message).join('; '));
  });
});

test.after(() => db.destroy());
