import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Edit and Delete on the stock screens, as Zoho Books and Zoho Inventory have
// them: adjustments, transfers between godowns, production runs, bills of
// materials, batches and godowns (2026-11-25, "wherever we need edit and
// delete you should give").
//
// Stock is worked out from the documents (reports/stock.ts), never stored, so
// changing or removing a document is what moves the stock back: there is no
// stock entry to reverse. What has to hold is that nothing already done rests
// on the quantity taken away —
//
//   * goods sold, used or moved since cannot be taken back out from under the
//     documents that sent them. Each change is measured before and after, at
//     the document's own date and today, for the branch it sits in: if it
//     leaves an item below zero (and lower than it was), the book's
//     negative-stock rule decides, as on every sale (guards.ts) — off, a
//     warning, or a refusal;
//   * a numbered piece found or written off on an adjustment that has moved on
//     another document since keeps that adjustment: deleting it would leave
//     the later document moving a piece that was never there.
//
// An adjustment from before stock became quantity-only may still carry a
// journal entry; that entry is reversed on its own date, never erased (a
// closed period refuses it). Every deleted adjustment, transfer and run keeps
// a row in deleted_documents with the whole of it as it stood, for the
// auditor; the route writes the audit line in the same transaction.
//
// Masters — bills of materials, batches, godowns — are refused while a
// document uses them (code `in_use`), with what Zoho offers instead: mark the
// bill of materials or the godown as not in use. A batch has no such state:
// it is named on documents, and goes only when none names it.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor, Trx } from '../db';
import { ApiError, badRequest, conflict, notFound } from '../http';
import { stockPosition } from '../reports/stock';
import { toPaiseFromSql, toSqlFromPaise } from '../money-sql';
import { enforce, getPolicies } from './org-settings';
import { findOrCreateBatch, type BatchInput } from './batches';
import { recordSerials } from './serials';
import { checkTransfer, type TransferInput } from './stock-transfers';
import { recordProduction, type ProductionInput } from './manufacturing';
import { plain, recordDeletion, reverseForChange, unlinkDocument } from './doc-delete';
import { indiaToday } from './held-journals';
import { afterStockMoved, itemValues, perpetualOn, postStockChange } from './stock-ledger';
import { CODE } from '../ledger/chart-of-accounts';

const locked = (message: string) => new ApiError(409, message, 'locked_document');
const inUse = (message: string) => new ApiError(409, message, 'in_use');
const ymd = (d: unknown) => String(d instanceof Date ? d.toISOString() : d).slice(0, 10);
const dmy = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
const q4 = (n: number) => Math.round(n * 10_000) / 10_000;

// ── Stock, before and after ─────────────────────────────────────────────────

interface Scope { branchId: number | null; date: string }

/** The branch a godown's stock counts in: its own, or the main branch's for a godown that names none. */
async function branchOfGodown(ex: Executor, orgId: number, warehouseId: number | null): Promise<number | null> {
  if (warehouseId) {
    const w = await ex.selectFrom('warehouses').select('branch_id').where('id', '=', warehouseId).where('org_id', '=', orgId).executeTakeFirst();
    if (w?.branch_id) return w.branch_id;
  }
  const primary = await ex.selectFrom('branches').select('id').where('org_id', '=', orgId).where('is_primary', '=', 1).executeTakeFirst();
  return primary?.id ?? null;
}

async function quantities(ex: Executor, orgId: number, scopes: Scope[], itemIds: number[]) {
  const out = new Map<string, { qty: number; name: string; date: string }>();
  const seen = new Set<string>();
  for (const s of scopes) {
    const key = `${s.branchId ?? 'all'}|${s.date}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const pos = await stockPosition(ex, orgId, s.date, { branchId: s.branchId ?? undefined, includeArchived: true });
    for (const id of itemIds) {
      const l = pos.lines.find((x) => x.itemId === String(id));
      if (l) out.set(`${key}|${id}`, { qty: l.qty, name: l.name, date: s.date });
    }
  }
  return out;
}

/**
 * Take the stock of the items a change touches, then, once the change is
 * made, look again: an item left below zero, and lower than it was, is what
 * the book's negative-stock rule is for. Always checked at today as well as
 * at the document's own dates, so a later sale is seen.
 */
async function stockGuard(
  trx: Trx, orgId: number, scopes: Scope[], itemIds: (number | null | undefined)[],
): Promise<{ check: (warnings: string[]) => Promise<void> }> {
  const ids = [...new Set(itemIds.filter((x): x is number => !!x))];
  const policy = (await getPolicies(trx, orgId)).negativeStock;
  if (policy === 'off' || !ids.length) return { check: async () => {} };
  const today = indiaToday();
  const all = [...scopes, ...[...new Set(scopes.map((s) => s.branchId))].map((branchId) => ({ branchId, date: today }))];
  const before = await quantities(trx, orgId, all, ids);
  return {
    check: async (warnings: string[]) => {
      const after = await quantities(trx, orgId, all, ids);
      const worst = new Map<string, { qty: number; date: string }>();
      for (const [key, a] of after) {
        const was = before.get(key)?.qty ?? 0;
        if (a.qty < -1e-9 && a.qty < was - 1e-9 && (!worst.has(a.name) || a.qty < worst.get(a.name)!.qty)) worst.set(a.name, { qty: a.qty, date: a.date });
      }
      if (!worst.size) return;
      const short = [...worst].map(([name, w]) => `${name} would be at ${q4(w.qty)} on ${dmy(w.date)}`);
      enforce(policy, `That leaves too little stock: ${short.join('; ')}. Goods sold or used since cannot be taken back out from under those documents.`,
        warnings, conflict);
    },
  };
}

let savepoints = 0;

/**
 * The change and the check after it, as one: a refusal from the check (or from
 * anything else the change runs into) takes the change back to a savepoint, so
 * nothing of it is left even inside a caller's larger transaction. A route
 * rolls its whole transaction back anyway; this keeps the service whole on its
 * own terms.
 */
async function atomically<T>(trx: Trx, fn: () => Promise<T>): Promise<T> {
  const name = sql.raw(`stock_change_${++savepoints}`);
  await sql`SAVEPOINT ${name}`.execute(trx);
  try {
    const out = await fn();
    await sql`RELEASE SAVEPOINT ${name}`.execute(trx);
    return out;
  } catch (err) {
    // A connection already gone has rolled back on its own; the first error is the one that matters.
    await sql`ROLLBACK TO SAVEPOINT ${name}`.execute(trx).catch(() => {});
    throw err;
  }
}

/** A piece found or written off on this adjustment that has moved on another document since. */
async function serialMovedSince(trx: Trx, orgId: number, adjustmentId: number): Promise<string | null> {
  const { rows } = await sql<{ serial_no: string }>`
    SELECT s.serial_no FROM serial_moves m
      JOIN serial_moves later ON later.serial_id = m.serial_id AND later.id > m.id AND NOT (later.doc_type = m.doc_type AND later.doc_id = m.doc_id)
      JOIN item_serials s ON s.id = m.serial_id
     WHERE m.org_id = ${orgId} AND m.doc_type = 'adjustment' AND m.doc_id = ${adjustmentId}
     LIMIT 1`.execute(trx);
  return rows[0]?.serial_no ?? null;
}

// ── Adjustments ─────────────────────────────────────────────────────────────

export const ADJUST_REASONS = ['damage', 'theft', 'stocktake', 'expiry', 'sample', 'opening', 'other', 'issued'] as const;
export type AdjustReason = (typeof ADJUST_REASONS)[number];

export interface AdjustmentInput {
  itemId: number;
  warehouseId?: number | null;
  date: string;
  qtyDelta: number;
  reason: AdjustReason;
  notes?: string | null;
  batch?: BatchInput | null;
  serials?: string[] | null;
}

/** The item and godown an adjustment names, checked as New checks them. `keepItem`: Edit of the same item, archived since. */
async function checkAdjustment(trx: Trx, orgId: number, input: AdjustmentInput, keepItem?: number) {
  if (!input.qtyDelta) throw badRequest('An adjustment of zero changes nothing.');
  const item = await trx.selectFrom('items')
    .select(['id', 'name', 'kind', 'is_archived', 'track_inventory', 'track_batches'])
    .where('id', '=', input.itemId).where('org_id', '=', orgId).executeTakeFirst();
  if (!item) throw badRequest('That item does not exist.');
  if (item.kind !== 'goods') throw badRequest('Only goods carry stock. A service has none to adjust.');
  if (item.is_archived && item.id !== keepItem) throw conflict(`${item.name} is archived.`);
  if (!item.track_inventory) throw conflict(`${item.name} does not track stock. Turn on stock tracking for it first.`);
  if (item.track_batches && !input.batch) throw badRequest(`${item.name} is tracked by batch: say which batch.`);
  if (input.warehouseId) {
    const w = await trx.selectFrom('warehouses').select(['id', 'name', 'is_active']).where('id', '=', input.warehouseId).where('org_id', '=', orgId).executeTakeFirst();
    if (!w) throw notFound('That godown does not exist.');
    if (!w.is_active) throw badRequest(`${w.name} is no longer in use.`);
  }
  return item;
}

/** The adjustment as entered, for its Edit window. */
export async function adjustmentForEdit(ex: Executor, orgId: number, id: number) {
  const a = await ex.selectFrom('stock_adjustments as a').innerJoin('items as i', 'i.id', 'a.item_id').leftJoin('batches as b', 'b.id', 'a.batch_id')
    .select(['a.id', 'a.item_id', 'a.warehouse_id', 'a.adjust_date', 'a.qty_delta', 'a.reason', 'a.notes', 'a.journal_entry_id',
      'i.name as item_name', 'b.batch_no', 'b.mfg_date', 'b.expiry_date'])
    .where('a.id', '=', id).where('a.org_id', '=', orgId).executeTakeFirst();
  if (!a) throw notFound('That adjustment does not exist.');
  const serials = await ex.selectFrom('serial_moves as m').innerJoin('item_serials as s', 's.id', 'm.serial_id')
    .select('s.serial_no').where('m.org_id', '=', orgId).where('m.doc_type', '=', 'adjustment').where('m.doc_id', '=', id).orderBy('m.id').execute();
  return {
    id: String(a.id), itemId: String(a.item_id), itemName: a.item_name, warehouseId: a.warehouse_id ? String(a.warehouse_id) : null,
    date: ymd(a.adjust_date), qtyDelta: Number(a.qty_delta), reason: a.reason, notes: a.notes,
    batch: a.batch_no ? { batchNo: a.batch_no, mfgDate: a.mfg_date ? ymd(a.mfg_date) : null, expiryDate: a.expiry_date ? ymd(a.expiry_date) : null } : null,
    serials: serials.map((s) => s.serial_no),
    posted: !!a.journal_entry_id,
  };
}

/** Record an adjustment: quantity only on a periodic book, as in Tally (see app/api/inventory/route.ts); posted on a perpetual one. */
export async function createAdjustment(trx: Trx, orgId: number, userId: number | null, input: AdjustmentInput) {
  const item = await checkAdjustment(trx, orgId, input);
  // Goods written off that are not there to write off: the book's negative-stock rule (Settings →
  // Controls) warns or refuses, measured on the adjustment's day and today, as on every sale.
  const guard = input.qtyDelta < 0
    ? await stockGuard(trx, orgId, [{ branchId: await branchOfGodown(trx, orgId, input.warehouseId ?? null), date: input.date }], [item.id])
    : null;
  return atomically(trx, async () => {
    const batchId = item.track_batches && input.batch ? await findOrCreateBatch(trx, orgId, item.id, input.batch) : null;
    // The stock's value on the day without this adjustment, on either method: what it moves is
    // measured against it (keepAdjustmentValue below), and on a perpetual book posted.
    const valueBefore = await itemValues(trx, orgId, input.date);
    const id = Number((await trx.insertInto('stock_adjustments').values({
      org_id: orgId, batch_id: batchId, warehouse_id: input.warehouseId ?? null, item_id: item.id, adjust_date: input.date,
      qty_delta: String(input.qtyDelta), reason: input.reason, notes: input.notes ?? null, journal_entry_id: null, created_by_user_id: userId,
    }).executeTakeFirstOrThrow()).insertId);
    // Numbered pieces found (opening stock, a count) or written off.
    await recordSerials(trx, orgId, { type: 'adjustment', id }, input.qtyDelta > 0 ? 1 : -1,
      [{ lineId: null, itemId: item.id, qty: input.qtyDelta, serials: input.serials }], { check: true });
    const valuePaise = await keepAdjustmentValue(trx, orgId, id, item.id, input.date, valueBefore);
    if (await perpetualOn(trx, orgId, input.date)) await postAdjustment(trx, orgId, userId, id, { ...input, itemName: item.name }, valueBefore);
    const warnings: string[] = [];
    if (guard) await guard.check(warnings);
    return { id, itemName: item.name, valuePaise, warnings };
  });
}

/**
 * What an adjustment took out of stock (negative) or put back (positive), at
 * the stock valuation's own figures: the item's value on the adjustment's date
 * with it, less its value without it. For a FIFO item that is the cost of the
 * oldest units on hand (AS 2 / Ind AS 2: issues come from the earliest
 * purchases); for an average-cost item, the year's average. It is kept on the
 * adjustment (migration 137) because a periodic book posts nothing at the
 * adjustment — the loss reaches the profit and loss through a smaller closing
 * stock — so there is no entry to read it back from, and the adjustments list,
 * its export and the window that recorded it must all say the same figure. On a
 * perpetual book it is exactly what postAdjustment posts to Inventory.
 */
async function keepAdjustmentValue(trx: Trx, orgId: number, id: number, itemId: number, date: string, before: Map<number, number>): Promise<number> {
  const after = await itemValues(trx, orgId, date);
  const moved = (after.get(itemId) ?? 0) - (before.get(itemId) ?? 0);
  await trx.updateTable('stock_adjustments').set({ value: toSqlFromPaise(moved) }).where('id', '=', id).execute();
  return moved;
}

/** A date no report reaches: an adjustment moved there is out of the stock for a moment, to measure it. */
const OUT_OF_RANGE = '2999-12-31';

/** Work an adjustment's value out again from the stock as it stands (seeded or older adjustments, migration 137). */
export async function refreshAdjustmentValue(trx: Trx, orgId: number, id: number): Promise<number> {
  const row = await trx.selectFrom('stock_adjustments').select(['item_id', 'adjust_date', 'qty_delta']).where('id', '=', id).where('org_id', '=', orgId).executeTakeFirstOrThrow();
  const date = ymd(row.adjust_date);
  await trx.updateTable('stock_adjustments').set({ adjust_date: OUT_OF_RANGE }).where('id', '=', id).execute();
  const before = await itemValues(trx, orgId, date);
  await trx.updateTable('stock_adjustments').set({ adjust_date: date }).where('id', '=', id).execute();
  return keepAdjustmentValue(trx, orgId, id, row.item_id, date, before);
}

/**
 * On a perpetual book an adjustment posts on its own date, not at the month-end
 * true-up: goods written off (damaged, stolen, expired, a stocktake short) leave
 * Inventory at their FIFO or average cost on the day, into cost of goods sold,
 * which is where the periodic method's smaller closing stock puts the same loss,
 * so both methods report the same cost; goods found come back the other way.
 * Opening stock entered as an adjustment is an opening balance: its other side
 * is opening equity, as on the item itself. Before this the Inventory account
 * and the valuation report disagreed from the adjustment until month end.
 */
async function postAdjustment(
  trx: Trx, orgId: number, userId: number | null, id: number,
  a: AdjustmentInput & { itemName: string }, before: Map<number, number>,
) {
  const opening = a.reason === 'opening';
  const posted = await postStockChange(trx, orgId, userId, {
    date: a.date, before, sourceType: 'stock_adjustment', sourceId: id,
    counterCode: opening ? CODE.OPENING_BALANCE_EQUITY : CODE.COGS,
    memo: `Stock adjustment ADJ-${id}: ${a.qtyDelta > 0 ? '+' : ''}${a.qtyDelta} ${a.itemName} (${a.reason})${a.notes ? ` - ${a.notes}` : ''}`.slice(0, 500),
    describe: { in: 'Stock found: into Inventory', out: `Stock written off: ${a.reason}`, counter: opening ? 'Opening stock' : `Stock adjustment: ${a.reason}` },
  });
  await trx.updateTable('stock_adjustments').set({ journal_entry_id: posted?.entryId ?? null }).where('id', '=', id).execute();
  await afterStockMoved(trx, orgId, userId, a.date, `stock adjustment ADJ-${id} dated ${a.date}`);
}

/**
 * Edit an adjustment, as Zoho's Edit: written again over its own row. Refused
 * while a piece it named has moved since; the stock it leaves is checked as
 * above. A legacy entry it carried is reversed; the new version, like every
 * adjustment now, posts nothing.
 */
export async function updateAdjustment(trx: Trx, orgId: number, userId: number | null, id: number, input: AdjustmentInput) {
  const row = await trx.selectFrom('stock_adjustments').selectAll().where('id', '=', id).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!row) throw notFound('That adjustment does not exist.');
  const moved = await serialMovedSince(trx, orgId, id);
  if (moved) throw locked(`This adjustment cannot be edited: piece ${moved}, named on it, has moved on another document since.`);
  const before = await adjustmentForEdit(trx, orgId, id);
  const item = await checkAdjustment(trx, orgId, input, row.item_id);
  const guard = await stockGuard(trx, orgId, [
    { branchId: await branchOfGodown(trx, orgId, row.warehouse_id), date: ymd(row.adjust_date) },
    { branchId: await branchOfGodown(trx, orgId, input.warehouseId ?? null), date: input.date },
  ], [row.item_id, item.id]);

  return atomically(trx, async () => {
    await reverseForChange(trx, orgId, row.journal_entry_id, { memo: `Stock adjustment of ${before.itemName} edited: the entry as it was, reversed`, userId, module: 'accountant' });
    await trx.deleteFrom('serial_moves').where('org_id', '=', orgId).where('doc_type', '=', 'adjustment').where('doc_id', '=', id).execute();
    const batchId = item.track_batches && input.batch ? await findOrCreateBatch(trx, orgId, item.id, input.batch) : null;
    // The stock's value without this adjustment, for what the new version moves (and, on a perpetual book, posts).
    const perpetual = await perpetualOn(trx, orgId, input.date);
    // Out of the way for the measurement: dated past any report (a quantity of nil is not allowed, ck_adj_nonzero).
    await trx.updateTable('stock_adjustments').set({ adjust_date: OUT_OF_RANGE, journal_entry_id: null }).where('id', '=', id).execute();
    const valueBefore = await itemValues(trx, orgId, input.date);
    await trx.updateTable('stock_adjustments').set({
      batch_id: batchId, warehouse_id: input.warehouseId ?? null, item_id: item.id, adjust_date: input.date,
      qty_delta: String(input.qtyDelta), reason: input.reason, notes: input.notes ?? null, journal_entry_id: null,
    }).where('id', '=', id).execute();
    await recordSerials(trx, orgId, { type: 'adjustment', id }, input.qtyDelta > 0 ? 1 : -1,
      [{ lineId: null, itemId: item.id, qty: input.qtyDelta, serials: input.serials }], { check: true });
    const valuePaise = await keepAdjustmentValue(trx, orgId, id, item.id, input.date, valueBefore);
    if (perpetual) await postAdjustment(trx, orgId, userId, id, { ...input, itemName: item.name }, valueBefore);
    const oldDay = ymd(row.adjust_date);
    if (oldDay < input.date || !perpetual) await afterStockMoved(trx, orgId, userId, oldDay < input.date ? oldDay : input.date, `stock adjustment ADJ-${id} edited`);

    const warnings: string[] = [];
    await guard.check(warnings);
    return { id, itemName: item.name, before, valuePaise, warnings };
  });
}

/** Delete an adjustment: its quantity leaves the stock figures, the record of it is kept. */
export async function deleteAdjustment(trx: Trx, orgId: number, userId: number | null, id: number, reason?: string | null) {
  const row = await trx.selectFrom('stock_adjustments').selectAll().where('id', '=', id).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!row) throw notFound('That adjustment does not exist.');
  const moved = await serialMovedSince(trx, orgId, id);
  if (moved) throw locked(`This adjustment cannot be deleted: piece ${moved}, named on it, has moved on another document since.`);
  const snapshot = await adjustmentForEdit(trx, orgId, id);
  const guard = await stockGuard(trx, orgId, [{ branchId: await branchOfGodown(trx, orgId, row.warehouse_id), date: ymd(row.adjust_date) }], [row.item_id]);

  return atomically(trx, async () => {
    const reversal = await reverseForChange(trx, orgId, row.journal_entry_id, { memo: `Stock adjustment of ${snapshot.itemName} deleted`, userId, module: 'accountant' });
    await trx.deleteFrom('serial_moves').where('org_id', '=', orgId).where('doc_type', '=', 'adjustment').where('doc_id', '=', id).execute();
    await unlinkDocument(trx, orgId, 'stock_adjustment', id);
    await recordDeletion(trx, {
      orgId, userId, docType: 'stock_adjustment', docId: id, number: null, date: ymd(row.adjust_date),
      journalEntryId: row.journal_entry_id, reversalEntryId: reversal, reason, snapshot: { adjustment: plain(row), ...snapshot },
    });
    await trx.deleteFrom('stock_adjustments').where('id', '=', id).where('org_id', '=', orgId).execute();
    await afterStockMoved(trx, orgId, userId, ymd(row.adjust_date), `stock adjustment ADJ-${id} deleted`);

    const warnings: string[] = [];
    await guard.check(warnings);
    return { itemName: snapshot.itemName, qtyDelta: snapshot.qtyDelta, warnings };
  });
}

// ── Transfers ───────────────────────────────────────────────────────────────

/** The transfer as entered, for its Edit window. */
export async function transferForEdit(ex: Executor, orgId: number, id: number) {
  const t = await ex.selectFrom('stock_transfers').selectAll().where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
  if (!t) throw notFound('That transfer does not exist.');
  const lines = await ex.selectFrom('stock_transfer_lines').select(['item_id', 'qty']).where('transfer_id', '=', id).orderBy('id').execute();
  return {
    id: String(t.id), number: t.number, status: t.status, fromWarehouseId: String(t.from_warehouse_id), toWarehouseId: String(t.to_warehouse_id),
    date: ymd(t.dispatch_date), receivedDate: t.received_date ? ymd(t.received_date) : null,
    vehicleNo: t.vehicle_no, ewayBillNo: t.eway_bill_no, notes: t.notes,
    lines: lines.map((l) => ({ itemId: String(l.item_id), qty: Number(l.qty) })),
  };
}

/** Where a transfer's goods count, out and (once received) in. */
async function transferScopes(trx: Trx, orgId: number, t: { from: number; to: number; date: string; receivedDate: string | null }): Promise<Scope[]> {
  const scopes: Scope[] = [{ branchId: await branchOfGodown(trx, orgId, t.from), date: t.date }];
  if (t.receivedDate) scopes.push({ branchId: await branchOfGodown(trx, orgId, t.to), date: t.receivedDate });
  return scopes;
}

/**
 * Edit a transfer, in transit or received: written again over its own row,
 * under its own number. A cancelled one is not edited. A received one keeps
 * being received, on the date given (not before it was sent).
 */
export async function updateTransfer(trx: Trx, orgId: number, id: number, input: TransferInput & { receivedDate?: string | null }) {
  const t = await trx.selectFrom('stock_transfers').selectAll().where('id', '=', id).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!t) throw notFound('That transfer does not exist.');
  if (t.status === 'cancelled') throw locked(`${t.number} is cancelled. Record a new transfer instead.`);
  const received = t.status === 'received' ? input.receivedDate || ymd(t.received_date) : null;
  if (received && received < input.date) throw badRequest('Goods cannot arrive before they were sent.');
  const before = await transferForEdit(trx, orgId, id);
  const { lines } = await checkTransfer(trx, orgId, input);
  const guard = await stockGuard(trx, orgId, [
    ...await transferScopes(trx, orgId, { from: t.from_warehouse_id, to: t.to_warehouse_id, date: ymd(t.dispatch_date), receivedDate: t.received_date ? ymd(t.received_date) : null }),
    ...await transferScopes(trx, orgId, { from: input.fromWarehouseId, to: input.toWarehouseId, date: input.date, receivedDate: received }),
  ], [...before.lines.map((l) => Number(l.itemId)), ...lines.map((l) => l.itemId)]);

  return atomically(trx, async () => {
    await trx.deleteFrom('stock_transfer_lines').where('transfer_id', '=', id).execute();
    await trx.updateTable('stock_transfers').set({
      from_warehouse_id: input.fromWarehouseId, to_warehouse_id: input.toWarehouseId, dispatch_date: input.date, received_date: received,
      vehicle_no: input.vehicleNo ?? null, eway_bill_no: input.ewayBillNo ?? null, notes: input.notes ?? null,
    }).where('id', '=', id).execute();
    await trx.insertInto('stock_transfer_lines').values(lines.map((l) => ({ transfer_id: id, item_id: l.itemId, qty: String(l.qty) }))).execute();

    const warnings: string[] = [];
    await guard.check(warnings);
    return { id, number: t.number, before, warnings };
  });
}

/** Delete a transfer: the goods are where they were before it, the record of it kept. */
export async function deleteTransfer(trx: Trx, orgId: number, userId: number | null, id: number, reason?: string | null) {
  const t = await trx.selectFrom('stock_transfers').selectAll().where('id', '=', id).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!t) throw notFound('That transfer does not exist.');
  const snapshot = await transferForEdit(trx, orgId, id);
  // A cancelled transfer moved nothing; one received took goods to the other godown, which may have gone on since.
  const guard = t.status === 'cancelled' ? null : await stockGuard(trx, orgId,
    await transferScopes(trx, orgId, { from: t.from_warehouse_id, to: t.to_warehouse_id, date: ymd(t.dispatch_date), receivedDate: t.received_date ? ymd(t.received_date) : null }),
    snapshot.lines.map((l) => Number(l.itemId)));
  return atomically(trx, async () => {
    await unlinkDocument(trx, orgId, 'stock_transfer', id);
    await recordDeletion(trx, { orgId, userId, docType: 'stock_transfer', docId: id, number: t.number, date: ymd(t.dispatch_date), reason, snapshot });
    await trx.deleteFrom('stock_transfers').where('id', '=', id).where('org_id', '=', orgId).execute();
    const warnings: string[] = [];
    await guard?.check(warnings);
    return { number: t.number, warnings };
  });
}

// ── Production runs ─────────────────────────────────────────────────────────

/** The run as entered, for its Edit window. */
export async function productionForEdit(ex: Executor, orgId: number, id: number) {
  const p = await ex.selectFrom('productions').selectAll().where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
  if (!p) throw notFound('That production run does not exist.');
  const lines = await ex.selectFrom('production_lines').select(['item_id', 'qty', 'cost']).where('production_id', '=', id).orderBy('id').execute();
  return {
    id: String(p.id), number: p.number, status: p.status, bomId: p.bom_id ? String(p.bom_id) : null, itemId: String(p.item_id),
    qty: Number(p.qty), date: ymd(p.produced_on), branchId: String(p.branch_id), warehouseId: p.warehouse_id ? String(p.warehouse_id) : null,
    overheadPaise: toPaiseFromSql(p.overhead), notes: p.notes,
    lines: lines.map((l) => ({ itemId: String(l.item_id), qty: Number(l.qty), costPaise: toPaiseFromSql(l.cost) })),
  };
}

/**
 * Edit a run, as Zoho's Edit on an assembly: what it made and how much, the
 * day, the godown and the overhead. It comes out of stock first, so its
 * components are checked and costed afresh as if it were being recorded now
 * (recordProduction), and it is written back over its own row and number. If
 * it now makes less, the finished goods already sold are checked for.
 */
export async function updateProduction(trx: Trx, orgId: number, userId: number | null, id: number, input: ProductionInput) {
  const p = await trx.selectFrom('productions').selectAll().where('id', '=', id).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!p) throw notFound('That production run does not exist.');
  if (p.status === 'void') throw locked(`${p.number} is void. Record a new run instead.`);
  const before = await productionForEdit(trx, orgId, id);
  const bom = input.bomId ? await trx.selectFrom('boms').select('item_id').where('id', '=', input.bomId).where('org_id', '=', orgId).executeTakeFirst() : undefined;
  const guard = await stockGuard(trx, orgId, [
    { branchId: p.branch_id, date: ymd(p.produced_on) },
    { branchId: input.branchId, date: input.date },
  ], [p.item_id, bom?.item_id]);
  return atomically(trx, async () => {
    // Out of stock for a moment, so the components are counted without it.
    await reverseForChange(trx, orgId, p.journal_entry_id, { memo: `Production ${p.number} edited: the entry as it was, reversed`, userId, module: 'accountant' });
    await trx.updateTable('productions').set({ status: 'void', journal_entry_id: null }).where('id', '=', id).execute();
    await trx.deleteFrom('production_lines').where('production_id', '=', id).execute();
    const made = await recordProduction(trx, orgId, userId, input, { replace: { id, number: p.number, bomId: p.bom_id } });
    if (ymd(p.produced_on) < input.date) await afterStockMoved(trx, orgId, userId, ymd(p.produced_on), `production ${p.number} edited`);
    await guard.check(made.warnings);
    return { ...made, before };
  });
}

/** Delete a run: its components back in stock, the goods it made gone, the record of it kept. */
export async function deleteProduction(trx: Trx, orgId: number, userId: number | null, id: number, reason?: string | null) {
  const p = await trx.selectFrom('productions').selectAll().where('id', '=', id).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!p) throw notFound('That production run does not exist.');
  const snapshot = await productionForEdit(trx, orgId, id);
  const guard = p.status === 'void' ? null : await stockGuard(trx, orgId, [{ branchId: p.branch_id, date: ymd(p.produced_on) }], [p.item_id]);
  return atomically(trx, async () => {
    const reversal = await reverseForChange(trx, orgId, p.journal_entry_id, { memo: `Production ${p.number} deleted`, userId, module: 'accountant' });
    await unlinkDocument(trx, orgId, 'production', id);
    await recordDeletion(trx, {
      orgId, userId, docType: 'production', docId: id, number: p.number, date: ymd(p.produced_on), branchId: p.branch_id,
      totalPaise: toPaiseFromSql(p.cost), reason, snapshot, journalEntryId: p.journal_entry_id, reversalEntryId: reversal,
    });
    await trx.deleteFrom('productions').where('id', '=', id).where('org_id', '=', orgId).execute();
    await afterStockMoved(trx, orgId, userId, ymd(p.produced_on), `production ${p.number} deleted`);
    const warnings: string[] = [];
    await guard?.check(warnings);
    return { number: p.number, warnings };
  });
}

// ── Bills of materials ──────────────────────────────────────────────────────

/** Delete a bill of materials nothing was made from; one in use is marked not in use instead. */
export async function deleteBom(trx: Trx, orgId: number, id: number) {
  const b = await trx.selectFrom('boms as b').innerJoin('items as i', 'i.id', 'b.item_id').select(['b.id', 'b.name', 'i.name as item_name'])
    .where('b.id', '=', id).where('b.org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!b) throw notFound('That bill of materials does not exist.');
  const runs = await trx.selectFrom('productions').select((eb) => eb.fn.countAll<number>().as('n')).where('org_id', '=', orgId).where('bom_id', '=', id).executeTakeFirst();
  if (Number(runs?.n ?? 0) > 0) {
    throw inUse(`${b.item_name} (${b.name}) was used for ${runs!.n} production run(s), which keep it. Mark it as not in use instead: it stays on those runs and cannot be picked for new ones.`);
  }
  await trx.deleteFrom('boms').where('id', '=', id).where('org_id', '=', orgId).execute();
  return { label: `${b.item_name}: ${b.name}` };
}

export async function setBomActive(trx: Trx, orgId: number, id: number, isActive: boolean) {
  const r = await trx.updateTable('boms').set({ is_active: isActive ? 1 : 0 }).where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
  if (!Number(r.numUpdatedRows)) throw notFound('That bill of materials does not exist.');
}

// ── Batches ─────────────────────────────────────────────────────────────────

/** The documents that name a batch, by kind. */
async function batchUse(ex: Executor, orgId: number, id: number) {
  const { rows } = await sql<{ kind: string; n: number }>`
    SELECT 'bill' AS kind, COUNT(*) AS n FROM bill_lines l JOIN bills d ON d.id = l.bill_id WHERE d.org_id = ${orgId} AND l.batch_id = ${id}
    UNION ALL SELECT 'goods receipt', COUNT(*) FROM goods_receipt_lines l JOIN goods_receipts d ON d.id = l.receipt_id WHERE d.org_id = ${orgId} AND l.batch_id = ${id}
    UNION ALL SELECT 'invoice', COUNT(*) FROM invoice_lines l JOIN invoices d ON d.id = l.invoice_id WHERE d.org_id = ${orgId} AND l.batch_id = ${id}
    UNION ALL SELECT 'credit note', COUNT(*) FROM credit_note_lines l JOIN credit_notes d ON d.id = l.credit_note_id WHERE d.org_id = ${orgId} AND l.batch_id = ${id}
    UNION ALL SELECT 'adjustment', COUNT(*) FROM stock_adjustments a WHERE a.org_id = ${orgId} AND a.batch_id = ${id}`.execute(ex);
  return rows.filter((r) => Number(r.n) > 0).map((r) => `${r.n} ${r.kind}${Number(r.n) === 1 ? '' : 's'}`);
}

/**
 * Correct a batch: the number or the dates printed on the pack. Every document
 * naming it follows, since they name it by its id. Two batches of one item
 * cannot share a number.
 */
export async function updateBatch(trx: Trx, orgId: number, id: number, input: BatchInput) {
  const b = await trx.selectFrom('batches').selectAll().where('id', '=', id).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!b) throw notFound('That batch does not exist.');
  const batchNo = input.batchNo.trim();
  if (!batchNo) throw badRequest('Give the batch number.');
  if (input.mfgDate && input.expiryDate && input.expiryDate < input.mfgDate) throw badRequest(`Batch ${batchNo} expires before it was made.`);
  const clash = await trx.selectFrom('batches').select('id').where('org_id', '=', orgId).where('item_id', '=', b.item_id)
    .where('batch_no', '=', batchNo).where('id', '<>', id).executeTakeFirst();
  if (clash) throw conflict(`This item already has a batch ${batchNo}.`);
  await trx.updateTable('batches').set({ batch_no: batchNo, mfg_date: input.mfgDate || null, expiry_date: input.expiryDate || null }).where('id', '=', id).execute();
  return { before: plain(b), batchNo };
}

/** Delete a batch no document names: one left over after its documents were changed. */
export async function deleteBatch(trx: Trx, orgId: number, id: number) {
  const b = await trx.selectFrom('batches').select(['id', 'batch_no']).where('id', '=', id).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!b) throw notFound('That batch does not exist.');
  const used = await batchUse(trx, orgId, id);
  if (used.length) {
    throw inUse(`Batch ${b.batch_no} is named on ${used.join(', ')}. It goes when none of them names it: change or delete those documents first.`);
  }
  await trx.deleteFrom('batches').where('id', '=', id).execute();
  return { batchNo: b.batch_no };
}

// ── Godowns ─────────────────────────────────────────────────────────────────

/** The documents that name a godown, by kind. */
async function godownUse(ex: Executor, orgId: number, id: number) {
  const { rows } = await sql<{ kind: string; n: number }>`
    SELECT 'bill' AS kind, COUNT(*) AS n FROM bills WHERE org_id = ${orgId} AND warehouse_id = ${id}
    UNION ALL SELECT 'invoice', COUNT(*) FROM invoices WHERE org_id = ${orgId} AND warehouse_id = ${id}
    UNION ALL SELECT 'credit note', COUNT(*) FROM credit_notes WHERE org_id = ${orgId} AND warehouse_id = ${id}
    UNION ALL SELECT 'goods receipt', COUNT(*) FROM goods_receipts WHERE org_id = ${orgId} AND warehouse_id = ${id}
    UNION ALL SELECT 'production run', COUNT(*) FROM productions WHERE org_id = ${orgId} AND warehouse_id = ${id}
    UNION ALL SELECT 'adjustment', COUNT(*) FROM stock_adjustments WHERE org_id = ${orgId} AND warehouse_id = ${id}
    UNION ALL SELECT 'transfer', COUNT(*) FROM stock_transfers WHERE org_id = ${orgId} AND (from_warehouse_id = ${id} OR to_warehouse_id = ${id})`.execute(ex);
  return rows.filter((r) => Number(r.n) > 0).map((r) => `${r.n} ${r.kind}${Number(r.n) === 1 ? '' : 's'}`);
}

export interface WarehouseInput {
  name: string;
  code?: string | null;
  address?: string | null;
  branchId?: number | null;
  /** Make it the default, where stock goes when a document names none. */
  isPrimary?: boolean;
  isActive?: boolean;
}

/**
 * Edit a godown: its name, code and address freely. Its branch decides which
 * GST registration the stock in it sits under, so it does not change once a
 * document names the godown. The default cannot be put out of use; another is
 * made the default first.
 */
export async function updateWarehouse(trx: Trx, orgId: number, id: number, input: WarehouseInput) {
  const w = await trx.selectFrom('warehouses').selectAll().where('id', '=', id).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!w) throw notFound('That warehouse does not exist.');
  const name = input.name.trim();
  if (!name) throw badRequest('A warehouse needs a name.');
  const clash = await trx.selectFrom('warehouses').select('id').where('org_id', '=', orgId).where('name', '=', name).where('id', '<>', id).executeTakeFirst();
  if (clash) throw conflict(`There is already a warehouse called ${name}.`);
  const branchId = input.branchId ?? null;
  if (branchId !== w.branch_id) {
    if (branchId) {
      const b = await trx.selectFrom('branches').select('id').where('id', '=', branchId).where('org_id', '=', orgId).executeTakeFirst();
      if (!b) throw notFound('That branch does not exist.');
    }
    const used = await godownUse(trx, orgId, id);
    if (used.length) {
      throw conflict(`${w.name} is named on ${used.join(', ')}, recorded under its present branch, so its branch stays. Add a new warehouse for the other branch.`);
    }
  }
  const isActive = input.isActive ?? !!w.is_active;
  const isPrimary = input.isPrimary || (!!w.is_primary && input.isPrimary !== false);
  if (w.is_primary && !isPrimary) throw badRequest(`${w.name} is the default warehouse. Make another the default instead.`);
  if (isPrimary && !isActive) throw badRequest(`${w.name} is the default warehouse, so it stays in use. Make another the default first.`);
  if (isPrimary && !w.is_primary) await trx.updateTable('warehouses').set({ is_primary: 0 }).where('org_id', '=', orgId).execute();
  await trx.updateTable('warehouses').set({
    name: name.slice(0, 150), code: input.code?.trim() || null, address: input.address?.trim() || null, branch_id: branchId,
    is_primary: isPrimary ? 1 : 0, is_active: isActive ? 1 : 0,
  }).where('id', '=', id).execute();
  return { before: plain(w), name };
}

/** Delete a godown no document names; one in use is marked inactive instead, as Zoho offers. */
export async function deleteWarehouse(trx: Trx, orgId: number, id: number) {
  const w = await trx.selectFrom('warehouses').select(['id', 'name', 'is_primary']).where('id', '=', id).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!w) throw notFound('That warehouse does not exist.');
  const used = await godownUse(trx, orgId, id);
  if (used.length) {
    throw inUse(`${w.name} is named on ${used.join(', ')}. Mark it as inactive instead: it stays on those documents and cannot be picked for new ones.`);
  }
  const others = await trx.selectFrom('warehouses').select('id').where('org_id', '=', orgId).where('id', '<>', id).executeTakeFirst();
  if (w.is_primary && others) throw badRequest(`${w.name} is the default warehouse. Make another the default first, then delete it.`);
  await trx.deleteFrom('warehouses').where('id', '=', id).execute();
  return { name: w.name };
}
