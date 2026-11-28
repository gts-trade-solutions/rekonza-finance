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

import { db, sql, transaction, type Executor, type Trx } from '../db';
import type { Paise } from '../../types';
import { toPaiseFromSql, toSqlFromPaise } from '../money-sql';
import { explodeKits } from './kits';
import { badRequest, conflict } from '../http';
import { assertPeriodOpen, postEntry, type DraftLine } from '../ledger/posting';
import { CODE, accountIds, requireAccount } from '../ledger/chart-of-accounts';
import { dayBefore, fifoLayers, fifoValue, stockPosition } from '../reports/stock';
import { inventoryInLedger } from '../reports/statements';
import { getPolicies } from './org-settings';
import { indiaToday } from './held-journals';
import { dayLabel } from '../../date-range';

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

/**
 * What these goods cost, item by item, at each item's cost on the day (its
 * catalogue price when it has none yet).
 *
 * A sale of a FIFO item takes its oldest units, so it costs what the FIFO
 * value of the stock loses when they go: the value before the sale less the
 * value after, from the same purchase layers the Inventory Valuation report
 * uses (reports/stock.ts). A return from a customer is the same movement run
 * backwards: the units come back as the ones that went out last, at what the
 * stack gains by them. Both are worked out on the report's own rounded values,
 * so the Inventory account and the report agree to the paisa sale by sale,
 * not only at a month-end true-up. `counted` says whether the stock position on
 * the day already counts this document (one that stands).
 */
async function costByItem(
  ex: Executor, orgId: number, date: string, given: { itemId: number | null; qty: number }[],
  how: { direction: 'out' | 'in'; counted: boolean },
): Promise<Map<number, Paise>> {
  // A kit costs what its components cost.
  const lines = await explodeKits(ex, orgId, given);
  const tracked = await trackedItems(ex, orgId, lines.map((l) => l.itemId));
  const out = new Map<number, Paise>();
  if (!tracked.size) return out;
  const pos = await stockPosition(ex, orgId, date, { includeArchived: true });
  const byId = new Map(pos.lines.map((l) => [Number(l.itemId), l]));
  const qtyOf = new Map<number, number>();
  for (const l of lines) if (l.itemId && tracked.has(l.itemId)) qtyOf.set(l.itemId, (qtyOf.get(l.itemId) ?? 0) + l.qty);

  const fifo = [...qtyOf.keys()].filter((id) => byId.get(id)?.valuation === 'fifo');
  const layers = fifo.length ? await fifoLayers(ex, orgId, date) : new Map();
  const rates = fifo.length
    ? new Map((await ex.selectFrom('items').select(['id', 'opening_stock_rate', 'purchase_price']).where('org_id', '=', orgId).where('id', 'in', fifo).execute())
        .map((it) => [Number(it.id), toPaiseFromSql(it.opening_stock_rate ?? it.purchase_price)]))
    : new Map<number, number>();
  for (const [id, q] of qtyOf) {
    const line = byId.get(id);
    if (!line || q <= 0) continue;
    // The quantity on hand with the document's units, and without them.
    const withQty = how.counted ? line.qty : how.direction === 'out' ? line.qty : line.qty + q;
    const fewer = how.direction === 'out' ? (how.counted ? line.qty : line.qty - q) : withQty - q;
    const more = how.direction === 'out' ? fewer + q : withQty;
    if (line.valuation === 'fifo' && fewer >= 0) {
      const stack = layers.get(id) ?? [];
      const rate = rates.get(id) ?? 0;
      out.set(id, Math.round(fifoValue(stack, more, rate)) - Math.round(fifoValue(stack, fewer, rate)));
      continue;
    }
    // Average cost: what the report's value moves by between the two quantities.
    const unit = line.exactUnitCost ?? (line.unitCostPaise || tracked.get(id) || 0);
    out.set(id, Math.round(more * unit) - Math.round(fewer * unit) || Math.round((tracked.get(id) ?? 0) * q));
  }
  return out;
}

/** Inventory lines item by item against one account: `delta` is the change in each item's stock value. */
function inventoryLines(inventory: number, counter: number, delta: Map<number, Paise>, what: { in: string; out: string; counter: string }): DraftLine[] {
  const lines: DraftLine[] = [];
  let net = 0;
  for (const [itemId, d] of delta) {
    if (!d) continue;
    net += d;
    lines.push(d > 0 ? { accountId: inventory, debit: d, itemId, description: what.in } : { accountId: inventory, credit: -d, itemId, description: what.out });
  }
  if (net > 0) lines.push({ accountId: counter, credit: net, description: what.counter });
  else if (net < 0) lines.push({ accountId: counter, debit: -net, description: what.counter });
  return lines;
}

/** The lines a sale adds to its entry: the goods' cost out of Inventory, item by item. None on a periodic book. */
export async function saleCostLines(trx: Trx, orgId: number, date: string, invoiceId: number): Promise<DraftLine[]> {
  if (!(await perpetualOn(trx, orgId, date))) return [];
  const lines = await trx.selectFrom('invoice_lines').select(['item_id', 'qty']).where('invoice_id', '=', invoiceId).execute();
  // The stock position counts an invoice that stands; one still being approved is not in it yet.
  const inv = await trx.selectFrom('invoices').select('status').where('id', '=', invoiceId).executeTakeFirst();
  const counted = !!inv && inv.status !== 'draft' && inv.status !== 'void';
  const cost = await costByItem(trx, orgId, date, lines.map((l) => ({ itemId: l.item_id, qty: Number(l.qty) })), { direction: 'out', counted });
  const acc = await accountIds(trx, orgId);
  const out = new Map([...cost].map(([id, c]) => [id, -c] as const).filter(([, c]) => c < 0));
  return inventoryLines(requireAccount(acc, CODE.INVENTORY), requireAccount(acc, CODE.COGS), out,
    { in: 'Goods back into stock', out: 'Goods out of stock', counter: 'Cost of the goods sold' });
}

/** The lines a sales return adds: the goods back into Inventory at their cost, item by item. */
export async function returnCostLines(
  trx: Trx, orgId: number, date: string, lines: { itemId: number | null; qty: number }[],
): Promise<DraftLine[]> {
  if (!(await perpetualOn(trx, orgId, date))) return [];
  // The credit note's lines are written before its entry, so the stock position counts them.
  const cost = await costByItem(trx, orgId, date, lines, { direction: 'in', counted: true });
  const acc = await accountIds(trx, orgId);
  return inventoryLines(requireAccount(acc, CODE.INVENTORY), requireAccount(acc, CODE.COGS), new Map([...cost].filter(([, c]) => c > 0)),
    { in: 'Goods back into stock', out: 'Goods out of stock', counter: 'Cost of the goods returned' });
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

/** Each tracked item's value at the end of `date`, as the Inventory Valuation report gives it. */
export async function itemValues(ex: Executor, orgId: number, date: string): Promise<Map<number, Paise>> {
  const pos = await stockPosition(ex, orgId, date, { includeArchived: true });
  return new Map(pos.lines.map((l) => [Number(l.itemId), l.valuePaise]));
}

/** Each item's balance in the Inventory account at the end of `date`: its stock_postings rows (ledger/posting.ts). */
export async function itemLedgerValues(ex: Executor, orgId: number, date: string): Promise<Map<number, Paise>> {
  const rows = await ex.selectFrom('stock_postings').select((eb) => ['item_id', eb.fn.sum<string>('amount').as('v')])
    .where('org_id', '=', orgId).where('posting_date', '<=', date).groupBy('item_id').execute();
  return new Map(rows.map((r) => [Number(r.item_id), toPaiseFromSql(r.v ?? '0')]));
}

const minus = (a: Map<number, Paise>, b: Map<number, Paise>) => {
  const out = new Map<number, Paise>();
  for (const id of new Set([...a.keys(), ...b.keys()])) {
    const d = (a.get(id) ?? 0) - (b.get(id) ?? 0);
    if (d) out.set(id, d);
  }
  return out;
};

async function primaryBranch(trx: Trx, orgId: number): Promise<number> {
  return Number((await trx.selectFrom('branches').select('id').where('org_id', '=', orgId).where('is_primary', '=', 1).executeTakeFirstOrThrow()).id);
}

const ymdOf = (d: string | Date) => String(d instanceof Date ? d.toISOString() : d).slice(0, 10);

/**
 * A perpetual book that posted to Inventory before the account was kept item
 * by item (migration 131) gets a starting split: each item's value on the day
 * of its last Inventory posting, as a 'baseline' row. From then on every
 * posting is item by item; whatever the account held beyond the valuation on
 * that day stays unassigned, and the reconciliation report shows it as such.
 * Returns the baseline's date, or null when the book needs none.
 */
export async function ensureStockBaseline(trx: Trx, orgId: number): Promise<string | null> {
  const has = await trx.selectFrom('stock_postings').select('id').where('org_id', '=', orgId).limit(1).executeTakeFirst();
  if (has) {
    const b = await trx.selectFrom('stock_postings').select('posting_date').where('org_id', '=', orgId).where('source_type', '=', 'baseline').limit(1).executeTakeFirst();
    return b ? ymdOf(b.posting_date) : null;
  }
  const last = await sql<{ d: string | Date | null }>`
    SELECT MAX(jl.entry_date) AS d FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
     WHERE jl.org_id = ${orgId} AND a.code = ${CODE.INVENTORY}`.execute(trx);
  const d = last.rows[0]?.d;
  if (!d) return null;
  const day = ymdOf(d);
  const values = await itemValues(trx, orgId, day);
  const rows = [...values].filter(([, v]) => v !== 0).map(([itemId, v]) => ({
    org_id: orgId, entry_id: null, item_id: itemId, posting_date: day, amount: toSqlFromPaise(v), source_type: 'baseline', source_id: null,
  }));
  if (rows.length) await trx.insertInto('stock_postings').values(rows).execute();
  return day;
}

/**
 * Post what a stock document did to the value of stock, on a perpetual book:
 * each item's value on the document's date after it, less `before` (taken
 * before the document was written), into or out of Inventory against
 * `counterCode` (cost of goods sold unless said otherwise). Returns the entry,
 * or null on a periodic book or when the value did not move.
 */
export async function postStockChange(trx: Trx, orgId: number, userId: number | null, input: {
  date: string; before: Map<number, Paise>; sourceType: string; sourceId: number; memo: string;
  counterCode?: string; branchId?: number; describe?: { in: string; out: string; counter: string };
}): Promise<{ entryId: number; amountPaise: Paise } | null> {
  if (!(await perpetualOn(trx, orgId, input.date))) return null;
  await ensureStockBaseline(trx, orgId);
  const after = await itemValues(trx, orgId, input.date);
  const delta = minus(after, input.before);
  if (!delta.size) return null;
  const acc = await accountIds(trx, orgId);
  const lines = inventoryLines(requireAccount(acc, CODE.INVENTORY), requireAccount(acc, input.counterCode ?? CODE.COGS), delta,
    input.describe ?? { in: 'Goods into stock', out: 'Goods out of stock', counter: 'Cost of stock moved' });
  const entry = await postEntry(trx, {
    orgId, branchId: input.branchId ?? await primaryBranch(trx, orgId), date: input.date, module: 'accountant', userId,
    memo: input.memo, sourceType: input.sourceType, sourceId: input.sourceId, lines,
  });
  return { entryId: entry.id, amountPaise: [...delta.values()].reduce((t, v) => t + v, 0) };
}

/** Every day on or after `from` that some document moved stock, oldest first. */
async function movementDates(ex: Executor, orgId: number, from: string): Promise<string[]> {
  const { rows } = await sql<{ d: string | Date }>`
    SELECT DISTINCT d FROM (
      SELECT bill_date AS d FROM bills WHERE org_id = ${orgId} AND bill_date >= ${from}
      UNION SELECT receipt_date FROM goods_receipts WHERE org_id = ${orgId} AND receipt_date >= ${from}
      UNION SELECT invoice_date FROM invoices WHERE org_id = ${orgId} AND invoice_date >= ${from}
      UNION SELECT note_date FROM credit_notes WHERE org_id = ${orgId} AND note_date >= ${from}
      UNION SELECT credit_date FROM vendor_credits WHERE org_id = ${orgId} AND credit_date >= ${from}
      UNION SELECT adjust_date FROM stock_adjustments WHERE org_id = ${orgId} AND adjust_date >= ${from}
      UNION SELECT produced_on FROM productions WHERE org_id = ${orgId} AND produced_on >= ${from}
      UNION SELECT received_date FROM job_work_receipts WHERE org_id = ${orgId} AND received_date >= ${from}
      UNION SELECT allocated_on FROM landed_costs WHERE org_id = ${orgId} AND allocated_on >= ${from}
    ) x WHERE d IS NOT NULL ORDER BY d`.execute(ex);
  return rows.map((r) => ymdOf(r.d));
}

/** At most this many days are re-checked after one change; the month-end true-up and the report see the rest. */
const SYNC_DAYS = 120;

/**
 * The rule for a back-dated document, chosen and kept to: what was posted for
 * later documents stands, and the difference the back-dated one makes to the
 * cost of what left stock after it is posted as a visible cost variance, on
 * the day of each later movement it changes, with the reason in the entry's
 * memo ("Stock cost variance: bill BILL-5 dated 05 Nov 2026 …"). Re-costing
 * the later sales in place would rewrite entries already reported (the P&L of
 * a month already read, a GST return already filed); a variance entry leaves
 * every earlier figure as it was and shows exactly what changed and why, which
 * is what AS 2 / Ind AS 2 and an auditor want of a cost correction.
 *
 * So after any stock document on a perpetual book, each day from its date on
 * that some document moved stock is checked: each item's value per the
 * valuation against its balance in the Inventory account, and any difference
 * posted against cost of goods sold. A day in a locked period is left as it is
 * (the reconciliation report shows it). Returns the variance entries posted.
 */
export async function syncStockLedger(trx: Trx, orgId: number, userId: number | null, from: string, cause: string): Promise<{ date: string; amountPaise: Paise }[]> {
  const s = (await getPolicies(trx, orgId)).stockAccounting;
  if (s.method !== 'perpetual' || !s.from) return [];
  const baseline = await ensureStockBaseline(trx, orgId);
  const start = [from, s.from, baseline ?? ''].sort().pop()!;
  const days = (await movementDates(trx, orgId, start)).slice(0, SYNC_DAYS);
  const posted: { date: string; amountPaise: Paise }[] = [];
  if (!days.length) return posted;
  const acc = await accountIds(trx, orgId);
  const branch = await primaryBranch(trx, orgId);
  for (const day of days) {
    const [values, ledger] = await Promise.all([itemValues(trx, orgId, day), itemLedgerValues(trx, orgId, day)]);
    const delta = minus(values, ledger);
    if (!delta.size) continue;
    try {
      await assertPeriodOpen(trx, orgId, 'accountant', day);
    } catch {
      // A locked month keeps its figures; the reconciliation report shows the difference.
      break;
    }
    await postEntry(trx, {
      orgId, branchId: branch, date: day, module: 'accountant', userId,
      memo: `Stock cost variance: ${cause}`.slice(0, 500), sourceType: 'stock_variance', sourceId: Number(day.replace(/-/g, '')),
      lines: inventoryLines(requireAccount(acc, CODE.INVENTORY), requireAccount(acc, CODE.COGS), delta,
        { in: 'Stock value up: cost variance', out: 'Stock value down: cost variance', counter: 'Stock cost variance' }),
    });
    posted.push({ date: day, amountPaise: [...delta.values()].reduce((t, v) => t + v, 0) });
  }
  return posted;
}

/** On a perpetual book, the check above after a stock document dated `date`; nothing on a periodic one. */
export async function afterStockMoved(trx: Trx, orgId: number, userId: number | null, date: string, cause: string) {
  const s = (await getPolicies(trx, orgId)).stockAccounting;
  if (s.method !== 'perpetual' || !s.from) return [];
  return syncStockLedger(trx, orgId, userId, date, cause);
}

/**
 * Bring the Inventory account into line with the stock valued from the
 * documents, as at a date: the difference goes to cost of goods sold, item by
 * item, and whatever the account holds that is no item's (a manual journal)
 * is brought into line with it. Posted on the primary branch, once per date; a
 * later run posts only what has moved since. Returns the amount posted (0 when
 * already in line).
 */
export async function trueUpStock(trx: Trx, orgId: number, userId: number | null, asOf: string, memo?: string): Promise<Paise> {
  await ensureStockBaseline(trx, orgId);
  const [pos, posted, items] = await Promise.all([
    stockPosition(trx, orgId, asOf, { includeArchived: true }),
    inventoryInLedger(trx, orgId, asOf),
    itemLedgerValues(trx, orgId, asOf),
  ]);
  const diff = pos.totalValuePaise - posted;
  const delta = minus(new Map(pos.lines.map((l) => [Number(l.itemId), l.valuePaise])), items);
  const itemTotal = [...delta.values()].reduce((t, v) => t + v, 0);
  if (diff === 0 && !delta.size) return 0;
  const acc = await accountIds(trx, orgId);
  const inv = requireAccount(acc, CODE.INVENTORY);
  const cogs = requireAccount(acc, CODE.COGS);
  const lines = inventoryLines(inv, cogs, delta, { in: 'Stock brought into line', out: 'Stock brought into line', counter: 'Stock brought into line' });
  // What no item accounts for: the rest of the difference, on Inventory itself.
  const rest = diff - itemTotal;
  if (rest > 0) lines.push({ accountId: inv, debit: rest, description: 'Inventory not held for any item' }, { accountId: cogs, credit: rest });
  else if (rest < 0) lines.push({ accountId: cogs, debit: -rest }, { accountId: inv, credit: -rest, description: 'Inventory not held for any item' });
  await postEntry(trx, {
    orgId, branchId: await primaryBranch(trx, orgId), date: asOf, module: 'accountant', userId,
    memo: memo ?? `Stock brought into line with its valuation at ${dayLabel(asOf)}`,
    sourceType: 'stock_valuation', sourceId: Number(asOf.replace(/-/g, '')),
    lines,
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

/** The stock on hand the day before `from`, posted into the Inventory account on `from`, item by item. */
async function stockOnHandInto(trx: Trx, orgId: number, userId: number | null, from: string): Promise<Paise> {
  const before = dayBefore(from);
  const [values, ledger, total] = await Promise.all([itemValues(trx, orgId, before), itemLedgerValues(trx, orgId, before), inventoryInLedger(trx, orgId, before)]);
  const delta = minus(values, ledger);
  // Anything already on the Inventory account for no item (a journal before the
  // switch) is taken out of what goes in, so the account ends at the valuation.
  const unassigned = total - [...ledger.values()].reduce((t, v) => t + v, 0);
  if (!delta.size && !unassigned) return 0;
  const acc = await accountIds(trx, orgId);
  const inv = requireAccount(acc, CODE.INVENTORY);
  const cogs = requireAccount(acc, CODE.COGS);
  const lines = inventoryLines(inv, cogs, delta,
    { in: 'Stock on hand into the ledger', out: 'Stock on hand into the ledger', counter: 'Stock on hand into the ledger' });
  if (unassigned > 0) lines.push({ accountId: cogs, debit: unassigned }, { accountId: inv, credit: unassigned, description: 'Inventory not held for any item' });
  else if (unassigned < 0) lines.push({ accountId: inv, debit: -unassigned, description: 'Inventory not held for any item' }, { accountId: cogs, credit: -unassigned });
  await postEntry(trx, {
    orgId, branchId: await primaryBranch(trx, orgId), date: from, module: 'accountant', userId,
    memo: `Stock on hand taken into the ledger: perpetual inventory from ${dayLabel(from)}`,
    sourceType: 'stock_opening', sourceId: Number(from.replace(/-/g, '')), lines,
  });
  return [...delta.values()].reduce((t, v) => t + v, 0) - unassigned;
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
