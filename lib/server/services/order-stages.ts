import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// A sales order's stages before the invoice, as the client works:
//
//   Order → Proforma invoice → Work in process → Ready for delivery
//
// A proforma invoice is the order priced for the customer to pay against or
// approve: it is not a tax invoice, posts nothing and moves no stock, and has
// its own PI series. Work in process is a note of where the job is.
//
// Ready for delivery raises the tax invoice from the order on its own — every
// line still to invoice, at the order's prices and discounts — and, for the
// goods on it, the delivery challan they travel with. That challan names the
// invoice and is already invoiced, so it can never be invoiced a second time.
// ─────────────────────────────────────────────────────────────────────────────

import type { Trx } from '../db';
import { allocateNumber } from '../ledger/posting';
import { conflict, notFound } from '../http';
import { fyLabelFor } from './sales';
import { challanFromSalesOrder, invoiceFromSalesOrder, onOpenChallans } from './order-flow';

export type OrderStage = 'order' | 'proforma' | 'in_process' | 'ready';
export const STAGE_LABEL: Record<OrderStage, string> = {
  order: 'Order received', proforma: 'Proforma sent', in_process: 'Work in process', ready: 'Ready for delivery',
};

async function orderOf(trx: Trx, orgId: number, soId: number) {
  const so = await trx.selectFrom('sales_orders')
    .select(['id', 'number', 'branch_id', 'customer_id', 'status', 'stage', 'proforma_number', 'proforma_date'])
    .where('id', '=', soId).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!so) throw notFound('That sales order does not exist.');
  if (so.status === 'cancelled') throw conflict(`Sales order ${so.number} was cancelled.`);
  if (so.status === 'closed') throw conflict(`Sales order ${so.number} is closed.`);
  return so;
}

/** The due date the customer's terms give: net 30 is thirty days on, due on receipt is the same day. */
async function dueDateFor(trx: Trx, orgId: number, customerId: number, date: string) {
  const c = await trx.selectFrom('contacts').select('payment_terms').where('id', '=', customerId).where('org_id', '=', orgId).executeTakeFirst();
  const days = Number(/^net_(\d+)$/.exec(c?.payment_terms ?? '')?.[1] ?? (c?.payment_terms === 'due_on_receipt' ? 0 : 30));
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Raise the order's proforma invoice: numbered once in the PI series, dated
 * the day it is first raised. Raising it again prints the same one.
 */
export async function raiseProforma(trx: Trx, orgId: number, soId: number, date: string) {
  const so = await orderOf(trx, orgId, soId);
  if (so.status === 'invoiced') throw conflict(`Sales order ${so.number} is already invoiced: send the tax invoice instead.`);
  if (so.proforma_number) return { number: so.proforma_number, date: String(so.proforma_date).slice(0, 10), stage: so.stage as OrderStage };
  const number = await allocateNumber(trx, orgId, so.branch_id, 'PI', fyLabelFor(date), { prefix: 'PI' });
  const stage: OrderStage = so.stage === 'order' ? 'proforma' : (so.stage as OrderStage);
  await trx.updateTable('sales_orders')
    .set({ proforma_number: number, proforma_date: date, stage, stage_changed_at: new Date() })
    .where('id', '=', soId).execute();
  return { number, date, stage };
}

export interface ReadyResult {
  invoice: { id: number; number: string; totalPaise: number; heldForApproval: boolean } | null;
  challan: { id: number; number: string } | null;
  /** Goods already on a challan of this order that is not invoiced: invoiced from that challan. */
  openChallans: number;
}

/**
 * Move an order to a stage. Ready for delivery invoices what is left of it
 * and makes the challan for the goods on that invoice.
 */
export async function setOrderStage(
  trx: Trx, orgId: number, userId: number | null, soId: number, stage: Exclude<OrderStage, 'proforma'>, date: string,
): Promise<{ stage: OrderStage; ready?: ReadyResult }> {
  const so = await orderOf(trx, orgId, soId);
  if (stage !== 'ready') {
    if (so.stage === 'ready') throw conflict(`Sales order ${so.number} is ready for delivery and invoiced; it cannot go back a stage.`);
    await trx.updateTable('sales_orders').set({ stage, stage_changed_at: new Date() }).where('id', '=', soId).execute();
    return { stage };
  }
  if (so.stage === 'ready') throw conflict(`Sales order ${so.number} is already ready for delivery.`);

  const lines = await trx.selectFrom('sales_order_lines as l').leftJoin('items as i', 'i.id', 'l.item_id')
    .select(['l.id', 'l.qty', 'l.qty_invoiced', 'l.qty_delivered', 'l.hsn_sac', 'i.kind'])
    .where('l.sales_order_id', '=', soId).orderBy('l.line_no').execute();
  const challaned = await onOpenChallans(trx, lines.map((l) => l.id));
  const left = lines.map((l) => ({ ...l, toInvoice: Number(l.qty) - Number(l.qty_invoiced) - (challaned.get(l.id) ?? 0) }));
  const openChallans = [...challaned.values()].filter((q) => q > 0).length;

  let invoice: ReadyResult['invoice'] = null;
  let challan: ReadyResult['challan'] = null;
  if (left.some((l) => l.toInvoice > 1e-9)) {
    const dueDate = await dueDateFor(trx, orgId, so.customer_id, date);
    const created = await invoiceFromSalesOrder(trx, orgId, userId, soId, { date, dueDate, status: 'approved' });
    invoice = { id: created.id, number: created.number, totalPaise: created.totalPaise, heldForApproval: !!created.heldForApproval };

    // The goods on that invoice go out on a challan naming it. Services are not
    // delivered on one: an item marked a service, or a typed line with a SAC (99…).
    const isService = (l: (typeof left)[number]) => l.kind === 'service' || (!l.kind && /^99/.test(l.hsn_sac ?? ''));
    const goods = left
      .filter((l) => l.toInvoice > 1e-9 && !isService(l))
      .map((l) => ({ lineId: l.id, qty: Math.min(l.toInvoice, Number(l.qty) - Number(l.qty_delivered)) }))
      .filter((p) => p.qty > 1e-9);
    if (goods.length) {
      const dc = await challanFromSalesOrder(trx, orgId, userId, soId, {
        date, challanType: 'other', notes: `Goods sent with invoice ${created.number}`, lines: goods,
      });
      // Invoiced already, with the order: closed against that invoice.
      await trx.updateTable('challan_lines').set((eb) => ({ qty_invoiced: eb.ref('qty') })).where('challan_id', '=', dc.id).execute();
      await trx.updateTable('delivery_challans').set({ status: 'invoiced', invoice_id: created.id }).where('id', '=', dc.id).execute();
      challan = { id: dc.id, number: dc.number };
    }
  }

  await trx.updateTable('sales_orders').set({ stage: 'ready', stage_changed_at: new Date() }).where('id', '=', soId).execute();
  return { stage: 'ready', ready: { invoice, challan, openChallans } };
}
