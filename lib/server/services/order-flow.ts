import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// The order flow, line by line.
//
//   Sales:     sales order → delivery challan → invoice (or order → invoice)
//   Purchases: purchase order → goods receipt note → bill (or order → bill)
//
// Every step can take part of the step before: some lines, or part of a line.
// Each line remembers how much has gone on from it, so the next step offers
// only what is left and nothing is invoiced or billed twice.
//
// Stock moves with the accounting, not the paperwork. Goods leave stock on the
// invoice, not the challan: until the sale is invoiced they are still ours.
// Goods arrive on the receipt note, with their cost accrued against "goods
// received, bill pending" so the profit is right before the bill comes; the
// bill takes that accrual back and puts in the real cost.
//
// A bill raised from an order or a receipt is matched against them. A bill
// for more than was received, or at a price above the order's, is held from
// payment until someone with approval rights accepts it.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor, Trx } from '../db';
import type { Paise } from '../../types';
import { toPaiseFromSql, toSqlFromPaise } from '../money-sql';
import { allocateNumber, postEntry, reverseEntry, type DraftLine } from '../ledger/posting';
import { CODE, accountIds, requireAccount } from '../ledger/chart-of-accounts';
import { badRequest, conflict, notFound } from '../http';
import { createInvoice, fyLabelFor } from './sales';
import { findOrCreateBatch, type BatchInput } from './batches';
import { recordSerials } from './serials';
import { checkGodown } from './godowns';
import { createBill } from './purchases';
import { createChallan, type CreatedDocument } from './sales-documents';

/** Quantities are DECIMAL(19,6); arithmetic stays at that precision. */
const q6 = (n: number) => Math.round(n * 1e6) / 1e6;
/**
 * Add to a quantity column in the database rather than writing a figure read
 * earlier: two lines of one document can point at the same order line.
 */
const add = (column: string, qty: number) => sql<string>`${sql.ref(column)} + ${String(q6(qty))}`;
/** A bill may be this much dearer than the order before it is an exception. */
const PRICE_TOLERANCE = 0.005;

export interface LinePick { lineId: number; qty: number }

/**
 * Which lines go on, and how much of each. With no picks, everything left.
 * A pick for more than is left is refused rather than trimmed: someone typed
 * a figure, and quietly using a different one would hide the mistake.
 */
function choose<L extends { id: number; line_no: number }>(
  lines: L[], pending: (l: L) => number, picks: LinePick[] | undefined, doc: string,
): { line: L; qty: number }[] {
  if (!picks?.length) {
    const all = lines.map((line) => ({ line, qty: q6(pending(line)) })).filter((x) => x.qty > 0);
    if (!all.length) throw conflict(`Nothing is left on ${doc}.`);
    return all;
  }
  const byId = new Map(lines.map((l) => [l.id, l]));
  const out: { line: L; qty: number }[] = [];
  for (const p of picks) {
    const line = byId.get(p.lineId);
    if (!line) throw badRequest(`Line ${p.lineId} is not on ${doc}.`);
    if (!(p.qty > 0)) continue;
    const left = q6(pending(line));
    if (q6(p.qty) > left) throw badRequest(`Line ${line.line_no} of ${doc} has ${left} left; ${p.qty} was asked for.`);
    out.push({ line, qty: q6(p.qty) });
  }
  if (!out.length) throw badRequest('Give a quantity for at least one line.');
  return out;
}

const statusFor = (lines: { qty: string | number; done: number }[], full: string, part: string, none: string) => {
  const all = lines.every((l) => q6(l.done) >= q6(Number(l.qty)));
  const any = lines.some((l) => l.done > 0);
  return all ? full : any ? part : none;
};

// ── Sales ────────────────────────────────────────────────────────────────────

async function loadOrder(trx: Trx, orgId: number, soId: number) {
  const so = await trx.selectFrom('sales_orders')
    .select(['id', 'number', 'branch_id', 'customer_id', 'place_of_supply', 'status', 'invoiced_amount'])
    .where('id', '=', soId).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!so) throw notFound('That sales order does not exist.');
  if (so.status === 'cancelled') throw conflict(`Sales order ${so.number} was cancelled.`);
  if (so.status === 'closed') throw conflict(`Sales order ${so.number} is closed.`);
  const lines = await trx.selectFrom('sales_order_lines')
    .select(['id', 'line_no', 'item_id', 'description', 'hsn_sac', 'qty', 'qty_delivered', 'qty_invoiced', 'uqc', 'rate', 'discount_pct', 'gst_rate_pct'])
    .where('sales_order_id', '=', soId).orderBy('line_no').execute();
  return { so, lines };
}

async function refreshOrderStatus(trx: Trx, soId: number, addInvoicedPaise: Paise) {
  const lines = await trx.selectFrom('sales_order_lines').select(['qty', 'qty_invoiced'])
    .where('sales_order_id', '=', soId).execute();
  const so = await trx.selectFrom('sales_orders').select(['invoiced_amount']).where('id', '=', soId).executeTakeFirstOrThrow();
  await trx.updateTable('sales_orders').set({
    invoiced_amount: toSqlFromPaise(toPaiseFromSql(so.invoiced_amount) + addInvoicedPaise),
    status: statusFor(lines.map((l) => ({ qty: l.qty, done: Number(l.qty_invoiced) })), 'invoiced', 'partially_invoiced', 'open') as 'open',
  }).where('id', '=', soId).execute();
}

/**
 * What of each order line sits on a challan not yet invoiced. Those goods are
 * invoiced from the challan, so the order does not offer them again.
 */
export async function onOpenChallans(trx: Executor, soLineIds: number[]): Promise<Map<number, number>> {
  if (!soLineIds.length) return new Map();
  const rows = await trx.selectFrom('challan_lines as cl')
    .innerJoin('delivery_challans as dc', 'dc.id', 'cl.challan_id')
    .select(['cl.so_line_id', 'cl.qty', 'cl.qty_invoiced'])
    .where('cl.so_line_id', 'in', soLineIds)
    .where('dc.status', 'in', ['open', 'partially_invoiced'])
    .execute();
  const out = new Map<number, number>();
  for (const r of rows) {
    if (r.so_line_id) out.set(r.so_line_id, (out.get(r.so_line_id) ?? 0) + Number(r.qty) - Number(r.qty_invoiced));
  }
  return out;
}

/** Invoice what is left on a sales order, or the lines and quantities picked. */
export async function invoiceFromSalesOrder(
  trx: Trx, orgId: number, userId: number | null, soId: number,
  input: { date: string; dueDate: string; status?: 'draft' | 'approved'; lines?: LinePick[] },
): Promise<CreatedDocument> {
  const { so, lines } = await loadOrder(trx, orgId, soId);
  const challaned = await onOpenChallans(trx, lines.map((l) => l.id));
  const picked = choose(
    lines, (l) => Number(l.qty) - Number(l.qty_invoiced) - (challaned.get(l.id) ?? 0), input.lines, `sales order ${so.number}`,
  );

  const created = await createInvoice(trx, orgId, userId, {
    branchId: so.branch_id, customerId: so.customer_id, date: input.date, dueDate: input.dueDate,
    placeOfSupply: so.place_of_supply, status: input.status ?? 'approved', orderNumber: so.number,
    sourceDocType: 'sales_order', sourceDocId: so.id, holdForApproval: true,
    lines: picked.map(({ line, qty }) => ({
      itemId: line.item_id, description: line.description, hsnSac: line.hsn_sac, qty, uqc: line.uqc,
      ratePaise: toPaiseFromSql(line.rate), discountPct: Number(line.discount_pct), gstRatePct: Number(line.gst_rate_pct),
    })),
    lineSources: picked.map(({ line }) => ({ type: 'sales_order', id: line.id })),
  });

  for (const { line, qty } of picked) {
    await trx.updateTable('sales_order_lines')
      .set({ qty_invoiced: add('qty_invoiced', qty) }).where('id', '=', line.id).execute();
  }
  await refreshOrderStatus(trx, soId, created.totalPaise);
  return created;
}

/** Send goods against a sales order on a delivery challan. */
export async function challanFromSalesOrder(
  trx: Trx, orgId: number, userId: number | null, soId: number,
  input: { date: string; challanType?: 'supply_on_approval' | 'liquid_gas' | 'other'; notes?: string | null; lines?: LinePick[] },
): Promise<CreatedDocument> {
  const { so, lines } = await loadOrder(trx, orgId, soId);
  const picked = choose(lines, (l) => Number(l.qty) - Number(l.qty_delivered), input.lines, `sales order ${so.number}`);

  const created = await createChallan(trx, orgId, userId, {
    branchId: so.branch_id, customerId: so.customer_id, date: input.date,
    challanType: input.challanType ?? 'other', placeOfSupply: so.place_of_supply,
    notes: input.notes ?? `Against sales order ${so.number}`,
    lines: picked.map(({ line, qty }) => ({
      itemId: line.item_id, description: line.description, hsnSac: line.hsn_sac, qty, uqc: line.uqc,
      ratePaise: Math.round(toPaiseFromSql(line.rate) * (1 - Number(line.discount_pct) / 100)),
    })),
  });

  await trx.updateTable('delivery_challans').set({ source_so_id: so.id }).where('id', '=', created.id).execute();
  const challanLines = await trx.selectFrom('challan_lines').select(['id', 'line_no'])
    .where('challan_id', '=', created.id).orderBy('line_no').execute();
  for (let i = 0; i < picked.length; i++) {
    const { line, qty } = picked[i];
    await trx.updateTable('challan_lines').set({ so_line_id: line.id }).where('id', '=', challanLines[i].id).execute();
    await trx.updateTable('sales_order_lines')
      .set({ qty_delivered: add('qty_delivered', qty) }).where('id', '=', line.id).execute();
  }
  return created;
}

/** Invoice the goods on a delivery challan, or the part of them picked. */
export async function invoiceFromChallan(
  trx: Trx, orgId: number, userId: number | null, challanId: number,
  input: { date: string; dueDate: string; status?: 'draft' | 'approved'; lines?: LinePick[] },
): Promise<CreatedDocument> {
  const dc = await trx.selectFrom('delivery_challans')
    .select(['id', 'number', 'branch_id', 'customer_id', 'place_of_supply', 'status', 'challan_type', 'source_so_id'])
    .where('id', '=', challanId).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!dc) throw notFound('That delivery challan does not exist.');
  if (dc.status === 'cancelled' || dc.status === 'returned') throw conflict(`Challan ${dc.number} is ${dc.status}.`);
  if (dc.challan_type === 'job_work') {
    throw conflict(`Challan ${dc.number} sent goods for job work. They come back; they are not sold, so there is nothing to invoice.`);
  }

  const lines = await trx.selectFrom('challan_lines as cl')
    .leftJoin('sales_order_lines as sol', 'sol.id', 'cl.so_line_id')
    .select([
      'cl.id', 'cl.line_no', 'cl.item_id', 'cl.description', 'cl.hsn_sac', 'cl.qty', 'cl.qty_invoiced', 'cl.uqc', 'cl.rate',
      'cl.so_line_id', 'sol.gst_rate_pct as so_gst_rate', 'sol.qty_invoiced as so_qty_invoiced', 'sol.sales_order_id',
    ])
    .where('cl.challan_id', '=', challanId).orderBy('cl.line_no').execute();
  const picked = choose(lines, (l) => Number(l.qty) - Number(l.qty_invoiced), input.lines, `challan ${dc.number}`);

  const created = await createInvoice(trx, orgId, userId, {
    branchId: dc.branch_id, customerId: dc.customer_id, date: input.date, dueDate: input.dueDate,
    placeOfSupply: dc.place_of_supply, status: input.status ?? 'approved',
    sourceDocType: 'challan', sourceDocId: dc.id, holdForApproval: true,
    notes: `Goods sent on delivery challan ${dc.number}`,
    lines: picked.map(({ line, qty }) => ({
      itemId: line.item_id, description: line.description, hsnSac: line.hsn_sac, qty, uqc: line.uqc,
      ratePaise: toPaiseFromSql(line.rate),
      // The order's rate when the challan came from one; otherwise the item's or the code's.
      gstRatePct: line.so_gst_rate == null ? undefined : Number(line.so_gst_rate),
    })),
    lineSources: picked.map(({ line }) => ({ type: 'challan', id: line.id })),
  });

  const orders = new Set<number>();
  for (const { line, qty } of picked) {
    await trx.updateTable('challan_lines')
      .set({ qty_invoiced: add('qty_invoiced', qty) }).where('id', '=', line.id).execute();
    if (line.so_line_id) {
      await trx.updateTable('sales_order_lines')
        .set({ qty_invoiced: add('qty_invoiced', qty) }).where('id', '=', line.so_line_id).execute();
      if (line.sales_order_id) orders.add(line.sales_order_id);
    }
  }
  const after = await trx.selectFrom('challan_lines').select(['qty', 'qty_invoiced']).where('challan_id', '=', challanId).execute();
  await trx.updateTable('delivery_challans').set({
    status: statusFor(after.map((l) => ({ qty: l.qty, done: Number(l.qty_invoiced) })), 'invoiced', 'partially_invoiced', 'open') as 'open',
  }).where('id', '=', challanId).execute();
  // The invoice's value counts against an order only when the whole challan came from it.
  for (const soId of orders) await refreshOrderStatus(trx, soId, orders.size === 1 ? created.totalPaise : 0);
  return created;
}

// ── Purchases ────────────────────────────────────────────────────────────────

export interface ReceiptLineInput {
  poLineId?: number | null;
  itemId?: number | null;
  description?: string | null;
  hsnSac?: string | null;
  qty: number;
  uqc?: string | null;
  /** Per unit, after any discount: what the goods are carried at until billed. */
  ratePaise?: Paise;
  gstRatePct?: number;
  /** A batch-tracked item: the batch it arrived in, with the dates on the pack. */
  batch?: BatchInput | null;
  /** A serial-tracked item: the number of each piece, one per unit. */
  serials?: string[] | null;
}

/**
 * Receive goods on a goods receipt note.
 *
 *   Dr Purchases (or the item's purchase account)   the goods' cost at the note's rate
 *     Cr Goods received, bill pending
 *
 * The stock arrives now; the bill, when it comes, reverses this and posts the
 * supplier's actual figures with the tax.
 */
export async function receiveGoods(
  trx: Trx, orgId: number, userId: number | null,
  input: {
    branchId: number; vendorId: number; date: string; vendorChallanNo?: string | null; warehouseId?: number | null;
    sourcePoId?: number | null; notes?: string | null; lines: ReceiptLineInput[];
  },
): Promise<CreatedDocument> {
  if (!input.lines.length) throw badRequest('A receipt note needs at least one line.');
  const vendor = await trx.selectFrom('contacts').select(['id', 'display_name'])
    .where('id', '=', input.vendorId).where('org_id', '=', orgId).executeTakeFirst();
  if (!vendor) throw notFound('That vendor does not exist.');

  const itemIds = input.lines.map((l) => l.itemId).filter((x): x is number => !!x);
  const items = itemIds.length
    ? await trx.selectFrom('items')
        .select(['id', 'name', 'kind', 'hsn_sac', 'uqc', 'gst_rate_pct', 'purchase_price', 'purchase_account_id'])
        .where('org_id', '=', orgId).where('id', 'in', itemIds).execute()
    : [];
  const itemById = new Map(items.map((i) => [i.id, i]));
  const acc = await accountIds(trx, orgId);

  const priced = input.lines.map((l, idx) => {
    const item = l.itemId ? itemById.get(l.itemId) : undefined;
    if (l.itemId && !item) throw badRequest(`Line ${idx + 1} refers to an item that does not exist.`);
    if (!(l.qty > 0)) throw badRequest(`Line ${idx + 1} needs a quantity above zero.`);
    const rate = l.ratePaise ?? (item ? toPaiseFromSql(item.purchase_price) : 0);
    return {
      ...l,
      itemId: l.itemId ?? null,
      description: l.description ?? item?.name ?? null,
      hsnSac: l.hsnSac ?? item?.hsn_sac ?? null,
      uqc: l.uqc ?? item?.uqc ?? 'NOS',
      qty: q6(l.qty),
      rate,
      gstRatePct: l.gstRatePct ?? (item ? Number(item.gst_rate_pct) : 0),
      accountId: item?.purchase_account_id ?? requireAccount(acc, CODE.PURCHASES),
      lineTotal: Math.round(rate * l.qty),
    };
  });
  const total = priced.reduce((t, l) => t + l.lineTotal, 0);

  // A batch-tracked item names the batch it arrived in, as a bill would.
  const tracked = new Set((await trx.selectFrom('items').select('id').where('org_id', '=', orgId)
    .where('track_batches', '=', 1).where('id', 'in', [0, ...itemIds]).execute()).map((r) => r.id));
  const batchIds: (number | null)[] = [];
  for (const l of priced) {
    if (!l.itemId || !tracked.has(l.itemId)) { batchIds.push(null); continue; }
    if (!l.batch?.batchNo?.trim()) throw badRequest('Give the batch number for each batch-tracked item.');
    batchIds.push(await findOrCreateBatch(trx, orgId, l.itemId, l.batch));
  }

  const number = await allocateNumber(trx, orgId, input.branchId, 'GRN', fyLabelFor(input.date), { prefix: 'GRN' });
  const id = Number((await trx.insertInto('goods_receipts').values({
    org_id: orgId, branch_id: input.branchId, number, vendor_id: input.vendorId,
    source_po_id: input.sourcePoId ?? null, receipt_date: input.date,
    vendor_challan_no: input.vendorChallanNo?.trim() || null, status: 'open',
    total: toSqlFromPaise(total), notes: input.notes ?? null, created_by_user_id: userId,
    warehouse_id: await checkGodown(trx, orgId, input.branchId, input.warehouseId),
  }).executeTakeFirstOrThrow()).insertId);

  await trx.insertInto('goods_receipt_lines').values(priced.map((l, i) => ({
    org_id: orgId, receipt_id: id, po_line_id: l.poLineId ?? null, line_no: i + 1,
    item_id: l.itemId, account_id: l.accountId, description: l.description, hsn_sac: l.hsnSac,
    qty: String(l.qty), uqc: l.uqc, rate: toSqlFromPaise(l.rate),
    gst_rate_pct: String(l.gstRatePct), line_total: toSqlFromPaise(l.lineTotal), batch_id: batchIds[i] ?? null,
  }))).execute();
  const lineIds = (await trx.selectFrom('goods_receipt_lines').select('id').where('receipt_id', '=', id).orderBy('line_no').execute()).map((r) => r.id);
  await recordSerials(trx, orgId, { type: 'goods_receipt', id }, 1,
    priced.map((l, i) => ({ lineId: lineIds[i] ?? null, itemId: l.itemId, qty: l.qty, serials: l.serials })), { check: true });

  if (total > 0) {
    const byAccount = new Map<number, Paise>();
    for (const l of priced) byAccount.set(l.accountId, (byAccount.get(l.accountId) ?? 0) + l.lineTotal);
    const lines: DraftLine[] = [...byAccount].map(([accountId, amount]) => ({ accountId, debit: amount, description: `Received on ${number}` }));
    lines.push({ accountId: requireAccount(acc, CODE.GOODS_RECEIVED_NOT_BILLED), credit: total, contactId: input.vendorId, description: number });
    const entry = await postEntry(trx, {
      orgId, branchId: input.branchId, date: input.date,
      memo: `Goods received ${number} — ${vendor.display_name}, bill pending`,
      sourceType: 'goods_receipt', sourceId: id, userId, module: 'purchases', lines,
    });
    await trx.updateTable('goods_receipts').set({ journal_entry_id: entry.id }).where('id', '=', id).execute();
  }
  return { id, number, totalPaise: total, journalEntryId: null };
}

async function loadPurchaseOrder(trx: Trx, orgId: number, poId: number) {
  const po = await trx.selectFrom('purchase_orders')
    .select(['id', 'number', 'branch_id', 'vendor_id', 'status', 'billed_amount', 'total'])
    .where('id', '=', poId).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!po) throw notFound('That purchase order does not exist.');
  if (po.status === 'cancelled') throw conflict(`Purchase order ${po.number} was cancelled.`);
  if (po.status === 'closed') throw conflict(`Purchase order ${po.number} is closed.`);
  if (po.status === 'draft') throw conflict(`Purchase order ${po.number} is still a draft; issue it first.`);
  const lines = await trx.selectFrom('purchase_order_lines')
    .select(['id', 'line_no', 'item_id', 'account_id', 'description', 'hsn_sac', 'qty', 'qty_received', 'qty_billed', 'uqc', 'rate', 'discount_pct', 'gst_rate_pct'])
    .where('purchase_order_id', '=', poId).orderBy('line_no').execute();
  return { po, lines };
}

/** Receive goods ordered on a purchase order: what is left, or the lines picked. */
export async function receiveFromPurchaseOrder(
  trx: Trx, orgId: number, userId: number | null, poId: number,
  input: { date: string; vendorChallanNo?: string | null; notes?: string | null; lines?: (LinePick & { batch?: BatchInput | null })[] },
): Promise<CreatedDocument> {
  const { po, lines } = await loadPurchaseOrder(trx, orgId, poId);
  const picked = choose(lines, (l) => Number(l.qty) - Number(l.qty_received), input.lines, `purchase order ${po.number}`);
  const created = await receiveGoods(trx, orgId, userId, {
    branchId: po.branch_id, vendorId: po.vendor_id, date: input.date, vendorChallanNo: input.vendorChallanNo,
    sourcePoId: po.id, notes: input.notes ?? `Against purchase order ${po.number}`,
    lines: picked.map(({ line, qty }) => ({
      poLineId: line.id, itemId: line.item_id, description: line.description, hsnSac: line.hsn_sac, qty, uqc: line.uqc,
      ratePaise: Math.round(toPaiseFromSql(line.rate) * (1 - Number(line.discount_pct) / 100)),
      gstRatePct: Number(line.gst_rate_pct),
      batch: input.lines?.find((p) => p.lineId === line.id)?.batch ?? null,
    })),
  });
  for (const { line, qty } of picked) {
    await trx.updateTable('purchase_order_lines')
      .set({ qty_received: add('qty_received', qty) }).where('id', '=', line.id).execute();
  }
  return created;
}

/** The net unit price on an order line, which a bill is matched against. */
const netRate = (rate: string, discountPct: string | number) => toPaiseFromSql(rate) * (1 - Number(discountPct) / 100);

async function refreshPurchaseOrder(trx: Trx, poId: number, addBilledPaise: Paise) {
  const lines = await trx.selectFrom('purchase_order_lines').select(['qty', 'qty_billed'])
    .where('purchase_order_id', '=', poId).execute();
  const po = await trx.selectFrom('purchase_orders').select(['billed_amount']).where('id', '=', poId).executeTakeFirstOrThrow();
  await trx.updateTable('purchase_orders').set({
    billed_amount: toSqlFromPaise(toPaiseFromSql(po.billed_amount) + addBilledPaise),
    status: statusFor(lines.map((l) => ({ qty: l.qty, done: Number(l.qty_billed) })), 'billed', 'partially_billed', 'open') as 'open',
  }).where('id', '=', poId).execute();
}

export interface BillPick extends LinePick {
  /** The supplier's price per unit, when it differs from the order's. */
  ratePaise?: Paise;
}

/**
 * Bill the goods on a receipt note. The supplier's own invoice number is
 * required: GSTR-2B is matched on it.
 */
export async function billFromGoodsReceipt(
  trx: Trx, orgId: number, userId: number | null, grnId: number,
  input: { vendorInvoiceNo: string; date: string; dueDate: string; lines?: BillPick[] },
): Promise<{ id: number; internalNo: string; totalPaise: Paise; heldForApproval: boolean; match: { status: 'matched' | 'exception'; note: string | null } }> {
  if (!input.vendorInvoiceNo?.trim()) throw badRequest("The supplier's own invoice number is needed — GSTR-2B is matched on it.");
  const grn = await trx.selectFrom('goods_receipts')
    .select(['id', 'number', 'branch_id', 'vendor_id', 'source_po_id', 'status'])
    .where('id', '=', grnId).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!grn) throw notFound('That goods receipt does not exist.');
  if (grn.status === 'cancelled') throw conflict(`Goods receipt ${grn.number} was cancelled.`);

  const lines = await trx.selectFrom('goods_receipt_lines as gl')
    .leftJoin('purchase_order_lines as pol', 'pol.id', 'gl.po_line_id')
    .leftJoin('batches as bt', 'bt.id', 'gl.batch_id')
    .select([
      'bt.batch_no', 'bt.mfg_date', 'bt.expiry_date',
      'gl.id', 'gl.line_no', 'gl.po_line_id', 'gl.item_id', 'gl.account_id', 'gl.description', 'gl.hsn_sac', 'gl.qty',
      'gl.qty_billed', 'gl.uqc', 'gl.rate', 'gl.gst_rate_pct',
      'pol.rate as po_rate', 'pol.discount_pct as po_discount', 'pol.qty_billed as po_qty_billed',
    ])
    .where('gl.receipt_id', '=', grnId).orderBy('gl.line_no').execute();
  const picked = choose(lines, (l) => Number(l.qty) - Number(l.qty_billed), input.lines, `goods receipt ${grn.number}`);
  const rateOf = new Map((input.lines ?? []).filter((p) => p.ratePaise != null).map((p) => [p.lineId, p.ratePaise!]));

  // Matching: quantity cannot exceed what was received (choose() saw to that);
  // the price is checked against the order the goods were received against.
  const problems: string[] = [];
  const billLines = picked.map(({ line, qty }) => {
    const rate = rateOf.get(line.id) ?? toPaiseFromSql(line.rate);
    if (line.po_rate != null) {
      const ordered = netRate(line.po_rate, line.po_discount ?? 0);
      if (rate > ordered * (1 + PRICE_TOLERANCE)) {
        problems.push(`line ${line.line_no} billed at ₹${(rate / 100).toFixed(2)}, ordered at ₹${(ordered / 100).toFixed(2)}`);
      }
    }
    return {
      itemId: line.item_id, accountId: line.account_id, description: line.description, hsnSac: line.hsn_sac,
      qty, uqc: line.uqc, ratePaise: rate, gstRatePct: Number(line.gst_rate_pct),
      // The bill carries the goods on in the batch they arrived in.
      batch: line.batch_no ? {
        batchNo: line.batch_no, mfgDate: line.mfg_date ? String(line.mfg_date).slice(0, 10) : null,
        expiryDate: line.expiry_date ? String(line.expiry_date).slice(0, 10) : null,
      } : null,
    };
  });
  const match = problems.length
    ? { status: 'exception' as const, note: `Does not agree with the order: ${problems.join('; ')}.` }
    : { status: 'matched' as const, note: null };

  const bill = await createBill(trx, orgId, userId, {
    branchId: grn.branch_id, vendorId: grn.vendor_id, vendorInvoiceNo: input.vendorInvoiceNo.trim(),
    date: input.date, dueDate: input.dueDate, sourcePoId: grn.source_po_id, sourceGrnId: grn.id, status: 'open',
    lines: billLines, lineSources: picked.map(({ line }) => ({ type: 'goods_receipt', id: line.id })), match, holdForApproval: true,
  });

  // Take back the accrual for what is now billed, at the rate it was accrued at.
  const acc = await accountIds(trx, orgId);
  const back = new Map<number, Paise>();
  for (const { line, qty } of picked) {
    const account = line.account_id ?? requireAccount(acc, CODE.PURCHASES);
    back.set(account, (back.get(account) ?? 0) + Math.round(qty * toPaiseFromSql(line.rate)));
  }
  const reversal = [...back.values()].reduce((t, v) => t + v, 0);
  if (reversal > 0) {
    await postEntry(trx, {
      orgId, branchId: grn.branch_id, date: input.date,
      memo: `Bill ${bill.internalNo} received for ${grn.number}: accrual taken back`,
      sourceType: 'goods_receipt', sourceId: grn.id, userId, module: 'purchases',
      lines: [
        { accountId: requireAccount(acc, CODE.GOODS_RECEIVED_NOT_BILLED), debit: reversal, contactId: grn.vendor_id, description: grn.number },
        ...[...back].map(([accountId, amount]) => ({ accountId, credit: amount, description: `Billed on ${bill.internalNo}` })),
      ],
    });
  }

  for (const { line, qty } of picked) {
    await trx.updateTable('goods_receipt_lines')
      .set({ qty_billed: add('qty_billed', qty) }).where('id', '=', line.id).execute();
    if (line.po_line_id) {
      await trx.updateTable('purchase_order_lines')
        .set({ qty_billed: add('qty_billed', qty) }).where('id', '=', line.po_line_id).execute();
    }
  }
  const after = await trx.selectFrom('goods_receipt_lines').select(['qty', 'qty_billed']).where('receipt_id', '=', grnId).execute();
  await trx.updateTable('goods_receipts').set({
    status: statusFor(after.map((l) => ({ qty: l.qty, done: Number(l.qty_billed) })), 'billed', 'partially_billed', 'open') as 'open',
  }).where('id', '=', grnId).execute();
  if (grn.source_po_id) await refreshPurchaseOrder(trx, grn.source_po_id, bill.totalPaise);

  return { id: bill.id, internalNo: bill.internalNo, totalPaise: bill.totalPaise, heldForApproval: bill.heldForApproval, match };
}

/**
 * Bill straight from a purchase order, for services, or goods not put through
 * a receipt note. A line whose goods are already on an unbilled receipt note
 * is billed from the note instead, or the stock would come in twice.
 */
export async function billFromPurchaseOrder(
  trx: Trx, orgId: number, userId: number | null, poId: number,
  input: { vendorInvoiceNo: string; date: string; dueDate: string; lines?: BillPick[] },
): Promise<{ id: number; internalNo: string; totalPaise: Paise; heldForApproval: boolean; match: { status: 'matched' | 'exception'; note: string | null } }> {
  if (!input.vendorInvoiceNo?.trim()) throw badRequest("The supplier's own invoice number is needed — GSTR-2B is matched on it.");
  const { po, lines } = await loadPurchaseOrder(trx, orgId, poId);

  const onNotes = await trx.selectFrom('goods_receipt_lines as gl')
    .innerJoin('goods_receipts as g', 'g.id', 'gl.receipt_id')
    .select(['gl.po_line_id', 'gl.qty', 'gl.qty_billed', 'g.number'])
    .where('g.source_po_id', '=', poId).where('g.status', '<>', 'cancelled').execute();
  const unbilledReceived = new Map<number, { qty: number; note: string }>();
  for (const r of onNotes) {
    if (!r.po_line_id) continue;
    const left = Number(r.qty) - Number(r.qty_billed);
    if (left <= 0) continue;
    const prev = unbilledReceived.get(r.po_line_id);
    unbilledReceived.set(r.po_line_id, { qty: (prev?.qty ?? 0) + left, note: r.number });
  }
  // What can still be billed directly: ordered, less billed, less what sits on a note.
  const pending = (l: (typeof lines)[number]) =>
    Number(l.qty) - Number(l.qty_billed) - (unbilledReceived.get(l.id)?.qty ?? 0);
  if (input.lines?.length) {
    for (const p of input.lines) {
      const r = unbilledReceived.get(p.lineId);
      const l = lines.find((x) => x.id === p.lineId);
      if (r && l && p.qty > pending(l)) {
        throw badRequest(`Line ${l.line_no} has goods on receipt note ${r.note} still to be billed. Bill them from the note.`);
      }
    }
  }
  const picked = choose(lines, pending, input.lines, `purchase order ${po.number}`);
  const rateOf = new Map((input.lines ?? []).filter((p) => p.ratePaise != null).map((p) => [p.lineId, p.ratePaise!]));

  const problems: string[] = [];
  const billLines = picked.map(({ line, qty }) => {
    const ordered = netRate(line.rate, line.discount_pct);
    const override = rateOf.get(line.id);
    if (override != null && override > ordered * (1 + PRICE_TOLERANCE)) {
      problems.push(`line ${line.line_no} billed at ₹${(override / 100).toFixed(2)}, ordered at ₹${(ordered / 100).toFixed(2)}`);
    }
    return {
      itemId: line.item_id, accountId: line.account_id, description: line.description, hsnSac: line.hsn_sac,
      qty, uqc: line.uqc,
      ratePaise: override ?? toPaiseFromSql(line.rate),
      discountPct: override != null ? 0 : Number(line.discount_pct),
      gstRatePct: Number(line.gst_rate_pct),
    };
  });
  const match = problems.length
    ? { status: 'exception' as const, note: `Does not agree with the order: ${problems.join('; ')}.` }
    : { status: 'matched' as const, note: null };

  const bill = await createBill(trx, orgId, userId, {
    branchId: po.branch_id, vendorId: po.vendor_id, vendorInvoiceNo: input.vendorInvoiceNo.trim(),
    date: input.date, dueDate: input.dueDate, sourcePoId: po.id, status: 'open',
    lines: billLines, lineSources: picked.map(({ line }) => ({ type: 'purchase_order', id: line.id })), match, holdForApproval: true,
  });
  for (const { line, qty } of picked) {
    await trx.updateTable('purchase_order_lines')
      .set({ qty_billed: add('qty_billed', qty) }).where('id', '=', line.id).execute();
  }
  await refreshPurchaseOrder(trx, poId, bill.totalPaise);
  return { id: bill.id, internalNo: bill.internalNo, totalPaise: bill.totalPaise, heldForApproval: bill.heldForApproval, match };
}

/** Accept a bill that does not match its order or receipt, so it can be paid. */
export async function acceptBillMismatch(trx: Trx, orgId: number, userId: number | null, billId: number, note: string) {
  const bill = await trx.selectFrom('bills').select(['id', 'internal_no', 'match_status', 'match_note'])
    .where('id', '=', billId).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!bill) throw notFound('That bill does not exist.');
  if (bill.match_status !== 'exception') throw conflict(`Bill ${bill.internal_no} has nothing to accept.`);
  if (!note.trim()) throw badRequest('Say why it is being accepted; the note stays on the bill.');
  await trx.updateTable('bills').set({
    match_status: 'accepted',
    match_note: `${bill.match_note ?? ''} Accepted: ${note.trim()}`.trim(),
    match_accepted_by_user_id: userId,
    match_accepted_at: new Date(),
  }).where('id', '=', billId).execute();
}

/** Cancel a receipt note entered in error. Only while none of it is billed. */
export async function cancelGoodsReceipt(trx: Trx, orgId: number, userId: number | null, grnId: number, reason?: string) {
  const grn = await trx.selectFrom('goods_receipts').select(['id', 'number', 'status', 'journal_entry_id'])
    .where('id', '=', grnId).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!grn) throw notFound('That goods receipt does not exist.');
  if (grn.status === 'cancelled') throw conflict(`${grn.number} is already cancelled.`);
  if (grn.status !== 'open') throw conflict(`${grn.number} has been billed against; it can no longer be cancelled.`);

  const lines = await trx.selectFrom('goods_receipt_lines').select(['po_line_id', 'qty']).where('receipt_id', '=', grnId).execute();
  for (const l of lines) {
    if (!l.po_line_id) continue;
    const pol = await trx.selectFrom('purchase_order_lines').select(['qty_received']).where('id', '=', l.po_line_id).executeTakeFirstOrThrow();
    await trx.updateTable('purchase_order_lines')
      .set({ qty_received: String(Math.max(0, q6(Number(pol.qty_received) - Number(l.qty)))) }).where('id', '=', l.po_line_id).execute();
  }
  if (grn.journal_entry_id) {
    await reverseEntry(trx, orgId, grn.journal_entry_id, {
      memo: `${grn.number} cancelled${reason ? ` — ${reason}` : ''}`, userId, module: 'purchases',
    });
  }
  await trx.updateTable('goods_receipts').set({ status: 'cancelled' }).where('id', '=', grnId).execute();
}
