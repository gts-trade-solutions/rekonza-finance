import { z } from 'zod';
import { findOrCreateBatch } from '@/lib/server/services/batches';
import { recordSerials } from '@/lib/server/services/serials';
import { db, transaction } from '@/lib/server/db';
import { route, body, query, asId, badRequest, conflict } from '@/lib/server/http';
import { toPaiseFromSql } from '@/lib/server/money-sql';
import { stockByGodown, stockPosition } from '@/lib/server/reports/stock';
import { logAudit, auditMeta } from '@/lib/server/audit';

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
          'w.name as warehouse_name', 'u.name as user_name',
        ])
        .where('a.org_id', '=', orgId)
        .$if(!!q.itemId, (qb) => qb.where('a.item_id', '=', Number(q.itemId)))
        .orderBy('a.adjust_date', 'desc')
        .orderBy('a.id', 'desc')
        .limit(300)
        .execute();

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
          valuePaise: Math.round(Number(a.qty_delta) * toPaiseFromSql(a.purchase_price)),
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

const AdjustInput = z.object({
  itemId: z.union([z.string(), z.number()]),
  warehouseId: z.union([z.string(), z.number()]).nullish(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a yyyy-mm-dd date.'),
  qtyDelta: z.number().refine((v) => v !== 0, 'An adjustment of zero changes nothing.'),
  reason: z.enum(['damage', 'theft', 'stocktake', 'expiry', 'sample', 'opening', 'other']),
  notes: z.string().trim().max(500).nullish(),
  /** A batch-tracked item: which batch, made if new (with its dates) on an opening or a found count. */
  batch: z.object({ batchNo: z.string().trim().min(1).max(40), mfgDate: z.string().nullish(), expiryDate: z.string().nullish() }).nullish(),
  /** A serial-tracked item: the number of each piece found or written off. */
  serials: z.array(z.string().trim().min(1).max(80)).max(5000).nullish(),
});

/**
 * Adjust stock.
 *
 * Quantity only, as in Tally. Stock is valued from the documents on the day a
 * report is run, so damage, theft or a short count reaches the profit and loss
 * as a smaller closing stock. Posting the loss as well would count it twice.
 *
 * An adjustment with the reason 'opening' is opening stock, whatever its date:
 * it is an opening balance, and is carried in opening equity, not in profit.
 */
export const POST = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, AdjustInput);
    const itemId = Number(input.itemId);

    const item = await db
      .selectFrom('items')
      .select(['id', 'name', 'kind', 'purchase_price', 'is_archived', 'track_inventory', 'track_batches'])
      .where('id', '=', itemId).where('org_id', '=', orgId).executeTakeFirst();
    if (!item) throw badRequest('That item does not exist.');
    if (item.kind !== 'goods') throw badRequest('Only goods carry stock. A service has none to adjust.');
    if (item.is_archived) throw conflict(`${item.name} is archived.`);
    if (!item.track_inventory) {
      throw conflict(`${item.name} does not track stock. Turn on stock tracking for it first.`);
    }

    // Shown for information: the value at the catalogue price.
    const valuePaise = Math.round(Math.abs(input.qtyDelta) * toPaiseFromSql(item.purchase_price));

    if (item.track_batches && !input.batch) throw badRequest(`${item.name} is tracked by batch: say which batch.`);

    const inserted = await transaction(async (trx) => {
      const batchId = item.track_batches && input.batch ? await findOrCreateBatch(trx, orgId, itemId, input.batch) : null;
      const row = await trx
        .insertInto('stock_adjustments')
        .values({
          org_id: orgId,
          batch_id: batchId,
          warehouse_id: input.warehouseId ? Number(input.warehouseId) : null,
          item_id: itemId,
          adjust_date: input.date,
          qty_delta: String(input.qtyDelta),
          reason: input.reason,
          notes: input.notes ?? null,
          journal_entry_id: null,
          created_by_user_id: user.userId,
        })
        .executeTakeFirstOrThrow();
      // Numbered pieces found (opening stock, a count) or written off.
      await recordSerials(trx, orgId, { type: 'adjustment', id: Number(row.insertId) }, input.qtyDelta > 0 ? 1 : -1,
        [{ lineId: null, itemId, qty: input.qtyDelta, serials: input.serials }], { check: true });
      return row;
    });
    const result = { id: Number(inserted.insertId), journalEntryId: null as number | null };

    await logAudit({
      orgId, actorUserId: user.userId, actorName: user.name, action: 'create',
      targetType: 'stock_adjustment', targetId: result.id, targetLabel: item.name,
      detail: `${input.qtyDelta > 0 ? '+' : ''}${input.qtyDelta} ${item.name} (${input.reason}), ` +
        `value ${(valuePaise / 100).toFixed(2)}`,
      ...auditMeta(req),
    });

    return {
      id: asId(result.id),
      valuePaise,
      journalEntryId: result.journalEntryId === null ? null : asId(result.journalEntryId),
    };
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
