import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Item groups: one product in variants — a riding jacket in three sizes and
// two colours (migration 091). Each variant is an item of its own, with its
// own stock, SKU and price, so everything else in the app (invoices, stock,
// GST) treats it like any item; the group ties them together and names them.
//
// Variants are made for every combination of the attributes' values, up to a
// hundred, all with the group's HSN, unit, GST rate and prices to start from.
// ─────────────────────────────────────────────────────────────────────────────

import type { Executor, Trx } from '../db';
import type { Paise } from '../../types';
import { toSqlFromPaise } from '../money-sql';
import { badRequest, conflict } from '../http';

export interface Attribute { name: string; values: string[] }
export interface ItemGroupInput {
  name: string;
  attributes: Attribute[];
  hsnSac?: string | null;
  uqc?: string;
  gstRatePct?: number;
  salePricePaise?: Paise;
  purchasePricePaise?: Paise;
  trackInventory?: boolean;
  skuPrefix?: string | null;
}

/** Every combination: [{Size: 'S', Colour: 'Red'}, {Size: 'S', Colour: 'Black'}, …]. */
export function combinations(attributes: Attribute[]): Record<string, string>[] {
  return attributes.reduce<Record<string, string>[]>(
    (acc, a) => acc.flatMap((c) => a.values.map((v) => ({ ...c, [a.name]: v }))),
    [{}],
  );
}

export async function createItemGroup(trx: Trx, orgId: number, input: ItemGroupInput) {
  const name = input.name.trim();
  if (!name) throw badRequest('Name the item group.');
  const attributes = input.attributes
    .map((a) => ({ name: a.name.trim(), values: [...new Set(a.values.map((v) => v.trim()).filter(Boolean))] }))
    .filter((a) => a.name && a.values.length);
  if (!attributes.length) throw badRequest('Give at least one attribute, such as Size, with its values.');
  if (new Set(attributes.map((a) => a.name.toLowerCase())).size !== attributes.length) throw badRequest('Each attribute once.');
  const combos = combinations(attributes);
  if (combos.length > 100) throw badRequest(`That makes ${combos.length} variants; a group holds at most 100.`);
  const clash = await trx.selectFrom('item_groups').select('id').where('org_id', '=', orgId).where('name', '=', name).executeTakeFirst();
  if (clash) throw conflict(`There is already an item group called ${name}.`);
  const groupId = Number((await trx.insertInto('item_groups').values({ org_id: orgId, name, attributes: JSON.stringify(attributes) }).executeTakeFirstOrThrow()).insertId);

  const prefix = (input.skuPrefix?.trim() || name.replace(/[^A-Za-z0-9]+/g, '').slice(0, 8)).toUpperCase();
  const ids: number[] = [];
  for (const c of combos) {
    const label = Object.values(c).join(' / ');
    const sku = `${prefix}-${Object.values(c).map((v) => v.replace(/[^A-Za-z0-9]+/g, '').toUpperCase().slice(0, 6)).join('-')}`.slice(0, 60);
    const r = await trx.insertInto('items').values({
      org_id: orgId, kind: 'goods', name: `${name} — ${label}`.slice(0, 200), sku, hsn_sac: input.hsnSac || null,
      uqc: input.uqc || 'NOS', gst_rate_pct: String(input.gstRatePct ?? 18),
      sale_price: toSqlFromPaise(input.salePricePaise ?? 0), purchase_price: toSqlFromPaise(input.purchasePricePaise ?? 0),
      track_inventory: input.trackInventory === false ? 0 : 1, item_group_id: groupId, variant: JSON.stringify(c),
    }).executeTakeFirstOrThrow();
    ids.push(Number(r.insertId));
  }
  return { groupId, itemIds: ids };
}

export async function listItemGroups(ex: Executor, orgId: number) {
  const [groups, items] = await Promise.all([
    ex.selectFrom('item_groups').selectAll().where('org_id', '=', orgId).orderBy('name').execute(),
    ex.selectFrom('items').select(['id', 'name', 'sku', 'item_group_id', 'variant', 'sale_price', 'is_archived']).where('org_id', '=', orgId).where('item_group_id', 'is not', null).execute(),
  ]);
  const parse = <T>(v: unknown): T => (typeof v === 'string' ? JSON.parse(v) : v) as T;
  return groups.map((g) => ({
    id: String(g.id), name: g.name, attributes: parse<Attribute[]>(g.attributes),
    variants: items.filter((i) => i.item_group_id === g.id).map((i) => ({ id: String(i.id), name: i.name, sku: i.sku, variant: parse<Record<string, string>>(i.variant), archived: !!i.is_archived })),
  }));
}
