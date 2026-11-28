import { z } from 'zod';
import { sql } from 'kysely';
import { CODE } from '@/lib/server/ledger/chart-of-accounts';
import { createAdjustment } from '@/lib/server/services/stock-changes';
import { AdjustInput, toAdjustment } from '@/lib/server/adjustment-input';
import { db, transaction } from '@/lib/server/db';
import { route, body, query, asId } from '@/lib/server/http';
import { toPaiseFromSql } from '@/lib/server/money-sql';
import { stockByGodown, stockPosition } from '@/lib/server/reports/stock';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { adjustmentValuesNow } from '@/lib/server/services/stock-ledger';

// ─────────────────────────────────────────────────────────────────────────────
// Stock.
//
// Quantity on hand is derived, never stored: opening, plus what the bills
// brought in and credit notes took back, less what the invoices sent out, plus
// or minus adjustments. The documents are the record. A stored running quantity
// could only be a second copy to fall out of step with them, and a stock figure
// that disagrees with the purchase and sales history is worse than no figure.
//
// Valuation is weighted average cost per financial year, the same figure the
// balance sheet carries as closing stock (lib/server/reports/stock.ts). This
// screen and the statements read one calculation, so they cannot disagree.
// ─────────────────────────────────────────────────────────────────────────────

/** Today on the server's clock, built from local parts: toISOString() is UTC. */
const localToday = (): string => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const Q = z.object({
  view: z.enum(['stock', 'adjustments', 'warehouses', 'godowns']).default('stock'),
  itemId: z.string().optional(),
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export const GET = route(
  async ({ orgId, req }) => {
    const q = query(req, Q);

    if (q.view === 'godowns') return { view: q.view, ...(await stockByGodown(db, orgId, q.asOf ?? localToday())) };

    if (q.view === 'warehouses') {
      const rows = await db
        .selectFrom('warehouses as w')
        .leftJoin('branches as b', 'b.id', 'w.branch_id')
        .select([
          'w.id', 'w.name', 'w.code', 'w.address', 'w.is_primary', 'w.is_active',
          'w.branch_id', 'b.name as branch_name',
        ])
        .where('w.org_id', '=', orgId)
        .orderBy('w.is_primary', 'desc')
        .orderBy('w.name')
        .execute();

      return {
        view: q.view,
        warehouses: rows.map((w) => ({
          id: asId(w.id),
          name: w.name,
          code: w.code,
          address: w.address,
          branchId: w.branch_id === null ? null : asId(w.branch_id),
          branchName: w.branch_name,
          isPrimary: !!w.is_primary,
          isActive: !!w.is_active,
        })),
      };
    }

    if (q.view === 'adjustments') {
      const rows = await db
        .selectFrom('stock_adjustments as a')
        .innerJoin('items as i', 'i.id', 'a.item_id')
        .leftJoin('warehouses as w', 'w.id', 'a.warehouse_id')
        .leftJoin('users as u', 'u.id', 'a.created_by_user_id')
        .select([
          'a.id', 'a.adjust_date', 'a.qty_delta', 'a.reason', 'a.notes',
          'a.journal_entry_id', 'a.item_id',
          'i.name as item_name', 'i.sku', 'i.uqc', 'i.purchase_price',
          'w.name as warehouse_name', 'u.name as user_name', 'a.value',
          // What the adjustment moved in the Inventory account, when it posted (a perpetual book posts on the day).
          sql<string | null>`(SELECT SUM(jl.debit - jl.credit) FROM journal_lines jl JOIN accounts ac ON ac.id = jl.account_id
            WHERE jl.entry_id = a.journal_entry_id AND ac.code = ${CODE.INVENTORY})`.as('posted_value'),
        ])
        .where('a.org_id', '=', orgId)
        .$if(!!q.itemId, (qb) => qb.where('a.item_id', '=', Number(q.itemId)))
        .orderBy('a.adjust_date', 'desc')
        .orderBy('a.id', 'desc')
        .limit(300)
        .execute();

      // An adjustment from before its value was kept (migration 137), and not posted: worked out
      // from the stock as it stands on its date, as the valuation does — never the catalogue price.
      const legacy = rows.filter((a) => a.value === null && (a.posted_value === null || a.posted_value === undefined));
      const legacyValue = await adjustmentValuesNow(db, orgId,
        legacy.map((a) => ({ id: Number(a.id), itemId: Number(a.item_id), date: String(a.adjust_date).slice(0, 10), qtyDelta: Number(a.qty_delta) })));
      return {
        view: q.view,
        adjustments: rows.map((a) => ({
          id: asId(a.id),
          date: String(a.adjust_date).slice(0, 10),
          itemId: asId(a.item_id),
          itemName: a.item_name,
          sku: a.sku,
          uqc: a.uqc,
          qtyDelta: Number(a.qty_delta),
          reason: a.reason,
          notes: a.notes,
          warehouseName: a.warehouse_name,
          userName: a.user_name,
          // What left stock (or came back), at the FIFO or average cost on its date: kept with the
          // adjustment on either method (on a perpetual book it is the figure posted to Inventory).
          valuePaise: a.value !== null ? toPaiseFromSql(a.value)
            : a.posted_value !== null && a.posted_value !== undefined ? toPaiseFromSql(a.posted_value)
            : legacyValue.get(Number(a.id)) ?? Math.round(Number(a.qty_delta) * toPaiseFromSql(a.purchase_price)),
          valuePosted: a.posted_value !== null && a.posted_value !== undefined,
          journalEntryId: a.journal_entry_id === null ? null : asId(a.journal_entry_id),
        })),
      };
    }

    // Stock on hand, item by item, from the documents.
    const asOf = q.asOf ?? localToday();
    const position = await stockPosition(db, orgId, asOf);
    const masters = await db
      .selectFrom('items').select(['id', 'reorder_level', 'min_level', 'standard_cost', 'alt_uqc', 'alt_factor'])
      .where('org_id', '=', orgId).where('kind', '=', 'goods').execute();
    const masterBy = new Map(masters.map((r) => [String(r.id), r]));

    const items = position.lines.map((l) => {
      const m = masterBy.get(l.itemId);
      const standardCostPaise = m?.standard_cost == null ? null : toPaiseFromSql(m.standard_cost);
      return {
        itemId: l.itemId,
        name: l.name,
        sku: l.sku,
        uqc: l.uqc,
        openingQty: l.openingQty,
        boughtQty: l.inwardQty,
        soldQty: l.outwardQty,
        returnedQty: l.returnedQty,
        adjustedQty: l.adjustedQty,
        // Goods sent back to suppliers on vendor credits with item lines; and how the item is valued.
        sentBackQty: l.returnedToVendorQty ?? 0,
        qty: l.qty,
        reorderLevel: m?.reorder_level == null ? 0 : Number(m.reorder_level),
        minLevel: m?.min_level == null ? 0 : Number(m.min_level),
        altUqc: m?.alt_uqc ?? null,
        altFactor: m?.alt_factor == null ? null : Number(m.alt_factor),
        unitCostPaise: l.unitCostPaise,
        // Negative stock is not netted away. It means the documents disagree
        // with reality, and hiding it would hide the problem.
        valuePaise: l.valuePaise,
        // What it would be worth at its budgeted cost, and how far the actual
        // average has drifted from it.
        standardCostPaise,
        varianceValuePaise: standardCostPaise === null ? null : Math.round(l.qty * (l.unitCostPaise - standardCostPaise)),
        stockGroupId: l.stockGroupId,
        valuation: l.valuation,
      };
    });

    return {
      view: 'stock' as const,
      asOf,
      items,
      summary: {
        totalValuePaise: items.reduce((t, i) => t + i.valuePaise, 0),
        lowStock: items.filter((i) => i.qty > 0 && i.qty <= i.reorderLevel).length,
        belowMinimum: items.filter((i) => i.qty > 0 && i.minLevel > 0 && i.qty <= i.minLevel).length,
        outOfStock: items.filter((i) => i.qty <= 0).length,
        negative: items.filter((i) => i.qty < 0).length,
        tracked: items.length,
      },
    };
  },
  { permission: { module: 'inventory', action: 'view' } },
);

/**
 * Adjust stock.
 *
 * On a periodic book, quantity only, as in Tally: stock is valued from the
 * documents on the day a report is run, so damage, theft or a short count
 * reaches the profit and loss as a smaller closing stock, and posting the loss
 * as well would count it twice. On a perpetual book the adjustment posts its
 * value on its own date (services/stock-changes.ts postAdjustment), so the
 * Inventory account agrees with the valuation the same day.
 *
 * An adjustment with the reason 'opening' is opening stock, whatever its date:
 * it is an opening balance, and is carried in opening equity, not in profit.
 */
export const POST = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, AdjustInput);
    return transaction(async (trx) => {
      const made = await createAdjustment(trx, orgId, user.userId, toAdjustment(input));
      // What it took out of stock (or put back), at the stock valuation's own figure on its date —
      // the FIFO cost of the units that left, or the average — kept on the adjustment on either
      // method, so this reply, the adjustments list and the valuation all say the same.
      const row = await trx.selectFrom('stock_adjustments').select('journal_entry_id').where('id', '=', Number(made.id)).executeTakeFirst();
      const journalEntryId = row?.journal_entry_id ?? null;
      const valuePaise = Math.abs(made.valuePaise);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'create',
        targetType: 'stock_adjustment', targetId: made.id, targetLabel: made.itemName,
        detail: `${input.qtyDelta > 0 ? '+' : ''}${input.qtyDelta} ${made.itemName} (${input.reason}), ` +
          `value ${(valuePaise / 100).toFixed(2)}`,
        ...auditMeta(req),
      });
      return { id: asId(made.id), valuePaise, signedValuePaise: made.valuePaise, journalEntryId: journalEntryId ? asId(journalEntryId) : null, warnings: made.warnings };
    });
  },
  { permission: { module: 'inventory', action: 'edit' } },
);

const WarehouseInput = z.object({
  name: z.string().trim().min(1, 'A warehouse needs a name.').max(150),
  code: z.string().trim().max(20).nullish(),
  address: z.string().trim().max(500).nullish(),
  branchId: z.union([z.string(), z.number()]).nullish(),
});

export const PUT = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, WarehouseInput);

    const existing = await db
      .selectFrom('warehouses').select('id')
      .where('org_id', '=', orgId).executeTakeFirst();

    const inserted = await db
      .insertInto('warehouses')
      .values({
        org_id: orgId,
        branch_id: input.branchId ? Number(input.branchId) : null,
        name: input.name,
        code: input.code ?? null,
        address: input.address ?? null,
        // The first one is the default, so stock has somewhere to live.
        is_primary: existing ? 0 : 1,
        is_active: 1,
      })
      .executeTakeFirstOrThrow();

    const id = Number(inserted.insertId);
    await logAudit({
      orgId, actorUserId: user.userId, actorName: user.name, action: 'create',
      targetType: 'warehouse', targetId: id, targetLabel: input.name,
      detail: `Added warehouse ${input.name}`, ...auditMeta(req),
    });

    return { id: asId(id), name: input.name };
  },
  { permission: { module: 'inventory', action: 'create' } },
);
