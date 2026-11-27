// Edit and Delete wherever a purchases or sales record needs them (2026-11-25):
// purchase orders, bills of entry, recurring bill and expense profiles,
// payment batches, price lists, sales receipts, interest invoices, payment
// reminders, collection follow-ups and payment links — against real MySQL
// inside rolled-back transactions.
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/purchases-sales-edit-delete.test.ts
//
// What has to hold: an edit leaves the books as if the record had been entered
// right the first time, under the same number; a delete reverses what was
// posted (never erasing an entry), keeps the record where the law wants it
// kept, frees what the record held, and is refused while something rests on it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { verifyLedgerBalances } from '../../lib/server/ledger/posting';
import { createPurchaseOrder } from '../../lib/server/services/purchase-documents';
import { receiveFromPurchaseOrder } from '../../lib/server/services/order-flow';
import { createBill } from '../../lib/server/services/purchases';
import {
  deleteBill, deleteBillOfEntry, deleteGoodsReceipt, deletePurchaseOrder, purchaseOrderForEdit, updateBillOfEntry, updatePurchaseOrder,
} from '../../lib/server/services/purchase-changes';
import { recordBillOfEntry, type BillOfEntryInput } from '../../lib/server/services/bill-of-entry';
import { recurringPurchaseValues, type RecurringPurchaseBodyInput } from '../../lib/server/recurring-purchase-input';
import { runRecurringPurchase } from '../../lib/server/services/recurring';
import { deleteRecurringPurchase, updateRecurringPurchase } from '../../lib/server/services/recurring-purchases';
import { createBatch, deleteBatch, updateBatch } from '../../lib/server/services/payment-batches';
import { deletePriceList, savePriceList, setPriceListActive } from '../../lib/server/services/price-lists';
import { createSalesReceipt, deleteSalesReceipt, updateSalesReceipt } from '../../lib/server/services/sales-receipts';
import { createInvoice, deleteInvoice } from '../../lib/server/services/sales';
import { overdueInterest, raiseInterestInvoice } from '../../lib/server/services/overdue-interest';
import { deleteReminder, updateReminder } from '../../lib/server/services/reminders';
import { deleteFollowUp, logFollowUp, updateFollowUp } from '../../lib/server/services/collections';
import {
  createPaymentLink, deletePaymentLink, saveGateway, setPaymentLinkApi, setPaymentLinkCancelApi,
} from '../../lib/server/services/payment-links';
import { toPaiseFromSql } from '../../lib/server/money-sql';

interface Fixture {
  trx: Trx; orgId: number; branchId: number; acc: Record<string, number>;
  vendorId: number; customerId: number; bankId: number; cashId: number; itemId: number;
}

async function withFixture(fn: (f: Fixture) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Edit Delete Everywhere Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1, gstin: '33AAACR4849R1ZK' }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const acc = await accountIds(trx, orgId);
      const vendorId = Number((await trx.insertInto('contacts').values({
        org_id: orgId, kind: 'vendor', display_name: 'Maker', gst_treatment: 'registered', state_code: '33', pan: 'AAACS3333S', gstin: '33AAACS3333S1Z3',
        bank_account_no: '99887766', bank_ifsc: 'ICIC0000999',
      }).executeTakeFirstOrThrow()).insertId);
      const customerId = Number((await trx.insertInto('contacts').values({
        org_id: orgId, kind: 'customer', display_name: 'Walk-in', gst_treatment: 'unregistered', state_code: '33',
      } as never).executeTakeFirstOrThrow()).insertId);
      const bankId = Number((await trx.insertInto('bank_accounts').values({
        org_id: orgId, kind: 'bank', name: 'ICICI', ledger_account_id: acc[CODE.BANK_DEFAULT], opening_balance: '0.0000', account_number: '1234567890',
      }).executeTakeFirstOrThrow()).insertId);
      const cashId = Number((await trx.insertInto('bank_accounts').values({
        org_id: orgId, kind: 'cash', name: 'Cash in hand', ledger_account_id: acc[CODE.CASH], opening_balance: '0.0000',
      }).executeTakeFirstOrThrow()).insertId);
      const itemId = Number((await trx.insertInto('items').values({
        org_id: orgId, kind: 'goods', name: 'Disc', sku: 'D-1', hsn_sac: '8708', uqc: 'NOS',
        sale_price: '200.0000', purchase_price: '100.0000', gst_rate_pct: 18, track_inventory: 1,
      }).executeTakeFirstOrThrow()).insertId);
      await trx.insertInto('hsn_codes').values({ org_id: orgId, code: '8708', kind: 'hsn', description: 'Parts', gst_rate_pct: 18, is_active: 1 }).execute();
      await fn({ trx, orgId, branchId, acc, vendorId, customerId, bankId, cashId, itemId });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

test.after(() => db.destroy());

const balance = async (f: Fixture, code: string) => toPaiseFromSql((await sql<{ b: string }>`
  SELECT COALESCE(SUM(debit - credit), 0) AS b FROM journal_lines WHERE org_id = ${f.orgId} AND account_id = ${f.acc[code]}
`.execute(f.trx)).rows[0].b);
const deletedOf = (f: Fixture, type: string) => f.trx.selectFrom('deleted_documents').select(['number', 'reason', 'doc_id'])
  .where('org_id', '=', f.orgId).where('doc_type', '=', type).execute();
const balanced = async (f: Fixture) => {
  const v = await verifyLedgerBalances(f.trx, f.orgId);
  assert.equal(v.balanced, true, 'the ledger still balances');
};

test('a purchase order is edited in place under its number, and deleted once nothing rests on it', async () => {
  await withFixture(async (f) => {
    const po = await createPurchaseOrder(f.trx, f.orgId, null, {
      branchId: f.branchId, vendorId: f.vendorId, date: '2026-10-01', expectedDate: '2026-10-10', lines: [{ itemId: f.itemId, qty: 10, ratePaise: 100_00 }],
    });
    assert.equal(po.totalPaise, 1_180_00);
    await f.trx.updateTable('purchase_orders').set({ vendor_response: 'accepted' }).where('id', '=', po.id).execute();

    const edited = await updatePurchaseOrder(f.trx, f.orgId, null, po.id, {
      branchId: f.branchId, vendorId: f.vendorId, date: '2026-10-02', expectedDate: null, notes: 'Two lines now',
      lines: [{ itemId: f.itemId, qty: 5, ratePaise: 100_00 }, { description: 'Freight', qty: 1, ratePaise: 200_00, gstRatePct: 18 }],
    });
    assert.equal(edited.number, po.number, 'the same number');
    assert.equal(edited.id, po.id, 'the same row');
    assert.equal(edited.totalPaise, Math.round((500_00 + 200_00) * 1.18));
    const after = await purchaseOrderForEdit(f.trx, f.orgId, po.id);
    assert.deepEqual([after.status, after.date, after.lines.length, after.notes, after.vendorResponse], ['open', '2026-10-02', 2, 'Two lines now', null],
      'an open order stays open; the vendor’s answer was to the old one');
    assert.equal((await f.trx.selectFrom('journal_entries').select('id').where('org_id', '=', f.orgId).execute()).length, 0, 'an order posts nothing');

    // Goods received on it: neither edit nor delete until the receipt note goes.
    const lineId = Number((await f.trx.selectFrom('purchase_order_lines').select('id').where('purchase_order_id', '=', po.id).orderBy('line_no').executeTakeFirstOrThrow()).id);
    const grn = await receiveFromPurchaseOrder(f.trx, f.orgId, null, po.id, { date: '2026-10-05', lines: [{ lineId, qty: 2 }] });
    await assert.rejects(updatePurchaseOrder(f.trx, f.orgId, null, po.id, {
      branchId: f.branchId, vendorId: f.vendorId, date: '2026-10-02', lines: [{ itemId: f.itemId, qty: 1, ratePaise: 1 }],
    }), /goods were received on it/);
    await assert.rejects(deletePurchaseOrder(f.trx, f.orgId, null, po.id), (e: Error & { code?: string }) => e.code === 'locked_document' && /Delete that receipt note first/.test(e.message));
    await deleteGoodsReceipt(f.trx, f.orgId, null, grn.id);

    const gone = await deletePurchaseOrder(f.trx, f.orgId, null, po.id, 'raised twice');
    assert.equal(gone.number, po.number);
    assert.equal(await f.trx.selectFrom('purchase_orders').select('id').where('id', '=', po.id).executeTakeFirst(), undefined);
    assert.equal((await f.trx.selectFrom('purchase_order_lines').select('id').where('purchase_order_id', '=', po.id).execute()).length, 0);
    const kept = await deletedOf(f, 'purchase_order');
    assert.deepEqual(kept.map((k) => [k.number, k.reason]), [[po.number, 'raised twice']], 'the record of it is kept');
    await balanced(f);
  });
});

test('a bill of entry is edited by reversing and reposting its entry, and deleted by reversing it; a filed GSTR-3B refuses both', async () => {
  await withFixture(async (f) => {
    const input = (igst: number): BillOfEntryInput => ({
      branchId: f.branchId, vendorId: f.vendorId, boeNo: '1234567', boeDate: '2026-10-08', portCode: 'INMAA1',
      assessablePaise: 100_000_00, customsDutyPaise: 10_000_00, igstPaise: igst, cessPaise: 0, itcEligibility: 'eligible',
      dutyAccountId: f.acc[CODE.PURCHASES], paidThroughBankAccountId: f.bankId,
    });
    const made = await recordBillOfEntry(f.trx, f.orgId, null, input(19_800_00));
    assert.equal(await balance(f, CODE.ITC_IGST), 19_800_00);

    const edited = await updateBillOfEntry(f.trx, f.orgId, null, made.id, input(18_000_00));
    assert.equal(edited.id, made.id, 'the same row');
    assert.equal(await balance(f, CODE.ITC_IGST), 18_000_00, 'the credit as corrected');
    assert.equal(await balance(f, CODE.BANK_DEFAULT), -(10_000_00 + 18_000_00), 'paid at customs as corrected');
    const entries = await f.trx.selectFrom('journal_entries').select(['id', 'reversal_of_entry_id']).where('org_id', '=', f.orgId).execute();
    assert.equal(entries.length, 3, 'the first entry, its reversal and the new one: nothing erased');
    assert.equal(entries.filter((e) => e.reversal_of_entry_id).length, 1);

    // Its IGST is in a filed return: correct it in a later one instead.
    await f.trx.insertInto('gst_return_submissions').values({
      org_id: f.orgId, branch_id: f.branchId, gstin: '33AAACR4849R1ZK', return_type: 'GSTR3B', ret_period: '102026', action: 'file', provider: 'test', status: 'filed',
    }).execute();
    await assert.rejects(updateBillOfEntry(f.trx, f.orgId, null, made.id, input(1_00)), /GSTR-3B for 2026-10 is filed/);
    await assert.rejects(deleteBillOfEntry(f.trx, f.orgId, null, made.id), /GSTR-3B for 2026-10 is filed/);
    await f.trx.deleteFrom('gst_return_submissions').where('org_id', '=', f.orgId).execute();

    await deleteBillOfEntry(f.trx, f.orgId, null, made.id, 'wrong port');
    assert.equal(await balance(f, CODE.ITC_IGST), 0, 'the credit is taken back');
    assert.equal(await balance(f, CODE.BANK_DEFAULT), 0);
    assert.equal(await f.trx.selectFrom('bills_of_entry').select('id').where('id', '=', made.id).executeTakeFirst(), undefined);
    const kept = await deletedOf(f, 'bill_of_entry');
    assert.deepEqual(kept.map((k) => [k.number, k.reason]), [['1234567', 'wrong port']]);
    await balanced(f);
  });
});

test('a recurring bill profile is edited for its next runs, keeps its kind, and on delete leaves what it raised', async () => {
  await withFixture(async (f) => {
    const body = (over: Partial<RecurringPurchaseBodyInput> = {}): RecurringPurchaseBodyInput => ({
      kind: 'bill', name: 'Office rent', vendorId: f.vendorId, frequency: 'monthly', startDate: '2026-10-01', dueDays: 15, autoRun: false,
      lines: [{ accountId: f.acc[CODE.PURCHASES], description: 'Rent', qty: 1, ratePaise: 10_000_00, gstRatePct: 18 }], ...over,
    });
    const values = await recurringPurchaseValues(f.trx, f.orgId, body());
    const id = Number((await f.trx.insertInto('recurring_purchases').values({
      org_id: f.orgId, branch_id: f.branchId, kind: 'bill', ...values, next_run: '2026-10-01', is_active: 1,
    }).executeTakeFirstOrThrow()).insertId);
    const run = await runRecurringPurchase(f.trx, f.orgId, null, id);
    assert.equal(run.made.kind, 'bill');

    const r = await updateRecurringPurchase(f.trx, f.orgId, id, body({
      name: 'Office and parking', frequency: 'quarterly', startDate: '2026-10-01',
      lines: [{ accountId: f.acc[CODE.PURCHASES], description: 'Rent', qty: 1, ratePaise: 12_000_00, gstRatePct: 18 }, { accountId: f.acc[CODE.PURCHASES], description: 'Parking', qty: 1, ratePaise: 500_00, gstRatePct: 18 }],
    }));
    assert.equal(r.nextRun, '2026-11-01', 'it has run, so it keeps the next date it had');
    const p = await f.trx.selectFrom('recurring_purchases').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    const tpl = typeof p.template === 'string' ? JSON.parse(p.template) : p.template;
    assert.deepEqual([p.profile_name, p.frequency, tpl.length], ['Office and parking', 'quarterly', 2]);
    const later = await updateRecurringPurchase(f.trx, f.orgId, id, body({ startDate: '2027-01-01' }));
    assert.equal(later.nextRun, '2027-01-01', 'a later first date moves the next run');
    await assert.rejects(updateRecurringPurchase(f.trx, f.orgId, id, { ...body(), kind: 'expense' }), /stays one/);
    const bill = await f.trx.selectFrom('bills').select(['id', 'total']).where('id', '=', run.made.id).executeTakeFirstOrThrow();
    assert.equal(toPaiseFromSql(bill.total), 11_800_00, 'the bill it raised is as it was raised');

    const gone = await deleteRecurringPurchase(f.trx, f.orgId, id);
    assert.equal(gone.raised, 1);
    assert.equal(await f.trx.selectFrom('recurring_purchases').select('id').where('id', '=', id).executeTakeFirst(), undefined);
    const still = await f.trx.selectFrom('bills').select(['recurring_id']).where('id', '=', run.made.id).executeTakeFirstOrThrow();
    assert.equal(still.recurring_id, null, 'the bill stays, no longer linked');
  });
});

test('a payment batch is edited while a draft, deleted until released, and its bills are free again', async () => {
  await withFixture(async (f) => {
    const bill = await createBill(f.trx, f.orgId, null, {
      branchId: f.branchId, vendorId: f.vendorId, vendorInvoiceNo: 'M-1', date: '2026-10-01', dueDate: '2026-10-15', status: 'open',
      lines: [{ itemId: f.itemId, qty: 10, ratePaise: 100_00, gstRatePct: 18 }],
    });
    const b = await createBatch(f.trx, f.orgId, null, { branchId: f.branchId, bankAccountId: f.bankId, payDate: '2026-10-14', lines: [{ billId: bill.id, amountPaise: 500_00 }] });
    const e = await updateBatch(f.trx, f.orgId, b.id, { bankAccountId: f.bankId, payDate: '2026-10-15', notes: 'Fortnight', lines: [{ billId: bill.id, amountPaise: 1_180_00 }] });
    assert.equal(e.number, b.number);
    const row = await f.trx.selectFrom('payment_batches').selectAll().where('id', '=', b.id).executeTakeFirstOrThrow();
    assert.deepEqual([toPaiseFromSql(row.total_amount), String(row.pay_date).slice(0, 10), row.notes, row.status], [1_180_00, '2026-10-15', 'Fortnight', 'draft']);
    await assert.rejects(updateBatch(f.trx, f.orgId, b.id, { bankAccountId: f.bankId, payDate: '2026-10-15', lines: [{ billId: bill.id, amountPaise: 2_000_00 }] }), /left to pay/);

    // The bill is in a batch: it cannot be deleted until the batch goes.
    await assert.rejects(deleteBill(f.trx, f.orgId, null, bill.id), /payment batch/);
    await f.trx.updateTable('payment_batches').set({ status: 'approved' }).where('id', '=', b.id).execute();
    await assert.rejects(updateBatch(f.trx, f.orgId, b.id, { bankAccountId: f.bankId, payDate: '2026-10-15', lines: [{ billId: bill.id, amountPaise: 1_00 }] }), /released/);
    await assert.rejects(deleteBatch(f.trx, f.orgId, null, b.id), /Cancel it first/);
    await f.trx.updateTable('payment_batches').set({ status: 'paid' }).where('id', '=', b.id).execute();
    await assert.rejects(deleteBatch(f.trx, f.orgId, null, b.id), /is paid/);
    await f.trx.updateTable('payment_batches').set({ status: 'cancelled' }).where('id', '=', b.id).execute();

    await deleteBatch(f.trx, f.orgId, null, b.id, 'made by mistake');
    assert.equal(await f.trx.selectFrom('payment_batches').select('id').where('id', '=', b.id).executeTakeFirst(), undefined);
    assert.deepEqual((await deletedOf(f, 'payment_batch')).map((k) => [k.number, k.reason]), [[b.number, 'made by mistake']]);
    await deleteBill(f.trx, f.orgId, null, bill.id);
    await balanced(f);
  });
});

test('a price list in use is refused with in_use and can be marked inactive; an unused one is deleted', async () => {
  await withFixture(async (f) => {
    const id = await savePriceList(f.trx, f.orgId, { name: 'Dealers', basis: 'per_item', items: [{ itemId: f.itemId, ratePaise: 150_00 }], discounts: [{ itemId: null, minQty: 10, discountPct: 5 }] });
    await f.trx.updateTable('contacts').set({ price_list_id: id }).where('id', '=', f.customerId).execute();
    await assert.rejects(deletePriceList(f.trx, f.orgId, id), (e: Error & { code?: string }) => e.code === 'in_use' && /1 customer/.test(e.message));
    await setPriceListActive(f.trx, f.orgId, id, false);
    assert.equal((await f.trx.selectFrom('price_lists').select('is_active').where('id', '=', id).executeTakeFirstOrThrow()).is_active, 0);
    await f.trx.updateTable('contacts').set({ price_list_id: null }).where('id', '=', f.customerId).execute();
    const gone = await deletePriceList(f.trx, f.orgId, id);
    assert.equal(gone.name, 'Dealers');
    assert.equal((await f.trx.selectFrom('price_list_items').select('id').where('price_list_id', '=', id).execute()).length, 0);
    assert.equal((await f.trx.selectFrom('price_list_discounts').select('id').where('price_list_id', '=', id).execute()).length, 0);
  });
});

test('a sales receipt is edited with its counter payment, and deleted with it', async () => {
  await withFixture(async (f) => {
    const line = (rupees: number) => ({ description: 'Brake pad', hsnSac: '8708', qty: 1, ratePaise: rupees * 100, gstRatePct: 18 });
    const r = await createSalesReceipt(f.trx, f.orgId, null,
      { branchId: f.branchId, customerId: f.customerId, date: '2026-10-04', dueDate: '2026-10-04', lines: [line(1_000)] },
      { mode: 'upi', bankAccountId: f.bankId, reference: 'UPI 1' });
    assert.equal(await balance(f, CODE.BANK_DEFAULT), 1_180_00);

    // Down, then up: the payment follows the sale each time, and neither changes its number.
    for (const rupees of [500, 2_000]) {
      const e = await updateSalesReceipt(f.trx, f.orgId, null, r.id,
        { branchId: f.branchId, customerId: f.customerId, date: '2026-10-04', dueDate: '2026-10-04', lines: [line(rupees)] },
        { mode: 'cash', bankAccountId: f.cashId, reference: null });
      const total = Math.round(rupees * 100 * 1.18);
      assert.deepEqual([e.number, e.payment.number], [r.number, r.payment.number], 'the same invoice and receipt numbers');
      const inv = await f.trx.selectFrom('invoices').select(['total', 'amount_paid', 'status', 'paid_at_sale']).where('id', '=', r.id).executeTakeFirstOrThrow();
      assert.deepEqual([toPaiseFromSql(inv.total), toPaiseFromSql(inv.amount_paid), inv.status, inv.paid_at_sale], [total, total, 'paid', 1], 'born settled again');
      const pay = await f.trx.selectFrom('payments').select(['amount', 'mode', 'unapplied_amount']).where('id', '=', r.payment.id).executeTakeFirstOrThrow();
      assert.deepEqual([toPaiseFromSql(pay.amount), pay.mode, toPaiseFromSql(pay.unapplied_amount)], [total, 'cash', 0]);
      assert.equal(await balance(f, CODE.AR), 0, 'nothing owed by the customer');
      assert.deepEqual([await balance(f, CODE.BANK_DEFAULT), await balance(f, CODE.CASH)], [0, total], 'the money as taken, in cash now');
    }

    const gone = await deleteSalesReceipt(f.trx, f.orgId, null, r.id, 'rung up twice');
    assert.deepEqual([gone.number, gone.payments], [r.number, [r.payment.number]]);
    assert.equal(await f.trx.selectFrom('invoices').select('id').where('id', '=', r.id).executeTakeFirst(), undefined);
    assert.equal(await f.trx.selectFrom('payments').select('id').where('id', '=', r.payment.id).executeTakeFirst(), undefined);
    assert.deepEqual([await balance(f, CODE.BANK_DEFAULT), await balance(f, CODE.CASH)], [0, 0]);
    assert.equal(await balance(f, CODE.AR), 0);
    assert.equal((await deletedOf(f, 'invoice')).length, 1, 'the invoice number is kept as cancelled');
    assert.equal((await deletedOf(f, 'payment_received')).length, 1);
    // An ordinary invoice is not a receipt.
    const inv = await createInvoice(f.trx, f.orgId, null, { branchId: f.branchId, customerId: f.customerId, date: '2026-10-05', dueDate: '2026-10-20', status: 'approved', lines: [line(10)] });
    await assert.rejects(deleteSalesReceipt(f.trx, f.orgId, null, inv.id), /not a sales receipt/);
    await balanced(f);
  });
});

test('an interest invoice can be deleted, and the interest is owed again; the invoice it charged waits for it', async () => {
  await withFixture(async (f) => {
    const inv = await createInvoice(f.trx, f.orgId, null, {
      branchId: f.branchId, customerId: f.customerId, date: '2026-04-01', dueDate: '2026-04-30', status: 'approved',
      lines: [{ description: 'Parts', hsnSac: '8708', qty: 1, ratePaise: 10_000_00, gstRatePct: 18 }],
    });
    const charge = await raiseInterestInvoice(f.trx, f.orgId, null, { customerId: f.customerId, asOf: '2026-05-30', ratePct: 18, graceDays: 0, branchId: f.branchId });
    assert.deepEqual(await overdueInterest(f.trx, f.orgId, '2026-05-30', 18, 0), []);
    await assert.rejects(deleteInvoice(f.trx, f.orgId, null, inv.id), new RegExp(`billed on ${charge.number}`));
    await deleteInvoice(f.trx, f.orgId, null, charge.id);
    const [row] = await overdueInterest(f.trx, f.orgId, '2026-05-30', 18, 0);
    assert.deepEqual([row.invoiceId, row.days], [String(inv.id), 30], 'the same days are owed again');
    await deleteInvoice(f.trx, f.orgId, null, inv.id);
    await balanced(f);
  });
});

test('a queued reminder is edited before it goes; deleted, it is kept as skipped and not changed again', async () => {
  await withFixture(async (f) => {
    const inv = await createInvoice(f.trx, f.orgId, null, {
      branchId: f.branchId, customerId: f.customerId, date: '2026-10-01', dueDate: '2026-10-15', status: 'approved',
      lines: [{ description: 'Parts', hsnSac: '8708', qty: 1, ratePaise: 1_000_00, gstRatePct: 18 }],
    });
    const id = Number((await f.trx.insertInto('payment_reminders').values({
      org_id: f.orgId, invoice_id: inv.id, stage_days: 0, channel: 'email', to_address: 'old@walkin.test', subject: 'Reminder', queued_on: '2026-10-15',
      message: 'Dear Walk-in … {link}',
    }).executeTakeFirstOrThrow()).insertId);
    await assert.rejects(updateReminder(f.trx, f.orgId, id, { to: 'not an email', message: 'x' }), /does not look right/);
    await updateReminder(f.trx, f.orgId, id, { to: 'accounts@walkin.test', subject: 'Invoice due today', message: 'Please pay: {link}' });
    const r = await f.trx.selectFrom('payment_reminders').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    assert.deepEqual([r.to_address, r.subject, r.message, r.status], ['accounts@walkin.test', 'Invoice due today', 'Please pay: {link}', 'queued']);
    await deleteReminder(f.trx, f.orgId, null, id);
    assert.equal((await f.trx.selectFrom('payment_reminders').select('status').where('id', '=', id).executeTakeFirstOrThrow()).status, 'skipped',
      'kept, so the nightly sweep does not queue the stage again');
    await assert.rejects(updateReminder(f.trx, f.orgId, id, { message: 'again' }), /already skipped/);
    await assert.rejects(deleteReminder(f.trx, f.orgId, null, id), /already skipped/);
  });
});

test('a collection follow-up is edited and deleted', async () => {
  await withFixture(async (f) => {
    const id = await logFollowUp(f.trx, f.orgId, { id: null, name: 'Arun' }, {
      contactId: f.customerId, kind: 'call', note: 'Spoke to accounts', promisedDate: '2026-11-01', promisedPaise: 5_000_00,
    });
    await assert.rejects(updateFollowUp(f.trx, f.orgId, id, { kind: 'call', note: 'x', promisedPaise: 100 }), /when they promised/);
    const r = await updateFollowUp(f.trx, f.orgId, id, { kind: 'visit', note: 'Met the director', promisedDate: '2026-11-05', promisedPaise: 6_000_00, nextFollowup: null });
    assert.equal(r.contactId, f.customerId);
    const row = await f.trx.selectFrom('collection_followups').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    assert.deepEqual([row.kind, row.note, String(row.promised_date).slice(0, 10), toPaiseFromSql(row.promised_amount!), String(row.next_followup).slice(0, 10)],
      ['visit', 'Met the director', '2026-11-05', 6_000_00, '2026-11-05'], 'with no chase date, the promise date');
    await deleteFollowUp(f.trx, f.orgId, id);
    assert.equal(await f.trx.selectFrom('collection_followups').select('id').where('id', '=', id).executeTakeFirst(), undefined);
  });
});

test('a payment link waiting to be paid is cancelled at the gateway by Delete; a paid one is refused', async () => {
  const savedKey = process.env.INTEGRATION_KEY;
  process.env.INTEGRATION_KEY = randomBytes(32).toString('hex');
  const cancelled: string[] = [];
  setPaymentLinkApi(async () => ({ id: `plink_${cancelled.length + 1}`, short_url: 'https://rzp.io/i/x' }));
  setPaymentLinkCancelApi(async (_k, _s, linkId) => { cancelled.push(linkId); });
  try {
    await withFixture(async (f) => {
      await saveGateway(f.trx, f.orgId, { keyId: 'rzp_test_abc123', keySecret: 'secret_0123456789', webhookSecret: 'whsec_123', depositBankAccountId: f.bankId });
      const inv = await createInvoice(f.trx, f.orgId, null, {
        branchId: f.branchId, customerId: f.customerId, date: '2026-10-01', dueDate: '2026-10-15', status: 'approved',
        lines: [{ description: 'Parts', hsnSac: '8708', qty: 1, ratePaise: 1_000_00, gstRatePct: 18 }],
      });
      await createPaymentLink(f.trx, f.orgId, null, inv.id);
      const link = await f.trx.selectFrom('invoice_payment_links').select(['id', 'provider_link_id']).where('invoice_id', '=', inv.id).executeTakeFirstOrThrow();
      const first = await deletePaymentLink(f.trx, f.orgId, link.id);
      assert.equal(first.outcome, 'cancelled');
      assert.deepEqual(cancelled, [link.provider_link_id], 'cancelled at Razorpay first');
      assert.equal((await f.trx.selectFrom('invoice_payment_links').select('status').where('id', '=', link.id).executeTakeFirstOrThrow()).status, 'cancelled', 'kept as cancelled');
      const second = await deletePaymentLink(f.trx, f.orgId, link.id);
      assert.equal(second.outcome, 'removed');
      assert.equal(cancelled.length, 1, 'nothing more asked of Razorpay');

      await createPaymentLink(f.trx, f.orgId, null, inv.id);
      const paid = await f.trx.selectFrom('invoice_payment_links').select('id').where('invoice_id', '=', inv.id).executeTakeFirstOrThrow();
      await f.trx.updateTable('invoice_payment_links').set({ status: 'paid' }).where('id', '=', paid.id).execute();
      await assert.rejects(deletePaymentLink(f.trx, f.orgId, paid.id), /paid .* through this link/);
    });
  } finally {
    setPaymentLinkApi(null);
    setPaymentLinkCancelApi(null);
    if (savedKey === undefined) delete process.env.INTEGRATION_KEY; else process.env.INTEGRATION_KEY = savedKey;
  }
});
