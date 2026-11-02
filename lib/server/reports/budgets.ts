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
  variancePaise: Paise;
  pct: number;
  notes: string | null;
}

export interface BudgetVsActual {
  fy: string;
  from: string;
  to: string;
  asOf: string;
  elapsedPct: number;
  rows: BudgetRow[];
  totals: { budgetPaise: Paise; actualPaise: Paise };
}

/**
 * A year's budgets against what the journal shows. Year-to-date by default:
 * comparing a full-year budget against a full year of actuals that has not
 * happened yet makes everything look under budget.
 */
export async function budgetVsActual(ex: Executor, orgId: number, opts: { fy?: string; asOf?: string; today: string }): Promise<BudgetVsActual> {
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

  const { rows: actuals } = await sql<{ id: number; v: string }>`
    SELECT jl.account_id AS id, COALESCE(SUM(jl.debit - jl.credit), 0) AS v
      FROM journal_lines jl
     WHERE jl.org_id = ${orgId}
       AND jl.entry_date BETWEEN ${range.from} AND ${asOf}
     GROUP BY jl.account_id
  `.execute(ex);
  const actualBy = new Map(actuals.map((a) => [a.id, toPaiseFromSql(a.v)]));

  // How far through the year we are, so an account can be flagged as ahead of
  // pace rather than merely under its annual total.
  const elapsed = Math.max(
    0,
    Math.min(1, (new Date(asOf).getTime() - new Date(range.from).getTime())
      / (new Date(range.to).getTime() - new Date(range.from).getTime())),
  );

  const rows = budgets.map((b) => {
    const raw = actualBy.get(b.account_id) ?? 0;
    // Income is credit-normal, so its actual arrives negative from a
    // debit-minus-credit sum. Both sides are shown as positive spend/earn.
    const actual = b.type === 'income' ? -raw : raw;
    const budget = toPaiseFromSql(b.amount);
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
    };
  });

  return {
    fy,
    from: range.from,
    to: range.to,
    asOf,
    elapsedPct: elapsed * 100,
    rows,
    totals: {
      budgetPaise: rows.reduce((t, r) => t + r.budgetPaise, 0),
      actualPaise: rows.reduce((t, r) => t + r.actualPaise, 0),
    },
  };
}
