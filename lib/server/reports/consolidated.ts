import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Consolidated statements across the companies one person works in.
//
// Each company's profit and loss and balance sheet, account by account in
// columns, an Eliminations column, and the group total. Every book here
// carries the same chart, so an account code means the same thing in each.
// Only companies where the person may see the financial statements can be
// chosen; any subset of them can be consolidated.
//
// Inter-company elimination. A company's customer or vendor is another group
// company when its PAN (or the PAN inside its GSTIN) is that company's PAN.
// Between group companies these come out of the group total:
//   · what each is owed by the others (Accounts Receivable) and owes them
//     (Accounts Payable), as at the date;
//   · the sales each made to the others and the purchases it made from them,
//     over the period (taxable value).
// Where one side's figure does not agree with the other's (a bill not yet
// entered, a payment in transit), the difference is shown, so the balance
// sheet's gap is explained rather than hidden. Profit still held in stock
// bought from a group company is not taken out; that needs the stock's cost.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor } from '../db';
import type { Paise, RoleName } from '../../types';
import { hasPermission, type CustomPermissions } from '../../rbac';
import { CODE } from '../ledger/chart-of-accounts';
import { toPaiseFromSql } from '../money-sql';
import { balanceSheet, profitAndLoss, type AccountBalance } from './statements';

export interface ConsolidatedRow { code: string; name: string; by: Record<string, Paise>; elimination: Paise; total: Paise }

export interface InterCompany {
  fromOrgId: string; fromName: string; toOrgId: string; toName: string;
  /** What `from` is owed by `to`, and what `to` says it owes `from`. */
  receivablePaise: Paise; counterpartPayablePaise: Paise;
  /** What `from` sold to `to` in the period, and what `to` says it bought from `from`. */
  salesPaise: Paise; counterpartPurchasesPaise: Paise;
}

/** The companies whose statements this person may see. */
async function companiesFor(ex: Executor, email: string) {
  const rows = await ex.selectFrom('users as u').innerJoin('organizations as o', 'o.id', 'u.org_id')
    .leftJoin('custom_roles as r', 'r.id', 'u.custom_role_id')
    .select(['u.org_id', 'o.name', 'o.legal_name', 'o.pan', 'u.role', 'r.permissions'])
    .where('u.email', '=', email).where('u.is_active', '=', 1).orderBy('o.name').execute();
  return rows
    .filter((r) => hasPermission(r.role as RoleName, 'reports.financial', 'view',
      r.role !== 'admin' && r.permissions ? (typeof r.permissions === 'string' ? JSON.parse(r.permissions) : r.permissions) as CustomPermissions : null))
    .map((r) => ({ orgId: String(r.org_id), name: r.legal_name ?? r.name, pan: r.pan?.toUpperCase() ?? null }));
}

/** Rows merged by account code, or by name for figures the statements compute (closing stock, earnings). */
function merge(sets: { orgId: string; rows: AccountBalance[] }[], elim: Map<string, Paise> = new Map()): ConsolidatedRow[] {
  const by = new Map<string, ConsolidatedRow>();
  for (const s of sets) {
    for (const r of s.rows) {
      const key = r.code || r.name;
      const row = by.get(key) ?? { code: r.code, name: r.name, by: {}, elimination: 0, total: 0 };
      row.by[s.orgId] = (row.by[s.orgId] ?? 0) + r.balancePaise;
      row.total += r.balancePaise;
      by.set(key, row);
    }
  }
  for (const [code, amount] of elim) {
    const row = by.get(code);
    if (!row || !amount) continue;
    row.elimination += amount;
    row.total += amount;
  }
  return [...by.values()].filter((r) => r.total !== 0 || Object.values(r.by).some((v) => v !== 0)).sort((a, b) => (a.code || 'zzzz').localeCompare(b.code || 'zzzz'));
}

/** Each company's dealings with the others, found by PAN. */
async function interCompany(ex: Executor, companies: { orgId: string; name: string; pan: string | null }[], from: string, to: string): Promise<InterCompany[]> {
  const byPan = new Map(companies.filter((c) => c.pan).map((c) => [c.pan!, c]));
  if (byPan.size < 2) return [];
  const pans = [...byPan.keys()];
  const out = new Map<string, InterCompany>();
  const pair = (a: { orgId: string; name: string }, b: { orgId: string; name: string }) => {
    const k = `${a.orgId}>${b.orgId}`;
    const v = out.get(k) ?? { fromOrgId: a.orgId, fromName: a.name, toOrgId: b.orgId, toName: b.name, receivablePaise: 0, counterpartPayablePaise: 0, salesPaise: 0, counterpartPurchasesPaise: 0 };
    out.set(k, v);
    return v;
  };
  for (const c of companies) {
    const orgId = Number(c.orgId);
    // The contacts in this book that are other group companies.
    const contacts = await ex.selectFrom('contacts').select(['id', 'pan', 'gstin'])
      .where('org_id', '=', orgId)
      .where((eb) => eb.or([eb('pan', 'in', pans), eb(sql<string>`SUBSTRING(gstin, 3, 10)`, 'in', pans)]))
      .execute();
    const other = new Map<number, (typeof companies)[number]>();
    for (const k of contacts) {
      const pan = (k.pan ?? k.gstin?.slice(2, 12) ?? '').toUpperCase();
      const co = byPan.get(pan);
      if (co && co.orgId !== c.orgId) other.set(Number(k.id), co);
    }
    if (!other.size) continue;
    const ids = [...other.keys()];
    const balances = await sql<{ contact_id: number; code: string; b: string }>`
      SELECT jl.contact_id, a.code, COALESCE(SUM(jl.debit - jl.credit), 0) AS b
        FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
       WHERE jl.org_id = ${orgId} AND jl.entry_date <= ${to} AND a.code IN (${CODE.AR}, ${CODE.AP})
         AND jl.contact_id IN (${sql.join(ids)})
       GROUP BY jl.contact_id, a.code
    `.execute(ex);
    const sales = await sql<{ customer_id: number; v: string }>`
      SELECT customer_id, COALESCE(SUM(subtotal), 0) AS v FROM invoices
       WHERE org_id = ${orgId} AND status NOT IN ('draft','void') AND invoice_date BETWEEN ${from} AND ${to} AND customer_id IN (${sql.join(ids)})
       GROUP BY customer_id
    `.execute(ex);
    const buys = await sql<{ vendor_id: number; v: string }>`
      SELECT vendor_id, COALESCE(SUM(subtotal), 0) AS v FROM bills
       WHERE org_id = ${orgId} AND status NOT IN ('draft','void') AND bill_date BETWEEN ${from} AND ${to} AND vendor_id IN (${sql.join(ids)})
       GROUP BY vendor_id
    `.execute(ex);
    for (const r of balances.rows) {
      const co = other.get(Number(r.contact_id))!;
      const v = toPaiseFromSql(r.b);
      // A receivable in this book is the pair (this → them); a payable is (them → this) seen from the other side.
      if (r.code === CODE.AR) pair(c, co).receivablePaise += v;
      else pair(co, c).counterpartPayablePaise += -v;
    }
    for (const r of sales.rows) pair(c, other.get(Number(r.customer_id))!).salesPaise += toPaiseFromSql(r.v);
    for (const r of buys.rows) pair(other.get(Number(r.vendor_id))!, c).counterpartPurchasesPaise += toPaiseFromSql(r.v);
  }
  return [...out.values()].filter((x) => x.receivablePaise || x.counterpartPayablePaise || x.salesPaise || x.counterpartPurchasesPaise);
}

export async function consolidatedStatements(ex: Executor, email: string, from: string, to: string, chosen?: string[]) {
  const allowed = await companiesFor(ex, email);
  const companies = chosen?.length ? allowed.filter((c) => chosen.includes(c.orgId)) : allowed;
  const each = await Promise.all(companies.map(async (c) => {
    const id = Number(c.orgId);
    const [pl, bs] = await Promise.all([profitAndLoss(ex, id, from, to), balanceSheet(ex, id, to)]);
    return { c, pl, bs };
  }));
  const pairs = await interCompany(ex, companies, from, to);
  const sumOf = (k: keyof InterCompany) => pairs.reduce((t, p) => t + Number(p[k]), 0);
  // Each side taken out as its own book records it.
  const elimReceivable = sumOf('receivablePaise');
  const elimPayable = sumOf('counterpartPayablePaise');
  const elimSales = sumOf('salesPaise');
  const elimPurchases = sumOf('counterpartPurchasesPaise');

  const sum = (f: (x: (typeof each)[number]) => Paise, elimination = 0) => {
    const by: Record<string, Paise> = {};
    for (const x of each) by[x.c.orgId] = f(x);
    return { by, elimination, total: Object.values(by).reduce((t, v) => t + v, 0) + elimination };
  };
  // The year's profit and earlier years' as equity rows, so the balance sheet's lines add up to its totals.
  const equityRows = (x: (typeof each)[number]): AccountBalance[] => [
    ...x.bs.equityRows,
    { accountId: 'prior-earnings', code: '', name: 'Profit of earlier years', type: 'equity', subtype: 'reserves', debitPaise: 0, creditPaise: 0, balancePaise: x.bs.priorYearsEarnings },
    { accountId: 'current-earnings', code: '', name: 'Profit for the year to date', type: 'equity', subtype: 'reserves', debitPaise: 0, creditPaise: 0, balancePaise: x.bs.currentPeriodEarnings },
  ];
  const profitElim = -elimSales + elimPurchases;
  return {
    from, to,
    companies: allowed.map((c) => ({ orgId: c.orgId, name: c.name, pan: c.pan, included: companies.some((x) => x.orgId === c.orgId) })),
    interCompany: pairs.map((p) => ({ ...p, balanceDifferencePaise: p.receivablePaise - p.counterpartPayablePaise, tradeDifferencePaise: p.salesPaise - p.counterpartPurchasesPaise })),
    income: merge(each.map((x) => ({ orgId: x.c.orgId, rows: x.pl.incomeRows })), new Map([[CODE.SALES, -elimSales]])),
    expenses: merge(each.map((x) => ({ orgId: x.c.orgId, rows: x.pl.expenseRows })), new Map([[CODE.PURCHASES, -elimPurchases]])),
    assets: merge(each.map((x) => ({ orgId: x.c.orgId, rows: x.bs.assetRows })), new Map([[CODE.AR, -elimReceivable]])),
    liabilities: merge(each.map((x) => ({ orgId: x.c.orgId, rows: x.bs.liabilityRows })), new Map([[CODE.AP, -elimPayable]])),
    equity: merge(each.map((x) => ({ orgId: x.c.orgId, rows: equityRows(x) }))),
    totalIncome: sum((x) => x.pl.totalIncome, -elimSales),
    // The ledger's expenses, adjusted by the change in stock, as each P&L shows them.
    totalExpense: sum((x) => x.pl.totalExpense + x.pl.openingStockPaise - x.pl.closingStockPaise, -elimPurchases),
    netProfit: sum((x) => x.pl.netProfit, profitElim),
    totalAssets: sum((x) => x.bs.totalAssets, -elimReceivable),
    totalLiabilities: sum((x) => x.bs.totalLiabilities, -elimPayable),
    totalEquity: sum((x) => x.bs.totalEquity),
    /** What the eliminations leave unexplained: one side's figure not matching the other's. */
    unreconciledPaise: elimReceivable - elimPayable,
  };
}
