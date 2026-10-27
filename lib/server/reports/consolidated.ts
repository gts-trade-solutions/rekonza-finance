import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Consolidated statements across the companies one person works in.
//
// Each company's profit and loss and balance sheet, account by account in
// columns, and their sum. Every book here carries the same chart, so an
// account code means the same thing in each. Only companies where the person
// may see the financial statements are included.
//
// Sales and balances between these companies are not taken out: a group that
// trades within itself has to eliminate those by hand (or by a journal in a
// consolidation book) before the totals are the group's.
// ─────────────────────────────────────────────────────────────────────────────

import type { Executor } from '../db';
import type { Paise, RoleName } from '../../types';
import { hasPermission, type CustomPermissions } from '../../rbac';
import { balanceSheet, profitAndLoss, type AccountBalance } from './statements';

export interface ConsolidatedRow { code: string; name: string; by: Record<string, Paise>; total: Paise }

/** The companies whose statements this person may see. */
async function companiesFor(ex: Executor, email: string) {
  const rows = await ex.selectFrom('users as u').innerJoin('organizations as o', 'o.id', 'u.org_id')
    .leftJoin('custom_roles as r', 'r.id', 'u.custom_role_id')
    .select(['u.org_id', 'o.name', 'o.legal_name', 'u.role', 'r.permissions'])
    .where('u.email', '=', email).where('u.is_active', '=', 1).orderBy('o.name').execute();
  return rows
    .filter((r) => hasPermission(r.role as RoleName, 'reports.financial', 'view',
      r.role !== 'admin' && r.permissions ? (typeof r.permissions === 'string' ? JSON.parse(r.permissions) : r.permissions) as CustomPermissions : null))
    .map((r) => ({ orgId: String(r.org_id), name: r.legal_name ?? r.name }));
}

function merge(sets: { orgId: string; rows: AccountBalance[] }[]): ConsolidatedRow[] {
  const by = new Map<string, ConsolidatedRow>();
  for (const s of sets) {
    for (const r of s.rows) {
      const row = by.get(r.code) ?? { code: r.code, name: r.name, by: {}, total: 0 };
      row.by[s.orgId] = (row.by[s.orgId] ?? 0) + r.balancePaise;
      row.total += r.balancePaise;
      by.set(r.code, row);
    }
  }
  return [...by.values()].filter((r) => r.total !== 0 || Object.values(r.by).some((v) => v !== 0)).sort((a, b) => a.code.localeCompare(b.code));
}

export async function consolidatedStatements(ex: Executor, email: string, from: string, to: string) {
  const companies = await companiesFor(ex, email);
  const each = await Promise.all(companies.map(async (c) => {
    const id = Number(c.orgId);
    const [pl, bs] = await Promise.all([profitAndLoss(ex, id, from, to), balanceSheet(ex, id, to)]);
    return { c, pl, bs };
  }));
  const sum = (f: (x: (typeof each)[number]) => Paise) => {
    const by: Record<string, Paise> = {};
    for (const x of each) by[x.c.orgId] = f(x);
    return { by, total: Object.values(by).reduce((t, v) => t + v, 0) };
  };
  return {
    from, to, companies,
    income: merge(each.map((x) => ({ orgId: x.c.orgId, rows: x.pl.incomeRows }))),
    expenses: merge(each.map((x) => ({ orgId: x.c.orgId, rows: x.pl.expenseRows }))),
    totalIncome: sum((x) => x.pl.totalIncome),
    // The ledger's expenses, adjusted by the change in stock, as each P&L shows them.
    totalExpense: sum((x) => x.pl.totalExpense + x.pl.openingStockPaise - x.pl.closingStockPaise),
    netProfit: sum((x) => x.pl.netProfit),
    totalAssets: sum((x) => x.bs.totalAssets),
    totalLiabilities: sum((x) => x.bs.totalLiabilities),
    totalEquity: sum((x) => x.bs.totalEquity),
  };
}
