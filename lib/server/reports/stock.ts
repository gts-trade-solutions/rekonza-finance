import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Closing stock, the way Tally values it.
//
// Purchases are expensed when they are billed, and nothing is posted when goods
// are sold. Stock on hand is therefore not a ledger balance at all: it is
// worked out from the documents on the day a report asks, and enters the
// statements twice — as an asset on the balance sheet, and in the trading
// section of the profit and loss:
//
//     cost of goods sold = opening stock + purchases − closing stock
//
// Without it, every rupee of stock still on the shelf is reported as a cost
// already incurred, which understates profit and leaves the balance sheet
// without inventory. That was the state of things before this file.
//
// Quantity on a date is the opening quantity, plus what bills brought in and
// credit notes took back, less what invoices sent out, plus or minus
// adjustments. Adjustments move quantity only: a write-off already reaches the
// profit and loss as a smaller closing stock, so posting it as well would count
// the loss twice.
//
// Value is weighted average cost, recomputed each financial year from that
// year's opening stock and purchases — Tally's "average cost". Averaging over
// the whole life of the books instead would let a price from three years ago
// keep diluting this year's cost.
//
// Opening stock is an opening balance. Its value is on the item (quantity and
// rate as at the start of the books), and an adjustment with the reason
// 'opening' adds to it whatever its date. Its other side is opening equity,
// which is why the balance sheet carries it there.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor } from '../db';
import type { Paise } from '../../types';
import { toPaiseFromSql } from '../money-sql';
import { getPolicies } from '../services/org-settings';

export interface StockLine {
  itemId: string;
  name: string;
  sku: string | null;
  uqc: string;
  isArchived: boolean;
  /** At the start of the books, including adjustments marked 'opening'. */
  openingQty: number;
  /** Everything up to the date, from the start of the books. */
  inwardQty: number;
  outwardQty: number;
  returnedQty: number;
  adjustedQty: number;
  /** Moved in from other branches less moved out to them; nil for the whole business. */
  transferredQty: number;
  qty: number;
  /** Weighted average for the financial year the date falls in. */
  unitCostPaise: Paise;
  /** Negative when the documents say more left than arrived. Not hidden. */
  valuePaise: Paise;
  /** The stock group it is reported under, if any. */
  stockGroupId: string | null;
  /** How it is valued: its own method, or the book's. */
  valuation: 'average' | 'fifo';
}

export interface StockPosition {
  asOf: string;
  lines: StockLine[];
  totalValuePaise: Paise;
  /** Opening stock at the start of the books: an opening balance, not income. */
  bookOpeningValuePaise: Paise;
}

/** The first day of the financial year a date falls in. */
export function fyStartFor(date: string, startMonth: number): string {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const year = m < startMonth ? y - 1 : y;
  return `${year}-${String(startMonth).padStart(2, '0')}-01`;
}

/** yyyy-mm-dd of the day before. Computed in UTC so no timezone moves it. */
export function dayBefore(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export async function fiscalStartMonth(ex: Executor, orgId: number): Promise<number> {
  const org = await ex
    .selectFrom('organizations').select('fiscal_year_start_month')
    .where('id', '=', orgId).executeTakeFirst();
  return Number(org?.fiscal_year_start_month ?? 4);
}

interface Movement { item_id: number; fy: number; qty: string; cost?: string }

/**
 * Stock on hand and its value at the end of `asOf`.
 *
 * With a branch, only that branch's documents count. Opening stock and
 * adjustments that name no branch belong to the primary branch, because that
 * is where an organisation with one location keeps everything.
 */
export async function stockPosition(
  ex: Executor,
  orgId: number,
  asOf: string,
  opts: { branchId?: number; includeArchived?: boolean } = {},
): Promise<StockPosition> {
  const startMonth = await fiscalStartMonth(ex, orgId);
  const fyOf = (d: string) => Number(fyStartFor(d, startMonth).slice(0, 4));
  const fySql = (col: ReturnType<typeof sql.ref>) =>
    sql<number>`(YEAR(${col}) - (MONTH(${col}) < ${startMonth}))`;

  const primary = await ex
    .selectFrom('branches').select('id')
    .where('org_id', '=', orgId).where('is_primary', '=', 1).executeTakeFirst();
  const branchId = opts.branchId;
  // Does stock that names no branch belong to the branch being asked about?
  const ownsUnplaced = !branchId || (primary && Number(primary.id) === branchId);
  const docBranch = (col: string) => (branchId ? sql`AND ${sql.ref(col)} = ${branchId}` : sql``);

  const items = await ex
    .selectFrom('items')
    .select(['id', 'name', 'sku', 'uqc', 'is_archived', 'opening_stock_qty', 'opening_stock_rate', 'purchase_price', 'stock_group_id', 'valuation_method'])
    .where('org_id', '=', orgId)
    .where('kind', '=', 'goods')
    .where('track_inventory', '=', 1)
    .$if(!opts.includeArchived, (qb) => qb.where('is_archived', '=', 0))
    .orderBy('name')
    .execute();

  const [inward, outward, returned, adjusted, openingAdj] = await Promise.all([
    // What a purchase cost is what was posted to the cost: the taxable value,
    // plus the tax only when that tax could not be claimed back.
    //
    // Goods on a receipt note are in stock from the day they arrive, at the
    // note's rate, until their bill comes; from then the bill carries them.
    // So a note counts only for what had not been billed by `asOf`.
    sql<Movement>`
      SELECT item_id, fy, SUM(qty) AS qty, SUM(cost) AS cost FROM (
        SELECT bl.item_id, ${fySql(sql.ref('b.bill_date'))} AS fy, bl.qty,
               bl.taxable + CASE WHEN bl.itc_eligibility NOT IN ('eligible', 'capital_goods') AND b.is_rcm = 0
                                 THEN bl.cgst + bl.sgst + bl.igst + bl.cess ELSE 0 END AS cost
          FROM bill_lines bl
          JOIN bills b ON b.id = bl.bill_id
         WHERE b.org_id = ${orgId} AND b.status NOT IN ('draft','void')
           AND bl.item_id IS NOT NULL AND b.bill_date <= ${asOf} ${docBranch('b.branch_id')}
        UNION ALL
        SELECT gl.item_id, ${fySql(sql.ref('g.receipt_date'))} AS fy,
               gl.qty - COALESCE(billed.q, 0) AS qty,
               (gl.qty - COALESCE(billed.q, 0)) * gl.rate AS cost
          FROM goods_receipt_lines gl
          JOIN goods_receipts g ON g.id = gl.receipt_id
          LEFT JOIN (
            SELECT bl.source_line_id, SUM(bl.qty) AS q
              FROM bill_lines bl JOIN bills b ON b.id = bl.bill_id
             WHERE b.org_id = ${orgId} AND bl.source_line_type = 'goods_receipt'
               AND b.status NOT IN ('draft','void') AND b.bill_date <= ${asOf}
             GROUP BY bl.source_line_id
          ) billed ON billed.source_line_id = gl.id
         WHERE g.org_id = ${orgId} AND g.status <> 'cancelled'
           AND gl.item_id IS NOT NULL AND g.receipt_date <= ${asOf} ${docBranch('g.branch_id')}
        UNION ALL
        -- Made here: in at what the production cost, fixed when it was recorded.
        SELECT p.item_id, ${fySql(sql.ref('p.produced_on'))} AS fy, p.qty, p.cost
          FROM productions p
         WHERE p.org_id = ${orgId} AND p.status = 'done' AND p.produced_on <= ${asOf} ${docBranch('p.branch_id')}
      ) moves
       GROUP BY item_id, fy
    `.execute(ex),
    sql<Movement>`
      SELECT item_id, fy, SUM(qty) AS qty FROM (
        SELECT il.item_id, ${fySql(sql.ref('i.invoice_date'))} AS fy, il.qty
          FROM invoice_lines il
          JOIN invoices i ON i.id = il.invoice_id
         WHERE i.org_id = ${orgId} AND i.status NOT IN ('draft','void')
           AND il.item_id IS NOT NULL AND i.invoice_date <= ${asOf} ${docBranch('i.branch_id')}
        UNION ALL
        -- Components used up in making something.
        SELECT pl.item_id, ${fySql(sql.ref('p.produced_on'))} AS fy, pl.qty
          FROM production_lines pl JOIN productions p ON p.id = pl.production_id
         WHERE p.org_id = ${orgId} AND p.status = 'done' AND p.produced_on <= ${asOf} ${docBranch('p.branch_id')}
        UNION ALL
        -- Waste at a job worker: sent, and not coming back.
        SELECT cl.item_id, ${fySql(sql.ref('r.received_date'))} AS fy, rl.qty_waste
          FROM job_work_receipt_lines rl
          JOIN job_work_receipts r ON r.id = rl.receipt_id
          JOIN challan_lines cl ON cl.id = rl.challan_line_id
          JOIN delivery_challans d ON d.id = r.challan_id
         WHERE r.org_id = ${orgId} AND rl.qty_waste > 0 AND cl.item_id IS NOT NULL
           AND r.received_date <= ${asOf} ${docBranch('d.branch_id')}
      ) used
       GROUP BY item_id, fy
    `.execute(ex),
    sql<Movement>`
      SELECT cl.item_id, ${fySql(sql.ref('c.note_date'))} AS fy, SUM(cl.qty) AS qty
        FROM credit_note_lines cl
        JOIN credit_notes c ON c.id = cl.credit_note_id
       WHERE c.org_id = ${orgId} AND c.status <> 'void'
         AND cl.item_id IS NOT NULL AND c.note_date <= ${asOf} ${docBranch('c.branch_id')}
       GROUP BY cl.item_id, fy
    `.execute(ex),
    sql<Movement>`
      SELECT a.item_id, ${fySql(sql.ref('a.adjust_date'))} AS fy, SUM(a.qty_delta) AS qty
        FROM stock_adjustments a
        LEFT JOIN warehouses w ON w.id = a.warehouse_id
       WHERE a.org_id = ${orgId} AND a.reason <> 'opening' AND a.adjust_date <= ${asOf}
         ${branchId
           ? (ownsUnplaced
               ? sql`AND (w.branch_id = ${branchId} OR w.branch_id IS NULL)`
               : sql`AND w.branch_id = ${branchId}`)
           : sql``}
       GROUP BY a.item_id, fy
    `.execute(ex),
    // Opening stock entered as an adjustment is still opening stock, whatever
    // day it was typed in on.
    sql<{ item_id: number; qty: string }>`
      SELECT a.item_id, SUM(a.qty_delta) AS qty
        FROM stock_adjustments a
        LEFT JOIN warehouses w ON w.id = a.warehouse_id
       WHERE a.org_id = ${orgId} AND a.reason = 'opening'
         ${branchId
           ? (ownsUnplaced
               ? sql`AND (w.branch_id = ${branchId} OR w.branch_id IS NULL)`
               : sql`AND w.branch_id = ${branchId}`)
           : sql``}
       GROUP BY a.item_id
    `.execute(ex),
  ]);

  // item → fy → movement
  const index = (rows: Movement[]) => {
    const m = new Map<number, Map<number, { qty: number; cost: number }>>();
    for (const r of rows) {
      const byFy = m.get(Number(r.item_id)) ?? new Map();
      byFy.set(Number(r.fy), { qty: Number(r.qty), cost: r.cost === undefined ? 0 : toPaiseFromSql(r.cost) });
      m.set(Number(r.item_id), byFy);
    }
    return m;
  };
  // Transfers move stock between branches: out on the day it leaves, in on the
  // day it arrives. For the whole business they net to nil, goods in transit
  // included, so they are read only for one branch.
  const transferred = branchId
    ? await sql<Movement>`
        SELECT item_id, fy, SUM(q) AS qty FROM (
          SELECT l.item_id, ${fySql(sql.ref('t.dispatch_date'))} AS fy, -l.qty AS q
            FROM stock_transfer_lines l JOIN stock_transfers t ON t.id = l.transfer_id
            JOIN warehouses w ON w.id = t.from_warehouse_id
           WHERE t.org_id = ${orgId} AND t.status <> 'cancelled' AND t.dispatch_date <= ${asOf}
             AND ${ownsUnplaced ? sql`(w.branch_id = ${branchId} OR w.branch_id IS NULL)` : sql`w.branch_id = ${branchId}`}
          UNION ALL
          SELECT l.item_id, ${fySql(sql.ref('t.received_date'))} AS fy, l.qty AS q
            FROM stock_transfer_lines l JOIN stock_transfers t ON t.id = l.transfer_id
            JOIN warehouses w ON w.id = t.to_warehouse_id
           WHERE t.org_id = ${orgId} AND t.status = 'received' AND t.received_date <= ${asOf}
             AND ${ownsUnplaced ? sql`(w.branch_id = ${branchId} OR w.branch_id IS NULL)` : sql`w.branch_id = ${branchId}`}
        ) moves GROUP BY item_id, fy
      `.execute(ex)
    : { rows: [] as Movement[] };
  const trBy = index(transferred.rows);
  const inBy = index(inward.rows);
  const outBy = index(outward.rows);
  const retBy = index(returned.rows);
  const adjBy = index(adjusted.rows);
  const openAdj = new Map(openingAdj.rows.map((r) => [Number(r.item_id), Number(r.qty)]));

  const lastFy = fyOf(asOf);
  const years = [inward, outward, returned, adjusted].flatMap((r) => r.rows.map((x) => Number(x.fy)));
  const firstFy = years.length ? Math.min(lastFy, ...years) : lastFy;

  // An item valued by its own method, or else by the book's.
  const bookMethod = (await getPolicies(ex, orgId)).stockValuation;
  let bookOpeningValuePaise = 0;
  const lines: StockLine[] = items.map((it) => {
    const id = Number(it.id);
    const catalogue = toPaiseFromSql(it.purchase_price);
    const openingRate = it.opening_stock_rate === null ? catalogue : toPaiseFromSql(it.opening_stock_rate);
    const placedOpening = ownsUnplaced ? Number(it.opening_stock_qty ?? 0) : 0;
    const openingQty = placedOpening + (openAdj.get(id) ?? 0);
    const openingValue = Math.round(openingQty * openingRate);
    bookOpeningValuePaise += openingValue;

    let qty = openingQty;
    let value = openingValue;
    let avg = openingRate;
    let inwardQty = 0, outwardQty = 0, returnedQty = 0, adjustedQty = 0, transferredQty = 0;

    for (let fy = firstFy; fy <= lastFy; fy++) {
      const inn = inBy.get(id)?.get(fy) ?? { qty: 0, cost: 0 };
      const out = outBy.get(id)?.get(fy)?.qty ?? 0;
      const ret = retBy.get(id)?.get(fy)?.qty ?? 0;
      const adj = adjBy.get(id)?.get(fy)?.qty ?? 0;
      const moved = trBy.get(id)?.get(fy)?.qty ?? 0;

      // The year's average: what was on hand at the start, plus what was
      // bought, over how many. Negative stock carried in has no cost to
      // average, so a year that starts in the red averages its purchases alone.
      if (qty > 0 && qty + inn.qty > 0) avg = (value + inn.cost) / (qty + inn.qty);
      else if (inn.qty > 0) avg = inn.cost / inn.qty;

      qty = qty + inn.qty - out + ret + adj + moved;
      value = qty * avg;

      inwardQty += inn.qty;
      outwardQty += out;
      returnedQty += ret;
      adjustedQty += adj;
      transferredQty += moved;
    }

    return {
      itemId: String(id),
      name: it.name,
      sku: it.sku,
      uqc: it.uqc,
      isArchived: !!it.is_archived,
      openingQty,
      inwardQty,
      outwardQty,
      returnedQty,
      adjustedQty,
      transferredQty,
      qty,
      unitCostPaise: Math.round(avg),
      valuePaise: Math.round(value),
      stockGroupId: it.stock_group_id === null ? null : String(it.stock_group_id),
      valuation: it.valuation_method ?? bookMethod,
    };
  });

  // First in, first out: what is left is what came in last. Each item's
  // closing quantity is valued from its latest purchases back, and anything
  // older than them at the opening rate. Only for the items valued that way.
  if (lines.some((l) => l.valuation === 'fifo')) {
    const { rows: layers } = await sql<{ item_id: number; qty: string; cost: string }>`
      SELECT item_id, qty, cost FROM (
        SELECT bl.item_id, b.bill_date AS d, bl.id AS seq, bl.qty,
               bl.taxable + CASE WHEN bl.itc_eligibility NOT IN ('eligible', 'capital_goods') AND b.is_rcm = 0
                                 THEN bl.cgst + bl.sgst + bl.igst + bl.cess ELSE 0 END AS cost
          FROM bill_lines bl JOIN bills b ON b.id = bl.bill_id
         WHERE b.org_id = ${orgId} AND b.status NOT IN ('draft','void')
           AND bl.item_id IS NOT NULL AND bl.qty > 0 AND b.bill_date <= ${asOf} ${docBranch('b.branch_id')}
        UNION ALL
        SELECT p.item_id, p.produced_on AS d, p.id AS seq, p.qty, p.cost
          FROM productions p
         WHERE p.org_id = ${orgId} AND p.status = 'done' AND p.produced_on <= ${asOf} ${docBranch('p.branch_id')}
      ) x ORDER BY d DESC, seq DESC
    `.execute(ex);
    const byItem = new Map<number, { qty: number; cost: Paise }[]>();
    for (const l of layers) {
      const list = byItem.get(Number(l.item_id)) ?? [];
      list.push({ qty: Number(l.qty), cost: toPaiseFromSql(l.cost) });
      byItem.set(Number(l.item_id), list);
    }
    for (const line of lines) {
      if (line.qty <= 0 || line.valuation !== 'fifo') continue;
      let left = line.qty;
      let value = 0;
      for (const layer of byItem.get(Number(line.itemId)) ?? []) {
        if (left <= 0) break;
        const take = Math.min(left, layer.qty);
        value += (layer.cost / layer.qty) * take;
        left -= take;
      }
      const it = items.find((x) => String(x.id) === line.itemId)!;
      const openingRate = it.opening_stock_rate === null ? toPaiseFromSql(it.purchase_price) : toPaiseFromSql(it.opening_stock_rate);
      if (left > 0) value += left * openingRate;
      line.valuePaise = Math.round(value);
      line.unitCostPaise = Math.round(value / line.qty);
    }
  }

  return {
    asOf,
    lines,
    totalValuePaise: lines.reduce((t, l) => t + l.valuePaise, 0),
    bookOpeningValuePaise,
  };
}

export interface GodownStock {
  asOf: string;
  godowns: { id: string; name: string; branchName: string | null }[];
  rows: { itemId: string; name: string; uqc: string; byGodown: Record<string, number>; inTransit: number; total: number }[];
}

/**
 * Stock by godown: each document's quantity at the godown it names, or at its
 * branch's main godown when it names none (as every document did before
 * godowns were named). Goods dispatched between godowns and not yet received
 * are in transit, in neither; so the godowns and the transit add up to the
 * stock position for the whole business.
 */
export async function stockByGodown(ex: Executor, orgId: number, asOf: string): Promise<GodownStock> {
  const godowns = await ex.selectFrom('warehouses as w').leftJoin('branches as b', 'b.id', 'w.branch_id')
    .select(['w.id', 'w.name', 'w.branch_id', 'w.is_primary', 'b.name as branch_name'])
    .where('w.org_id', '=', orgId).where('w.is_active', '=', 1).orderBy('w.is_primary', 'desc').orderBy('w.name').execute();
  const branches = await ex.selectFrom('branches').select(['id', 'is_primary']).where('org_id', '=', orgId).execute();
  const orgMain = godowns.find((g) => g.is_primary) ?? godowns[0];
  // Each branch's main godown: its primary one, or its first, or the book's.
  const mainOf = new Map<number, number | null>(branches.map((b) => {
    const own = godowns.filter((g) => g.branch_id === b.id);
    return [b.id, (own.find((g) => g.is_primary) ?? own[0] ?? (b.is_primary ? orgMain : undefined) ?? orgMain)?.id ?? null];
  }));
  const primaryBranch = branches.find((b) => b.is_primary)?.id ?? branches[0]?.id;

  const { rows: moves } = await sql<{ item_id: number; wh: number | null; br: number | null; qty: string }>`
    SELECT item_id, wh, br, SUM(q) AS qty FROM (
      SELECT bl.item_id, b.warehouse_id AS wh, b.branch_id AS br, bl.qty AS q
        FROM bill_lines bl JOIN bills b ON b.id = bl.bill_id
       WHERE b.org_id = ${orgId} AND b.status NOT IN ('draft','void') AND bl.item_id IS NOT NULL AND b.bill_date <= ${asOf}
         AND NOT (bl.source_line_type <=> 'goods_receipt')
      UNION ALL
      SELECT gl.item_id, g.warehouse_id, g.branch_id, gl.qty
        FROM goods_receipt_lines gl JOIN goods_receipts g ON g.id = gl.receipt_id
       WHERE g.org_id = ${orgId} AND g.status <> 'cancelled' AND gl.item_id IS NOT NULL AND g.receipt_date <= ${asOf}
      UNION ALL
      SELECT p.item_id, p.warehouse_id, p.branch_id, p.qty
        FROM productions p WHERE p.org_id = ${orgId} AND p.status = 'done' AND p.produced_on <= ${asOf}
      UNION ALL
      SELECT pl.item_id, p.warehouse_id, p.branch_id, -pl.qty
        FROM production_lines pl JOIN productions p ON p.id = pl.production_id
       WHERE p.org_id = ${orgId} AND p.status = 'done' AND p.produced_on <= ${asOf}
      UNION ALL
      SELECT il.item_id, i.warehouse_id, i.branch_id, -il.qty
        FROM invoice_lines il JOIN invoices i ON i.id = il.invoice_id
       WHERE i.org_id = ${orgId} AND i.status NOT IN ('draft','void') AND il.item_id IS NOT NULL AND i.invoice_date <= ${asOf}
      UNION ALL
      SELECT cl.item_id, c.warehouse_id, c.branch_id, cl.qty
        FROM credit_note_lines cl JOIN credit_notes c ON c.id = cl.credit_note_id
       WHERE c.org_id = ${orgId} AND c.status <> 'void' AND cl.item_id IS NOT NULL AND c.note_date <= ${asOf}
      UNION ALL
      SELECT cl.item_id, NULL, d.branch_id, -rl.qty_waste
        FROM job_work_receipt_lines rl JOIN job_work_receipts r ON r.id = rl.receipt_id
        JOIN challan_lines cl ON cl.id = rl.challan_line_id JOIN delivery_challans d ON d.id = r.challan_id
       WHERE r.org_id = ${orgId} AND rl.qty_waste > 0 AND cl.item_id IS NOT NULL AND r.received_date <= ${asOf}
      UNION ALL
      SELECT a.item_id, a.warehouse_id, NULL, a.qty_delta
        FROM stock_adjustments a WHERE a.org_id = ${orgId} AND a.adjust_date <= ${asOf}
      UNION ALL
      SELECT l.item_id, t.from_warehouse_id, NULL, -l.qty
        FROM stock_transfer_lines l JOIN stock_transfers t ON t.id = l.transfer_id
       WHERE t.org_id = ${orgId} AND t.status <> 'cancelled' AND t.dispatch_date <= ${asOf}
      UNION ALL
      SELECT l.item_id, t.to_warehouse_id, NULL, l.qty
        FROM stock_transfer_lines l JOIN stock_transfers t ON t.id = l.transfer_id
       WHERE t.org_id = ${orgId} AND t.status = 'received' AND t.received_date <= ${asOf}
    ) m GROUP BY item_id, wh, br`.execute(ex);
  const { rows: transit } = await sql<{ item_id: number; qty: string }>`
    SELECT l.item_id, SUM(l.qty) AS qty FROM stock_transfer_lines l JOIN stock_transfers t ON t.id = l.transfer_id
     WHERE t.org_id = ${orgId} AND t.status <> 'cancelled' AND t.dispatch_date <= ${asOf}
       AND (t.status = 'in_transit' OR t.received_date > ${asOf})
     GROUP BY l.item_id`.execute(ex);

  const items = await ex.selectFrom('items').select(['id', 'name', 'uqc', 'opening_stock_qty'])
    .where('org_id', '=', orgId).where('kind', '=', 'goods').where('track_inventory', '=', 1).orderBy('name').execute();
  const UNPLACED = '0';
  const at = new Map<string, Record<string, number>>();
  const put = (itemId: number, wh: number | null | undefined, qty: number) => {
    const key = wh ? String(wh) : UNPLACED;
    const row = at.get(String(itemId)) ?? {};
    row[key] = (row[key] ?? 0) + qty;
    at.set(String(itemId), row);
  };
  for (const it of items) if (Number(it.opening_stock_qty ?? 0)) put(it.id, primaryBranch ? mainOf.get(primaryBranch) : orgMain?.id, Number(it.opening_stock_qty));
  for (const m of moves) put(Number(m.item_id), m.wh ?? (m.br ? mainOf.get(Number(m.br)) : orgMain?.id), Number(m.qty));
  const transitBy = new Map(transit.map((t) => [String(t.item_id), Number(t.qty)]));

  const rows = items.map((it) => {
    const byGodown = at.get(String(it.id)) ?? {};
    const inTransit = transitBy.get(String(it.id)) ?? 0;
    const total = Object.values(byGodown).reduce((t, q) => t + q, 0) + inTransit;
    return { itemId: String(it.id), name: it.name, uqc: it.uqc, byGodown, inTransit, total };
  }).filter((r) => r.total !== 0 || Object.values(r.byGodown).some((q) => q !== 0));
  const used = new Set(rows.flatMap((r) => Object.keys(r.byGodown)));
  return {
    asOf,
    godowns: [
      ...godowns.map((g) => ({ id: String(g.id), name: g.name, branchName: g.branch_name })),
      ...(used.has(UNPLACED) ? [{ id: UNPLACED, name: 'No godown', branchName: null }] : []),
    ],
    rows,
  };
}
