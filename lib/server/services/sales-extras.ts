import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Zoho Books' sales actions that sit on a record's ⋯ (recorded 2026-11-23):
//
//   Credit note  → Convert to Open: a draft is posted, as if saved open then.
//   Sales order  → Cancel Items: quantity that will never be invoiced or
//                  delivered; the order is done when nothing is left.
//   Sales order  → Convert to Purchase Order: the goods bought in for it, from
//                  the vendor chosen, at what we pay, linked back to the order.
//   Quote        → Create Project: a project for the customer, named for the
//                  quote, and the quote put on it.
//   Quote        → "Create a retainer invoice for this quote automatically":
//                  a retainer (advance) invoice for the agreed per cent.
//
// Each runs in the caller's transaction, and none posts except the credit note
// (through createCreditNote) and the retainer (through createRetainer).
// ─────────────────────────────────────────────────────────────────────────────

import type { Trx } from '../db';
import type { Paise } from '../../types';
import { badRequest, conflict, notFound } from '../http';
import { toPaiseFromSql } from '../money-sql';
import { createCreditNote, type CreatedDocument } from './sales-documents';
import { createPurchaseOrder } from './purchase-documents';
import { saveProject, type BillingMethod } from './projects';
import { createRetainerZoho } from './retainers';

const day = (v: unknown) => String(v instanceof Date ? v.toISOString() : v).slice(0, 10);

/** A draft credit note, posted: its entry, its stock back, applied to its invoice. Same number. */
export async function openCreditNote(trx: Trx, orgId: number, userId: number | null, id: number): Promise<CreatedDocument> {
  const cn = await trx.selectFrom('credit_notes').selectAll().where('id', '=', id).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!cn) throw notFound('That credit note does not exist.');
  if (cn.status !== 'draft') throw conflict(`${cn.number} is not a draft.`);
  const lines = await trx.selectFrom('credit_note_lines').selectAll().where('credit_note_id', '=', id).orderBy('line_no').execute();
  return createCreditNote(trx, orgId, userId, {
    branchId: cn.branch_id, customerId: cn.customer_id, date: day(cn.note_date), reason: cn.reason,
    againstInvoiceId: cn.against_invoice_id, warehouseId: cn.warehouse_id, placeOfSupply: cn.place_of_supply,
    notes: cn.notes, terms: cn.terms, referenceNumber: cn.reference_number, salespersonId: cn.salesperson_id,
    shippingChargePaise: toPaiseFromSql(cn.shipping_charge), adjustmentPaise: toPaiseFromSql(cn.adjustment), adjustmentLabel: cn.adjustment_label,
    lines: lines.map((l) => ({
      itemId: l.item_id, description: l.description, hsnSac: l.hsn_sac, qty: Number(l.qty), uqc: l.uqc,
      ratePaise: toPaiseFromSql(l.rate), discountPct: Number(l.discount_pct ?? 0), gstRatePct: Number(l.gst_rate_pct ?? 0),
      cessRatePct: Number(l.cess_rate_pct ?? 0), accountId: l.account_id, batchId: l.batch_id,
    })),
    status: 'open',
  }, { replace: { id, number: cn.number } });
}

/** What is still to invoice on an order line: neither invoiced nor cancelled. */
const leftOf = (l: { qty: unknown; qty_invoiced: unknown; qty_cancelled: unknown }) =>
  Math.max(0, Number(l.qty) - Number(l.qty_invoiced) - Number(l.qty_cancelled));

/**
 * Zoho's "Cancel Items" on a sales order: the quantity picked (all that is left,
 * when none is) will never be invoiced or delivered. The order is invoiced when
 * what it invoiced and what was cancelled cover it, and void if it invoiced
 * nothing at all.
 */
export async function cancelSalesOrderItems(
  trx: Trx, orgId: number, soId: number, picks?: { lineId: number; qty: number }[],
): Promise<{ cancelled: number; status: string }> {
  const so = await trx.selectFrom('sales_orders').select(['id', 'number', 'status']).where('id', '=', soId).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!so) throw notFound('That sales order does not exist.');
  if (so.status === 'cancelled' || so.status === 'closed' || so.status === 'invoiced') throw conflict(`Sales order ${so.number} is ${so.status}: nothing is left to cancel.`);
  const lines = await trx.selectFrom('sales_order_lines').select(['id', 'line_no', 'qty', 'qty_invoiced', 'qty_cancelled', 'qty_delivered'])
    .where('sales_order_id', '=', soId).orderBy('line_no').execute();
  const wanted = picks?.length ? picks : lines.map((l) => ({ lineId: l.id, qty: leftOf(l) }));
  let cancelled = 0;
  for (const p of wanted) {
    const l = lines.find((x) => x.id === p.lineId);
    if (!l) throw badRequest('That line is not on this sales order.');
    if (!(p.qty > 0)) continue;
    // Goods already delivered on a challan cannot be cancelled: they are with the customer, to invoice.
    const cancellable = Math.max(0, Math.min(leftOf(l), Number(l.qty) - Number(l.qty_delivered) - Number(l.qty_cancelled)));
    if (p.qty > cancellable + 1e-9) throw badRequest(`Line ${l.line_no}: only ${cancellable} is left to cancel (the rest is invoiced or delivered).`);
    await trx.updateTable('sales_order_lines').set({ qty_cancelled: String(Number(l.qty_cancelled) + p.qty) }).where('id', '=', l.id).execute();
    cancelled += p.qty;
  }
  if (!cancelled) throw badRequest('Choose at least one quantity to cancel.');
  const after = await trx.selectFrom('sales_order_lines').select(['qty', 'qty_invoiced', 'qty_cancelled']).where('sales_order_id', '=', soId).execute();
  const nothingLeft = after.every((l) => leftOf(l) <= 1e-9);
  const invoicedAny = after.some((l) => Number(l.qty_invoiced) > 0);
  const status = nothingLeft ? (invoicedAny ? 'invoiced' : 'cancelled') : invoicedAny ? 'partially_invoiced' : so.status;
  await trx.updateTable('sales_orders').set({ status: status as 'open' }).where('id', '=', soId).execute();
  return { cancelled, status };
}

/**
 * Zoho's "Convert to Purchase Order": a purchase order to the vendor chosen for
 * the goods still to supply on the order, priced at what we pay for each item
 * (a line with no item has no purchase price, so it is left off), and kept
 * linked to the order it is for.
 */
export async function purchaseOrderFromSalesOrder(
  trx: Trx, orgId: number, userId: number | null, soId: number,
  input: { vendorId: number; date: string; expectedDate?: string | null; lineIds?: number[] },
): Promise<{ id: number; number: string; totalPaise: Paise; skipped: number }> {
  const so = await trx.selectFrom('sales_orders').select(['id', 'number', 'branch_id', 'status']).where('id', '=', soId).where('org_id', '=', orgId).executeTakeFirst();
  if (!so) throw notFound('That sales order does not exist.');
  if (so.status === 'cancelled') throw conflict(`Sales order ${so.number} was cancelled.`);
  const vendor = await trx.selectFrom('contacts').select(['id', 'kind']).where('id', '=', input.vendorId).where('org_id', '=', orgId).executeTakeFirst();
  if (!vendor || (vendor.kind !== 'vendor' && vendor.kind !== 'both')) throw badRequest('Choose a vendor for the purchase order.');
  const lines = await trx.selectFrom('sales_order_lines')
    .select(['id', 'item_id', 'description', 'hsn_sac', 'qty', 'qty_cancelled', 'uqc', 'gst_rate_pct'])
    .where('sales_order_id', '=', soId).orderBy('line_no').execute();
  const chosen = lines.filter((l) => !input.lineIds?.length || input.lineIds.includes(l.id));
  const usable = chosen.filter((l) => l.item_id && Number(l.qty) - Number(l.qty_cancelled) > 0);
  if (!usable.length) throw badRequest('None of these lines names an item, so there is nothing to buy in. Add items to the order first.');
  const made = await createPurchaseOrder(trx, orgId, userId, {
    branchId: so.branch_id, vendorId: input.vendorId, date: input.date, expectedDate: input.expectedDate ?? null,
    notes: `For sales order ${so.number}`,
    lines: usable.map((l) => ({
      itemId: l.item_id, description: l.description, hsnSac: l.hsn_sac, qty: Number(l.qty) - Number(l.qty_cancelled), uqc: l.uqc,
      gstRatePct: Number(l.gst_rate_pct),
    })),
  });
  await trx.updateTable('purchase_orders').set({ source_sales_order_id: soId }).where('id', '=', made.id).execute();
  return { id: made.id, number: made.number, totalPaise: made.totalPaise, skipped: chosen.length - usable.length };
}

/**
 * Zoho's "Create Project" on a quote: a project for the quote's customer, named
 * for the quote unless a name is given, billed at a fixed fee of the quote's
 * value unless an hourly rate is given; the quote is then put on the project.
 */
export async function projectFromEstimate(
  trx: Trx, orgId: number, userId: number | null, estimateId: number,
  input: { name?: string | null; billingMethod?: BillingMethod; ratePaise?: Paise } = {},
): Promise<{ id: number; name: string }> {
  const est = await trx.selectFrom('estimates as e').innerJoin('contacts as c', 'c.id', 'e.customer_id')
    .select(['e.id', 'e.number', 'e.customer_id', 'e.subtotal', 'e.project_id', 'c.display_name'])
    .where('e.id', '=', estimateId).where('e.org_id', '=', orgId).executeTakeFirst();
  if (!est) throw notFound('That quote does not exist.');
  if (est.project_id) throw conflict(`${est.number} is already on a project.`);
  const method: BillingMethod = input.billingMethod ?? 'fixed';
  const name = input.name?.trim() || `${est.display_name} – ${est.number}`;
  const id = await saveProject(trx, orgId, userId, {
    customerId: est.customer_id, name, description: `From quote ${est.number}`, billingMethod: method,
    fixedAmountPaise: method === 'fixed' ? toPaiseFromSql(est.subtotal) : undefined,
    ratePaise: method === 'fixed' ? undefined : input.ratePaise,
    status: 'active',
  });
  await trx.updateTable('estimates').set({ project_id: id }).where('id', '=', estimateId).execute();
  return { id, name };
}

/**
 * "Create a retainer invoice for this quote automatically": a retainer invoice
 * for the quote's per cent of its total, dated with the quote, on its project,
 * quoting its number — saved as a draft, to check and send.
 */
export async function retainerFromEstimate(trx: Trx, orgId: number, userId: number | null, estimateId: number): Promise<{ id: number; number: string; amountPaise: Paise } | null> {
  const est = await trx.selectFrom('estimates')
    .select(['id', 'number', 'branch_id', 'customer_id', 'estimate_date', 'total', 'retainer_pct', 'project_id'])
    .where('id', '=', estimateId).where('org_id', '=', orgId).executeTakeFirst();
  if (!est) throw notFound('That quote does not exist.');
  const pct = est.retainer_pct == null ? 0 : Number(est.retainer_pct);
  if (!(pct > 0)) return null;
  const existing = await trx.selectFrom('retainer_invoices').select('id').where('org_id', '=', orgId).where('source_estimate_id', '=', estimateId).executeTakeFirst();
  if (existing) return null;
  const amountPaise = Math.round((toPaiseFromSql(est.total) * pct) / 100) as Paise;
  if (!(amountPaise > 0)) return null;
  const made = await createRetainerZoho(trx, orgId, userId, {
    branchId: est.branch_id, customerId: est.customer_id, date: day(est.estimate_date), reference: est.number,
    projectId: est.project_id,
    lines: [{ description: `Retainer of ${pct}% for quote ${est.number}`, amountPaise }],
    status: 'draft',
  });
  await trx.updateTable('retainer_invoices').set({ source_estimate_id: estimateId }).where('id', '=', made.id).execute();
  return { id: made.id, number: made.number, amountPaise };
}
