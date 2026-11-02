import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Inventory reports beyond the stock summary (stock.ts): an item's stock
// ledger — every receipt, issue, sale, return and adjustment with a running
// balance — and the age of what is on hand.
//
// The movements are the documents stock.ts counts, document by document, so
// the ledger's closing quantity is the stock summary's. Goods received on a
// receipt note come in on the note's date; a bill raised from that note does
// not bring them in a second time.
//
// Ageing assumes the oldest stock went first (FIFO): what is left is the most
// recently received, so each item's quantity on hand is laid against its
// latest receipts, newest first, and aged from their dates.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor } from '../db';
import type { Paise } from '../../types';
import { dayBefore, stockPosition } from './stock';

export interface Movement {
  date: string;
  itemId: number;
  kind: string;
  sourceType: string;
  sourceId: number | null;
  number: string;
  qtyIn: number;
  qtyOut: number;
}

/** Every stock movement up to `to` (from `from` when given), oldest first. */
export async function movements(ex: Executor, orgId: number, opts: { itemId?: number; from?: string; to: string }): Promise<Movement[]> {
  const from = opts.from ?? '1900-01-01';
  const item = (col: string) => (opts.itemId ? sql`AND ${sql.ref(col)} = ${opts.itemId}` : sql``);
  const { rows } = await sql<{ d: string; item_id: number; kind: string; st: string; sid: number | null; num: string | null; qin: string; qout: string }>`
    SELECT * FROM (
      SELECT b.bill_date AS d, bl.item_id, 'Purchase' AS kind, 'bill' AS st, b.id AS sid, b.internal_no AS num, bl.qty AS qin, 0 AS qout
        FROM bill_lines bl JOIN bills b ON b.id = bl.bill_id
       WHERE b.org_id = ${orgId} AND b.status NOT IN ('draft','void') AND bl.item_id IS NOT NULL
         AND (bl.source_line_type IS NULL OR bl.source_line_type <> 'goods_receipt') ${item('bl.item_id')}
      UNION ALL
      SELECT g.receipt_date, gl.item_id, 'Goods received', 'goods_receipt', g.id, g.number, gl.qty, 0
        FROM goods_receipt_lines gl JOIN goods_receipts g ON g.id = gl.receipt_id
       WHERE g.org_id = ${orgId} AND g.status <> 'cancelled' AND gl.item_id IS NOT NULL ${item('gl.item_id')}
      UNION ALL
      SELECT p.produced_on, p.item_id, 'Produced', 'production', p.id, p.number, p.qty, 0
        FROM productions p WHERE p.org_id = ${orgId} AND p.status = 'done' ${item('p.item_id')}
      UNION ALL
      SELECT i.invoice_date, il.item_id, 'Sale', 'invoice', i.id, i.number, 0, il.qty
        FROM invoice_lines il JOIN invoices i ON i.id = il.invoice_id
       WHERE i.org_id = ${orgId} AND i.status NOT IN ('draft','void') AND il.item_id IS NOT NULL ${item('il.item_id')}
      UNION ALL
      SELECT i.invoice_date, ic.component_item_id, 'Sale (in a kit)', 'invoice', i.id, i.number, 0, il.qty * ic.qty
        FROM invoice_lines il JOIN invoices i ON i.id = il.invoice_id JOIN item_components ic ON ic.kit_item_id = il.item_id
       WHERE i.org_id = ${orgId} AND i.status NOT IN ('draft','void') ${item('ic.component_item_id')}
      UNION ALL
      SELECT c.note_date, ic.component_item_id, 'Sales return (in a kit)', 'credit_note', c.id, c.number, cl.qty * ic.qty, 0
        FROM credit_note_lines cl JOIN credit_notes c ON c.id = cl.credit_note_id JOIN item_components ic ON ic.kit_item_id = cl.item_id
       WHERE c.org_id = ${orgId} AND c.status <> 'void' ${item('ic.component_item_id')}
      UNION ALL
      SELECT p.produced_on, pl.item_id, 'Issued to production', 'production', p.id, p.number, 0, pl.qty
        FROM production_lines pl JOIN productions p ON p.id = pl.production_id
       WHERE p.org_id = ${orgId} AND p.status = 'done' ${item('pl.item_id')}
      UNION ALL
      SELECT c.note_date, cl.item_id, 'Sales return', 'credit_note', c.id, c.number, cl.qty, 0
        FROM credit_note_lines cl JOIN credit_notes c ON c.id = cl.credit_note_id
       WHERE c.org_id = ${orgId} AND c.status <> 'void' AND cl.item_id IS NOT NULL ${item('cl.item_id')}
      UNION ALL
      SELECT a.adjust_date, a.item_id, CONCAT('Adjustment: ', a.reason), 'stock_adjustment', a.id, CONCAT('ADJ-', a.id),
             GREATEST(a.qty_delta, 0), GREATEST(-a.qty_delta, 0)
        FROM stock_adjustments a WHERE a.org_id = ${orgId} ${item('a.item_id')}
      UNION ALL
      SELECT r.received_date, cl.item_id, 'Waste at job worker', 'job_work', r.id, CONCAT('JW-', r.id), 0, rl.qty_waste
        FROM job_work_receipt_lines rl JOIN job_work_receipts r ON r.id = rl.receipt_id
        JOIN challan_lines cl ON cl.id = rl.challan_line_id
       WHERE r.org_id = ${orgId} AND rl.qty_waste > 0 AND cl.item_id IS NOT NULL ${item('cl.item_id')}
    ) m
     WHERE m.d BETWEEN ${from} AND ${opts.to}
     ORDER BY m.d, m.qout, m.sid
  `.execute(ex);
  return rows.map((r) => ({
    date: String(r.d).slice(0, 10), itemId: Number(r.item_id), kind: r.kind, sourceType: r.st, sourceId: r.sid == null ? null : Number(r.sid),
    number: r.num ?? '', qtyIn: Number(r.qin), qtyOut: Number(r.qout),
  }));
}

export interface StockLedger {
  item: { id: string; name: string; sku: string | null; uqc: string };
  from: string;
  to: string;
  openingQty: number;
  lines: (Omit<Movement, 'itemId'> & { balanceQty: number })[];
  inQty: number;
  outQty: number;
  closingQty: number;
  closingValuePaise: Paise;
}

export async function stockLedger(ex: Executor, orgId: number, itemId: number, from: string, to: string): Promise<StockLedger | null> {
  const [before, after, moves] = await Promise.all([
    stockPosition(ex, orgId, dayBefore(from), { includeArchived: true }),
    stockPosition(ex, orgId, to, { includeArchived: true }),
    movements(ex, orgId, { itemId, from, to }),
  ]);
  const at = after.lines.find((l) => l.itemId === String(itemId));
  if (!at) return null;
  // Opening stock entered as an opening adjustment belongs before the period.
  const inPeriod = moves.filter((m) => !(m.sourceType === 'stock_adjustment' && m.kind === 'Adjustment: opening'));
  const openingQty = before.lines.find((l) => l.itemId === String(itemId))?.qty ?? 0;
  let balance = openingQty;
  const lines = inPeriod.map((mv) => {
    balance += mv.qtyIn - mv.qtyOut;
    const { date, kind, sourceType, sourceId, number, qtyIn, qtyOut } = mv;
    return { date, kind, sourceType, sourceId, number, qtyIn, qtyOut, balanceQty: Math.round(balance * 1000) / 1000 };
  });
  return {
    item: { id: at.itemId, name: at.name, sku: at.sku, uqc: at.uqc },
    from, to, openingQty,
    lines,
    inQty: inPeriod.reduce((t, m) => t + m.qtyIn, 0),
    outQty: inPeriod.reduce((t, m) => t + m.qtyOut, 0),
    closingQty: at.qty,
    closingValuePaise: at.valuePaise,
  };
}

export const AGE_BUCKETS = ['0–30 days', '31–60 days', '61–90 days', '91–180 days', 'Over 180 days'] as const;

export interface StockAgeingRow {
  itemId: string; name: string; uqc: string; qty: number; valuePaise: Paise;
  buckets: number[];
  /** Value in each bucket, at the item's unit cost. */
  bucketValuesPaise: Paise[];
  /** Days since the oldest stock still on hand came in. */
  oldestDays: number | null;
}

export async function stockAgeing(ex: Executor, orgId: number, asOf: string): Promise<{ asOf: string; rows: StockAgeingRow[]; totalsPaise: Paise[] }> {
  const [pos, moves] = await Promise.all([stockPosition(ex, orgId, asOf), movements(ex, orgId, { to: asOf })]);
  const inward = new Map<number, { date: string; qty: number }[]>();
  for (const m of moves) {
    if (m.qtyIn <= 0) continue;
    const list = inward.get(m.itemId) ?? [];
    // Opening stock counts as old as it gets.
    list.push({ date: m.kind === 'Adjustment: opening' ? '1900-01-01' : m.date, qty: m.qtyIn });
    inward.set(m.itemId, list);
  }
  const ageOf = (date: string) => Math.max(0, Math.round((Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86_400_000));
  const bucketOf = (days: number) => (days <= 30 ? 0 : days <= 60 ? 1 : days <= 90 ? 2 : days <= 180 ? 3 : 4);
  const rows: StockAgeingRow[] = [];
  for (const l of pos.lines) {
    if (l.qty <= 0) continue;
    const buckets = [0, 0, 0, 0, 0];
    let left = l.qty;
    let oldest: number | null = null;
    // Newest receipts first; what is not explained by receipts is opening stock.
    for (const r of [...(inward.get(Number(l.itemId)) ?? [])].sort((a, b) => b.date.localeCompare(a.date))) {
      if (left <= 0) break;
      const take = Math.min(left, r.qty);
      const days = ageOf(r.date);
      buckets[bucketOf(days)] += take;
      oldest = days;
      left -= take;
    }
    if (left > 0) { buckets[4] += left; oldest = Math.max(oldest ?? 0, 181); }
    rows.push({
      itemId: l.itemId, name: l.name, uqc: l.uqc, qty: l.qty, valuePaise: l.valuePaise,
      buckets: buckets.map((q) => Math.round(q * 1000) / 1000),
      bucketValuesPaise: buckets.map((q) => Math.round(q * l.unitCostPaise)),
      oldestDays: oldest,
    });
  }
  rows.sort((a, b) => (b.oldestDays ?? 0) - (a.oldestDays ?? 0));
  const totalsPaise = [0, 1, 2, 3, 4].map((i) => rows.reduce((t, r) => t + r.bucketValuesPaise[i], 0));
  return { asOf, rows, totalsPaise };
}
