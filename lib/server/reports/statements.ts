import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Financial statements, computed in SQL from journal_lines.
//
// Nothing here is stored. Every figure is derived from the journal on each
// request, which is why two reports can never disagree — there is no cached
// total to fall out of date, and no "rebuild balances" job to forget to run.
//
// Aggregation happens in the database rather than in JavaScript. A year of a
// real book is hundreds of thousands of lines; shipping them to the server
// process to be summed would be slow long before it was wrong.
//
// One rule runs through all of it: which side increases an account depends on
// its type. Assets and expenses grow with debits, everything else with credits.
// Getting that backwards flips the sign of half the report and it still adds
// up, which is what makes it hard to spot.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor } from '../db';
import type { Paise } from '../../types';
import { toPaiseFromSql } from '../money-sql';
import { CODE } from '../ledger/chart-of-accounts';
import { dayBefore, fiscalStartMonth, fyStartFor, stockPosition } from './stock';

export type AccountType = 'asset' | 'liability' | 'equity' | 'income' | 'expense';

/** True when debits increase the account. */
export const isDebitNormal = (type: AccountType): boolean =>
  type === 'asset' || type === 'expense';

export interface AccountBalance {
  accountId: string;
  code: string;
  name: string;
  type: AccountType;
  subtype: string | null;
  debitPaise: Paise;
  creditPaise: Paise;
  /** Signed in the account's own direction: positive means a normal balance. */
  balancePaise: Paise;
}

interface RawBalance {
  id: number;
  code: string;
  name: string;
  type: AccountType;
  subtype: string | null;
  dr: string;
  cr: string;
}

/**
 * Every account's movement between two dates.
 *
 * `from` is optional: a balance sheet wants everything up to a date, while a
 * profit and loss wants only the period. That difference is the whole reason
 * the two reports exist — one is a position, the other is a performance.
 */
async function balances(
  ex: Executor,
  orgId: number,
  opts: { from?: string; to: string; branchId?: number },
): Promise<AccountBalance[]> {
  const from = opts.from ?? '1900-01-01';
  const branchFilter = opts.branchId
    ? sql`AND e.branch_id = ${opts.branchId}`
    : sql``;

  const { rows } = await sql<RawBalance>`
    SELECT a.id, a.code, a.name, a.type, a.subtype,
           COALESCE(SUM(jl.debit), 0)  AS dr,
           COALESCE(SUM(jl.credit), 0) AS cr
      FROM accounts a
      LEFT JOIN journal_lines jl
        -- The book first, so the (org_id, account_id, entry_date) index serves it.
        ON jl.org_id = a.org_id
       AND jl.account_id = a.id
       AND jl.entry_date BETWEEN ${from} AND ${opts.to}
      ${opts.branchId ? sql`LEFT JOIN journal_entries e ON e.id = jl.entry_id` : sql``}
     WHERE a.org_id = ${orgId} ${branchFilter}
     GROUP BY a.id, a.code, a.name, a.type, a.subtype
     ORDER BY a.code
  `.execute(ex);

  return rows.map((r) => {
    const debitPaise = toPaiseFromSql(r.dr);
    const creditPaise = toPaiseFromSql(r.cr);
    return {
      accountId: String(r.id),
      code: r.code,
      name: r.name,
      type: r.type,
      subtype: r.subtype,
      debitPaise,
      creditPaise,
      balancePaise: isDebitNormal(r.type) ? debitPaise - creditPaise : creditPaise - debitPaise,
    };
  });
}

/**
 * What the Inventory account holds at the end of a date.
 *
 * Stock enters the statements from the documents (stock.ts). A book on
 * perpetual inventory (services/stock-ledger.ts) also posts it: every sale's
 * cost out of Inventory, every purchase of stock into it, and a month-end entry
 * that brings the account into line with the documents. The statements then
 * add only what the ledger does not already carry — the stock value less this
 * — so a figure is never counted twice, and a periodic book, whose Inventory
 * account is empty, reads exactly as it always has.
 */
export async function inventoryInLedger(ex: Executor, orgId: number, asOf: string, branchId?: number): Promise<Paise> {
  const { rows } = await sql<{ v: string }>`
    SELECT COALESCE(SUM(jl.debit - jl.credit), 0) AS v
      FROM accounts a
      JOIN journal_lines jl ON jl.org_id = a.org_id AND jl.account_id = a.id AND jl.entry_date <= ${asOf}
      ${branchId ? sql`JOIN journal_entries e ON e.id = jl.entry_id AND e.branch_id = ${branchId}` : sql``}
     WHERE a.org_id = ${orgId} AND a.code = ${CODE.INVENTORY}
  `.execute(ex);
  return toPaiseFromSql(rows[0]?.v ?? '0');
}

// ── Trial balance ────────────────────────────────────────────────────────────

export interface TrialBalance {
  rows: (AccountBalance & { debitSide: Paise; creditSide: Paise })[];
  totalDebit: Paise;
  totalCredit: Paise;
  balanced: boolean;
}

/**
 * The proof that the books tie.
 *
 * Every account with a balance, on whichever side it naturally falls. The two
 * columns must agree exactly — not approximately — because every entry was
 * balanced when it was posted, so their sum has to be.
 */
export async function trialBalance(
  ex: Executor,
  orgId: number,
  asOf: string,
  branchId?: number,
): Promise<TrialBalance> {
  const all = await balances(ex, orgId, { to: asOf, branchId });

  const rows = all
    .filter((r) => r.debitPaise !== 0 || r.creditPaise !== 0)
    .map((r) => {
      const net = r.debitPaise - r.creditPaise;
      return { ...r, debitSide: net > 0 ? net : 0, creditSide: net < 0 ? -net : 0 };
    });

  const totalDebit = rows.reduce((t, r) => t + r.debitSide, 0);
  const totalCredit = rows.reduce((t, r) => t + r.creditSide, 0);

  return { rows, totalDebit, totalCredit, balanced: totalDebit === totalCredit };
}

// ── Profit and loss ──────────────────────────────────────────────────────────

export interface ProfitAndLoss {
  incomeRows: AccountBalance[];
  expenseRows: AccountBalance[];
  totalIncome: Paise;
  /** What the ledger expensed. Purchases are in here in full; the stock lines adjust them. */
  totalExpense: Paise;
  /** Stock on the shelf the day before the period began, and at its end. */
  openingStockPaise: Paise;
  closingStockPaise: Paise;
  /** Direct costs plus opening stock less closing stock: what the goods sold cost. */
  costOfGoodsSoldPaise: Paise;
  grossProfit: Paise;
  netProfit: Paise;
  from: string;
  to: string;
}

/**
 * Income less expenses for a period. Did we make money?
 *
 * Purchases are expensed when billed, so the period's cost includes goods that
 * are still unsold. The trading lines put that right the way every Indian
 * accountant reads it: add the stock the period started with, take off the
 * stock it ended with.
 */
export async function profitAndLoss(
  ex: Executor,
  orgId: number,
  from: string,
  to: string,
  branchId?: number,
): Promise<ProfitAndLoss> {
  const [all, opening, closing, postedOpening, postedClosing] = await Promise.all([
    balances(ex, orgId, { from, to, branchId }),
    stockPosition(ex, orgId, dayBefore(from), { branchId, includeArchived: true }),
    stockPosition(ex, orgId, to, { branchId, includeArchived: true }),
    inventoryInLedger(ex, orgId, dayBefore(from), branchId),
    inventoryInLedger(ex, orgId, to, branchId),
  ]);

  const incomeRows = all.filter((r) => r.type === 'income' && r.balancePaise !== 0);
  const expenseRows = all.filter((r) => r.type === 'expense' && r.balancePaise !== 0);

  const totalIncome = incomeRows.reduce((t, r) => t + r.balancePaise, 0);
  const totalExpense = expenseRows.reduce((t, r) => t + r.balancePaise, 0);

  // Direct costs — what the goods themselves cost — separated from overheads,
  // because the margin on trading is a different question from whether the
  // business covers its rent.
  const directCodes = new Set(['5100', '5200', '5300']);
  const directCost = expenseRows
    .filter((r) => directCodes.has(r.code))
    .reduce((t, r) => t + r.balancePaise, 0);

  // Only the stock the ledger does not carry already (inventoryInLedger).
  const openingStockPaise = opening.totalValuePaise - postedOpening;
  const closingStockPaise = closing.totalValuePaise - postedClosing;
  const costOfGoodsSoldPaise = directCost + openingStockPaise - closingStockPaise;

  return {
    incomeRows,
    expenseRows,
    totalIncome,
    totalExpense,
    openingStockPaise,
    closingStockPaise,
    costOfGoodsSoldPaise,
    grossProfit: totalIncome - costOfGoodsSoldPaise,
    netProfit: totalIncome - totalExpense + closingStockPaise - openingStockPaise,
    from,
    to,
  };
}

// ── Balance sheet ────────────────────────────────────────────────────────────

export interface BalanceSheet {
  assetRows: AccountBalance[];
  liabilityRows: AccountBalance[];
  /** Includes opening stock, which is an opening balance with no ledger of its own. */
  equityRows: AccountBalance[];
  totalAssets: Paise;
  totalLiabilities: Paise;
  totalEquity: Paise;
  /** Valued from the documents; it is in assetRows too. */
  closingStockPaise: Paise;
  /** Profit of earlier financial years. Nothing posts it, so it is worked out here. */
  priorYearsEarnings: Paise;
  /** This financial year's profit to date; part of what the owners hold. */
  currentPeriodEarnings: Paise;
  /** First day of the financial year `asOf` falls in. */
  fyStart: string;
  balanced: boolean;
  asOf: string;
}

/** Statement rows for figures that are computed rather than posted. */
function computedRow(id: string, name: string, type: AccountType, subtype: string, balancePaise: Paise): AccountBalance {
  return {
    accountId: id, code: '', name, type, subtype,
    debitPaise: isDebitNormal(type) ? balancePaise : 0,
    creditPaise: isDebitNormal(type) ? 0 : balancePaise,
    balancePaise,
  };
}

/**
 * What the business owns and owes on a single date.
 *
 * Assets must equal liabilities plus equity. Two pieces are worked out rather
 * than read from a ledger:
 *
 *   * Stock. It is an asset on the date, valued from the documents; its other
 *     side is the profit it adds back, and opening stock is opening equity.
 *
 *   * Profit. No entry ever moves a year's profit into retained earnings, so
 *     the earnings are split here: everything before this financial year is
 *     retained from earlier years, the rest is this year's. Leaving either out
 *     makes the sheet fail to balance by exactly that profit.
 */
export async function balanceSheet(
  ex: Executor,
  orgId: number,
  asOf: string,
  branchId?: number,
): Promise<BalanceSheet> {
  const fyStart = fyStartFor(asOf, await fiscalStartMonth(ex, orgId));
  const lastYearEnd = dayBefore(fyStart);

  const [all, beforeYear, stockNow, stockAtYearStart, postedNow, postedAtYearStart] = await Promise.all([
    balances(ex, orgId, { to: asOf, branchId }),
    balances(ex, orgId, { to: lastYearEnd, branchId }),
    stockPosition(ex, orgId, asOf, { branchId, includeArchived: true }),
    stockPosition(ex, orgId, lastYearEnd, { branchId, includeArchived: true }),
    inventoryInLedger(ex, orgId, asOf, branchId),
    inventoryInLedger(ex, orgId, lastYearEnd, branchId),
  ]);

  const profitIn = (rows: AccountBalance[]) =>
    rows.filter((r) => r.type === 'income').reduce((t, r) => t + r.balancePaise, 0) -
    rows.filter((r) => r.type === 'expense').reduce((t, r) => t + r.balancePaise, 0);

  const openingStock = stockNow.bookOpeningValuePaise;
  // The part of stock the Inventory account does not already hold (inventoryInLedger).
  const closingStockPaise = stockNow.totalValuePaise - postedNow;
  const stockAtYearStartPaise = stockAtYearStart.totalValuePaise - postedAtYearStart;
  const priorYearsEarnings = profitIn(beforeYear) + stockAtYearStartPaise - openingStock;
  const currentPeriodEarnings =
    profitIn(all) - profitIn(beforeYear) + closingStockPaise - stockAtYearStartPaise;

  const assetRows = all.filter((r) => r.type === 'asset' && r.balancePaise !== 0);
  if (closingStockPaise !== 0) {
    assetRows.push(computedRow('closing-stock', postedNow ? 'Stock not yet in the ledger' : 'Closing stock (weighted average cost)', 'asset', 'stock', closingStockPaise));
  }
  const liabilityRows = all.filter((r) => r.type === 'liability' && r.balancePaise !== 0);
  const equityRows = all.filter((r) => r.type === 'equity' && r.balancePaise !== 0);
  if (openingStock !== 0) {
    equityRows.push(computedRow('opening-stock', 'Opening stock (opening balance)', 'equity', 'opening', openingStock));
  }

  const totalAssets = assetRows.reduce((t, r) => t + r.balancePaise, 0);
  const totalLiabilities = liabilityRows.reduce((t, r) => t + r.balancePaise, 0);
  const totalEquity =
    equityRows.reduce((t, r) => t + r.balancePaise, 0) + priorYearsEarnings + currentPeriodEarnings;

  return {
    assetRows,
    liabilityRows,
    equityRows,
    totalAssets,
    totalLiabilities,
    totalEquity,
    closingStockPaise,
    priorYearsEarnings,
    currentPeriodEarnings,
    fyStart,
    balanced: totalAssets === totalLiabilities + totalEquity,
    asOf,
  };
}

// ── General ledger ───────────────────────────────────────────────────────────

export interface LedgerLine {
  entryId: string;
  entryNo: number;
  date: string;
  memo: string | null;
  description: string | null;
  sourceType: string;
  /** The document behind the entry, for drilling through to it. */
  sourceId: string | null;
  debitPaise: Paise;
  creditPaise: Paise;
  runningPaise: Paise;
  contactName: string | null;
}

/** One account, in order, with a running balance — how an auditor reads it. */
export async function generalLedger(
  ex: Executor,
  orgId: number,
  accountId: number,
  from: string,
  to: string,
): Promise<{ openingPaise: Paise; lines: LedgerLine[]; closingPaise: Paise }> {
  const account = await ex
    .selectFrom('accounts').select(['id', 'type'])
    .where('id', '=', accountId).where('org_id', '=', orgId).executeTakeFirst();
  if (!account) throw new Error('Account not found.');

  const debitNormal = isDebitNormal(account.type as AccountType);

  const { rows: opening } = await sql<{ dr: string; cr: string }>`
    SELECT COALESCE(SUM(debit), 0) AS dr, COALESCE(SUM(credit), 0) AS cr
      FROM journal_lines
     WHERE org_id = ${orgId} AND account_id = ${accountId} AND entry_date < ${from}
  `.execute(ex);

  const openingDr = toPaiseFromSql(opening[0]?.dr ?? '0');
  const openingCr = toPaiseFromSql(opening[0]?.cr ?? '0');
  const openingPaise = debitNormal ? openingDr - openingCr : openingCr - openingDr;

  const rows = await ex
    .selectFrom('journal_lines')
    .innerJoin('journal_entries', 'journal_entries.id', 'journal_lines.entry_id')
    .leftJoin('contacts', 'contacts.id', 'journal_lines.contact_id')
    .select([
      'journal_lines.entry_id', 'journal_lines.debit', 'journal_lines.credit',
      'journal_lines.description', 'journal_lines.entry_date',
      'journal_entries.entry_no', 'journal_entries.memo', 'journal_entries.source_type', 'journal_entries.source_id',
      'contacts.display_name as contact_name',
    ])
    .where('journal_lines.org_id', '=', orgId)
    .where('journal_lines.account_id', '=', accountId)
    .where('journal_lines.entry_date', '>=', from)
    .where('journal_lines.entry_date', '<=', to)
    .orderBy('journal_lines.entry_date')
    .orderBy('journal_entries.entry_no')
    .execute();

  let running = openingPaise;
  const lines: LedgerLine[] = rows.map((r) => {
    const debitPaise = toPaiseFromSql(r.debit);
    const creditPaise = toPaiseFromSql(r.credit);
    running += debitNormal ? debitPaise - creditPaise : creditPaise - debitPaise;
    return {
      entryId: String(r.entry_id),
      entryNo: r.entry_no,
      date: r.entry_date,
      memo: r.memo,
      description: r.description,
      sourceType: r.source_type,
      sourceId: r.source_id ? String(r.source_id) : null,
      debitPaise,
      creditPaise,
      runningPaise: running,
      contactName: r.contact_name,
    };
  });

  return { openingPaise, lines, closingPaise: running };
}

// ── Ageing ───────────────────────────────────────────────────────────────────

export const AGEING_BUCKETS = ['Current', '1–15', '16–30', '31–45', '46–60', '60+'] as const;

export interface AgeingRow {
  contactId: string;
  name: string;
  buckets: Record<string, Paise>;
  totalPaise: Paise;
}

/**
 * Receivables or payables, aged from the due date.
 *
 * From the *due* date, not the document date: an invoice on sixty-day terms is
 * not overdue on day thirty, and ageing it from when it was raised would show a
 * collections problem that does not exist.
 */
export async function ageing(
  ex: Executor,
  orgId: number,
  side: 'receivable' | 'payable',
  asOf: string,
): Promise<{ rows: AgeingRow[]; totals: Record<string, Paise>; grandTotalPaise: Paise }> {
  // The ageing is the subsidiary ledger behind the control account, so it has
  // to equal it — at every date, not only today.
  //
  // That is why the amount comes from the journal rather than from the current
  // balance on each document. A document's `amount_paid` is what it says right
  // now; asking what was owed on 31 March and reading today's payment status
  // against March's invoices gives a figure that belongs to neither date. The
  // journal, filtered to the as-of, is the only thing that knows.
  //
  // The buckets then come from the documents. Payments clear the oldest bills
  // first, so what is still owed is the newest: each party's balance is laid
  // against their documents newest first, and only what is left reaches the
  // older ones. Laying it oldest first would show a customer who pays
  // promptly as long overdue.
  const control = side === 'receivable' ? CODE.AR : CODE.AP;
  const sign = side === 'receivable' ? 1 : -1;

  const { rows: balances } = await sql<{ contact_id: number; name: string; v: string }>`
    SELECT jl.contact_id, c.display_name AS name,
           COALESCE(SUM(jl.debit - jl.credit), 0) AS v
      FROM journal_lines jl
      JOIN accounts a ON a.id = jl.account_id
      JOIN contacts c ON c.id = jl.contact_id
     WHERE jl.org_id = ${orgId} AND a.code = ${control}
       AND jl.contact_id IS NOT NULL
       AND jl.entry_date <= ${asOf}
     GROUP BY jl.contact_id, c.display_name
  `.execute(ex);

  // Each party's documents, newest due first, with the bills carried in as
  // openings among them.
  const opening = side === 'receivable' ? 'receivable' : 'payable';
  const { rows: docs } = side === 'receivable'
    ? await sql<{ contact_id: number; due_date: string; amount: string }>`
        SELECT contact_id, due_date, amount FROM (
          SELECT i.customer_id AS contact_id, i.due_date, i.total AS amount, i.id AS ord
            FROM invoices i
           WHERE i.org_id = ${orgId} AND i.status NOT IN ('void', 'draft')
             AND i.invoice_date <= ${asOf}
          UNION ALL
          SELECT d.contact_id, d.due_date, d.amount, -d.id
            FROM opening_documents d
           WHERE d.org_id = ${orgId} AND d.kind = ${opening} AND d.status <> 'void'
        ) x
         ORDER BY due_date DESC, ord DESC
      `.execute(ex)
    : await sql<{ contact_id: number; due_date: string; amount: string }>`
        SELECT contact_id, due_date, amount FROM (
          SELECT b.vendor_id AS contact_id, b.due_date, b.total AS amount, b.id AS ord
            FROM bills b
           WHERE b.org_id = ${orgId} AND b.status NOT IN ('void', 'draft')
             AND b.bill_date <= ${asOf}
          UNION ALL
          SELECT d.contact_id, d.due_date, d.amount, -d.id
            FROM opening_documents d
           WHERE d.org_id = ${orgId} AND d.kind = ${opening} AND d.status <> 'void'
        ) x
         ORDER BY due_date DESC, ord DESC
      `.execute(ex);

  const docsByContact = new Map<number, { dueDate: string; amount: Paise }[]>();
  for (const d of docs) {
    const list = docsByContact.get(d.contact_id) ?? [];
    list.push({ dueDate: String(d.due_date).slice(0, 10), amount: toPaiseFromSql(d.amount) });
    docsByContact.set(d.contact_id, list);
  }

  const bucketFor = (dueDate: string) => {
    const days = Math.floor(
      (new Date(asOf).getTime() - new Date(dueDate).getTime()) / 86_400_000,
    );
    return days <= 0 ? 'Current'
      : days <= 15 ? '1–15'
      : days <= 30 ? '16–30'
      : days <= 45 ? '31–45'
      : days <= 60 ? '46–60'
      : '60+';
  };

  const out: AgeingRow[] = [];
  const totals: Record<string, Paise> = Object.fromEntries(AGEING_BUCKETS.map((b) => [b, 0]));

  for (const b of balances) {
    // Signed in the party's own direction: what a customer owes us, or what we
    // owe a supplier. A negative means they are in credit.
    const owed = sign * toPaiseFromSql(b.v);
    if (owed === 0) continue;

    const row: AgeingRow = {
      contactId: String(b.contact_id),
      name: b.name,
      buckets: Object.fromEntries(AGEING_BUCKETS.map((x) => [x, 0])),
      totalPaise: owed,
    };

    if (owed < 0) {
      // A credit balance is not aged — nothing is overdue about money we hold.
      row.buckets.Current += owed;
      totals.Current += owed;
    } else {
      // Lay the balance against the documents, newest first. Anything left
      // over has no document behind it, such as a retainer still unpaid, and
      // belongs in Current.
      let left = owed;
      for (const d of docsByContact.get(b.contact_id) ?? []) {
        if (left <= 0) break;
        const applied = Math.min(left, d.amount);
        const bucket = bucketFor(d.dueDate);
        row.buckets[bucket] += applied;
        totals[bucket] += applied;
        left -= applied;
      }
      if (left > 0) {
        row.buckets.Current += left;
        totals.Current += left;
      }
    }

    out.push(row);
  }

  out.sort((a, b) => b.totalPaise - a.totalPaise);

  return {
    rows: out,
    totals,
    grandTotalPaise: out.reduce((t, r) => t + r.totalPaise, 0),
  };
}
