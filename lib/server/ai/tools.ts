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
  accountBalanceReport, ageingReport, balanceSheetReport, budgetReport, cashFlowReport, cashPositionReport, collectionsReport,
  complianceReport, documentsReport, expensesReport, fixedAssetsReport, gstReport, ordersReport, paymentsReport, payrollReport, pendingPaymentsReport,
  profitAndLossReport, projectsReport, ratiosReport, reconciliationReport, reportKey, safely, salesReport, statementReport,
  stockAgeingReport, stockItemReport, stockReport, tdsReport, trialBalanceReport,
  type ReportDraft,
} from './reports';
import { formatDay, fyStartOf, previousMonth } from './time';
import { stockPosition } from '../reports/stock';
import { AGE_BUCKETS, stockAgeing, stockLedger } from '../reports/stock-movement';
import { partyStatement, type StatementSide } from '../reports/party-statement';
import { pendingPurchaseOrders, pendingSalesOrders } from '../reports/orders';
import { budgetVsActual } from '../reports/budgets';
import { stockAlerts } from '../services/stock-alerts';
import { collectionsWorkbench } from '../services/collections';
import { projectFigures } from '../services/projects';
import { assetRegister } from '../services/fixed-assets';
import { listRuns as listPayrollRuns } from '../payroll/payroll';
import { complianceCalendar } from '../tax/compliance-calendar';
import { quarterRange, quarterReturn, type Quarter } from '../tax/tds-returns';
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

type Gate = 'costs' | 'sales' | 'purchases' | 'parties' | 'cash' | 'gst' | 'inventory' | 'projects' | 'payroll' | 'any';

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
    // Customers or suppliers: the tool itself keeps to the side the role can see.
    case 'parties':
      return hasPermission(role, 'sales', 'view') || hasPermission(role, 'purchases', 'view');
    case 'inventory':
      return hasPermission(role, 'inventory', 'view');
    case 'projects':
      return hasPermission(role, 'projects', 'view');
    case 'payroll':
      return hasPermission(role, 'payroll', 'view');
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

export interface AccountRow {
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
  return pickAccount(accounts as AccountRow[], banks, query);
}

export interface BankName {
  name: string;
  bank_name: string | null;
  ledger_account_id: number;
}

/** The scoring behind resolveAccount, on lists already read — the online demo reads them from its recording. */
export function pickAccount(accounts: AccountRow[], banks: BankName[], query: string): { match: AccountRow | null; candidates: AccountRow[] } {
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

// ── Finding a customer or supplier by name ───────────────────────────────────

/** The sides of the business this role can see: customers, suppliers, or both. */
function sidesFor(role: RoleName): StatementSide[] {
  const out: StatementSide[] = [];
  if (hasPermission(role, 'sales', 'view')) out.push('customer');
  if (hasPermission(role, 'purchases', 'view')) out.push('vendor');
  return out;
}

interface ContactRow {
  id: number;
  name: string;
  kind: 'customer' | 'vendor' | 'both';
}

/**
 * The contact a name means, among those on the sides this role can see. An
 * exact name wins; one partial match is taken; more than one is offered back
 * as candidates, never guessed between.
 */
async function findContact(ex: Executor, orgId: number, query: string, sides: StatementSide[]): Promise<{ match: ContactRow | null; candidates: ContactRow[] }> {
  if (!sides.length) return { match: null, candidates: [] };
  const kinds: ('customer' | 'vendor' | 'both')[] = ['both', ...sides];
  const rows = await ex
    .selectFrom('contacts')
    .select(['id', 'display_name', 'legal_name', 'kind'])
    .where('org_id', '=', orgId)
    .where('kind', 'in', kinds)
    .where((eb) => eb.or([eb('display_name', 'like', `%${query}%`), eb('legal_name', 'like', `%${query}%`)]))
    .orderBy('is_archived')
    .orderBy('display_name')
    .limit(10)
    .execute();
  const list = rows.map((r) => ({ id: r.id, name: r.display_name, kind: r.kind, legal: r.legal_name }));
  const q = norm(query);
  const exact = list.filter((r) => norm(r.name) === q || (r.legal && norm(r.legal) === q));
  const pick = exact.length === 1 ? exact[0] : list.length === 1 ? list[0] : null;
  const strip = ({ id, name, kind }: (typeof list)[number]): ContactRow => ({ id, name, kind });
  return { match: pick ? strip(pick) : null, candidates: list.slice(0, 6).map(strip) };
}

const notFoundContact = (query: string, candidates: ContactRow[]) => ({
  found: false,
  query,
  candidates: candidates.map((c) => ({ name: c.name, is: c.kind === 'both' ? 'customer and supplier' : c.kind === 'vendor' ? 'supplier' : 'customer' })),
  hint: candidates.length ? 'More than one contact matches. Call again with the full name, or ask which one.' : 'No customer or supplier matches that name.',
});

/** For a name with no balance: is that a settled account, or nobody by that name? */
async function nobodyOrSettled(ctx: ToolContext, name: string, side: StatementSide): Promise<string> {
  const found = await findContact(ctx.ex, ctx.orgId, name, [side]);
  const who = found.match?.name ?? found.candidates[0]?.name;
  if (who) return `${who} has no balance outstanding: nothing is owed either way.`;
  return `No ${side === 'customer' ? 'customer' : 'supplier'} matches "${name}".`;
}

const shiftDays = (iso: string, days: number): string => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

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
          note: a.customer && !rows.length
            ? await nobodyOrSettled(ctx, a.customer, 'customer')
            : a.customer && asOf !== ctx.today ? 'Open invoices are listed as they stand today.' : undefined,
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
          note: a.vendor && !rows.length ? await nobodyOrSettled(ctx, a.vendor, 'vendor') : undefined,
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

  // ── Beyond the ledger: stock, parties, projects, payroll, compliance ────────

  define({
    name: 'get_stock',
    label: 'Counting the stock',
    description:
      'Stock on hand: the quantity of each item and, for roles that see costs, its value at weighted average cost; items below their minimum level; negative stock. For one named item, its quantity, average cost, minimum level and this year\'s movements. With view "ageing", how long the stock has been on hand.',
    parameters: params({
      item: P.text('Part of an item name, or its SKU, to see that item in detail.'),
      view: P.oneOf(['summary', 'ageing'], 'summary (the default) or ageing.'),
      as_of: P.day('The date, YYYY-MM-DD. Defaults to today.'),
    }),
    schema: z.object({ item: z.string().trim().min(1).max(100).optional(), view: z.enum(['summary', 'ageing']).optional(), as_of: Day.optional() }),
    gate: 'inventory',
    run: async (ctx, a) => {
      const asOf = a.as_of ?? ctx.today;
      const costs = seesCosts(ctx.role);

      if (a.view === 'ageing' && !a.item) {
        if (!costs) return { data: { error: 'Stock ageing is valued at cost, which this role does not see.' } };
        const ag = await stockAgeing(ctx.ex, ctx.orgId, asOf);
        const total = ag.totalsPaise.reduce((t, v) => t + v, 0);
        return {
          data: {
            as_of: asOf,
            method: 'FIFO: the oldest stock is assumed to have gone first',
            stock_value: amt(total),
            by_age: Object.fromEntries(AGE_BUCKETS.map((b, i) => [b, amt(ag.totalsPaise[i] ?? 0)])),
            oldest_items: [...ag.rows]
              .sort((x, y) => (y.oldestDays ?? 0) - (x.oldestDays ?? 0))
              .slice(0, 10)
              .map((r) => ({ item: r.name, quantity: `${r.qty} ${r.uqc}`, value: amt(r.valuePaise), oldest_days: r.oldestDays })),
          },
          sources: [{ label: 'Stock ageing', href: '/reports/stock-ageing' }],
          report: safely(() =>
            stockAgeingReport({
              asOf,
              bands: [...AGE_BUCKETS],
              totals: ag.totalsPaise,
              rows: ag.rows.map((r) => ({ name: r.name, value: r.valuePaise, oldestDays: r.oldestDays })),
            }),
          ),
        };
      }

      const pos = await stockPosition(ctx.ex, ctx.orgId, asOf);
      const lines = pos.lines.filter((l) => !l.isArchived);

      if (a.item) {
        const q = a.item.toLowerCase();
        const exact = lines.find((l) => l.name.toLowerCase() === q || (l.sku ?? '').toLowerCase() === q);
        const hits = exact ? [exact] : lines.filter((l) => l.name.toLowerCase().includes(q) || (l.sku ?? '').toLowerCase().includes(q));
        if (hits.length !== 1) {
          return {
            data: {
              found: false,
              query: a.item,
              candidates: hits.slice(0, 8).map((l) => ({ name: l.name, sku: l.sku })),
              hint: hits.length ? 'More than one item matches. Call again with the full name or SKU, or ask which one.' : 'No stocked item matches. Ask for the stock summary to see every item.',
            },
          };
        }
        const line = hits[0];
        const from = fyStartOf(asOf);
        const [led, item] = await Promise.all([
          stockLedger(ctx.ex, ctx.orgId, Number(line.itemId), from, asOf),
          ctx.ex.selectFrom('items').select(['min_level', 'reorder_level']).where('id', '=', Number(line.itemId)).executeTakeFirst(),
        ]);
        const minRaw = item?.min_level ?? item?.reorder_level ?? null;
        const minLevel = minRaw === null ? null : Number(minRaw);
        const moves = (led?.lines ?? []).map((m) => ({ date: day(m.date), kind: m.kind, number: m.number, qtyIn: m.qtyIn, qtyOut: m.qtyOut, balance: m.balanceQty }));
        return {
          data: {
            found: true,
            as_of: asOf,
            item: line.name,
            sku: line.sku ?? undefined,
            on_hand: `${line.qty} ${line.uqc}`,
            average_cost: costs ? amt(line.unitCostPaise) : undefined,
            value: costs ? amt(line.valuePaise) : undefined,
            minimum_level: minLevel ?? undefined,
            below_minimum: minLevel !== null ? line.qty < minLevel : undefined,
            this_year: { from, came_in: led?.inQty ?? 0, went_out: led?.outQty ?? 0 },
            latest_movements: moves.slice(-8).reverse().map((m) => ({ date: m.date, what: m.kind, document: m.number, in: m.qtyIn || undefined, out: m.qtyOut || undefined, balance: m.balance })),
          },
          sources: [{ label: `Stock ledger · ${line.name}`, href: '/reports/stock-ledger' }],
          report: safely(() =>
            stockItemReport({
              asOf,
              item: {
                name: line.name, sku: line.sku, uqc: line.uqc, qty: line.qty,
                unitCost: costs ? line.unitCostPaise : null, value: costs ? line.valuePaise : null, minLevel,
              },
              from,
              inward: led?.inQty ?? 0,
              outward: led?.outQty ?? 0,
              moves,
            }),
          ),
        };
      }

      const alerts = await stockAlerts(ctx.ex, ctx.orgId, asOf);
      const inStock = lines.filter((l) => l.qty > 0);
      const negative = lines.filter((l) => l.qty < 0);
      const ranked = costs ? [...inStock].sort((x, y) => y.valuePaise - x.valuePaise) : [...inStock].sort((x, y) => y.qty - x.qty);
      return {
        data: {
          as_of: asOf,
          stock_value: costs ? amt(pos.totalValuePaise) : undefined,
          valued_at: costs ? 'weighted average cost' : undefined,
          items_in_stock: inStock.length,
          items_out_of_stock: lines.filter((l) => l.qty === 0).length,
          below_minimum_level: alerts.short.map((s) => ({ item: s.name, on_hand: `${s.qty} ${s.uqc}`, minimum: s.minLevel })),
          negative_stock: negative.slice(0, 10).map((l) => ({ item: l.name, on_hand: `${l.qty} ${l.uqc}` })),
          batches_expired: alerts.expired.length || undefined,
          batches_expiring_within_30_days: alerts.expiring.length || undefined,
          [costs ? 'largest_by_value' : 'largest_by_quantity']: ranked.slice(0, 10).map((l) => ({
            item: l.name,
            on_hand: `${l.qty} ${l.uqc}`,
            value: costs ? amt(l.valuePaise) : undefined,
          })),
        },
        sources: [{ label: 'Stock summary', href: '/inventory/stock' }],
        report: safely(() =>
          stockReport({
            asOf,
            totalValue: costs ? pos.totalValuePaise : null,
            inStock: inStock.length,
            negative: negative.length,
            items: inStock.map((l) => ({ name: l.name, qty: l.qty, uqc: l.uqc, value: costs ? l.valuePaise : null })),
            short: alerts.short,
          }),
        ),
      };
    },
  }),

  define({
    name: 'get_party_statement',
    label: 'Preparing the statement',
    description:
      "A customer's or supplier's statement of account for a period: the opening balance, every invoice, bill, payment, credit note and journal in date order with the running balance, and the closing balance. Use for \"statement for X\", \"how did X's balance come about\", \"what have we invoiced and received from X this year\".",
    parameters: params(
      {
        party: P.text('Part of the customer or supplier name.'),
        side: P.oneOf(['customer', 'vendor'], 'Customer or supplier. Needed only for a contact that is both.'),
        from: P.day('Start date, YYYY-MM-DD. Defaults to the start of the financial year.'),
        to: P.day('End date, YYYY-MM-DD. Defaults to today.'),
      },
      ['party'],
    ),
    schema: z.object({ party: z.string().trim().min(1).max(100), side: z.enum(['customer', 'vendor']).optional(), from: Day.optional(), to: Day.optional() }),
    gate: 'parties',
    run: async (ctx, a) => {
      const sides = sidesFor(ctx.role);
      const found = await findContact(ctx.ex, ctx.orgId, a.party, sides);
      if (!found.match) return { data: notFoundContact(a.party, found.candidates) };
      const c = found.match;
      const side: StatementSide = a.side ?? (c.kind === 'vendor' ? 'vendor' : c.kind === 'customer' ? 'customer' : sides[0]);
      if (!sides.includes(side)) return { data: { error: `This role cannot see ${side === 'customer' ? 'customers' : 'suppliers'}.` } };
      const w = period(ctx, a.from, a.to);
      const st = await partyStatement(ctx.ex, ctx.orgId, c.id, side, w.from, w.to);
      const href = side === 'customer' ? `/sales/customers/${c.id}` : `/purchases/vendors/${c.id}`;
      const cust = side === 'customer';
      return {
        data: {
          party: c.name,
          side: cust ? 'customer' : 'supplier',
          period: { from: st.from, to: st.to },
          opening_balance: amt(st.openingPaise),
          [cust ? 'invoiced_and_charged' : 'billed']: amt(st.chargesPaise),
          [cust ? 'received_and_credited' : 'paid_and_credited']: amt(st.paymentsPaise),
          closing_balance: amt(st.closingPaise),
          meaning: st.closingPaise === 0 ? 'Settled: nothing is owed either way.'
            : cust ? (st.closingPaise > 0 ? `${c.name} owes the business this amount.` : `The business holds this much of ${c.name}'s money in advance or credit.`)
            : (st.closingPaise > 0 ? `The business owes ${c.name} this amount.` : `${c.name} holds this much of the business's money in advance or credit.`),
          entries_in_period: st.lines.length,
          latest_entries: st.lines.slice(-12).reverse().map((l) => ({
            date: day(l.date),
            what: l.kind,
            number: l.number,
            charge: l.chargePaise ? amt(l.chargePaise) : undefined,
            payment: l.paymentPaise ? amt(l.paymentPaise) : undefined,
            balance: amt(l.balancePaise),
          })),
        },
        sources: [{ label: `Statement · ${c.name}`, href }],
        report: safely(() =>
          statementReport({
            side, party: c.name, href, from: st.from, to: st.to,
            opening: st.openingPaise, charges: st.chargesPaise, payments: st.paymentsPaise, closing: st.closingPaise,
            lines: st.lines.map((l) => ({ date: day(l.date), kind: l.kind, number: l.number, charge: l.chargePaise, payment: l.paymentPaise, balance: l.balancePaise })),
          }),
        ),
      };
    },
  }),

  define({
    name: 'search_payments',
    label: 'Looking through payments',
    description:
      'Payments already received from customers or made to suppliers in a period, optionally for one party or one mode (UPI, NEFT, cheque, cash…), with the total, the split by mode and the latest payments. Not for what is still pending or owed — get_pending_payments answers that.',
    parameters: params({
      direction: P.oneOf(['received', 'made'], 'received (from customers) or made (to suppliers). Defaults to received.'),
      party: P.text('Part of the customer or supplier name.'),
      mode: P.oneOf(['cash', 'cheque', 'neft', 'rtgs', 'imps', 'upi', 'card', 'netbanking', 'other'], 'Only payments made this way.'),
      from: P.day('Payment date from, YYYY-MM-DD. Defaults to the start of the financial year.'),
      to: P.day('Payment date to, YYYY-MM-DD. Defaults to today.'),
      limit: P.limit(),
    }),
    schema: z.object({
      direction: z.enum(['received', 'made']).optional(),
      party: z.string().trim().min(1).max(100).optional(),
      mode: z.enum(['cash', 'cheque', 'neft', 'rtgs', 'imps', 'upi', 'card', 'netbanking', 'other']).optional(),
      from: Day.optional(),
      to: Day.optional(),
      limit: Limit.optional(),
    }),
    gate: 'parties',
    run: async (ctx, a) => {
      const sides = sidesFor(ctx.role);
      const direction = a.direction ?? (sides.includes('customer') ? 'received' : 'made');
      if (!sides.includes(direction === 'received' ? 'customer' : 'vendor')) {
        return { data: { error: `This role cannot see payments ${direction === 'received' ? 'from customers' : 'to suppliers'}.` } };
      }
      const w = period(ctx, a.from, a.to);
      let q = ctx.ex
        .selectFrom('payments')
        .innerJoin('contacts', 'contacts.id', 'payments.contact_id')
        .where('payments.org_id', '=', ctx.orgId)
        .where('payments.kind', '=', direction)
        .where('payments.status', '<>', 'void')
        .where('payments.payment_date', '>=', w.from)
        .where('payments.payment_date', '<=', w.to);
      if (a.party) q = q.where((eb) => eb.or([eb('contacts.display_name', 'like', `%${a.party}%`), eb('contacts.legal_name', 'like', `%${a.party}%`)]));
      if (a.mode) q = q.where('payments.mode', '=', a.mode);
      const [rows, modes] = await Promise.all([
        q.select(['payments.number', 'payments.payment_date', 'payments.amount', 'payments.mode', 'payments.tds_amount', 'payments.reference', 'contacts.display_name'])
          .orderBy('payments.payment_date', 'desc').orderBy('payments.id', 'desc').limit(a.limit ?? 10).execute(),
        q.select(['payments.mode', sql<string>`SUM(payments.amount)`.as('total'), sql<number>`COUNT(*)`.as('n')]).groupBy('payments.mode').execute(),
      ]);
      const byMode = modes.map((m) => ({ mode: m.mode.toUpperCase(), amount: toPaiseFromSql(m.total), count: Number(m.n) })).sort((x, y) => y.amount - x.amount);
      const total = byMode.reduce((t, m) => t + m.amount, 0);
      const count = byMode.reduce((t, m) => t + m.count, 0);
      return {
        data: {
          direction,
          period: w,
          party_filter: a.party,
          payments: count,
          total: amt(total),
          by_mode: Object.fromEntries(byMode.map((m) => [m.mode, amt(m.amount)])),
          latest: rows.map((r) => ({
            number: r.number,
            date: day(r.payment_date),
            [direction === 'received' ? 'from' : 'to']: r.display_name,
            amount: amt(toPaiseFromSql(r.amount)),
            mode: r.mode,
            tds: toPaiseFromSql(r.tds_amount) ? amt(toPaiseFromSql(r.tds_amount)) : undefined,
            reference: r.reference ?? undefined,
          })),
        },
        sources: [direction === 'received' ? { label: 'Payments received', href: '/reports/payments-received' } : { label: 'Payments made', href: '/reports/payments-made' }],
        report: safely(() =>
          paymentsReport({
            direction, from: w.from, to: w.to, total, count,
            byMode: byMode.map((m) => ({ mode: m.mode, amount: m.amount })),
            rows: rows.map((r) => ({ number: r.number, date: day(r.payment_date), party: r.display_name, mode: r.mode.toUpperCase(), amount: toPaiseFromSql(r.amount) })),
          }),
        ),
      };
    },
  }),

  define({
    name: 'get_tds_summary',
    label: 'Adding up TDS',
    description:
      'TDS the business deducted from suppliers in a quarter, by section (194C, 194J, 194Q…), what has been deposited each month against the 7th-of-next-month due date, problems that would stop the TDS return being filed, the return due date, and the TDS customers deducted from payments to the business.',
    parameters: params({
      fy: { type: 'integer', description: 'The year the financial year starts in: 2026 for FY 2026-27. Defaults to the current one.' },
      quarter: { type: 'integer', minimum: 1, maximum: 4, description: 'Q1 Apr–Jun, Q2 Jul–Sep, Q3 Oct–Dec, Q4 Jan–Mar. Defaults to the current quarter.' },
    }),
    schema: z.object({ fy: z.number().int().min(2017).max(2100).optional(), quarter: z.number().int().min(1).max(4).optional() }),
    gate: 'gst',
    run: async (ctx, a) => {
      const m = Number(ctx.today.slice(5, 7));
      const nowFy = Number(ctx.today.slice(0, 4)) - (m < 4 ? 1 : 0);
      const nowQ = (m >= 4 ? Math.floor((m - 4) / 3) + 1 : 4) as Quarter;
      const fy = a.fy ?? nowFy;
      const q = (a.quarter ?? (a.fy === undefined || a.fy === nowFy ? nowQ : 4)) as Quarter;
      const [ret, fromCustomers] = await Promise.all([
        quarterReturn(ctx.ex, ctx.orgId, fy, q),
        sql<{ v: string | null }>`
          SELECT SUM(tds_amount) AS v FROM payments
           WHERE org_id = ${ctx.orgId} AND kind = 'received' AND status <> 'void'
             AND payment_date BETWEEN ${quarterRange(fy, q).from} AND ${quarterRange(fy, q).to}
        `.execute(ctx.ex),
      ]);
      const rows = ret.forms.filter((f) => f.kind !== 'tcs').flatMap((f) => f.rows);
      const sections = new Map<string, { section: string; label: string; amount: number; tax: number; count: number }>();
      for (const r of rows) {
        const s = sections.get(r.section) ?? { section: r.section, label: r.sectionLabel, amount: 0, tax: 0, count: 0 };
        s.amount += r.amountPaise;
        s.tax += r.taxPaise;
        s.count += 1;
        sections.set(r.section, s);
      }
      const deducted = rows.reduce((t, r) => t + r.taxPaise, 0);
      const deposited = ret.deposits.tds.reduce((t, d) => t + d.depositedPaise, 0);
      const label = `Q${q} of FY ${fy}-${String((fy + 1) % 100).padStart(2, '0')} (${ret.from} to ${ret.to})`;
      // "How much TDS is still to deposit?" early in a quarter is mostly about
      // the months before it: a July deduction not deposited by 7 August is
      // still owed — with interest — in October.
      const earlier: { month: string; shortPaise: number; due: string }[] = [];
      if (a.quarter === undefined && fy === nowFy) {
        for (let pq = 1; pq < q; pq++) {
          const back = await quarterReturn(ctx.ex, ctx.orgId, fy, pq as Quarter);
          for (const d of back.deposits.tds) {
            if (d.status === 'unpaid' || d.status === 'short') earlier.push({ month: d.month, shortPaise: d.deductedPaise - d.depositedPaise, due: d.dueDate });
          }
        }
      }
      return {
        data: {
          quarter: label,
          tds_deducted: amt(deducted),
          tds_deposited: amt(deposited),
          still_to_deposit: amt(Math.max(0, deducted - deposited)),
          by_section: [...sections.values()].map((s) => ({ section: s.section, what: s.label, paid_or_credited: amt(s.amount), tds: amt(s.tax), deductions: s.count })),
          by_month: ret.deposits.tds.map((d) => ({
            month: d.month, deducted: amt(d.deductedPaise), deposited: amt(d.depositedPaise), due_by: d.dueDate, status: d.status,
            days_late: d.daysLate || undefined,
          })),
          return_due_date: ret.returnDueDate,
          earlier_months_not_deposited: earlier.length
            ? earlier.map((e) => ({ month: e.month, short: amt(e.shortPaise), due_by: e.due }))
            : undefined,
          earlier_not_deposited_total: earlier.length ? amt(earlier.reduce((t, e) => t + e.shortPaise, 0)) : undefined,
          problems_before_filing: ret.issues.map((i) => i.message),
          tds_deducted_by_customers: amt(toPaiseFromSql(fromCustomers.rows[0]?.v ?? '0')),
          note: 'Interest under section 201(1A) runs at 1.5% a month on TDS deposited late.',
        },
        sources: [{ label: 'TDS and TCS', href: '/gst/tds-tcs' }],
        report: safely(() =>
          tdsReport({
            label, returnDue: ret.returnDueDate, deducted, deposited,
            bySection: [...sections.values()].map((s) => ({ section: s.section, tax: s.tax })),
            months: ret.deposits.tds.map((d) => ({ month: d.month, deducted: d.deductedPaise, deposited: d.depositedPaise, due: d.dueDate, status: d.status })),
            issues: ret.issues.map((i) => i.message),
          }),
        ),
      };
    },
  }),

  define({
    name: 'get_compliance_calendar',
    label: 'Checking the compliance calendar',
    description:
      'Returns and tax payments due from this business — GSTR-1, GSTR-3B, TDS deposits and returns, advance tax, PF and ESI, ROC filings, MSME-1 — with each due date and whether it is done, overdue, due within a week or upcoming. Use for "what is due this month", "have we filed GSTR-3B", "what is overdue".',
    parameters: params({
      from: P.day('From, YYYY-MM-DD. Defaults to 30 days ago.'),
      to: P.day('To, YYYY-MM-DD. Defaults to 45 days ahead.'),
    }),
    schema: z.object({ from: Day.optional(), to: Day.optional() }),
    gate: 'gst',
    run: async (ctx, a) => {
      const from = a.from ?? shiftDays(ctx.today, -30);
      const to = a.to ?? shiftDays(ctx.today, 45);
      const cal = await complianceCalendar(ctx.ex, ctx.orgId, from, to, ctx.today);
      const order = { overdue: 0, due_soon: 1, upcoming: 2, done: 3 } as const;
      const rows = [...cal.rows].sort((x, y) => order[x.status] - order[y.status] || x.dueDate.localeCompare(y.dueDate));
      return {
        data: {
          today: ctx.today,
          window: { from, to },
          overdue: rows.filter((r) => r.status === 'overdue').length,
          due_within_a_week: rows.filter((r) => r.status === 'due_soon').length,
          items: rows.slice(0, 25).map((r) => ({
            what: r.title,
            for: r.periodLabel,
            due: r.dueDate,
            status: r.status === 'due_soon' ? 'due soon' : r.status,
            days_left: r.status === 'done' ? undefined : r.daysLeft,
            done_on: r.done?.on ?? undefined,
            optional: r.optional || undefined,
          })),
        },
        sources: [{ label: 'Compliance calendar', href: '/gst/compliance-calendar' }],
        report: safely(() =>
          complianceReport({
            from, to,
            rows: rows.map((r) => ({ title: r.title, period: r.periodLabel, due: r.dueDate, status: r.status, daysLeft: r.daysLeft })),
          }),
        ),
      };
    },
  }),

  define({
    name: 'get_bank_reconciliation',
    label: 'Checking the bank reconciliation',
    description:
      'For each bank, card and wallet account: imported statement lines not yet matched to the books, how much money in and out they carry, the oldest unmatched line, and how far the statement has been imported.',
    parameters: params({}),
    schema: z.object({}),
    gate: 'cash',
    run: async (ctx) => {
      const { rows } = await sql<{ name: string; kind: string; unmatched: number; dep: string | null; wd: string | null; oldest: string | null; last_line: string | null }>`
        SELECT ba.name, ba.kind,
               SUM(bt.status = 'unmatched') AS unmatched,
               SUM(IF(bt.status = 'unmatched', bt.deposit, 0)) AS dep,
               SUM(IF(bt.status = 'unmatched', bt.withdrawal, 0)) AS wd,
               MIN(IF(bt.status = 'unmatched', bt.txn_date, NULL)) AS oldest,
               MAX(bt.txn_date) AS last_line
          FROM bank_accounts ba
          LEFT JOIN bank_transactions bt ON bt.bank_account_id = ba.id
         WHERE ba.org_id = ${ctx.orgId} AND ba.is_active = 1 AND ba.kind IN ('bank', 'card', 'wallet')
         GROUP BY ba.id, ba.name, ba.kind
         ORDER BY unmatched DESC, ba.name
      `.execute(ctx.ex);
      const accounts = rows.map((r) => ({
        name: r.name,
        unmatched: Number(r.unmatched ?? 0),
        deposits: toPaiseFromSql(r.dep ?? '0'),
        withdrawals: toPaiseFromSql(r.wd ?? '0'),
        oldest: r.oldest ? day(r.oldest) : null,
        lastLine: r.last_line ? day(r.last_line) : null,
      }));
      return {
        data: {
          unmatched_lines: accounts.reduce((t, x) => t + x.unmatched, 0),
          accounts: accounts.map((x) => ({
            account: x.name,
            unmatched_lines: x.unmatched,
            money_in_unmatched: amt(x.deposits),
            money_out_unmatched: amt(x.withdrawals),
            oldest_unmatched: x.oldest ?? undefined,
            statement_imported_to: x.lastLine ?? 'no statement imported yet',
          })),
        },
        sources: [{ label: 'Reconcile', href: '/banking/reconcile' }],
        report: safely(() => reconciliationReport({ accounts })),
      };
    },
  }),

  define({
    name: 'get_projects',
    label: 'Reading the projects',
    description:
      'Projects with the hours logged, hours not yet billed, what has been invoiced and — for roles that see costs — the cost of time and expenses and the profit. For one named project, its budget against what has been used.',
    parameters: params({
      project: P.text('Part of a project name or code.'),
      status: P.oneOf(['active', 'completed', 'all'], 'Which projects. Defaults to active.'),
    }),
    schema: z.object({ project: z.string().trim().min(1).max(100).optional(), status: z.enum(['active', 'completed', 'all']).optional() }),
    gate: 'projects',
    run: async (ctx, a) => {
      const costs = seesCosts(ctx.role);
      let q = ctx.ex
        .selectFrom('projects')
        .innerJoin('contacts', 'contacts.id', 'projects.customer_id')
        .select(['projects.id', 'projects.name', 'projects.code', 'projects.status', 'projects.billing_method', 'projects.budget_hours', 'projects.budget_amount', 'contacts.display_name'])
        .where('projects.org_id', '=', ctx.orgId);
      if (a.project) q = q.where((eb) => eb.or([eb('projects.name', 'like', `%${a.project}%`), eb('projects.code', '=', a.project!)]));
      else if (a.status !== 'all') q = q.where('projects.status', '=', a.status ?? 'active');
      const projects = await q.orderBy('projects.name').limit(30).execute();
      if (!projects.length) {
        return { data: { found: false, query: a.project, hint: a.project ? 'No project matches that name.' : 'There are no projects with that status.' } };
      }
      const figs = await projectFigures(ctx.ex, ctx.orgId, projects.map((p) => p.id));
      const hours = (min: number) => Math.round((min / 60) * 10) / 10;
      const rows = projects.map((p) => {
        const f = figs.get(p.id);
        return {
          name: p.name,
          customer: p.display_name,
          status: p.status,
          hours: hours(f?.loggedMinutes ?? 0),
          unbilledHours: hours(f?.unbilledMinutes ?? 0),
          billed: f?.billedPaise ?? 0,
          cost: costs ? (f?.timeCostPaise ?? 0) + (f?.expenseCostPaise ?? 0) : null,
          profit: costs ? (f?.profitPaise ?? 0) : null,
          budgetHours: p.budget_hours === null ? null : Number(p.budget_hours),
          budgetAmount: p.budget_amount === null ? null : toPaiseFromSql(p.budget_amount),
          billing: p.billing_method,
        };
      });
      return {
        data: {
          projects: rows.map((r) => ({
            project: r.name,
            customer: r.customer,
            status: r.status,
            billing: r.billing.replace('_', ' '),
            hours_logged: r.hours,
            hours_not_billed: r.unbilledHours,
            invoiced_before_tax: amt(r.billed),
            cost_of_time_and_expenses: r.cost === null ? undefined : amt(r.cost),
            profit: r.profit === null ? undefined : amt(r.profit),
            budget_hours: r.budgetHours ?? undefined,
            budget: r.budgetAmount === null ? undefined : amt(r.budgetAmount),
          })),
        },
        sources: [{ label: 'Projects', href: '/projects' }],
        report: safely(() => projectsReport({ showCosts: costs, rows })),
      };
    },
  }),

  define({
    name: 'get_payroll_summary',
    label: 'Reading the payroll',
    description:
      'Payroll runs by month — employees paid, gross and net pay, status — and for the latest run the PF, ESI, professional tax and TDS withheld from salaries and the employer contributions on top.',
    parameters: params({ months: { type: 'integer', minimum: 1, maximum: 24, description: 'How many recent months. Defaults to 12.' } }),
    schema: z.object({ months: z.number().int().min(1).max(24).optional() }),
    gate: 'payroll',
    run: async (ctx, a) => {
      const runs = (await listPayrollRuns(ctx.ex, ctx.orgId)).slice(0, a.months ?? 12);
      const latest = runs.find((r) => r.status !== 'draft') ?? runs[0];
      let totals: Record<string, number> | null = null;
      if (latest) {
        const { rows } = await sql<Record<string, string | null>>`
          SELECT SUM(gross) AS gross, SUM(net_pay) AS net, SUM(pf_employee) AS pf_employee,
                 SUM(pf_employer_epf + pf_employer_eps + pf_admin + pf_edli) AS pf_employer,
                 SUM(esi_employee) AS esi_employee, SUM(esi_employer) AS esi_employer,
                 SUM(pt) AS pt, SUM(tds) AS tds, SUM(lwf_employee) AS lwf_employee, SUM(lwf_employer) AS lwf_employer
            FROM payroll_lines WHERE run_id = ${Number(latest.id)}
        `.execute(ctx.ex);
        totals = Object.fromEntries(Object.entries(rows[0] ?? {}).map(([k, v]) => [k, toPaiseFromSql(v ?? '0')]));
      }
      const withheld = totals ? totals.pf_employee + totals.esi_employee + totals.pt + totals.tds + totals.lwf_employee : 0;
      const employer = totals ? totals.pf_employer + totals.esi_employer + totals.lwf_employer : 0;
      return {
        data: runs.length
          ? {
              runs: runs.map((r) => ({ month: r.month, status: r.status, employees: r.employees, gross: amt(r.grossPaise), net: amt(r.netPaise), paid_on: r.paidOn ?? undefined })),
              latest_run: latest && totals
                ? {
                    month: latest.month,
                    status: latest.status,
                    employees: latest.employees,
                    gross: amt(totals.gross),
                    net_pay: amt(totals.net),
                    withheld_from_pay: { pf: amt(totals.pf_employee), esi: amt(totals.esi_employee), professional_tax: amt(totals.pt), tds: amt(totals.tds), lwf: amt(totals.lwf_employee), total: amt(withheld) },
                    employer_contributions: { pf: amt(totals.pf_employer), esi: amt(totals.esi_employer), lwf: amt(totals.lwf_employer), total: amt(employer) },
                    cost_to_company: amt(totals.gross + employer),
                  }
                : undefined,
              due_dates: 'PF and ESI by the 15th of the next month; TDS on salary by the 7th.',
            }
          : { runs: [], note: 'No payroll has been run in this book yet.' },
        sources: [{ label: 'Payroll runs', href: '/payroll/runs' }],
        report: safely(() =>
          payrollReport({
            runs: runs.map((r) => ({ month: r.month, status: r.status, employees: r.employees, gross: r.grossPaise, net: r.netPaise })),
            latest: latest && totals ? { month: latest.month, gross: totals.gross, net: totals.net, withheld, employees: latest.employees } : null,
          }),
        ),
      };
    },
  }),

  define({
    name: 'get_fixed_assets',
    label: 'Reading the asset register',
    description:
      'The fixed asset register: cost, depreciation to date and book value by asset class, how many assets are in use or not yet put to use, and assets needing attention (insurance or AMC lapsing, not physically verified in a year).',
    parameters: params({ as_of: P.day('The date, YYYY-MM-DD. Defaults to today.') }),
    schema: z.object({ as_of: Day.optional() }),
    gate: 'costs',
    run: async (ctx, a) => {
      const asOf = a.as_of ?? ctx.today;
      const reg = (await assetRegister(ctx.ex, ctx.orgId, asOf)).filter((r) => r.status !== 'disposed');
      const classes = new Map<string, { name: string; count: number; cost: number; accumulated: number; net: number }>();
      for (const r of reg) {
        const c = classes.get(r.className) ?? { name: r.className, count: 0, cost: 0, accumulated: 0, net: 0 };
        c.count += 1;
        c.cost += r.costPaise;
        c.accumulated += r.accumulatedPaise;
        c.net += r.netPaise;
        classes.set(r.className, c);
      }
      const byClass = [...classes.values()].sort((x, y) => y.net - x.net);
      const tot = (k: 'cost' | 'accumulated' | 'net') => byClass.reduce((t, c) => t + c[k], 0);
      const flags = reg.flatMap((r) => r.flags.map((f) => `${r.name} (${r.tagNo}): ${f}`));
      return {
        data: reg.length
          ? {
              as_of: asOf,
              assets: reg.length,
              in_use: reg.filter((r) => r.status === 'in_use').length,
              not_yet_put_to_use: reg.filter((r) => r.status === 'cwip').length,
              cost: amt(tot('cost')),
              depreciation_to_date: amt(tot('accumulated')),
              book_value: amt(tot('net')),
              by_class: byClass.map((c) => ({ class: c.name, assets: c.count, cost: amt(c.cost), depreciation: amt(c.accumulated), book_value: amt(c.net) })),
              needs_attention: flags.slice(0, 10),
            }
          : { as_of: asOf, assets: 0, note: 'No fixed assets are recorded in the register.' },
        sources: [{ label: 'Fixed asset register', href: '/accountant/fixed-assets' }],
        report: reg.length
          ? safely(() =>
              fixedAssetsReport({
                asOf, cost: tot('cost'), accumulated: tot('accumulated'), net: tot('net'),
                inUse: reg.filter((r) => r.status === 'in_use').length, cwip: reg.filter((r) => r.status === 'cwip').length,
                byClass, flags,
              }),
            )
          : null,
      };
    },
  }),

  define({
    name: 'get_budget_vs_actual',
    label: 'Comparing against the budget',
    description:
      "The year's budget for each account set against the actual from the journal, how much of each budget is used, and which accounts are ahead of or behind the year's pace.",
    parameters: params({
      fy: { type: 'string', pattern: '^\\d{4}-\\d{2}$', description: 'The financial year, like 2026-27. Defaults to the current one.' },
      as_of: P.day('Actuals up to this date, YYYY-MM-DD. Defaults to today.'),
    }),
    schema: z.object({ fy: z.string().regex(/^\d{4}-\d{2}$/).optional(), as_of: Day.optional() }),
    gate: 'costs',
    run: async (ctx, a) => {
      const b = await budgetVsActual(ctx.ex, ctx.orgId, { fy: a.fy, asOf: a.as_of, today: ctx.today });
      if (!b.rows.length) {
        return { data: { fy: b.fy, budgets: 0, note: `No budget has been set for FY ${b.fy}. Budgets are set under Accountant → Budgets.` } };
      }
      return {
        data: {
          fy: b.fy,
          actuals_to: b.asOf,
          share_of_year_gone: pct(b.elapsedPct),
          total_budget: amt(b.totals.budgetPaise),
          total_actual: amt(b.totals.actualPaise),
          accounts: b.rows.map((r) => ({
            account: r.name,
            type: r.type,
            budget: amt(r.budgetPaise),
            actual: amt(r.actualPaise),
            used: pct(r.pct),
            remaining: amt(r.variancePaise),
            pace: r.type === 'income'
              ? (r.pct < b.elapsedPct - 10 ? 'behind' : 'on track')
              : (r.pct > b.elapsedPct + 10 ? 'ahead of budget' : 'on track'),
          })),
        },
        sources: [{ label: 'Budgets', href: '/accountant/budgets' }],
        report: safely(() =>
          budgetReport({
            fy: b.fy, asOf: b.asOf, elapsedPct: b.elapsedPct, budget: b.totals.budgetPaise, actual: b.totals.actualPaise,
            rows: b.rows.map((r) => ({ name: r.name, type: r.type, budget: r.budgetPaise, actual: r.actualPaise, pct: r.pct })),
          }),
        ),
      };
    },
  }),

  define({
    name: 'get_open_orders',
    label: 'Looking at open orders',
    description:
      'Quotes sent and still open, sales orders not yet delivered or invoiced, and purchase orders not yet received or billed — with the open value, and which are late against their expected date.',
    parameters: params({ kind: P.oneOf(['quotes', 'sales_orders', 'purchase_orders', 'all'], 'Which documents. Defaults to all this role can see.') }),
    schema: z.object({ kind: z.enum(['quotes', 'sales_orders', 'purchase_orders', 'all']).optional() }),
    gate: 'parties',
    run: async (ctx, a) => {
      const sides = sidesFor(ctx.role);
      const kind = a.kind ?? 'all';
      const want = (k: 'quotes' | 'sales_orders' | 'purchase_orders') =>
        (kind === 'all' || kind === k) && sides.includes(k === 'purchase_orders' ? 'vendor' : 'customer');
      if (!want('quotes') && !want('sales_orders') && !want('purchase_orders')) {
        return { data: { error: 'This role cannot see those documents.' } };
      }
      const [quotes, so, po] = await Promise.all([
        want('quotes')
          ? ctx.ex.selectFrom('estimates').innerJoin('contacts', 'contacts.id', 'estimates.customer_id')
              .select(['estimates.number', 'estimates.estimate_date', 'estimates.expiry_date', 'estimates.total', 'contacts.display_name'])
              .where('estimates.org_id', '=', ctx.orgId).where('estimates.status', '=', 'sent')
              .orderBy('estimates.estimate_date', 'desc').limit(50).execute()
          : null,
        want('sales_orders') ? pendingSalesOrders(ctx.ex, ctx.orgId, ctx.today) : null,
        want('purchase_orders') ? pendingPurchaseOrders(ctx.ex, ctx.orgId, ctx.today) : null,
      ]);
      const openQuotes = quotes?.filter((x) => day(x.expiry_date) >= ctx.today) ?? [];
      const lapsed = quotes ? quotes.length - openQuotes.length : 0;
      const groups: { label: string; count: number; value: number; overdue: number; href: string }[] = [];
      const rows: { kind: string; number: string; party: string; date: string; value: number; overdue: boolean }[] = [];
      const data: Record<string, unknown> = { as_of: ctx.today };
      if (quotes) {
        const value = openQuotes.reduce((t, x) => t + toPaiseFromSql(x.total), 0);
        groups.push({ label: 'Open quotes', count: openQuotes.length, value, overdue: 0, href: '/sales/estimates' });
        rows.push(...openQuotes.map((x) => ({ kind: 'Quote', number: x.number, party: x.display_name, date: day(x.estimate_date), value: toPaiseFromSql(x.total), overdue: false })));
        data.quotes = {
          open: openQuotes.length,
          value: amt(value),
          sent_but_past_validity: lapsed || undefined,
          list: openQuotes.slice(0, 10).map((x) => ({ number: x.number, customer: x.display_name, date: day(x.estimate_date), valid_until: day(x.expiry_date), value: amt(toPaiseFromSql(x.total)) })),
        };
      }
      for (const [key, label, res, href] of [
        ['sales_orders', 'Pending sales orders', so, '/reports/pending-sales-orders'],
        ['purchase_orders', 'Pending purchase orders', po, '/reports/pending-purchase-orders'],
      ] as const) {
        if (!res) continue;
        groups.push({ label, count: res.orders.length, value: res.totalPendingPaise, overdue: res.overdue, href });
        rows.push(...res.orders.map((o) => ({ kind: key === 'sales_orders' ? 'Sales order' : 'Purchase order', number: o.number, party: o.partyName, date: o.date, value: o.pendingPaise, overdue: o.overdue })));
        data[key] = {
          open: res.orders.length,
          open_value: amt(res.totalPendingPaise),
          late: res.overdue,
          list: res.orders.slice(0, 10).map((o) => ({ number: o.number, party: o.partyName, date: o.date, expected: o.expectedDate ?? undefined, open_value: amt(o.pendingPaise), late: o.overdue || undefined })),
        };
      }
      return {
        data,
        sources: groups.map((g) => ({ label: g.label, href: g.href })),
        report: safely(() => ordersReport({ asOf: ctx.today, groups, rows })),
      };
    },
  }),

  define({
    name: 'get_collections',
    label: 'Checking collections',
    description:
      'The collections list: customers with overdue invoices, how long the oldest has been overdue, the last follow-up, payment promises (and which were broken), and who is due a chase today.',
    parameters: params({ customer: P.text('Part of a customer name, to see only them.') }),
    schema: z.object({ customer: z.string().trim().min(1).max(100).optional() }),
    gate: 'sales',
    run: async (ctx, a) => {
      const all = await collectionsWorkbench(ctx.ex, ctx.orgId, ctx.today);
      const rows = (a.customer ? all.filter((r) => r.name.toLowerCase().includes(a.customer!.toLowerCase())) : all)
        .filter((r) => r.overduePaise > 0)
        .sort((x, y) => y.overduePaise - x.overduePaise);
      const week = shiftDays(ctx.today, 7);
      const promisedThisWeek = rows.filter((r) => r.promise && !r.promise.broken && r.promise.date >= ctx.today && r.promise.date <= week)
        .reduce((t, r) => t + (r.promise?.amountPaise ?? 0), 0);
      const broken = rows.filter((r) => r.promise?.broken).length;
      const overdue = rows.reduce((t, r) => t + r.overduePaise, 0);
      const dueToday = rows.filter((r) => r.dueToday).length;
      return {
        data: {
          today: ctx.today,
          customers_overdue: rows.length,
          overdue: amt(overdue),
          due_a_chase_today: dueToday,
          promised_this_week: amt(promisedThisWeek),
          broken_promises: broken,
          customers: rows.slice(0, 12).map((r) => ({
            customer: r.name,
            overdue: amt(r.overduePaise),
            overdue_invoices: r.overdueInvoices,
            oldest_days_overdue: r.oldestDays,
            last_follow_up: r.lastFollowUp ? `${r.lastFollowUp.at.slice(0, 10)} (${r.lastFollowUp.kind}): ${r.lastFollowUp.note}`.slice(0, 160) : 'none yet',
            promise: r.promise ? `${amt(r.promise.amountPaise)} by ${r.promise.date}${r.promise.broken ? ' (broken)' : ''}` : undefined,
            next_follow_up: r.nextFollowup ?? undefined,
            phone: r.phone ?? undefined,
          })),
        },
        sources: [{ label: 'Collections', href: '/sales/collections' }],
        report: safely(() =>
          collectionsReport({
            today: ctx.today, overdue, dueToday, promisedThisWeek, broken,
            rows: rows.map((r) => ({
              name: r.name, overdue: r.overduePaise, oldestDays: r.oldestDays,
              promise: r.promise ? `${formatDay(r.promise.date)}${r.promise.broken ? ' (broken)' : ''}` : null,
              next: r.nextFollowup,
            })),
          }),
        ),
      };
    },
  }),

  define({
    name: 'get_pending_payments',
    label: 'Listing pending payments',
    description:
      'Every payment still pending, both ways: unpaid invoices customers have yet to pay (to receive) and unpaid bills the business has yet to pay its suppliers (to pay), each with its due date and days overdue, and the totals overdue, due in the next 7 days and later. Use this for "pending payments", "outstanding payments", "dues", "what is to be received or paid", "who has not paid" — anything still owed, as opposed to payments already made or received. Filter by side, by a party, or by when it falls due.',
    parameters: params({
      side: P.oneOf(['both', 'receive', 'pay'], 'receive (customers to pay us), pay (us to pay suppliers) or both. Defaults to both, within what this person can see.'),
      party: P.text('Part of a customer or supplier name.'),
      due: P.oneOf(['all', 'overdue', 'next_7_days', 'this_month'], 'Only what is overdue, falls due in the next 7 days, or by the end of this month. Defaults to all.'),
      limit: P.limit(),
    }),
    schema: z.object({
      side: z.enum(['both', 'receive', 'pay']).optional(),
      party: z.string().trim().min(1).max(100).optional(),
      due: z.enum(['all', 'overdue', 'next_7_days', 'this_month']).optional(),
      limit: Limit.optional(),
    }),
    gate: 'parties',
    run: async (ctx, a) => {
      const sides = sidesFor(ctx.role);
      const wantReceive = (a.side ?? 'both') !== 'pay' && sides.includes('customer');
      const wantPay = (a.side ?? 'both') !== 'receive' && sides.includes('vendor');
      const week = shiftDays(ctx.today, 7);
      const monthEnd = `${ctx.today.slice(0, 8)}${String(new Date(Number(ctx.today.slice(0, 4)), Number(ctx.today.slice(5, 7)), 0).getDate()).padStart(2, '0')}`;
      const like = a.party ? `%${a.party}%` : null;
      type Doc = { number: string; party: string; due: string; balance: number; msme?: boolean };

      // Invoices and bills with something left to pay, and the openings
      // carried in from before the books began, oldest due date first.
      const read = async (kind: 'receivable' | 'payable'): Promise<Doc[]> => {
        const docs = kind === 'receivable'
          ? await sql<{ number: string; party: string; due: string; balance: string; msme: number }>`
              SELECT i.number, c.display_name AS party, i.due_date AS due, (i.total - i.amount_paid) AS balance, 0 AS msme
                FROM invoices i JOIN contacts c ON c.id = i.customer_id
               WHERE i.org_id = ${ctx.orgId} AND i.status NOT IN ('draft', 'void') AND i.total > i.amount_paid
                 ${like ? sql`AND c.display_name LIKE ${like}` : sql``}`.execute(ctx.ex)
          : await sql<{ number: string; party: string; due: string; balance: string; msme: number }>`
              SELECT CONCAT(b.vendor_invoice_no, ' (', b.internal_no, ')') AS number, c.display_name AS party, b.due_date AS due,
                     (b.total - b.amount_paid) AS balance, c.is_msme AS msme
                FROM bills b JOIN contacts c ON c.id = b.vendor_id
               WHERE b.org_id = ${ctx.orgId} AND b.status NOT IN ('draft', 'void') AND b.total > b.amount_paid
                 ${like ? sql`AND c.display_name LIKE ${like}` : sql``}`.execute(ctx.ex);
        const openings = await sql<{ number: string; party: string; due: string; balance: string; msme: number }>`
          SELECT CONCAT(o.ref_no, ' (opening)') AS number, c.display_name AS party, o.due_date AS due, (o.amount - o.amount_paid) AS balance, c.is_msme AS msme
            FROM opening_documents o JOIN contacts c ON c.id = o.contact_id
           WHERE o.org_id = ${ctx.orgId} AND o.kind = ${kind} AND o.status NOT IN ('paid', 'void') AND o.amount > o.amount_paid
             ${like ? sql`AND c.display_name LIKE ${like}` : sql``}`.execute(ctx.ex);
        return [...docs.rows, ...openings.rows]
          .map((r) => ({ number: r.number, party: r.party, due: day(r.due), balance: toPaiseFromSql(r.balance), msme: kind === 'payable' && Number(r.msme) === 1 }))
          .filter((d) => d.balance > 0)
          .sort((x, y) => (x.due < y.due ? -1 : x.due > y.due ? 1 : y.balance - x.balance));
      };
      const inWindow = (d: Doc) => a.due === 'overdue' ? d.due < ctx.today
        : a.due === 'next_7_days' ? d.due >= ctx.today && d.due <= week
          : a.due === 'this_month' ? d.due <= monthEnd
            : true;
      const side = (docs: Doc[], kind: 'receive' | 'pay') => {
        const all = docs.filter(inWindow);
        // Asked what falls due this week: what is already overdue matters as much.
        const lateOutside = a.due === 'next_7_days' ? docs.filter((d) => d.due < ctx.today) : [];
        const overdue = all.filter((d) => d.due < ctx.today);
        const next7 = all.filter((d) => d.due >= ctx.today && d.due <= week);
        const total = all.reduce((t, d) => t + d.balance, 0);
        return {
          docs: all,
          summary: {
            total, overdue: overdue.reduce((t, d) => t + d.balance, 0), next7: next7.reduce((t, d) => t + d.balance, 0), count: all.length,
            oldestDays: overdue.length ? daysBetween(overdue[0].due, ctx.today) : 0,
          },
          data: {
            total: amt(total),
            documents: all.length,
            overdue: amt(overdue.reduce((t, d) => t + d.balance, 0)),
            overdue_documents: overdue.length,
            due_next_7_days: amt(next7.reduce((t, d) => t + d.balance, 0)),
            oldest_days_overdue: overdue.length ? daysBetween(overdue[0].due, ctx.today) : 0,
            ...(kind === 'pay' ? { msme_bills: all.filter((d) => d.msme).length } : {}),
            ...(lateOutside.length ? { already_overdue: amt(lateOutside.reduce((t, d) => t + d.balance, 0)), already_overdue_documents: lateOutside.length } : {}),
            [kind === 'receive' ? 'invoices' : 'bills']: all.slice(0, a.limit ?? 12).map((d) => ({
              [kind === 'receive' ? 'invoice' : 'bill']: d.number,
              [kind === 'receive' ? 'customer' : 'supplier']: d.party,
              due: d.due,
              pending: amt(d.balance),
              ...(d.due < ctx.today ? { days_overdue: daysBetween(d.due, ctx.today) } : { due_in_days: daysBetween(ctx.today, d.due) }),
              ...(d.msme ? { msme: true } : {}),
            })),
          },
        };
      };

      const [rec, pay] = await Promise.all([wantReceive ? read('receivable') : null, wantPay ? read('payable') : null]);
      const r = rec ? side(rec, 'receive') : null;
      const p = pay ? side(pay, 'pay') : null;

      // What the ledger holds that no document explains — an opening balance
      // entered by journal, an advance not yet set against an invoice — so the
      // list ties to the ageing report rather than quietly differing from it.
      const ledgerSide = async (kind: 'receivable' | 'payable', docs: Doc[]) => {
        if (a.due && a.due !== 'all') return null;
        const ag = await ageing(ctx.ex, ctx.orgId, kind, ctx.today);
        const byParty = new Map<string, number>();
        for (const d of docs) byParty.set(d.party, (byParty.get(d.party) ?? 0) + d.balance);
        const rowsOf = ag.rows.filter((x) => !a.party || x.name.toLowerCase().includes(a.party.toLowerCase()));
        const diffs = rowsOf.map((x) => ({ party: x.name, diff: x.totalPaise - (byParty.get(x.name) ?? 0) })).filter((x) => Math.abs(x.diff) >= 100);
        if (!diffs.length) return null;
        const who = kind === 'receivable' ? 'customer' : 'supplier';
        return {
          not_on_any_document: diffs.filter((x) => x.diff > 0).map((x) => ({ [who]: x.party, amount: amt(x.diff) })),
          paid_in_advance: diffs.filter((x) => x.diff < 0).map((x) => ({ [who]: x.party, amount: amt(-x.diff) })),
          total_as_in_the_ageing_report: amt(rowsOf.reduce((t, x) => t + x.totalPaise, 0)),
        };
      };
      const [recLedger, payLedger] = await Promise.all([rec ? ledgerSide('receivable', rec) : null, pay ? ledgerSide('payable', pay) : null]);
      if (r && recLedger) Object.assign(r.data, { ledger: recLedger });
      if (p && payLedger) Object.assign(p.data, { ledger: payLedger });
      const notes: string[] = [];
      if (!wantReceive && (a.side ?? 'both') !== 'pay') notes.push('This person’s role does not include customers, so money to receive is not shown.');
      if (!wantPay && (a.side ?? 'both') !== 'receive') notes.push('This person’s role does not include suppliers, so money to pay is not shown.');
      if (a.party && !(r?.docs.length) && !(p?.docs.length)) notes.push(`Nothing is pending for a party matching "${a.party}".`);
      notes.push('Totals are of unpaid invoices and bills; "ledger" lists any balance the ledger holds that is not on one, so they tie to the ageing reports.');

      const rows = [
        ...(r?.docs ?? []).map((d) => ({ side: 'To receive' as const, number: d.number, party: d.party, due: d.due, daysOverdue: Math.max(0, daysBetween(d.due, ctx.today)), balance: d.balance })),
        ...(p?.docs ?? []).map((d) => ({ side: 'To pay' as const, number: d.number, party: d.party, due: d.due, daysOverdue: Math.max(0, daysBetween(d.due, ctx.today)), balance: d.balance })),
      ].sort((x, y) => (x.due < y.due ? -1 : x.due > y.due ? 1 : 0));

      return {
        data: {
          as_of: ctx.today,
          filter: { side: a.side ?? 'both', party: a.party, due: a.due ?? 'all' },
          to_receive_from_customers: r?.data,
          to_pay_to_suppliers: p?.data,
          net_position: r && p ? amt(r.summary.total - p.summary.total) : undefined,
          note: notes.join(' '),
        },
        sources: [
          ...(r ? [{ label: 'Receivables ageing', href: '/reports/ar-ageing' }] : []),
          ...(p ? [{ label: 'Payables ageing', href: '/reports/ap-ageing' }] : []),
        ],
        report: safely(() => pendingPaymentsReport({ today: ctx.today, receive: r?.summary ?? null, pay: p?.summary ?? null, rows })),
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
  if (!allows('inventory', role)) out.push(HIDDEN_AREA_WORDS.inventory);
  if (!allows('projects', role)) out.push(HIDDEN_AREA_WORDS.projects);
  if (!allows('payroll', role)) out.push(HIDDEN_AREA_WORDS.payroll);
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
