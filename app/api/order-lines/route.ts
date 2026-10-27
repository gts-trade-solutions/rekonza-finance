import { z } from 'zod';
import { db } from '@/lib/server/db';
import { route, query, asId, forbidden } from '@/lib/server/http';
import { hasPermission } from '@/lib/rbac';
import { toPaiseFromSql } from '@/lib/server/money-sql';
import { onOpenChallans } from '@/lib/server/services/order-flow';

// The lines of an order, challan or receipt note, with what is left to go on
// from each: what the next step's dialog offers.

const Q = z.object({
  doc: z.enum(['sales_order', 'challan', 'purchase_order', 'goods_receipt']),
  id: z.coerce.number().int().positive(),
});

export interface OrderLine {
  id: string;
  lineNo: number;
  description: string | null;
  uqc: string | null;
  qty: number;
  ratePaise: number;
  /** Left to invoice (sales) or bill (purchases). */
  toInvoice: number;
  /** Left to deliver (sales order) or receive (purchase order). */
  toMove: number | null;
}

export const GET = route(async ({ orgId, role, req }) => {
  const q = query(req, Q);
  const area = q.doc === 'sales_order' || q.doc === 'challan' ? 'sales' : 'purchases';
  if (!hasPermission(role, area, 'view')) throw forbidden('You cannot see these lines.');

  let lines: OrderLine[] = [];
  if (q.doc === 'sales_order') {
    const rows = await db.selectFrom('sales_order_lines as l').innerJoin('sales_orders as d', 'd.id', 'l.sales_order_id')
      .leftJoin('items as i', 'i.id', 'l.item_id')
      .select(['l.id', 'l.line_no', 'l.description', 'i.name as item_name', 'l.uqc', 'l.qty', 'l.qty_delivered', 'l.qty_invoiced', 'l.rate'])
      .where('d.id', '=', q.id).where('d.org_id', '=', orgId).orderBy('l.line_no').execute();
    // Goods on a challan are invoiced from the challan, not offered here again.
    const challaned = await onOpenChallans(db, rows.map((r) => r.id));
    lines = rows.map((r) => ({
      id: asId(r.id), lineNo: r.line_no, description: r.description || r.item_name, uqc: r.uqc,
      qty: Number(r.qty), ratePaise: toPaiseFromSql(r.rate),
      toInvoice: Number(r.qty) - Number(r.qty_invoiced) - (challaned.get(r.id) ?? 0),
      toMove: Number(r.qty) - Number(r.qty_delivered),
    }));
  } else if (q.doc === 'challan') {
    const rows = await db.selectFrom('challan_lines as l').innerJoin('delivery_challans as d', 'd.id', 'l.challan_id')
      .leftJoin('items as i', 'i.id', 'l.item_id')
      .select(['l.id', 'l.line_no', 'l.description', 'i.name as item_name', 'l.uqc', 'l.qty', 'l.qty_invoiced', 'l.rate'])
      .where('d.id', '=', q.id).where('d.org_id', '=', orgId).orderBy('l.line_no').execute();
    lines = rows.map((r) => ({
      id: asId(r.id), lineNo: r.line_no, description: r.description || r.item_name, uqc: r.uqc,
      qty: Number(r.qty), ratePaise: toPaiseFromSql(r.rate), toInvoice: Number(r.qty) - Number(r.qty_invoiced), toMove: null,
    }));
  } else if (q.doc === 'purchase_order') {
    const rows = await db.selectFrom('purchase_order_lines as l').innerJoin('purchase_orders as d', 'd.id', 'l.purchase_order_id')
      .leftJoin('items as i', 'i.id', 'l.item_id')
      .select(['l.id', 'l.line_no', 'l.description', 'i.name as item_name', 'l.uqc', 'l.qty', 'l.qty_received', 'l.qty_billed', 'l.rate', 'l.discount_pct'])
      .where('d.id', '=', q.id).where('d.org_id', '=', orgId).orderBy('l.line_no').execute();
    // Goods on a receipt note are billed from the note, not from the order.
    const onNotes = await db.selectFrom('goods_receipt_lines as gl').innerJoin('goods_receipts as g', 'g.id', 'gl.receipt_id')
      .select(['gl.po_line_id', 'gl.qty', 'gl.qty_billed'])
      .where('g.source_po_id', '=', q.id).where('g.org_id', '=', orgId).where('g.status', '<>', 'cancelled').execute();
    const waiting = new Map<number, number>();
    for (const r of onNotes) {
      if (r.po_line_id) waiting.set(r.po_line_id, (waiting.get(r.po_line_id) ?? 0) + Number(r.qty) - Number(r.qty_billed));
    }
    lines = rows.map((r) => ({
      id: asId(r.id), lineNo: r.line_no, description: r.description || r.item_name, uqc: r.uqc,
      qty: Number(r.qty), ratePaise: Math.round(toPaiseFromSql(r.rate) * (1 - Number(r.discount_pct) / 100)),
      toInvoice: Number(r.qty) - Number(r.qty_billed) - (waiting.get(r.id) ?? 0),
      toMove: Number(r.qty) - Number(r.qty_received),
    }));
  } else {
    const rows = await db.selectFrom('goods_receipt_lines as l').innerJoin('goods_receipts as d', 'd.id', 'l.receipt_id')
      .leftJoin('items as i', 'i.id', 'l.item_id')
      .select(['l.id', 'l.line_no', 'l.description', 'i.name as item_name', 'l.uqc', 'l.qty', 'l.qty_billed', 'l.rate'])
      .where('d.id', '=', q.id).where('d.org_id', '=', orgId).orderBy('l.line_no').execute();
    lines = rows.map((r) => ({
      id: asId(r.id), lineNo: r.line_no, description: r.description || r.item_name, uqc: r.uqc,
      qty: Number(r.qty), ratePaise: toPaiseFromSql(r.rate), toInvoice: Number(r.qty) - Number(r.qty_billed), toMove: null,
    }));
  }
  const round = (n: number) => Math.round(n * 1e6) / 1e6;
  return { lines: lines.map((l) => ({ ...l, toInvoice: round(l.toInvoice), toMove: l.toMove === null ? null : round(l.toMove) })) };
});
