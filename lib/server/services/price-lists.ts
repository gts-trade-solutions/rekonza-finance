import 'server-only';

// Price lists: what a customer is charged when it is not the item's own price.
// A percentage list moves every item's price by the same share; a per-item
// list names rates, and leaves the items it does not name at their own price.
// Either can carry discount rules: from a quantity up, a percentage off, for
// one item or every item. The best rule a line qualifies for is the one used.

import type { Executor, Trx } from '../db';
import type { Paise } from '../../types';
import { toPaiseFromSql, toSqlFromPaise } from '../money-sql';
import { badRequest, conflict, notFound } from '../http';

export interface PriceListInput {
  name: string;
  basis: 'percent' | 'per_item';
  percent?: number;
  items?: { itemId: number; ratePaise: Paise }[];
  discounts?: DiscountRule[];
  isActive?: boolean;
}

export interface DiscountRule { itemId: number | null; minQty: number; discountPct: number }

function check(i: PriceListInput) {
  if (!i.name.trim()) throw badRequest('Give the price list a name.');
  if (i.basis === 'percent' && !(Number.isFinite(i.percent) && (i.percent ?? 0) > -100 && (i.percent ?? 0) <= 500)) {
    throw badRequest('A percentage list moves prices by more than -100% and at most 500%.');
  }
  for (const it of i.items ?? []) if (!(it.ratePaise >= 0)) throw badRequest('A rate cannot be negative.');
  for (const d of i.discounts ?? []) {
    if (!(d.discountPct > 0 && d.discountPct <= 100)) throw badRequest('A discount is more than 0% and at most 100%.');
    if (!(d.minQty >= 0)) throw badRequest('A discount starts from a quantity of nothing or more.');
  }
}

export async function savePriceList(trx: Trx, orgId: number, input: PriceListInput, id?: number): Promise<number> {
  check(input);
  const dup = await trx.selectFrom('price_lists').select('id').where('org_id', '=', orgId).where('name', '=', input.name.trim())
    .$if(!!id, (q) => q.where('id', '<>', id!)).executeTakeFirst();
  if (dup) throw conflict(`There is already a price list called ${input.name}.`);
  const values = { name: input.name.trim(), basis: input.basis, percent: String(input.basis === 'percent' ? input.percent ?? 0 : 0), is_active: input.isActive === false ? 0 : 1 };
  if (id) {
    const found = await trx.selectFrom('price_lists').select('id').where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
    if (!found) throw notFound('That price list does not exist.');
    await trx.updateTable('price_lists').set(values).where('id', '=', id).execute();
  } else {
    id = Number((await trx.insertInto('price_lists').values({ org_id: orgId, ...values }).executeTakeFirstOrThrow()).insertId);
  }
  await trx.deleteFrom('price_list_items').where('price_list_id', '=', id).execute();
  const rows = input.basis === 'per_item' ? input.items ?? [] : [];
  if (rows.length) {
    const ok = await trx.selectFrom('items').select('id').where('org_id', '=', orgId).where('id', 'in', rows.map((r) => r.itemId)).execute();
    if (ok.length !== new Set(rows.map((r) => r.itemId)).size) throw notFound('One of the items does not exist.');
    await trx.insertInto('price_list_items').values(rows.map((r) => ({ price_list_id: id!, item_id: r.itemId, rate: toSqlFromPaise(r.ratePaise) }))).execute();
  }
  await trx.deleteFrom('price_list_discounts').where('price_list_id', '=', id).execute();
  const rules = input.discounts ?? [];
  if (rules.length) {
    const named = [...new Set(rules.map((r) => r.itemId).filter((x): x is number => !!x))];
    if (named.length) {
      const ok = await trx.selectFrom('items').select('id').where('org_id', '=', orgId).where('id', 'in', named).execute();
      if (ok.length !== named.length) throw notFound('One of the items does not exist.');
    }
    await trx.insertInto('price_list_discounts').values(rules.map((r) => ({
      price_list_id: id!, item_id: r.itemId, min_qty: String(r.minQty), discount_pct: String(r.discountPct),
    }))).execute();
  }
  return id;
}

/** A contact's discount rules, from their price list; null when they have none. */
export async function discountsFor(ex: Executor, orgId: number, contactId: number): Promise<DiscountRule[] | null> {
  const rows = await ex.selectFrom('contacts as c').innerJoin('price_lists as l', 'l.id', 'c.price_list_id')
    .innerJoin('price_list_discounts as d', 'd.price_list_id', 'l.id')
    .select(['d.item_id', 'd.min_qty', 'd.discount_pct'])
    .where('c.id', '=', contactId).where('c.org_id', '=', orgId).where('l.is_active', '=', 1).execute();
  return rows.length ? rows.map((r) => ({ itemId: r.item_id, minQty: Number(r.min_qty), discountPct: Number(r.discount_pct) })) : null;
}

/** The best discount a quantity of an item earns under the rules: an item's own rules and the list-wide ones alike. */
export function bestDiscount(rules: DiscountRule[], itemId: number, qty: number): number {
  return rules
    .filter((r) => (r.itemId === null || r.itemId === itemId) && qty >= r.minQty)
    .reduce((best, r) => Math.max(best, r.discountPct), 0);
}

export async function listPriceLists(ex: Executor, orgId: number) {
  const lists = await ex.selectFrom('price_lists').selectAll().where('org_id', '=', orgId).orderBy('name').execute();
  const discounts = lists.length
    ? await ex.selectFrom('price_list_discounts').select(['price_list_id', 'item_id', 'min_qty', 'discount_pct']).where('price_list_id', 'in', lists.map((l) => l.id)).orderBy('min_qty').execute()
    : [];
  const items = lists.length
    ? await ex.selectFrom('price_list_items').select(['price_list_id', 'item_id', 'rate']).where('price_list_id', 'in', lists.map((l) => l.id)).execute()
    : [];
  const customers = lists.length
    ? await ex.selectFrom('contacts').select(['price_list_id', ex.fn.countAll<number>().as('n')])
      .where('org_id', '=', orgId).where('price_list_id', 'in', lists.map((l) => l.id)).groupBy('price_list_id').execute()
    : [];
  return lists.map((l) => ({
    id: String(l.id), name: l.name, basis: l.basis, percent: Number(l.percent), isActive: !!l.is_active,
    customers: Number(customers.find((c) => c.price_list_id === l.id)?.n ?? 0),
    items: items.filter((i) => i.price_list_id === l.id).map((i) => ({ itemId: String(i.item_id), ratePaise: toPaiseFromSql(i.rate) })),
    discounts: discounts.filter((d) => d.price_list_id === l.id)
      .map((d) => ({ itemId: d.item_id === null ? null : String(d.item_id), minQty: Number(d.min_qty), discountPct: Number(d.discount_pct) })),
  }));
}

/** Every item's price for a contact: their list's, or the item's own. */
export async function pricesFor(ex: Executor, orgId: number, contactId: number): Promise<Map<number, Paise> | null> {
  const c = await ex.selectFrom('contacts as c').innerJoin('price_lists as l', 'l.id', 'c.price_list_id')
    .select(['l.id', 'l.basis', 'l.percent', 'l.is_active']).where('c.id', '=', contactId).where('c.org_id', '=', orgId).executeTakeFirst();
  if (!c || !c.is_active) return null;
  const items = await ex.selectFrom('items').select(['id', 'sale_price']).where('org_id', '=', orgId).execute();
  const out = new Map<number, Paise>();
  if (c.basis === 'percent') {
    const pct = Number(c.percent);
    for (const it of items) out.set(it.id, Math.round(toPaiseFromSql(it.sale_price) * (1 + pct / 100)));
  } else {
    const named = await ex.selectFrom('price_list_items').select(['item_id', 'rate']).where('price_list_id', '=', c.id).execute();
    for (const it of items) out.set(it.id, toPaiseFromSql(it.sale_price));
    for (const n of named) out.set(n.item_id, toPaiseFromSql(n.rate));
  }
  return out;
}
