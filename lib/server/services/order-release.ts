import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// A void gives back what the invoice took from its order and its challans.
//
// An invoice raised from a sales order or a delivery challan counts its
// quantities as invoiced there, so the same goods are never invoiced twice. A
// voided invoice is not a sale: those quantities are open again, for the
// invoice that replaces it. A challan Ready for delivery closed against the
// invoice (services/order-stages.ts) opens again, and an order that had gone
// through Ready goes back to Work in process, so Ready raises the new invoice.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Trx } from '../db';
import { toPaiseFromSql, toSqlFromPaise } from '../money-sql';

/** Quantities are DECIMAL(19,6); arithmetic stays at that precision. */
const q6 = (n: number) => Math.round(n * 1e6) / 1e6;
const less = (column: string, qty: number) => sql<string>`GREATEST(${sql.ref(column)} - ${String(q6(qty))}, 0)`;

/** Done, part done or not started, from each line's quantity and how much of it is done. */
export const statusFor = (lines: { qty: string | number; done: number }[], full: string, part: string, none: string) => {
  const all = lines.every((l) => q6(l.done) >= q6(Number(l.qty)));
  const any = lines.some((l) => l.done > 0);
  return all ? full : any ? part : none;
};

/** Called when an invoice is voided, after it is marked void. */
export async function releaseInvoiceQuantities(trx: Trx, orgId: number, invoiceId: number): Promise<void> {
  const inv = await trx.selectFrom('invoices').select(['source_doc_type', 'source_doc_id', 'total'])
    .where('id', '=', invoiceId).where('org_id', '=', orgId).executeTakeFirst();
  if (!inv) return;
  const lines = await trx.selectFrom('invoice_lines').select(['source_line_type', 'source_line_id', 'qty'])
    .where('invoice_id', '=', invoiceId).where('source_line_id', 'is not', null).execute();
  const orders = new Set<number>();
  const challans = new Set<number>();

  for (const l of lines) {
    const qty = Number(l.qty);
    if (l.source_line_type === 'sales_order') {
      const sol = await trx.selectFrom('sales_order_lines as sol').innerJoin('sales_orders as so', 'so.id', 'sol.sales_order_id')
        .select(['sol.id', 'sol.sales_order_id']).where('sol.id', '=', Number(l.source_line_id)).where('so.org_id', '=', orgId).executeTakeFirst();
      if (!sol) continue;
      await trx.updateTable('sales_order_lines').set({ qty_invoiced: less('qty_invoiced', qty) }).where('id', '=', sol.id).execute();
      orders.add(sol.sales_order_id);
    } else if (l.source_line_type === 'challan') {
      const cl = await trx.selectFrom('challan_lines as cl').innerJoin('delivery_challans as dc', 'dc.id', 'cl.challan_id')
        .leftJoin('sales_order_lines as sol', 'sol.id', 'cl.so_line_id')
        .select(['cl.id', 'cl.challan_id', 'cl.so_line_id', 'sol.sales_order_id'])
        .where('cl.id', '=', Number(l.source_line_id)).where('dc.org_id', '=', orgId).executeTakeFirst();
      if (!cl) continue;
      await trx.updateTable('challan_lines').set({ qty_invoiced: less('qty_invoiced', qty) }).where('id', '=', cl.id).execute();
      challans.add(cl.challan_id);
      if (cl.so_line_id) {
        await trx.updateTable('sales_order_lines').set({ qty_invoiced: less('qty_invoiced', qty) }).where('id', '=', cl.so_line_id).execute();
        if (cl.sales_order_id) orders.add(cl.sales_order_id);
      }
    }
  }

  // Challans Ready for delivery closed against this invoice open again for
  // what this invoice covered of each order line, and no more: what other
  // invoices took, from the challan or from the order before it was sent, stays.
  const covered = new Map<number, number>();
  for (const l of lines) {
    if (l.source_line_type === 'sales_order') covered.set(Number(l.source_line_id), (covered.get(Number(l.source_line_id)) ?? 0) + Number(l.qty));
  }
  const closed = await trx.selectFrom('delivery_challans').select('id')
    .where('org_id', '=', orgId).where('invoice_id', '=', invoiceId).orderBy('id').execute();
  for (const dc of closed) {
    const { rows: dcLines } = await sql<{ id: number; so_line_id: number | null; qty_invoiced: string; billed: string }>`
      SELECT cl.id, cl.so_line_id, cl.qty_invoiced,
             (SELECT COALESCE(SUM(il.qty), 0) FROM invoice_lines il JOIN invoices i ON i.id = il.invoice_id
               WHERE i.org_id = ${orgId} AND i.status <> 'void' AND i.id <> ${invoiceId}
                 AND il.source_line_type = 'challan' AND il.source_line_id = cl.id) AS billed
        FROM challan_lines cl WHERE cl.challan_id = ${dc.id} ORDER BY cl.line_no`.execute(trx);
    for (const cl of dcLines) {
      const soLine = cl.so_line_id == null ? null : Number(cl.so_line_id);
      const give = q6(Math.min(Number(cl.qty_invoiced) - Number(cl.billed), soLine == null ? 0 : covered.get(soLine) ?? 0));
      if (give <= 0 || soLine == null) continue;
      await trx.updateTable('challan_lines').set({ qty_invoiced: less('qty_invoiced', give) }).where('id', '=', cl.id).execute();
      covered.set(soLine, (covered.get(soLine) ?? 0) - give);
    }
    await trx.updateTable('delivery_challans').set({ invoice_id: null }).where('id', '=', dc.id).execute();
    challans.add(dc.id);
  }

  for (const id of challans) {
    const dc = await trx.selectFrom('delivery_challans').select('status').where('id', '=', id).executeTakeFirst();
    if (!dc || !['open', 'partially_invoiced', 'invoiced'].includes(dc.status)) continue;
    const after = await trx.selectFrom('challan_lines').select(['qty', 'qty_invoiced']).where('challan_id', '=', id).execute();
    await trx.updateTable('delivery_challans').set({
      status: statusFor(after.map((l) => ({ qty: l.qty, done: Number(l.qty_invoiced) })), 'invoiced', 'partially_invoiced', 'open') as 'open',
    }).where('id', '=', id).execute();
  }

  // The invoice's value came off an order only when it was raised from that
  // order, or from challans of that one order alone (order-flow.ts).
  for (const soId of orders) {
    const so = await trx.selectFrom('sales_orders').select(['status', 'stage', 'invoiced_amount']).where('id', '=', soId).executeTakeFirst();
    if (!so || so.status === 'cancelled' || so.status === 'closed') continue;
    const counted = inv.source_doc_type === 'sales_order' ? Number(inv.source_doc_id) === soId : inv.source_doc_type === 'challan' && orders.size === 1;
    const soLines = await trx.selectFrom('sales_order_lines').select(['qty', 'qty_invoiced']).where('sales_order_id', '=', soId).execute();
    await trx.updateTable('sales_orders').set({
      invoiced_amount: toSqlFromPaise(Math.max(0, toPaiseFromSql(so.invoiced_amount) - (counted ? toPaiseFromSql(inv.total) : 0))),
      status: statusFor(soLines.map((l) => ({ qty: l.qty, done: Number(l.qty_invoiced) })), 'invoiced', 'partially_invoiced', 'open') as 'open',
      ...(so.stage === 'ready' ? { stage: 'in_process' as const, stage_changed_at: new Date() } : {}),
    }).where('id', '=', soId).execute();
  }
}
