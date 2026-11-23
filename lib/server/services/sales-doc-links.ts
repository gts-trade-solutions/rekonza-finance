import 'server-only';

import { db, type Executor } from '../db';
import { asId } from '../http';

/**
 * What a challan or an order list row shows beside its number: the products on
 * it, the invoices raised from it, and for a challan the order it came from;
 * for an order its stage (proforma, work in process, ready for delivery).
 */
export async function salesDocLinks(orgId: number, kind: 'challan' | 'sales-order', ids: number[], ex: Executor = db) {
  const out = new Map<number, {
    items: { name: string; qty: number; uqc: string | null }[];
    invoices: { id: string; number: string }[];
    salesOrder?: { id: string; number: string } | null;
    stage?: string; proformaNumber?: string | null;
  }>();
  if (!ids.length) return out;
  for (const id of ids) out.set(id, { items: [], invoices: [] });

  const lines = kind === 'challan'
    ? await ex.selectFrom('challan_lines as l').leftJoin('items as i', 'i.id', 'l.item_id')
      .select(['l.challan_id as doc', 'l.description', 'i.name', 'l.qty', 'l.uqc'])
      .where('l.org_id', '=', orgId).where('l.challan_id', 'in', ids).orderBy('l.line_no').execute()
    : await ex.selectFrom('sales_order_lines as l').leftJoin('items as i', 'i.id', 'l.item_id')
      .select(['l.sales_order_id as doc', 'l.description', 'i.name', 'l.qty', 'l.uqc'])
      .where('l.org_id', '=', orgId).where('l.sales_order_id', 'in', ids).orderBy('l.line_no').execute();
  for (const l of lines) out.get(l.doc)?.items.push({ name: l.name ?? l.description ?? 'Item', qty: Number(l.qty), uqc: l.uqc });

  // Invoices raised from it; an order's include those raised from its challans.
  const direct = await ex.selectFrom('invoices').select(['id', 'number', 'source_doc_id'])
    .where('org_id', '=', orgId).where('source_doc_type', '=', kind === 'challan' ? 'challan' : 'sales_order')
    .where('source_doc_id', 'in', ids).where('status', '<>', 'void').orderBy('id').execute();
  for (const inv of direct) out.get(inv.source_doc_id!)?.invoices.push({ id: asId(inv.id), number: inv.number });

  if (kind === 'challan') {
    const dcs = await ex.selectFrom('delivery_challans as d').leftJoin('sales_orders as so', 'so.id', 'd.source_so_id')
      .leftJoin('invoices as inv', (j) => j.onRef('inv.id', '=', 'd.invoice_id').on('inv.status', '<>', 'void'))
      .select(['d.id', 'so.id as so_id', 'so.number as so_number', 'inv.id as inv_id', 'inv.number as inv_number'])
      .where('d.org_id', '=', orgId).where('d.id', 'in', ids).execute();
    for (const d of dcs) {
      const o = out.get(d.id);
      if (!o) continue;
      o.salesOrder = d.so_id ? { id: asId(d.so_id), number: d.so_number! } : null;
      // Sent with the invoice an order raised when it was made ready for delivery.
      if (d.inv_id && !o.invoices.some((i) => i.id === asId(d.inv_id!))) o.invoices.push({ id: asId(d.inv_id), number: d.inv_number! });
    }
  } else {
    const viaChallan = await ex.selectFrom('invoices as inv').innerJoin('delivery_challans as d', 'd.id', 'inv.source_doc_id')
      .select(['inv.id', 'inv.number', 'd.source_so_id'])
      .where('inv.org_id', '=', orgId).where('inv.source_doc_type', '=', 'challan').where('d.source_so_id', 'in', ids)
      .where('inv.status', '<>', 'void').orderBy('inv.id').execute();
    for (const inv of viaChallan) out.get(inv.source_so_id!)?.invoices.push({ id: asId(inv.id), number: inv.number });
    const sos = await ex.selectFrom('sales_orders').select(['id', 'stage', 'proforma_number']).where('org_id', '=', orgId).where('id', 'in', ids).execute();
    for (const so of sos) { const o = out.get(so.id); if (o) { o.stage = so.stage; o.proformaNumber = so.proforma_number; } }
  }
  return out;
}
