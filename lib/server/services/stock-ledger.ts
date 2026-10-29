import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Perpetual inventory: stock and the cost of what was sold, in the ledger.
//
// By default a book keeps stock as Tally does (reports/stock.ts): purchases
// are expensed, nothing posts when goods are sold, and the statements work out
// cost of goods sold as opening stock + purchases − closing stock. It is
// correct, but the ledger itself never shows a sale's cost or the stock on
// hand, and an auditor reading it sees inventory and cost of sales that
// nothing updates.
//
// A book switched to perpetual (Settings → Controls) posts them as it goes:
//
//   * a sale       — Dr Cost of Goods Sold, Cr Inventory, at the item's cost
//                    on the day, inside the invoice's own entry (so voiding the
//                    invoice takes the cost back out with it);
//   * a return     — the reverse, inside the credit note's entry;
//   * a purchase   — a stock line of a bill is debited to Inventory, not to
//                    Purchases;
//   * month end    — one entry brings the Inventory account into line with the
//                    stock valued from the documents, for what moves stock
//                    without a sale or a bill (adjustments, production, waste,
//                    a back-dated purchase changing the average).
//
// Switching posts the stock already on hand into the Inventory account, on
// the day perpetual starts, against cost of goods sold. The statements count
// only the stock the ledger does not carry yet (statements.ts
// inventoryInLedger), so profit is the same under either method and nothing is
// counted twice — even mid-month, before the month-end entry.
// ─────────────────────────────────────────────────────────────────────────────

import { db, transaction, type Executor, type Trx } from '../db';
import type { Paise } from '../../types';
import { toPaiseFromSql } from '../money-sql';
import { badRequest, conflict } from '../http';
import { postEntry, type DraftLine } from '../ledger/posting';
import { CODE, accountIds, requireAccount } from '../ledger/chart-of-accounts';
import { dayBefore, stockPosition } from '../reports/stock';
import { inventoryInLedger } from '../reports/statements';
import { getPolicies } from './org-settings';
import { indiaToday } from './held-journals';

/** Is the book on perpetual inventory on this date? */
export async function perpetualOn(ex: Executor, orgId: number, date: string): Promise<boolean> {
  const s = (await getPolicies(ex, orgId)).stockAccounting;
  return s.method === 'perpetual' && !!s.from && date >= s.from;
}

async function trackedItems(ex: Executor, orgId: number, ids: (number | null)[]): Promise<Map<number, Paise>> {
  const wanted = [...new Set(ids.filter((i): i is number => !!i))];
  if (!wanted.length) return new Map();
  const rows = await ex.selectFrom('items').select(['id', 'purchase_price']).where('org_id', '=', orgId)
    .where('id', 'in', wanted).where('kind', '=', 'goods').where('track_inventory', '=', 1).execute();
  return new Map(rows.map((r) => [Number(r.id), toPaiseFromSql(r.purchase_price)]));
}

/** What these goods cost, at each item's cost on the day (its catalogue price when it has none yet). */
async function costOf(ex: Executor, orgId: number, date: string, lines: { itemId: number | null; qty: number }[]): Promise<Paise> {
  const tracked = await trackedItems(ex, orgId, lines.map((l) => l.itemId));
  if (!tracked.size) return 0;
  const pos = await stockPosition(ex, orgId, date, { includeArchived: true });
  const unit = new Map(pos.lines.map((l) => [Number(l.itemId), l.unitCostPaise]));
  return lines.reduce((t, l) => {
    if (!l.itemId || !tracked.has(l.itemId)) return t;
    const cost = unit.get(l.itemId) || tracked.get(l.itemId) || 0;
    return t + Math.round(cost * l.qty);
  }, 0);
}

/** The lines a sale adds to its entry: the goods' cost out of Inventory. None on a periodic book. */
export async function saleCostLines(trx: Trx, orgId: number, date: string, invoiceId: number): Promise<DraftLine[]> {
  if (!(await perpetualOn(trx, orgId, date))) return [];
  const lines = await trx.selectFrom('invoice_lines').select(['item_id', 'qty']).where('invoice_id', '=', invoiceId).execute();
  const cost = await costOf(trx, orgId, date, lines.map((l) => ({ itemId: l.item_id, qty: Number(l.qty) })));
  if (cost <= 0) return [];
  const acc = await accountIds(trx, orgId);
  return [
    { accountId: requireAccount(acc, CODE.COGS), debit: cost, description: 'Cost of the goods sold' },
    { accountId: requireAccount(acc, CODE.INVENTORY), credit: cost, description: 'Goods out of stock' },
  ];
}

/** The lines a sales return adds: the goods back into Inventory at their cost. */
export async function returnCostLines(
  trx: Trx, orgId: number, date: string, lines: { itemId: number | null; qty: number }[],
): Promise<DraftLine[]> {
  if (!(await perpetualOn(trx, orgId, date))) return [];
  const cost = await costOf(trx, orgId, date, lines);
  if (cost <= 0) return [];
  const acc = await accountIds(trx, orgId);
  return [
    { accountId: requireAccount(acc, CODE.INVENTORY), debit: cost, description: 'Goods back into stock' },
    { accountId: requireAccount(acc, CODE.COGS), credit: cost, description: 'Cost of the goods returned' },
  ];
}

/**
 * For a bill: the account its stock lines are debited to on a perpetual book
 * (Inventory), and which of its items are stock. Null on a periodic book.
 */
export async function stockPurchaseAccount(
  trx: Trx, orgId: number, date: string, itemIds: (number | null)[],
): Promise<{ accountId: number; items: Set<number> } | null> {
  if (!(await perpetualOn(trx, orgId, date))) return null;
  const tracked = await trackedItems(trx, orgId, itemIds);
  if (!tracked.size) return null;
  const acc = await accountIds(trx, orgId);
  return { accountId: requireAccount(acc, CODE.INVENTORY), items: new Set(tracked.keys()) };
}

// ── Keeping the Inventory account true ──────────────────────────────────────

/**
 * Bring the Inventory account into line with the stock valued from the
 * documents, as at a date: the difference goes to cost of goods sold. Posted
 * on the primary branch, once per date; a later run posts only what has moved
 * since. Returns the amount posted (0 when already in line).
 */
export async function trueUpStock(trx: Trx, orgId: number, userId: number | null, asOf: string, memo?: string): Promise<Paise> {
  const [pos, posted] = await Promise.all([
    stockPosition(trx, orgId, asOf, { includeArchived: true }),
    inventoryInLedger(trx, orgId, asOf),
  ]);
  const diff = pos.totalValuePaise - posted;
  if (diff === 0) return 0;
  const acc = await accountIds(trx, orgId);
  const branch = await trx.selectFrom('branches').select('id').where('org_id', '=', orgId).where('is_primary', '=', 1).executeTakeFirstOrThrow();
  const inv = requireAccount(acc, CODE.INVENTORY);
  const cogs = requireAccount(acc, CODE.COGS);
  await postEntry(trx, {
    orgId, branchId: Number(branch.id), date: asOf, module: 'accountant', userId,
    memo: memo ?? `Stock brought into line with its valuation at ${asOf}`,
    sourceType: 'stock_valuation', sourceId: Number(asOf.replace(/-/g, '')),
    lines: diff > 0
      ? [{ accountId: inv, debit: diff }, { accountId: cogs, credit: diff }]
      : [{ accountId: cogs, debit: -diff }, { accountId: inv, credit: -diff }],
  });
  return diff;
}

/**
 * Put a book on perpetual inventory from a date (the first of a month). The
 * stock on hand the day before goes into the Inventory account on that date.
 */
export async function switchToPerpetual(trx: Trx, orgId: number, userId: number | null, from: string) {
  if (!/^\d{4}-\d{2}-01$/.test(from)) throw badRequest('Perpetual inventory starts on the first day of a month.');
  const current = (await getPolicies(trx, orgId)).stockAccounting;
  if (current.method === 'perpetual') throw conflict(`This book is already on perpetual inventory, from ${current.from}.`);
  // A locked period refuses the posting below, and the switch with it (posting.ts).
  await trx.insertInto('settings').values({
    org_id: orgId, scope: 'policy', setting_key: 'stockAccounting', value: JSON.stringify({ method: 'perpetual', from }), updated_by_user_id: userId,
  }).onDuplicateKeyUpdate({ value: JSON.stringify({ method: 'perpetual', from }), updated_by_user_id: userId }).execute();
  const opening = await stockOnHandInto(trx, orgId, userId, from);
  return { from, openingPaise: opening };
}

/** The stock on hand the day before `from`, posted into the Inventory account on `from`. */
async function stockOnHandInto(trx: Trx, orgId: number, userId: number | null, from: string): Promise<Paise> {
  const before = dayBefore(from);
  const [pos, posted] = await Promise.all([
    stockPosition(trx, orgId, before, { includeArchived: true }),
    inventoryInLedger(trx, orgId, before),
  ]);
  const value = pos.totalValuePaise - posted;
  if (value === 0) return 0;
  const acc = await accountIds(trx, orgId);
  const branch = await trx.selectFrom('branches').select('id').where('org_id', '=', orgId).where('is_primary', '=', 1).executeTakeFirstOrThrow();
  await postEntry(trx, {
    orgId, branchId: Number(branch.id), date: from, module: 'accountant', userId,
    memo: `Stock on hand taken into the ledger: perpetual inventory from ${from}`,
    sourceType: 'stock_opening', sourceId: Number(from.replace(/-/g, '')),
    lines: value > 0
      ? [{ accountId: requireAccount(acc, CODE.INVENTORY), debit: value }, { accountId: requireAccount(acc, CODE.COGS), credit: value }]
      : [{ accountId: requireAccount(acc, CODE.COGS), debit: -value }, { accountId: requireAccount(acc, CODE.INVENTORY), credit: -value }],
  });
  return value;
}

/**
 * From the scheduler: each perpetual book's Inventory account brought into
 * line at the end of the month just ended, once. A locked month is left for a
 * person, and shows up as a difference in the statements' "stock not yet in
 * the ledger" until they do.
 */
export async function runStockTrueUp(now = new Date()): Promise<number> {
  const today = indiaToday(now);
  const monthEnd = dayBefore(`${today.slice(0, 7)}-01`);
  const orgs = await db.selectFrom('organizations').select('id').execute();
  let n = 0;
  for (const o of orgs) {
    const orgId = Number(o.id);
    try {
      const s = (await getPolicies(db, orgId)).stockAccounting;
      if (s.method !== 'perpetual' || !s.from || monthEnd < s.from) continue;
      const done = await db.selectFrom('journal_entries').select('id').where('org_id', '=', orgId)
        .where('source_type', '=', 'stock_valuation').where('source_id', '=', Number(monthEnd.replace(/-/g, ''))).executeTakeFirst();
      if (done) continue;
      const moved = await transaction((trx) => trueUpStock(trx, orgId, null, monthEnd, `Month-end stock: Inventory brought into line at ${monthEnd}`));
      if (moved) n++;
    } catch (err) {
      console.error(`[stock-ledger] org ${o.id}`, err instanceof Error ? err.message : err);
    }
  }
  return n;
}
