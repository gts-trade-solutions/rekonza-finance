import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Stock valuation vs ledger: the reconciliation the auditors asked for when
// they found a "FIFO valuation variance" (status review 7, item 5).
//
// For each item, and in total, at any date: what the stock is worth per the
// Inventory Valuation report (FIFO layers or the year's average, reports/
// stock.ts), what the Inventory account holds for it (stock_postings, written
// with every Inventory line, ledger/posting.ts), the difference, and why there
// is one. A book in order reads ₹0.00 everywhere.
//
// On a periodic book the Inventory account is not posted at all: the balance
// sheet and the P&L take closing stock from the valuation (statements.ts), so
// there is nothing to differ and the report says so, with the proof that the
// P&L's cost of goods sold is opening stock + purchases − closing stock.
//
// A perpetual book can differ where something moved stock without posting:
// an adjustment or production recorded before they posted on their own
// (migration 131), goods received and not yet billed, a back-dated document in
// a locked month, or a journal someone posted to Inventory by hand. Each is
// named. "Bring into line" posts the rest as a true-up (stock-ledger.ts).
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor } from '../db';
import type { Paise } from '../../types';
import { toPaiseFromSql } from '../money-sql';
import { CODE } from '../ledger/chart-of-accounts';
import { fyStartFor, fiscalStartMonth, stockPosition } from './stock';
import { inventoryInLedger, profitAndLoss } from './statements';
import { getPolicies } from '../services/org-settings';

export interface StockRecLine {
  itemId: string;
  name: string;
  sku: string | null;
  uqc: string;
  valuation: 'average' | 'fifo';
  qty: number;
  valuationPaise: Paise;
  /** Null on a periodic book: the account is not posted item by item, or at all. */
  ledgerPaise: Paise | null;
  variancePaise: Paise;
  reasons: string[];
}

export interface StockReconciliation {
  asOf: string;
  method: 'perpetual' | 'periodic';
  perpetualFrom: string | null;
  lines: StockRecLine[];
  /** What the Inventory account holds that no item accounts for, and the entries that put it there. */
  unassigned: { amountPaise: Paise; entries: { entryId: string; entryNo: number; date: string; memo: string | null; amountPaise: Paise }[] };
  totals: { valuationPaise: Paise; ledgerPaise: Paise; variancePaise: Paise; inStatementsPaise: Paise };
  /** The P&L for the financial year to the date: cost of goods sold, and how it is made up. */
  proof: { from: string; openingStockPaise: Paise; directCostsPaise: Paise; closingStockPaise: Paise; costOfGoodsSoldPaise: Paise; cogsAccountPaise: Paise };
  notes: string[];
}

const ymd = (v: unknown) => String(v instanceof Date ? v.toISOString() : v).slice(0, 10);
const dmy = (d: string) => `${d.slice(8, 10)}-${d.slice(5, 7)}-${d.slice(0, 4)}`;

export async function stockReconciliation(ex: Executor, orgId: number, asOf: string): Promise<StockReconciliation> {
  const s = (await getPolicies(ex, orgId)).stockAccounting;
  const perpetual = s.method === 'perpetual' && !!s.from && asOf >= s.from;
  const [pos, ledgerTotal, itemRows] = await Promise.all([
    stockPosition(ex, orgId, asOf, { includeArchived: true }),
    inventoryInLedger(ex, orgId, asOf),
    ex.selectFrom('stock_postings').select((eb) => ['item_id', eb.fn.sum<string>('amount').as('v')])
      .where('org_id', '=', orgId).where('posting_date', '<=', asOf).groupBy('item_id').execute(),
  ]);
  const ledgerBy = new Map(itemRows.map((r) => [String(r.item_id), toPaiseFromSql(r.v ?? '0')]));

  // Why an item may differ, found from the documents that move stock without posting.
  const reasonsBy = new Map<string, string[]>();
  const say = (itemId: unknown, why: string) => {
    const k = String(itemId);
    const list = reasonsBy.get(k) ?? [];
    if (!list.includes(why) && list.length < 6) list.push(why);
    reasonsBy.set(k, list);
  };
  if (perpetual) {
    const since = s.from!;
    const [adjustments, productions, receipts] = await Promise.all([
      ex.selectFrom('stock_adjustments').select(['id', 'item_id', 'adjust_date', 'qty_delta', 'reason'])
        .where('org_id', '=', orgId).where('journal_entry_id', 'is', null).where('adjust_date', '>=', since).where('adjust_date', '<=', asOf).execute(),
      ex.selectFrom('productions').select(['id', 'number', 'item_id', 'produced_on'])
        .where('org_id', '=', orgId).where('status', '=', 'done').where('journal_entry_id', 'is', null)
        .where('produced_on', '>=', since).where('produced_on', '<=', asOf).execute(),
      sql<{ item_id: number; number: string; receipt_date: string }>`
        SELECT gl.item_id, g.number, g.receipt_date FROM goods_receipt_lines gl JOIN goods_receipts g ON g.id = gl.receipt_id
         WHERE g.org_id = ${orgId} AND g.status IN ('open', 'partially_billed') AND gl.item_id IS NOT NULL
           AND g.receipt_date <= ${asOf} AND g.journal_entry_id IS NULL`.execute(ex),
    ]);
    for (const a of adjustments) say(a.item_id, `Adjustment ADJ-${a.id} of ${a.adjust_date ? dmy(ymd(a.adjust_date)) : ''} (${Number(a.qty_delta)} ${a.reason}) is not posted to the ledger yet.`);
    for (const p of productions) say(p.item_id, `Production ${p.number} of ${dmy(ymd(p.produced_on))} is not posted to the ledger yet.`);
    for (const g of receipts.rows) say(g.item_id, `Goods receipt ${g.number} of ${dmy(ymd(g.receipt_date))}: in stock, but not billed or posted yet.`);
  }

  const lines: StockRecLine[] = pos.lines.map((l) => {
    const ledger = perpetual ? ledgerBy.get(l.itemId) ?? 0 : null;
    const variance = perpetual ? l.valuePaise - (ledger ?? 0) : 0;
    const reasons = reasonsBy.get(l.itemId) ?? [];
    if (variance !== 0 && !reasons.length) {
      reasons.push('The item\'s cost was worked out again after it was posted (a back-dated document, a document in a locked month, or the year\'s average cost moving). "Bring into line" posts the difference as a stock cost variance.');
    }
    return {
      itemId: l.itemId, name: l.name, sku: l.sku, uqc: l.uqc, valuation: l.valuation, qty: l.qty,
      valuationPaise: l.valuePaise, ledgerPaise: ledger, variancePaise: variance, reasons: variance ? reasons : [],
    };
  }).filter((l) => l.qty !== 0 || l.valuationPaise !== 0 || (l.ledgerPaise ?? 0) !== 0);

  // Items no longer tracked that the account still holds something for.
  if (perpetual) {
    const known = new Set(lines.map((l) => l.itemId));
    const gone = [...ledgerBy].filter(([id, v]) => !known.has(id) && v !== 0);
    if (gone.length) {
      const names = await ex.selectFrom('items').select(['id', 'name', 'sku', 'uqc']).where('org_id', '=', orgId).where('id', 'in', gone.map(([id]) => Number(id))).execute();
      for (const [id, v] of gone) {
        const it = names.find((n) => String(n.id) === id);
        lines.push({
          itemId: id, name: it?.name ?? `Item ${id}`, sku: it?.sku ?? null, uqc: it?.uqc ?? '', valuation: 'average', qty: 0,
          valuationPaise: 0, ledgerPaise: v, variancePaise: -v,
          reasons: ['The item no longer tracks stock (or is not goods), but the Inventory account still holds this for it.'],
        });
      }
    }
  }

  const itemLedgerTotal = [...ledgerBy.values()].reduce((t, v) => t + v, 0);
  const unassignedPaise = perpetual ? ledgerTotal - itemLedgerTotal : 0;
  const entries: StockReconciliation['unassigned']['entries'] = [];
  if (perpetual && unassignedPaise !== 0) {
    // Entries whose Inventory lines are not all held for an item: journals by hand, and older entries.
    const { rows } = await sql<{ id: number; entry_no: number; entry_date: string; memo: string | null; inv: string; held: string | null }>`
      SELECT e.id, e.entry_no, e.entry_date, e.memo, x.inv, sp.held FROM journal_entries e
        JOIN (SELECT jl.entry_id, SUM(jl.debit - jl.credit) AS inv FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
               WHERE jl.org_id = ${orgId} AND a.code = ${CODE.INVENTORY} AND jl.entry_date <= ${asOf} GROUP BY jl.entry_id) x ON x.entry_id = e.id
        LEFT JOIN (SELECT entry_id, SUM(amount) AS held FROM stock_postings WHERE org_id = ${orgId} GROUP BY entry_id) sp ON sp.entry_id = e.id
       WHERE e.org_id = ${orgId} AND ROUND(x.inv - COALESCE(sp.held, 0), 2) <> 0
       ORDER BY e.entry_date DESC, e.id DESC LIMIT 50`.execute(ex);
    for (const r of rows) {
      entries.push({ entryId: String(r.id), entryNo: Number(r.entry_no), date: ymd(r.entry_date), memo: r.memo, amountPaise: toPaiseFromSql(r.inv) - toPaiseFromSql(r.held ?? '0') });
    }
    const baseline = await ex.selectFrom('stock_postings').select((eb) => [eb.fn.sum<string>('amount').as('v'), eb.fn.max('posting_date').as('d')])
      .where('org_id', '=', orgId).where('source_type', '=', 'baseline').where('posting_date', '<=', asOf).executeTakeFirst();
    if (baseline?.v && toPaiseFromSql(baseline.v) !== 0) {
      entries.push({ entryId: '', entryNo: 0, date: ymd(baseline.d), memo: 'Starting split of the Inventory account by item (posted before item-wise tracking began)', amountPaise: -toPaiseFromSql(baseline.v) });
    }
  }

  const valuationPaise = pos.totalValuePaise;
  const totals = perpetual
    ? { valuationPaise, ledgerPaise: ledgerTotal, variancePaise: valuationPaise - ledgerTotal, inStatementsPaise: valuationPaise }
    // A periodic book: the statements add the valuation less whatever the account holds, so stock is never short or double.
    : { valuationPaise, ledgerPaise: ledgerTotal, variancePaise: 0, inStatementsPaise: valuationPaise };

  const from = fyStartFor(asOf, await fiscalStartMonth(ex, orgId));
  const pnl = await profitAndLoss(ex, orgId, from, asOf);
  const directCodes = new Set(['5100', '5200', '5300']);
  const directCostsPaise = pnl.expenseRows.filter((r) => directCodes.has(r.code)).reduce((t, r) => t + r.balancePaise, 0);
  const cogsAccountPaise = pnl.expenseRows.find((r) => r.code === CODE.COGS)?.balancePaise ?? 0;

  const notes: string[] = [];
  if (!perpetual) {
    notes.push(s.method === 'perpetual' && s.from
      ? `This book keeps stock perpetually from ${dmy(s.from)}; before that date stock is carried from the valuation, so there is nothing to reconcile.`
      : 'This book keeps stock periodically (Settings → Controls): the Inventory account is not posted as goods move, and the balance sheet and the P&L take closing stock from this valuation. There is nothing to differ: the variance is ₹0.00 by construction.');
  } else {
    notes.push(`Perpetual inventory from ${dmy(s.from!)}: every bill, sale, return, adjustment and production posts to the Inventory account on its own date, item by item, at FIFO or average cost.`);
    notes.push('A back-dated document is handled by one rule: what was posted for later documents stands, and the difference it makes is posted as a "Stock cost variance" entry on each later day it changes, naming the document.');
  }
  return {
    asOf, method: perpetual ? 'perpetual' : 'periodic', perpetualFrom: s.method === 'perpetual' ? s.from ?? null : null,
    lines: lines.sort((a, b) => Math.abs(b.variancePaise) - Math.abs(a.variancePaise) || a.name.localeCompare(b.name)),
    unassigned: { amountPaise: unassignedPaise, entries },
    totals,
    proof: { from, openingStockPaise: pnl.openingStockPaise, directCostsPaise, closingStockPaise: pnl.closingStockPaise, costOfGoodsSoldPaise: pnl.costOfGoodsSoldPaise, cogsAccountPaise },
    notes,
  };
}

/** One item's FIFO layers at a date, newest first, with what of each is still on hand: the item page's Stock Layers. */
export async function itemLayers(ex: Executor, orgId: number, itemId: number, asOf: string) {
  const { allFifoLayers } = await import('./stock');
  const pos = await stockPosition(ex, orgId, asOf, { includeArchived: true });
  const line = pos.lines.find((l) => l.itemId === String(itemId));
  const layers = (await allFifoLayers(ex, orgId, asOf)).get(itemId) ?? [];
  const billIds = layers.filter((l) => l.source === 'bill').map((l) => l.lineId!);
  const prodIds = layers.filter((l) => l.source === 'production').map((l) => l.lineId!);
  const bills = billIds.length
    ? await ex.selectFrom('bill_lines as bl').innerJoin('bills as b', 'b.id', 'bl.bill_id').innerJoin('contacts as c', 'c.id', 'b.vendor_id')
        .select(['bl.id', 'b.id as bill_id', 'b.internal_no', 'b.vendor_invoice_no', 'c.display_name']).where('bl.id', 'in', billIds).execute()
    : [];
  const prods = prodIds.length ? await ex.selectFrom('productions').select(['id', 'number']).where('id', 'in', prodIds).execute() : [];
  let left = Math.max(0, line?.qty ?? 0);
  const rows = layers.map((l) => {
    const onHand = Math.min(left, l.qty);
    left -= onHand;
    const unit = l.qty > 0 ? l.cost / l.qty : 0;
    const b = l.source === 'bill' ? bills.find((x) => x.id === l.lineId) : undefined;
    const p = l.source === 'production' ? prods.find((x) => x.id === l.lineId) : undefined;
    return {
      date: l.date ?? '', source: l.source ?? 'bill', documentId: b ? String(b.bill_id) : p ? String(p.id) : null,
      document: b ? `${b.internal_no} (${b.vendor_invoice_no})` : p ? p.number : '', party: b?.display_name ?? null,
      receivedQty: l.receivedQty ?? l.qty, returnedQty: l.returnedQty ?? 0, qty: l.qty, onHandQty: onHand,
      ratePaise: Math.round(unit), valuePaise: Math.round(unit * onHand),
    };
  });
  // Units older than every layer (opening stock) are valued at the opening rate.
  const openingRate = line?.openingRatePaise ?? 0;
  return {
    asOf, itemId: String(itemId), valuation: line?.valuation ?? 'average', qty: line?.qty ?? 0, valuePaise: line?.valuePaise ?? 0,
    layers: rows, olderQty: left > 0 ? left : 0, olderRatePaise: openingRate, olderValuePaise: left > 0 ? Math.round(left * openingRate) : 0,
  };
}
