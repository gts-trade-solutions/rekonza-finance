// ─────────────────────────────────────────────────────────────────────────────
// Budget vs actual.
//
// The actuals come from the journal, not from a second store of numbers, and
// they are matched to the budget by account id. That is the whole reason
// budgets are held per account: there is no category mapping in the middle for
// the two sides to disagree about.
//
// The Budgets page and the assistant both read this, so the figure the
// assistant quotes is the figure on the page.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor } from '../db';
import type { Paise } from '../../types';
import { toPaiseFromSql } from '../money-sql';

/** '2026-27' for any date in the 2026-27 financial year. India runs Apr–Mar. */
export function fyLabelFor(date: string): string {
  const [y, m] = date.split('-').map(Number);
  const start = m < 4 ? y - 1 : y;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

export function fyRange(label: string): { from: string; to: string } {
  const start = Number(label.slice(0, 4));
  return { from: `${start}-04-01`, to: `${start + 1}-03-31` };
}

export interface BudgetRow {
  id: string;
  accountId: string;
  code: string;
  name: string;
  type: string;
  budgetPaise: Paise;
  actualPaise: Paise;
  /** What is left of the year's budget: budget less actual. */
  variancePaise: Paise;
  pct: number;
  notes: string | null;
  /** The year's budget spread evenly over the days gone, to the as-at date. */
  budgetToDatePaise: Paise;
  /** Against the budget to date, signed so that plus is good: spending under, or earning over. */
  varianceToDatePaise: Paise;
  /** That variance as a share of the budget to date. */
  variancePct: number;
  favourable: boolean;
  /** Month by month, from April to the as-at month: the month's share of the budget, and the actual. */
  months: { month: string; budgetPaise: Paise; actualPaise: Paise; variancePaise: Paise }[];
}

export interface BudgetVsActual {
  fy: string;
  from: string;
  to: string;
  asOf: string;
  elapsedPct: number;
  /** The actuals' filters, when narrowed: one branch, one cost centre. */
  branchId: string | null;
  costCentreId: string | null;
  months: string[];
  rows: BudgetRow[];
  totals: { budgetPaise: Paise; actualPaise: Paise; budgetToDatePaise: Paise; varianceToDatePaise: Paise };
}

const DAY = 86_400_000;
const days = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY) + 1;

/**
 * A year's budgets against what the journal shows. Year-to-date by default:
 * comparing a full-year budget against a full year of actuals that has not
 * happened yet makes everything look under budget.
 */
export async function budgetVsActual(ex: Executor, orgId: number, opts: {
  fy?: string; asOf?: string; today: string; branchId?: number | null; costCentreId?: number | null;
}): Promise<BudgetVsActual> {
  const fy = opts.fy ?? fyLabelFor(opts.today);
  const range = fyRange(fy);
  const asOf = opts.asOf ?? (opts.today < range.to ? opts.today : range.to);

  const budgets = await ex
    .selectFrom('budgets')
    .innerJoin('accounts', 'accounts.id', 'budgets.account_id')
    .select([
      'budgets.id', 'budgets.account_id', 'budgets.amount', 'budgets.notes',
      'accounts.code', 'accounts.name', 'accounts.type',
    ])
    .where('budgets.org_id', '=', orgId)
    .where('budgets.fy_label', '=', fy)
    .orderBy('accounts.code')
    .execute();

  // Actuals by account and month, narrowed to a branch (its entries) or a cost centre (its lines) when asked.
  const branch = opts.branchId ? sql`AND je.branch_id = ${opts.branchId}` : sql``;
  const centre = opts.costCentreId ? sql`AND jl.cost_centre_id = ${opts.costCentreId}` : sql``;
  const { rows: actuals } = await sql<{ id: number; ym: string; v: string }>`
    SELECT jl.account_id AS id, DATE_FORMAT(jl.entry_date, '%Y-%m') AS ym, COALESCE(SUM(jl.debit - jl.credit), 0) AS v
      FROM journal_lines jl
      JOIN journal_entries je ON je.id = jl.entry_id
     WHERE jl.org_id = ${orgId}
       AND jl.entry_date BETWEEN ${range.from} AND ${asOf}
       ${branch} ${centre}
     GROUP BY jl.account_id, ym
  `.execute(ex);
  const actualBy = new Map<number, number>();
  const monthBy = new Map<string, number>();
  for (const a of actuals) {
    actualBy.set(a.id, (actualBy.get(a.id) ?? 0) + toPaiseFromSql(a.v));
    monthBy.set(`${a.id}|${a.ym}`, toPaiseFromSql(a.v));
  }
  // The months from April to the as-at month, each with its days for the budget's share.
  const months: { ym: string; from: string; to: string }[] = [];
  for (let d = new Date(`${range.from}T00:00:00Z`); d.toISOString().slice(0, 10) <= asOf;) {
    const ym = d.toISOString().slice(0, 7);
    const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
    months.push({ ym, from: `${ym}-01`, to: end < asOf ? end : asOf });
    d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  }
  const yearDays = days(range.from, range.to);
  const daysGone = days(range.from, asOf);

  // How far through the year we are, so an account can be flagged as ahead of
  // pace rather than merely under its annual total.
  const elapsed = Math.max(
    0,
    Math.min(1, (new Date(asOf).getTime() - new Date(range.from).getTime())
      / (new Date(range.to).getTime() - new Date(range.from).getTime())),
  );

  const rows = budgets.map((b) => {
    // Income is credit-normal, so its actual arrives negative from a
    // debit-minus-credit sum. Both sides are shown as positive spend/earn.
    const sign = b.type === 'income' ? -1 : 1;
    const actual = sign * (actualBy.get(b.account_id) ?? 0) || 0;
    const budget = toPaiseFromSql(b.amount);
    const toDate = Math.round((budget * daysGone) / yearDays);
    // Plus is good: an expense under its budget, or income over it.
    const good = (bud: number, act: number) => (b.type === 'income' ? act - bud : bud - act);
    const varianceToDate = good(toDate, actual);
    return {
      id: String(b.id),
      accountId: String(b.account_id),
      code: b.code,
      name: b.name,
      type: b.type,
      budgetPaise: budget,
      actualPaise: actual,
      variancePaise: budget - actual,
      pct: budget > 0 ? (actual / budget) * 100 : 0,
      notes: b.notes,
      budgetToDatePaise: toDate,
      varianceToDatePaise: varianceToDate,
      variancePct: toDate > 0 ? (varianceToDate / toDate) * 100 : 0,
      favourable: varianceToDate >= 0,
      months: months.map((m) => {
        const mb = Math.round((budget * days(m.from, m.to)) / yearDays);
        const ma = sign * (monthBy.get(`${b.account_id}|${m.ym}`) ?? 0) || 0;
        return { month: m.ym, budgetPaise: mb, actualPaise: ma, variancePaise: good(mb, ma) };
      }),
    };
  });

  return {
    fy,
    from: range.from,
    to: range.to,
    asOf,
    elapsedPct: elapsed * 100,
    branchId: opts.branchId ? String(opts.branchId) : null,
    costCentreId: opts.costCentreId ? String(opts.costCentreId) : null,
    months: months.map((m) => m.ym),
    rows,
    totals: {
      budgetPaise: rows.reduce((t, r) => t + r.budgetPaise, 0),
      actualPaise: rows.reduce((t, r) => t + r.actualPaise, 0),
      budgetToDatePaise: rows.reduce((t, r) => t + r.budgetToDatePaise, 0),
      varianceToDatePaise: rows.reduce((t, r) => t + r.varianceToDatePaise, 0),
    },
  };
}
