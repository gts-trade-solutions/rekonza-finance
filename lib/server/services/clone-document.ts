import 'server-only';

// Clone a quote, a sales order or a purchase order, as Zoho Books does: a new
// one dated today with the same party, lines and prices, numbered in its own
// series. Only the documents that post nothing and move no stock are cloned;
// invoices and bills have their own clone (they go through approvals and
// posting), and a challan, credit note or payment is never copied blindly.

import type { Trx } from '../db';
import { badRequest, notFound } from '../http';
import { toPaiseFromSql } from '../money-sql';
import { createEstimate, createSalesOrder } from './sales-documents';
import { createPurchaseOrder } from './purchase-documents';
import type { DocumentLineInput } from './lines';
import { CLONABLE, type PrintKind } from '../../print-doc';

const today = () => new Date().toISOString().slice(0, 10);
const plusDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const daysBetween = (a: unknown, b: unknown) => Math.round((Date.parse(`${String(b).slice(0, 10)}T00:00:00Z`) - Date.parse(`${String(a).slice(0, 10)}T00:00:00Z`)) / 86_400_000);

interface LineRow {
  item_id: number | null; description: string | null; hsn_sac: string | null; qty: string | number; uqc: string | null;
  rate: string; discount_pct: string | number; gst_rate_pct: string | number;
}
const asInput = (l: LineRow): DocumentLineInput => ({
  itemId: l.item_id, description: l.description, hsnSac: l.hsn_sac, qty: Number(l.qty), uqc: l.uqc,
  ratePaise: toPaiseFromSql(l.rate), discountPct: Number(l.discount_pct), gstRatePct: Number(l.gst_rate_pct),
});

export async function cloneDocument(trx: Trx, orgId: number, userId: number | null, kind: PrintKind, id: number, date = today()) {
  if (!CLONABLE[kind]) throw badRequest('Only quotes, sales orders and purchase orders are cloned here.');
  if (kind === 'estimate') {
    const d = await trx.selectFrom('estimates').selectAll().where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
    if (!d) throw notFound('That quote does not exist.');
    const lines = await trx.selectFrom('estimate_lines').selectAll().where('estimate_id', '=', id).orderBy('line_no').execute();
    // As long to accept as the original gave, from today.
    const valid = Math.max(daysBetween(d.estimate_date, d.expiry_date), 1);
    return createEstimate(trx, orgId, userId, {
      branchId: d.branch_id, customerId: d.customer_id, date, expiryDate: plusDays(date, valid), lines: lines.map(asInput),
      placeOfSupply: d.place_of_supply, notes: d.notes, status: 'draft',
    });
  }
  if (kind === 'sales-order') {
    const d = await trx.selectFrom('sales_orders').selectAll().where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
    if (!d) throw notFound('That sales order does not exist.');
    const lines = await trx.selectFrom('sales_order_lines').selectAll().where('sales_order_id', '=', id).orderBy('line_no').execute();
    return createSalesOrder(trx, orgId, userId, {
      branchId: d.branch_id, customerId: d.customer_id, date, lines: lines.map(asInput), placeOfSupply: d.place_of_supply,
    });
  }
  const d = await trx.selectFrom('purchase_orders').selectAll().where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
  if (!d) throw notFound('That purchase order does not exist.');
  const lines = await trx.selectFrom('purchase_order_lines').selectAll().where('purchase_order_id', '=', id).orderBy('line_no').execute();
  return createPurchaseOrder(trx, orgId, userId, {
    branchId: d.branch_id, vendorId: d.vendor_id, date, lines: lines.map(asInput), notes: d.notes, status: 'draft',
  });
}
