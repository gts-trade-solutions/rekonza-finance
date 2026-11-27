import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Bills of materials and production.
//
// A production consumes components and makes a finished item (see
// reports/stock.ts for how both move stock). Its cost is fixed when it is
// recorded: each component at its cost on that day, plus overhead absorbed —
// labour and factory costs, which AS 2 includes in the cost of finished goods.
// Nothing is posted: purchases and overheads were expensed as they came, and
// closing stock, worked out from documents, now carries the finished goods at
// that cost instead of the components.
// ─────────────────────────────────────────────────────────────────────────────

import type { Executor, Trx } from '../db';
import type { Paise } from '../../types';
import { checkGodown } from './godowns';
import { toPaiseFromSql, toSqlFromPaise } from '../money-sql';
import { badRequest, conflict, notFound } from '../http';
import { allocateOrgNumber } from '../ledger/posting';
import { stockPosition } from '../reports/stock';
import { fyLabelFor } from './sales';
import { checkStock } from './guards';

export interface BomInput { itemId: number; name: string; outputQty: number; lines: { itemId: number; qty: number }[]; isActive?: boolean; notes?: string | null }

async function stockItems(ex: Executor, orgId: number, ids: number[]) {
  const rows = await ex.selectFrom('items').select(['id', 'name', 'kind', 'track_inventory']).where('org_id', '=', orgId).where('id', 'in', ids).execute();
  for (const id of ids) {
    const it = rows.find((r) => r.id === id);
    if (!it) throw notFound('One of the items does not exist.');
    if (it.kind !== 'goods' || !it.track_inventory) throw badRequest(`${it.name} is not a stocked item.`);
  }
  return rows;
}

export async function saveBom(trx: Trx, orgId: number, input: BomInput, id?: number): Promise<number> {
  if (!(input.outputQty > 0)) throw badRequest('A bill of materials makes more than zero.');
  const lines = input.lines.filter((l) => l.qty > 0);
  if (!lines.length) throw badRequest('List the components that go into it.');
  if (lines.some((l) => l.itemId === input.itemId)) throw badRequest('An item cannot be a component of itself.');
  await stockItems(trx, orgId, [input.itemId, ...lines.map((l) => l.itemId)]);
  const values = { item_id: input.itemId, name: input.name.trim() || 'Standard', output_qty: String(input.outputQty), is_active: input.isActive === false ? 0 : 1, notes: input.notes ?? null };
  if (id) {
    const found = await trx.selectFrom('boms').select('id').where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
    if (!found) throw notFound('That bill of materials does not exist.');
    await trx.updateTable('boms').set(values).where('id', '=', id).execute();
    await trx.deleteFrom('bom_lines').where('bom_id', '=', id).execute();
  } else {
    id = Number((await trx.insertInto('boms').values({ org_id: orgId, ...values }).executeTakeFirstOrThrow()).insertId);
  }
  await trx.insertInto('bom_lines').values(lines.map((l) => ({ bom_id: id!, item_id: l.itemId, qty: String(l.qty) }))).execute();
  return id;
}

export async function listBoms(ex: Executor, orgId: number) {
  const boms = await ex.selectFrom('boms as b').innerJoin('items as i', 'i.id', 'b.item_id')
    .select(['b.id', 'b.item_id', 'i.name as item_name', 'b.name', 'b.output_qty', 'b.is_active', 'b.notes'])
    .where('b.org_id', '=', orgId).orderBy('i.name').execute();
  const lines = boms.length
    ? await ex.selectFrom('bom_lines as l').innerJoin('items as i', 'i.id', 'l.item_id')
      .select(['l.bom_id', 'l.item_id', 'i.name', 'i.uqc', 'l.qty']).where('l.bom_id', 'in', boms.map((b) => b.id)).execute()
    : [];
  return boms.map((b) => ({
    id: String(b.id), itemId: String(b.item_id), itemName: b.item_name, name: b.name, outputQty: Number(b.output_qty),
    isActive: !!b.is_active, notes: b.notes,
    lines: lines.filter((l) => l.bom_id === b.id).map((l) => ({ itemId: String(l.item_id), name: l.name, uqc: l.uqc, qty: Number(l.qty) })),
  }));
}

export interface ProductionInput {
  bomId: number;
  qty: number;
  date: string;
  branchId: number;
  /** The godown the goods leave or enter; none is the branch's main one. */
  warehouseId?: number | null;
  overheadPaise?: Paise;
  notes?: string | null;
}

/**
 * Make `qty` of a BOM's item: components consumed in proportion, cost fixed now.
 *
 * `replace` is Edit (services/stock-changes.ts): the run is written again over
 * its own row under its own number, costed afresh on its (new) date. The caller
 * has already taken the old version out of stock. A run keeps the bill of
 * materials it was made from even if that has since been marked not in use.
 */
export async function recordProduction(
  trx: Trx, orgId: number, userId: number | null, input: ProductionInput,
  opts: { replace?: { id: number; number: string; bomId: number | null } } = {},
) {
  if (!(input.qty > 0)) throw badRequest('Make more than zero.');
  const bom = (await listBoms(trx, orgId)).find((b) => b.id === String(input.bomId));
  if (!bom) throw notFound('That bill of materials does not exist.');
  if (!bom.isActive && opts.replace?.bomId !== input.bomId) throw conflict(`${bom.name} for ${bom.itemName} is no longer in use.`);
  const factor = input.qty / bom.outputQty;
  const needs = bom.lines.map((l) => ({ itemId: Number(l.itemId), name: l.name, qty: Math.round(l.qty * factor * 10_000) / 10_000 }));

  // Components that are not there cannot be used: the book's negative-stock rule decides how firmly.
  const warnings: string[] = [];
  await checkStock(trx, orgId, input.branchId, input.date, needs, warnings);

  const position = await stockPosition(trx, orgId, input.date, { branchId: input.branchId, includeArchived: true });
  const costed = needs.map((n) => {
    const unit = position.lines.find((l) => l.itemId === String(n.itemId))?.unitCostPaise ?? 0;
    return { ...n, cost: Math.round(unit * n.qty) };
  });
  const componentsCost = costed.reduce((t, c) => t + c.cost, 0);
  const overhead = input.overheadPaise ?? 0;
  if (overhead < 0) throw badRequest('Overhead cannot be negative.');
  const values = {
    bom_id: input.bomId, item_id: Number(bom.itemId), branch_id: input.branchId, qty: String(input.qty),
    produced_on: input.date, components_cost: toSqlFromPaise(componentsCost), overhead: toSqlFromPaise(overhead),
    cost: toSqlFromPaise(componentsCost + overhead), notes: input.notes ?? null,
    warehouse_id: await checkGodown(trx, orgId, input.branchId, input.warehouseId),
  };
  let id: number;
  let number: string;
  if (opts.replace) {
    ({ id, number } = opts.replace);
    await trx.updateTable('productions').set({ ...values, status: 'done' }).where('id', '=', id).where('org_id', '=', orgId).execute();
  } else {
    number = await allocateOrgNumber(trx, orgId, 'MFG', fyLabelFor(input.date), 'MFG');
    id = Number((await trx.insertInto('productions').values({ org_id: orgId, number, created_by_user_id: userId, ...values }).executeTakeFirstOrThrow()).insertId);
  }
  await trx.insertInto('production_lines').values(costed.map((c) => ({
    production_id: id, item_id: c.itemId, qty: String(c.qty), cost: toSqlFromPaise(c.cost),
  }))).execute();
  return { id, number, costPaise: componentsCost + overhead, unitCostPaise: Math.round((componentsCost + overhead) / input.qty), warnings };
}

export async function voidProduction(trx: Trx, orgId: number, id: number) {
  const p = await trx.selectFrom('productions').select(['number', 'status']).where('id', '=', id).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!p) throw notFound('That production does not exist.');
  if (p.status === 'void') throw conflict(`${p.number} is already void.`);
  await trx.updateTable('productions').set({ status: 'void' }).where('id', '=', id).execute();
}

export async function listProductions(ex: Executor, orgId: number) {
  const rows = await ex.selectFrom('productions as p').innerJoin('items as i', 'i.id', 'p.item_id').innerJoin('branches as b', 'b.id', 'p.branch_id')
    .select(['p.id', 'p.number', 'p.produced_on', 'i.name as item_name', 'i.uqc', 'p.qty', 'p.components_cost', 'p.overhead', 'p.cost', 'p.status', 'b.name as branch_name', 'p.notes',
      'p.bom_id', 'p.branch_id', 'p.warehouse_id'])
    .where('p.org_id', '=', orgId).orderBy('p.produced_on', 'desc').orderBy('p.id', 'desc').limit(300).execute();
  return rows.map((r) => ({
    id: String(r.id), number: r.number, date: String(r.produced_on).slice(0, 10), itemName: r.item_name, uqc: r.uqc, qty: Number(r.qty),
    componentsCostPaise: toPaiseFromSql(r.components_cost), overheadPaise: toPaiseFromSql(r.overhead), costPaise: toPaiseFromSql(r.cost),
    unitCostPaise: Math.round(toPaiseFromSql(r.cost) / Number(r.qty)), status: r.status, branch: r.branch_name, notes: r.notes,
    // For its Edit window.
    bomId: r.bom_id ? String(r.bom_id) : null, branchId: String(r.branch_id), warehouseId: r.warehouse_id ? String(r.warehouse_id) : null,
  }));
}
