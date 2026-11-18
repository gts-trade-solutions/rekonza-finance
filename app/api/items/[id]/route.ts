import { sql } from 'kysely';
import { db, transaction } from '@/lib/server/db';
import { route, idParam, asId, notFound, conflict } from '@/lib/server/http';
import { canSeeCosts } from '@/lib/rbac';
import { toPaiseFromSql } from '@/lib/server/money-sql';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { selectItems, shapeItems } from '@/lib/server/services/item-read';
import { itemUses } from '@/lib/server/services/item-activity';
import { stockPosition } from '@/lib/server/reports/stock';
import { indiaToday } from '@/lib/server/services/held-journals';

/**
 * One item, as Zoho's item page shows it: the master, and for goods kept in
 * stock, what is on hand, promised on open sales orders, and free to sell.
 *
 * What the goods cost (the purchase price, the standard cost, the opening
 * rate and the stock's value) is left out for a role that may not see costs.
 */
export const GET = route(
  async ({ orgId, role, params }) => {
    const id = idParam(params);
    const row = await selectItems(orgId).where('id', '=', id).executeTakeFirst();
    if (!row) throw notFound('That item does not exist.');
    const [item] = await shapeItems(orgId, [row]);
    const seesCosts = canSeeCosts(role);
    if (!seesCosts) {
      item.purchasePricePaise = 0;
      item.standardCostPaise = null;
      item.openingStockRatePaise = null;
      item.marginPaise = 0;
    }

    const accountIds = [item.saleAccountId, item.purchaseAccountId].filter((x): x is string => !!x).map(Number);
    const [group, components, accounts, vendor, priceLists, tags] = await Promise.all([
      item.stockGroupId
        ? db.selectFrom('stock_groups').select('name').where('id', '=', Number(item.stockGroupId)).where('org_id', '=', orgId).executeTakeFirst()
        : undefined,
      item.kitComponents.length
        ? db.selectFrom('items').select(['id', 'name', 'uqc']).where('org_id', '=', orgId)
            .where('id', 'in', item.kitComponents.map((c) => Number(c.itemId))).execute()
        : [],
      accountIds.length
        ? db.selectFrom('accounts').select(['id', 'code', 'name']).where('org_id', '=', orgId).where('id', 'in', accountIds).execute()
        : [],
      item.preferredVendorId
        ? db.selectFrom('contacts').select(['id', 'display_name']).where('id', '=', Number(item.preferredVendorId)).where('org_id', '=', orgId).executeTakeFirst()
        : undefined,
      // Zoho's "Associated Price Lists": the lists that name this item, at its rate on each.
      db.selectFrom('price_list_items as pi').innerJoin('price_lists as pl', 'pl.id', 'pi.price_list_id')
        .select(['pl.id', 'pl.name', 'pl.is_active', 'pi.rate'])
        .where('pl.org_id', '=', orgId).where('pi.item_id', '=', id).orderBy('pl.name').execute(),
      db.selectFrom('reporting_tag_links as l')
        .innerJoin('reporting_tags as t', 't.id', 'l.tag_id')
        .innerJoin('reporting_tag_options as o', 'o.id', 'l.option_id')
        .select(['t.id as tagId', 't.name as tag', 'o.value as option'])
        .where('l.org_id', '=', orgId).where('l.entity', '=', 'item').where('l.entity_id', '=', id)
        .orderBy('t.name').execute(),
    ]);
    const acct = (accId: string | null) => {
      const a = accId ? accounts.find((x) => asId(x.id) === accId) : undefined;
      return a ? { id: asId(a.id), code: a.code, name: a.name } : null;
    };

    let stock: { onHand: number; valuePaise: number | null; committed: number; available: number } | null = null;
    if (item.kind === 'goods' && item.trackInventory && !item.isKit) {
      const today = indiaToday();
      const [pos, promised] = await Promise.all([
        stockPosition(db, orgId, today, { includeArchived: true }),
        // Promised on open sales orders and not yet invoiced or delivered.
        sql<{ n: string | null }>`
          SELECT SUM(l.qty - GREATEST(l.qty_invoiced, l.qty_delivered)) AS n
            FROM sales_order_lines l JOIN sales_orders o ON o.id = l.sales_order_id
           WHERE o.org_id = ${orgId} AND l.item_id = ${id}
             AND o.status NOT IN ('cancelled', 'closed', 'invoiced') AND o.order_date <= ${today}
             AND l.qty > GREATEST(l.qty_invoiced, l.qty_delivered)`.execute(db),
      ]);
      const line = pos.lines.find((l) => l.itemId === asId(id));
      const onHand = line?.qty ?? 0;
      const committed = Number(promised.rows[0]?.n ?? 0);
      stock = { onHand, valuePaise: seesCosts ? line?.valuePaise ?? 0 : null, committed, available: onHand - committed };
    }

    return {
      item,
      stock,
      stockGroupName: group?.name ?? null,
      saleAccount: acct(item.saleAccountId),
      // What a role that may not see costs is not shown: where the cost goes.
      purchaseAccount: seesCosts ? acct(item.purchaseAccountId) : null,
      preferredVendor: vendor ? { id: asId(vendor.id), name: vendor.display_name } : null,
      priceLists: priceLists.map((p) => ({ id: asId(p.id), name: p.name, ratePaise: toPaiseFromSql(p.rate), isActive: !!p.is_active })),
      tags: tags.map((t) => ({ tagId: asId(t.tagId), tag: t.tag, option: t.option })),
      components: item.kitComponents.map((c) => {
        const it = components.find((x) => asId(x.id) === c.itemId);
        return { itemId: c.itemId, name: it?.name ?? 'Item', uqc: it?.uqc ?? '', qty: c.qty };
      }),
    };
  },
  { permission: { module: 'sales', action: 'view' } },
);

/**
 * Delete an item that was never used, as Zoho's "Delete" does. One that is on
 * any document, stock record, price list or recurring profile stays: deleting
 * it would leave those pointing at nothing, so it is marked inactive instead.
 * Opening stock counts as use, because it is part of the closing stock.
 */
export const DELETE = route(
  async ({ orgId, user, params, req }) => {
    const id = idParam(params);
    const existing = await db.selectFrom('items').select(['id', 'name', 'kind', 'opening_stock_qty'])
      .where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
    if (!existing) throw notFound('That item does not exist.');

    const uses = await itemUses(db, orgId, id);
    if (Number(existing.opening_stock_qty ?? 0) > 0) uses.push('opening stock');
    if (uses.length) {
      throw conflict(`"${existing.name}" is still in use (${uses.join(', ')}), so it cannot be deleted. Mark it as inactive instead: it stays on those records and leaves the pickers.`);
    }

    await transaction(async (trx) => {
      // A kit's own list of components goes with it.
      await trx.deleteFrom('item_components').where('kit_item_id', '=', id).execute();
      await trx.deleteFrom('items').where('id', '=', id).where('org_id', '=', orgId).execute();
      await logAudit({
        orgId, actorUserId: user.userId, actorName: user.name, action: 'void',
        targetType: 'item', targetId: id, targetLabel: existing.name,
        detail: `Deleted unused ${existing.kind} "${existing.name}"`, trx, ...auditMeta(req),
      });
    });
    return { id: asId(id) };
  },
  { permission: { module: 'sales', action: 'void' } },
);
