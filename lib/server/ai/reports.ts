import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Detailed reports, built from what a lookup found.
//
// One builder per lookup, called by the tool with the raw figures it already
// has — the same paise the report pages show — so a report adds no query and
// no second calculation. The model sees the compact text the tool returns; the
// person sees this, under the answer: key figures, a chart, a table, and a few
// observations worked out by plain rules.
//
// Pure functions of their inputs. A builder that throws loses its report, never
// the answer (see `safely`).
// ─────────────────────────────────────────────────────────────────────────────

import { formatFigure, type AiReport, type ReportChart, type ReportKpi, type ReportTable } from '../../ai/reports';
import { formatDay } from './time';

/** A report before the tool's key is put on it. */
export type ReportDraft = Omit<AiReport, 'key'>;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const asAt = (d: string) => `As at ${formatDay(d)}`;
export const between = (from: string, to: string) => `${formatDay(from)} to ${formatDay(to)}`;
/** 'Sep 2026' from 'YYYY-MM'. */
export const monthLabel = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
export const shareOf = (part: number, whole: number): number | null => (whole ? (part / whole) * 100 : null);
export const changeOf = (now: number, before: number): number | null => (before ? ((now - before) / Math.abs(before)) * 100 : null);
const money = (paise: number) => formatFigure(paise, 'inr');
const sum = (xs: number[]) => xs.reduce((t, x) => t + x, 0);

/** A short, stable key for a lookup and its arguments. */
export function reportKey(tool: string, args: unknown): string {
  const s = JSON.stringify(args ?? {});
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) ^ s.charCodeAt(i)) >>> 0;
  return `${tool}:${h.toString(36)}`.slice(0, 120);
}

/** A report that fails to build is left out. The answer never is. */
export function safely(build: () => ReportDraft | null): ReportDraft | null {
  try {
    return build();
  } catch (err) {
    console.error('[ai] a report could not be built', err);
    return null;
  }
}

/** Every month from one date's month to another's, oldest first — at most two years. */
function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  const end = to.slice(0, 7);
  while (out.length < 24) {
    const key = `${y}-${String(m).padStart(2, '0')}`;
    out.push(key);
    if (key >= end) break;
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

/** Largest first, the rest folded into "Other", so a chart never needs a ninth colour. */
function topWithOther<T>(rows: T[], n: number, value: (r: T) => number, name: (r: T) => string): { name: string; value: number }[] {
  const sorted = [...rows].sort((a, b) => value(b) - value(a));
  const top = sorted.slice(0, n).map((r) => ({ name: name(r), value: value(r) }));
  const rest = sum(sorted.slice(n).map(value));
  return rest > 0 ? [...top, { name: 'Other', value: rest }] : top;
}

function hbar(unit: ReportChart['unit'], categoryLabel: string, seriesName: string, points: { name: string; value: number }[]): ReportChart | null {
  if (points.length < 2) return null;
  return { kind: 'hbar', unit, categoryLabel, categories: points.map((p) => p.name), series: [{ name: seriesName, values: points.map((p) => p.value) }] };
}

function table(columns: ReportTable['columns'], rows: ReportTable['rows'], limit: number, total?: ReportTable['total']): ReportTable {
  return { columns, rows: rows.slice(0, limit), total, more: rows.length > limit ? rows.length - limit : undefined };
}

const kpi = (k: ReportKpi): ReportKpi => k;

// ── One account ──────────────────────────────────────────────────────────────

export function accountBalanceReport(p: {
  account: { code: string; name: string };
  debitNormal: boolean;
  from: string;
  to: string;
  openingPaise: number;
  closingPaise: number;
  lines: { date: string; description: string | null; memo: string | null; sourceType: string; contactName: string | null; debitPaise: number; creditPaise: number; runningPaise: number }[];
}): ReportDraft {
  const side = (v: number): 'Dr' | 'Cr' => ((v >= 0) === p.debitNormal ? 'Dr' : 'Cr');
  const debits = sum(p.lines.map((l) => l.debitPaise));
  const credits = sum(p.lines.map((l) => l.creditPaise));
  const detail = (l: (typeof p.lines)[number]) => l.description || l.memo || l.contactName || l.sourceType;

  // The balance at each month's end, carried through months with no entries.
  const lastInMonth = new Map<string, number>();
  for (const l of p.lines) lastInMonth.set(String(l.date).slice(0, 7), l.runningPaise);
  const months = monthsBetween(p.from, p.to);
  let carried = p.openingPaise;
  const balances = months.map((m) => (carried = lastInMonth.get(m) ?? carried));

  const biggest = [...p.lines].sort((a, b) => Math.max(b.debitPaise, b.creditPaise) - Math.max(a.debitPaise, a.creditPaise))[0];
  const moved = Math.abs(p.closingPaise) - Math.abs(p.openingPaise);
  const insights = [`${p.lines.length.toLocaleString('en-IN')} entr${p.lines.length === 1 ? 'y' : 'ies'} between ${formatDay(p.from)} and ${formatDay(p.to)}.`];
  if (side(p.openingPaise) === side(p.closingPaise) && moved !== 0) {
    insights.push(`The balance ${moved > 0 ? 'rose' : 'fell'} by ${money(Math.abs(moved))} over the period.`);
  }
  if (biggest) {
    insights.push(`The largest entry was ${money(Math.max(biggest.debitPaise, biggest.creditPaise))} on ${formatDay(String(biggest.date).slice(0, 10))} — ${detail(biggest)}.`);
  }

  return {
    title: `${p.account.name} · ${p.account.code}`,
    subtitle: `${between(p.from, p.to)} · closing ${asAt(p.to).toLowerCase()}`,
    kpis: [
      kpi({ label: 'Closing balance', value: Math.abs(p.closingPaise), unit: 'inr', side: side(p.closingPaise) }),
      kpi({ label: 'Opening balance', value: Math.abs(p.openingPaise), unit: 'inr', side: side(p.openingPaise), note: formatDay(p.from) }),
      kpi({ label: 'Debits', value: debits, unit: 'inr', note: 'In the period' }),
      kpi({ label: 'Credits', value: credits, unit: 'inr', note: 'In the period' }),
    ],
    chart:
      months.length >= 2
        ? { kind: 'line', unit: 'inr', categoryLabel: 'Month end', categories: months.map(monthLabel), series: [{ name: 'Balance', values: balances }] }
        : null,
    table: table(
      [{ label: 'Date' }, { label: 'Detail' }, { label: 'Debit', unit: 'inr' }, { label: 'Credit', unit: 'inr' }, { label: 'Balance', unit: 'inr' }],
      [...p.lines].reverse().map((l) => [formatDay(String(l.date).slice(0, 10)), detail(l), l.debitPaise || null, l.creditPaise || null, l.runningPaise]),
      8,
    ),
    insights,
    source: { label: `General ledger · ${p.account.name}`, href: '/reports/general-ledger' },
  };
}

// ── Trial balance ────────────────────────────────────────────────────────────

export function trialBalanceReport(p: {
  asOf: string;
  totalDebit: number;
  totalCredit: number;
  balanced: boolean;
  rows: { code: string; name: string; debitSide: number; creditSide: number }[];
}): ReportDraft {
  const rows = [...p.rows].sort((a, b) => Math.max(b.debitSide, b.creditSide) - Math.max(a.debitSide, a.creditSide));
  const diff = Math.abs(p.totalDebit - p.totalCredit);
  return {
    title: 'Trial balance',
    subtitle: asAt(p.asOf),
    kpis: [
      kpi({ label: 'Total debits', value: p.totalDebit, unit: 'inr' }),
      kpi({ label: 'Total credits', value: p.totalCredit, unit: 'inr' }),
      kpi({ label: 'Difference', value: diff, unit: 'inr', tone: p.balanced ? 'good' : 'bad', note: p.balanced ? 'The books balance' : 'The books do not balance' }),
      kpi({ label: 'Accounts with a balance', value: rows.length, unit: 'count' }),
    ],
    chart: hbar('inr', 'Account', 'Balance', rows.slice(0, 8).map((r) => ({ name: r.name, value: Math.max(r.debitSide, r.creditSide) }))),
    table: table(
      [{ label: 'Code' }, { label: 'Account' }, { label: 'Debit', unit: 'inr' }, { label: 'Credit', unit: 'inr' }],
      rows.map((r) => [r.code, r.name, r.debitSide || null, r.creditSide || null]),
      12,
      ['', 'Total', p.totalDebit, p.totalCredit],
    ),
    insights: [
      p.balanced
        ? 'Debits equal credits: every entry has both sides.'
        : `Debits and credits differ by ${money(diff)} — something has been posted to one side only.`,
    ],
    source: { label: 'Trial balance', href: '/reports/trial-balance' },
  };
}

// ── Profit and loss ──────────────────────────────────────────────────────────

export function profitAndLossReport(p: {
  from: string;
  to: string;
  prev: { from: string; to: string };
  now: { income: number; expense: number; gross: number; net: number };
  before: { income: number; expense: number; net: number };
  expenseRows: { name: string; balancePaise: number }[];
}): ReportDraft {
  const against = between(p.prev.from, p.prev.to);
  const margin = shareOf(p.now.net, p.now.income);
  const expenses = [...p.expenseRows].filter((r) => r.balancePaise > 0).sort((a, b) => b.balancePaise - a.balancePaise);
  const netChange = changeOf(p.now.net, p.before.net);

  const insights: string[] = [];
  if (netChange !== null) {
    insights.push(
      `Net ${p.now.net >= 0 ? 'profit' : 'loss'} of ${money(Math.abs(p.now.net))} against ${money(Math.abs(p.before.net))} the period before — ${netChange >= 0 ? 'up' : 'down'} ${Math.abs(netChange).toFixed(1)}%.`,
    );
  }
  if (expenses[0]) {
    insights.push(`The largest expense is ${expenses[0].name}, ${money(expenses[0].balancePaise)} — ${(shareOf(expenses[0].balancePaise, p.now.expense) ?? 0).toFixed(1)}% of all expenses.`);
  }
  if (p.now.gross) insights.push(`Gross profit, before overheads, is ${money(p.now.gross)}.`);

  return {
    title: 'Profit and loss',
    subtitle: between(p.from, p.to),
    kpis: [
      kpi({ label: 'Income', value: p.now.income, unit: 'inr', change: { pct: changeOf(p.now.income, p.before.income), upIsGood: true, against } }),
      kpi({ label: 'Expenses', value: p.now.expense, unit: 'inr', change: { pct: changeOf(p.now.expense, p.before.expense), upIsGood: false, against } }),
      kpi({
        label: p.now.net >= 0 ? 'Net profit' : 'Net loss',
        value: p.now.net,
        unit: 'inr',
        tone: p.now.net >= 0 ? 'good' : 'bad',
        change: { pct: netChange, upIsGood: true, against },
      }),
      kpi({ label: 'Net margin', value: margin, unit: 'pct', note: 'Net profit as a share of income' }),
    ],
    chart: {
      kind: 'bar',
      unit: 'inr',
      categoryLabel: 'Measure',
      categories: ['Income', 'Expenses', 'Net profit'],
      series: [
        { name: 'This period', values: [p.now.income, p.now.expense, p.now.net] },
        { name: 'Period before', values: [p.before.income, p.before.expense, p.before.net] },
      ],
    },
    table: table(
      [{ label: 'Expense account' }, { label: 'Amount', unit: 'inr' }, { label: 'Share', unit: 'pct' }],
      expenses.map((r) => [r.name, r.balancePaise, shareOf(r.balancePaise, p.now.expense)]),
      8,
      ['Total expenses', p.now.expense, p.now.expense ? 100 : null],
    ),
    insights,
    source: { label: 'Profit and loss', href: '/reports/profit-and-loss' },
  };
}

// ── Balance sheet ────────────────────────────────────────────────────────────

export function balanceSheetReport(p: {
  asOf: string;
  assets: number;
  liabilities: number;
  equity: number;
  currentEarnings: number;
  balanced: boolean;
  assetRows: { name: string; balancePaise: number }[];
  liabilityRows: { name: string; balancePaise: number }[];
}): ReportDraft {
  const assets = p.assetRows.filter((r) => r.balancePaise > 0);
  const slices = topWithOther(assets, 5, (r) => r.balancePaise, (r) => r.name);
  const top = assets.sort((a, b) => b.balancePaise - a.balancePaise)[0];
  const rows = [
    ...assets.slice(0, 8).map((r) => ['Asset', r.name, r.balancePaise]),
    ...[...p.liabilityRows].sort((a, b) => Math.abs(b.balancePaise) - Math.abs(a.balancePaise)).slice(0, 8).map((r) => ['Liability', r.name, r.balancePaise]),
  ];
  return {
    title: 'Balance sheet',
    subtitle: asAt(p.asOf),
    kpis: [
      kpi({ label: 'Total assets', value: p.assets, unit: 'inr' }),
      kpi({ label: 'Total liabilities', value: p.liabilities, unit: 'inr' }),
      kpi({ label: 'Total equity', value: p.equity, unit: 'inr' }),
      kpi({ label: 'Profit this year', value: p.currentEarnings, unit: 'inr', note: 'Since the start of the financial year' }),
    ],
    chart:
      slices.length >= 2
        ? { kind: 'donut', unit: 'inr', categoryLabel: 'Asset', categories: slices.map((s) => s.name), series: [{ name: 'Assets', values: slices.map((s) => s.value) }] }
        : null,
    table: { columns: [{ label: 'Side' }, { label: 'Account' }, { label: 'Amount', unit: 'inr' }], rows },
    insights: [
      p.balanced ? 'Assets equal liabilities plus equity: the balance sheet balances.' : 'Assets do not equal liabilities plus equity — the books need checking.',
      ...(top ? [`${top.name} is the largest asset, ${(shareOf(top.balancePaise, p.assets) ?? 0).toFixed(1)}% of the total.`] : []),
    ],
    source: { label: 'Balance sheet', href: '/reports/balance-sheet' },
  };
}

// ── Bank and cash ────────────────────────────────────────────────────────────

export function cashPositionReport(p: {
  asOf: string;
  rows: { name: string; kind: string; balancePaise: number; unmatched: number }[];
}): ReportDraft {
  const cash = p.rows.filter((r) => r.kind !== 'card');
  const cards = p.rows.filter((r) => r.kind === 'card');
  const total = sum(cash.map((r) => r.balancePaise));
  const owedOnCards = sum(cards.map((r) => Math.max(0, -r.balancePaise)));
  const unmatched = sum(p.rows.map((r) => r.unmatched || 0));
  const largest = [...cash].sort((a, b) => b.balancePaise - a.balancePaise)[0];
  const overdrawn = cash.filter((r) => r.balancePaise < 0);

  const kpis: ReportKpi[] = [
    kpi({ label: 'Cash and bank', value: total, unit: 'inr', tone: total < 0 ? 'bad' : undefined }),
    kpi({ label: 'Accounts', value: cash.length, unit: 'count', note: 'Bank and cash' }),
  ];
  if (cards.length) kpis.push(kpi({ label: 'Owed on cards', value: owedOnCards, unit: 'inr', tone: owedOnCards > 0 ? 'warn' : undefined }));
  kpis.push(kpi({ label: 'Unreconciled lines', value: unmatched, unit: 'count', tone: unmatched > 0 ? 'warn' : 'good', note: unmatched ? 'Statement lines not yet matched' : 'Everything is matched' }));

  const insights: string[] = [];
  if (largest && total > 0) insights.push(`${largest.name} holds ${(shareOf(largest.balancePaise, total) ?? 0).toFixed(1)}% of your cash.`);
  if (overdrawn.length) insights.push(`${overdrawn.map((r) => r.name).join(', ')} ${overdrawn.length === 1 ? 'is' : 'are'} overdrawn.`);
  if (unmatched) insights.push(`${unmatched} statement line${unmatched === 1 ? ' is' : 's are'} waiting to be reconciled.`);

  return {
    title: 'Bank and cash',
    subtitle: asAt(p.asOf),
    kpis,
    chart: hbar('inr', 'Account', 'Balance', cash.map((r) => ({ name: r.name, value: r.balancePaise }))),
    table: {
      columns: [{ label: 'Account' }, { label: 'Type' }, { label: 'Balance', unit: 'inr' }, { label: 'Unreconciled', unit: 'count' }],
      rows: p.rows.map((r) => [r.name, r.kind === 'card' ? 'Card' : r.kind === 'cash' ? 'Cash' : 'Bank', r.balancePaise, r.unmatched || 0]),
    },
    insights,
    source: { label: 'Banking', href: '/banking' },
  };
}

// ── What customers owe, and what we owe suppliers ────────────────────────────

const BUCKET_WORDS: Record<string, string> = {
  Current: 'Not yet due',
  '1–15': '1–15 days',
  '16–30': '16–30 days',
  '31–45': '31–45 days',
  '46–60': '46–60 days',
  '60+': 'Over 60 days',
};

export function ageingReport(p: {
  side: 'receivable' | 'payable';
  asOf: string;
  buckets: readonly string[];
  totals: Record<string, number>;
  rows: { name: string; totalPaise: number; buckets: Record<string, number> }[];
  owed: number;
  /** Paid in advance: a credit the ageing report nets off, and the chart leaves out. */
  advances?: number;
  msme?: { unpaid: number; past45: number };
}): ReportDraft {
  const ar = p.side === 'receivable';
  const overdueOf = (b: Record<string, number>) => sum(Object.entries(b).filter(([k]) => k !== 'Current').map(([, v]) => v));
  const overdue = overdueOf(p.totals);
  const share = shareOf(overdue, p.owed);
  const debtors = p.rows.filter((r) => r.totalPaise > 0).sort((a, b) => b.totalPaise - a.totalPaise);
  const top3 = sum(debtors.slice(0, 3).map((r) => r.totalPaise));
  const old = p.totals['60+'] ?? 0;
  const who = ar ? 'customer' : 'supplier';

  const insights: string[] = [];
  if (debtors.length > 3 && p.owed > 0) {
    insights.push(`The three largest ${who}s account for ${(shareOf(top3, p.owed) ?? 0).toFixed(1)}% of the total.`);
  }
  if (old > 0) insights.push(`${money(old)} is more than 60 days past due${ar ? ' — the hardest money to collect' : ''}.`);
  const late = debtors.filter((r) => overdueOf(r.buckets) > 0).length;
  if (late) insights.push(`${late} ${who}${late === 1 ? ' has' : 's have'} something overdue.`);
  if (p.advances) {
    insights.push(
      ar
        ? `You also hold ${money(p.advances)} paid in advance by customers, which the ageing report nets off.`
        : `You have also paid suppliers ${money(p.advances)} in advance, which the ageing report nets off.`,
    );
  }
  if (p.msme?.unpaid) {
    insights.push(
      `${p.msme.unpaid} unpaid bill${p.msme.unpaid === 1 ? '' : 's'} from MSME suppliers${p.msme.past45 ? `, ${p.msme.past45} past the 45-day limit` : ''}.`,
    );
  }

  return {
    title: ar ? 'What customers owe' : 'What you owe suppliers',
    subtitle: `${asAt(p.asOf)} · aged from the due date`,
    kpis: [
      kpi({ label: ar ? 'Owed by customers' : 'Owed to suppliers', value: p.owed, unit: 'inr' }),
      kpi({ label: 'Overdue', value: overdue, unit: 'inr', tone: overdue <= 0 ? 'good' : (share ?? 0) >= 50 ? 'bad' : 'warn' }),
      kpi({ label: 'Share overdue', value: share, unit: 'pct', note: 'Of the amount owed' }),
      kpi({ label: ar ? 'Customers owing' : 'Suppliers owed', value: debtors.length, unit: 'count' }),
    ],
    chart: {
      kind: 'bar',
      unit: 'inr',
      categoryLabel: 'Days past due',
      categories: p.buckets.map((b) => BUCKET_WORDS[b] ?? b),
      // What is owed, band by band. An advance nets a band below zero in the
      // ageing report; it is said in words below instead of drawn as debt.
      series: [{ name: ar ? 'Owed by customers' : 'Owed to suppliers', values: p.buckets.map((b) => Math.max(0, p.totals[b] ?? 0)) }],
      ordinal: true,
    },
    table: table(
      [{ label: ar ? 'Customer' : 'Supplier' }, { label: ar ? 'Owes' : 'Owed', unit: 'inr' }, { label: 'Overdue', unit: 'inr' }, { label: 'Over 60 days', unit: 'inr' }],
      debtors.map((r) => [r.name, r.totalPaise, overdueOf(r.buckets), r.buckets['60+'] ?? 0]),
      10,
    ),
    insights,
    source: ar ? { label: 'Receivables ageing', href: '/reports/ar-ageing' } : { label: 'Payables ageing', href: '/reports/ap-ageing' },
  };
}

// ── Invoices and bills found by a search ─────────────────────────────────────

export function documentsReport(p: {
  kind: 'invoice' | 'bill';
  matching: number;
  totalValue: number;
  unpaid: number;
  docs: { number: string; party: string; due: string; status: string; balance: number; daysOverdue: number | undefined }[];
}): ReportDraft {
  const inv = p.kind === 'invoice';
  const open = p.docs.filter((d) => d.balance > 0).sort((a, b) => b.balance - a.balance);
  const late = p.docs.filter((d) => (d.daysOverdue ?? 0) > 0).sort((a, b) => (b.daysOverdue ?? 0) - (a.daysOverdue ?? 0));
  return {
    title: inv ? 'Invoices found' : 'Bills found',
    subtitle: `${p.matching.toLocaleString('en-IN')} matching · the ${p.docs.length} most recent listed`,
    kpis: [
      kpi({ label: inv ? 'Invoices' : 'Bills', value: p.matching, unit: 'count' }),
      kpi({ label: 'Total value', value: p.totalValue, unit: 'inr' }),
      kpi({ label: 'Unpaid', value: p.unpaid, unit: 'inr', tone: p.unpaid > 0 ? 'warn' : 'good' }),
    ],
    chart: hbar('inr', inv ? 'Invoice' : 'Bill', 'Unpaid', open.slice(0, 8).map((d) => ({ name: `${d.number} · ${d.party}`, value: d.balance }))),
    table: {
      columns: [
        { label: inv ? 'Invoice' : 'Bill' },
        { label: inv ? 'Customer' : 'Supplier' },
        { label: 'Due' },
        { label: 'Status' },
        { label: 'Balance', unit: 'inr' },
        { label: 'Days overdue', unit: 'count' },
      ],
      rows: p.docs.map((d) => [d.number, d.party, formatDay(d.due), d.status, d.balance, d.daysOverdue ?? null]),
      more: p.matching > p.docs.length ? p.matching - p.docs.length : undefined,
    },
    insights: late[0]
      ? [
          `${late.length} of those listed ${late.length === 1 ? 'is' : 'are'} overdue; the oldest, ${late[0].number}, by ${late[0].daysOverdue} days.`,
        ]
      : [],
    source: inv ? { label: 'Invoices', href: '/sales/invoices' } : { label: 'Bills', href: '/purchases/bills' },
  };
}

// ── Sales ────────────────────────────────────────────────────────────────────

const GROUP_WORDS = { customer: 'Customer', item: 'Item', salesperson: 'Salesperson', month: 'Month' } as const;

export function salesReport(p: {
  from: string;
  to: string;
  by: keyof typeof GROUP_WORDS;
  rows: { name: string; taxable: number; tax: number; count: number }[];
  href: string;
}): ReportDraft {
  const taxable = sum(p.rows.map((r) => r.taxable));
  const tax = sum(p.rows.map((r) => r.tax));
  const monthly = p.by === 'month';
  const label = GROUP_WORDS[p.by];
  const named = (r: { name: string }) => (monthly ? monthLabel(r.name) : r.name);
  const ranked = monthly ? p.rows : [...p.rows].sort((a, b) => b.taxable - a.taxable);

  const insights: string[] = [];
  if (monthly && p.rows.length >= 2) {
    const best = [...p.rows].sort((a, b) => b.taxable - a.taxable)[0];
    const [prev, last] = p.rows.slice(-2);
    insights.push(`The best month was ${monthLabel(best.name)}, at ${money(best.taxable)} before tax.`);
    const c = changeOf(last.taxable, prev.taxable);
    if (c !== null) insights.push(`${monthLabel(last.name)} is ${c >= 0 ? 'up' : 'down'} ${Math.abs(c).toFixed(1)}% on ${monthLabel(prev.name)}.`);
  } else if (ranked[0] && taxable) {
    insights.push(`${ranked[0].name} is the largest, with ${(shareOf(ranked[0].taxable, taxable) ?? 0).toFixed(1)}% of sales.`);
    const top3 = sum(ranked.slice(0, 3).map((r) => r.taxable));
    if (ranked.length > 3) insights.push(`The top three make up ${(shareOf(top3, taxable) ?? 0).toFixed(1)}% of sales.`);
  }

  const points = ranked.map((r) => ({ name: named(r), value: r.taxable }));
  return {
    title: monthly ? 'Sales by month' : `Sales by ${label.toLowerCase()}`,
    subtitle: between(p.from, p.to),
    kpis: [
      kpi({ label: 'Sales, with tax', value: taxable + tax, unit: 'inr' }),
      kpi({ label: 'Before tax', value: taxable, unit: 'inr' }),
      kpi({ label: 'GST charged', value: tax, unit: 'inr' }),
      kpi({ label: monthly ? 'Invoices' : `${label}s`, value: monthly ? sum(p.rows.map((r) => r.count)) : p.rows.length, unit: 'count' }),
    ],
    chart: monthly
      ? points.length >= 2
        ? { kind: points.length >= 3 ? 'line' : 'bar', unit: 'inr', categoryLabel: 'Month', categories: points.map((x) => x.name), series: [{ name: 'Sales before tax', values: points.map((x) => x.value) }] }
        : null
      : hbar('inr', label, 'Sales before tax', points.slice(0, 8)),
    table: table(
      [{ label }, { label: 'Before tax', unit: 'inr' }, { label: 'Tax', unit: 'inr' }, { label: 'Total', unit: 'inr' }, { label: 'Share', unit: 'pct' }],
      ranked.map((r) => [named(r), r.taxable, r.tax, r.taxable + r.tax, shareOf(r.taxable, taxable)]),
      monthly ? 24 : 10,
      ['Total', taxable, tax, taxable + tax, taxable ? 100 : null],
    ),
    insights,
    source: { label: monthly ? 'Sales reports' : `Sales by ${label.toLowerCase()}`, href: p.href },
  };
}

// ── Expenses ─────────────────────────────────────────────────────────────────

export function expensesReport(p: {
  from: string;
  to: string;
  prev: { from: string; to: string };
  total: number;
  prevTotal: number;
  rows: { name: string; amountPaise: number }[];
}): ReportDraft {
  const rows = [...p.rows].filter((r) => r.amountPaise > 0).sort((a, b) => b.amountPaise - a.amountPaise);
  const c = changeOf(p.total, p.prevTotal);
  const insights: string[] = [];
  if (rows[0]) insights.push(`${rows[0].name} is the largest, ${(shareOf(rows[0].amountPaise, p.total) ?? 0).toFixed(1)}% of spending.`);
  if (c !== null) insights.push(`Spending is ${c >= 0 ? 'up' : 'down'} ${Math.abs(c).toFixed(1)}% on the period before (${money(p.prevTotal)}).`);
  return {
    title: 'Expenses by account',
    subtitle: between(p.from, p.to),
    kpis: [
      kpi({ label: 'Total spent', value: p.total, unit: 'inr', change: { pct: c, upIsGood: false, against: between(p.prev.from, p.prev.to) } }),
      kpi({ label: 'Period before', value: p.prevTotal, unit: 'inr', note: between(p.prev.from, p.prev.to) }),
      kpi({ label: 'Expense accounts', value: rows.length, unit: 'count' }),
    ],
    chart: hbar('inr', 'Expense account', 'Spent', rows.slice(0, 8).map((r) => ({ name: r.name, value: r.amountPaise }))),
    table: table(
      [{ label: 'Expense account' }, { label: 'Amount', unit: 'inr' }, { label: 'Share', unit: 'pct' }],
      rows.map((r) => [r.name, r.amountPaise, shareOf(r.amountPaise, p.total)]),
      10,
      ['Total', p.total, p.total ? 100 : null],
    ),
    insights,
    source: { label: 'Expenses by category', href: '/reports/expenses-by-category' },
  };
}

// ── GST ──────────────────────────────────────────────────────────────────────

export function gstReport(p: {
  month: string;
  outputTax: number;
  itc: number;
  blocked: number;
  cash: number;
  setOff: { head: string; liabilityPaise: number; creditUsedPaise: number; cashPaise: number }[];
  due: { gstr1: string; gstr3b: string };
}): ReportDraft {
  const heads = p.setOff.filter((s) => s.liabilityPaise || s.creditUsedPaise || s.cashPaise);
  return {
    title: `GST for ${monthLabel(p.month)}`,
    subtitle: `GSTR-3B · due ${formatDay(p.due.gstr3b)}`,
    kpis: [
      kpi({ label: 'Tax on sales', value: p.outputTax, unit: 'inr' }),
      kpi({ label: 'Input tax credit', value: p.itc, unit: 'inr', note: 'Tax paid on purchases' }),
      kpi({ label: 'Payable in cash', value: p.cash, unit: 'inr', tone: p.cash > 0 ? 'warn' : 'good', note: p.cash > 0 ? `Pay by ${formatDay(p.due.gstr3b)}` : 'Covered by credit' }),
      kpi({ label: 'Blocked credit', value: p.blocked, unit: 'inr', tone: p.blocked > 0 ? 'warn' : undefined, note: 'Cannot be claimed' }),
    ],
    chart: heads.length
      ? {
          kind: 'bar',
          unit: 'inr',
          categoryLabel: 'Tax head',
          categories: heads.map((s) => s.head),
          series: [
            { name: 'Paid from credit', values: heads.map((s) => s.creditUsedPaise) },
            { name: 'Paid in cash', values: heads.map((s) => s.cashPaise) },
          ],
          stacked: true,
        }
      : null,
    table: {
      columns: [{ label: 'Head' }, { label: 'Liability', unit: 'inr' }, { label: 'From credit', unit: 'inr' }, { label: 'In cash', unit: 'inr' }],
      rows: heads.map((s) => [s.head, s.liabilityPaise, s.creditUsedPaise, s.cashPaise]),
      total: ['Total', sum(heads.map((s) => s.liabilityPaise)), sum(heads.map((s) => s.creditUsedPaise)), p.cash],
    },
    insights: [
      `GSTR-1 is due by ${formatDay(p.due.gstr1)} and GSTR-3B by ${formatDay(p.due.gstr3b)} (monthly filers).`,
      ...(p.blocked > 0 ? [`${money(p.blocked)} of input tax cannot be claimed — it stays a cost.`] : []),
    ],
    source: { label: `GSTR-3B · ${p.month}`, href: '/gst/gstr3b' },
  };
}

// ── Ratios ───────────────────────────────────────────────────────────────────

export function ratiosReport(p: {
  from: string;
  to: string;
  ratios: { label: string; value: number; unit: 'pct' | 'ratio' | 'days'; good: boolean; explain: string }[];
}): ReportDraft {
  const healthy = p.ratios.filter((r) => r.good).length;
  return {
    title: 'Business ratios',
    subtitle: between(p.from, p.to),
    kpis: p.ratios.slice(0, 4).map((r) =>
      kpi({ label: r.label, value: r.value, unit: r.unit, tone: r.good ? 'good' : 'warn', note: r.good ? 'Looks healthy' : 'Worth a look' }),
    ),
    chart: null,
    table: {
      columns: [{ label: 'Ratio' }, { label: 'Value' }, { label: 'Looks healthy' }, { label: 'What it means' }],
      rows: p.ratios.map((r) => [r.label, formatFigure(r.value, r.unit), r.good ? 'Yes' : 'No', r.explain]),
    },
    insights: p.ratios.length ? [`${healthy} of ${p.ratios.length} ratios look healthy.`] : [],
    source: { label: 'Business performance ratios', href: '/reports/business-ratios' },
  };
}

// ── Cash flow ────────────────────────────────────────────────────────────────

export function cashFlowReport(p: {
  from: string;
  to: string;
  opening: number;
  operating: number;
  investing: number;
  financing: number;
  closing: number;
  rows: { label: string; group: string; amountPaise: number }[];
}): ReportDraft {
  const net = p.closing - p.opening;
  const rows = [...p.rows].sort((a, b) => Math.abs(b.amountPaise) - Math.abs(a.amountPaise));
  return {
    title: 'Cash flow',
    subtitle: between(p.from, p.to),
    kpis: [
      kpi({ label: 'Opening cash', value: p.opening, unit: 'inr' }),
      kpi({ label: 'Closing cash', value: p.closing, unit: 'inr' }),
      kpi({ label: 'Net change', value: net, unit: 'inr', tone: net >= 0 ? 'good' : 'warn' }),
      kpi({ label: 'From operations', value: p.operating, unit: 'inr', tone: p.operating >= 0 ? 'good' : 'warn', note: 'Cash the business itself made or used' }),
    ],
    chart: {
      kind: 'bar',
      unit: 'inr',
      categoryLabel: 'Activity',
      categories: ['Operating', 'Investing', 'Financing'],
      series: [{ name: 'Net cash', values: [p.operating, p.investing, p.financing] }],
      signed: true,
    },
    table: table(
      [{ label: 'Movement' }, { label: 'Activity' }, { label: 'Amount', unit: 'inr' }],
      rows.map((r) => [r.label, r.group, r.amountPaise]),
      10,
    ),
    insights: [
      `Operations ${p.operating >= 0 ? 'brought in' : 'used'} ${money(Math.abs(p.operating))}; cash ${net >= 0 ? 'rose' : 'fell'} by ${money(Math.abs(net))} over the period.`,
    ],
    source: { label: 'Cash flow statement', href: '/reports/cash-flow' },
  };
}
