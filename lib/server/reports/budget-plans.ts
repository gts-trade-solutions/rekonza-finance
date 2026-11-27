import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Budgets by period, as Zoho Books keeps them, and Budget vs Actuals.
//
// A budget is a named plan for a financial year — "Original", "Revised" —
// entered month by month, by quarter, by half year or for the year, for the
// whole business or for one branch, cost centre or project. Its amounts sit
// per account per period; the actuals come from the journal, matched by
// account and narrowed by the same scope (line-filters.ts), so a budget's
// actual and a filtered report's figure are the same number.
//
// Reading a plan in other columns than it was entered in (a yearly plan month
// by month, a quarterly one by half year) spreads each period's amount by the
// days of it that fall in the column, which is how the old yearly budgets were
// always spread; they were moved into yearly plans (migration 130) and read
// exactly as before.
//
// Variance is actual less budget. Whether it is good depends on the account:
// income above budget is favourable, an expense above budget is unfavourable
// (ICAI's Guidance Note on Cost Audit and the standard variance convention);
// balance sheet lines carry a variance but no verdict.
//
// The primary plan of a year, when it covers the whole business, is also kept
// as yearly figures in the old budgets table, which the assistant and the
// controls review read.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor, Trx } from '../db';
import type { Paise } from '../../types';
import { toPaiseFromSql, toSqlFromPaise } from '../money-sql';
import { badRequest, conflict, notFound } from '../http';
import { lineOf, overrides } from './schedule-iii';
import { inventoryInLedger, type AccountBalance, type AccountType } from './statements';
import { stockPosition } from './stock';
import { lineFilterSql, type LineFilter } from './line-filters';
import { fyLabelFor, fyRange } from './budgets';
import { CODE } from '../ledger/chart-of-accounts';

export type BudgetPeriod = 'monthly' | 'quarterly' | 'half_yearly' | 'yearly';
export type ColumnMode = 'month' | 'quarter' | 'half' | 'year';
export const PERIOD_COUNT: Record<BudgetPeriod, number> = { monthly: 12, quarterly: 4, half_yearly: 2, yearly: 1 };

const DAY = 86_400_000;
const days = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY) + 1;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthEnd = (y: number, m0: number) => new Date(Date.UTC(y, m0 + 1, 0)).toISOString().slice(0, 10);

export interface PeriodSpan { no: number; label: string; from: string; to: string }

/** The periods of a plan: April to March in twelve, four, two or one. */
export function planPeriods(fy: string, period: BudgetPeriod | ColumnMode): PeriodSpan[] {
  const y = Number(fy.slice(0, 4));
  const size = period === 'monthly' || period === 'month' ? 1 : period === 'quarterly' || period === 'quarter' ? 3 : period === 'half_yearly' || period === 'half' ? 6 : 12;
  const out: PeriodSpan[] = [];
  for (let k = 0; k < 12 / size; k++) {
    const startM = 3 + k * size; // 0-based month index from January of y (3 = April)
    const sy = y + Math.floor(startM / 12), sm = startM % 12;
    const endM = startM + size - 1;
    const ey = y + Math.floor(endM / 12), em = endM % 12;
    const from = `${sy}-${String(sm + 1).padStart(2, '0')}-01`;
    const to = monthEnd(ey, em);
    const label = size === 1 ? `${MONTHS[sm]} ${sy}` : size === 3 ? `Q${k + 1} (${MONTHS[sm]}–${MONTHS[em]})` : size === 6 ? `H${k + 1} (${MONTHS[sm]}–${MONTHS[em]})` : `FY ${fy}`;
    out.push({ no: k + 1, label, from, to });
  }
  return out;
}

/** A plan's amounts (one per period) spread over a range by days. */
export function budgetFor(amounts: Paise[], periods: PeriodSpan[], from: string, to: string): Paise {
  let total = 0;
  periods.forEach((p, i) => {
    const a = amounts[i] ?? 0;
    if (!a) return;
    const s = p.from > from ? p.from : from;
    const e = p.to < to ? p.to : to;
    if (s > e) return;
    total += (a * days(s, e)) / days(p.from, p.to);
  });
  return Math.round(total);
}

// ── Plans ────────────────────────────────────────────────────────────────────

export interface PlanInput {
  id?: number | null;
  name: string;
  fyLabel: string;
  period: BudgetPeriod;
  branchId?: number | null;
  costCentreId?: number | null;
  projectId?: number | null;
  includeBalanceSheet?: boolean;
  isPrimary?: boolean;
  notes?: string | null;
  lines: { accountId: number; amountsPaise: Paise[] }[];
}

export interface PlanSummary {
  id: string; name: string; fyLabel: string; period: BudgetPeriod;
  branchId: string | null; branchName: string | null; costCentreId: string | null; costCentreName: string | null; projectId: string | null; projectName: string | null;
  includeBalanceSheet: boolean; isPrimary: boolean; notes: string | null;
  accounts: number; incomePaise: Paise; expensePaise: Paise; updatedAt: string;
}

export async function listPlans(ex: Executor, orgId: number, fy?: string): Promise<PlanSummary[]> {
  let q = ex.selectFrom('budget_plans as p')
    .leftJoin('branches as b', 'b.id', 'p.branch_id')
    .leftJoin('cost_centres as c', 'c.id', 'p.cost_centre_id')
    .leftJoin('projects as j', 'j.id', 'p.project_id')
    .select(['p.id', 'p.name', 'p.fy_label', 'p.period', 'p.branch_id', 'b.name as branch_name', 'p.cost_centre_id', 'c.name as cc_name', 'p.project_id', 'j.name as project_name',
      'p.include_balance_sheet', 'p.is_primary', 'p.notes', 'p.updated_at'])
    .where('p.org_id', '=', orgId);
  if (fy) q = q.where('p.fy_label', '=', fy);
  const plans = await q.orderBy('p.fy_label', 'desc').orderBy('p.is_primary', 'desc').orderBy('p.name').execute();
  const ids = plans.map((p) => p.id);
  const totals = ids.length ? (await sql<{ plan_id: number; type: string; n: number; v: string }>`
    SELECT l.plan_id, a.type, COUNT(DISTINCT l.account_id) AS n, SUM(l.amount) AS v
      FROM budget_plan_lines l JOIN accounts a ON a.id = l.account_id
     WHERE l.plan_id IN (${sql.join(ids)}) GROUP BY l.plan_id, a.type`.execute(ex)).rows : [];
  return plans.map((p) => {
    const t = totals.filter((x) => Number(x.plan_id) === Number(p.id));
    return {
      id: String(p.id), name: p.name, fyLabel: p.fy_label, period: p.period as BudgetPeriod,
      branchId: p.branch_id ? String(p.branch_id) : null, branchName: p.branch_name, costCentreId: p.cost_centre_id ? String(p.cost_centre_id) : null, costCentreName: p.cc_name,
      projectId: p.project_id ? String(p.project_id) : null, projectName: p.project_name,
      includeBalanceSheet: !!p.include_balance_sheet, isPrimary: !!p.is_primary, notes: p.notes,
      accounts: t.reduce((s, x) => s + Number(x.n), 0),
      incomePaise: toPaiseFromSql(t.find((x) => x.type === 'income')?.v ?? '0'),
      expensePaise: toPaiseFromSql(t.find((x) => x.type === 'expense')?.v ?? '0'),
      updatedAt: new Date(p.updated_at).toISOString(),
    };
  });
}

export async function getPlan(ex: Executor, orgId: number, id: number) {
  const p = (await listPlans(ex, orgId)).find((x) => x.id === String(id));
  if (!p) throw notFound('That budget does not exist.');
  const lines = await ex.selectFrom('budget_plan_lines as l').innerJoin('accounts as a', 'a.id', 'l.account_id')
    .select(['l.account_id', 'l.period_no', 'l.amount', 'a.code', 'a.name', 'a.type'])
    .where('l.plan_id', '=', id).orderBy('a.code').orderBy('l.period_no').execute();
  const n = PERIOD_COUNT[p.period];
  const byAccount = new Map<number, { accountId: string; code: string; name: string; type: AccountType; amountsPaise: Paise[] }>();
  for (const l of lines) {
    const row = byAccount.get(l.account_id) ?? { accountId: String(l.account_id), code: l.code, name: l.name, type: l.type as AccountType, amountsPaise: Array(n).fill(0) };
    if (l.period_no >= 1 && l.period_no <= n) row.amountsPaise[l.period_no - 1] = toPaiseFromSql(l.amount);
    byAccount.set(l.account_id, row);
  }
  return { ...p, periods: planPeriods(p.fyLabel, p.period), lines: [...byAccount.values()] };
}

async function checkScope(trx: Trx, orgId: number, input: PlanInput) {
  if (!/^\d{4}-\d{2}$/.test(input.fyLabel)) throw badRequest('Choose the financial year.');
  if (!(input.period in PERIOD_COUNT)) throw badRequest('Choose the budget period: monthly, quarterly, half-yearly or yearly.');
  const name = input.name.trim();
  if (name.length < 2) throw badRequest('Give the budget a name, such as "Original" or "Revised".');
  const one = async (table: 'branches' | 'cost_centres' | 'projects', id: number | null | undefined, what: string) => {
    if (!id) return null;
    const r = await trx.selectFrom(table as 'branches').select('id').where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
    if (!r) throw badRequest(`That ${what} does not exist.`);
    return id;
  };
  const scope = [input.branchId, input.costCentreId, input.projectId].filter(Boolean).length;
  if (scope > 1) throw badRequest('A budget is for the whole business, or for one branch, one cost centre or one project — choose one.');
  return {
    name, branchId: await one('branches', input.branchId, 'branch'), costCentreId: await one('cost_centres', input.costCentreId, 'cost centre'), projectId: await one('projects', input.projectId, 'project'),
  };
}

/** Create or change a plan: its settings and every amount, all at once. */
export async function savePlan(trx: Trx, orgId: number, userId: number | null, input: PlanInput): Promise<number> {
  const scope = await checkScope(trx, orgId, input);
  const n = PERIOD_COUNT[input.period];
  const accountIds = [...new Set(input.lines.map((l) => l.accountId))];
  const accounts = accountIds.length ? await trx.selectFrom('accounts').select(['id', 'type', 'name']).where('org_id', '=', orgId).where('id', 'in', accountIds).execute() : [];
  if (accounts.length !== accountIds.length) throw badRequest('One of those accounts does not exist.');
  for (const a of accounts) {
    if (!input.includeBalanceSheet && a.type !== 'income' && a.type !== 'expense') {
      throw badRequest(`${a.name} is a balance sheet account. Tick "Include asset and liability accounts" to budget it.`);
    }
  }
  for (const l of input.lines) {
    if (l.amountsPaise.length !== n) throw badRequest(`Each account needs ${n} amount${n === 1 ? '' : 's'} for a ${input.period.replace('_', '-')} budget.`);
    if (l.amountsPaise.some((x) => !Number.isInteger(x) || x < 0)) throw badRequest('Amounts are in whole paise and cannot be negative.');
  }
  const clash = await trx.selectFrom('budget_plans').select('id').where('org_id', '=', orgId).where('fy_label', '=', input.fyLabel).where('name', '=', scope.name)
    .$if(!!input.id, (q) => q.where('id', '!=', input.id!)).executeTakeFirst();
  if (clash) throw conflict(`There is already a budget called ${scope.name} for FY ${input.fyLabel}. Give this one another name, such as "Revised".`);

  const values = {
    name: scope.name, fy_label: input.fyLabel, period: input.period, branch_id: scope.branchId, cost_centre_id: scope.costCentreId, project_id: scope.projectId,
    include_balance_sheet: input.includeBalanceSheet ? 1 : 0, notes: input.notes?.trim() || null,
  };
  let id = input.id ?? null;
  if (id) {
    const r = await trx.updateTable('budget_plans').set(values).where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
    if (!Number(r.numUpdatedRows)) throw notFound('That budget does not exist.');
    await trx.deleteFrom('budget_plan_lines').where('plan_id', '=', id).execute();
  } else {
    id = Number((await trx.insertInto('budget_plans').values({ org_id: orgId, ...values, created_by_user_id: userId }).executeTakeFirstOrThrow()).insertId);
  }
  const rows = input.lines.flatMap((l) => l.amountsPaise.map((a, i) => ({ org_id: orgId, plan_id: id!, account_id: l.accountId, period_no: i + 1, amount: toSqlFromPaise(a) })).filter((r) => r.amount !== '0.00' && Number(r.amount) !== 0));
  for (let i = 0; i < rows.length; i += 500) await trx.insertInto('budget_plan_lines').values(rows.slice(i, i + 500)).execute();
  // The first whole-business plan of a year is its primary one unless another is.
  const primary = input.isPrimary ?? !(await trx.selectFrom('budget_plans').select('id').where('org_id', '=', orgId).where('fy_label', '=', input.fyLabel).where('is_primary', '=', 1).where('id', '!=', id).executeTakeFirst());
  await setPrimary(trx, orgId, id, primary && !scope.branchId && !scope.costCentreId && !scope.projectId);
  return id;
}

/** Mark a plan as its year's primary one, and keep the year's figures in the old yearly table for what reads it. */
async function setPrimary(trx: Trx, orgId: number, id: number, primary: boolean) {
  const p = await trx.selectFrom('budget_plans').select(['fy_label', 'is_primary']).where('id', '=', id).executeTakeFirstOrThrow();
  if (primary) {
    await trx.updateTable('budget_plans').set({ is_primary: 0 }).where('org_id', '=', orgId).where('fy_label', '=', p.fy_label).where('id', '!=', id).execute();
    await trx.updateTable('budget_plans').set({ is_primary: 1 }).where('id', '=', id).execute();
  } else if (p.is_primary) {
    await trx.updateTable('budget_plans').set({ is_primary: 0 }).where('id', '=', id).execute();
  }
  await mirrorPrimary(trx, orgId, p.fy_label);
}

async function mirrorPrimary(trx: Trx, orgId: number, fy: string) {
  await trx.deleteFrom('budgets').where('org_id', '=', orgId).where('fy_label', '=', fy).where('branch_id', '=', 0).execute();
  const prim = await trx.selectFrom('budget_plans').select('id').where('org_id', '=', orgId).where('fy_label', '=', fy).where('is_primary', '=', 1).executeTakeFirst();
  if (!prim) return;
  const { rows } = await sql<{ account_id: number; v: string }>`
    SELECT account_id, SUM(amount) AS v FROM budget_plan_lines WHERE plan_id = ${prim.id} GROUP BY account_id HAVING SUM(amount) > 0`.execute(trx);
  if (rows.length) {
    await trx.insertInto('budgets').values(rows.map((r) => ({ org_id: orgId, branch_id: 0, account_id: r.account_id, fy_label: fy, amount: toSqlFromPaise(toPaiseFromSql(r.v)), notes: null }))).execute();
  }
}

export async function deletePlan(trx: Trx, orgId: number, id: number) {
  const p = await trx.selectFrom('budget_plans').select(['name', 'fy_label', 'is_primary']).where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
  if (!p) throw notFound('That budget does not exist.');
  await trx.deleteFrom('budget_plan_lines').where('plan_id', '=', id).execute();
  await trx.deleteFrom('budget_plans').where('id', '=', id).execute();
  if (p.is_primary) await mirrorPrimary(trx, orgId, p.fy_label);
  return { name: p.name, fyLabel: p.fy_label };
}

/** A copy under a new name, for the same or another year, each amount raised or lowered by a percentage. */
export async function clonePlan(trx: Trx, orgId: number, userId: number | null, id: number, input: { name: string; fyLabel?: string; adjustPct?: number }) {
  const p = await getPlan(trx, orgId, id);
  const k = 1 + (input.adjustPct ?? 0) / 100;
  return savePlan(trx, orgId, userId, {
    name: input.name, fyLabel: input.fyLabel ?? p.fyLabel, period: p.period,
    branchId: p.branchId ? Number(p.branchId) : null, costCentreId: p.costCentreId ? Number(p.costCentreId) : null, projectId: p.projectId ? Number(p.projectId) : null,
    includeBalanceSheet: p.includeBalanceSheet, isPrimary: false, notes: p.notes,
    lines: p.lines.map((l) => ({ accountId: Number(l.accountId), amountsPaise: l.amountsPaise.map((a) => Math.round((a * k) / 100) * 100) })),
  });
}

// ── Actuals ─────────────────────────────────────────────────────────────────

/** A plan's scope as a journal-line filter. */
export const scopeFilter = (p: { branchId: string | null; costCentreId: string | null; projectId: string | null }): LineFilter => ({
  branchId: p.branchId ? Number(p.branchId) : null,
  costCentreIds: p.costCentreId ? [Number(p.costCentreId)] : [],
  projectIds: p.projectId ? [Number(p.projectId)] : [],
});

/** Each account's movement by month, in its own direction (income and liabilities credit less debit). */
async function actualsByMonth(ex: Executor, orgId: number, from: string, to: string, f: LineFilter, accountIds?: number[]) {
  const { rows } = await sql<{ account_id: number; type: AccountType; ym: string; v: string }>`
    SELECT jl.account_id, a.type, DATE_FORMAT(jl.entry_date, '%Y-%m') AS ym, SUM(jl.debit - jl.credit) AS v
      FROM journal_lines jl
      JOIN journal_entries e ON e.id = jl.entry_id
      JOIN accounts a ON a.id = jl.account_id
     WHERE jl.org_id = ${orgId} AND jl.entry_date BETWEEN ${from} AND ${to}
       ${accountIds?.length ? sql`AND jl.account_id IN (${sql.join(accountIds)})` : sql``}
       ${lineFilterSql(orgId, f)}
     GROUP BY jl.account_id, a.type, ym`.execute(ex);
  const out = new Map<number, Map<string, Paise>>();
  for (const r of rows) {
    const sign = r.type === 'asset' || r.type === 'expense' ? 1 : -1;
    const m = out.get(r.account_id) ?? new Map<string, Paise>();
    m.set(r.ym, sign * toPaiseFromSql(r.v));
    out.set(r.account_id, m);
  }
  return out;
}

const sumMonths = (m: Map<string, Paise> | undefined, from: string, to: string) => {
  if (!m) return 0;
  let t = 0;
  for (const [ym, v] of m) if (ym >= from.slice(0, 7) && ym <= to.slice(0, 7)) t += v;
  return t;
};

/** Last year's actuals per period, raised or lowered by a percentage: Zoho's "fill from actuals". */
export async function actualsForPlan(ex: Executor, orgId: number, input: {
  fyLabel: string; period: BudgetPeriod; accountIds: number[]; adjustPct?: number; branchId?: number | null; costCentreId?: number | null; projectId?: number | null; sourceFy?: string;
}) {
  const source = input.sourceFy ?? `${Number(input.fyLabel.slice(0, 4)) - 1}-${String(Number(input.fyLabel.slice(0, 4)) % 100).padStart(2, '0')}`;
  const range = fyRange(source);
  const periods = planPeriods(source, input.period);
  const f = scopeFilter({ branchId: input.branchId ? String(input.branchId) : null, costCentreId: input.costCentreId ? String(input.costCentreId) : null, projectId: input.projectId ? String(input.projectId) : null });
  const acts = await actualsByMonth(ex, orgId, range.from, range.to, f, input.accountIds.length ? input.accountIds : undefined);
  const k = 1 + (input.adjustPct ?? 0) / 100;
  const accounts = input.accountIds.length ? input.accountIds : [...acts.keys()];
  return {
    sourceFy: source,
    lines: accounts.map((id) => ({
      accountId: String(id),
      // Whole rupees: a budget is a plan, not a ledger.
      amountsPaise: periods.map((p) => Math.max(0, Math.round((sumMonths(acts.get(id), p.from, p.to) * k) / 100) * 100)),
    })),
  };
}

// ── Budget vs Actuals ───────────────────────────────────────────────────────

export interface VarianceCell { budgetPaise: Paise; actualPaise: Paise; variancePaise: Paise; variancePct: number | null; favourable: boolean | null; flagged: boolean }
export interface VarianceRow { accountId: string; code: string; name: string; type: AccountType; budgeted: boolean; computed?: boolean; cells: VarianceCell[]; total: VarianceCell }
export interface VarianceSection { key: string; label: string; rows: VarianceRow[]; total: { cells: VarianceCell[]; total: VarianceCell } }
export interface VarianceSummaryRow { key: string; label: string; cells: VarianceCell[]; total: VarianceCell }

export interface BudgetVsActuals {
  plan: Awaited<ReturnType<typeof getPlan>>;
  columns: { key: string; label: string; from: string; to: string }[];
  upto: string;
  thresholdPct: number;
  sections: VarianceSection[];
  summary: VarianceSummaryRow[];
  /** Why stock is or is not in the cost of goods sold, in words. */
  notes: string[];
}

/** One cell: plus is over budget; favourable when income is over or a cost is under. */
function cell(budget: Paise, actual: Paise, kind: 'income' | 'expense' | 'none', threshold: number): VarianceCell {
  const variance = actual - budget;
  const pct = budget !== 0 ? (variance / Math.abs(budget)) * 100 : null;
  const favourable = kind === 'none' ? null : kind === 'income' ? variance >= 0 : variance <= 0;
  return {
    budgetPaise: budget, actualPaise: actual, variancePaise: variance, variancePct: pct === null ? null : Math.round(pct * 10) / 10, favourable,
    flagged: pct !== null ? Math.abs(pct) > threshold : budget === 0 && actual !== 0 && kind !== 'none',
  };
}

// The grouping the profit and loss uses (statement-groups.ts), so the totals mean the same thing.
const COGS_LINES = new Set(['purchases_stock_in_trade', 'cost_of_materials', 'changes_in_inventories']);
const NON_OPERATING_EXPENSE_CODES = new Set<string>([CODE.FX_LOSS, CODE.LOSS_ON_ASSET_SALE]);

export async function budgetVsActuals(ex: Executor, orgId: number, planId: number, opts: { columns?: ColumnMode; upto?: string; thresholdPct?: number; today: string }): Promise<BudgetVsActuals> {
  const plan = await getPlan(ex, orgId, planId);
  const range = fyRange(plan.fyLabel);
  const threshold = opts.thresholdPct ?? 10;
  const upto = opts.upto && opts.upto >= range.from && opts.upto <= range.to ? opts.upto : range.to;
  const mode: ColumnMode = opts.columns ?? (plan.period === 'monthly' ? 'month' : plan.period === 'quarterly' ? 'quarter' : plan.period === 'half_yearly' ? 'half' : 'year');
  const columns = planPeriods(plan.fyLabel, mode).filter((c) => c.from <= upto).map((c) => ({ key: `c${c.no}`, label: c.label, from: c.from, to: c.to < upto ? c.to : upto }));
  const f = scopeFilter(plan);
  const acts = await actualsByMonth(ex, orgId, range.from, upto, f);
  const over = await overrides(ex, orgId);

  // Every budgeted account, and every income and expense account with actuals in the scope, so the totals tie to the profit and loss.
  const budgeted = new Map(plan.lines.map((l) => [Number(l.accountId), l]));
  const ids = new Set<number>([...budgeted.keys()]);
  const accRows = await ex.selectFrom('accounts').select(['id', 'code', 'name', 'type', 'subtype']).where('org_id', '=', orgId).execute();
  for (const a of accRows) if ((a.type === 'income' || a.type === 'expense') && acts.has(a.id) && [...acts.get(a.id)!.values()].some((v) => v !== 0)) ids.add(a.id);
  const accounts = accRows.filter((a) => ids.has(a.id)).sort((a, b) => a.code.localeCompare(b.code));

  const sections: Record<string, VarianceSection> = {};
  const section = (key: string, label: string) => (sections[key] ??= { key, label, rows: [], total: { cells: [], total: cell(0, 0, 'none', threshold) } });
  for (const a of accounts) {
    const amounts = budgeted.get(a.id)?.amountsPaise ?? [];
    const kind = a.type === 'income' ? 'income' : a.type === 'expense' ? 'expense' : 'none';
    const cells = columns.map((c) => cell(budgetFor(amounts, plan.periods, c.from, c.to), sumMonths(acts.get(a.id), c.from, c.to), kind, threshold));
    const row: VarianceRow = {
      accountId: String(a.id), code: a.code, name: a.name, type: a.type as AccountType, budgeted: budgeted.has(a.id), cells,
      total: cell(cells.reduce((t, x) => t + x.budgetPaise, 0), cells.reduce((t, x) => t + x.actualPaise, 0), kind, threshold),
    };
    const ab = { accountId: String(a.id), code: a.code, name: a.name, type: a.type, subtype: a.subtype } as AccountBalance;
    const line = lineOf(ab, over) ?? '';
    if (a.type === 'income') section(line === 'other_income' ? 'other_income' : 'income', line === 'other_income' ? 'Non Operating Income' : 'Operating Income').rows.push(row);
    else if (a.type === 'expense') {
      if (COGS_LINES.has(line)) section('cogs', 'Cost of Goods Sold').rows.push(row);
      else if (line === 'finance_costs' || NON_OPERATING_EXPENSE_CODES.has(a.code)) section('other_expense', 'Non Operating Expense').rows.push(row);
      else section('expense', 'Operating Expense').rows.push(row);
    } else section(a.type, a.type === 'asset' ? 'Assets (movement)' : a.type === 'liability' ? 'Liabilities (movement)' : 'Equity (movement)').rows.push(row);
  }

  // The change in stock the profit and loss adds (opening less closing stock not in the ledger), so gross and net profit tie to it.
  const notes: string[] = [];
  if (!plan.costCentreId && !plan.projectId) {
    const branchId = plan.branchId ? Number(plan.branchId) : undefined;
    const bounds = [...new Set(columns.flatMap((c) => [dayBefore(c.from), c.to]))];
    const value = new Map<string, Paise>();
    for (const d of bounds) {
      const [pos, posted] = await Promise.all([stockPosition(ex, orgId, d, { branchId, includeArchived: true }), inventoryInLedger(ex, orgId, d, branchId)]);
      value.set(d, pos.totalValuePaise - posted);
    }
    const change = columns.map((c) => (value.get(dayBefore(c.from)) ?? 0) - (value.get(c.to) ?? 0));
    if (change.some((v) => v !== 0)) {
      const cells = change.map((v) => cell(0, v, 'none', threshold));
      section('cogs', 'Cost of Goods Sold').rows.push({
        accountId: 'stock-change', code: '', name: 'Change in stock (opening less closing, from the profit and loss)', type: 'expense', budgeted: false, computed: true, cells,
        total: cell(0, change.reduce((t, v) => t + v, 0), 'none', threshold),
      });
      notes.push('Change in stock is the profit and loss\'s own adjustment for goods still on hand; it has no budget, and is shown so gross and net profit agree with the profit and loss.');
    }
  } else {
    notes.push(`Actuals are the ledger lines of this ${plan.costCentreId ? 'cost centre' : 'project'} only. Stock on hand belongs to no ${plan.costCentreId ? 'cost centre' : 'project'}, so the profit and loss's stock adjustment is left out.`);
  }

  const order = ['income', 'cogs', 'expense', 'other_income', 'other_expense', 'asset', 'liability', 'equity'];
  const list = order.filter((k) => sections[k]).map((k) => sections[k]);
  const kindOf = (k: string) => (k === 'income' || k === 'other_income' ? 'income' : k === 'asset' || k === 'liability' || k === 'equity' ? 'none' : 'expense');
  for (const s of list) {
    s.total.cells = columns.map((_, i) => cell(s.rows.reduce((t, r) => t + r.cells[i].budgetPaise, 0), s.rows.reduce((t, r) => t + r.cells[i].actualPaise, 0), kindOf(s.key) as 'income', threshold));
    s.total.total = cell(s.rows.reduce((t, r) => t + r.total.budgetPaise, 0), s.rows.reduce((t, r) => t + r.total.actualPaise, 0), kindOf(s.key) as 'income', threshold);
  }
  const at = (k: string, i: number | 'total', side: 'budgetPaise' | 'actualPaise') => {
    const s = sections[k];
    if (!s) return 0;
    return i === 'total' ? s.total.total[side] : s.total.cells[i][side];
  };
  const combine = (key: string, label: string, plus: string[], minus: string[]): VarianceSummaryRow => {
    const make = (i: number | 'total') => cell(
      plus.reduce((t, k) => t + at(k, i, 'budgetPaise'), 0) - minus.reduce((t, k) => t + at(k, i, 'budgetPaise'), 0),
      plus.reduce((t, k) => t + at(k, i, 'actualPaise'), 0) - minus.reduce((t, k) => t + at(k, i, 'actualPaise'), 0),
      'income', threshold);
    return { key, label, cells: columns.map((_, i) => make(i)), total: make('total') };
  };
  const summary = [
    combine('gross', 'Gross Profit', ['income'], ['cogs']),
    combine('operating', 'Operating Profit', ['income'], ['cogs', 'expense']),
    combine('net', 'Net Profit', ['income', 'other_income'], ['cogs', 'expense', 'other_expense']),
  ];
  return { plan, columns, upto, thresholdPct: threshold, sections: list, summary, notes };
}

function dayBefore(d: string) {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() - 1);
  return t.toISOString().slice(0, 10);
}

/**
 * Costing: each cost centre's budget against what its lines show for the
 * year — income, expense and the net — from the plans set for a cost centre,
 * and every cost centre with lines but no plan, so nothing spent is unseen.
 */
export async function costCentreSummary(ex: Executor, orgId: number, fy: string, upto?: string) {
  const range = fyRange(fy);
  const end = upto && upto <= range.to ? upto : range.to;
  const plans = (await listPlans(ex, orgId, fy)).filter((p) => p.costCentreId);
  const centres = await ex.selectFrom('cost_centres').select(['id', 'code', 'name']).where('org_id', '=', orgId).orderBy('code').execute();
  const { rows } = await sql<{ cc: number; type: string; v: string }>`
    SELECT jl.cost_centre_id AS cc, a.type, SUM(jl.debit - jl.credit) AS v
      FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
     WHERE jl.org_id = ${orgId} AND jl.cost_centre_id IS NOT NULL AND jl.entry_date BETWEEN ${range.from} AND ${end} AND a.type IN ('income', 'expense')
     GROUP BY jl.cost_centre_id, a.type`.execute(ex);
  const out = [];
  for (const c of centres) {
    const plan = plans.find((p) => p.costCentreId === String(c.id) && p.isPrimary) ?? plans.find((p) => p.costCentreId === String(c.id));
    const actualIncome = -toPaiseFromSql(rows.find((r) => Number(r.cc) === c.id && r.type === 'income')?.v ?? '0');
    const actualExpense = toPaiseFromSql(rows.find((r) => Number(r.cc) === c.id && r.type === 'expense')?.v ?? '0');
    if (!plan && !actualIncome && !actualExpense) continue;
    let budgetIncome = 0, budgetExpense = 0;
    if (plan) {
      const full = await getPlan(ex, orgId, Number(plan.id));
      for (const l of full.lines) {
        const b = budgetFor(l.amountsPaise, full.periods, range.from, end);
        if (l.type === 'income') budgetIncome += b; else if (l.type === 'expense') budgetExpense += b;
      }
    }
    out.push({
      costCentreId: String(c.id), code: c.code, name: c.name, planId: plan?.id ?? null, planName: plan?.name ?? null,
      income: cell(budgetIncome, actualIncome, 'income', 10), expense: cell(budgetExpense, actualExpense, 'expense', 10),
      net: cell(budgetIncome - budgetExpense, actualIncome - actualExpense, 'income', 10),
    });
  }
  return { fy, from: range.from, to: end, centres: out };
}

/** The financial years a book can budget for: last year, this year, next year, and any with plans. */
export async function budgetYears(ex: Executor, orgId: number, today: string) {
  const now = fyLabelFor(today);
  const y = Number(now.slice(0, 4));
  const label = (s: number) => `${s}-${String((s + 1) % 100).padStart(2, '0')}`;
  const have = (await ex.selectFrom('budget_plans').select('fy_label').distinct().where('org_id', '=', orgId).execute()).map((r) => r.fy_label);
  return [...new Set([label(y + 1), now, label(y - 1), ...have])].sort().reverse();
}
