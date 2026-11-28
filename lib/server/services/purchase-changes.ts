import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Edit and Delete on bills, vendor credits and goods receipts, as Zoho Books
// has them and as the sales side already does (services/doc-delete.ts).
//
// An edit reverses the document's entry on its own date (a closed period
// refuses it) and writes the document again in place: the same row, the same
// number, its payments, comments and files kept. A delete reverses the entry,
// keeps the record in deleted_documents, and releases what the document held
// (order and receipt quantities, landed cost). Both are refused while
// something else rests on the document — money applied to it, an asset or a
// bill of entry made from it, its input credit already in a filed GSTR-3B, the
// TDS on it already deposited, pieces received on it sold since.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor, Trx } from '../db';
import type { Paise } from '../../types';
import { ApiError, badRequest, notFound } from '../http';
import { toPaiseFromSql, toSqlFromPaise } from '../money-sql';
import { reverseEntry } from '../ledger/posting';
import { createBill, type CreateBillInput } from './purchases';
import { createPurchaseOrder, createVendorCredit, type CreatePurchaseOrderInput, type CreateVendorCreditInput } from './purchase-documents';
import { afterStockMoved } from './stock-ledger';
import { receiveGoods, type ReceiptLineInput } from './order-flow';
import { statusFor } from './order-release';
import { removeLandedCost } from './landed-cost';
import { bankLineMatched, plain, recordDeletion, reverseForChange, unlinkDocument } from './doc-delete';
import { recordBillOfEntry, type BillOfEntryInput } from './bill-of-entry';

const locked = (message: string) => new ApiError(409, message, 'locked_document');
const ymd = (d: unknown) => String(d instanceof Date ? d.toISOString() : d).slice(0, 10);
const q6 = (n: number) => Math.round(n * 1e6) / 1e6;

// ── What makes a purchase document unchangeable ─────────────────────────────

/** Pieces received on this document that have gone out since (sold, adjusted): taking it away would lose them. */
async function serialsMovedSince(trx: Trx, orgId: number, docType: 'bill' | 'goods_receipt', docId: number): Promise<string | null> {
  const { rows } = await sql<{ serial_no: string }>`
    SELECT s.serial_no FROM serial_moves m
      JOIN serial_moves later ON later.serial_id = m.serial_id AND later.id > m.id AND NOT (later.doc_type = m.doc_type AND later.doc_id = m.doc_id)
      JOIN item_serials s ON s.id = m.serial_id
     WHERE m.org_id = ${orgId} AND m.doc_type = ${docType} AND m.doc_id = ${docId}
     LIMIT 1`.execute(trx);
  return rows[0]?.serial_no ?? null;
}

/** GSTR-3B for the month of `date`, filed for this registration: its input credit is in the return. */
async function filedGstr3b(trx: Trx, orgId: number, branchId: number, date: string): Promise<boolean> {
  const period = `${date.slice(5, 7)}${date.slice(0, 4)}`;
  const filed = await trx.selectFrom('gst_return_submissions').select('id')
    .where('org_id', '=', orgId).where('branch_id', '=', branchId).where('return_type', '=', 'GSTR3B')
    .where('ret_period', 'in', [period, date.slice(0, 7)]).where('status', 'in', ['filed', 'processed']).executeTakeFirst();
  return !!filed;
}

/** A TDS challan deposited for the month of `date`: the deduction on a bill of that month is in it. */
async function tdsChallanFor(trx: Trx, orgId: number, date: string): Promise<string | null> {
  const c = await trx.selectFrom('tds_challans').select(['challan_serial', 'challan_date'])
    .where('org_id', '=', orgId).where('kind', '=', 'tds').where('for_month', '=', date.slice(0, 7)).executeTakeFirst();
  return c ? `${c.challan_serial} of ${ymd(c.challan_date)}` : null;
}

// ── Bills ───────────────────────────────────────────────────────────────────

type BillRow = {
  id: number; internal_no: string; status: string; branch_id: number; bill_date: string; is_rcm: number;
  cgst: string; sgst: string; igst: string; cess: string; tds_amount: string; amount_paid: string;
};

async function billBlocker(trx: Trx, orgId: number, b: BillRow, what: 'edit' | 'delete'): Promise<string | null> {
  const no = b.internal_no;
  if (b.status === 'void') return what === 'edit' ? `${no} is void. Clone it to enter it again.` : null;
  const refuse = (why: string) => `${no} cannot be ${what === 'edit' ? 'edited' : 'deleted'}: ${why}`;
  const vc = await trx.selectFrom('vendor_credits').select('number').where('org_id', '=', orgId)
    .where('against_bill_id', '=', b.id).where('status', '<>', 'void').executeTakeFirst();
  if (vc) return refuse(`vendor credit ${vc.number} was raised against it. Delete or void that first.`);
  // GST TDS deducted from it (s.51, GSTR-7) settled part of it and is reported deductee by deductee:
  // the deduction is taken off first (or amended, once its month's GSTR-7 is filed).
  const gstTds = await trx.selectFrom('gst_tds_deductions').select('period').where('org_id', '=', orgId).where('bill_id', '=', b.id).executeTakeFirst();
  if (gstTds) return refuse(`GST TDS was deducted from it in ${gstTds.period} (GST & Taxes → GSTR-7). Delete that deduction first.`);
  const asset = await trx.selectFrom('fixed_assets').select('name').where('org_id', '=', orgId).where('bill_id', '=', b.id).executeTakeFirst()
    ?? await trx.selectFrom('asset_costs').select(sql<string>`'an asset'`.as('name')).where('bill_id', '=', b.id).executeTakeFirst();
  if (asset) return refuse(`${asset.name} was capitalised from it. Remove the asset first.`);
  const boe = await trx.selectFrom('bills_of_entry').select('boe_no').where('org_id', '=', orgId).where('bill_id', '=', b.id).executeTakeFirst();
  if (boe) return refuse(`bill of entry ${boe.boe_no} is tied to it.`);
  if (await trx.selectFrom('itc_reversals').select('id').where('org_id', '=', orgId).where('bill_id', '=', b.id).executeTakeFirst()) {
    return refuse('input credit on it has been reversed (ITC reversals). Undo that first.');
  }
  if (await trx.selectFrom('payment_batch_lines').select('id').where('bill_id', '=', b.id).executeTakeFirst()) {
    return refuse('it is in a payment batch. Take it out of the batch first.');
  }
  if (what === 'edit') {
    const landed = await trx.selectFrom('landed_costs').select('id').where('org_id', '=', orgId)
      .where((eb) => eb.or([eb('goods_bill_id', '=', b.id), eb('charge_bill_id', '=', b.id)])).executeTakeFirst();
    if (landed) return refuse('landed cost is spread with it. Remove the landed cost, edit the bill, then add it again.');
  }
  const p = toPaiseFromSql;
  const itc = p(b.cgst) + p(b.sgst) + p(b.igst) + p(b.cess) > 0;
  if (b.status !== 'draft' && (itc || b.is_rcm) && await filedGstr3b(trx, orgId, b.branch_id, ymd(b.bill_date))) {
    return refuse(`GSTR-3B for ${ymd(b.bill_date).slice(0, 7)} is filed with this bill in it. Correct it with a vendor credit instead.`);
  }
  if (what === 'delete') {
    if (p(b.amount_paid) > 0) return refuse('payments or credits are recorded against it. Delete or unapply them first.');
    if (await trx.selectFrom('payment_allocations').select('id').where('org_id', '=', orgId).where('target_type', '=', 'bill').where('target_id', '=', b.id).executeTakeFirst()) {
      return refuse('a payment is applied to it.');
    }
    if (await trx.selectFrom('journal_allocations').select('id').where('org_id', '=', orgId).where('target_type', '=', 'bill').where('target_id', '=', b.id).executeTakeFirst()) {
      return refuse('a journal entry is set against it.');
    }
    if (b.status !== 'draft' && p(b.tds_amount) > 0) {
      const challan = await tdsChallanFor(trx, orgId, ymd(b.bill_date));
      if (challan) return refuse(`the TDS withheld on it was deposited in challan ${challan}.`);
    }
  }
  const moved = await serialsMovedSince(trx, orgId, 'bill', b.id);
  if (moved) return refuse(`piece ${moved}, received on it, has gone out since.`);
  return null;
}

async function billSnapshot(trx: Trx, orgId: number, billId: number) {
  const head = await trx.selectFrom('bills').selectAll().where('id', '=', billId).where('org_id', '=', orgId).executeTakeFirst();
  const lines = await trx.selectFrom('bill_lines').selectAll().where('bill_id', '=', billId).orderBy('line_no').execute();
  return head ? { bill: plain(head), lines: lines.map(plain) } : null;
}

/** An order's billed amount and status after a bill raised from it changed by `deltaPaise`. */
async function refreshPurchaseOrder(trx: Trx, poId: number, deltaPaise: Paise) {
  const po = await trx.selectFrom('purchase_orders').select(['billed_amount', 'status']).where('id', '=', poId).executeTakeFirst();
  if (!po) return;
  const lines = await trx.selectFrom('purchase_order_lines').select(['qty', 'qty_billed']).where('purchase_order_id', '=', poId).execute();
  const billed = Math.max(0, toPaiseFromSql(po.billed_amount) + deltaPaise);
  const status = ['cancelled', 'closed', 'draft'].includes(po.status) ? po.status
    : statusFor(lines.map((l) => ({ qty: l.qty, done: Number(l.qty_billed) })), 'billed', 'partially_billed', 'open');
  await trx.updateTable('purchase_orders').set({ billed_amount: toSqlFromPaise(billed), status: status as 'open' }).where('id', '=', poId).execute();
}

/**
 * Give back the order and receipt quantities a bill took, and take back the
 * receipt-note accrual it cleared ("accrual taken back"), so the goods are on
 * the note, waiting for a bill, as they were before it.
 */
async function releaseBillQuantities(trx: Trx, orgId: number, userId: number | null, bill: { id: number; internal_no: string; total: string; source_po_id: number | null }) {
  const lines = await trx.selectFrom('bill_lines').select(['source_line_type', 'source_line_id', 'qty']).where('bill_id', '=', bill.id).execute();
  const pos = new Set<number>();
  const grns = new Set<number>();
  for (const l of lines) {
    if (!l.source_line_id) continue;
    const qty = Number(l.qty);
    if (l.source_line_type === 'purchase_order') {
      await trx.updateTable('purchase_order_lines').set({ qty_billed: sql<string>`GREATEST(0, qty_billed - ${String(q6(qty))})` }).where('id', '=', l.source_line_id).execute();
      const po = await trx.selectFrom('purchase_order_lines').select('purchase_order_id').where('id', '=', l.source_line_id).executeTakeFirst();
      if (po) pos.add(po.purchase_order_id);
    } else if (l.source_line_type === 'goods_receipt') {
      const gl = await trx.selectFrom('goods_receipt_lines').select(['receipt_id', 'po_line_id']).where('id', '=', l.source_line_id).executeTakeFirst();
      if (!gl) continue;
      await trx.updateTable('goods_receipt_lines').set({ qty_billed: sql<string>`GREATEST(0, qty_billed - ${String(q6(qty))})` }).where('id', '=', l.source_line_id).execute();
      if (gl.po_line_id) {
        await trx.updateTable('purchase_order_lines').set({ qty_billed: sql<string>`GREATEST(0, qty_billed - ${String(q6(qty))})` }).where('id', '=', gl.po_line_id).execute();
      }
      grns.add(gl.receipt_id);
    }
  }
  for (const grnId of grns) {
    const g = await trx.selectFrom('goods_receipts').select(['id', 'number', 'status', 'source_po_id']).where('id', '=', grnId).executeTakeFirst();
    if (!g) continue;
    const after = await trx.selectFrom('goods_receipt_lines').select(['qty', 'qty_billed']).where('receipt_id', '=', grnId).execute();
    if (g.status !== 'cancelled') {
      await trx.updateTable('goods_receipts').set({
        status: statusFor(after.map((l) => ({ qty: l.qty, done: Number(l.qty_billed) })), 'billed', 'partially_billed', 'open') as 'open',
      }).where('id', '=', grnId).execute();
    }
    // The accrual the bill cleared from "goods received, bill pending" goes back on.
    const takeBack = await trx.selectFrom('journal_entries').select(['id']).where('org_id', '=', orgId)
      .where('source_type', '=', 'goods_receipt').where('source_id', '=', grnId)
      .where('memo', 'like', `Bill ${bill.internal_no} received for %`).execute();
    for (const t of takeBack) {
      const done = await trx.selectFrom('journal_entries').select('id').where('reversal_of_entry_id', '=', t.id).executeTakeFirst();
      if (!done) await reverseEntry(trx, orgId, t.id, { memo: `Bill ${bill.internal_no} deleted: ${g.number} waits for a bill again`, userId, module: 'purchases' });
    }
    if (g.source_po_id) pos.add(g.source_po_id);
  }
  if (bill.source_po_id) pos.add(bill.source_po_id);
  for (const poId of pos) await refreshPurchaseOrder(trx, poId, -toPaiseFromSql(bill.total));
}

/**
 * Edit a bill, as Zoho Books' Edit: its entry is reversed on its own date and
 * it is written again in place — the same internal number, its payments kept.
 * Lines billed from an order or a receipt note keep that line and its quantity.
 */
export async function updateBill(trx: Trx, orgId: number, userId: number | null, billId: number, input: CreateBillInput) {
  const bill = await trx.selectFrom('bills')
    .select(['id', 'internal_no', 'self_invoice_no', 'status', 'branch_id', 'vendor_id', 'bill_date', 'is_rcm', 'cgst', 'sgst', 'igst', 'cess',
      'tds_amount', 'amount_paid', 'total', 'journal_entry_id', 'source_po_id', 'source_grn_id'])
    .where('id', '=', billId).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!bill) throw notFound('Bill not found.');
  const blocked = await billBlocker(trx, orgId, bill, 'edit');
  if (blocked) throw locked(blocked);

  const linked = await trx.selectFrom('bill_lines').select(['source_line_type', 'source_line_id', 'qty', 'description'])
    .where('bill_id', '=', billId).where('source_line_id', 'is not', null).execute();
  for (const l of linked) {
    const kept = input.lines.filter((_, i) => input.lineSources?.[i]?.type === l.source_line_type && input.lineSources?.[i]?.id === Number(l.source_line_id));
    const qty = kept.reduce((t, k) => t + k.qty, 0);
    if (Math.abs(qty - Number(l.qty)) > 1e-6) {
      throw badRequest(`"${l.description ?? 'A line'}" was billed from ${l.source_line_type === 'goods_receipt' ? 'a goods receipt' : 'a purchase order'}: ` +
        'keep it at its quantity. To bill a different quantity, delete this bill and bill the order again.');
    }
  }
  if ((linked.length || bill.source_po_id || bill.source_grn_id) && (input.vendorId !== bill.vendor_id || input.branchId !== bill.branch_id)) {
    throw badRequest(`${bill.internal_no} was raised from an order or a receipt note: it stays with that vendor and branch.`);
  }
  if (toPaiseFromSql(bill.amount_paid) > 0 && input.vendorId !== bill.vendor_id) {
    throw badRequest(`${bill.internal_no} has payments from this vendor on it: it stays with them. Remove the payments to move it.`);
  }
  const sources = new Set(linked.map((l) => `${l.source_line_type}|${l.source_line_id}`));
  for (const src of input.lineSources ?? []) {
    if (src && !sources.has(`${src.type}|${src.id}`)) throw badRequest('A line can only keep the order or receipt it was billed from.');
  }

  const before = await billSnapshot(trx, orgId, billId);
  const posted = bill.status !== 'draft';
  await reverseForChange(trx, orgId, bill.journal_entry_id, { memo: `Bill ${bill.internal_no} edited: the entry as it was, reversed`, userId, module: 'purchases' });
  // Unposted for a moment, so every check sees the books without the old version.
  await trx.updateTable('bills').set({ journal_entry_id: null, status: 'draft' }).where('id', '=', billId).execute();
  await trx.deleteFrom('serial_moves').where('org_id', '=', orgId).where('doc_type', '=', 'bill').where('doc_id', '=', billId).execute();
  await trx.deleteFrom('bill_lines').where('bill_id', '=', billId).execute();

  const made = await createBill(trx, orgId, userId, {
    ...input,
    // Once entered it stays entered: an edited open bill is saved open, never back to a draft.
    status: posted ? 'open' : input.status ?? 'draft',
    holdForApproval: false,
  }, { replace: { id: billId, internalNo: bill.internal_no, selfInvoiceNo: bill.self_invoice_no } });

  const paid = toPaiseFromSql(bill.amount_paid);
  if (paid > made.totalPaise) {
    throw new ApiError(409, `₹${(paid / 100).toLocaleString('en-IN')} has already been paid or credited on ${bill.internal_no}; the new total cannot be less. ` +
      'Remove a payment or credit first.', 'has_payments');
  }
  const after = await trx.selectFrom('bills').select(['tds_amount', 'bill_date']).where('id', '=', billId).executeTakeFirstOrThrow();
  if (posted && toPaiseFromSql(after.tds_amount) !== toPaiseFromSql(bill.tds_amount)) {
    for (const d of new Set([ymd(bill.bill_date), ymd(after.bill_date)])) {
      const challan = await tdsChallanFor(trx, orgId, d);
      if (challan) {
        const rupees = (v: string) => `₹${(toPaiseFromSql(v) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
        throw locked(`${bill.internal_no}: the edit changes the TDS on it from ${rupees(bill.tds_amount)} to ${rupees(after.tds_amount)}, ` +
          `but the TDS for ${d.slice(0, 7)} was deposited in challan ${challan}. Keep the TDS as it was.`);
      }
    }
  }
  if (posted) {
    await trx.updateTable('bills')
      .set({ status: paid <= 0 ? 'open' : paid >= made.totalPaise ? 'paid' : 'partially_paid' })
      .where('id', '=', billId).execute();
  }
  if (bill.source_po_id) await refreshPurchaseOrder(trx, bill.source_po_id, made.totalPaise - toPaiseFromSql(bill.total));
  // The record as it now stands, beside the one before: the audit trail writes the field-by-field edit log from the two.
  return { ...made, before, after: await billSnapshot(trx, orgId, billId) };
}

/**
 * Delete a bill, as Zoho Books' Delete: only while nothing is paid or applied
 * against it. Its entry is reversed (a void bill's already was), the order and
 * receipt quantities it took and the landed cost it carried are released, and
 * the record of it is kept in deleted_documents.
 */
export async function deleteBill(trx: Trx, orgId: number, userId: number | null, billId: number, reason?: string | null): Promise<{ number: string }> {
  const bill = await trx.selectFrom('bills')
    .select(['id', 'internal_no', 'vendor_invoice_no', 'status', 'branch_id', 'bill_date', 'is_rcm', 'cgst', 'sgst', 'igst', 'cess',
      'tds_amount', 'amount_paid', 'total', 'journal_entry_id', 'source_po_id', 'vendor_id'])
    .where('id', '=', billId).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!bill) throw notFound('Bill not found.');
  const blocked = await billBlocker(trx, orgId, bill, 'delete');
  if (blocked) throw locked(blocked);

  const snapshot = await billSnapshot(trx, orgId, billId);
  const reversal = bill.status === 'void' ? null
    : await reverseForChange(trx, orgId, bill.journal_entry_id, { memo: `Bill ${bill.internal_no} deleted`, userId, module: 'purchases' });
  // Landed cost it carried, or gave: off the goods (a void bill's went when it was voided).
  const landed = await trx.selectFrom('landed_costs').select('id').where('org_id', '=', orgId)
    .where((eb) => eb.or([eb('goods_bill_id', '=', billId), eb('charge_bill_id', '=', billId)])).execute();
  for (const l of landed) await removeLandedCost(trx, orgId, userId, l.id);
  await releaseBillQuantities(trx, orgId, userId, bill);
  // A void vendor credit raised against it stays void; its link goes with the bill (its entry's memo still names it).
  await trx.updateTable('vendor_credits').set({ against_bill_id: null })
    .where('org_id', '=', orgId).where('against_bill_id', '=', billId).where('status', '=', 'void').execute();
  // A GSTR-2B line matched to it is waiting for a bill again.
  await trx.updateTable('gstr2b_entries').set({ matched_bill_id: null, match_status: 'unmatched' }).where('org_id', '=', orgId).where('matched_bill_id', '=', billId).execute();
  await trx.deleteFrom('serial_moves').where('org_id', '=', orgId).where('doc_type', '=', 'bill').where('doc_id', '=', billId).execute();
  await unlinkDocument(trx, orgId, 'bill', billId);
  await recordDeletion(trx, {
    orgId, userId, docType: 'bill', docId: billId, number: bill.internal_no, date: ymd(bill.bill_date),
    totalPaise: toPaiseFromSql(bill.total), contactId: bill.vendor_id, branchId: bill.branch_id,
    journalEntryId: bill.journal_entry_id, reversalEntryId: reversal, reason, snapshot,
  });
  await trx.deleteFrom('bill_lines').where('bill_id', '=', billId).execute();
  await trx.deleteFrom('bills').where('id', '=', billId).where('org_id', '=', orgId).execute();
  return { number: bill.internal_no };
}

// ── Vendor credits ──────────────────────────────────────────────────────────

/**
 * A vendor credit as it was entered, for its Edit window: the amount before
 * tax, the GST rate and whether input credit was given back are read from its
 * own entry (the table keeps only the total).
 */
export async function vendorCreditForEdit(trx: Executor, orgId: number, creditId: number) {
  const vc = await trx.selectFrom('vendor_credits').selectAll().where('id', '=', creditId).where('org_id', '=', orgId).executeTakeFirst();
  if (!vc) throw notFound('That vendor credit does not exist.');
  let amountPaise = toPaiseFromSql(vc.total);
  let gstRatePct = 0;
  let itcClaimed = true;
  if (vc.journal_entry_id) {
    const lines = await trx.selectFrom('journal_lines as l').innerJoin('accounts as a', 'a.id', 'l.account_id')
      .select(['l.credit', 'l.line_no', 'a.code']).where('l.entry_id', '=', vc.journal_entry_id).orderBy('l.line_no').execute();
    const { CODE } = await import('../ledger/chart-of-accounts');
    const purchases = lines.filter((l) => l.code === CODE.PURCHASES && toPaiseFromSql(l.credit) > 0).map((l) => toPaiseFromSql(l.credit));
    const itcCodes: string[] = [CODE.ITC_CGST, CODE.ITC_SGST, CODE.ITC_IGST, CODE.ITC_CESS];
    const itc = lines.filter((l) => itcCodes.includes(l.code)).reduce((t, l) => t + toPaiseFromSql(l.credit), 0);
    if (purchases.length) amountPaise = purchases[0];
    itcClaimed = itc > 0 || purchases.length < 2;
    const tax = itc > 0 ? itc : purchases[1] ?? 0;
    if (amountPaise > 0 && tax > 0) {
      const raw = (tax * 100) / amountPaise;
      gstRatePct = [0, 0.1, 0.25, 1.5, 3, 5, 6, 7.5, 12, 18, 28, 40].reduce((best, r) => (Math.abs(r - raw) < Math.abs(best - raw) ? r : best), 0);
    }
  }
  const against = vc.against_bill_id
    ? await trx.selectFrom('bills').select(['internal_no', 'vendor_invoice_no']).where('id', '=', vc.against_bill_id).executeTakeFirst()
    : undefined;
  // Goods sent back line by line (migration 131): the window opens with them.
  const lines = (await trx.selectFrom('vendor_credit_lines as l').leftJoin('items as i', 'i.id', 'l.item_id')
    .select(['l.item_id', 'l.bill_line_id', 'l.description', 'l.hsn_sac', 'l.qty', 'l.rate', 'l.gst_rate_pct', 'l.taxable', 'l.stock_cost', 'i.name as item_name', 'i.uqc'])
    .where('l.vendor_credit_id', '=', creditId).orderBy('l.line_no').execute()).map((l) => ({
    itemId: l.item_id ? String(l.item_id) : null, itemName: l.item_name, billLineId: l.bill_line_id ? String(l.bill_line_id) : null,
    description: l.description, hsnSac: l.hsn_sac, qty: Number(l.qty), uqc: l.uqc, ratePaise: toPaiseFromSql(l.rate), gstRatePct: Number(l.gst_rate_pct),
    taxablePaise: toPaiseFromSql(l.taxable), stockCostPaise: l.stock_cost === null ? null : toPaiseFromSql(l.stock_cost),
  }));
  if (lines.length) {
    amountPaise = lines.reduce((t, l) => t + l.taxablePaise, 0);
    gstRatePct = lines[0].gstRatePct;
  }
  return {
    id: String(vc.id), number: vc.number, status: vc.status, branchId: String(vc.branch_id), vendorId: String(vc.vendor_id),
    date: ymd(vc.credit_date), reason: vc.reason, againstBillId: vc.against_bill_id ? String(vc.against_bill_id) : null,
    againstBillNo: against?.internal_no ?? null, againstBillRef: against?.vendor_invoice_no ?? null,
    amountPaise, gstRatePct, itcClaimed, totalPaise: toPaiseFromSql(vc.total), appliedPaise: toPaiseFromSql(vc.applied_amount),
    lines,
  };
}

async function vendorCreditBlocker(trx: Trx, orgId: number, vc: { id: number; number: string; status: string; credit_date: string; branch_id: number }, what: 'edit' | 'delete') {
  if (vc.status === 'void') return what === 'edit' ? `${vc.number} is void.` : null;
  if (vc.status === 'refunded') return `${vc.number} was refunded in cash, so it can no longer be ${what === 'edit' ? 'edited' : 'deleted'}.`;
  const allocated = await trx.selectFrom('payment_allocations').select('id').where('org_id', '=', orgId)
    .where('target_type', '=', 'vendor_credit').where('target_id', '=', vc.id).executeTakeFirst();
  if (allocated) return `${vc.number} has a payment set against it. Remove that first.`;
  if (await filedGstr3b(trx, orgId, vc.branch_id, ymd(vc.credit_date))) {
    return `GSTR-3B for ${ymd(vc.credit_date).slice(0, 7)} is filed with ${vc.number} in it.`;
  }
  return null;
}

/** Take a credit off the bill it was set against, so its payable is owed again. */
async function unapplyVendorCredit(trx: Trx, orgId: number, vc: { against_bill_id: number | null; applied_amount: string }) {
  const applied = toPaiseFromSql(vc.applied_amount);
  if (!vc.against_bill_id || applied <= 0) return;
  await trx.updateTable('bills').set({ amount_paid: sql<string>`GREATEST(0, amount_paid - ${toSqlFromPaise(applied)})` })
    .where('id', '=', vc.against_bill_id).where('org_id', '=', orgId).execute();
  const b = await trx.selectFrom('bills').select(['status', 'total', 'amount_paid']).where('id', '=', vc.against_bill_id).executeTakeFirst();
  if (b && !['void', 'draft'].includes(b.status)) {
    const paid = toPaiseFromSql(b.amount_paid);
    await trx.updateTable('bills').set({ status: paid <= 0 ? 'open' : paid >= toPaiseFromSql(b.total) ? 'paid' : 'partially_paid' })
      .where('id', '=', vc.against_bill_id).execute();
  }
}

/**
 * Edit a vendor credit, as Zoho Books' Edit: its entry is reversed, it is taken
 * off its bill, and it is written again in place and set against the bill
 * again. Refused once refunded in cash.
 */
export async function updateVendorCredit(trx: Trx, orgId: number, userId: number | null, creditId: number, input: CreateVendorCreditInput) {
  const vc = await trx.selectFrom('vendor_credits').selectAll().where('id', '=', creditId).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!vc) throw notFound('That vendor credit does not exist.');
  const blocked = await vendorCreditBlocker(trx, orgId, vc, 'edit');
  if (blocked) throw locked(blocked);
  const before = await vendorCreditSnapshot(trx, creditId);
  await reverseForChange(trx, orgId, vc.journal_entry_id, { memo: `Vendor credit ${vc.number} edited: the entry as it was, reversed`, userId, module: 'purchases' });
  await unapplyVendorCredit(trx, orgId, vc);
  // Set against its bill again, as New does whenever a bill is named.
  const made = await createVendorCredit(trx, orgId, userId, input, { replace: { id: creditId, number: vc.number } });
  if (ymd(vc.credit_date) < input.date) await afterStockMoved(trx, orgId, userId, ymd(vc.credit_date), `vendor credit ${vc.number} edited`);
  // The record as it now stands, beside the one before: the audit trail writes the field-by-field edit log from the two.
  return { ...made, before, after: await vendorCreditSnapshot(trx, creditId) };
}

/** A vendor credit as the edit log compares it: the header and its lines. */
async function vendorCreditSnapshot(trx: Trx, creditId: number) {
  const head = await trx.selectFrom('vendor_credits').selectAll().where('id', '=', creditId).executeTakeFirst();
  const lines = await trx.selectFrom('vendor_credit_lines').selectAll().where('vendor_credit_id', '=', creditId).orderBy('line_no').execute();
  return head ? { vendorCredit: plain(head), lines: lines.map(plain) } : null;
}

/** Delete a vendor credit: its entry reversed, taken off its bill, the record kept (migration 118). */
export async function deleteVendorCredit(trx: Trx, orgId: number, userId: number | null, creditId: number, reason?: string | null) {
  const vc = await trx.selectFrom('vendor_credits').selectAll().where('id', '=', creditId).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!vc) throw notFound('That vendor credit does not exist.');
  const blocked = await vendorCreditBlocker(trx, orgId, vc, 'delete');
  if (blocked) throw locked(blocked);
  const reversal = vc.status === 'void' ? null
    : await reverseForChange(trx, orgId, vc.journal_entry_id, { memo: `Vendor credit ${vc.number} deleted`, userId, module: 'purchases' });
  if (vc.status !== 'void') await unapplyVendorCredit(trx, orgId, vc);
  await unlinkDocument(trx, orgId, 'vendor_credit', creditId);
  await recordDeletion(trx, {
    orgId, userId, docType: 'vendor_credit', docId: creditId, number: vc.number, date: ymd(vc.credit_date),
    totalPaise: toPaiseFromSql(vc.total), contactId: vc.vendor_id, branchId: vc.branch_id,
    journalEntryId: vc.journal_entry_id, reversalEntryId: reversal, reason, snapshot: { vendorCredit: plain(vc) },
  });
  const hadGoods = await trx.selectFrom('vendor_credit_lines').select('id').where('vendor_credit_id', '=', creditId).where('item_id', 'is not', null).limit(1).executeTakeFirst();
  await trx.deleteFrom('vendor_credits').where('id', '=', creditId).where('org_id', '=', orgId).execute();
  // The goods it sent back are stock again from its date.
  if (hadGoods) await afterStockMoved(trx, orgId, userId, ymd(vc.credit_date), `vendor credit ${vc.number} deleted`);
  return { number: vc.number };
}

// ── Goods receipts ──────────────────────────────────────────────────────────

async function receiptBlocker(trx: Trx, orgId: number, g: { id: number; number: string; status: string }, what: 'edit' | 'delete') {
  if (g.status === 'cancelled' && what === 'edit') return `${g.number} is cancelled.`;
  if (g.status !== 'open' && g.status !== 'cancelled') return `${g.number} has been billed against. Delete the bill first.`;
  const moved = await serialsMovedSince(trx, orgId, 'goods_receipt', g.id);
  if (moved) return `${g.number} cannot be ${what === 'edit' ? 'edited' : 'deleted'}: piece ${moved}, received on it, has gone out since.`;
  return null;
}

/** Give the purchase order back the quantities this receipt note received. */
async function releaseReceivedQuantities(trx: Trx, receiptId: number) {
  const lines = await trx.selectFrom('goods_receipt_lines').select(['po_line_id', 'qty']).where('receipt_id', '=', receiptId).execute();
  for (const l of lines) {
    if (!l.po_line_id) continue;
    await trx.updateTable('purchase_order_lines').set({ qty_received: sql<string>`GREATEST(0, qty_received - ${String(q6(Number(l.qty)))})` })
      .where('id', '=', l.po_line_id).execute();
  }
}

/** The receipt note as saved, for its Edit window. */
export async function goodsReceiptForEdit(trx: Executor, orgId: number, receiptId: number) {
  const g = await trx.selectFrom('goods_receipts').selectAll().where('id', '=', receiptId).where('org_id', '=', orgId).executeTakeFirst();
  if (!g) throw notFound('That goods receipt does not exist.');
  const lines = await trx.selectFrom('goods_receipt_lines as gl').leftJoin('batches as b', 'b.id', 'gl.batch_id')
    .select(['gl.id', 'gl.po_line_id', 'gl.item_id', 'gl.description', 'gl.hsn_sac', 'gl.qty', 'gl.uqc', 'gl.rate', 'gl.gst_rate_pct', 'b.batch_no', 'b.mfg_date', 'b.expiry_date'])
    .where('gl.receipt_id', '=', receiptId).orderBy('gl.line_no').execute();
  const serials = await trx.selectFrom('serial_moves as m').innerJoin('item_serials as s', 's.id', 'm.serial_id')
    .select(['m.line_id', 's.serial_no']).where('m.org_id', '=', orgId).where('m.doc_type', '=', 'goods_receipt').where('m.doc_id', '=', receiptId).execute();
  return {
    id: String(g.id), number: g.number, status: g.status, branchId: String(g.branch_id), vendorId: String(g.vendor_id),
    warehouseId: g.warehouse_id ? String(g.warehouse_id) : null, date: ymd(g.receipt_date), vendorChallanNo: g.vendor_challan_no,
    notes: g.notes, sourcePoId: g.source_po_id ? String(g.source_po_id) : null,
    lines: lines.map((l) => ({
      poLineId: l.po_line_id ? String(l.po_line_id) : null, itemId: l.item_id ? String(l.item_id) : null, description: l.description,
      hsnSac: l.hsn_sac, qty: Number(l.qty), uqc: l.uqc, ratePaise: toPaiseFromSql(l.rate), gstRatePct: Number(l.gst_rate_pct),
      batch: l.batch_no ? { batchNo: l.batch_no, mfgDate: l.mfg_date ? ymd(l.mfg_date) : null, expiryDate: l.expiry_date ? ymd(l.expiry_date) : null } : null,
      serials: serials.filter((x) => x.line_id === l.id).map((x) => x.serial_no),
    })),
  };
}

/**
 * Edit a receipt note, as Zoho Books' Edit: while nothing on it is billed. Its
 * accrual is reversed and it is written again in place; lines received against
 * a purchase order keep that line, within what the order still has to come.
 */
export async function updateGoodsReceipt(
  trx: Trx, orgId: number, userId: number | null, receiptId: number,
  input: { branchId: number; vendorId: number; date: string; vendorChallanNo?: string | null; warehouseId?: number | null; notes?: string | null; lines: ReceiptLineInput[] },
) {
  const g = await trx.selectFrom('goods_receipts').selectAll().where('id', '=', receiptId).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!g) throw notFound('That goods receipt does not exist.');
  const blocked = await receiptBlocker(trx, orgId, g, 'edit');
  if (blocked) throw locked(blocked);
  const before = await goodsReceiptForEdit(trx, orgId, receiptId);
  const oldLines = await trx.selectFrom('goods_receipt_lines').select(['po_line_id', 'qty']).where('receipt_id', '=', receiptId).execute();
  const onThisNote = new Map<number, number>();
  for (const l of oldLines) if (l.po_line_id) onThisNote.set(l.po_line_id, (onThisNote.get(l.po_line_id) ?? 0) + Number(l.qty));
  const wanted = new Map<number, number>();
  for (const l of input.lines) {
    if (!l.poLineId) continue;
    if (!onThisNote.has(l.poLineId)) throw badRequest('A line can only keep the purchase order line it was received against.');
    wanted.set(l.poLineId, (wanted.get(l.poLineId) ?? 0) + l.qty);
  }
  // What the order still has to come, counting this note's own quantities as not yet received.
  for (const [poLineId, qty] of wanted) {
    const pol = await trx.selectFrom('purchase_order_lines').select(['qty', 'qty_received', 'line_no']).where('id', '=', poLineId).executeTakeFirstOrThrow();
    const left = q6(Number(pol.qty) - Number(pol.qty_received) + (onThisNote.get(poLineId) ?? 0));
    if (qty > left + 1e-6) throw badRequest(`Line ${pol.line_no} of the order has only ${left} still to come.`);
  }
  await reverseForChange(trx, orgId, g.journal_entry_id, { memo: `${g.number} edited: the receipt as it was, reversed`, userId, module: 'purchases' });
  await releaseReceivedQuantities(trx, receiptId);
  await trx.deleteFrom('serial_moves').where('org_id', '=', orgId).where('doc_type', '=', 'goods_receipt').where('doc_id', '=', receiptId).execute();
  await trx.deleteFrom('goods_receipt_lines').where('receipt_id', '=', receiptId).execute();
  const made = await receiveGoods(trx, orgId, userId, { ...input, sourcePoId: g.source_po_id }, { replace: { id: receiptId, number: g.number } });
  for (const l of input.lines.filter((x) => x.poLineId)) {
    await trx.updateTable('purchase_order_lines').set({ qty_received: sql<string>`qty_received + ${String(q6(l.qty))}` }).where('id', '=', l.poLineId!).execute();
  }
  // The record as it now stands, beside the one before: the audit trail writes the field-by-field edit log from the two.
  return { ...made, before, after: await goodsReceiptForEdit(trx, orgId, receiptId) };
}

/** Delete a receipt note: while nothing on it is billed. Its accrual reversed, the order's quantities given back, the record kept. */
export async function deleteGoodsReceipt(trx: Trx, orgId: number, userId: number | null, receiptId: number, reason?: string | null) {
  const g = await trx.selectFrom('goods_receipts').selectAll().where('id', '=', receiptId).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!g) throw notFound('That goods receipt does not exist.');
  const blocked = await receiptBlocker(trx, orgId, g, 'delete');
  if (blocked) throw locked(blocked);
  const snapshot = await goodsReceiptForEdit(trx, orgId, receiptId);
  // A cancelled note's accrual was reversed, and its order quantities given back, when it was cancelled.
  const reversal = g.status === 'cancelled' ? null
    : await reverseForChange(trx, orgId, g.journal_entry_id, { memo: `${g.number} deleted`, userId, module: 'purchases' });
  if (g.status !== 'cancelled') await releaseReceivedQuantities(trx, receiptId);
  await trx.deleteFrom('serial_moves').where('org_id', '=', orgId).where('doc_type', '=', 'goods_receipt').where('doc_id', '=', receiptId).execute();
  await unlinkDocument(trx, orgId, 'goods_receipt', receiptId);
  await recordDeletion(trx, {
    orgId, userId, docType: 'goods_receipt', docId: receiptId, number: g.number, date: ymd(g.receipt_date),
    totalPaise: toPaiseFromSql(g.total), contactId: g.vendor_id, branchId: g.branch_id,
    journalEntryId: g.journal_entry_id, reversalEntryId: reversal, reason, snapshot,
  });
  await trx.deleteFrom('goods_receipt_lines').where('receipt_id', '=', receiptId).execute();
  await trx.deleteFrom('goods_receipts').where('id', '=', receiptId).where('org_id', '=', orgId).execute();
  return { number: g.number };
}

// ── Purchase orders ─────────────────────────────────────────────────────────
//
// A purchase order posts nothing (purchase-documents.ts), so changing it moves
// no entry: an edit rewrites it in place under the same number, a delete
// removes it and keeps the record in deleted_documents. Both wait until
// nothing has been received or billed on it — a receipt note or a bill made
// from it holds its line ids and quantities, and taking the order away from
// under them would leave them pointing at nothing. Delete those first, as
// Zoho Books asks.

async function purchaseOrderBlocker(trx: Trx, orgId: number, po: { id: number; number: string; status: string }, what: 'edit' | 'delete') {
  if (what === 'edit' && po.status === 'cancelled') return `${po.number} is cancelled. Reopen it, or raise a new order.`;
  const refuse = (why: string) => `${po.number} cannot be ${what === 'edit' ? 'edited' : 'deleted'}: ${why}`;
  const grn = await trx.selectFrom('goods_receipts').select(['number', 'status']).where('org_id', '=', orgId)
    .where('source_po_id', '=', po.id).executeTakeFirst();
  if (grn) return refuse(`goods were received on it (${grn.number}${grn.status === 'cancelled' ? ', cancelled' : ''}). Delete that receipt note first.`);
  const bill = await trx.selectFrom('bills').select('internal_no').where('org_id', '=', orgId).where('source_po_id', '=', po.id).executeTakeFirst()
    ?? await trx.selectFrom('bill_lines as bl').innerJoin('purchase_order_lines as pol', 'pol.id', 'bl.source_line_id')
      .innerJoin('bills as b', 'b.id', 'bl.bill_id').select('b.internal_no')
      .where('bl.source_line_type', '=', 'purchase_order').where('pol.purchase_order_id', '=', po.id).executeTakeFirst();
  if (bill) return refuse(`bill ${bill.internal_no} was raised from it. Delete that bill first.`);
  const moved = await trx.selectFrom('purchase_order_lines').select('id').where('purchase_order_id', '=', po.id)
    .where((eb) => eb.or([eb('qty_received', '>', '0'), eb('qty_billed', '>', '0')])).executeTakeFirst();
  if (moved) return refuse('part of it has been received or billed. Delete those receipt notes and bills first.');
  return null;
}

/** The order as saved, for its Edit window. */
export async function purchaseOrderForEdit(trx: Executor, orgId: number, poId: number) {
  const po = await trx.selectFrom('purchase_orders').selectAll().where('id', '=', poId).where('org_id', '=', orgId).executeTakeFirst();
  if (!po) throw notFound('That purchase order does not exist.');
  const lines = await trx.selectFrom('purchase_order_lines')
    .select(['item_id', 'description', 'hsn_sac', 'qty', 'uqc', 'rate', 'discount_pct', 'gst_rate_pct', 'cess'])
    .where('purchase_order_id', '=', poId).orderBy('line_no').execute();
  return {
    id: String(po.id), number: po.number, status: po.status, branchId: String(po.branch_id), vendorId: String(po.vendor_id),
    date: ymd(po.order_date), expectedDate: po.expected_date ? ymd(po.expected_date) : null, notes: po.notes,
    totalPaise: toPaiseFromSql(po.total), vendorResponse: po.vendor_response,
    lines: lines.map((l) => ({
      itemId: l.item_id ? String(l.item_id) : null, description: l.description, hsnSac: l.hsn_sac, qty: Number(l.qty), uqc: l.uqc,
      ratePaise: toPaiseFromSql(l.rate), discountPct: Number(l.discount_pct), gstRatePct: Number(l.gst_rate_pct),
    })),
  };
}

async function purchaseOrderSnapshot(trx: Trx, orgId: number, poId: number) {
  const head = await trx.selectFrom('purchase_orders').selectAll().where('id', '=', poId).where('org_id', '=', orgId).executeTakeFirst();
  const lines = await trx.selectFrom('purchase_order_lines').selectAll().where('purchase_order_id', '=', poId).orderBy('line_no').execute();
  return head ? { purchaseOrder: plain(head), lines: lines.map(plain) } : null;
}

/**
 * Edit a purchase order, as Zoho Books' Edit: while nothing on it is received
 * or billed. Rewritten in place, the same number; a draft stays a draft, an
 * open or closed order keeps its state.
 */
export async function updatePurchaseOrder(trx: Trx, orgId: number, userId: number | null, poId: number, input: CreatePurchaseOrderInput) {
  const po = await trx.selectFrom('purchase_orders').select(['id', 'number', 'status'])
    .where('id', '=', poId).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!po) throw notFound('That purchase order does not exist.');
  const blocked = await purchaseOrderBlocker(trx, orgId, po, 'edit');
  if (blocked) throw locked(blocked);
  if (!input.lines.length) throw badRequest('An order needs at least one line.');
  const before = await purchaseOrderSnapshot(trx, orgId, poId);
  await trx.deleteFrom('purchase_order_lines').where('purchase_order_id', '=', poId).execute();
  const status = po.status === 'draft' ? (input.status ?? 'draft') : po.status === 'closed' ? 'closed' : 'open';
  const made = await createPurchaseOrder(trx, orgId, userId, input, { replace: { id: poId, number: po.number, status } });
  // The record as it now stands, beside the one before: the audit trail writes the field-by-field edit log from the two.
  return { ...made, before, after: await purchaseOrderSnapshot(trx, orgId, poId) };
}

/** Delete a purchase order: while nothing on it is received or billed. Nothing was posted, so nothing is reversed; the record is kept. */
export async function deletePurchaseOrder(trx: Trx, orgId: number, userId: number | null, poId: number, reason?: string | null) {
  const po = await trx.selectFrom('purchase_orders').selectAll().where('id', '=', poId).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!po) throw notFound('That purchase order does not exist.');
  const blocked = await purchaseOrderBlocker(trx, orgId, po, 'delete');
  if (blocked) throw locked(blocked);
  const snapshot = await purchaseOrderSnapshot(trx, orgId, poId);
  await unlinkDocument(trx, orgId, 'purchase_order', poId);
  await unlinkDocument(trx, orgId, 'purchase-order', poId);
  await recordDeletion(trx, {
    orgId, userId, docType: 'purchase_order', docId: poId, number: po.number, date: ymd(po.order_date),
    totalPaise: toPaiseFromSql(po.total), contactId: po.vendor_id, branchId: po.branch_id, reason, snapshot,
  });
  await trx.deleteFrom('purchase_order_lines').where('purchase_order_id', '=', poId).execute();
  await trx.deleteFrom('purchase_orders').where('id', '=', poId).where('org_id', '=', orgId).execute();
  return { number: po.number };
}

// ── Bills of entry ──────────────────────────────────────────────────────────
//
// A bill of entry posts the duty and the import IGST paid at customs
// (bill-of-entry.ts). An edit reverses that entry on its own date and posts it
// again from the corrected figures, on the same row; a delete reverses it and
// keeps the record. Both are refused once the IGST is in a filed GSTR-3B
// (correct it in the next return instead), or while the payment is matched to
// a bank statement line (unmatch it in Banking first).

async function billOfEntryBlocker(trx: Trx, orgId: number, e: { boe_no: string; status: string; branch_id: number; boe_date: unknown; itc_eligibility: string; journal_entry_id: number | null }, what: 'edit' | 'delete') {
  if (what === 'edit' && e.status === 'void') return `Bill of entry ${e.boe_no} is void. Record it again instead.`;
  if (e.status === 'void') return null;
  const refuse = (why: string) => `Bill of entry ${e.boe_no} cannot be ${what === 'edit' ? 'edited' : 'deleted'}: ${why}`;
  if (e.journal_entry_id && await bankLineMatched(trx, orgId, 'journal_entry', e.journal_entry_id)) {
    return refuse('the payment at customs is matched to a bank statement line. Unmatch it in Banking first.');
  }
  if (e.itc_eligibility !== 'ineligible' && await filedGstr3b(trx, orgId, e.branch_id, ymd(e.boe_date))) {
    return refuse(`GSTR-3B for ${ymd(e.boe_date).slice(0, 7)} is filed with its IGST in table 4(A)(1). Correct it in a later return.`);
  }
  return null;
}

/** Edit a bill of entry: its entry reversed on its own date and posted again from the figures as corrected. */
export async function updateBillOfEntry(trx: Trx, orgId: number, userId: number | null, id: number, input: BillOfEntryInput) {
  const e = await trx.selectFrom('bills_of_entry').selectAll().where('id', '=', id).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!e) throw notFound('That bill of entry does not exist.');
  const blocked = await billOfEntryBlocker(trx, orgId, e, 'edit');
  if (blocked) throw locked(blocked);
  const before = plain(e);
  await reverseForChange(trx, orgId, e.journal_entry_id, { memo: `Bill of entry ${e.boe_no} edited: the entry as it was, reversed`, userId, module: 'purchases' });
  const made = await recordBillOfEntry(trx, orgId, userId, input, { replace: { id } });
  // The record as it now stands, beside the one before: the audit trail writes the field-by-field edit log from the two.
  return { ...made, before, after: plain(await trx.selectFrom('bills_of_entry').selectAll().where('id', '=', id).executeTakeFirstOrThrow()) };
}

/** Delete a bill of entry: its entry reversed (a void one's already was), the record kept. */
export async function deleteBillOfEntry(trx: Trx, orgId: number, userId: number | null, id: number, reason?: string | null) {
  const e = await trx.selectFrom('bills_of_entry').selectAll().where('id', '=', id).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!e) throw notFound('That bill of entry does not exist.');
  const blocked = await billOfEntryBlocker(trx, orgId, e, 'delete');
  if (blocked) throw locked(blocked);
  const reversal = e.status === 'void' ? null
    : await reverseForChange(trx, orgId, e.journal_entry_id, { memo: `Bill of entry ${e.boe_no} deleted`, userId, module: 'purchases' });
  await unlinkDocument(trx, orgId, 'bill_of_entry', id);
  const p = toPaiseFromSql;
  await recordDeletion(trx, {
    orgId, userId, docType: 'bill_of_entry', docId: id, number: e.boe_no, date: ymd(e.boe_date),
    totalPaise: p(e.customs_duty) + p(e.igst) + p(e.cess), contactId: e.vendor_id, branchId: e.branch_id,
    journalEntryId: e.journal_entry_id, reversalEntryId: reversal, reason, snapshot: { billOfEntry: plain(e) },
  });
  await trx.deleteFrom('bills_of_entry').where('id', '=', id).where('org_id', '=', orgId).execute();
  return { number: e.boe_no };
}
