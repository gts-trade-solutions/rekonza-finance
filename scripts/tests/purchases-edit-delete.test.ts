// Edit and Delete on bills, vendor credits and goods receipts, as Zoho Books has
// them (services/purchase-changes.ts), against real MySQL inside rolled-back
// transactions.
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/purchases-edit-delete.test.ts
//
// What has to hold: an edit leaves the ledger exactly as if the document had
// been entered right the first time (the old entry reversed, never erased), on
// the same row under the same number; a delete leaves a reversed pair and a
// deleted_documents record, gives back what the document held (order and
// receipt quantities, the receipt-note accrual), and is refused while
// something rests on it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { verifyLedgerBalances } from '../../lib/server/ledger/posting';
import { createBill, type CreateBillInput } from '../../lib/server/services/purchases';
import { createPurchaseOrder, createVendorCredit, refundVendorCredit } from '../../lib/server/services/purchase-documents';
import { billFromGoodsReceipt, billFromPurchaseOrder, receiveFromPurchaseOrder, receiveGoods } from '../../lib/server/services/order-flow';
import { makePayment } from '../../lib/server/services/payments';
import {
  deleteBill, deleteGoodsReceipt, deleteVendorCredit, goodsReceiptForEdit, updateBill, updateGoodsReceipt,
  updateVendorCredit, vendorCreditForEdit,
} from '../../lib/server/services/purchase-changes';
import { gstr3b } from '../../lib/server/gst/returns';
import { gstr1PortalFile } from '../../lib/server/gst/gstr1-json';
import { stockPosition } from '../../lib/server/reports/stock';
import { toPaiseFromSql } from '../../lib/server/money-sql';

interface Fixture { trx: Trx; orgId: number; branchId: number; acc: Record<string, number>; vendorId: number; unregId: number; bankId: number; itemId: number }

async function withFixture(fn: (f: Fixture) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Purchases Edit Delete Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1, gstin: '33AAACR4849R1ZK' }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const acc = await accountIds(trx, orgId);
      const vendorId = Number((await trx.insertInto('contacts').values({
        org_id: orgId, kind: 'vendor', display_name: 'Maker', gst_treatment: 'registered', state_code: '33', pan: 'AAACS3333S', gstin: '33AAACS3333S1Z3',
      }).executeTakeFirstOrThrow()).insertId);
      const unregId = Number((await trx.insertInto('contacts').values({
        org_id: orgId, kind: 'vendor', display_name: 'Local Carrier', gst_treatment: 'unregistered', state_code: '33', pan: 'AAAPL5555L',
      }).executeTakeFirstOrThrow()).insertId);
      const bankId = Number((await trx.insertInto('bank_accounts').values({
        org_id: orgId, kind: 'bank', name: 'ICICI', ledger_account_id: acc[CODE.BANK_DEFAULT], opening_balance: '0.0000',
      }).executeTakeFirstOrThrow()).insertId);
      const itemId = Number((await trx.insertInto('items').values({
        org_id: orgId, kind: 'goods', name: 'Disc', sku: 'D-1', hsn_sac: '8708', uqc: 'NOS',
        sale_price: '200.0000', purchase_price: '100.0000', gst_rate_pct: 18, track_inventory: 1,
      }).executeTakeFirstOrThrow()).insertId);
      await trx.insertInto('hsn_codes').values({ org_id: orgId, code: '8708', kind: 'hsn', description: 'Parts', gst_rate_pct: 18, is_active: 1 }).execute();
      await fn({ trx, orgId, branchId, acc, vendorId, unregId, bankId, itemId });
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
const onHand = async (f: Fixture) =>
  (await stockPosition(f.trx, f.orgId, '2026-12-31')).lines.find((l) => l.itemId === String(f.itemId))?.qty ?? 0;
const lineIds = async (f: Fixture, table: 'purchase_order_lines' | 'goods_receipt_lines', fk: string, id: number) =>
  (await sql<{ id: number }>`SELECT id FROM ${sql.table(table)} WHERE ${sql.ref(fk)} = ${id} ORDER BY line_no`.execute(f.trx)).rows.map((r) => Number(r.id));

const bill = (f: Fixture, qty: number, extra: Partial<CreateBillInput> = {}): CreateBillInput => ({
  branchId: f.branchId, vendorId: f.vendorId, vendorInvoiceNo: 'M-101', date: '2026-10-05', dueDate: '2026-11-04', status: 'open',
  lines: [{ itemId: f.itemId, qty, ratePaise: 100_00, gstRatePct: 18 }], ...extra,
});
const pay = (f: Fixture, billId: number, amountPaise: number) => makePayment(f.trx, f.orgId, null, {
  branchId: f.branchId, contactId: f.vendorId, date: '2026-10-06', mode: 'neft', amountPaise, bankAccountId: f.bankId,
  allocations: [{ targetType: 'bill', targetId: billId, amountPaise }],
});

// ── Bills ───────────────────────────────────────────────────────────────────

test('editing a bill rewrites it in place and the ledger is as if it were right first time', async () => {
  await withFixture(async (f) => {
    const b = await createBill(f.trx, f.orgId, null, bill(f, 2));
    assert.equal(await balance(f, CODE.AP), -236_00);

    const edited = await updateBill(f.trx, f.orgId, null, b.id, { ...bill(f, 5), notes: 'Five, not two' });
    assert.equal(edited.id, b.id, 'same row');
    assert.equal(edited.internalNo, b.internalNo, 'same number');
    assert.equal(edited.totalPaise, 590_00);
    const row = await f.trx.selectFrom('bills').select(['status', 'total', 'notes', 'journal_entry_id']).where('id', '=', b.id).executeTakeFirstOrThrow();
    assert.equal(row.status, 'open', 'an entered bill stays entered');
    assert.equal(row.notes, 'Five, not two');
    assert.notEqual(row.journal_entry_id, b.journalEntryId, 'posted afresh');
    const lines = await f.trx.selectFrom('bill_lines').select('qty').where('bill_id', '=', b.id).execute();
    assert.deepEqual(lines.map((l) => Number(l.qty)), [5]);

    const reversal = await f.trx.selectFrom('journal_entries').select(['id', 'entry_date']).where('reversal_of_entry_id', '=', b.journalEntryId!).executeTakeFirst();
    assert.ok(reversal, 'the old entry has a reversal');
    const on: unknown = reversal.entry_date;
    assert.equal(String(on instanceof Date ? on.toISOString() : on).slice(0, 10), '2026-10-05', 'on the bill\'s own date');
    assert.equal(await balance(f, CODE.AP), -590_00);
    assert.equal(await balance(f, CODE.ITC_CGST), 45_00);
    assert.ok((await verifyLedgerBalances(f.trx, f.orgId)).balanced);
    assert.ok(edited.before, 'the old version is handed to the audit trail');

    // GSTR-3B's input credit reads the bill as edited.
    const r = await gstr3b(f.trx, f.orgId, '2026-10');
    assert.equal(r.itc.cgstPaise, 45_00);
    assert.equal(r.itc.sgstPaise, 45_00);
  });
});

test('a draft bill stays a draft through an edit, and posts when saved as open', async () => {
  await withFixture(async (f) => {
    const b = await createBill(f.trx, f.orgId, null, bill(f, 1, { status: 'draft' }));
    await updateBill(f.trx, f.orgId, null, b.id, bill(f, 3, { status: 'draft' }));
    const row = await f.trx.selectFrom('bills').select(['status', 'journal_entry_id']).where('id', '=', b.id).executeTakeFirstOrThrow();
    assert.equal(row.status, 'draft');
    assert.equal(row.journal_entry_id, null);
    assert.equal(await balance(f, CODE.AP), 0);
    await updateBill(f.trx, f.orgId, null, b.id, bill(f, 3, { status: 'open' }));
    assert.equal(await balance(f, CODE.AP), -354_00);
  });
});

test('payments stay with an edited bill, and its total cannot drop below them', async () => {
  await withFixture(async (f) => {
    const b = await createBill(f.trx, f.orgId, null, bill(f, 2));
    await pay(f, b.id, 100_00);
    await updateBill(f.trx, f.orgId, null, b.id, bill(f, 3));
    const row = await f.trx.selectFrom('bills').select(['status', 'amount_paid', 'total']).where('id', '=', b.id).executeTakeFirstOrThrow();
    assert.equal(row.status, 'partially_paid');
    assert.equal(toPaiseFromSql(row.amount_paid), 100_00);
    assert.equal(await balance(f, CODE.AP), -(354_00 - 100_00));
    await pay(f, b.id, 254_00);
    assert.equal((await f.trx.selectFrom('bills').select('status').where('id', '=', b.id).executeTakeFirstOrThrow()).status, 'paid');
    // A full bill can still be edited at the same total (a narration, a date), not below it.
    await updateBill(f.trx, f.orgId, null, b.id, { ...bill(f, 3), notes: 'Checked' });
    assert.equal((await f.trx.selectFrom('bills').select('status').where('id', '=', b.id).executeTakeFirstOrThrow()).status, 'paid');
    await sql`SAVEPOINT below_paid`.execute(f.trx);
    await assert.rejects(updateBill(f.trx, f.orgId, null, b.id, bill(f, 1)), /already been paid/);
    await sql`ROLLBACK TO SAVEPOINT below_paid`.execute(f.trx);
    assert.equal(toPaiseFromSql((await f.trx.selectFrom('bills').select('total').where('id', '=', b.id).executeTakeFirstOrThrow()).total), 354_00, 'left as it was');
  });
});

test('deleting a bill reverses it and keeps the record; a paid one is refused', async () => {
  await withFixture(async (f) => {
    const b = await createBill(f.trx, f.orgId, null, bill(f, 2));
    const gone = await deleteBill(f.trx, f.orgId, null, b.id, 'Entered twice');
    assert.equal(gone.number, b.internalNo);
    assert.equal(await f.trx.selectFrom('bills').select('id').where('id', '=', b.id).executeTakeFirst(), undefined, 'the row is gone');
    assert.equal((await f.trx.selectFrom('bill_lines').select('id').where('bill_id', '=', b.id).execute()).length, 0);
    const kept = await f.trx.selectFrom('deleted_documents').selectAll().where('org_id', '=', f.orgId).where('doc_type', '=', 'bill').executeTakeFirstOrThrow();
    assert.equal(kept.number, b.internalNo);
    assert.equal(kept.reason, 'Entered twice');
    assert.equal(toPaiseFromSql(kept.total!), 236_00);
    assert.ok(kept.reversal_entry_id, 'with the reversal it was undone by');
    assert.ok(await f.trx.selectFrom('journal_entries').select('id').where('id', '=', b.journalEntryId!).executeTakeFirst(), 'the original entry is kept');
    assert.equal(await balance(f, CODE.AP), 0);
    assert.equal(await balance(f, CODE.ITC_CGST), 0);
    assert.equal((await gstr3b(f.trx, f.orgId, '2026-10')).itc.cgstPaise, 0, 'and its input credit is out of GSTR-3B');
    assert.ok((await verifyLedgerBalances(f.trx, f.orgId)).balanced);

    const paid = await createBill(f.trx, f.orgId, null, bill(f, 1, { vendorInvoiceNo: 'M-102' }));
    await pay(f, paid.id, 50_00);
    await assert.rejects(deleteBill(f.trx, f.orgId, null, paid.id), /payments or credits/);
  });
});

test('a void bill can be deleted but not edited', async () => {
  await withFixture(async (f) => {
    const { voidBill } = await import('../../lib/server/services/purchases');
    const b = await createBill(f.trx, f.orgId, null, bill(f, 2));
    await voidBill(f.trx, f.orgId, null, b.id, 'Wrong vendor');
    await assert.rejects(updateBill(f.trx, f.orgId, null, b.id, bill(f, 2)), /void/);
    const entries = (await f.trx.selectFrom('journal_entries').select('id').where('org_id', '=', f.orgId).execute()).length;
    await deleteBill(f.trx, f.orgId, null, b.id);
    assert.equal((await f.trx.selectFrom('journal_entries').select('id').where('org_id', '=', f.orgId).execute()).length, entries, 'nothing more to reverse');
    assert.equal(await balance(f, CODE.AP), 0);
  });
});

test('a closed period, a filed GSTR-3B and deposited TDS each refuse the change', async () => {
  await withFixture(async (f) => {
    const b = await createBill(f.trx, f.orgId, null, bill(f, 2));
    await f.trx.insertInto('transaction_locks').values({ org_id: f.orgId, module: 'purchases', locked_upto: '2026-10-31', reason: 'Books closed' }).execute();
    await assert.rejects(updateBill(f.trx, f.orgId, null, b.id, bill(f, 4)), /lock|closed|filed/i);
    await assert.rejects(deleteBill(f.trx, f.orgId, null, b.id), /lock|closed|filed/i);
    await f.trx.deleteFrom('transaction_locks').where('org_id', '=', f.orgId).execute();

    await f.trx.insertInto('gst_return_submissions').values({
      org_id: f.orgId, branch_id: f.branchId, gstin: '33AAACR4849R1ZK', return_type: 'GSTR3B', ret_period: '102026',
      action: 'file', provider: 'test', status: 'filed',
    }).execute();
    await assert.rejects(updateBill(f.trx, f.orgId, null, b.id, bill(f, 4)), /GSTR-3B .* filed/);
    await assert.rejects(deleteBill(f.trx, f.orgId, null, b.id), /GSTR-3B .* filed/);
    await f.trx.deleteFrom('gst_return_submissions').where('org_id', '=', f.orgId).execute();

    // Contract work over the single-bill limit: TDS under 194C, deposited for October.
    const t = await createBill(f.trx, f.orgId, null, bill(f, 500, { vendorInvoiceNo: 'M-200', tdsSectionOverride: '194C' }));
    const tds = toPaiseFromSql((await f.trx.selectFrom('bills').select('tds_amount').where('id', '=', t.id).executeTakeFirstOrThrow()).tds_amount);
    assert.ok(tds > 0, 'TDS was withheld');
    await f.trx.insertInto('tds_challans').values({
      org_id: f.orgId, kind: 'tds', for_month: '2026-10', challan_serial: '00042', challan_date: '2026-11-07', bsr_code: '0510308', tax: '1000.0000', total: '1000.0000',
    }).execute();
    await assert.rejects(deleteBill(f.trx, f.orgId, null, t.id), /challan 00042/);
    // Refused after the rewrite has begun: the request's transaction is rolled back, as here.
    await sql`SAVEPOINT tds_edit`.execute(f.trx);
    await assert.rejects(updateBill(f.trx, f.orgId, null, t.id, bill(f, 400, { vendorInvoiceNo: 'M-200', tdsSectionOverride: '194C' })), /challan 00042/);
    await sql`ROLLBACK TO SAVEPOINT tds_edit`.execute(f.trx);
    // The same TDS, a different narration: allowed.
    await updateBill(f.trx, f.orgId, null, t.id, { ...bill(f, 500, { vendorInvoiceNo: 'M-200', tdsSectionOverride: '194C' }), notes: 'Site 4' });
  });
});

test('a vendor credit against a bill refuses its change until the credit goes', async () => {
  await withFixture(async (f) => {
    const b = await createBill(f.trx, f.orgId, null, bill(f, 2));
    const vc = await createVendorCredit(f.trx, f.orgId, null, {
      branchId: f.branchId, vendorId: f.vendorId, date: '2026-10-08', reason: 'Damaged', againstBillId: b.id, amountPaise: 50_00, gstRatePct: 18, applyImmediately: true,
    });
    await assert.rejects(updateBill(f.trx, f.orgId, null, b.id, bill(f, 3)), new RegExp(`vendor credit ${vc.number}`));
    await assert.rejects(deleteBill(f.trx, f.orgId, null, b.id), new RegExp(`vendor credit ${vc.number}`));
    await deleteVendorCredit(f.trx, f.orgId, null, vc.id);
    await deleteBill(f.trx, f.orgId, null, b.id);
    assert.equal(await balance(f, CODE.AP), 0);

    // A void credit does not hold its bill.
    const { voidVendorCredit } = await import('../../lib/server/services/purchase-documents');
    const b2 = await createBill(f.trx, f.orgId, null, bill(f, 2, { vendorInvoiceNo: 'M-301' }));
    const vc2 = await createVendorCredit(f.trx, f.orgId, null, {
      branchId: f.branchId, vendorId: f.vendorId, date: '2026-10-08', reason: 'Damaged', againstBillId: b2.id, amountPaise: 50_00, gstRatePct: 18,
    });
    await voidVendorCredit(f.trx, f.orgId, null, vc2.id, 'Raised in error');
    await deleteBill(f.trx, f.orgId, null, b2.id);
    const left = await f.trx.selectFrom('vendor_credits').select(['status', 'against_bill_id']).where('id', '=', vc2.id).executeTakeFirstOrThrow();
    assert.equal(left.status, 'void');
    assert.equal(left.against_bill_id, null);
    assert.equal(await balance(f, CODE.AP), 0);
    assert.ok((await verifyLedgerBalances(f.trx, f.orgId)).balanced);
  });
});

test('a bill from a receipt note keeps its lines; deleting it puts the goods back on the note, waiting for a bill', async () => {
  await withFixture(async (f) => {
    const po = await createPurchaseOrder(f.trx, f.orgId, null, {
      branchId: f.branchId, vendorId: f.vendorId, date: '2026-10-01', lines: [{ itemId: f.itemId, qty: 10, ratePaise: 100_00 }],
    });
    const [poLine] = await lineIds(f, 'purchase_order_lines', 'purchase_order_id', po.id);
    const grn = await receiveFromPurchaseOrder(f.trx, f.orgId, null, po.id, { date: '2026-10-02', lines: [{ lineId: poLine, qty: 6 }] });
    const [grnLine] = await lineIds(f, 'goods_receipt_lines', 'receipt_id', grn.id);
    assert.equal(await balance(f, CODE.GOODS_RECEIVED_NOT_BILLED), -600_00);
    const b = await billFromGoodsReceipt(f.trx, f.orgId, null, grn.id, { vendorInvoiceNo: 'M-1', date: '2026-10-04', dueDate: '2026-11-04' });
    assert.equal(await balance(f, CODE.GOODS_RECEIVED_NOT_BILLED), 0);

    // The note cannot change while billed.
    await assert.rejects(deleteGoodsReceipt(f.trx, f.orgId, null, grn.id), /billed against/);

    // Edit: the quantity billed from the note is fixed; the price is not.
    const asLine = (qty: number, ratePaise: number) => ({
      ...bill(f, qty), vendorInvoiceNo: 'M-1', date: '2026-10-04',
      lines: [{ itemId: f.itemId, qty, ratePaise, gstRatePct: 18 }], lineSources: [{ type: 'goods_receipt' as const, id: grnLine }],
    });
    await assert.rejects(updateBill(f.trx, f.orgId, null, b.id, asLine(4, 100_00)), /keep it at its quantity/);
    await assert.rejects(updateBill(f.trx, f.orgId, null, b.id, { ...asLine(6, 100_00), lineSources: [null] }), /keep it at its quantity/);
    const edited = await updateBill(f.trx, f.orgId, null, b.id, asLine(6, 98_00));
    assert.equal(edited.totalPaise, Math.round(6 * 98_00 * 1.18));
    const line = await f.trx.selectFrom('bill_lines').select(['source_line_type', 'source_line_id']).where('bill_id', '=', b.id).executeTakeFirstOrThrow();
    assert.equal(line.source_line_type, 'goods_receipt');
    assert.equal(Number(line.source_line_id), grnLine);
    assert.equal(await onHand(f), 6, 'the goods counted once, on the note');

    await deleteBill(f.trx, f.orgId, null, b.id, 'Wrong invoice');
    const g = await f.trx.selectFrom('goods_receipts').select('status').where('id', '=', grn.id).executeTakeFirstOrThrow();
    assert.equal(g.status, 'open', 'the note waits for a bill again');
    const gl = await f.trx.selectFrom('goods_receipt_lines').select('qty_billed').where('id', '=', grnLine).executeTakeFirstOrThrow();
    assert.equal(Number(gl.qty_billed), 0);
    const pol = await f.trx.selectFrom('purchase_order_lines').select(['qty_billed', 'qty_received']).where('id', '=', poLine).executeTakeFirstOrThrow();
    assert.equal(Number(pol.qty_billed), 0);
    assert.equal(Number(pol.qty_received), 6);
    assert.equal(toPaiseFromSql((await f.trx.selectFrom('purchase_orders').select('billed_amount').where('id', '=', po.id).executeTakeFirstOrThrow()).billed_amount), 0);
    assert.equal(await balance(f, CODE.GOODS_RECEIVED_NOT_BILLED), -600_00, 'the accrual is back on');
    assert.equal(await balance(f, CODE.AP), 0);
    assert.ok((await verifyLedgerBalances(f.trx, f.orgId)).balanced);

    // And it can be billed again.
    await billFromGoodsReceipt(f.trx, f.orgId, null, grn.id, { vendorInvoiceNo: 'M-1', date: '2026-10-04', dueDate: '2026-11-04' });
    assert.equal(await balance(f, CODE.GOODS_RECEIVED_NOT_BILLED), 0);
  });
});

test('deleting a bill raised from an order gives the order its quantities back', async () => {
  await withFixture(async (f) => {
    const po = await createPurchaseOrder(f.trx, f.orgId, null, {
      branchId: f.branchId, vendorId: f.vendorId, date: '2026-10-01', lines: [{ itemId: f.itemId, qty: 10, ratePaise: 100_00 }],
    });
    const [poLine] = await lineIds(f, 'purchase_order_lines', 'purchase_order_id', po.id);
    const b = await billFromPurchaseOrder(f.trx, f.orgId, null, po.id, { vendorInvoiceNo: 'P-1', date: '2026-10-03', dueDate: '2026-11-03', lines: [{ lineId: poLine, qty: 4 }] });
    assert.equal(Number((await f.trx.selectFrom('purchase_order_lines').select('qty_billed').where('id', '=', poLine).executeTakeFirstOrThrow()).qty_billed), 4);
    // Edited at the same quantity and a new price: the order's billed amount follows.
    await updateBill(f.trx, f.orgId, null, b.id, {
      ...bill(f, 4), vendorInvoiceNo: 'P-1', date: '2026-10-03', lines: [{ itemId: f.itemId, qty: 4, ratePaise: 90_00, gstRatePct: 18 }],
      lineSources: [{ type: 'purchase_order', id: poLine }],
    });
    const after = Math.round(4 * 90_00 * 1.18);
    assert.equal(toPaiseFromSql((await f.trx.selectFrom('purchase_orders').select('billed_amount').where('id', '=', po.id).executeTakeFirstOrThrow()).billed_amount), after);
    await deleteBill(f.trx, f.orgId, null, b.id);
    const pol = await f.trx.selectFrom('purchase_order_lines').select('qty_billed').where('id', '=', poLine).executeTakeFirstOrThrow();
    assert.equal(Number(pol.qty_billed), 0);
    const o = await f.trx.selectFrom('purchase_orders').select(['status', 'billed_amount']).where('id', '=', po.id).executeTakeFirstOrThrow();
    assert.equal(o.status, 'open');
    assert.equal(toPaiseFromSql(o.billed_amount), 0);
  });
});

test('a deleted reverse-charge bill counts its self-invoice as cancelled in GSTR-1 table 13', async () => {
  await withFixture(async (f) => {
    const rcm = (no: string) => ({ ...bill(f, 1), vendorId: f.unregId, vendorInvoiceNo: no, isRcm: true, duplicateReason: 'Two separate self-invoiced purchases' });
    await createBill(f.trx, f.orgId, null, rcm('C-1'));
    const second = await createBill(f.trx, f.orgId, null, rcm('C-2'));
    const self = (await f.trx.selectFrom('bills').select('self_invoice_no').where('id', '=', second.id).executeTakeFirstOrThrow()).self_invoice_no;
    assert.ok(self, 'a self-invoice was raised');
    // Edited: the self-invoice number stays.
    await updateBill(f.trx, f.orgId, null, second.id, { ...rcm('C-2'), notes: 'Freight' });
    assert.equal((await f.trx.selectFrom('bills').select('self_invoice_no').where('id', '=', second.id).executeTakeFirstOrThrow()).self_invoice_no, self);
    await deleteBill(f.trx, f.orgId, null, second.id);
    const file = await gstr1PortalFile(f.trx, f.orgId, '2026-10');
    const docIssue = (file as { doc_issue?: { doc_det: { doc_num: number; docs: { totnum: number; cancel: number; net_issue: number }[] }[] } }).doc_issue;
    const series = docIssue?.doc_det.find((d) => d.doc_num === 2)?.docs[0];
    assert.equal(series?.totnum, 2);
    assert.equal(series?.cancel, 1);
    assert.equal(series?.net_issue, 1);
  });
});

// ── Vendor credits ──────────────────────────────────────────────────────────

test('a vendor credit opens for edit as entered, and an edit re-applies it to its bill', async () => {
  await withFixture(async (f) => {
    const b = await createBill(f.trx, f.orgId, null, bill(f, 5));
    const vc = await createVendorCredit(f.trx, f.orgId, null, {
      branchId: f.branchId, vendorId: f.vendorId, date: '2026-10-08', reason: 'Two damaged', againstBillId: b.id,
      amountPaise: 200_00, gstRatePct: 18, itcClaimed: true, applyImmediately: true,
    });
    const paidOf = async () => toPaiseFromSql((await f.trx.selectFrom('bills').select('amount_paid').where('id', '=', b.id).executeTakeFirstOrThrow()).amount_paid);
    assert.equal(await paidOf(), 236_00);
    const seen = await vendorCreditForEdit(f.trx, f.orgId, vc.id);
    assert.equal(seen.amountPaise, 200_00);
    assert.equal(seen.gstRatePct, 18);
    assert.equal(seen.itcClaimed, true);
    assert.equal(seen.againstBillId, String(b.id));

    const edited = await updateVendorCredit(f.trx, f.orgId, null, vc.id, {
      branchId: f.branchId, vendorId: f.vendorId, date: '2026-10-08', reason: 'One damaged', againstBillId: b.id,
      amountPaise: 100_00, gstRatePct: 18, itcClaimed: true,
    });
    assert.equal(edited.id, vc.id);
    assert.equal(edited.number, vc.number, 'same number');
    assert.equal(edited.totalPaise, 118_00);
    assert.equal(await paidOf(), 118_00, 'set against the bill again, at the new amount');
    const row = await f.trx.selectFrom('vendor_credits').select(['reason', 'status', 'applied_amount']).where('id', '=', vc.id).executeTakeFirstOrThrow();
    assert.equal(row.reason, 'One damaged');
    assert.equal(toPaiseFromSql(row.applied_amount), 118_00);
    assert.equal(await balance(f, CODE.AP), -(590_00 - 118_00));
    assert.equal(await balance(f, CODE.ITC_CGST), 45_00 - 9_00);
    assert.ok((await verifyLedgerBalances(f.trx, f.orgId)).balanced);

    // Without input credit claimed, the edit window says so.
    const plain = await createVendorCredit(f.trx, f.orgId, null, {
      branchId: f.branchId, vendorId: f.vendorId, date: '2026-10-09', reason: 'Rate', amountPaise: 50_00, gstRatePct: 12, itcClaimed: false,
    });
    const p = await vendorCreditForEdit(f.trx, f.orgId, plain.id);
    assert.equal(p.itcClaimed, false);
    assert.equal(p.gstRatePct, 12);
    assert.equal(p.amountPaise, 50_00);
  });
});

test('deleting a vendor credit takes it off its bill; a refunded one is refused', async () => {
  await withFixture(async (f) => {
    const b = await createBill(f.trx, f.orgId, null, bill(f, 2));
    const vc = await createVendorCredit(f.trx, f.orgId, null, {
      branchId: f.branchId, vendorId: f.vendorId, date: '2026-10-08', reason: 'Damaged', againstBillId: b.id, amountPaise: 100_00, gstRatePct: 18, applyImmediately: true,
    });
    assert.equal((await f.trx.selectFrom('bills').select('status').where('id', '=', b.id).executeTakeFirstOrThrow()).status, 'partially_paid');
    await deleteVendorCredit(f.trx, f.orgId, null, vc.id, 'Raised in error');
    const row = await f.trx.selectFrom('bills').select(['status', 'amount_paid']).where('id', '=', b.id).executeTakeFirstOrThrow();
    assert.equal(row.status, 'open');
    assert.equal(toPaiseFromSql(row.amount_paid), 0);
    assert.equal(await f.trx.selectFrom('vendor_credits').select('id').where('id', '=', vc.id).executeTakeFirst(), undefined);
    const kept = await f.trx.selectFrom('deleted_documents').select(['number', 'reason']).where('doc_type', '=', 'vendor_credit').where('org_id', '=', f.orgId).executeTakeFirstOrThrow();
    assert.equal(kept.number, vc.number);
    assert.equal(await balance(f, CODE.AP), -236_00);
    assert.equal(await balance(f, CODE.ITC_CGST), 18_00);

    const loose = await createVendorCredit(f.trx, f.orgId, null, {
      branchId: f.branchId, vendorId: f.vendorId, date: '2026-10-09', reason: 'Rebate', amountPaise: 100_00, gstRatePct: 0,
    });
    await refundVendorCredit(f.trx, f.orgId, null, loose.id, { bankAccountId: f.bankId, date: '2026-10-10' });
    await assert.rejects(deleteVendorCredit(f.trx, f.orgId, null, loose.id), /refunded/);
    await assert.rejects(updateVendorCredit(f.trx, f.orgId, null, loose.id, {
      branchId: f.branchId, vendorId: f.vendorId, date: '2026-10-09', reason: 'Rebate', amountPaise: 90_00,
    }), /refunded/);
  });
});

// ── Goods receipts ──────────────────────────────────────────────────────────

test('editing a receipt note reposts its stock and accrual, within what the order has to come', async () => {
  await withFixture(async (f) => {
    const po = await createPurchaseOrder(f.trx, f.orgId, null, {
      branchId: f.branchId, vendorId: f.vendorId, date: '2026-10-01', lines: [{ itemId: f.itemId, qty: 10, ratePaise: 100_00 }],
    });
    const [poLine] = await lineIds(f, 'purchase_order_lines', 'purchase_order_id', po.id);
    const grn = await receiveFromPurchaseOrder(f.trx, f.orgId, null, po.id, { date: '2026-10-02', lines: [{ lineId: poLine, qty: 6 }] });
    const seen = await goodsReceiptForEdit(f.trx, f.orgId, grn.id);
    assert.equal(seen.lines.length, 1);
    assert.equal(seen.lines[0].poLineId, String(poLine));
    assert.equal(seen.lines[0].qty, 6);

    const input = (qty: number) => ({
      branchId: f.branchId, vendorId: f.vendorId, date: '2026-10-02', vendorChallanNo: 'DC-7',
      lines: [{ poLineId: poLine, itemId: f.itemId, qty, ratePaise: 100_00, gstRatePct: 18 }],
    });
    const edited = await updateGoodsReceipt(f.trx, f.orgId, null, grn.id, input(8));
    assert.equal(edited.id, grn.id);
    assert.equal(edited.number, grn.number, 'same number');
    assert.equal(await onHand(f), 8);
    assert.equal(await balance(f, CODE.GOODS_RECEIVED_NOT_BILLED), -800_00);
    assert.equal(Number((await f.trx.selectFrom('purchase_order_lines').select('qty_received').where('id', '=', poLine).executeTakeFirstOrThrow()).qty_received), 8);
    assert.equal((await f.trx.selectFrom('goods_receipts').select('vendor_challan_no').where('id', '=', grn.id).executeTakeFirstOrThrow()).vendor_challan_no, 'DC-7');
    await assert.rejects(updateGoodsReceipt(f.trx, f.orgId, null, grn.id, input(11)), /only 10 still to come/);
    assert.ok((await verifyLedgerBalances(f.trx, f.orgId)).balanced);
  });
});

test('deleting a receipt note takes the goods and the accrual out and gives the order its quantity back', async () => {
  await withFixture(async (f) => {
    const po = await createPurchaseOrder(f.trx, f.orgId, null, {
      branchId: f.branchId, vendorId: f.vendorId, date: '2026-10-01', lines: [{ itemId: f.itemId, qty: 10, ratePaise: 100_00 }],
    });
    const [poLine] = await lineIds(f, 'purchase_order_lines', 'purchase_order_id', po.id);
    const grn = await receiveFromPurchaseOrder(f.trx, f.orgId, null, po.id, { date: '2026-10-02', lines: [{ lineId: poLine, qty: 6 }] });
    await deleteGoodsReceipt(f.trx, f.orgId, null, grn.id, 'Wrong supplier');
    assert.equal(await f.trx.selectFrom('goods_receipts').select('id').where('id', '=', grn.id).executeTakeFirst(), undefined);
    assert.equal(await onHand(f), 0);
    assert.equal(await balance(f, CODE.GOODS_RECEIVED_NOT_BILLED), 0);
    assert.equal(Number((await f.trx.selectFrom('purchase_order_lines').select('qty_received').where('id', '=', poLine).executeTakeFirstOrThrow()).qty_received), 0);
    const kept = await f.trx.selectFrom('deleted_documents').select(['number', 'reversal_entry_id']).where('doc_type', '=', 'goods_receipt').where('org_id', '=', f.orgId).executeTakeFirstOrThrow();
    assert.equal(kept.number, grn.number);
    assert.ok(kept.reversal_entry_id);

    // A note without an order, a closed period.
    const loose = await receiveGoods(f.trx, f.orgId, null, {
      branchId: f.branchId, vendorId: f.vendorId, date: '2026-10-03', lines: [{ itemId: f.itemId, qty: 2, ratePaise: 100_00 }],
    });
    await f.trx.insertInto('transaction_locks').values({ org_id: f.orgId, module: 'purchases', locked_upto: '2026-10-31', reason: 'Books closed' }).execute();
    await assert.rejects(deleteGoodsReceipt(f.trx, f.orgId, null, loose.id), /lock|closed/i);
    await f.trx.deleteFrom('transaction_locks').where('org_id', '=', f.orgId).execute();
    await deleteGoodsReceipt(f.trx, f.orgId, null, loose.id);
    assert.equal(await onHand(f), 0);
    assert.ok((await verifyLedgerBalances(f.trx, f.orgId)).balanced);
  });
});
