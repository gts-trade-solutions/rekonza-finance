import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// The built-in stand-in.
//
// Answers when no OpenAI key is configured — in development, in tests, on a
// server that is not live yet, and on the online demo — so the whole assistant
// can be built and exercised without spending anything: the tools run against
// the real books, the answer streams, and the question is charged credits for
// the tokens a real model would have used.
//
// It does not reason. It reads a question for the tools a model would most
// likely have called — and for the names and periods in it ("Apex", "last
// month", "FY 2025-26") — and writes their results up plainly. Every answer
// says that it came from the stand-in, so nobody mistakes it for the real
// thing.
//
// Never used on a live server unless AI_STANDIN=1 says so explicitly.
// ─────────────────────────────────────────────────────────────────────────────

import { estimateTokens } from './pricing';
import { fyStartOf, istDate, monthEnd, previousMonth } from './time';
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

// ── Reading the question ─────────────────────────────────────────────────────

/** Words that end the name in "statement for Apex Motors this year". */
const TRAILING =
  /\s+(?:this|last|in|for|during|since|so far|till|until|up to|upto|today|now|us|please|as of|as on|in total|overall|from (?:april|apr)|with|and|or|between|on|by|at|of the|year|month|quarter|fy)\b.*$/i;
/** Phrases that look like a name but are not one. */
const NOT_A_NAME = /^(?:we|i|you|they|he|she|us|me|them|it|all|each|every|everyone|anyone|customers?|suppliers?|vendors?|clients?|parties|people|the business|our business|the company|money|cash|tax|gst|tds)$/i;

function tidyName(raw: string | undefined): string | null {
  if (!raw) return null;
  let s = raw.replace(/[?.!,;:]+$/g, '').replace(TRAILING, '').trim();
  s = s.replace(/^(?:the|our|my|m\/s\.?|messrs\.?)\s+/i, '').replace(/['’]s$/i, '').trim();
  if (s.length < 2 || s.length > 60 || NOT_A_NAME.test(s)) return null;
  // "payments to be received", "to make", "this week": a phrase, not a party.
  if (/^(?:be|get|make|pay|receive|collect|this|next|coming|customers?|suppliers?|vendors?)\b/i.test(s)) return null;
  return s;
}

/** "closing balance of HDFC Bank today" → "HDFC Bank". */
export function extractAccount(question: string): string | null {
  const m = question.match(
    /(?:balance|ledger)\s+(?:of|for|in|on)\s+(?:the\s+|our\s+|my\s+)?(.+?)(?:\s+(?:as of|as on|on|today|now|this|at|till|until)\b.*)?[?.!\s]*$/i,
  );
  if (!m) return null;
  const s = m[1].replace(/\b(account|a\/c)\b/gi, '').replace(/\s+/g, ' ').trim();
  if (s.length < 2 || /\b(each|all|every)\b/i.test(s)) return null;
  // "balance of Apex Motors" is a customer, not a ledger account: the
  // statement answers that, and the account finder would only say "no match".
  if (/^(?:customer|supplier|vendor)\b/i.test(s)) return null;
  return s.slice(0, 60);
}

/** The customer or supplier a question names, if it names one. */
export function extractParty(question: string): string | null {
  const q = question.trim();
  const patterns = [
    /statement\s+(?:of\s+account\s+)?(?:of|for|from|to|with)\s+(.+)/i,
    /(?:does|did|do|will)\s+(.+?)\s+(?:still\s+)?owe\b/i,
    // "How much does Bosch want from us?" — what we owe them, said the other way round.
    /(?:does|did|do|will|is)\s+(.+?)\s+(?:still\s+)?(?:wants?|asking|ask|claims?|claiming)\s+(?:from|of)\s+us\b/i,
    /\bwe\s+owe\s+(.+)/i,
    /\b(?:have|need)\s+to\s+pay\s+(?!for\b|the\s+gst|gst|tax|tds)(.+)/i,
    /\bdues?\s+(?:to|of)\s+(.+)/i,
    /\bowed\s+(?:to|by)\s+(.+)/i,
    /\b(?:paid|pay|payments?|sent)\s+(?:to|from)\s+(.+)/i,
    /\breceived\s+from\s+(.+)/i,
    /\b(?:invoices?|bills?|quotes?|orders?|follow[- ]?ups?|promises?)\s+(?:for|from|of|to|by|with)\s+(.+)/i,
    /\b(?:customer|supplier|vendor|client)\s+(?:called\s+|named\s+)?([A-Z][^?.!,]*)/,
    /\b(?:for|from|with|to)\s+([A-Z][\w&.'’-]*(?:\s+[A-Z][\w&.'’-]*)*)/,
  ];
  for (const p of patterns) {
    const name = tidyName(q.match(p)?.[1]);
    if (name) return name;
  }
  return null;
}

/** The item a stock question names: "stock of brake pads" → "brake pad". */
export function extractItem(question: string): string | null {
  const q = question.trim();
  const patterns = [
    /\b(?:stock|quantity|qty|units?)\s+(?:of|for|left of)\s+(.+)/i,
    /\bhow\s+(?:many|much)\s+(.+?)\s+(?:do\s+we\s+have|have\s+we\s+got|are\s+(?:left|there|in stock|on hand)|is\s+(?:left|there|in stock)|in\s+stock|on\s+hand|remaining|left)\b/i,
    /^(?:is|are)\s+(?:there\s+any\s+)?(.+?)\s+(?:in stock|available)\b/i,
  ];
  for (const p of patterns) {
    let name = tidyName(q.match(p)?.[1]);
    if (!name || /^(?:stock|inventory|items?|goods|products?|everything)$/i.test(name)) continue;
    // "brake pads" should find "Brake Pad Set".
    name = name.replace(/(\w{3,}?)(?:es|s)$/i, (w, stem: string) => (/(?:ss|us|is)$/i.test(w) ? w : stem));
    return name;
  }
  return null;
}

/** A project a question names: "the Hosur fit-out project". */
export function extractProject(question: string): string | null {
  const m = question.match(/\bproject\s+(?:called\s+|named\s+)?["“]?([^"”?.!,]+)/i) ?? question.match(/\b(?:the\s+)?([A-Z][\w&'’-]*(?:\s+[\w&'’-]+){0,4})\s+project\b/);
  const name = tidyName(m?.[1]);
  return name && !/^(?:status|profit|profitability|wise|list|each|all)$/i.test(name) ? name : null;
}

const MONTH_WORDS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const pad = (n: number) => String(n).padStart(2, '0');
const shift = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

export interface Period {
  from: string;
  to: string;
  /** Set when the period is one whole month: what GST lookups take. */
  month?: string;
}

/** The financial-year quarter a date falls in: its first day. */
function quarterStart(date: string): string {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const qm = m >= 4 ? 4 + Math.floor((m - 4) / 3) * 3 : 1;
  return `${y}-${pad(qm)}-01`;
}

/**
 * The period a question asks about, relative to today in India. Null when it
 * names none, which every lookup reads as the financial year to date.
 */
export function extractPeriod(question: string, today: string): Period | null {
  const q = question.toLowerCase();
  const clampTo = (to: string) => (to > today ? today : to);
  if (/\btoday\b/.test(q) && !/\b(?:balance|position|cash|owe|stock)\b/.test(q)) return { from: today, to: today };
  if (/\byesterday\b/.test(q)) return { from: shift(today, -1), to: shift(today, -1) };
  const lastDays = q.match(/\b(?:last|past)\s+(\d{1,3})\s+days\b/);
  if (lastDays) return { from: shift(today, -Number(lastDays[1])), to: today };
  if (/\b(?:this|current)\s+month\b|\bmonth to date\b|\bmtd\b/.test(q)) return { from: `${today.slice(0, 7)}-01`, to: today, month: today.slice(0, 7) };
  if (/\b(?:last|previous|past)\s+month\b/.test(q)) {
    const m = previousMonth(today);
    return { from: `${m}-01`, to: monthEnd(m), month: m };
  }
  if (/\b(?:this|current)\s+quarter\b|\bqtd\b/.test(q)) return { from: quarterStart(today), to: today };
  if (/\b(?:last|previous)\s+quarter\b/.test(q)) {
    const prevEnd = shift(quarterStart(today), -1);
    return { from: quarterStart(prevEnd), to: prevEnd };
  }
  const fy = q.match(/\bfy\s*'?(\d{4})\s*[-–/]\s*'?(\d{2,4})\b/) ?? q.match(/\b(?:financial|fiscal)\s+year\s+(\d{4})\s*[-–/]\s*(\d{2,4})\b/);
  if (fy) {
    const start = Number(fy[1]);
    return { from: `${start}-04-01`, to: clampTo(`${start + 1}-03-31`) };
  }
  if (/\b(?:last|previous|past)\s+(?:financial\s+|fiscal\s+)?year\b|\b(?:last|previous)\s+fy\b/.test(q)) {
    const start = Number(fyStartOf(today).slice(0, 4)) - 1;
    return { from: `${start}-04-01`, to: `${start + 1}-03-31` };
  }
  // "in September", "for Aug 2026", "September's sales" — whole words only,
  // or "Marina" would be March and "margin" too.
  const month = q.match(/\b(january|february|march|april|may|june|july|august|september|sept|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\.?(?:['’]s)?(?:\s+(\d{4}))?\b/);
  if (month && !(month[1] === 'may' && !month[2] && !/\b(?:in|for|during|of)\s+may\b/.test(q))) {
    const mi = MONTH_WORDS.indexOf(month[1].slice(0, 3)) + 1;
    let year = month[2] ? Number(month[2]) : Number(today.slice(0, 4));
    if (!month[2] && `${year}-${pad(mi)}` > today.slice(0, 7)) year -= 1;
    const key = `${year}-${pad(mi)}`;
    return { from: `${key}-01`, to: clampTo(monthEnd(key)), month: key };
  }
  return null;
}

/** "Today is 31 Oct 2026 (2026-10-31), in India." — the prompt says what today is. */
export function todayFromMessages(messages: ChatMessage[]): string {
  const system = messages.find((m) => m.role === 'system');
  const iso = typeof system?.content === 'string' ? system.content.match(/\((\d{4}-\d{2}-\d{2})\)/)?.[1] : undefined;
  return iso ?? istDate();
}

/** A greeting with nothing else in it. */
export const isGreeting = (q: string): boolean =>
  /^\s*(?:hi+|hello+|hey+|hiya|namaste|namaskar|vanakkam|good\s+(?:morning|afternoon|evening|day))(?:\s+(?:there|team|rekonza|ai|assistant))?[\s!.,]*$/i.test(q);

/** Asking what the assistant can do, rather than asking it something. */
export const isHelp = (q: string): boolean =>
  /\bwhat\s+(?:can|could)\s+you\b|\bwhat\s+do\s+you\s+(?:do|know)\b|\bhow\s+(?:can|do)\s+(?:i|you)\s+(?:use|help)\b|^\s*(?:help|\?)\s*$|\bwho\s+are\s+you\b|\bwhat\s+(?:questions|things)\s+can\s+i\s+ask\b/i.test(q);

const ATTENTION_WORDS = /attention|problems?|issues?|wrong|\bfix\b|alerts?|exceptions?|urgent|important|what\s+should\s+i\s+(?:do|look|check)|anything\s+(?:i|we)\s+should/i;
/** "How are we doing?" — answered with the three figures an owner checks first. */
const OVERVIEW_WORDS = /\bhow\s+(?:are|is)\s+(?:we|things|the\s+business|business|the\s+company)\s+doing\b|\boverview\b|\bsummary\b|\bhealth\b|\bsnapshot\b|\bat\s+a\s+glance\b/i;

/**
 * The tools a model would probably reach for, among those actually offered,
 * with the names and periods the question gives.
 *
 * Empty when the question needs reports this role was not given — the caller
 * says so, rather than answering a different question the role can see.
 */
export function planTools(question: string, offered: Set<string>, today: string = istDate()): Planned[] {
  const q = question.toLowerCase();
  const out: Planned[] = [];
  const add = (name: string, args: Record<string, unknown> = {}) => {
    if (!out.some((p) => p.name === name)) out.push({ name, args: Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined && v !== null)) });
  };

  const period = extractPeriod(question, today);
  const range = period ? { from: period.from, to: period.to } : {};
  const party = extractParty(question);
  const account = extractAccount(question);
  // "Cash" is a payment mode only when said as one: "paid in cash", "by cash".
  const mode = q.match(/\b(upi|neft|rtgs|imps|cheques?|card|netbanking)\b/)?.[1]?.replace(/s$/, '')
    ?? (/\b(?:in|by|via|through)\s+cash\b|\bcash\s+(?:payments?|receipts?|sales)\b/.test(q) ? 'cash' : undefined);
  const salesWord = /\bsales\b(?!\s*(?:orders?|receipts?|tax|reminders?))|\brevenue\b|\bturnover\b|\bsold\b|\bsell(?:ing)?\b/.test(q);
  const invoicesWord = /\binvoices?\b/.test(q) && !/e-?invoic|\birn\b/.test(q);
  const billsWord = /\bbills?\b/.test(q) && !/bills?\s+of\s+entry/.test(q);
  const chaseWords = /follow[- ]?ups?|promis(?:e|ed)\s+to\s+pay|\bpromises?\b|\bchase\b|\bchasing\b|collections?\s+(?:list|status|today)|who\s+(?:should|do|must)\s+(?:i|we)\s+(?:call|chase|remind|follow)/.test(q);
  const docStatus = /overdue/.test(q) ? 'overdue' : /\bpaid\b/.test(q) && !/unpaid/.test(q) ? 'paid' : /draft/.test(q) ? 'draft' : /\ball\b|\bevery\b/.test(q) ? 'any' : 'unpaid';

  // Money still owed, either way: "pending payments", "dues", "who has not
  // paid". Said of payments, these mean what is yet to come in or go out —
  // never the payments already made, which is what a payments search lists.
  const pendingWords = (/\b(?:pending|outstanding|unpaid|due|overdue|open|balance)\s+(?:payments?|amounts?|dues?|money|balances?)\b/.test(q)
    || /\bpayments?\s+(?:are\s+|is\s+|still\s+)?(?:pending|outstanding|due|overdue|to\s+be\s+(?:received|made|paid|collected))\b/.test(q)
    || /\b(?:pending|outstanding)\s+(?:from|to)\b|\bdues\b|\bto\s+be\s+(?:received|collected|paid)\b/.test(q)
    || /\bwho\s+(?:has|have)\s+(?:not|n't)\s+(?:yet\s+)?paid\b|\btotal\s+(?:pending|outstanding|dues?)\b|\b(?:money|amount)\s+(?:is\s+|still\s+)?pending\b/.test(q)
    || /\bpayments?\s+(?:do|should|must)\s+(?:we|i)\s+(?:have\s+to\s+|need\s+to\s+)?(?:make|pay|receive|collect)\b|\bpayments?\s+(?:we|i)\s+(?:have|need)\s+to\s+(?:make|pay|receive|collect)\b/.test(q))
    && !/\breturns?\b|\bgst\b|\btds\b|\btax\b/.test(q);
  if (pendingWords) {
    const side = /\bcustomers?\b|\breceiv|\bcollect|\bdebtors?\b|\bwho\s+(?:has|have)\s+(?:not|n't)\s+(?:yet\s+)?paid\b|\b(?:pending|outstanding|due|payments?)\s+from\b/.test(q) ? 'receive'
      : /\bsuppliers?\b|\bvendors?\b|\bcreditors?\b|\bto\s+be\s+paid\b|\b(?:make|pay)\b|\b(?:pending|outstanding|due|payments?)\s+to\b/.test(q) ? 'pay'
      : undefined;
    const due = /overdue|past\s+(?:the\s+)?due|\blate\b/.test(q) ? 'overdue'
      : /this\s+week|next\s+(?:7|seven)\s+days|coming\s+week|within\s+(?:a|one)\s+week/.test(q) ? 'next_7_days'
      : /this\s+month|month[- ]end|end\s+of\s+(?:the\s+)?month/.test(q) ? 'this_month'
      : undefined;
    add('get_pending_payments', { side, party: party ?? undefined, due });
  }

  if (account) add('get_account_balance', { account, as_of: period?.to });

  // Documents, when the question is about them rather than about a balance.
  if (invoicesWord && !/\bsales\b|\btotal\b/.test(q)) add('search_invoices', { status: docStatus, customer: party ?? undefined, limit: 8, ...range });
  if (billsWord && !/\bmsme\b/.test(q)) add('search_bills', { status: docStatus, vendor: party ?? undefined, limit: 8, ...range });

  // Customers and suppliers by name.
  // "GST payable" and "TDS payable" are tax owed to the government, not to suppliers.
  const taxWords = /\b(?:gst|igst|cgst|sgst|tds|tcs|tax)\b/.test(q);
  const paysWords = /\bwe\s+owe\b|\bcreditors?\b|\bowed\s+to\b|\bdue\s+to\s+(?:suppliers|vendors)\b|\bwants?\s+from\s+us\b|\b(?:asking|claims?|claiming)\s+(?:from|of)\s+us\b|\bdues?\s+(?:to|of)\b/.test(q)
    || (/\bpayables?\b/.test(q) && !taxWords)
    || (/\b(?:have|need)\s+to\s+pay\b/.test(q) && !taxWords);
  if (/\bstatement\b/.test(q) && !/bank\s+statement|statement\s+of\s+(?:profit|cash)|cash\s*flow\s+statement|financial\s+statements?/.test(q) && party) {
    add('get_party_statement', { party, ...range });
  }
  if (!pendingWords && (paysWords || (/\bsuppliers?\b|\bvendors?\b|\bmsme\b/.test(q) && /\bowe|due|unpaid|outstanding|overdue|pending|msme\b/.test(q)))) {
    add('get_payables', { vendor: paysWords ? party ?? undefined : undefined });
  }
  if (/overdue|receivables?|owe\s+us|owes\s+us|debtors?|who\s+owes|outstanding\s+(?:from|amount)|due\s+from|(?:does|do|did)\s+.+\s+owe\b/.test(q)
    && !paysWords && !pendingWords && !invoicesWord && !billsWord && !/\bsuppliers?\b|\bvendors?\b|\bmsme\b/.test(q) && !chaseWords) {
    add('get_receivables', { customer: party ?? undefined });
  }
  if (chaseWords) add('get_collections', { customer: party ?? undefined });

  // Money.
  if (/\bcash\b|\bbank\b|\bbalances?\b.*\baccounts?\b|\bliquidity\b/.test(q) && !account && !/cash\s*flow|reconcil|bank\s+statement|unmatched/.test(q) && !mode) {
    add('get_cash_position');
  }
  if (/\bprofit|\bloss\b|p&l|p & l|earning|making money|net income|bottom line/.test(q)) add('get_profit_and_loss', range);
  if (/\bgst\b|gstr|input (?:tax )?credit|\bitc\b|tax (?:liability|payable)/.test(q) && !/\bgstin\b/.test(q)) add('get_gst_summary', { month: period?.month });
  if (/top\s+customers?|best\s+customers?|biggest\s+customers?|sales\s+by|best[- ]selling|top[- ]selling|top\s+(?:items|products)|most\s+sold/.test(q) || salesWord) {
    const group = /item|product|selling|sold|goods/.test(q) ? 'item'
      : /salesperson|sales\s*person|sales\s+rep|executive/.test(q) ? 'salesperson'
      : /trend|month(?:ly)?[- ]wise|by\s+month|each\s+month|every\s+month|per\s+month|month\s+on\s+month/.test(q) ? 'month'
      : 'customer';
    add('get_sales_summary', { group_by: group, limit: 5, ...range });
  }
  if (/expense|\bspend|\bspent\b|\bcosts?\b|overheads?/.test(q) && !/cost\s+price|fixed\s+assets?|cost\s+to\s+company|\bctc\b|payroll|salar(?:y|ies)|\bwages\b/.test(q)) add('get_expense_summary', { limit: 5, ...range });
  if (/ratio|margin|\bdso\b|days\s+sales|working\s+capital|liquidity/.test(q)) add('get_business_ratios', range);
  if (/cash\s*flow/.test(q)) add('get_cash_flow', range);
  if (/trial\s+balance/.test(q)) add('get_trial_balance', { as_of: period?.to });
  if (/balance\s+sheet/.test(q)) add('get_balance_sheet', { as_of: period?.to });
  if (/chart\s+of\s+accounts|list\s+(?:of\s+)?(?:all\s+)?(?:our\s+)?accounts|all\s+(?:the\s+)?accounts|which\s+accounts/.test(q)) add('list_accounts');

  // Everything beyond the ledger.
  if (/\bstock\b|inventory|\bon\s+hand\b|(?<!cash\s)\bin\s+hand\b|reorder|out\s+of\s+stock|running\s+low|low\s+stock|slow[- ]moving|dead\s+stock|how\s+many\s+.+\s+(?:left|do\s+we\s+have|in\s+stock|remaining)/.test(q)
    && !/stock\s+(?:market|exchange|shares?)/.test(q) && !account) {
    const item = extractItem(question);
    const ageing = /ageing|aging|\bold\s+stock|slow[- ]moving|dead\s+stock|how\s+long/.test(q);
    add('get_stock', item ? { item } : ageing ? { view: 'ageing' } : {});
  }
  if (/payments?\b|\breceipts?\b|\bcollected\b|\breceived\b|\bpaid\s+(?:to|out)|\bpayouts?\b|how\s+much\s+(?:did|have)\s+we\s+(?:pay|paid|receive|received|collect)/.test(q)
    && !/payment\s+(?:reminders?|terms|links?)|\bpayables?\b|we\s+owe|\bpaid\s+(?:invoices?|bills?)\b/.test(q) && !chaseWords && !invoicesWord && !billsWord && !pendingWords) {
    const direction = /\breceived?\b|\bcollect(?:ed)?\b|\breceipts?\b|from\s+customers?|came\s+in/.test(q) ? 'received'
      : /\bmade\b|\bpaid\b|\bpay\s+out|\bpayouts?\b|to\s+(?:suppliers?|vendors?)|went\s+out/.test(q) ? 'made'
      : undefined;
    add('search_payments', { direction, party: party ?? undefined, mode, ...range });
  }
  if (/\btds\b|\b194[a-z]{0,2}\b|withholding|\b26q\b|\b24q\b|\b27q\b|\btan\b/.test(q)) add('get_tds_summary');
  if (/due\s+dates?|deadlines?|compliance|\bfil(?:e|ed|ing)\b|what(?:'s|\s+is|\s+are)\s+due(?!\s+from)|\breturns?\b[^?]*\b(?:due|pending|overdue|filed)\b|\b(?:due|pending|overdue)\b[^?]*\breturns?\b|\broc\b|\baoc-?4\b|\bmgt-?7\b|advance\s+tax|\bitr\b|income[- ]tax\s+return|msme-?1/.test(q)) {
    add('get_compliance_calendar');
  }
  if (/reconcil|unmatched|bank\s+statement|\bbrs\b|uncleared/.test(q)) add('get_bank_reconciliation');
  if (/\bprojects?\b|timesheets?|hours\s+(?:logged|billed|worked)|unbilled\s+(?:time|hours)|billable\s+hours/.test(q)) {
    add('get_projects', { project: extractProject(question) ?? undefined, status: /completed|finished|closed/.test(q) ? 'completed' : /\ball\b|every/.test(q) ? 'all' : undefined });
  }
  if (/payroll|salar(?:y|ies)|\bwages\b|\bpf\b|\bepf\b|\besi\b|\bctc\b|cost\s+to\s+company|professional\s+tax|payslips?|employees?\s+(?:cost|pay)/.test(q)) add('get_payroll_summary');
  if (/fixed\s+assets?|asset\s+register|depreciation|\bwdv\b|written\s+down|capital\s+goods/.test(q)) add('get_fixed_assets');
  if (/\bbudget/.test(q)) add('get_budget_vs_actual');
  if (/\bquotes?\b|quotations?|estimates?|sales\s+orders?|purchase\s+orders?|\bpos?\b|pending\s+orders?|open\s+orders?|order\s+book|backlog|pipeline/.test(q)) {
    const kind = /purchase\s+orders?|\bpos?\b/.test(q) ? 'purchase_orders' : /sales\s+orders?/.test(q) ? 'sales_orders' : /quotes?|quotations?|estimates?/.test(q) ? 'quotes' : undefined;
    add('get_open_orders', { kind });
  }

  if (!out.length && OVERVIEW_WORDS.test(q)) {
    add('get_profit_and_loss', range);
    add('get_cash_position');
    add('get_receivables');
  }
  if (!out.length && ATTENTION_WORDS.test(q)) add('get_attention_items');

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

const listOf = (xs: string[], max = 3) => (xs.length <= max ? xs.join(', ') : `${xs.slice(0, max).join(', ')} and ${xs.length - max} more`);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function candidatesLine(d: any, what: string): string {
  return d.candidates?.length
    ? `More than one ${what} could match "${d.query}": ${d.candidates.map((c: any) => c.name ?? c).join(', ')}. Which one did you mean?`
    : `I could not find a ${what} matching "${d.query}".`;
}

/** What a lookup's name argument refers to, for "I could not find a …". */
const NOUN: Record<string, string> = {
  get_receivables: 'customer', get_collections: 'customer', search_invoices: 'customer',
  get_payables: 'supplier', search_bills: 'supplier',
  search_payments: 'customer or supplier', get_party_statement: 'customer or supplier',
  get_stock: 'stocked item', get_projects: 'project',
};

function describe(name: string, d: any): string {
  if (d?.error) return `I could not run that lookup: ${d.error}`;
  if (d?.found === false && d.query !== undefined && name !== 'get_account_balance') return candidatesLine(d, NOUN[name] ?? 'match');
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
    case 'list_accounts':
      return `There are ${plural(d.count, 'account')} in the chart of accounts${d.truncated ? '; the first 60 are listed in the report' : ''}.`;
    case 'get_cash_position':
      return (
        `You have **${d.total_cash_and_bank}** across your cash and bank accounts today.\n\n` +
        table(['Account', 'Balance'], (d.accounts ?? []).map((a: any) => [a.name, a.balance]))
      );
    case 'get_receivables': {
      // A named customer: their figures, not the whole book's.
      if (d.open_invoices !== undefined) {
        const c = d.customers?.[0];
        if (!c) return d.note ?? 'That customer owes nothing at the moment.';
        const oldest = d.open_invoices[0];
        return `**${c.name}** owes **${c.owes}**, of which **${c.overdue}** is overdue.` +
          (oldest ? ` There ${d.open_invoices.length === 1 ? 'is one open invoice' : `are ${d.open_invoices.length} open invoices`}; the oldest, ${oldest.number}, was due ${oldest.due}${oldest.days_overdue ? ` (${oldest.days_overdue} days ago)` : ''}.` : '') +
          (d.customers.length > 1 ? ` (${d.customers.length - 1} other customer${d.customers.length > 2 ? 's' : ''} also match that name.)` : '');
      }
      return (
        `Customers owe **${d.owed_by_customers}**, of which **${d.overdue}** is past its due date.` +
        (d.advances_held_for_customers
          ? ` You also hold ${d.advances_held_for_customers} paid in advance, so the net receivable is ${d.net_receivable_as_in_the_ageing_report}.`
          : '') +
        (d.customers?.length ? ` The largest balances are ${listOf(d.customers.slice(0, 3).map((c: any) => `${c.name} (${c.owes})`))}.` : '') +
        '\n\n' +
        table(['Customer', 'Owes', 'Overdue'], (d.customers ?? []).slice(0, 5).map((c: any) => [c.name, c.owes, c.overdue]))
      );
    }
    case 'get_pending_payments': {
      const r = d.to_receive_from_customers;
      const y = d.to_pay_to_suppliers;
      const when = d.filter?.due === 'overdue' ? ' overdue' : d.filter?.due === 'next_7_days' ? ' due in the next 7 days' : d.filter?.due === 'this_month' ? ' due by the end of this month' : '';
      const who = d.filter?.party ? ` for ${d.filter.party}` : '';
      const line = (x: any, kind: 'receive' | 'pay') => {
        const late = x.already_overdue
          ? ` Besides that, **${x.already_overdue}** is already overdue on ${plural(x.already_overdue_documents, kind === 'receive' ? 'invoice' : 'bill')}.`
          : '';
        if (!x.documents) return (kind === 'receive' ? `- **To receive:** nothing${when} from customers${who}.` : `- **To pay:** nothing${when} to suppliers${who}.`) + late;
        const docs = kind === 'receive' ? x.invoices : x.bills;
        const first = docs?.find((i: any) => i.days_overdue);
        const oldest = first ? ` The oldest is ${kind === 'receive' ? first.invoice : first.bill} (${kind === 'receive' ? first.customer : first.supplier}), ${plural(first.days_overdue, 'day')} overdue.` : '';
        const soon = x.due_next_7_days && x.due_next_7_days !== '₹0.00' ? ` ${x.due_next_7_days} falls due in the next 7 days.` : '';
        const msme = kind === 'pay' && x.msme_bills ? ` ${plural(x.msme_bills, 'is an MSME bill', 'are MSME bills')} (45-day rule).` : '';
        // Balances on the ledger but on no invoice or bill, so the figures tie to the ageing report.
        const partyKey = kind === 'receive' ? 'customer' : 'supplier';
        const off = (x.ledger?.not_on_any_document ?? []) as any[];
        const ahead = (x.ledger?.paid_in_advance ?? []) as any[];
        const ledger = x.ledger
          ? `${off.length ? ` Also ${listOf(off.map((o) => `${o.amount} ${kind === 'receive' ? 'owed by' : 'owed to'} ${o[partyKey]}`))} with no ${kind === 'receive' ? 'invoice' : 'bill'} behind it (an opening or journal balance).` : ''}` +
            `${ahead.length ? ` ${listOf(ahead.map((o) => `${o[partyKey]} ${kind === 'receive' ? 'has paid' : 'was paid'} ${o.amount} in advance`))}.` : ''}` +
            ` The ${kind === 'receive' ? 'receivables' : 'payables'} ageing shows **${x.ledger.total_as_in_the_ageing_report}** in all.`
          : '';
        return kind === 'receive'
          ? `- **To receive: ${x.total}** from customers on ${plural(x.documents, 'invoice')}; **${x.overdue}** of it is overdue (${plural(x.overdue_documents, 'invoice')}).${soon}${oldest}${ledger}${late}`
          : `- **To pay: ${x.total}** to suppliers on ${plural(x.documents, 'bill')}; **${x.overdue}** of it is overdue (${plural(x.overdue_documents, 'bill')}).${soon}${msme}${oldest}${ledger}${late}`;
      };
      const parts = [
        `**Pending payments${who}${when}** as at ${d.as_of}:`,
        ...(r ? [line(r, 'receive')] : []),
        ...(y ? [line(y, 'pay')] : []),
      ];
      if (r && y && d.net_position) parts.push(`${String(d.net_position).startsWith('-') ? `You have **${String(d.net_position).slice(1)}** more to pay than to receive.` : `You have **${d.net_position}** more to receive than to pay.`}`);
      const rows = [
        ...((r?.invoices ?? []) as any[]).map((i) => ['To receive', i.invoice, i.customer, i.due, i.pending]),
        ...((y?.bills ?? []) as any[]).map((b) => ['To pay', b.bill, b.supplier, b.due, b.pending]),
      ].sort((a, b) => String(a[3]).localeCompare(String(b[3]))).slice(0, 8);
      return parts.join('\n') + (rows.length ? '\n\n' + table(['', 'Document', 'Party', 'Due', 'Pending'], rows) : '');
    }
    case 'get_payables': {
      const msme = d.msme_bills_unpaid ?? [];
      const msmeLine = msme.length
        ? ` ${plural(msme.length, 'MSME bill is', 'MSME bills are')} unpaid — under section 43B(h) they must be paid within 45 days: ${listOf(msme.map((b: any) => `${b.supplier} ${b.balance} (${b.status})`))}.`
        : '';
      if (d.open_bills !== undefined) {
        const s = d.suppliers?.[0];
        if (!s) return d.note ?? 'Nothing is owed to that supplier at the moment.';
        return `You owe **${s.name}** **${s.owed}**, of which **${s.overdue}** is overdue, across ${plural(d.open_bills.length, 'open bill')}.`;
      }
      return (
        `You owe suppliers **${d.owed_to_suppliers}**, of which **${d.overdue}** is overdue.` +
        msmeLine +
        '\n\n' +
        table(['Supplier', 'Owed', 'Overdue'], (d.suppliers ?? []).slice(0, 5).map((s: any) => [s.name, s.owed, s.overdue]))
      );
    }
    case 'get_profit_and_loss': {
      const net = String(d.net_profit).replace(/^-/, '');
      const before = d.previous_period;
      return (
        `From ${d.period.from} to ${d.period.to}, income was **${d.income}**; after the cost of goods sold (${d.cost_of_goods_sold}) the gross profit was ${d.gross_profit}, and the net ${d.result} was **${net}**` +
        (typeof d.net_margin === 'string' && d.net_margin.endsWith('%') ? `, a net margin of ${d.net_margin}.` : '.') +
        // Books that began this year have nothing before it to compare with.
        (before && before.income !== '₹0.00' ? ` In the ${before.from} to ${before.to} period before it, net profit was ${before.net_profit} on income of ${before.income}.` : '')
      );
    }
    case 'get_gst_summary':
      return (
        `For ${d.month}, the GST payable in cash after input tax credit is **${d.payable_in_cash}**. GSTR-3B is due by ${d.due_dates?.gstr3b}.\n\n` +
        table(['Head', 'Liability', 'From credit', 'In cash'], (d.set_off ?? []).map((s: any) => [s.head, s.liability, s.paid_from_credit, s.paid_in_cash]))
      );
    case 'get_sales_summary': {
      const top = (d.rows ?? [])[0];
      return (
        `Sales from ${d.period.from} to ${d.period.to} were **${d.total_invoiced}** including tax (${d.total_before_tax} before tax).` +
        (top && d.group_by !== 'month' ? ` The largest ${d.group_by} was ${top[d.group_by]}, at ${top.before_tax}${top.share ? ` (${top.share})` : ''}.` : '') +
        '\n\n' +
        table([d.group_by, 'Before tax', 'Share'], (d.rows ?? []).map((r: any) => [r[d.group_by], r.before_tax, r.share]))
      );
    }
    case 'get_expense_summary': {
      const top = (d.categories ?? [])[0];
      return (
        `Expenses from ${d.period.from} to ${d.period.to} came to **${d.total}**.` +
        (top ? ` The largest was ${top.name}, at ${top.amount}${top.share ? ` (${top.share})` : ''}.` : '') +
        '\n\n' +
        table(['Account', 'Amount', 'Share'], (d.categories ?? []).map((c: any) => [c.name, c.amount, c.share]))
      );
    }
    case 'get_business_ratios':
      return `${(d.ratios ?? []).filter((r: any) => r.healthy).length} of ${(d.ratios ?? []).length} ratios look healthy between ${d.period?.from} and ${d.period?.to}: ${(d.ratios ?? []).map((r: any) => `${r.name} ${r.value}`).join(', ')}.`;
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
        `${plural(d.matching, 'invoice')} match, worth ${d.total_value}, with **${d.unpaid}** unpaid.\n\n` +
        table(['Invoice', 'Customer', 'Due', 'Balance'], (d.invoices ?? []).map((i: any) => [i.number, i.customer, i.due, i.balance]))
      );
    case 'search_bills':
      return (
        `${plural(d.matching, 'bill')} match, worth ${d.total_value}, with **${d.unpaid}** unpaid.\n\n` +
        table(['Bill', 'Supplier', 'Due', 'Balance'], (d.bills ?? []).map((b: any) => [b.bill, b.supplier, b.due, b.balance]))
      );
    case 'get_attention_items':
      return d.count
        ? `${plural(d.count, 'thing needs', 'things need')} attention:\n\n${d.items.slice(0, 8).map((i: any) => `- **${i.title}** — ${i.detail}`).join('\n')}`
        : 'Nothing in the books needs attention right now.';

    case 'get_stock':
      if (d.found === false) return candidatesLine(d, 'stocked item');
      if (d.item) {
        return `**${d.item}**: ${d.on_hand} on hand on ${d.as_of}${d.value ? `, worth ${d.value} at an average cost of ${d.average_cost}` : ''}.` +
          (d.minimum_level !== undefined ? ` That is ${d.below_minimum ? '**below**' : 'above'} its minimum level of ${d.minimum_level}.` : '') +
          ` This financial year ${d.this_year.came_in} came in and ${d.this_year.went_out} went out.`;
      }
      if (d.by_age) {
        const old = Object.entries(d.by_age).slice(-2).map(([band, v]) => `${v} in ${band}`);
        return `Stock worth **${d.stock_value}** is on hand on ${d.as_of}; ${old.join(' and ')}. The oldest lines are ${listOf((d.oldest_items ?? []).map((i: any) => `${i.item} (${i.oldest_days} days)`))}.`;
      }
      return (
        `${d.stock_value ? `Stock on hand is worth **${d.stock_value}** at weighted average cost, across` : 'There are'} ${plural(d.items_in_stock, 'item')} in stock on ${d.as_of}.` +
        (d.below_minimum_level?.length ? ` ${plural(d.below_minimum_level.length, 'item is', 'items are')} below the minimum level: ${listOf(d.below_minimum_level.map((s: any) => `${s.item} (${s.on_hand})`))}.` : ' Nothing is below its minimum level.') +
        (d.negative_stock?.length ? ` ${plural(d.negative_stock.length, 'item shows', 'items show')} negative stock.` : '')
      );
    case 'get_party_statement':
      if (d.found === false) return candidatesLine(d, 'customer or supplier');
      return `**${d.party}** (${d.side}), ${d.period.from} to ${d.period.to}: opening balance ${d.opening_balance}, ${d.side === 'customer' ? `invoiced ${d.invoiced_and_charged}, received ${d.received_and_credited}` : `billed ${d.billed}, paid ${d.paid_and_credited}`}, closing balance **${d.closing_balance}**. ${d.meaning} The statement has ${plural(d.entries_in_period, 'entry', 'entries')} in the period.`;
    case 'search_payments':
      return d.payments
        ? `${plural(d.payments, 'payment')} ${d.direction === 'received' ? 'received' : 'made'}${d.party_filter ? ` (${d.party_filter})` : ''} from ${d.period.from} to ${d.period.to}, totalling **${d.total}**: ${Object.entries(d.by_mode ?? {}).map(([m, v]) => `${m} ${v}`).join(', ')}.`
        : `No payments ${d.direction === 'received' ? 'were received' : 'were made'} that match, between ${d.period.from} and ${d.period.to}.`;
    case 'get_tds_summary':
      return `For ${d.quarter}, TDS deducted is **${d.tds_deducted}** and deposited **${d.tds_deposited}**, leaving **${d.still_to_deposit}** to deposit. The return is due by ${d.return_due_date}.` +
        (d.earlier_months_not_deposited?.length
          ? ` Earlier this year, **${d.earlier_not_deposited_total}** is still not deposited: ${listOf(d.earlier_months_not_deposited.map((m: any) => `${m.month} (${m.short}, due ${m.due_by})`))}; interest runs at 1.5% a month until it is.`
          : '') +
        (d.by_section?.length ? ` By section: ${d.by_section.map((s: any) => `${s.section} ${s.tds}`).join(', ')}.` : '') +
        (d.problems_before_filing?.length ? ` Before filing: ${d.problems_before_filing[0]}` : '');
    case 'get_compliance_calendar': {
      const items = d.items ?? [];
      const overdue = items.filter((i: any) => i.status === 'overdue');
      const soon = items.filter((i: any) => i.status === 'due soon');
      return (overdue.length ? `**${plural(overdue.length, 'filing is', 'filings are')} overdue**: ${listOf(overdue.map((i: any) => `${i.what} for ${i.for} (due ${i.due})`), 4)}. ` : 'Nothing is overdue. ') +
        (soon.length ? `Due within a week: ${listOf(soon.map((i: any) => `${i.what} for ${i.for} by ${i.due}`), 4)}.` : 'Nothing falls due in the next week.');
    }
    case 'get_bank_reconciliation':
      return d.unmatched_lines
        ? `**${plural(d.unmatched_lines, 'statement line')}** ${d.unmatched_lines === 1 ? 'is' : 'are'} not yet matched to the books: ${listOf((d.accounts ?? []).filter((a: any) => a.unmatched_lines).map((a: any) => `${a.account} ${a.unmatched_lines}`))}.`
        : `Every imported statement line is matched. Statements are imported to ${listOf((d.accounts ?? []).map((a: any) => `${a.statement_imported_to} for ${a.account}`), 2)}.`;
    case 'get_projects':
      if (d.found === false) return d.hint;
      return `${plural(d.projects.length, 'project')}: ${listOf(d.projects.map((p: any) => `${p.project} — ${p.hours_logged} h logged, ${p.hours_not_billed} h not billed, ${p.invoiced_before_tax} invoiced${p.profit ? `, profit ${p.profit}` : ''}`), 4)}.`;
    case 'get_payroll_summary':
      if (!d.runs?.length) return d.note ?? 'No payroll has been run yet.';
      return d.latest_run
        ? `The ${d.latest_run.month} payroll (${d.latest_run.status}) paid ${plural(d.latest_run.employees, 'employee')}: gross **${d.latest_run.gross}**, net **${d.latest_run.net_pay}**, with ${d.latest_run.withheld_from_pay.total} withheld for PF, ESI, PT and TDS and ${d.latest_run.employer_contributions.total} of employer contributions. Cost to company was ${d.latest_run.cost_to_company}.`
        : `${plural(d.runs.length, 'payroll run')} on record.`;
    case 'get_fixed_assets':
      if (!d.assets) return d.note;
      return `${plural(d.assets, 'asset')} on the register on ${d.as_of}: cost **${d.cost}**, depreciation to date ${d.depreciation_to_date}, book value **${d.book_value}**.` +
        (d.needs_attention?.length ? ` Needs attention: ${listOf(d.needs_attention, 2)}.` : '');
    case 'get_budget_vs_actual': {
      if (!d.accounts) return d.note;
      const ahead = d.accounts.filter((a: any) => a.pace !== 'on track');
      return `For FY ${d.fy}, ${d.total_actual} of the ${d.total_budget} budget is used with ${d.share_of_year_gone} of the year gone.` +
        (ahead.length ? ` Off pace: ${listOf(ahead.map((a: any) => `${a.account} (${a.used} used, ${a.pace})`))}.` : ' Every account is on track.');
    }
    case 'get_open_orders': {
      const parts: string[] = [];
      if (d.quotes) parts.push(`${plural(d.quotes.open, 'open quote')} worth ${d.quotes.value}${d.quotes.sent_but_past_validity ? ` (and ${d.quotes.sent_but_past_validity} sent but past validity)` : ''}`);
      if (d.sales_orders) parts.push(`${plural(d.sales_orders.open, 'pending sales order')} worth ${d.sales_orders.open_value}${d.sales_orders.late ? `, ${d.sales_orders.late} late` : ''}`);
      if (d.purchase_orders) parts.push(`${plural(d.purchase_orders.open, 'pending purchase order')} worth ${d.purchase_orders.open_value}${d.purchase_orders.late ? `, ${d.purchase_orders.late} late` : ''}`);
      return `On ${d.as_of}: ${parts.join('; ')}.`;
    }
    case 'get_collections':
      return d.customers_overdue
        ? `**${plural(d.customers_overdue, 'customer')}** ${d.customers_overdue === 1 ? 'is' : 'are'} overdue, for **${d.overdue}** in all; ${d.due_a_chase_today} ${d.due_a_chase_today === 1 ? 'is' : 'are'} due a follow-up today.` +
          (d.broken_promises ? ` ${plural(d.broken_promises, 'promise')} to pay ${d.broken_promises === 1 ? 'was' : 'were'} broken.` : '') +
          ` Start with ${listOf(d.customers.slice(0, 3).map((c: any) => `${c.customer} (${c.overdue}, ${c.oldest_days_overdue} days)`))}.`
        : 'No customer is overdue.';
    default:
      return 'Here is what that report shows.';
  }
}

const FOLLOWUPS: Record<string, string[]> = {
  get_account_balance: ['What were the largest entries in this account this month?', 'How does this compare with last month?'],
  get_cash_position: ['Can we cover what we owe suppliers this month?', 'Which bank lines are still unreconciled?'],
  get_receivables: ['Who should we chase for payment today?', 'How long do customers take to pay us on average?'],
  get_payables: ['Which MSME bills must we pay this week?', 'What is our cash position today?'],
  get_profit_and_loss: ['What are our biggest expenses this year?', 'What is our net margin?'],
  get_gst_summary: ['What returns are due this month?', 'How much TDS do we have to deposit?'],
  get_sales_summary: ['Which items sell best?', 'Who owes us the most?'],
  get_expense_summary: ['How are we doing against the budget?', 'What is our profit this year?'],
  get_stock: ['Which stock has been on hand the longest?', 'Which items are below their minimum level?'],
  get_party_statement: ['Which of their invoices are overdue?', 'What payments have we received this month?'],
  search_payments: ['Who still owes us money?', 'What do we owe suppliers?'],
  get_tds_summary: ['What returns are due this month?', 'Which bills had TDS deducted?'],
  get_compliance_calendar: ['How much GST do we pay this month?', 'How much TDS is still to deposit?'],
  get_bank_reconciliation: ['What is our cash position today?', 'What payments did we receive this month?'],
  get_projects: ['Which projects have unbilled hours?', 'What is our profit this year?'],
  get_payroll_summary: ['What returns are due this month?', 'What are our biggest expenses?'],
  get_fixed_assets: ['What does the balance sheet look like?', 'What is our profit this year?'],
  get_budget_vs_actual: ['What are our biggest expenses this year?', 'What is our profit this year?'],
  get_open_orders: ['Which items are below their minimum level?', 'What were our sales this month?'],
  get_collections: ['Which invoices are overdue?', 'What payments did we receive this month?'],
  get_pending_payments: ['Who should we chase for payment today?', 'Which MSME bills must we pay this week?', 'What is our cash position today?'],
  get_attention_items: ['What returns are due this month?', 'Who owes us the most?', 'What is our cash position today?'],
  get_business_ratios: ['What is our profit this year?', 'Who owes us the most?'],
  get_cash_flow: ['What is our cash position today?', 'What do we owe suppliers?'],
  get_trial_balance: ['Show me the balance sheet', 'What is our profit this year?'],
  get_balance_sheet: ['What is our profit this year?', 'What is our cash position today?'],
  search_invoices: ['Who should we chase for payment today?', 'Which customers owe us the most?'],
  search_bills: ['Which MSME bills must we pay this week?', 'What is our cash position today?'],
  list_accounts: ['What is the closing balance of our main bank account?', 'Does the trial balance tally?'],
};

/** What this role can ask about, in words, from the tools it was given. */
const AREAS: [tool: string, words: string, example: string][] = [
  ['get_cash_position', 'cash and bank balances', 'How much cash do we have today?'],
  ['get_profit_and_loss', 'profit and loss', 'What is our profit this financial year?'],
  ['get_receivables', 'what customers owe', 'Which customers are overdue?'],
  ['get_payables', 'what you owe suppliers', 'What do we owe suppliers?'],
  ['get_sales_summary', 'sales', 'Who are our top customers this year?'],
  ['get_expense_summary', 'expenses', 'What were our biggest expenses last month?'],
  ['get_gst_summary', 'GST', 'How much GST do we pay for last month?'],
  ['get_stock', 'stock', 'Which items are running low?'],
  ['get_party_statement', 'customer and supplier statements', 'Show me the statement for a customer.'],
  ['search_payments', 'payments received and made', 'What payments did we receive this month?'],
  ['get_tds_summary', 'TDS', 'How much TDS is still to deposit?'],
  ['get_compliance_calendar', 'due dates for returns', 'What returns are due this month?'],
  ['get_bank_reconciliation', 'bank reconciliation', 'Are our bank accounts reconciled?'],
  ['get_collections', 'collections', 'Who should we chase for payment today?'],
  ['get_pending_payments', 'pending payments, to receive and to pay', 'What all are the pending payments?'],
  ['get_open_orders', 'quotes and orders', 'Which sales orders are pending?'],
  ['get_budget_vs_actual', 'budgets', 'How are we doing against the budget?'],
  ['get_projects', 'projects', 'Which projects have unbilled hours?'],
  ['get_payroll_summary', 'payroll', 'What did last month\'s payroll cost?'],
  ['get_fixed_assets', 'fixed assets', 'What is the book value of our fixed assets?'],
];

function capabilities(offered: Set<string>): { text: string; examples: string[] } {
  // Statements and payments reach suppliers only for a role that sees them.
  const suppliers = offered.has('get_payables');
  const customers = offered.has('get_receivables');
  const mine = AREAS.filter(([t]) => offered.has(t)).map(([t, w, e]): [string, string, string] =>
    t === 'get_party_statement' ? [t, suppliers && customers ? w : suppliers ? 'supplier statements' : 'customer statements', e]
      : t === 'search_payments' ? [t, suppliers && customers ? w : suppliers ? 'payments made' : 'payments received', e]
        : [t, w, e]);
  if (!mine.length) return { text: 'Your role does not include any of the reports I read from.', examples: [] };
  return {
    text: `I can answer questions about ${listOf(mine.map(([, w]) => w), mine.length)} — each from the same reports the app shows.`,
    examples: mine.slice(0, 3).map(([, , e]) => e),
  };
}

const followupBlock = (questions: string[]) =>
  questions.length ? `\n\n\`\`\`followups\n${questions.map((q) => `- ${q}`).join('\n')}\n\`\`\`` : '';

/** A write-up without its table: the detailed report under the answer shows the rows. */
function summaryOnly(text: string): string {
  return text
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('|'))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const STANDIN_NOTE = '_Answered by the built-in stand-in: the figures are the reports\' own, but it does not reason about them. Connect an OpenAI key for full answers._';

function writeUp(question: string, results: { name: string; data: any }[], offered: Set<string>): string {
  const body = results.map((r) => summaryOnly(describe(r.name, r.data))).join('\n\n');
  // A question the stand-in could not place was answered with what needs
  // attention; it says so, and what it can be asked instead.
  const onlyAttention = results.length === 1 && results[0].name === 'get_attention_items';
  let lead = '';
  if (results.length > 1 && OVERVIEW_WORDS.test(question)) lead = 'Here is where the business stands.\n\n';
  if (onlyAttention && isGreeting(question)) lead = 'Hello! Here is what stands out in the books today.\n\n';
  // Profit is the business's, not split by customer or supplier: said, rather
  // than leaving the whole company's figure to pass for one customer's.
  const named = extractParty(question);
  if (named && results.some((r) => r.name === 'get_profit_and_loss') && /\bprofit|\bmargin|\bloss\b/i.test(question)) {
    lead = `Profit is worked out for the business as a whole, not for ${named} alone, so these are the whole business's figures.\n\n`;
  }
  else if (onlyAttention && !ATTENTION_WORDS.test(question)) {
    lead = `I could not match that question to a report, so here is what needs attention instead. ${capabilities(offered).text}\n\n`;
  }
  const questions = [...new Set(results.flatMap((r) => FOLLOWUPS[r.name] ?? []))].slice(0, 3);
  return `${lead}${body}\n\n${STANDIN_NOTE}${followupBlock(questions)}`;
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
    const question = lastUser?.content ?? '';
    const userIndex = lastUser ? req.messages.lastIndexOf(lastUser) : -1;
    const toolResults = req.messages
      .slice(userIndex + 1)
      .filter((m): m is Extract<ChatMessage, { role: 'tool' }> => m.role === 'tool');
    const offered = new Set((req.tools ?? []).map((t) => t.name));

    // Asking what it can do is answered without a lookup.
    if (!toolResults.length && isHelp(question)) {
      const c = capabilities(offered);
      return this.say(`${c.text}\n\nAsk in your own words, for example "${c.examples[0] ?? 'How much cash do we have?'}"${followupBlock(c.examples)}`, inputTokens, req);
    }

    // First round: decide what to look up.
    if (!toolResults.length && req.tools?.length && req.toolChoice !== 'none') {
      const planned = planTools(question, offered, todayFromMessages(req.messages));
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
      return this.say(capabilities(offered).text, inputTokens, req);
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
    return this.say(writeUp(question, results, offered), inputTokens, req);
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
