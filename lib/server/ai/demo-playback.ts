import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// The assistant on the online demo, which has no database.
//
// scripts/demo-ai-snapshot.ts runs every lookup against the demo book — each
// customer, supplier, item and account, each period a question is likely to
// name — and keeps what each returned. Here a lookup the model (or the
// stand-in) asks for is answered with the recorded result that fits it best:
// the same name, the same status or grouping, the nearest period.
//
// The nearest period is not always the asked-for period, so every recorded
// result carries its own dates, and the answer quotes those. A name the
// sample company does not have is said to be missing, never answered with
// someone else's figures.
// ─────────────────────────────────────────────────────────────────────────────

import type { AiReport } from '../../ai/reports';
import type { RoleName } from '../../types';
import { reportKey } from './reports';
import { pickAccount, toolLabel, type AccountRow, type BankName, type ToolRun, type ToolSource } from './tools';
import { previousMonth } from './time';
import type { ToolCall } from './types';

export interface RecordedRun {
  args: Record<string, unknown>;
  content: string;
  sources: ToolSource[];
  report: Omit<AiReport, 'key'> | null;
}

export interface AiRecording {
  recordedAt: string;
  /** The day the figures are as at: the demo's "today". */
  today: string;
  fyStart: string;
  orgName: string;
  userName: string;
  role: RoleName;
  accounts: AccountRow[];
  banks: BankName[];
  tools: Record<string, RecordedRun[]>;
}

/** Arguments that name someone or something. */
const NAME_KEYS = ['account', 'customer', 'vendor', 'party', 'item', 'project'] as const;
const DATE_KEYS = ['from', 'to', 'as_of', 'month'] as const;
/** Said only when it matters — a statement's side, for a contact who is both — so leaving it out fits any. */
const OPTIONAL = new Set(['side']);
/** Shapes the size of a result, not which result it is. */
const IGNORED = new Set(['limit', 'months']);

/** What a missing argument means, per lookup, so "nothing said" and "the default said" match. */
const DEFAULTS: Record<string, Record<string, unknown>> = {
  get_sales_summary: { group_by: 'customer' },
  search_invoices: { status: 'any' },
  search_bills: { status: 'any' },
  search_payments: { direction: 'received' },
  get_projects: { status: 'active' },
  get_stock: { view: 'summary' },
  get_open_orders: { kind: 'all' },
  get_pending_payments: { side: 'both', due: 'all' },
};

/** Lookups whose from/to default to the financial year so far. */
const RANGE_TOOLS = new Set(['get_profit_and_loss', 'get_sales_summary', 'get_expense_summary', 'get_business_ratios', 'get_cash_flow', 'search_payments', 'get_party_statement']);
/** Lookups whose as_of defaults to today. */
const AS_OF_TOOLS = new Set(['get_account_balance', 'get_trial_balance', 'get_balance_sheet', 'get_receivables', 'get_payables', 'get_stock', 'get_fixed_assets']);

const norm = (v: unknown) => String(v ?? '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const days = (a: string, b: string) => Math.abs(Date.parse(a.length === 7 ? `${a}-01` : a) - Date.parse(b.length === 7 ? `${b}-01` : b)) / 86_400_000;

function effective(tool: string, args: Record<string, unknown>, rec: AiRecording): Record<string, unknown> {
  const out: Record<string, unknown> = { ...DEFAULTS[tool], ...args };
  for (const k of Object.keys(out)) if (out[k] === undefined || out[k] === null || IGNORED.has(k)) delete out[k];
  if (RANGE_TOOLS.has(tool)) {
    out.from ??= rec.fyStart;
    out.to ??= rec.today;
  }
  if (AS_OF_TOOLS.has(tool)) out.as_of ??= rec.today;
  if (tool === 'get_gst_summary') out.month ??= previousMonth(rec.today);
  return out;
}

const isName = (k: string) => (NAME_KEYS as readonly string[]).includes(k);
const isDate = (k: string) => (DATE_KEYS as readonly string[]).includes(k);

/** How well a recording fits what was asked; null when it is a different question. */
function fit(want: Record<string, unknown>, have: Record<string, unknown>): number | null {
  let score = 0;
  for (const k of new Set([...Object.keys(want), ...Object.keys(have)])) {
    const w = want[k];
    const h = have[k];
    if (isName(k)) {
      if (w === undefined || h === undefined) return null;
      const a = norm(w);
      const b = norm(h);
      if (a === b) score += 25;
      else if (a && b && (b.includes(a) || a.includes(b))) score += 20;
      else return null;
    } else if (isDate(k)) {
      if (w === undefined || h === undefined) {
        score -= 1;
        continue;
      }
      if (String(w) === String(h)) score += 5;
      else score -= days(String(w), String(h)) / 31;
    } else if (OPTIONAL.has(k) && w === undefined) {
      // The first recorded fits best: a customer's side before a supplier's.
      score -= 0.5;
    } else if (String(w) !== String(h)) {
      return null;
    } else {
      score += 10;
    }
  }
  return score;
}

const missing = (call: ToolCall, data: unknown): ToolRun => ({
  ok: false,
  content: JSON.stringify(data),
  sources: [],
  label: toolLabel(call.name),
  report: null,
});

/** Answer one lookup from the recording. Never throws, like runTool. */
export function playLookup(rec: AiRecording, call: ToolCall): ToolRun {
  let args: Record<string, unknown> = {};
  try {
    args = call.arguments?.trim() ? (JSON.parse(call.arguments) as Record<string, unknown>) : {};
  } catch {
    return missing(call, { error: 'The arguments were not valid JSON.' });
  }
  const runs = rec.tools[call.name];
  if (!runs?.length) return missing(call, { error: 'That report is not part of the online demo.' });

  // An account is found by the words used, the way the real lookup finds it.
  if (call.name === 'get_account_balance' && typeof args.account === 'string') {
    const { match, candidates } = pickAccount(rec.accounts, rec.banks, args.account);
    if (!match) {
      return missing(call, {
        found: false,
        query: args.account,
        candidates: candidates.map((c) => ({ code: c.code, name: c.name, type: c.type })),
        hint: candidates.length ? 'More than one account could be meant. Pick the obvious one by calling again with its code, or ask which one.' : 'No account matches.',
      });
    }
    args = { ...args, account: match.code };
  }

  const want = effective(call.name, args, rec);
  let best: RecordedRun | null = null;
  let bestScore = -Infinity;
  for (const run of runs) {
    const s = fit(want, effective(call.name, run.args, rec));
    if (s !== null && s > bestScore) {
      best = run;
      bestScore = s;
    }
  }

  if (!best) {
    const named = NAME_KEYS.find((k) => typeof args[k] === 'string');
    if (named) {
      const who = String(args[named]);
      const known = [...new Set(runs.map((r) => r.args[named]).filter((v): v is string => typeof v === 'string'))];
      const near = known.filter((n) => norm(who).split(' ').some((t) => t.length > 2 && norm(n).includes(t))).slice(0, 6);
      return missing(call, {
        found: false,
        query: who,
        candidates: near.map((name) => ({ name })),
        hint: near.length ? 'More than one could be meant. Call again with the full name, or ask which one.' : `Nothing in the sample company is called "${who}".`,
      });
    }
    return missing(call, { error: 'That view of the report is not part of the online demo.' });
  }

  return {
    ok: true,
    content: best.content,
    sources: best.sources,
    label: toolLabel(call.name),
    report: best.report ? { ...best.report, key: reportKey(call.name, args) } : null,
  };
}
