import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Closing a financial year.
//
// The ledger is continuous, so nothing has to be carried forward by hand: the
// balance sheet on 1 April is the one on 31 March, and the year's profit is in
// retained earnings because the balance sheet puts it there (statements.ts).
// No closing entry is posted — it would leave the closed year's profit and
// loss showing nil, which is the one report everyone opens a closed year for.
//
// Closing is therefore a decision and a record:
//
//   1. The year passes the close checks, including depreciation run to
//      31 March. A blocker stops it; an admin may override one with a reason,
//      except the trial balance, which must agree.
//   2. Every module is locked to 31 March, so nothing more can be dated into
//      the year without an unlock that the audit trail records.
//   3. The trial balance, the profit and the closing stock are kept as they
//      stood, so the closed year can be shown as it was closed, and the year
//      pack (the statements in one workbook) can be downloaded for the file.
//
// Reopening is the latest closed year only, with a reason; its locks go back
// to the previous closed year's end.
// ─────────────────────────────────────────────────────────────────────────────

import type { Executor, Trx } from '../db';
import type { Paise } from '../../types';
import { toPaiseFromSql, toSqlFromPaise } from '../money-sql';
import { badRequest, conflict, notFound } from '../http';
import { balanceSheet, profitAndLoss, trialBalance } from '../reports/statements';
import { closeChecks } from './period-close';
import { booksStartDate } from './opening-balances';
import type { Sheet } from '../../xlsx';

const MODULES = ['sales', 'purchases', 'banking', 'accountant'] as const;
const label = (y: number) => `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
const range = (y: number) => ({ from: `${y}-04-01`, to: `${y + 1}-03-31` });
const fyOf = (d: string) => Number(d.slice(0, 4)) - (Number(d.slice(5, 7)) < 4 ? 1 : 0);

export interface FinancialYearRow {
  fyStart: number;
  label: string;
  from: string;
  to: string;
  status: 'open' | 'closed' | 'current';
  closedAt: string | null;
  netProfitPaise: Paise | null;
  closingStockPaise: Paise | null;
  reopenReason: string | null;
  /** The latest closed year, the only one that may be reopened. */
  canReopen: boolean;
  /** The earliest open year that has ended: the only one that may be closed now. */
  canClose: boolean;
}

/** Every year from the one the books start in to the current one. */
export async function listYears(ex: Executor, orgId: number, today = new Date().toISOString().slice(0, 10)): Promise<FinancialYearRow[]> {
  const start = await booksStartDate(ex, orgId);
  const first = fyOf(start.date);
  const current = fyOf(today);
  const rows = await ex.selectFrom('financial_years').selectAll().where('org_id', '=', orgId).execute();
  const by = new Map(rows.map((r) => [r.fy_start, r]));
  const lastClosed = Math.max(-1, ...rows.filter((r) => r.status === 'closed').map((r) => r.fy_start));
  const out: FinancialYearRow[] = [];
  let firstOpenEnded: number | null = null;
  for (let y = first; y <= current; y++) {
    const r = by.get(y);
    const closed = r?.status === 'closed';
    if (!closed && y < current && firstOpenEnded === null) firstOpenEnded = y;
    out.push({
      fyStart: y, label: label(y), ...range(y),
      status: closed ? 'closed' : y === current ? 'current' : 'open',
      closedAt: r?.closed_at ? new Date(String(r.closed_at)).toISOString() : null,
      netProfitPaise: r?.net_profit != null ? toPaiseFromSql(r.net_profit) : null,
      closingStockPaise: r?.closing_stock != null ? toPaiseFromSql(r.closing_stock) : null,
      reopenReason: r?.reopen_reason ?? null,
      canReopen: closed && y === lastClosed,
      canClose: false,
    });
  }
  for (const row of out) row.canClose = row.fyStart === firstOpenEnded;
  return out.reverse();
}

/** The checks for closing a year: the period checks, plus depreciation and openings. */
export async function yearChecks(ex: Executor, orgId: number, fyStart: number) {
  const { from, to } = range(fyStart);
  return closeChecks(ex, orgId, from, to, { yearEnd: true });
}

export async function closeYear(
  trx: Trx, orgId: number, userId: number | null, fyStart: number,
  opts: { overrideReason?: string | null; today?: string } = {},
) {
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const { from, to } = range(fyStart);
  if (to >= today) throw badRequest(`FY ${label(fyStart)} has not ended yet; it can be closed from 1 April ${fyStart + 1}.`);
  const years = await listYears(trx, orgId, today);
  const row = years.find((y) => y.fyStart === fyStart);
  if (!row) throw badRequest(`The books do not cover FY ${label(fyStart)}.`);
  if (row.status === 'closed') throw conflict(`FY ${label(fyStart)} is already closed.`);
  if (!row.canClose) {
    const earlier = years.filter((y) => y.fyStart < fyStart && y.status !== 'closed').map((y) => y.label);
    throw conflict(`Close the earlier year${earlier.length > 1 ? 's' : ''} first: FY ${earlier.join(', ')}.`);
  }

  const checks = await yearChecks(trx, orgId, fyStart);
  const balance = checks.checks.find((c) => c.id === 'balance')!;
  if (balance.count) throw conflict('The trial balance does not agree. A year that does not balance cannot be closed.');
  const blockers = checks.checks.filter((c) => c.blocking && c.count > 0);
  if (blockers.length && !opts.overrideReason?.trim()) {
    throw conflict(`Not ready: ${blockers.map((b) => b.label.toLowerCase()).join('; ')}. Resolve these, or give a reason to close anyway.`);
  }

  // Lock every module to the year end — never moving a later lock back.
  for (const m of MODULES) {
    const lock = await trx.selectFrom('transaction_locks').select(['id', 'locked_upto'])
      .where('org_id', '=', orgId).where('module', '=', m).executeTakeFirst();
    const current = lock?.locked_upto ? String(lock.locked_upto).slice(0, 10) : null;
    if (current && current >= to) continue;
    const values = { locked_upto: to, reason: `FY ${label(fyStart)} closed`, locked_by_user_id: userId };
    if (lock) await trx.updateTable('transaction_locks').set(values).where('id', '=', lock.id).execute();
    else await trx.insertInto('transaction_locks').values({ org_id: orgId, module: m, ...values }).execute();
  }

  const [tb, pl] = await Promise.all([trialBalance(trx, orgId, to), profitAndLoss(trx, orgId, from, to)]);
  const snapshot = {
    asOf: to,
    rows: tb.rows.map((r) => ({ code: r.code, name: r.name, type: r.type, debit: r.debitSide, credit: r.creditSide })),
    totalDebit: tb.totalDebit,
    totalCredit: tb.totalCredit,
    checks: checks.checks.map((c) => ({ id: c.id, count: c.count })),
  };
  const values = {
    status: 'closed' as const, closed_at: new Date(), closed_by_user_id: userId,
    net_profit: toSqlFromPaise(pl.netProfit), closing_stock: toSqlFromPaise(pl.closingStockPaise),
    snapshot: JSON.stringify(snapshot), override_reason: blockers.length ? opts.overrideReason!.trim() : null,
  };
  const existing = await trx.selectFrom('financial_years').select('id')
    .where('org_id', '=', orgId).where('fy_start', '=', fyStart).executeTakeFirst();
  if (existing) await trx.updateTable('financial_years').set(values).where('id', '=', existing.id).execute();
  else await trx.insertInto('financial_years').values({ org_id: orgId, fy_start: fyStart, ...values }).execute();

  return { netProfitPaise: pl.netProfit, closingStockPaise: pl.closingStockPaise, overridden: blockers.map((b) => b.id) };
}

export async function reopenYear(trx: Trx, orgId: number, userId: number | null, fyStart: number, reason: string) {
  if (reason.trim().length < 5) throw badRequest('Say why the year is being reopened.');
  const years = await listYears(trx, orgId);
  const row = years.find((y) => y.fyStart === fyStart);
  if (!row || row.status !== 'closed') throw notFound(`FY ${label(fyStart)} is not closed.`);
  if (!row.canReopen) throw conflict('Only the latest closed year can be reopened. Reopen the later ones first.');
  const previous = years.filter((y) => y.status === 'closed' && y.fyStart < fyStart).map((y) => y.to).sort().pop() ?? null;
  const { to } = range(fyStart);
  for (const m of MODULES) {
    // Only locks this close set, or that stop at its year end, are moved back.
    await trx.updateTable('transaction_locks')
      .set({ locked_upto: previous, reason: previous ? `FY ${label(fyStart - 1)} closed` : null, locked_by_user_id: userId })
      .where('org_id', '=', orgId).where('module', '=', m).where('locked_upto', '=', to).execute();
  }
  await trx.updateTable('financial_years').set({
    status: 'open', reopened_at: new Date(), reopened_by_user_id: userId, reopen_reason: reason.trim(),
  }).where('org_id', '=', orgId).where('fy_start', '=', fyStart).execute();
}

/** The year's statements in one workbook: for the file, the auditor, and the archive. */
export async function yearPack(ex: Executor, orgId: number, fyStart: number): Promise<{ filename: string; sheets: Sheet[] }> {
  const { from, to } = range(fyStart);
  const org = await ex.selectFrom('organizations').select(['name']).where('id', '=', orgId).executeTakeFirstOrThrow();
  const [tb, pl, bs, entries] = await Promise.all([
    trialBalance(ex, orgId, to),
    profitAndLoss(ex, orgId, from, to),
    balanceSheet(ex, orgId, to),
    ex.selectFrom('journal_entries as e').innerJoin('journal_lines as l', 'l.entry_id', 'e.id')
      .innerJoin('accounts as a', 'a.id', 'l.account_id').leftJoin('contacts as c', 'c.id', 'l.contact_id')
      .select(['e.entry_no', 'e.entry_date', 'e.memo', 'e.source_type', 'a.code', 'a.name', 'c.display_name', 'l.debit', 'l.credit', 'l.description'])
      .where('e.org_id', '=', orgId).where('e.entry_date', '>=', from).where('e.entry_date', '<=', to)
      .orderBy('e.entry_date').orderBy('e.entry_no').orderBy('l.line_no').execute(),
  ]);
  const r = (p: Paise) => Math.round(p) / 100;
  const sheets: Sheet[] = [
    {
      name: 'Trial Balance',
      rows: [['Code', 'Account', 'Type', 'Debit', 'Credit'],
        ...tb.rows.map((x) => [x.code, x.name, x.type, x.debitSide ? r(x.debitSide) : null, x.creditSide ? r(x.creditSide) : null]),
        ['', 'Total', '', r(tb.totalDebit), r(tb.totalCredit)]],
    },
    {
      name: 'Profit and Loss',
      rows: [['Section', 'Code', 'Account', 'Amount'],
        ...pl.incomeRows.map((x) => ['Income', x.code, x.name, r(x.balancePaise)]),
        ['', '', 'Total income', r(pl.totalIncome)],
        ['Cost of goods', '', 'Opening stock', r(pl.openingStockPaise)],
        ['Cost of goods', '', 'Closing stock', r(-pl.closingStockPaise)],
        ...pl.expenseRows.map((x) => ['Expense', x.code, x.name, r(x.balancePaise)]),
        ['', '', 'Gross profit', r(pl.grossProfit)],
        ['', '', 'Net profit', r(pl.netProfit)]],
    },
    {
      name: 'Balance Sheet',
      rows: [['Side', 'Code', 'Account', 'Amount'],
        ...bs.assetRows.map((x) => ['Assets', x.code, x.name, r(x.balancePaise)]),
        ['', '', 'Total assets', r(bs.totalAssets)],
        ...bs.liabilityRows.map((x) => ['Liabilities', x.code, x.name, r(x.balancePaise)]),
        ...bs.equityRows.map((x) => ['Equity', x.code, x.name, r(x.balancePaise)]),
        ['Equity', '', 'Retained from earlier years', r(bs.priorYearsEarnings)],
        ['Equity', '', 'Profit for the year', r(bs.currentPeriodEarnings)],
        ['', '', 'Total liabilities and equity', r(bs.totalLiabilities + bs.totalEquity)]],
    },
    {
      name: 'Day Book',
      rows: [['Entry', 'Date', 'Narration', 'Source', 'Code', 'Account', 'Party', 'Debit', 'Credit', 'Line note'],
        ...entries.map((e) => [e.entry_no, String(e.entry_date).slice(0, 10), e.memo ?? '', e.source_type, e.code, e.name,
          e.display_name ?? '', Number(e.debit) || null, Number(e.credit) || null, e.description ?? ''])],
    },
  ];
  return { filename: `${org.name.replace(/[^\w-]+/g, '_')}_FY${label(fyStart)}.xlsx`, sheets };
}
