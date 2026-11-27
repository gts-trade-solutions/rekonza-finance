// Duplicate invoice detection (status review 7, item 8), as the auditors test
// it: the same supplier bill number again is refused however it is written,
// a bill that only looks like another needs a reason that is kept, another
// vendor may use the same number, an edit cannot take a number already used,
// expenses and goods receipts are checked too, the register is cleared or
// confirmed by an accountant, and on the sales side an invoice number is used
// once and a customer PO twice is warned.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/duplicate-bills.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { createBill, createExpense } from '../../lib/server/services/purchases';
import { updateBill } from '../../lib/server/services/purchase-changes';
import { receiveGoods } from '../../lib/server/services/order-flow';
import { createInvoice } from '../../lib/server/services/sales';
import { billNumberKey, findBillDuplicates } from '../../lib/server/services/bill-duplicates';
import { listDuplicateReviews, reviewDuplicate, scanForDuplicates } from '../../lib/server/services/duplicate-reviews';

interface Fixture { trx: Trx; orgId: number; userId: number; branchId: number; vendorX: number; vendorY: number; customerId: number; itemId: number; bankId: number; expenseAccount: number }

async function withFixture(fn: (f: Fixture) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Dup Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1 }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const acc = await accountIds(trx, orgId);
      const userId = Number((await trx.insertInto('users').values({ org_id: orgId, name: 'Priya', email: `priya-${orgId}@example.test`, role: 'accountant' } as never).executeTakeFirstOrThrow()).insertId);
      const mk = async (values: Record<string, unknown>) => Number((await trx.insertInto('contacts').values(values as never).executeTakeFirstOrThrow()).insertId);
      const vendorX = await mk({ org_id: orgId, kind: 'vendor', display_name: 'Vendor X', gst_treatment: 'unregistered', state_code: '33' });
      const vendorY = await mk({ org_id: orgId, kind: 'vendor', display_name: 'Vendor Y', gst_treatment: 'unregistered', state_code: '33' });
      const customerId = await mk({ org_id: orgId, kind: 'customer', display_name: 'Customer Z', gst_treatment: 'unregistered', state_code: '33' });
      await trx.insertInto('hsn_codes').values({ org_id: orgId, code: '8708', kind: 'hsn', description: 'Parts', gst_rate_pct: 18, is_active: 1 }).execute();
      const itemId = Number((await trx.insertInto('items').values({
        org_id: orgId, kind: 'goods', name: 'Brake pad', hsn_sac: '8708', uqc: 'NOS', sale_price: '200.0000', purchase_price: '100.0000',
        gst_rate_pct: 18, track_inventory: 1, sale_account_id: acc[CODE.SALES], purchase_account_id: acc[CODE.PURCHASES],
      }).executeTakeFirstOrThrow()).insertId);
      const bankId = Number((await trx.insertInto('bank_accounts').values({ org_id: orgId, kind: 'bank', name: 'Bank', ledger_account_id: acc[CODE.BANK_DEFAULT], opening_balance: '0.0000' }).executeTakeFirstOrThrow()).insertId);
      await fn({ trx, orgId, userId, branchId, vendorX, vendorY, customerId, itemId, bankId, expenseAccount: acc[CODE.RENT] });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

const bill = (f: Fixture, vendorId: number, no: string, date = '2026-04-10', qty = 10, duplicateReason?: string) =>
  createBill(f.trx, f.orgId, f.userId, {
    branchId: f.branchId, vendorId, vendorInvoiceNo: no, date, dueDate: date, lines: [{ itemId: f.itemId, qty, ratePaise: 10_000 }], duplicateReason,
  });
const refusedAs = (code: string, re?: RegExp) => (e: unknown) => {
  const err = e as { code?: string; message?: string };
  assert.equal(err.code, code, err.message);
  if (re) assert.match(err.message ?? '', re);
  return true;
};

test('the number as compared: case, spaces and separators ignored', () => {
  for (const v of ['INV-001', 'inv-001', 'INV001', ' INV/001 ', 'Inv.001', 'INV_001']) assert.equal(billNumberKey(v), 'INV001', v);
  assert.notEqual(billNumberKey('INV-01'), billNumberKey('INV-001'));
});

test('the same bill number from the same vendor is refused, however it is written; another vendor may use it', async () => {
  await withFixture(async (f) => {
    const first = await bill(f, f.vendorX, 'INV-001');
    for (const v of ['INV-001', 'INV001', 'inv-001', ' INV/001 ']) {
      await assert.rejects(bill(f, f.vendorX, v, '2026-04-20', 3), refusedAs('duplicate_bill', new RegExp(`already in your books as ${first.internalNo}`)), v);
    }
    // The refusal names the first bill, with the way to it.
    try { await bill(f, f.vendorX, 'inv-001', '2026-04-20', 3); } catch (e) {
      assert.equal((e as { details?: { href?: string } }).details?.href, `/purchases/bills/${first.id}`);
    }
    const other = await bill(f, f.vendorY, 'INV-001');
    assert.ok(other.id > 0, 'another vendor may have its own INV-001');
  });
});

test('the same amount from the same vendor within a week, under another number, needs a reason that is kept', async () => {
  await withFixture(async (f) => {
    const first = await bill(f, f.vendorX, 'INV-001', '2026-04-10');
    await assert.rejects(bill(f, f.vendorX, 'INV-002', '2026-04-13'), refusedAs('possible_duplicate', /same amount 3 day\(s\) apart/));
    await assert.rejects(bill(f, f.vendorX, 'INV-0001', '2026-05-30', 7), refusedAs('possible_duplicate', /leading zeros/));
    const saved = await bill(f, f.vendorX, 'INV-002', '2026-04-13', 10, 'Second delivery of the same order, separate invoice');
    assert.ok(saved.warnings.some((w) => /Possible duplicate bills list/.test(w)));
    const reg = await listDuplicateReviews(f.trx, f.orgId, { status: 'open' });
    assert.equal(reg.rows.length, 1);
    assert.equal(reg.rows[0].doc.id, String(saved.id));
    assert.equal(reg.rows[0].twin.id, String(first.id));
    assert.equal(reg.rows[0].enteredReason, 'Second delivery of the same order, separate invoice');
    assert.equal(reg.rows[0].enteredBy, 'Priya');
    // A different amount, or a month apart, is no near miss.
    await bill(f, f.vendorX, 'INV-003', '2026-04-11', 4);
    await bill(f, f.vendorX, 'INV-004', '2026-06-10', 10);

    // The accountant clears it with a note; a note is required; it can be reopened and confirmed.
    await assert.rejects(reviewDuplicate(f.trx, f.orgId, f.userId, Number(reg.rows[0].id), 'clear', ''), /Say why/);
    await reviewDuplicate(f.trx, f.orgId, f.userId, Number(reg.rows[0].id), 'clear', 'Checked with the supplier: two deliveries');
    assert.equal((await listDuplicateReviews(f.trx, f.orgId, { status: 'cleared' })).rows.length, 1);
    await reviewDuplicate(f.trx, f.orgId, f.userId, Number(reg.rows[0].id), 'reopen');
    await reviewDuplicate(f.trx, f.orgId, f.userId, Number(reg.rows[0].id), 'confirm', 'Same goods billed twice: void BILL');
    assert.equal((await listDuplicateReviews(f.trx, f.orgId, { status: 'confirmed' })).counts.confirmed, 1);
  });
});

test('an edit cannot change a bill number to one already used', async () => {
  await withFixture(async (f) => {
    await bill(f, f.vendorX, 'INV-001');
    const second = await bill(f, f.vendorX, 'INV-009', '2026-05-20', 4);
    await assert.rejects(updateBill(f.trx, f.orgId, f.userId, second.id, {
      branchId: f.branchId, vendorId: f.vendorX, vendorInvoiceNo: 'inv/001', date: '2026-05-20', dueDate: '2026-05-20',
      lines: [{ itemId: f.itemId, qty: 4, ratePaise: 10_000 }],
    }), refusedAs('duplicate_bill'));
  });
});

test('expenses and goods receipts carrying a supplier invoice number are checked too', async () => {
  await withFixture(async (f) => {
    await bill(f, f.vendorX, 'INV-001');
    const expense = (reference: string, amountPaise = 5_000) => createExpense(f.trx, f.orgId, f.userId, {
      branchId: f.branchId, date: '2026-04-15', accountId: f.expenseAccount, paidThroughBankAccountId: f.bankId, amountPaise, vendorId: f.vendorX, reference,
    });
    await assert.rejects(expense('INV 001'), refusedAs('duplicate_bill', /already in your books/));
    await expense('RCPT-77');
    // A bill for the same invoice an expense already booked is refused as well.
    await assert.rejects(bill(f, f.vendorX, 'rcpt77', '2026-04-15', 1), refusedAs('duplicate_bill', /expense/));
    const receive = (challan: string) => receiveGoods(f.trx, f.orgId, f.userId, {
      branchId: f.branchId, vendorId: f.vendorY, date: '2026-04-16', vendorChallanNo: challan, lines: [{ itemId: f.itemId, qty: 2, ratePaise: 10_000 }],
    });
    await receive('DC-55');
    await assert.rejects(receive('dc 55'), refusedAs('duplicate_receipt', /already on goods receipt/));
  });
});

test('a scan finds near misses entered before the check, once', async () => {
  await withFixture(async (f) => {
    const a = await bill(f, f.vendorX, 'A-1', '2026-04-10');
    // Entered straight into the table, as an older import might have.
    await f.trx.updateTable('bills').set({ vendor_invoice_no: 'A-01' }).where('id', '=', (await bill(f, f.vendorY, 'B-1')).id).execute();
    const twin = await bill(f, f.vendorX, 'A-77', '2026-04-11', 10, 'Separate invoice');
    assert.equal(await scanForDuplicates(f.trx, f.orgId, f.userId), 0, 'the pair saved with a reason is already on the register');
    await f.trx.deleteFrom('duplicate_reviews').where('org_id', '=', f.orgId).execute();
    assert.equal(await scanForDuplicates(f.trx, f.orgId, f.userId), 1);
    assert.equal(await scanForDuplicates(f.trx, f.orgId, f.userId), 0, 'once');
    const found = await findBillDuplicates(f.trx, f.orgId, { vendorId: f.vendorX, vendorInvoiceNo: 'A-0001' });
    assert.ok(found.exact === null && found.likely.some((l) => l.id === String(a.id)));
    void twin;
  });
});

test('sales: an invoice number is used once in its series, and a customer PO used twice is warned', async () => {
  await withFixture(async (f) => {
    const sell = (number: string | undefined, orderNumber: string | undefined) => createInvoice(f.trx, f.orgId, f.userId, {
      branchId: f.branchId, customerId: f.customerId, date: '2026-04-20', dueDate: '2026-04-20', status: 'approved', number, orderNumber,
      lines: [{ itemId: f.itemId, qty: 1, ratePaise: 20_000 }],
    });
    const first = await sell('INV-T-1', 'PO-123');
    await assert.rejects(sell('INV-T-1', undefined), refusedAs('duplicate_number', /already used/));
    const second = await sell(undefined, 'po 123');
    assert.ok(second.warnings?.some((w) => /Customer PO po 123 is already on/.test(w)));
    const reg = await listDuplicateReviews(f.trx, f.orgId);
    assert.ok(reg.rows.some((r) => r.doc.type === 'invoice' && r.doc.id === String(second.id) && r.twin.id === String(first.id)));
  });
});

test.after(() => db.destroy());
