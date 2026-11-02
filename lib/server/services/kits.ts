import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Kits: an item sold as a set of other items (migration 091) — a service kit of
// four brake pads and a bottle of fluid, priced and invoiced as one line.
//
// The kit holds no stock of its own. Selling one takes each component out of
// stock (reports/stock.ts reads the components through the kit), returning one
// puts them back, the stock check counts the components, and on a perpetual
// book the cost of sales is the components' cost. Making kits into stock ahead
// of a sale is what Production (bills of materials) is for.
// ─────────────────────────────────────────────────────────────────────────────

import type { Executor, Trx } from '../db';
import { badRequest } from '../http';

export interface Component { itemId: number; qty: number }

export async function kitComponents(ex: Executor, orgId: number, kitItemId: number) {
  const rows = await ex.selectFrom('item_components as c').innerJoin('items as i', 'i.id', 'c.component_item_id')
    .select(['c.component_item_id', 'c.qty', 'i.name', 'i.uqc']).where('c.org_id', '=', orgId).where('c.kit_item_id', '=', kitItemId).orderBy('i.name').execute();
  return rows.map((r) => ({ itemId: String(r.component_item_id), name: r.name, uqc: r.uqc, qty: Number(r.qty) }));
}

/** Make an item a kit of these components, or (with none) an ordinary item again. */
export async function saveKit(trx: Trx, orgId: number, kitItemId: number, components: Component[]) {
  const kit = await trx.selectFrom('items').select(['id', 'kind']).where('id', '=', kitItemId).where('org_id', '=', orgId).executeTakeFirst();
  if (!kit) throw badRequest('That item does not exist.');
  if (!components.length) {
    await trx.deleteFrom('item_components').where('kit_item_id', '=', kitItemId).execute();
    await trx.updateTable('items').set({ is_kit: 0 }).where('id', '=', kitItemId).execute();
    return;
  }
  if (kit.kind !== 'goods') throw badRequest('Only goods can be a kit.');
  const ids = [...new Set(components.map((c) => c.itemId))];
  if (ids.includes(kitItemId)) throw badRequest('A kit cannot contain itself.');
  if (ids.length !== components.length) throw badRequest('Each component once, with its quantity.');
  const parts = await trx.selectFrom('items').select(['id', 'name', 'kind', 'is_kit', 'track_inventory']).where('org_id', '=', orgId).where('id', 'in', ids).execute();
  for (const c of components) {
    const p = parts.find((x) => x.id === c.itemId);
    if (!p) throw badRequest('A component does not exist.');
    if (p.is_kit) throw badRequest(`${p.name} is a kit itself; a kit is made of ordinary items.`);
    if (p.kind !== 'goods' || !p.track_inventory) throw badRequest(`${p.name} is not kept in stock, so it cannot be a component.`);
    if (!(c.qty > 0)) throw badRequest(`Give a quantity for ${p.name}.`);
  }
  // Checked first, replaced second: a refused change leaves the kit as it was.
  await trx.deleteFrom('item_components').where('kit_item_id', '=', kitItemId).execute();
  await trx.insertInto('item_components').values(components.map((c) => ({ org_id: orgId, kit_item_id: kitItemId, component_item_id: c.itemId, qty: String(c.qty) }))).execute();
  // The kit holds no stock of its own; its components do.
  await trx.updateTable('items').set({ is_kit: 1, track_inventory: 0, track_batches: 0, track_serials: 0 }).where('id', '=', kitItemId).execute();
}

/** Lines with each kit replaced by its components, quantities multiplied out. */
export async function explodeKits(ex: Executor, orgId: number, lines: { itemId?: number | null; qty: number }[]): Promise<{ itemId: number | null; qty: number }[]> {
  const ids = [...new Set(lines.map((l) => l.itemId).filter((x): x is number => !!x))];
  if (!ids.length) return lines.map((l) => ({ itemId: l.itemId ?? null, qty: l.qty }));
  const comps = await ex.selectFrom('item_components').select(['kit_item_id', 'component_item_id', 'qty']).where('org_id', '=', orgId).where('kit_item_id', 'in', ids).execute();
  if (!comps.length) return lines.map((l) => ({ itemId: l.itemId ?? null, qty: l.qty }));
  return lines.flatMap((l) => {
    const mine = comps.filter((c) => c.kit_item_id === l.itemId);
    return mine.length ? mine.map((c) => ({ itemId: c.component_item_id, qty: l.qty * Number(c.qty) })) : [{ itemId: l.itemId ?? null, qty: l.qty }];
  });
}
