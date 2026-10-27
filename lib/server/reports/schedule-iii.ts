import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// The balance sheet and profit and loss in the Schedule III layout.
//
// Schedule III to the Companies Act, 2013 (Division I, for companies following
// the Accounting Standards) fixes the headings a company's financial
// statements use, the order they come in, a column for the previous period,
// and — since the 2021 amendment — ageing tables for trade receivables and
// trade payables, payables split between MSME suppliers and others.
//
// The figures are the same ones the ordinary statements show; only the
// grouping changes. Each account lands on a line by its type, subtype and
// code, unless a CA has put it elsewhere (accounts.schedule_iii_line). Notes
// to the accounts, contingent liabilities and the like are for the person
// signing the statements and are not produced here.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor } from '../db';
import type { Paise } from '../../types';
import { toPaiseFromSql } from '../money-sql';
import { CODE } from '../ledger/chart-of-accounts';
import { balanceSheet, profitAndLoss, type AccountBalance } from './statements';

export const BS_LINES = {
  share_capital: { side: 'el', group: "Shareholders' funds", label: 'Share capital' },
  reserves_surplus: { side: 'el', group: "Shareholders' funds", label: 'Reserves and surplus' },
  long_term_borrowings: { side: 'el', group: 'Non-current liabilities', label: 'Long-term borrowings' },
  deferred_tax_liabilities: { side: 'el', group: 'Non-current liabilities', label: 'Deferred tax liabilities (net)' },
  other_long_term_liabilities: { side: 'el', group: 'Non-current liabilities', label: 'Other long-term liabilities' },
  long_term_provisions: { side: 'el', group: 'Non-current liabilities', label: 'Long-term provisions' },
  short_term_borrowings: { side: 'el', group: 'Current liabilities', label: 'Short-term borrowings' },
  trade_payables: { side: 'el', group: 'Current liabilities', label: 'Trade payables' },
  other_current_liabilities: { side: 'el', group: 'Current liabilities', label: 'Other current liabilities' },
  short_term_provisions: { side: 'el', group: 'Current liabilities', label: 'Short-term provisions' },
  ppe: { side: 'a', group: 'Non-current assets', label: 'Property, plant and equipment' },
  intangible_assets: { side: 'a', group: 'Non-current assets', label: 'Intangible assets' },
  cwip: { side: 'a', group: 'Non-current assets', label: 'Capital work-in-progress' },
  non_current_investments: { side: 'a', group: 'Non-current assets', label: 'Non-current investments' },
  deferred_tax_assets: { side: 'a', group: 'Non-current assets', label: 'Deferred tax assets (net)' },
  long_term_loans_advances: { side: 'a', group: 'Non-current assets', label: 'Long-term loans and advances' },
  other_non_current_assets: { side: 'a', group: 'Non-current assets', label: 'Other non-current assets' },
  current_investments: { side: 'a', group: 'Current assets', label: 'Current investments' },
  inventories: { side: 'a', group: 'Current assets', label: 'Inventories' },
  trade_receivables: { side: 'a', group: 'Current assets', label: 'Trade receivables' },
  cash_equivalents: { side: 'a', group: 'Current assets', label: 'Cash and cash equivalents' },
  short_term_loans_advances: { side: 'a', group: 'Current assets', label: 'Short-term loans and advances' },
  other_current_assets: { side: 'a', group: 'Current assets', label: 'Other current assets' },
} as const;

export const PL_LINES = {
  revenue_from_operations: { label: 'Revenue from operations', income: true },
  other_income: { label: 'Other income', income: true },
  cost_of_materials: { label: 'Cost of materials consumed', income: false },
  purchases_stock_in_trade: { label: 'Purchases of stock-in-trade', income: false },
  changes_in_inventories: { label: 'Changes in inventories of stock-in-trade', income: false },
  employee_benefits: { label: 'Employee benefits expense', income: false },
  finance_costs: { label: 'Finance costs', income: false },
  depreciation: { label: 'Depreciation and amortisation expense', income: false },
  other_expenses: { label: 'Other expenses', income: false },
} as const;

export type BsLine = keyof typeof BS_LINES;
export type PlLine = keyof typeof PL_LINES;

/** Where an account goes when nobody has said otherwise. */
export function defaultLine(a: { code: string; type: AccountBalance['type']; subtype: string | null }): BsLine | PlLine | null {
  switch (a.type) {
    case 'equity':
      // Drawings are shown as a deduction from the capital they came out of.
      return a.code === CODE.CAPITAL || a.subtype === 'drawings' ? 'share_capital' : 'reserves_surplus';
    case 'liability':
      if (a.code === CODE.AP) return 'trade_payables';
      if (a.subtype === 'credit_card' || a.subtype === 'bank_od') return 'short_term_borrowings';
      if (a.subtype === 'loan') return 'long_term_borrowings';
      if (a.subtype === 'provision') return 'short_term_provisions';
      if (a.subtype === 'deposit') return 'other_long_term_liabilities';
      return 'other_current_liabilities';
    case 'asset':
      // The provision for doubtful debts is shown netted against them.
      if (a.code === CODE.AR || a.code === CODE.DOUBTFUL_DEBTS_PROVISION) return 'trade_receivables';
      if (a.subtype === 'bank' || a.subtype === 'cash') return 'cash_equivalents';
      if (a.subtype === 'stock') return 'inventories';
      if (a.subtype === 'fixed_asset') return 'ppe';
      if (a.subtype === 'cwip') return 'cwip';
      if (a.subtype === 'intangible') return 'intangible_assets';
      if (a.subtype === 'investment') return 'non_current_investments';
      if (a.subtype === 'current_investment') return 'current_investments';
      if (a.subtype === 'deposit') return 'long_term_loans_advances';
      if (a.subtype === 'advance') return 'short_term_loans_advances';
      if (a.subtype === 'misc_expense') return 'other_non_current_assets';
      return 'other_current_assets';
    case 'income':
      return [CODE.OTHER_INCOME, CODE.PROFIT_ON_ASSET_SALE, CODE.DISCOUNT_RECEIVED, CODE.FX_GAIN].includes(a.code as never) ? 'other_income' : 'revenue_from_operations';
    case 'expense':
      // Freight inward is part of what the goods cost.
      if ([CODE.PURCHASES, CODE.COGS, CODE.FREIGHT].includes(a.code as never)) return 'purchases_stock_in_trade';
      if (a.code === CODE.SALARIES || a.code === CODE.EMPLOYER_CONTRIBUTIONS) return 'employee_benefits';
      if (a.code === CODE.TAX_INTEREST) return 'finance_costs';
      if (a.subtype === 'depreciation') return 'depreciation';
      return 'other_expenses';
  }
}

const sameDayLastYear = (d: string) => `${Number(d.slice(0, 4)) - 1}${d.slice(4)}`;

async function overrides(ex: Executor, orgId: number): Promise<Map<string, string>> {
  const rows = await ex.selectFrom('accounts').select(['id', 'schedule_iii_line'])
    .where('org_id', '=', orgId).where('schedule_iii_line', 'is not', null).execute();
  return new Map(rows.map((r) => [String(r.id), r.schedule_iii_line as string]));
}

function lineOf(row: AccountBalance, over: Map<string, string>): string | null {
  const o = over.get(row.accountId);
  if (o && (o in BS_LINES || o in PL_LINES)) return o;
  return defaultLine(row);
}

export interface StatementLine {
  key: string;
  group?: string;
  label: string;
  currentPaise: Paise;
  previousPaise: Paise;
  /** The accounts behind the figure, for drilling in. */
  accounts: { accountId: string; code: string; name: string; currentPaise: Paise; previousPaise: Paise }[];
}

// ── Ageing ───────────────────────────────────────────────────────────────────

const RECEIVABLE_BUCKETS = ['Less than 6 months', '6 months – 1 year', '1–2 years', '2–3 years', 'More than 3 years'] as const;
const PAYABLE_BUCKETS = ['Less than 1 year', '1–2 years', '2–3 years', 'More than 3 years'] as const;

export interface AgeingTable {
  buckets: string[];
  rows: { category: string; amounts: Paise[]; totalPaise: Paise }[];
  totalPaise: Paise;
}

/**
 * Schedule III ageing, from the due date of payment.
 *
 * Each party's balance on the date comes from the journal, so the table adds
 * up to the control account. It is laid against that party's documents newest
 * first: payments settle the oldest bills first, so what is still owed is the
 * most recent. Laying it against the oldest instead would make a regular
 * payer's balance look years overdue.
 */
async function scheduleAgeing(ex: Executor, orgId: number, side: 'receivable' | 'payable', asOf: string): Promise<AgeingTable> {
  const control = side === 'receivable' ? CODE.AR : CODE.AP;
  const sign = side === 'receivable' ? 1 : -1;
  const { rows: balances } = await sql<{ contact_id: number; is_msme: number; v: string }>`
    SELECT jl.contact_id, c.is_msme, COALESCE(SUM(jl.debit - jl.credit), 0) AS v
      FROM journal_lines jl
      JOIN accounts a ON a.id = jl.account_id
      JOIN contacts c ON c.id = jl.contact_id
     WHERE jl.org_id = ${orgId} AND a.code = ${control} AND jl.contact_id IS NOT NULL
       AND jl.entry_date <= ${asOf}
     GROUP BY jl.contact_id, c.is_msme
  `.execute(ex);
  // Bills carried in as openings age from their own due dates too.
  const { rows: docs } = side === 'receivable'
    ? await sql<{ contact_id: number; due_date: string; amount: string }>`
        SELECT contact_id, due_date, amount FROM (
          SELECT customer_id AS contact_id, due_date, total AS amount, id AS ord FROM invoices
           WHERE org_id = ${orgId} AND status NOT IN ('void', 'draft') AND invoice_date <= ${asOf}
          UNION ALL
          SELECT contact_id, due_date, amount, -id FROM opening_documents
           WHERE org_id = ${orgId} AND kind = 'receivable' AND status <> 'void'
        ) x ORDER BY due_date DESC, ord DESC`.execute(ex)
    : await sql<{ contact_id: number; due_date: string; amount: string }>`
        SELECT contact_id, due_date, amount FROM (
          SELECT vendor_id AS contact_id, due_date, total AS amount, id AS ord FROM bills
           WHERE org_id = ${orgId} AND status NOT IN ('void', 'draft') AND bill_date <= ${asOf}
          UNION ALL
          SELECT contact_id, due_date, amount, -id FROM opening_documents
           WHERE org_id = ${orgId} AND kind = 'payable' AND status <> 'void'
        ) x ORDER BY due_date DESC, ord DESC`.execute(ex);

  const byContact = new Map<number, { due: string; amount: Paise }[]>();
  for (const d of docs) {
    const list = byContact.get(d.contact_id) ?? [];
    list.push({ due: String(d.due_date).slice(0, 10), amount: toPaiseFromSql(d.amount) });
    byContact.set(d.contact_id, list);
  }

  const buckets: string[] = side === 'receivable' ? [...RECEIVABLE_BUCKETS] : [...PAYABLE_BUCKETS];
  const months = (due: string) => {
    const a = new Date(`${asOf}T00:00:00Z`);
    const b = new Date(`${due}T00:00:00Z`);
    return (a.getUTCFullYear() - b.getUTCFullYear()) * 12 + (a.getUTCMonth() - b.getUTCMonth()) - (a.getUTCDate() < b.getUTCDate() ? 1 : 0);
  };
  const bucketOf = (due: string) => {
    const m = Math.max(0, months(due));
    if (side === 'receivable') return m < 6 ? 0 : m < 12 ? 1 : m < 24 ? 2 : m < 36 ? 3 : 4;
    return m < 12 ? 0 : m < 24 ? 1 : m < 36 ? 2 : 3;
  };

  const categories = side === 'receivable' ? ['Undisputed — considered good'] : ['MSME', 'Others'];
  const rows = categories.map((category) => ({ category, amounts: buckets.map(() => 0), totalPaise: 0 }));
  for (const b of balances) {
    const owed = sign * toPaiseFromSql(b.v);
    if (owed <= 0) continue; // an advance is not a trade receivable or payable
    const row = side === 'receivable' ? rows[0] : rows[b.is_msme ? 0 : 1];
    let left = owed;
    for (const d of byContact.get(b.contact_id) ?? []) {
      if (left <= 0) break;
      const applied = Math.min(left, d.amount);
      row.amounts[bucketOf(d.due)] += applied;
      left -= applied;
    }
    if (left > 0) row.amounts[0] += left;
    row.totalPaise += owed;
  }
  return { buckets, rows, totalPaise: rows.reduce((t, r) => t + r.totalPaise, 0) };
}

// ── Balance sheet ────────────────────────────────────────────────────────────

export interface ScheduleIIIBalanceSheet {
  asOf: string;
  previousAsOf: string;
  equityAndLiabilities: StatementLine[];
  assets: StatementLine[];
  totals: { equityAndLiabilities: [Paise, Paise]; assets: [Paise, Paise] };
  /** Trade payables owed to micro and small enterprises, shown apart. */
  msmePayablesPaise: Paise;
  receivablesAgeing: AgeingTable;
  payablesAgeing: AgeingTable;
  balanced: boolean;
}

export async function scheduleIIIBalanceSheet(
  ex: Executor, orgId: number, asOf: string, branchId?: number,
): Promise<ScheduleIIIBalanceSheet> {
  const previousAsOf = sameDayLastYear(asOf);
  const [now, before, over, receivablesAgeing, payablesAgeing] = await Promise.all([
    balanceSheet(ex, orgId, asOf, branchId),
    balanceSheet(ex, orgId, previousAsOf, branchId),
    overrides(ex, orgId),
    scheduleAgeing(ex, orgId, 'receivable', asOf),
    scheduleAgeing(ex, orgId, 'payable', asOf),
  ]);

  const lines = new Map<string, StatementLine>();
  for (const key of Object.keys(BS_LINES) as BsLine[]) {
    lines.set(key, { key, group: BS_LINES[key].group, label: BS_LINES[key].label, currentPaise: 0, previousPaise: 0, accounts: [] });
  }
  const put = (rows: AccountBalance[], which: 'currentPaise' | 'previousPaise') => {
    for (const r of rows) {
      const key = lineOf(r, over);
      const line = key && lines.get(key);
      if (!line) continue;
      line[which] += r.balancePaise;
      let acc = line.accounts.find((a) => a.accountId === r.accountId);
      if (!acc) {
        acc = { accountId: r.accountId, code: r.code, name: r.name, currentPaise: 0, previousPaise: 0 };
        line.accounts.push(acc);
      }
      acc[which] += r.balancePaise;
    }
  };
  for (const [bs, which] of [[now, 'currentPaise'], [before, 'previousPaise']] as const) {
    put([...bs.assetRows, ...bs.liabilityRows, ...bs.equityRows], which);
    // Profit not moved by any entry is part of reserves and surplus.
    const rs = lines.get('reserves_surplus')!;
    rs[which] += bs.priorYearsEarnings + bs.currentPeriodEarnings;
  }

  const el = [...lines.values()].filter((l) => BS_LINES[l.key as BsLine].side === 'el');
  const assets = [...lines.values()].filter((l) => BS_LINES[l.key as BsLine].side === 'a');
  const sum = (ls: StatementLine[], k: 'currentPaise' | 'previousPaise') => ls.reduce((t, l) => t + l[k], 0);
  const totals = {
    equityAndLiabilities: [sum(el, 'currentPaise'), sum(el, 'previousPaise')] as [Paise, Paise],
    assets: [sum(assets, 'currentPaise'), sum(assets, 'previousPaise')] as [Paise, Paise],
  };

  return {
    asOf,
    previousAsOf,
    equityAndLiabilities: el,
    assets,
    totals,
    msmePayablesPaise: payablesAgeing.rows[0].totalPaise,
    receivablesAgeing,
    payablesAgeing,
    balanced: totals.assets[0] === totals.equityAndLiabilities[0] && totals.assets[1] === totals.equityAndLiabilities[1],
  };
}

// ── Profit and loss ──────────────────────────────────────────────────────────

export interface ScheduleIIIProfitAndLoss {
  from: string;
  to: string;
  previous: { from: string; to: string };
  income: StatementLine[];
  expenses: StatementLine[];
  totalIncome: [Paise, Paise];
  totalExpenses: [Paise, Paise];
  profitBeforeTax: [Paise, Paise];
  /** No tax provision is posted in the books; the CA adds current and deferred tax. */
  profitForThePeriod: [Paise, Paise];
}

export async function scheduleIIIProfitAndLoss(
  ex: Executor, orgId: number, from: string, to: string, branchId?: number,
): Promise<ScheduleIIIProfitAndLoss> {
  const previous = { from: sameDayLastYear(from), to: sameDayLastYear(to) };
  const [now, before, over] = await Promise.all([
    profitAndLoss(ex, orgId, from, to, branchId),
    profitAndLoss(ex, orgId, previous.from, previous.to, branchId),
    overrides(ex, orgId),
  ]);

  const lines = new Map<string, StatementLine>();
  for (const key of Object.keys(PL_LINES) as PlLine[]) {
    lines.set(key, { key, label: PL_LINES[key].label, currentPaise: 0, previousPaise: 0, accounts: [] });
  }
  for (const [pl, which] of [[now, 'currentPaise'], [before, 'previousPaise']] as const) {
    for (const r of [...pl.incomeRows, ...pl.expenseRows]) {
      const line = lines.get(lineOf(r, over) ?? '');
      if (!line) continue;
      line[which] += r.balancePaise;
      let acc = line.accounts.find((a) => a.accountId === r.accountId);
      if (!acc) {
        acc = { accountId: r.accountId, code: r.code, name: r.name, currentPaise: 0, previousPaise: 0 };
        line.accounts.push(acc);
      }
      acc[which] += r.balancePaise;
    }
    // Opening stock less closing stock: positive when stock was run down.
    lines.get('changes_in_inventories')![which] += pl.openingStockPaise - pl.closingStockPaise;
  }

  const income = [...lines.values()].filter((l) => PL_LINES[l.key as PlLine].income);
  const expenses = [...lines.values()].filter((l) => !PL_LINES[l.key as PlLine].income);
  const pair = (ls: StatementLine[]): [Paise, Paise] => [
    ls.reduce((t, l) => t + l.currentPaise, 0), ls.reduce((t, l) => t + l.previousPaise, 0),
  ];
  const totalIncome = pair(income);
  const totalExpenses = pair(expenses);
  const pbt: [Paise, Paise] = [totalIncome[0] - totalExpenses[0], totalIncome[1] - totalExpenses[1]];

  return {
    from, to, previous,
    income, expenses,
    totalIncome, totalExpenses,
    profitBeforeTax: pbt,
    profitForThePeriod: pbt,
  };
}
