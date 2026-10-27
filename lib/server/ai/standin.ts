import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// The built-in stand-in.
//
// Answers when no OpenAI key is configured — in development, in tests, and on
// a server that is not live yet — so the whole assistant can be built and
// exercised without spending anything: the tools run against the real books,
// the answer streams, and the question is charged credits for the tokens a
// real model would have used.
//
// It does not reason. It matches a question to the tools a model would most
// likely have called, and writes their results up plainly. Every answer says
// that it came from the stand-in, so nobody mistakes it for the real thing.
//
// Never used in production unless AI_STANDIN=1 says so explicitly.
// ─────────────────────────────────────────────────────────────────────────────

import { estimateTokens } from './pricing';
import {
  ProviderError,
  type AiProvider, type CallUsage, type ChatMessage, type ChatRequest, type ChatResult, type ToolCall,
} from './types';

/* eslint-disable @typescript-eslint/no-explicit-any -- tool results are read defensively, field by field */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Planned {
  name: string;
  args: Record<string, unknown>;
}

/** "closing balance of HDFC Bank today" → "HDFC Bank". */
export function extractAccount(question: string): string | null {
  const m = question.match(
    /(?:balance|ledger)\s+(?:of|for|in|on)\s+(?:the\s+|our\s+|my\s+)?(.+?)(?:\s+(?:as of|as on|on|today|now|this|at|till|until)\b.*)?[?.!\s]*$/i,
  );
  if (!m) return null;
  const s = m[1].replace(/\b(account|a\/c)\b/gi, '').replace(/\s+/g, ' ').trim();
  if (s.length < 2 || /\b(each|all|every)\b/i.test(s)) return null;
  return s.slice(0, 60);
}

/**
 * The tools a model would probably reach for, among those actually offered.
 *
 * Empty when the question needs reports this role was not given — the caller
 * says so, rather than answering a different question the role can see.
 */
export function planTools(question: string, offered: Set<string>): Planned[] {
  const q = question.toLowerCase();
  const out: Planned[] = [];
  const add = (name: string, args: Record<string, unknown> = {}) => {
    if (!out.some((p) => p.name === name)) out.push({ name, args });
  };

  const account = extractAccount(question);
  if (account) add('get_account_balance', { account });
  if (/\bcash\b|\bbank\b/.test(q) && !account) add('get_cash_position');
  if (/overdue|receivable|owe us|owes us|debtor|collect|who owes/.test(q)) add('get_receivables');
  if (/payable|we owe|creditor|supplier|vendor|msme/.test(q)) add('get_payables');
  if (/profit|loss|p&l|p & l|earning|making money/.test(q)) add('get_profit_and_loss');
  if (/\bgst\b|gstr|input (tax )?credit|\bitc\b|tax (liability|payable)/.test(q)) add('get_gst_summary');
  if (/top customer|best customer|biggest customer|sales by|best-selling|best selling/.test(q)) {
    add('get_sales_summary', { group_by: /item|product|selling/.test(q) ? 'item' : 'customer', limit: 5 });
  }
  if (/expense|spend|spent|costs?\b/.test(q)) add('get_expense_summary', { limit: 5 });
  if (/ratio|margin|dso|days sales/.test(q)) add('get_business_ratios');
  if (/cash ?flow/.test(q)) add('get_cash_flow');
  if (/trial balance/.test(q)) add('get_trial_balance');
  if (/balance sheet/.test(q)) add('get_balance_sheet');
  if (/invoice/.test(q) && !out.length) add('search_invoices', { status: /overdue/.test(q) ? 'overdue' : 'unpaid', limit: 8 });

  const usable = out.filter((p) => offered.has(p.name));
  if (usable.length) return usable.slice(0, 3);
  if (out.length) return [];
  return offered.has('get_attention_items') ? [{ name: 'get_attention_items', args: {} }] : [];
}

// ── Writing the results up ───────────────────────────────────────────────────

const table = (head: string[], rows: (string | number | undefined)[][]): string =>
  [
    `| ${head.join(' | ')} |`,
    `| ${head.map((_, i) => (i === 0 ? '---' : '---:')).join(' | ')} |`,
    ...rows.map((r) => `| ${r.map((c) => (c === undefined || c === null ? '—' : String(c).replace(/\|/g, '/'))).join(' | ')} |`),
  ].join('\n');

function describe(name: string, d: any): string {
  if (d?.error) return `I could not run that lookup: ${d.error}`;
  switch (name) {
    case 'get_account_balance':
      if (!d.found) {
        return d.candidates?.length
          ? `More than one account could match "${d.query}":\n\n${d.candidates.map((c: any) => `- ${c.name} (${c.code})`).join('\n')}\n\nWhich one did you mean?`
          : `I could not find an account matching "${d.query}".`;
      }
      return (
        `The closing balance of **${d.account.name}** (${d.account.code}) on ${d.period.to} is **${d.closing_balance}**.\n\n` +
        table(['From', 'Opening', 'Debits', 'Credits', 'Closing'], [[d.period.from, d.opening_balance, d.debits, d.credits, d.closing_balance]])
      );
    case 'get_cash_position':
      return (
        `You have **${d.total_cash_and_bank}** across your cash and bank accounts today.\n\n` +
        table(['Account', 'Balance'], (d.accounts ?? []).map((a: any) => [a.name, a.balance]))
      );
    case 'get_receivables':
      return (
        `Customers owe **${d.owed_by_customers}**, of which **${d.overdue}** is past its due date.` +
        (d.advances_held_for_customers
          ? ` You also hold ${d.advances_held_for_customers} paid in advance, so the net receivable is ${d.net_receivable_as_in_the_ageing_report}.`
          : '') +
        '\n\n' +
        table(['Customer', 'Owes', 'Overdue'], (d.customers ?? []).slice(0, 5).map((c: any) => [c.name, c.owes, c.overdue]))
      );
    case 'get_payables':
      return (
        `You owe suppliers **${d.owed_to_suppliers}**, of which **${d.overdue}** is overdue.` +
        (d.msme_bills_unpaid?.length ? ` ${d.msme_bills_unpaid.length} MSME bill(s) are unpaid.` : '') +
        '\n\n' +
        table(['Supplier', 'Owed', 'Overdue'], (d.suppliers ?? []).slice(0, 5).map((s: any) => [s.name, s.owed, s.overdue]))
      );
    case 'get_profit_and_loss':
      return (
        `From ${d.period.from} to ${d.period.to}, income was **${d.income}** against expenses of **${d.expenses}** — a net ${d.result} of **${d.net_profit}**.\n\n` +
        table(
          ['', 'This period', 'Period before'],
          [
            ['Income', d.income, d.previous_period?.income],
            ['Expenses', d.expenses, d.previous_period?.expenses],
            ['Net profit', d.net_profit, d.previous_period?.net_profit],
          ],
        )
      );
    case 'get_gst_summary':
      return (
        `For ${d.month}, the GST payable in cash after input tax credit is **${d.payable_in_cash}**. GSTR-3B is due by ${d.due_dates?.gstr3b}.\n\n` +
        table(['Head', 'Liability', 'From credit', 'In cash'], (d.set_off ?? []).map((s: any) => [s.head, s.liability, s.paid_from_credit, s.paid_in_cash]))
      );
    case 'get_sales_summary':
      return (
        `Sales from ${d.period.from} to ${d.period.to} were **${d.total_invoiced}** including tax.\n\n` +
        table([d.group_by, 'Before tax', 'Share'], (d.rows ?? []).map((r: any) => [r[d.group_by], r.before_tax, r.share]))
      );
    case 'get_expense_summary':
      return (
        `Expenses from ${d.period.from} to ${d.period.to} came to **${d.total}**.\n\n` +
        table(['Account', 'Amount', 'Share'], (d.categories ?? []).map((c: any) => [c.name, c.amount, c.share]))
      );
    case 'get_business_ratios':
      return `${(d.ratios ?? []).filter((r: any) => r.healthy).length} of ${(d.ratios ?? []).length} ratios look healthy between ${d.period?.from} and ${d.period?.to}.`;
    case 'get_cash_flow':
      return (
        `Cash went from **${d.opening_cash}** to **${d.closing_cash}** between ${d.period.from} and ${d.period.to}.\n\n` +
        table(['Activity', 'Net'], [['Operating', d.operating], ['Investing', d.investing], ['Financing', d.financing]])
      );
    case 'get_trial_balance':
      return `On ${d.as_of} the trial balance totals **${d.total_debit}** on each side, and it ${d.balanced ? 'balances' : 'does not balance'}.`;
    case 'get_balance_sheet':
      return `On ${d.as_of} assets total **${d.total_assets}**, liabilities **${d.total_liabilities}** and equity **${d.total_equity}**.`;
    case 'search_invoices':
      return (
        `${d.matching} invoice(s) match, worth ${d.total_value}, with **${d.unpaid}** unpaid.\n\n` +
        table(['Invoice', 'Customer', 'Due', 'Balance'], (d.invoices ?? []).map((i: any) => [i.number, i.customer, i.due, i.balance]))
      );
    case 'get_attention_items':
      return d.count
        ? `${d.count} thing(s) need attention:\n\n${d.items.map((i: any) => `- **${i.title}** — ${i.detail}`).join('\n')}`
        : 'Nothing in the books needs attention right now.';
    default:
      return 'Here is what that report shows.';
  }
}

const FOLLOWUPS: Record<string, string[]> = {
  get_account_balance: ['What were the largest entries in this account this month?', 'How does this compare with last month?'],
  get_cash_position: ['Can we cover what we owe suppliers this month?', 'Which bank lines are still unreconciled?'],
  get_receivables: ['Which invoices are more than 60 days overdue?', 'How long do customers take to pay us on average?'],
  get_payables: ['Which MSME bills must we pay this week?', 'What is our cash position today?'],
  get_profit_and_loss: ['What are our biggest expenses this year?', 'What is our net margin?'],
  get_gst_summary: ['How much input tax credit is blocked, and why?', 'What is due in GSTR-1 this month?'],
};

/** A write-up without its table: the detailed report under the answer shows the rows. */
function summaryOnly(text: string): string {
  return text
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('|'))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function writeUp(results: { name: string; data: any }[]): string {
  const body = results.map((r) => summaryOnly(describe(r.name, r.data))).join('\n\n');
  const questions = [...new Set(results.flatMap((r) => FOLLOWUPS[r.name] ?? []))].slice(0, 3);
  return (
    `${body}\n\n_Answered by the built-in stand-in, which reads the same reports but does not reason about them. Set OPENAI_API_KEY for full answers._` +
    (questions.length ? `\n\n\`\`\`followups\n${questions.map((q) => `- ${q}`).join('\n')}\n\`\`\`` : '')
  );
}

// ── The provider ─────────────────────────────────────────────────────────────

export class StandinProvider implements AiProvider {
  readonly name = 'standin' as const;
  readonly model = 'stand-in';
  private readonly delayMs: number;

  constructor(opts: { delayMs?: number } = {}) {
    this.delayMs = opts.delayMs ?? 12;
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const inputTokens = estimateTokens(JSON.stringify(req.messages) + JSON.stringify(req.tools ?? []));
    const lastUser = [...req.messages].reverse().find((m) => m.role === 'user') as Extract<ChatMessage, { role: 'user' }> | undefined;
    const userIndex = lastUser ? req.messages.lastIndexOf(lastUser) : -1;
    const toolResults = req.messages
      .slice(userIndex + 1)
      .filter((m): m is Extract<ChatMessage, { role: 'tool' }> => m.role === 'tool');

    // First round: decide what to look up.
    if (!toolResults.length && req.tools?.length && req.toolChoice !== 'none') {
      const offered = new Set(req.tools.map((t) => t.name));
      const planned = planTools(lastUser?.content ?? '', offered);
      if (planned.length) {
        const calls: ToolCall[] = planned.map((p, i) => ({ id: `standin_${i + 1}`, name: p.name, arguments: JSON.stringify(p.args) }));
        return {
          text: '',
          toolCalls: calls,
          usage: this.usage(inputTokens, JSON.stringify(calls)),
          finishReason: 'tool_calls',
        };
      }
      return this.say(
        "Your role does not include the reports that question needs. An administrator can answer it, or change what your role can see.",
        inputTokens,
        req,
      );
    }

    if (!toolResults.length) {
      return this.say(
        'I can answer questions about balances, profit, cash, what customers owe, what you owe suppliers, GST and sales — each from the same reports the app shows.',
        inputTokens,
        req,
      );
    }

    const results = toolResults.map((m) => {
      let data: unknown;
      try {
        data = JSON.parse(m.content);
      } catch {
        data = { error: 'unreadable result' };
      }
      return { name: m.name, data };
    });
    return this.say(writeUp(results), inputTokens, req);
  }

  /** Stream a finished answer a few words at a time, the way a model would. */
  private async say(text: string, inputTokens: number, req: ChatRequest): Promise<ChatResult> {
    const pieces = text.match(/\S+\s*/g) ?? [text];
    let sent = '';
    for (let i = 0; i < pieces.length; i += 3) {
      if (req.signal?.aborted) {
        throw new ProviderError('Stopped.', 'aborted', { partial: { text: sent, usage: this.usage(inputTokens, sent) } });
      }
      const chunk = pieces.slice(i, i + 3).join('');
      sent += chunk;
      req.onText?.(chunk);
      if (this.delayMs) await sleep(this.delayMs);
    }
    return { text, toolCalls: [], usage: this.usage(inputTokens, text), finishReason: 'stop' };
  }

  private usage(inputTokens: number, output: string): CallUsage {
    return { inputTokens, cachedTokens: 0, outputTokens: estimateTokens(output), reasoningTokens: 0, estimated: false };
  }
}
