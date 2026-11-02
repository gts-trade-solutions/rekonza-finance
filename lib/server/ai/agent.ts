import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// One question, answered.
//
// The loop every tool-using assistant runs: ask the model; if it asks for
// lookups, run them and hand back the results; ask again; stop when it
// answers. What is particular to this one is the budget.
//
// The question arrives with credits reserved for it. Every model call is
// priced as it completes, and once most of the reservation is spent the model
// is told to stop looking things up and answer with what it has — so a
// question can never cost more than was reserved, however many lookups the
// model would have liked. The final call's output is capped to what is left.
//
// Text the model writes before it decides to use a tool ("Let me check…") is
// withdrawn from the screen when the tool call arrives, so the answer the
// person reads is only the answer.
//
// The lookups the model asks for in one step run side by side, not one after
// another, and a lookup already made while the books stood still is reused
// rather than read again (cache.ts) — the two things that make an answer
// quick once the model has decided what it needs.
// ─────────────────────────────────────────────────────────────────────────────

import { splitFollowups } from '../../ai/followups';
import { MAX_REPORTS_PER_ANSWER, type AiReport } from '../../ai/reports';
import { costMicroForMc, costMicroUsd, type ModelPrice } from './pricing';
import { buildSystemPrompt, type PromptContext } from './prompt';
import { runTool, toolLabel, toolSpecsFor, type ToolContext, type ToolRun, type ToolSource } from './tools';
import { cacheStats, lookupCache, lookupKey } from './cache';
import {
  NO_USAGE, ProviderError, addUsage,
  type AiProvider, type CallUsage, type ChatMessage, type ProviderErrorKind, type ToolCall,
} from './types';

/** Model calls per question, the last of which must answer. */
export const MAX_MODEL_CALLS = 6;
const MAX_TOOL_CALLS_PER_STEP = 6;
/** Earlier turns sent with each question: enough for "and last month?" to make sense. */
const HISTORY_MESSAGES = 12;
const HISTORY_CHARS = 2_500;
/** Stop offering tools once this share of the reservation is spent. */
const WRAP_UP_AT = 0.7;

export type AgentEvent =
  | { type: 'delta'; text: string }
  /** Withdraw what has streamed so far: it was a preamble to a tool call. */
  | { type: 'discard' }
  | { type: 'tool'; name: string; label: string };

export interface AgentInput {
  provider: AiProvider;
  tools: ToolContext;
  prompt: PromptContext;
  history: { role: 'user' | 'assistant'; content: string }[];
  question: string;
  holdMc: number;
  price: ModelPrice;
  creditCostUsd: number;
  signal: AbortSignal;
  emit: (e: AgentEvent) => void;
  /** Runs a lookup in place of the books: the online demo answers from its recording. */
  runLookup?: (call: ToolCall) => Promise<ToolRun>;
  /** The book's version (cache.ts): given, lookups made under it are reused. */
  booksVersion?: string;
  /** Sent to the model provider so requests from one book share its prompt cache. */
  cacheKey?: string;
}

export interface AgentResult {
  /** The answer, without its follow-up block. */
  content: string;
  followups: string[];
  sources: ToolSource[];
  /** One per lookup, in the order they ran — only for an answer that finished. */
  reports: AiReport[];
  usage: CallUsage;
  costMicroUsd: number;
  modelCalls: number;
  toolCalls: number;
  /** Of the lookups, how many were answered from the cache. */
  lookupsFromCache: number;
  outcome: 'answered' | 'stopped' | 'error';
  errorKind?: ProviderErrorKind | 'internal';
  errorMessage?: string;
}

function trimHistory(history: AgentInput['history']): ChatMessage[] {
  return history.slice(-HISTORY_MESSAGES).map((m) => ({
    role: m.role,
    content: m.content.length > HISTORY_CHARS ? `${m.content.slice(0, HISTORY_CHARS)}…` : m.content,
  }));
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export async function runAgent(input: AgentInput): Promise<AgentResult> {
  const specs = toolSpecsFor(input.tools.role);
  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt(input.prompt) },
    ...trimHistory(input.history),
    { role: 'user', content: input.question },
  ];

  const budget = costMicroForMc(input.holdMc, input.creditCostUsd);
  const sources = new Map<string, ToolSource>();
  const reports: AiReport[] = [];
  let usage: CallUsage = NO_USAGE;
  let modelCalls = 0;
  let toolCalls = 0;
  let lookupsFromCache = 0;

  const lookup = async (call: ToolCall): Promise<{ out: ToolRun; cached: boolean }> => {
    if (input.runLookup) return { out: await input.runLookup(call), cached: false };
    if (!input.booksVersion) return { out: await runTool(input.tools, call), cached: false };
    const key = lookupKey({ orgId: input.tools.orgId, role: input.tools.role, today: input.tools.today, version: input.booksVersion }, call);
    const hit = lookupCache.get(key);
    if (hit) {
      cacheStats.lookups++;
      return { out: hit, cached: true };
    }
    const out = await runTool(input.tools, call);
    if (out.ok) lookupCache.set(key, out);
    return { out, cached: false };
  };
  let answer = '';
  let outcome: AgentResult['outcome'] = 'answered';
  let errorKind: AgentResult['errorKind'];
  let errorMessage: string | undefined;

  for (let round = 0; round < MAX_MODEL_CALLS; round++) {
    const spent = costMicroUsd(usage, input.price);
    const wrapUp = round === MAX_MODEL_CALLS - 1 || spent >= budget * WRAP_UP_AT;
    // Room for the answer within what is left, at the output price. Never so
    // little that a reasoning model spends it all thinking and says nothing.
    const maxOutputTokens = clamp(Math.floor(((budget - spent) * 0.8) / Math.max(input.price.output, 0.01)), 800, 2500);
    let streamed = '';

    try {
      const result = await input.provider.chat({
        messages,
        tools: specs.length ? specs : undefined,
        toolChoice: specs.length ? (wrapUp ? 'none' : 'auto') : undefined,
        maxOutputTokens,
        cacheKey: input.cacheKey,
        signal: input.signal,
        onText: (t) => {
          streamed += t;
          input.emit({ type: 'delta', text: t });
        },
      });
      modelCalls++;
      usage = addUsage(usage, result.usage);

      if (result.toolCalls.length && !wrapUp) {
        if (streamed) input.emit({ type: 'discard' });
        messages.push({ role: 'assistant', content: result.text || null, toolCalls: result.toolCalls });
        const run = result.toolCalls.slice(0, MAX_TOOL_CALLS_PER_STEP);
        if (input.signal.aborted) throw new ProviderError('Stopped.', 'aborted');
        // The step's lookups run side by side; their answers go back in the
        // order the model asked for them.
        for (const call of run) input.emit({ type: 'tool', name: call.name, label: toolLabel(call.name) });
        const outs = await Promise.all(run.map((call) => lookup(call)));
        // Every call the model made must be answered — including the ones
        // not run — or the next request is rejected as malformed.
        for (const call of result.toolCalls) {
          const at = run.indexOf(call);
          if (at < 0) {
            messages.push({
              role: 'tool',
              toolCallId: call.id,
              name: call.name,
              content: JSON.stringify({ error: 'Too many lookups in one step. Ask again for this one if it is still needed.' }),
            });
            continue;
          }
          const { out, cached } = outs[at];
          toolCalls++;
          if (cached) lookupsFromCache++;
          for (const s of out.sources) sources.set(`${s.href}|${s.label}`, s);
          // The same lookup asked twice is one report.
          const report = out.report;
          if (report && !reports.some((r) => r.key === report.key)) reports.push(report);
          messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: out.content });
        }
        continue;
      }

      answer = result.text;
      if (!answer.trim()) {
        answer =
          result.finishReason === 'length'
            ? 'That needed a longer answer than this question had room for. Ask it again more narrowly — one period, or one account.'
            : 'I gathered the figures but could not put an answer together. Try asking again in different words.';
      }
      break;
    } catch (err) {
      if (err instanceof ProviderError) {
        modelCalls++;
        if (err.partial) usage = addUsage(usage, err.partial.usage);
        answer = err.partial?.text || streamed;
        if (err.kind === 'aborted') outcome = 'stopped';
        else {
          outcome = 'error';
          errorKind = err.kind;
          errorMessage = err.message;
        }
      } else {
        console.error('[ai] agent failed', err);
        outcome = 'error';
        errorKind = 'internal';
        errorMessage = (err as Error)?.message ?? 'unknown';
        answer = streamed;
      }
      break;
    }
  }

  const { body, followups } = splitFollowups(answer);
  return {
    content: body,
    followups: outcome === 'answered' ? followups : [],
    sources: [...sources.values()].slice(0, 6),
    // A stopped or failed answer has no summary for a report to sit under.
    reports: outcome === 'answered' ? reports.slice(0, MAX_REPORTS_PER_ANSWER) : [],
    usage,
    costMicroUsd: costMicroUsd(usage, input.price),
    modelCalls,
    toolCalls,
    lookupsFromCache,
    outcome,
    errorKind,
    errorMessage,
  };
}
