import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Zoho Books' "Customize Report", for the profit and loss, balance sheet,
// trial balance, general ledger, account transactions and cash flow.
//
// General: the period, the report basis, comparison with earlier periods or
// years, and "Report by" month, quarter or year columns. Filters: which
// accounts (all, non-zero, with transactions; by type; chosen ones), and the
// branch, cost centre, project, reporting tag, customer and vendor. Every
// figure comes from the same statement functions the plain reports use
// (statements.ts), over only the journal lines the filters keep
// (line-filters.ts), so a customised report and the plain one agree wherever
// their filters do.
//
// Each report states every filter applied in its heading, because a report an
// auditor files has to say on its face what it covers (SA 230). A balance
// sheet or trial balance cut by a customer, cost centre, project, tag or a
// set of accounts covers only part of each entry, so it cannot balance; it
// says so plainly rather than showing a total that does not add up.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor } from '../db';
import type { Paise } from '../../types';
import { toPaiseFromSql } from '../money-sql';
import { generalLedger, trialBalance, type AccountType, type ReportBasis } from './statements';
import { groupedBalanceSheet, groupedProfitAndLoss, type StatementGroup } from './statement-groups';
import { cashFlow } from './analysis';
import { accountFilterSql, cutsByAccount, cutsByDimension, describeFilter, lineFilterSql, type LineFilter } from './line-filters';
import { lineOf, overrides } from './schedule-iii';

export type CustomReportKind = 'profit-and-loss' | 'balance-sheet' | 'trial-balance' | 'general-ledger' | 'account-transactions' | 'cash-flow';

export interface CustomSpec {
  report: CustomReportKind;
  from: string;
  to: string;
  basis?: ReportBasis;
  reportBy?: 'total' | 'month' | 'quarter' | 'year';
  compareMode?: 'none' | 'previous_period' | 'previous_year';
  compareCount?: number;
  accounts?: 'all' | 'non_zero' | 'with_txns';
  filter?: LineFilter;
  /** The general ledger's account. */
  accountId?: string | null;
}

export interface Column { key: string; label: string; from: string; to: string }

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const iso = (d: Date) => d.toISOString().slice(0, 10);
const at = (s: string) => new Date(`${s}T00:00:00Z`);
const monthEnd = (y: number, m: number) => iso(new Date(Date.UTC(y, m + 1, 0)));
const dmy = (s: string) => { const d = at(s); return `${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
const isMonthStart = (s: string) => s.endsWith('-01');
const isMonthEnd = (s: string) => { const d = at(s); return monthEnd(d.getUTCFullYear(), d.getUTCMonth()) === s; };
const addMonths = (s: string, n: number, end = false) => {
  const d = at(s);
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
  return end ? monthEnd(t.getUTCFullYear(), t.getUTCMonth()) : iso(t);
};
const addDays = (s: string, n: number) => { const d = at(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };

/** The columns a spec asks for: the period split by month, quarter or year, or the period and N before it. */
export function columnsFor(spec: CustomSpec): Column[] {
  const asAt = spec.report === 'balance-sheet' || spec.report === 'trial-balance';
  const label = (from: string, to: string) => (asAt ? `As of ${dmy(to)}` : `${dmy(from)} – ${dmy(to)}`);
  const by = spec.reportBy ?? 'total';
  if (by !== 'total' && spec.report !== 'general-ledger' && spec.report !== 'account-transactions') {
    const out: Column[] = [];
    let start = spec.from;
    for (let k = 0; start <= spec.to && k < 60; k++) {
      const d = at(start);
      let end: string;
      if (by === 'month') end = monthEnd(d.getUTCFullYear(), d.getUTCMonth());
      else if (by === 'quarter') {
        // Indian quarters: Apr–Jun, Jul–Sep, Oct–Dec, Jan–Mar.
        const m = d.getUTCMonth();
        end = monthEnd(d.getUTCFullYear(), m <= 2 ? 2 : m <= 5 ? 5 : m <= 8 ? 8 : 11);
      } else {
        const fyEndYear = d.getUTCMonth() < 3 ? d.getUTCFullYear() : d.getUTCFullYear() + 1;
        end = `${fyEndYear}-03-31`;
      }
      if (end > spec.to) end = spec.to;
      const sd = at(start);
      const lab = by === 'month' ? `${MON[sd.getUTCMonth()]} ${sd.getUTCFullYear()}`
        : by === 'quarter' ? `${MON[sd.getUTCMonth()]}–${MON[at(end).getUTCMonth()]} ${at(end).getUTCFullYear()}`
          : `FY ${at(end).getUTCFullYear() - 1}-${String(at(end).getUTCFullYear() % 100).padStart(2, '0')}`;
      out.push({ key: `c${k}`, label: asAt ? `As of ${dmy(end)}` : lab, from: start, to: end });
      start = addDays(end, 1);
    }
    return out;
  }
  const cols: Column[] = [{ key: 'c0', label: label(spec.from, spec.to), from: spec.from, to: spec.to }];
  const n = spec.report === 'general-ledger' || spec.report === 'account-transactions' ? 0 : Math.max(0, Math.min(12, spec.compareCount ?? 0));
  if (spec.compareMode && spec.compareMode !== 'none') {
    const months = isMonthStart(spec.from) && isMonthEnd(spec.to)
      ? (at(spec.to).getUTCFullYear() - at(spec.from).getUTCFullYear()) * 12 + at(spec.to).getUTCMonth() - at(spec.from).getUTCMonth() + 1 : 0;
    const days = Math.round((at(spec.to).getTime() - at(spec.from).getTime()) / 86_400_000) + 1;
    for (let k = 1; k <= Math.max(1, n); k++) {
      let from: string, to: string;
      if (spec.compareMode === 'previous_year') {
        from = addMonths(spec.from, -12 * k) .slice(0, 8) + spec.from.slice(8);
        to = isMonthEnd(spec.to) ? addMonths(spec.to, -12 * k, true) : `${Number(spec.to.slice(0, 4)) - k}${spec.to.slice(4)}`;
      } else if (months) {
        from = addMonths(spec.from, -months * k);
        to = addMonths(spec.to, -months * k, true);
      } else {
        from = addDays(spec.from, -days * k);
        to = addDays(spec.to, -days * k);
      }
      cols.push({ key: `p${k}`, label: label(from, to), from, to });
    }
  }
  return cols;
}

export interface CustomRow { accountId: string; code: string; name: string; type?: AccountType; computed?: boolean; values: Paise[]; debit?: Paise[]; credit?: Paise[] }
export interface CustomSection { key: string; label: string; depth: number; rows: CustomRow[]; totals: Paise[]; /** A heading with no lines of its own (Current Assets). */ headingOnly?: boolean }
export interface CustomResult { key: string; label: string; values: Paise[] }

export interface CustomReport {
  spec: CustomSpec;
  columns: Column[];
  sections: CustomSection[];
  results: CustomResult[];
  /** The general ledger's or account transactions' lines. */
  lines?: { date: string; entryId: string; entryNo: number; account?: string; accountCode?: string; description: string; contact: string | null; sourceType: string; sourceId: string | null; debitPaise: Paise; creditPaise: Paise; runningPaise?: Paise }[];
  opening?: Paise; closing?: Paise; account?: { id: string; code: string; name: string; type: string } | null;
  truncated?: boolean;
  /** Every filter in words, for the heading on screen, in print and in the exports. */
  applied: string[];
  notes: string[];
  /** The balance sheet's or trial balance's own proof, per column; false when the filters make it impossible. */
  balanced: boolean[] | null;
  cannotBalance: boolean;
}

/** Accounts that had any line in the range under the filter: "with transactions". */
async function accountsWithLines(ex: Executor, orgId: number, from: string, to: string, f: LineFilter | undefined) {
  const { rows } = await sql<{ id: number }>`
    SELECT DISTINCT jl.account_id AS id FROM journal_lines jl JOIN journal_entries e ON e.id = jl.entry_id
     WHERE jl.org_id = ${orgId} AND jl.entry_date BETWEEN ${from} AND ${to} ${lineFilterSql(orgId, f)}`.execute(ex);
  return new Set(rows.map((r) => String(r.id)));
}

async function allAccounts(ex: Executor, orgId: number, types: AccountType[], f: LineFilter | undefined) {
  const { rows } = await sql<{ id: number; code: string; name: string; type: AccountType; subtype: string | null }>`
    SELECT a.id, a.code, a.name, a.type, a.subtype FROM accounts a
     WHERE a.org_id = ${orgId} AND a.is_active = 1 AND a.type IN (${sql.join(types)}) ${accountFilterSql(f)}
     ORDER BY a.code`.execute(ex);
  return rows;
}

const describeSpec = (spec: CustomSpec, columns: Column[]): string[] => {
  const out = [
    spec.report === 'balance-sheet' || spec.report === 'trial-balance' ? `As of ${dmy(spec.to)}` : `Period: ${dmy(spec.from)} to ${dmy(spec.to)}`,
    `Report basis: ${spec.basis === 'cash' ? 'Cash' : 'Accrual'}`,
  ];
  if ((spec.reportBy ?? 'total') !== 'total' && columns.length > 1) out.push(`Report by: ${spec.reportBy} (${columns.length} columns)`);
  if (spec.compareMode && spec.compareMode !== 'none' && columns.length > 1) out.push(`Compared with: ${columns.length - 1} previous ${spec.compareMode === 'previous_year' ? 'year' : 'period'}${columns.length > 2 ? 's' : ''}`);
  if (spec.accounts && spec.accounts !== 'non_zero') out.push(`Accounts: ${spec.accounts === 'all' ? 'all accounts, zero balances included' : 'accounts with transactions'}`);
  return out;
};

/** Merge one statement group across columns, by account. */
function mergeGroup(groups: (StatementGroup | undefined)[], key: string, label: string, depth: number): CustomSection[] {
  const first = groups.find(Boolean)!;
  const rows = new Map<string, CustomRow>();
  groups.forEach((g, i) => {
    for (const l of g?.lines ?? []) {
      const r = rows.get(l.accountId) ?? { accountId: l.accountId, code: l.code, name: l.name, computed: l.computed, values: groups.map(() => 0) };
      r.values[i] = l.amountPaise;
      rows.set(l.accountId, r);
    }
  });
  const children = (first.groups ?? []).flatMap((c) => mergeGroup(groups.map((g) => g?.groups?.find((x) => x.key === c.key)), c.key, c.label, depth + 1));
  return [
    { key, label, depth, rows: [...rows.values()].sort((a, b) => (a.code || 'zzz').localeCompare(b.code || 'zzz')), totals: groups.map((g) => g?.totalPaise ?? 0), headingOnly: (first.groups ?? []).length > 0 },
    ...children,
  ];
}

export async function customReport(ex: Executor, orgId: number, spec: CustomSpec): Promise<CustomReport> {
  const f = spec.filter;
  const basis = spec.basis ?? 'accrual';
  const branchId = f?.branchId ?? undefined;
  const columns = columnsFor(spec);
  const applied = [...describeSpec(spec, columns), ...(await describeFilter(ex, orgId, f))];
  const notes: string[] = [];
  const dimension = cutsByDimension(f);
  const byAccount = cutsByAccount(f);
  const out: CustomReport = { spec, columns, sections: [], results: [], applied, notes, balanced: null, cannotBalance: false };

  if (spec.report === 'profit-and-loss') {
    const pls = await Promise.all(columns.map((c) => groupedProfitAndLoss(ex, orgId, c.from, c.to, branchId, basis, f)));
    out.sections = [
      ...mergeGroup(pls.map((p) => p.operatingIncome), 'operating-income', 'Operating Income', 0),
      ...mergeGroup(pls.map((p) => p.costOfGoodsSold), 'cogs', 'Cost of Goods Sold', 0),
      ...mergeGroup(pls.map((p) => p.operatingExpense), 'operating-expense', 'Operating Expense', 0),
      ...mergeGroup(pls.map((p) => p.nonOperatingIncome), 'non-operating-income', 'Non Operating Income', 0),
      ...mergeGroup(pls.map((p) => p.nonOperatingExpense), 'non-operating-expense', 'Non Operating Expense', 0),
    ];
    out.results = [
      { key: 'gross', label: 'Gross Profit', values: pls.map((p) => p.grossProfitPaise) },
      { key: 'operating', label: 'Operating Profit', values: pls.map((p) => p.operatingProfitPaise) },
      { key: 'net', label: 'Net Profit', values: pls.map((p) => p.netProfitPaise) },
    ];
    await addAccounts(ex, orgId, spec, out, ['income', 'expense'], (a, over) => {
      const line = lineOf({ accountId: String(a.id), code: a.code, name: a.name, type: a.type, subtype: a.subtype } as never, over) ?? '';
      if (a.type === 'income') return line === 'other_income' ? 'non-operating-income' : 'operating-income';
      if (['purchases_stock_in_trade', 'cost_of_materials', 'changes_in_inventories'].includes(line)) return 'cogs';
      return line === 'finance_costs' ? 'non-operating-expense' : 'operating-expense';
    });
    if (dimension || byAccount) notes.push('Stock on hand belongs to no customer, cost centre, project, tag or single account, so the stock adjustment (opening less closing stock) is left out of this filtered profit and loss.');
  } else if (spec.report === 'balance-sheet') {
    const bss = await Promise.all(columns.map((c) => groupedBalanceSheet(ex, orgId, c.to, branchId, basis, f)));
    out.sections = [
      ...mergeGroup(bss.map((b) => b.assets), 'assets', 'Assets', 0),
      ...mergeGroup(bss.map((b) => b.liabilities), 'liabilities', 'Liabilities', 0),
      ...mergeGroup(bss.map((b) => b.equities), 'equities', 'Equities', 0),
    ];
    out.results = [
      { key: 'assets', label: 'Total Assets', values: bss.map((b) => b.assets.totalPaise) },
      { key: 'le', label: 'Total Liabilities & Equities', values: bss.map((b) => b.totalLiabilitiesAndEquitiesPaise) },
    ];
    out.balanced = bss.map((b) => b.balanced);
    await addAccounts(ex, orgId, spec, out, ['asset', 'liability', 'equity'], (a) => (a.type === 'asset' ? 'other-current-assets' : a.type === 'liability' ? 'other-current-liabilities' : 'equities'));
    if (dimension || byAccount) {
      out.cannotBalance = true;
      notes.push('This balance sheet is filtered, so it does not balance and is not meant to: a customer, cost centre, project, tag or a set of accounts takes in only part of each entry (an invoice\'s receivable but not all of its tax, a cost centre\'s expenses but no bank). The totals are of the lines shown.');
    }
  } else if (spec.report === 'trial-balance') {
    const tbs = await Promise.all(columns.map((c) => trialBalance(ex, orgId, c.to, branchId, basis, f)));
    const rows = new Map<string, CustomRow>();
    tbs.forEach((tb, i) => {
      for (const r of tb.rows) {
        const row = rows.get(r.accountId) ?? { accountId: r.accountId, code: r.code, name: r.name, type: r.type, values: columns.map(() => 0), debit: columns.map(() => 0), credit: columns.map(() => 0) };
        row.debit![i] = r.debitSide; row.credit![i] = r.creditSide; row.values[i] = r.debitSide - r.creditSide;
        rows.set(r.accountId, row);
      }
    });
    out.sections = [{ key: 'accounts', label: 'Accounts', depth: 0, rows: [...rows.values()].sort((a, b) => a.code.localeCompare(b.code)), totals: tbs.map((t) => t.totalDebit - t.totalCredit) }];
    out.results = [
      { key: 'debit', label: 'Total debit', values: tbs.map((t) => t.totalDebit) },
      { key: 'credit', label: 'Total credit', values: tbs.map((t) => t.totalCredit) },
    ];
    out.balanced = tbs.map((t) => t.balanced);
    await addAccounts(ex, orgId, spec, out, ['asset', 'liability', 'equity', 'income', 'expense'], () => 'accounts', true);
    if (dimension || byAccount) {
      out.cannotBalance = true;
      notes.push('This trial balance is filtered, so its debits and credits need not agree: the filters keep only part of each entry. The totals are of the lines shown.');
    }
  } else if (spec.report === 'cash-flow') {
    const cfs = await Promise.all(columns.map((c) => cashFlow(ex, orgId, { from: c.from, to: c.to, filter: f })));
    for (const group of ['Operating', 'Investing', 'Financing']) {
      const rows = new Map<string, CustomRow>();
      cfs.forEach((cf, i) => {
        for (const r of cf.rows.filter((x) => x.group === group)) {
          const row = rows.get(r.label) ?? { accountId: r.label, code: '', name: r.label, values: columns.map(() => 0) };
          row.values[i] += r.amountPaise;
          rows.set(r.label, row);
        }
      });
      out.sections.push({ key: group.toLowerCase(), label: `${group} activities`, depth: 0, rows: [...rows.values()], totals: cfs.map((cf) => (group === 'Operating' ? cf.operatingPaise : group === 'Investing' ? cf.investingPaise : cf.financingPaise)) });
    }
    out.results = [
      { key: 'opening', label: 'Cash at the beginning', values: cfs.map((c) => c.openingPaise) },
      { key: 'net', label: 'Net change in cash', values: cfs.map((c) => c.operatingPaise + c.investingPaise + c.financingPaise) },
      { key: 'closing', label: 'Cash at the end', values: cfs.map((c) => c.closingPaise) },
    ];
    if (f?.costCentreIds?.length || f?.accountIds?.length || f?.accountTypes?.length) notes.push('Cost centre and account filters do not apply to the cash flow: cash moves through bank and cash accounts, which carry no cost centre.');
  } else if (spec.report === 'general-ledger') {
    const account = spec.accountId ? await ex.selectFrom('accounts').select(['id', 'code', 'name', 'type']).where('id', '=', Number(spec.accountId)).where('org_id', '=', orgId).executeTakeFirst() : null;
    out.account = account ? { id: String(account.id), code: account.code, name: account.name, type: account.type } : null;
    if (account) {
      const gl = await generalLedger(ex, orgId, account.id, spec.from, spec.to, f);
      out.opening = gl.openingPaise; out.closing = gl.closingPaise;
      out.lines = gl.lines.map((l) => ({ date: l.date, entryId: l.entryId, entryNo: l.entryNo, description: l.description ?? l.memo ?? '', contact: l.contactName, sourceType: l.sourceType, sourceId: l.sourceId, debitPaise: l.debitPaise, creditPaise: l.creditPaise, runningPaise: l.runningPaise }));
    }
  } else {
    const LIMIT = 10_000;
    const { rows } = await sql<{ entry_date: string; entry_id: number; entry_no: number; code: string; name: string; description: string | null; memo: string | null; contact: string | null; source_type: string; source_id: number | null; debit: string; credit: string }>`
      SELECT DATE_FORMAT(jl.entry_date, '%Y-%m-%d') AS entry_date, jl.entry_id, e.entry_no, a.code, a.name, jl.description, e.memo, c.display_name AS contact,
             e.source_type, e.source_id, jl.debit, jl.credit
        FROM journal_lines jl
        JOIN journal_entries e ON e.id = jl.entry_id
        JOIN accounts a ON a.id = jl.account_id
        LEFT JOIN contacts c ON c.id = jl.contact_id
       WHERE jl.org_id = ${orgId} AND jl.entry_date BETWEEN ${spec.from} AND ${spec.to}
         ${lineFilterSql(orgId, f)} ${accountFilterSql(f)}
       ORDER BY jl.entry_date, e.entry_no, jl.line_no
       LIMIT ${LIMIT + 1}`.execute(ex);
    out.truncated = rows.length > LIMIT;
    out.lines = rows.slice(0, LIMIT).map((r) => ({
      date: r.entry_date, entryId: String(r.entry_id), entryNo: r.entry_no, account: r.name, accountCode: r.code,
      description: r.description ?? r.memo ?? '', contact: r.contact, sourceType: r.source_type, sourceId: r.source_id ? String(r.source_id) : null,
      debitPaise: toPaiseFromSql(r.debit), creditPaise: toPaiseFromSql(r.credit),
    }));
    if (out.truncated) notes.push(`Only the first ${LIMIT.toLocaleString('en-IN')} lines are shown; narrow the period or the filters for the rest.`);
  }
  return out;
}

/**
 * Accounts with no balance, when asked for: every account of the report's
 * types ("all"), or those with lines that net to nil ("with transactions").
 * A balance that is not zero is always shown.
 */
async function addAccounts(
  ex: Executor, orgId: number, spec: CustomSpec, out: CustomReport, types: AccountType[],
  sectionOf: (a: { id: number; code: string; name: string; type: AccountType; subtype: string | null }, over: Map<string, string>) => string, tb = false,
) {
  const mode = spec.accounts ?? 'non_zero';
  if (mode === 'non_zero') return;
  const shown = new Set(out.sections.flatMap((s) => s.rows.map((r) => r.accountId)));
  const accounts = await allAccounts(ex, orgId, types, spec.filter);
  const keep = mode === 'all' ? null : await accountsWithLines(ex, orgId, out.columns[out.columns.length - 1].from, out.columns[0].to, spec.filter);
  const over = await overrides(ex, orgId);
  for (const a of accounts) {
    if (shown.has(String(a.id)) || (keep && !keep.has(String(a.id)))) continue;
    const key = sectionOf(a, over);
    const sec = out.sections.find((s) => s.key === key) ?? out.sections.find((s) => !s.headingOnly);
    sec?.rows.push({ accountId: String(a.id), code: a.code, name: a.name, type: a.type, values: out.columns.map(() => 0), ...(tb ? { debit: out.columns.map(() => 0), credit: out.columns.map(() => 0) } : {}) });
  }
  for (const s of out.sections) s.rows.sort((x, y) => (x.code || 'zzz').localeCompare(y.code || 'zzz'));
}
