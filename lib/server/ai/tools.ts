import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// What the assistant can look up.
//
// Each tool is a report the app already runs — the same function behind the
// Reports pages, called with the same arguments — so a figure the assistant
// quotes is the figure the report shows, to the paisa. There is no second
// implementation of a balance anywhere in here.
//
// Every tool is read-only. There is no tool that posts, edits, deletes, sends
// or fetches anything outside this organisation's books, so the worst a
// confused or manipulated model can do is read what the person asking could
// already open.
//
// And only what they could open: each tool names the part of the app it
// reads, and a role that cannot see that part is not offered the tool at all.
// A salesperson's assistant has no profit-and-loss tool, rather than one that
// refuses — there is nothing to talk it into.
//
// Results are compact on purpose: every token here is a token the customer
// pays for, on every model call that follows in the same question.
// ─────────────────────────────────────────────────────────────────────────────

import { sql, type RawBuilder } from 'kysely';
import { z } from 'zod';
import type { Executor } from '../db';
import { hasPermission } from '../../rbac';
import type { RoleName } from '../../types';
import { toPaiseFromSql } from '../money-sql';
import {
  AGEING_BUCKETS, ageing, balanceSheet, generalLedger, isDebitNormal, profitAndLoss, trialBalance,
  type AccountType,
} from '../reports/statements';
import { businessRatios, cashFlow, expensesByCategory, salesBy } from '../reports/analysis';
import { cashPosition, previousWindow } from '../reports/analytics';
import { gstr3b } from '../gst/returns';
import type { AiReport } from '../../ai/reports';
import { detectFlags } from './insights';
import { HIDDEN_AREA_WORDS } from './prompt';
import {
  accountBalanceReport, ageingReport, balanceSheetReport, cashFlowReport, cashPositionReport, documentsReport,
  expensesReport, gstReport, profitAndLossReport, ratiosReport, reportKey, safely, salesReport, trialBalanceReport,
  type ReportDraft,
} from './reports';
import { fyStartOf, previousMonth } from './time';
import type { ToolCall, ToolSpec } from './types';

export interface ToolContext {
  /** Reads go through this, so a test can run the tools inside its own transaction. */
  ex: Executor;
  orgId: number;
  userId: number;
  role: RoleName;
  /** 'YYYY-MM-DD', India. */
  today: string;
  fyStart: string;
}

export interface ToolSource {
  label: string;
  href: string;
}

export interface ToolRun {
  ok: boolean;
  /** What the model is shown: JSON text. */
  content: string;
  sources: ToolSource[];
  label: string;
  /** What the person sees under the answer: key figures, a chart and a table. */
  report: AiReport | null;
}

/** Sales and staff roles do not see purchase costs, margins or the ledger. */
export const seesCosts = (role: RoleName): boolean => role === 'admin' || role === 'accountant' || role === 'viewer';

type Gate = 'costs' | 'sales' | 'purchases' | 'cash' | 'gst' | 'any';

function allows(gate: Gate, role: RoleName): boolean {
  switch (gate) {
    case 'costs':
      return seesCosts(role) && (hasPermission(role, 'reports', 'view') || hasPermission(role, 'accountant', 'view'));
    case 'sales':
      return hasPermission(role, 'sales', 'view');
    case 'purchases':
      return hasPermission(role, 'purchases', 'view');
    case 'cash':
      return hasPermission(role, 'banking', 'view') || (seesCosts(role) && hasPermission(role, 'reports', 'view'));
    case 'gst':
      return hasPermission(role, 'gst', 'view');
    default:
      return true;
  }
}

// ── Formatting ───────────────────────────────────────────────────────────────

const INR = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** ₹12,34,567.89 — the model is told to quote these exactly. */
const amt = (paise: number): string => INR.format(paise / 100);

/** '₹1,25,000.00 Dr' — a balance and the side it sits on. */
const withSide = (paise: number, debitNormal: boolean): string =>
  `${amt(Math.abs(paise))} ${(paise >= 0) === debitNormal ? 'Dr' : 'Cr'}`;

const pct = (n: number): string => `${n.toFixed(1)}%`;
const daysBetween = (from: string, to: string): number => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
const day = (v: unknown): string => String(v).slice(0, 10);

/** Only the non-zero age buckets, in order, formatted. */
const buckets = (b: Record<string, number>): Record<string, string> =>
  Object.fromEntries(AGEING_BUCKETS.filter((k) => (b[k] ?? 0) !== 0).map((k) => [k, amt(b[k])]));

const overdueOf = (b: Record<string, number>): number =>
  Object.entries(b).reduce((t, [k, v]) => (k === 'Current' ? t : t + v), 0);

/** The age buckets summed over some parties — one customer's, when a question names one. */
const bucketTotals = (rows: { buckets: Record<string, number> }[]): Record<string, number> => {
  const t: Record<string, number> = {};
  for (const r of rows) for (const [k, v] of Object.entries(r.buckets)) t[k] = (t[k] ?? 0) + v;
  return t;
};

const owedBy = (rows: { totalPaise: number }[]): number => rows.filter((r) => r.totalPaise > 0).reduce((t, r) => t + r.totalPaise, 0);

// ── Arguments ────────────────────────────────────────────────────────────────

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');
const Month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM.');
const Limit = z.number().int().min(1).max(25);

const P = {
  day: (description: string) => ({ type: 'string', description, pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
  month: (description: string) => ({ type: 'string', description, pattern: '^\\d{4}-\\d{2}$' }),
  text: (description: string) => ({ type: 'string', description }),
  limit: (description = 'How many rows to return, 1–25. Defaults to 10.') => ({ type: 'integer', description, minimum: 1, maximum: 25 }),
  oneOf: (values: string[], description: string) => ({ type: 'string', enum: values, description }),
};

const params = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

/** A period from optional dates: the financial year to date unless told otherwise. */
function period(ctx: ToolContext, from?: string, to?: string): { from: string; to: string } {
  let f = from ?? (to ? fyStartOf(to) : ctx.fyStart);
  let t = to ?? ctx.today;
  if (f > t) [f, t] = [t, f];
  return { from: f, to: t };
}

// ── Finding an account by the words someone used ────────────────────────────

interface AccountRow {
  id: number;
  code: string;
  name: string;
  type: AccountType;
}

const STOP = new Set(['account', 'accounts', 'a', 'c', 'ac', 'the', 'balance', 'closing', 'opening', 'ledger', 'of', 'for', 'in', 'my', 'our', 'current']);
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * The account a phrase most likely means — "HDFC", "rent", "1100", "cash" —
 * or, when two are equally likely, the candidates to choose between. Bank
 * accounts match on their bank name too, since that is what people call them.
 */
async function resolveAccount(ex: Executor, orgId: number, query: string): Promise<{ match: AccountRow | null; candidates: AccountRow[] }> {
  const [accounts, banks] = await Promise.all([
    ex.selectFrom('accounts').select(['id', 'code', 'name', 'type']).where('org_id', '=', orgId).where('is_active', '=', 1).execute(),
    ex.selectFrom('bank_accounts').select(['name', 'bank_name', 'ledger_account_id']).where('org_id', '=', orgId).execute(),
  ]);

  // A bank account's own name ("HDFC Bank – Current") says which account it
  // is. The bank it is held at ("HDFC Bank") does not — a current account and
  // a credit card can share one — so that match counts for less.
  const displayNames = new Map<number, string[]>();
  const institutions = new Map<number, string[]>();
  for (const b of banks) {
    displayNames.set(b.ledger_account_id, [...(displayNames.get(b.ledger_account_id) ?? []), b.name]);
    if (b.bank_name) institutions.set(b.ledger_account_id, [...(institutions.get(b.ledger_account_id) ?? []), b.bank_name]);
  }

  const raw = query.trim();
  const q = norm(raw);
  const tokens = q.split(' ').filter((t) => t && !STOP.has(t));

  const scored = accounts
    .map((a) => {
      const names = [a.name, ...(displayNames.get(a.id) ?? [])].map(norm);
      const heldAt = (institutions.get(a.id) ?? []).map(norm);
      let score = 0;
      if (a.code === raw) score = 100;
      else if (names.includes(q)) score = 90;
      else if (tokens.length && names.some((n) => tokens.every((t) => n.includes(t)))) {
        score = 60 + (names.some((n) => n.startsWith(tokens[0])) ? 10 : 0);
      } else if (tokens.length && heldAt.some((n) => tokens.every((t) => n.includes(t)))) {
        score = 40;
      } else if (tokens.length) {
        const hits = Math.max(0, ...[...names, ...heldAt].map((n) => tokens.filter((t) => n.includes(t)).length));
        score = hits ? 20 + hits * 5 : 0;
      }
      return { a: a as AccountRow, score };
    })
    .filter((x) => x.score > 0)
    .sort((x, y) => y.score - x.score || x.a.code.localeCompare(y.a.code));

  const best = scored[0];
  const clear = !!best && best.score >= 60 && (!scored[1] || scored[1].score < best.score);
  return { match: clear ? best.a : null, candidates: scored.slice(0, 6).map((x) => x.a) };
}

// ── The tools ────────────────────────────────────────────────────────────────

interface ToolDef<A> {
  name: string;
  /** Shown while it runs: "Reading the ledger…". */
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  schema: z.ZodType<A>;
  gate: Gate;
  run: (ctx: ToolContext, args: A) => Promise<{ data: unknown; sources?: ToolSource[]; report?: ReportDraft | null }>;
}

const define = <A>(d: ToolDef<A>): ToolDef<A> => d;

// The list holds tools with different argument shapes. Each validates its own
// arguments with its schema before `run` sees them, so the list itself can
// forget the shapes.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTool = ToolDef<any>;

const REPORT_FOR_GROUP: Record<string, string> = {
  customer: '/reports/sales-by-customer',
  item: '/reports/sales-by-item',
  salesperson: '/reports/sales-by-salesperson',
  month: '/reports/sales-by-customer',
};

const TOOLS: AnyTool[] = [
  define({
    name: 'get_account_balance',
    label: 'Reading the ledger',
    description:
      'Opening balance, debits, credits and closing balance of one ledger account — a bank, cash, receivables, a tax account, an income or expense account — for a period, with its latest entries. Use for "closing balance of X", "how much is in HDFC", "what have we spent on rent".',
    parameters: params(
      {
        account: P.text('The account name or code, for example "HDFC Bank", "Rent", "Cash in Hand" or "1100".'),
        as_of: P.day('Balance date, YYYY-MM-DD. Defaults to today.'),
        from: P.day('Start of the period the debits and credits cover. Defaults to the start of that financial year.'),
      },
      ['account'],
    ),
    schema: z.object({ account: z.string().trim().min(1).max(120), as_of: Day.optional(), from: Day.optional() }),
    gate: 'costs',
    run: async (ctx, a) => {
      const { match, candidates } = await resolveAccount(ctx.ex, ctx.orgId, a.account);
      if (!match) {
        return {
          data: {
            found: false,
            query: a.account,
            candidates: candidates.map((c) => ({ code: c.code, name: c.name, type: c.type })),
            hint: candidates.length
              ? 'More than one account could be meant. Pick the obvious one by calling again with its code, or ask which one.'
              : 'No account matches. Call list_accounts to see the chart of accounts.',
          },
        };
      }
      const asOf = a.as_of ?? ctx.today;
      let from = a.from ?? fyStartOf(asOf);
      if (from > asOf) from = fyStartOf(asOf);
      const gl = await generalLedger(ctx.ex, ctx.orgId, match.id, from, asOf);
      const debitNormal = isDebitNormal(match.type);
      return {
        data: {
          found: true,
          account: { code: match.code, name: match.name, type: match.type, normal_side: debitNormal ? 'Dr' : 'Cr' },
          period: { from, to: asOf },
          opening_balance: withSide(gl.openingPaise, debitNormal),
          debits: amt(gl.lines.reduce((t, l) => t + l.debitPaise, 0)),
          credits: amt(gl.lines.reduce((t, l) => t + l.creditPaise, 0)),
          closing_balance: withSide(gl.closingPaise, debitNormal),
          entries_in_period: gl.lines.length,
          latest_entries: gl.lines
            .slice(-6)
            .reverse()
            .map((l) => ({
              date: day(l.date),
              detail: l.description || l.memo || l.sourceType,
              party: l.contactName ?? undefined,
              debit: l.debitPaise ? amt(l.debitPaise) : undefined,
              credit: l.creditPaise ? amt(l.creditPaise) : undefined,
            })),
        },
        sources: [{ label: `General ledger · ${match.name}`, href: '/reports/general-ledger' }],
        report: safely(() =>
          accountBalanceReport({
            account: match,
            debitNormal,
            from,
            to: asOf,
            openingPaise: gl.openingPaise,
            closingPaise: gl.closingPaise,
            lines: gl.lines,
          }),
        ),
      };
    },
  }),

  define({
    name: 'list_accounts',
    label: 'Looking through the chart of accounts',
    description:
      "The chart of accounts with each account's balance today. Filter by type or by a word in the name. Use to find the right account, or to see every balance of one kind.",
    parameters: params({
      type: P.oneOf(['asset', 'liability', 'equity', 'income', 'expense'], 'Only accounts of this type.'),
      search: P.text('A word to look for in the account name or code.'),
    }),
    schema: z.object({
      type: z.enum(['asset', 'liability', 'equity', 'income', 'expense']).optional(),
      search: z.string().trim().max(80).optional(),
    }),
    gate: 'costs',
    run: async (ctx, a) => {
      const tb = await trialBalance(ctx.ex, ctx.orgId, ctx.today);
      const balance = new Map(tb.rows.map((r) => [r.accountId, r.balancePaise]));
      let rows = await ctx.ex
        .selectFrom('accounts')
        .select(['id', 'code', 'name', 'type'])
        .where('org_id', '=', ctx.orgId)
        .where('is_active', '=', 1)
        .orderBy('code')
        .execute();
      if (a.type) rows = rows.filter((r) => r.type === a.type);
      if (a.search) {
        const s = a.search.toLowerCase();
        rows = rows.filter((r) => r.name.toLowerCase().includes(s) || r.code.includes(s));
      }
      return {
        data: {
          as_of: ctx.today,
          count: rows.length,
          accounts: rows.slice(0, 60).map((r) => ({
            code: r.code,
            name: r.name,
            type: r.type,
            balance: withSide(balance.get(String(r.id)) ?? 0, isDebitNormal(r.type)),
          })),
          truncated: rows.length > 60 || undefined,
        },
        sources: [{ label: 'Chart of accounts', href: '/accountant/chart-of-accounts' }],
      };
    },
  }),

  define({
    name: 'get_trial_balance',
    label: 'Running the trial balance',
    description: 'The trial balance on a date: every account with a balance, on its debit or credit side, and whether the two columns agree.',
    parameters: params({ as_of: P.day('The date, YYYY-MM-DD. Defaults to today.') }),
    schema: z.object({ as_of: Day.optional() }),
    gate: 'costs',
    run: async (ctx, a) => {
      const asOf = a.as_of ?? ctx.today;
      const tb = await trialBalance(ctx.ex, ctx.orgId, asOf);
      const rows = [...tb.rows].sort((x, y) => Math.max(y.debitSide, y.creditSide) - Math.max(x.debitSide, x.creditSide));
      return {
        data: {
          as_of: asOf,
          total_debit: amt(tb.totalDebit),
          total_credit: amt(tb.totalCredit),
          balanced: tb.balanced,
          accounts_with_a_balance: rows.length,
          rows: rows.slice(0, 40).map((r) => ({
            code: r.code,
            name: r.name,
            debit: r.debitSide ? amt(r.debitSide) : undefined,
            credit: r.creditSide ? amt(r.creditSide) : undefined,
          })),
          truncated: rows.length > 40 || undefined,
        },
        sources: [{ label: 'Trial balance', href: '/reports/trial-balance' }],
        report: safely(() =>
          trialBalanceReport({ asOf, totalDebit: tb.totalDebit, totalCredit: tb.totalCredit, balanced: tb.balanced, rows }),
        ),
      };
    },
  }),

  define({
    name: 'get_profit_and_loss',
    label: 'Running the profit and loss',
    description:
      'Income, expenses, gross and net profit for a period, the largest accounts on each side, and the same figures for the equal-length period just before — for "are we making money", "profit this quarter", "how does this compare".',
    parameters: params({
      from: P.day('Start date, YYYY-MM-DD. Defaults to the start of the financial year.'),
      to: P.day('End date, YYYY-MM-DD. Defaults to today.'),
    }),
    schema: z.object({ from: Day.optional(), to: Day.optional() }),
    gate: 'costs',
    run: async (ctx, a) => {
      const w = period(ctx, a.from, a.to);
      const prev = previousWindow(w);
      const [pl, before] = await Promise.all([
        profitAndLoss(ctx.ex, ctx.orgId, w.from, w.to),
        profitAndLoss(ctx.ex, ctx.orgId, prev.from, prev.to),
      ]);
      return {
        data: {
          period: w,
          income: amt(pl.totalIncome),
          expenses_as_posted: amt(pl.totalExpense),
          // Purchases are expensed when billed; these turn them into the cost of what sold.
          opening_stock: amt(pl.openingStockPaise),
          closing_stock: amt(pl.closingStockPaise),
          cost_of_goods_sold: amt(pl.costOfGoodsSoldPaise),
          gross_profit: amt(pl.grossProfit),
          net_profit: amt(pl.netProfit),
          result: pl.netProfit >= 0 ? 'profit' : 'loss',
          net_margin: pl.totalIncome ? pct((pl.netProfit / pl.totalIncome) * 100) : 'no income in the period',
          income_accounts: [...pl.incomeRows].sort((x, y) => y.balancePaise - x.balancePaise).slice(0, 8).map((r) => ({ name: r.name, amount: amt(r.balancePaise) })),
          expense_accounts: [...pl.expenseRows].sort((x, y) => y.balancePaise - x.balancePaise).slice(0, 10).map((r) => ({ name: r.name, amount: amt(r.balancePaise) })),
          previous_period: {
            from: prev.from,
            to: prev.to,
            income: amt(before.totalIncome),
            expenses_after_stock: amt(before.totalExpense + before.openingStockPaise - before.closingStockPaise),
            net_profit: amt(before.netProfit),
          },
        },
        sources: [{ label: 'Profit and loss', href: '/reports/profit-and-loss' }],
        report: safely(() =>
          profitAndLossReport({
            from: w.from,
            to: w.to,
            prev,
            now: {
              income: pl.totalIncome,
              expense: pl.totalExpense + pl.openingStockPaise - pl.closingStockPaise,
              gross: pl.grossProfit,
              net: pl.netProfit,
            },
            before: {
              income: before.totalIncome,
              expense: before.totalExpense + before.openingStockPaise - before.closingStockPaise,
              net: before.netProfit,
            },
            expenseRows: pl.expenseRows,
          }),
        ),
      };
    },
  }),

  define({
    name: 'get_balance_sheet',
    label: 'Running the balance sheet',
    description: 'Assets, liabilities and equity on a date, with the largest accounts in each, and whether it balances.',
    parameters: params({ as_of: P.day('The date, YYYY-MM-DD. Defaults to today.') }),
    schema: z.object({ as_of: Day.optional() }),
    gate: 'costs',
    run: async (ctx, a) => {
      const asOf = a.as_of ?? ctx.today;
      const bs = await balanceSheet(ctx.ex, ctx.orgId, asOf);
      const top = (rows: { name: string; balancePaise: number }[]) =>
        [...rows].sort((x, y) => Math.abs(y.balancePaise) - Math.abs(x.balancePaise)).slice(0, 12).map((r) => ({ name: r.name, amount: amt(r.balancePaise) }));
      return {
        data: {
          as_of: asOf,
          total_assets: amt(bs.totalAssets),
          total_liabilities: amt(bs.totalLiabilities),
          total_equity: amt(bs.totalEquity),
          profit_this_financial_year: amt(bs.currentPeriodEarnings),
          retained_earnings_from_earlier_years: amt(bs.priorYearsEarnings),
          closing_stock_at_weighted_average_cost: amt(bs.closingStockPaise),
          balanced: bs.balanced,
          assets: top(bs.assetRows),
          liabilities: top(bs.liabilityRows),
          equity: top(bs.equityRows),
        },
        sources: [{ label: 'Balance sheet', href: '/reports/balance-sheet' }],
        report: safely(() =>
          balanceSheetReport({
            asOf,
            assets: bs.totalAssets,
            liabilities: bs.totalLiabilities,
            equity: bs.totalEquity,
            currentEarnings: bs.currentPeriodEarnings,
            balanced: bs.balanced,
            assetRows: bs.assetRows,
            liabilityRows: bs.liabilityRows,
          }),
        ),
      };
    },
  }),

  define({
    name: 'get_cash_position',
    label: 'Checking the bank and cash accounts',
    description: 'Today’s balance in every bank, cash and card account, the total cash available, and how many statement lines are not yet reconciled.',
    parameters: params({}),
    schema: z.object({}),
    gate: 'cash',
    run: async (ctx) => {
      const rows = await cashPosition(ctx.ex, ctx.orgId);
      const cash = rows.filter((r) => r.kind !== 'card');
      return {
        data: {
          as_of: ctx.today,
          total_cash_and_bank: amt(cash.reduce((t, r) => t + r.balancePaise, 0)),
          accounts: rows.map((r) => ({
            name: r.name,
            kind: r.kind,
            balance: r.kind === 'card' ? `${amt(Math.max(0, -r.balancePaise))} owed on the card` : amt(r.balancePaise),
            unreconciled_statement_lines: r.unmatched || undefined,
          })),
        },
        sources: [{ label: 'Banking', href: '/banking' }],
        report: safely(() =>
          cashPositionReport({
            asOf: ctx.today,
            rows: rows.map((r) => ({ name: r.name, kind: r.kind, balancePaise: r.balancePaise, unmatched: Number(r.unmatched ?? 0) })),
          }),
        ),
      };
    },
  }),

  define({
    name: 'get_receivables',
    label: 'Ageing what customers owe',
    description:
      'What customers owe on a date, aged from the due date (Current, 1–15, 16–30, 31–45, 46–60, 60+ days overdue), the customers who owe most, and — for one named customer — their open invoices.',
    parameters: params({
      as_of: P.day('The date, YYYY-MM-DD. Defaults to today.'),
      customer: P.text('Part of a customer name, to see that customer in detail.'),
    }),
    schema: z.object({ as_of: Day.optional(), customer: z.string().trim().min(1).max(100).optional() }),
    gate: 'sales',
    run: async (ctx, a) => {
      const asOf = a.as_of ?? ctx.today;
      const ar = await ageing(ctx.ex, ctx.orgId, 'receivable', asOf);
      const rows = a.customer ? ar.rows.filter((r) => r.name.toLowerCase().includes(a.customer!.toLowerCase())) : ar.rows;

      let openInvoices: unknown;
      if (a.customer) {
        const inv = await ctx.ex
          .selectFrom('invoices')
          .innerJoin('contacts', 'contacts.id', 'invoices.customer_id')
          .select(['invoices.number', 'invoices.invoice_date', 'invoices.due_date', 'invoices.total', 'invoices.amount_paid', 'contacts.display_name'])
          .where('invoices.org_id', '=', ctx.orgId)
          .where('invoices.status', 'not in', ['draft', 'void'])
          .where(sql<boolean>`invoices.total > invoices.amount_paid`)
          .where('contacts.display_name', 'like', `%${a.customer}%`)
          .orderBy('invoices.due_date')
          .limit(15)
          .execute();
        openInvoices = inv.map((i) => ({
          number: i.number,
          customer: i.display_name,
          date: day(i.invoice_date),
          due: day(i.due_date),
          balance: amt(toPaiseFromSql(i.total) - toPaiseFromSql(i.amount_paid)),
          days_overdue: Math.max(0, daysBetween(day(i.due_date), ctx.today)),
        }));
      }

      // The ageing report's total is net: customers who have paid in advance
      // are a credit against it. Said as two figures and the net, so "owed"
      // and "overdue" are never compared across different bases.
      const owed = ar.rows.filter((r) => r.totalPaise > 0).reduce((t, r) => t + r.totalPaise, 0);
      const advances = -ar.rows.filter((r) => r.totalPaise < 0).reduce((t, r) => t + r.totalPaise, 0);
      return {
        data: {
          as_of: asOf,
          owed_by_customers: amt(owed),
          overdue: amt(overdueOf(ar.totals)),
          advances_held_for_customers: advances ? amt(advances) : undefined,
          net_receivable_as_in_the_ageing_report: amt(ar.grandTotalPaise),
          by_days_overdue: buckets(ar.totals),
          customers_with_a_balance: ar.rows.length,
          customers: rows.slice(0, 12).map((r) => ({
            name: r.name,
            owes: amt(r.totalPaise),
            overdue: amt(overdueOf(r.buckets)),
            by_days_overdue: buckets(r.buckets),
          })),
          open_invoices: openInvoices,
          note: a.customer && asOf !== ctx.today ? 'Open invoices are listed as they stand today.' : undefined,
        },
        sources: [
          { label: 'Receivables ageing', href: '/reports/ar-ageing' },
          ...(a.customer ? [{ label: 'Invoices', href: '/sales/invoices' }] : []),
        ],
        // For one named customer the chart and the figures are theirs alone.
        report: safely(() =>
          ageingReport({
            side: 'receivable',
            asOf,
            buckets: AGEING_BUCKETS,
            totals: a.customer ? bucketTotals(rows) : ar.totals,
            rows,
            owed: a.customer ? owedBy(rows) : owed,
            advances: a.customer ? undefined : advances,
          }),
        ),
      };
    },
  }),

  define({
    name: 'get_payables',
    label: 'Ageing what we owe suppliers',
    description:
      'What the business owes suppliers on a date, aged from the due date, the suppliers owed most, and unpaid bills from MSME suppliers with their days left under the 45-day rule (section 43B(h)). For one named supplier, their open bills.',
    parameters: params({
      as_of: P.day('The date, YYYY-MM-DD. Defaults to today.'),
      vendor: P.text('Part of a supplier name, to see that supplier in detail.'),
    }),
    schema: z.object({ as_of: Day.optional(), vendor: z.string().trim().min(1).max(100).optional() }),
    gate: 'purchases',
    run: async (ctx, a) => {
      const asOf = a.as_of ?? ctx.today;
      const [ap, msme] = await Promise.all([
        ageing(ctx.ex, ctx.orgId, 'payable', asOf),
        sql<{ name: string; internal_no: string; vendor_invoice_no: string; bill_date: string; balance: string }>`
          SELECT c.display_name AS name, b.internal_no, b.vendor_invoice_no, b.bill_date,
                 (b.total - b.amount_paid) AS balance
            FROM bills b JOIN contacts c ON c.id = b.vendor_id
           WHERE b.org_id = ${ctx.orgId} AND c.is_msme = 1
             AND b.status NOT IN ('draft', 'void') AND b.total > b.amount_paid
           ORDER BY b.bill_date, b.id
           LIMIT 12
        `.execute(ctx.ex),
      ]);
      const rows = a.vendor ? ap.rows.filter((r) => r.name.toLowerCase().includes(a.vendor!.toLowerCase())) : ap.rows;

      let openBills: unknown;
      if (a.vendor) {
        const bills = await ctx.ex
          .selectFrom('bills')
          .innerJoin('contacts', 'contacts.id', 'bills.vendor_id')
          .select(['bills.internal_no', 'bills.vendor_invoice_no', 'bills.bill_date', 'bills.due_date', 'bills.total', 'bills.amount_paid', 'contacts.display_name'])
          .where('bills.org_id', '=', ctx.orgId)
          .where('bills.status', 'not in', ['draft', 'void'])
          .where(sql<boolean>`bills.total > bills.amount_paid`)
          .where('contacts.display_name', 'like', `%${a.vendor}%`)
          .orderBy('bills.due_date')
          .limit(15)
          .execute();
        openBills = bills.map((b) => ({
          bill: b.internal_no,
          supplier_invoice: b.vendor_invoice_no,
          supplier: b.display_name,
          date: day(b.bill_date),
          due: day(b.due_date),
          balance: amt(toPaiseFromSql(b.total) - toPaiseFromSql(b.amount_paid)),
          days_overdue: Math.max(0, daysBetween(day(b.due_date), ctx.today)),
        }));
      }

      const owedTo = ap.rows.filter((r) => r.totalPaise > 0).reduce((t, r) => t + r.totalPaise, 0);
      const paidAhead = -ap.rows.filter((r) => r.totalPaise < 0).reduce((t, r) => t + r.totalPaise, 0);
      return {
        data: {
          as_of: asOf,
          owed_to_suppliers: amt(owedTo),
          overdue: amt(overdueOf(ap.totals)),
          advances_paid_to_suppliers: paidAhead ? amt(paidAhead) : undefined,
          net_payable_as_in_the_ageing_report: amt(ap.grandTotalPaise),
          by_days_overdue: buckets(ap.totals),
          suppliers: rows.slice(0, 12).map((r) => ({
            name: r.name,
            owed: amt(r.totalPaise),
            overdue: amt(overdueOf(r.buckets)),
            by_days_overdue: buckets(r.buckets),
          })),
          msme_bills_unpaid: msme.rows.map((b) => {
            const age = daysBetween(day(b.bill_date), ctx.today);
            return {
              supplier: b.name,
              bill: b.internal_no,
              supplier_invoice: b.vendor_invoice_no,
              days_since_bill: age,
              balance: amt(toPaiseFromSql(b.balance)),
              status: age >= 45 ? 'past 45 days — the deduction is lost for this year until paid' : age >= 38 ? `due within ${45 - age} days` : `${45 - age} days left`,
            };
          }),
          open_bills: openBills,
        },
        sources: [
          { label: 'Payables ageing', href: '/reports/ap-ageing' },
          ...(msme.rows.length ? [{ label: 'MSME 45-day tracker', href: '/purchases/msme-tracker' }] : []),
        ],
        report: safely(() =>
          ageingReport({
            side: 'payable',
            asOf,
            buckets: AGEING_BUCKETS,
            totals: a.vendor ? bucketTotals(rows) : ap.totals,
            rows,
            owed: a.vendor ? owedBy(rows) : owedTo,
            advances: a.vendor ? undefined : paidAhead,
            msme: {
              unpaid: msme.rows.length,
              past45: msme.rows.filter((b) => daysBetween(day(b.bill_date), ctx.today) >= 45).length,
            },
          }),
        ),
      };
    },
  }),

  define({
    name: 'search_invoices',
    label: 'Searching invoices',
    description: 'Find sales invoices by customer, status and date range, with the total and unpaid amount across everything that matches.',
    parameters: params({
      customer: P.text('Part of a customer name.'),
      status: P.oneOf(['unpaid', 'overdue', 'paid', 'draft', 'any'], 'Which invoices. Defaults to any.'),
      from: P.day('Invoice date from, YYYY-MM-DD.'),
      to: P.day('Invoice date to, YYYY-MM-DD.'),
      limit: P.limit(),
    }),
    schema: z.object({
      customer: z.string().trim().min(1).max(100).optional(),
      status: z.enum(['unpaid', 'overdue', 'paid', 'draft', 'any']).optional(),
      from: Day.optional(),
      to: Day.optional(),
      limit: Limit.optional(),
    }),
    gate: 'sales',
    run: async (ctx, a) => {
      const conds: RawBuilder<unknown>[] = [sql`i.org_id = ${ctx.orgId}`, sql`i.status <> 'void'`];
      if (a.customer) conds.push(sql`c.display_name LIKE ${`%${a.customer}%`}`);
      if (a.from) conds.push(sql`i.invoice_date >= ${a.from}`);
      if (a.to) conds.push(sql`i.invoice_date <= ${a.to}`);
      const unpaid = sql`i.status <> 'draft' AND i.total > i.amount_paid`;
      if (a.status === 'unpaid') conds.push(unpaid);
      if (a.status === 'overdue') conds.push(sql`${unpaid} AND i.due_date < ${ctx.today}`);
      if (a.status === 'paid') conds.push(sql`i.status <> 'draft' AND i.total <= i.amount_paid`);
      if (a.status === 'draft') conds.push(sql`i.status = 'draft'`);
      const where = sql.join(conds, sql` AND `);
      const limit = a.limit ?? 10;

      const [rows, agg] = await Promise.all([
        sql<{ number: string; invoice_date: string; due_date: string; status: string; total: string; amount_paid: string; name: string }>`
          SELECT i.number, i.invoice_date, i.due_date, i.status, i.total, i.amount_paid, c.display_name AS name
            FROM invoices i JOIN contacts c ON c.id = i.customer_id
           WHERE ${where}
           ORDER BY i.invoice_date DESC, i.id DESC
           LIMIT ${limit}
        `.execute(ctx.ex),
        sql<{ n: string; total: string; unpaid: string }>`
          SELECT COUNT(*) AS n, COALESCE(SUM(i.total), 0) AS total, COALESCE(SUM(i.total - i.amount_paid), 0) AS unpaid
            FROM invoices i JOIN contacts c ON c.id = i.customer_id
           WHERE ${where}
        `.execute(ctx.ex),
      ]);
      const t = agg.rows[0];
      return {
        data: {
          matching: Number(t?.n ?? 0),
          total_value: amt(toPaiseFromSql(t?.total ?? 0)),
          unpaid: amt(toPaiseFromSql(t?.unpaid ?? 0)),
          shown: rows.rows.length,
          invoices: rows.rows.map((r) => {
            const balance = toPaiseFromSql(r.total) - toPaiseFromSql(r.amount_paid);
            return {
              number: r.number,
              customer: r.name,
              date: day(r.invoice_date),
              due: day(r.due_date),
              status: r.status,
              total: amt(toPaiseFromSql(r.total)),
              balance: amt(balance),
              days_overdue: balance > 0 && r.status !== 'draft' ? Math.max(0, daysBetween(day(r.due_date), ctx.today)) : undefined,
            };
          }),
        },
        sources: [{ label: 'Invoices', href: '/sales/invoices' }],
        report: safely(() =>
          documentsReport({
            kind: 'invoice',
            matching: Number(t?.n ?? 0),
            totalValue: toPaiseFromSql(t?.total ?? 0),
            unpaid: toPaiseFromSql(t?.unpaid ?? 0),
            docs: rows.rows.map((r) => {
              const balance = toPaiseFromSql(r.total) - toPaiseFromSql(r.amount_paid);
              return {
                number: r.number,
                party: r.name,
                due: day(r.due_date),
                status: r.status,
                balance,
                daysOverdue: balance > 0 && r.status !== 'draft' ? Math.max(0, daysBetween(day(r.due_date), ctx.today)) : undefined,
              };
            }),
          }),
        ),
      };
    },
  }),

  define({
    name: 'search_bills',
    label: 'Searching supplier bills',
    description: 'Find supplier bills by supplier, status and date range, with the total and unpaid amount across everything that matches.',
    parameters: params({
      vendor: P.text('Part of a supplier name.'),
      status: P.oneOf(['unpaid', 'overdue', 'paid', 'draft', 'any'], 'Which bills. Defaults to any.'),
      from: P.day('Bill date from, YYYY-MM-DD.'),
      to: P.day('Bill date to, YYYY-MM-DD.'),
      limit: P.limit(),
    }),
    schema: z.object({
      vendor: z.string().trim().min(1).max(100).optional(),
      status: z.enum(['unpaid', 'overdue', 'paid', 'draft', 'any']).optional(),
      from: Day.optional(),
      to: Day.optional(),
      limit: Limit.optional(),
    }),
    gate: 'purchases',
    run: async (ctx, a) => {
      const conds: RawBuilder<unknown>[] = [sql`b.org_id = ${ctx.orgId}`, sql`b.status <> 'void'`];
      if (a.vendor) conds.push(sql`c.display_name LIKE ${`%${a.vendor}%`}`);
      if (a.from) conds.push(sql`b.bill_date >= ${a.from}`);
      if (a.to) conds.push(sql`b.bill_date <= ${a.to}`);
      const unpaid = sql`b.status <> 'draft' AND b.total > b.amount_paid`;
      if (a.status === 'unpaid') conds.push(unpaid);
      if (a.status === 'overdue') conds.push(sql`${unpaid} AND b.due_date < ${ctx.today}`);
      if (a.status === 'paid') conds.push(sql`b.status <> 'draft' AND b.total <= b.amount_paid`);
      if (a.status === 'draft') conds.push(sql`b.status = 'draft'`);
      const where = sql.join(conds, sql` AND `);
      const limit = a.limit ?? 10;

      const [rows, agg] = await Promise.all([
        sql<{ internal_no: string; vendor_invoice_no: string; bill_date: string; due_date: string; status: string; total: string; amount_paid: string; name: string }>`
          SELECT b.internal_no, b.vendor_invoice_no, b.bill_date, b.due_date, b.status, b.total, b.amount_paid, c.display_name AS name
            FROM bills b JOIN contacts c ON c.id = b.vendor_id
           WHERE ${where}
           ORDER BY b.bill_date DESC, b.id DESC
           LIMIT ${limit}
        `.execute(ctx.ex),
        sql<{ n: string; total: string; unpaid: string }>`
          SELECT COUNT(*) AS n, COALESCE(SUM(b.total), 0) AS total, COALESCE(SUM(b.total - b.amount_paid), 0) AS unpaid
            FROM bills b JOIN contacts c ON c.id = b.vendor_id
           WHERE ${where}
        `.execute(ctx.ex),
      ]);
      const t = agg.rows[0];
      return {
        data: {
          matching: Number(t?.n ?? 0),
          total_value: amt(toPaiseFromSql(t?.total ?? 0)),
          unpaid: amt(toPaiseFromSql(t?.unpaid ?? 0)),
          shown: rows.rows.length,
          bills: rows.rows.map((r) => {
            const balance = toPaiseFromSql(r.total) - toPaiseFromSql(r.amount_paid);
            return {
              bill: r.internal_no,
              supplier_invoice: r.vendor_invoice_no,
              supplier: r.name,
              date: day(r.bill_date),
              due: day(r.due_date),
              status: r.status,
              total: amt(toPaiseFromSql(r.total)),
              balance: amt(balance),
              days_overdue: balance > 0 && r.status !== 'draft' ? Math.max(0, daysBetween(day(r.due_date), ctx.today)) : undefined,
            };
          }),
        },
        sources: [{ label: 'Bills', href: '/purchases/bills' }],
        report: safely(() =>
          documentsReport({
            kind: 'bill',
            matching: Number(t?.n ?? 0),
            totalValue: toPaiseFromSql(t?.total ?? 0),
            unpaid: toPaiseFromSql(t?.unpaid ?? 0),
            docs: rows.rows.map((r) => {
              const balance = toPaiseFromSql(r.total) - toPaiseFromSql(r.amount_paid);
              return {
                number: r.internal_no,
                party: r.name,
                due: day(r.due_date),
                status: r.status,
                balance,
                daysOverdue: balance > 0 && r.status !== 'draft' ? Math.max(0, daysBetween(day(r.due_date), ctx.today)) : undefined,
              };
            }),
          }),
        ),
      };
    },
  }),

  define({
    name: 'get_sales_summary',
    label: 'Summarising sales',
    description: 'Sales for a period grouped by customer, item, salesperson or month — before tax, tax and total — with the period total. For "top customers", "best-selling items", "sales by month".',
    parameters: params({
      from: P.day('Start date, YYYY-MM-DD. Defaults to the start of the financial year.'),
      to: P.day('End date, YYYY-MM-DD. Defaults to today.'),
      group_by: P.oneOf(['customer', 'item', 'salesperson', 'month'], 'How to group. Defaults to customer.'),
      limit: P.limit(),
    }),
    schema: z.object({
      from: Day.optional(),
      to: Day.optional(),
      group_by: z.enum(['customer', 'item', 'salesperson', 'month']).optional(),
      limit: Limit.optional(),
    }),
    gate: 'sales',
    run: async (ctx, a) => {
      const w = period(ctx, a.from, a.to);
      const by = a.group_by ?? 'customer';
      const limit = a.limit ?? 10;

      let rows: { name: string; detail?: string | null; taxable: number; tax: number; count: number; qty?: number }[];
      if (by === 'month') {
        const { rows: months } = await sql<{ m: string; n: string; taxable: string; tax: string }>`
          SELECT DATE_FORMAT(invoice_date, '%Y-%m') AS m, COUNT(*) AS n,
                 COALESCE(SUM(subtotal), 0) AS taxable,
                 COALESCE(SUM(cgst + sgst + igst + cess), 0) AS tax
            FROM invoices
           WHERE org_id = ${ctx.orgId} AND status NOT IN ('draft', 'void')
             AND invoice_date BETWEEN ${w.from} AND ${w.to}
           GROUP BY m ORDER BY m
        `.execute(ctx.ex);
        rows = months.map((r) => ({ name: r.m, taxable: toPaiseFromSql(r.taxable), tax: toPaiseFromSql(r.tax), count: Number(r.n) }));
      } else {
        rows = (await salesBy(ctx.ex, ctx.orgId, by, w)).map((r) => ({
          name: r.name,
          detail: r.detail,
          taxable: r.taxablePaise,
          tax: r.taxPaise,
          count: r.count,
          qty: by === 'item' ? r.qty : undefined,
        }));
      }

      const taxable = rows.reduce((t, r) => t + r.taxable, 0);
      const tax = rows.reduce((t, r) => t + r.tax, 0);
      const shown = by === 'month' ? rows : rows.slice(0, limit);
      return {
        data: {
          period: w,
          group_by: by,
          total_before_tax: amt(taxable),
          total_tax: amt(tax),
          total_invoiced: amt(taxable + tax),
          groups: rows.length,
          rows: shown.map((r) => ({
            [by]: r.name,
            detail: r.detail ?? undefined,
            before_tax: amt(r.taxable),
            tax: amt(r.tax),
            total: amt(r.taxable + r.tax),
            share: taxable ? pct((r.taxable / taxable) * 100) : undefined,
            [by === 'item' ? 'invoice_lines' : 'invoices']: r.count,
            quantity: r.qty,
          })),
        },
        sources: [{ label: by === 'month' ? 'Sales reports' : `Sales by ${by}`, href: REPORT_FOR_GROUP[by] }],
        report: safely(() => salesReport({ from: w.from, to: w.to, by, rows, href: REPORT_FOR_GROUP[by] })),
      };
    },
  }),

  define({
    name: 'get_expense_summary',
    label: 'Summarising expenses',
    description: 'Spending for a period by expense account, largest first, with each one’s share and the total for the equal-length period before.',
    parameters: params({
      from: P.day('Start date, YYYY-MM-DD. Defaults to the start of the financial year.'),
      to: P.day('End date, YYYY-MM-DD. Defaults to today.'),
      limit: P.limit(),
    }),
    schema: z.object({ from: Day.optional(), to: Day.optional(), limit: Limit.optional() }),
    gate: 'costs',
    run: async (ctx, a) => {
      const w = period(ctx, a.from, a.to);
      const prev = previousWindow(w);
      const [rows, before] = await Promise.all([
        expensesByCategory(ctx.ex, ctx.orgId, w),
        expensesByCategory(ctx.ex, ctx.orgId, prev),
      ]);
      const total = rows.reduce((t, r) => t + r.amountPaise, 0);
      const prevTotal = before.reduce((t, r) => t + r.amountPaise, 0);
      return {
        data: {
          period: w,
          total: amt(total),
          previous_period: { from: prev.from, to: prev.to, total: amt(prevTotal) },
          change: prevTotal ? pct(((total - prevTotal) / prevTotal) * 100) : undefined,
          categories: rows.slice(0, a.limit ?? 10).map((r) => ({
            code: r.code,
            name: r.name,
            amount: amt(r.amountPaise),
            share: total ? pct((r.amountPaise / total) * 100) : undefined,
          })),
        },
        sources: [{ label: 'Expenses by category', href: '/reports/expenses-by-category' }],
        report: safely(() => expensesReport({ from: w.from, to: w.to, prev, total, prevTotal, rows })),
      };
    },
  }),

  define({
    name: 'get_gst_summary',
    label: 'Working out the GST position',
    description:
      'GSTR-3B for a month: tax on sales, reverse charge, input tax credit (and what is blocked), how credit is set off head by head, the GST payable in cash, and the filing due dates.',
    parameters: params({ month: P.month('The month, YYYY-MM. Defaults to last month — the return being filed now.') }),
    schema: z.object({ month: Month.optional() }),
    gate: 'gst',
    run: async (ctx, a) => {
      const month = a.month ?? previousMonth(ctx.today);
      const g = await gstr3b(ctx.ex, ctx.orgId, month);
      const [y, m] = month.split('-').map(Number);
      const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
      return {
        data: {
          month,
          tax_on_sales: {
            taxable_value: amt(g.outward.taxablePaise),
            cgst: amt(g.outward.cgstPaise),
            sgst: amt(g.outward.sgstPaise),
            igst: amt(g.outward.igstPaise),
            cess: amt(g.outward.cessPaise),
          },
          reverse_charge_on_purchases: {
            taxable_value: amt(g.inwardRcm.taxablePaise),
            tax: amt(g.inwardRcm.cgstPaise + g.inwardRcm.sgstPaise + g.inwardRcm.igstPaise),
          },
          input_tax_credit: {
            cgst: amt(g.itc.cgstPaise),
            sgst: amt(g.itc.sgstPaise),
            igst: amt(g.itc.igstPaise),
            blocked_not_claimable: amt(g.itc.blockedPaise),
          },
          set_off: g.setOff.map((s) => ({
            head: s.head,
            liability: amt(s.liabilityPaise),
            paid_from_credit: amt(s.creditUsedPaise),
            paid_in_cash: amt(s.cashPaise),
          })),
          payable_in_cash: amt(g.totalCashPaise),
          due_dates: { gstr1: `${next}-11`, gstr3b: `${next}-20` },
          due_date_note: 'For monthly filers. Quarterly (QRMP) filers file GSTR-3B by the 22nd or 24th after the quarter, depending on the state.',
        },
        sources: [{ label: `GSTR-3B · ${month}`, href: '/gst/gstr3b' }],
        report: safely(() =>
          gstReport({
            month,
            outputTax: g.outward.cgstPaise + g.outward.sgstPaise + g.outward.igstPaise + g.outward.cessPaise,
            itc: g.itc.cgstPaise + g.itc.sgstPaise + g.itc.igstPaise,
            blocked: g.itc.blockedPaise,
            cash: g.totalCashPaise,
            setOff: g.setOff,
            due: { gstr1: `${next}-11`, gstr3b: `${next}-20` },
          }),
        ),
      };
    },
  }),

  define({
    name: 'get_business_ratios',
    label: 'Calculating ratios',
    description: 'Gross margin, net margin, current ratio and days sales outstanding for a period, each with what it means and whether it looks healthy.',
    parameters: params({
      from: P.day('Start date, YYYY-MM-DD. Defaults to the start of the financial year.'),
      to: P.day('End date, YYYY-MM-DD. Defaults to today.'),
    }),
    schema: z.object({ from: Day.optional(), to: Day.optional() }),
    gate: 'costs',
    run: async (ctx, a) => {
      const w = period(ctx, a.from, a.to);
      const ratios = await businessRatios(ctx.ex, ctx.orgId, w);
      return {
        data: {
          period: w,
          ratios: ratios.map((r) => ({
            name: r.label,
            value: r.unit === 'pct' ? pct(r.value) : r.unit === 'days' ? `${Math.round(r.value)} days` : r.value.toFixed(2),
            healthy: r.good,
            meaning: r.explain,
          })),
        },
        sources: [{ label: 'Business performance ratios', href: '/reports/business-ratios' }],
        report: safely(() =>
          ratiosReport({
            from: w.from,
            to: w.to,
            ratios: ratios.map((r) => ({ label: r.label, value: r.value, unit: r.unit, good: !!r.good, explain: r.explain })),
          }),
        ),
      };
    },
  }),

  define({
    name: 'get_cash_flow',
    label: 'Tracing the cash flow',
    description: 'Where cash came from and went in a period — operating, investing and financing — with opening and closing cash and the largest movements.',
    parameters: params({
      from: P.day('Start date, YYYY-MM-DD. Defaults to the start of the financial year.'),
      to: P.day('End date, YYYY-MM-DD. Defaults to today.'),
    }),
    schema: z.object({ from: Day.optional(), to: Day.optional() }),
    gate: 'costs',
    run: async (ctx, a) => {
      const w = period(ctx, a.from, a.to);
      const cf = await cashFlow(ctx.ex, ctx.orgId, w);
      return {
        data: {
          period: w,
          opening_cash: amt(cf.openingPaise),
          operating: amt(cf.operatingPaise),
          investing: amt(cf.investingPaise),
          financing: amt(cf.financingPaise),
          closing_cash: amt(cf.closingPaise),
          largest_movements: [...cf.rows]
            .sort((x, y) => Math.abs(y.amountPaise) - Math.abs(x.amountPaise))
            .slice(0, 10)
            .map((r) => ({ what: r.label, group: r.group, amount: amt(r.amountPaise) })),
        },
        sources: [{ label: 'Cash flow statement', href: '/reports/cash-flow' }],
        report: safely(() =>
          cashFlowReport({
            from: w.from,
            to: w.to,
            opening: cf.openingPaise,
            operating: cf.operatingPaise,
            investing: cf.investingPaise,
            financing: cf.financingPaise,
            closing: cf.closingPaise,
            rows: cf.rows,
          }),
        ),
      };
    },
  }),

  define({
    name: 'get_attention_items',
    label: 'Checking what needs attention',
    description:
      'Problems found by rules over the books: duplicate supplier invoice numbers, invoices near the e-invoice deadline, MSME bills near 45 days, missing HSN codes, unapplied payments, negative stock, unreconciled bank lines, invoices left in draft.',
    parameters: params({}),
    schema: z.object({}),
    gate: 'any',
    run: async (ctx) => {
      const flags = await detectFlags(ctx.ex, ctx.orgId, ctx.role);
      return {
        data: {
          count: flags.length,
          items: flags.map((f) => ({ severity: f.severity, title: f.title, detail: f.detail, where: f.href })),
        },
        sources: flags.slice(0, 3).map((f) => ({ label: f.title, href: f.href })),
      };
    },
  }),
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** The tools this role is offered. The rest are not mentioned to the model at all. */
export function toolSpecsFor(role: RoleName): ToolSpec[] {
  return TOOLS.filter((t) => allows(t.gate, role)).map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
}

export const toolNames = (): string[] => TOOLS.map((t) => t.name);

export const toolLabel = (name: string): string => BY_NAME.get(name)?.label ?? 'Looking that up';

/** What this role cannot see, in words the prompt and the page can both use. */
export function hiddenAreas(role: RoleName): string[] {
  const out: string[] = [];
  if (!allows('costs', role)) out.push(HIDDEN_AREA_WORDS.costs);
  if (!allows('sales', role)) out.push(HIDDEN_AREA_WORDS.sales);
  if (!allows('purchases', role)) out.push(HIDDEN_AREA_WORDS.purchases);
  if (!allows('cash', role)) out.push(HIDDEN_AREA_WORDS.banking);
  if (!allows('gst', role)) out.push(HIDDEN_AREA_WORDS.gst);
  return out;
}

/** The most one tool result may add to the conversation. */
const MAX_RESULT_CHARS = 12_000;

/**
 * Run one call the model made. Never throws: a failure is reported back to
 * the model as data, so it can say what went wrong instead of the whole
 * answer failing.
 */
export async function runTool(ctx: ToolContext, call: ToolCall): Promise<ToolRun> {
  const def = BY_NAME.get(call.name);
  const label = toolLabel(call.name);
  const fail = (error: string, details?: string[]): ToolRun => ({
    ok: false,
    content: JSON.stringify(details ? { error, details } : { error }),
    sources: [],
    label,
    report: null,
  });

  // Checked again here, not only when the list was offered: the model can
  // name a tool it was never given, and this is where that is refused.
  if (!def || !allows(def.gate, ctx.role)) return fail(`The tool "${call.name}" is not available to this person.`);

  let args: unknown;
  try {
    args = call.arguments?.trim() ? JSON.parse(call.arguments) : {};
  } catch {
    return fail('The arguments were not valid JSON.');
  }

  const parsed = def.schema.safeParse(args);
  if (!parsed.success) {
    return fail('The arguments did not fit.', parsed.error.issues.map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`));
  }

  try {
    const out = await def.run(ctx, parsed.data);
    let content = JSON.stringify(out.data);
    if (content.length > MAX_RESULT_CHARS) {
      content = JSON.stringify({
        truncated: true,
        note: 'The result was too large to show in full. Ask a narrower question — a shorter period, or one customer.',
        partial: content.slice(0, MAX_RESULT_CHARS - 400),
      });
    }
    return {
      ok: true,
      content,
      sources: out.sources ?? [],
      label,
      report: out.report ? { ...out.report, key: reportKey(def.name, parsed.data) } : null,
    };
  } catch (err) {
    console.error('[ai] tool failed', call.name, err);
    return fail('The report behind this could not be run just now.');
  }
}
