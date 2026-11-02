import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Answers and lookups remembered while the books stand still.
//
// The same question is asked again and again — "what do customers owe us?"
// first thing every morning, by three people. While nothing in the books has
// changed, the answer cannot have changed either, so it is given again at
// once and charged nothing. The same goes for the lookups behind an answer:
// "sales this month" read for one question is reused by the next that needs
// it, saving the database the work and the model the wait.
//
// "Nothing has changed" is the book's version: the newest audit-log entry and
// the newest journal entry. Every write the app makes moves one or the other,
// so a cached answer is never served after the figures behind it moved. A
// short time limit bounds the rest — the date, and anything that changes
// without a write (the clock passing a due date).
//
// Kept in the server's memory, per process: a restart forgets it, which costs
// only the time to ask again.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor } from '../db';
import type { AiReport } from '../../ai/reports';
import type { ToolRun, ToolSource } from './tools';
import type { ToolCall } from './types';

class TtlCache<V> {
  private readonly map = new Map<string, { value: V; at: number }>();
  constructor(private readonly max: number, private readonly ttlMs: number) {}

  get(key: string): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (Date.now() - hit.at > this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    // Most recently used goes to the end, so the oldest is evicted first.
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }

  set(key: string, value: V) {
    this.map.delete(key);
    this.map.set(key, { value, at: Date.now() });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string);
  }

  clear() {
    this.map.clear();
  }

  get size() {
    return this.map.size;
  }
}

export interface CachedAnswer {
  content: string;
  followups: string[];
  sources: ToolSource[];
  reports: AiReport[];
}

const g = globalThis as unknown as {
  __rekonzaAiLookups?: TtlCache<ToolRun>;
  __rekonzaAiAnswers?: TtlCache<CachedAnswer>;
  __rekonzaAiCacheStats?: { answers: number; lookups: number };
};
export const lookupCache = (g.__rekonzaAiLookups ??= new TtlCache<ToolRun>(2000, 10 * 60_000));
export const answerCache = (g.__rekonzaAiAnswers ??= new TtlCache<CachedAnswer>(500, 30 * 60_000));
/** How often each cache has answered, since the process started. */
export const cacheStats = (g.__rekonzaAiCacheStats ??= { answers: 0, lookups: 0 });

/** The book's version: it moves with every write, so anything cached under it is still true. */
export async function booksVersion(ex: Executor, orgId: number): Promise<string> {
  const [audit, journal] = await Promise.all([
    sql<{ id: number }>`SELECT id FROM audit_log WHERE org_id = ${orgId} ORDER BY created_at DESC, id DESC LIMIT 1`.execute(ex),
    sql<{ id: number }>`SELECT MAX(id) AS id FROM journal_entries WHERE org_id = ${orgId}`.execute(ex),
  ]);
  return `${audit.rows[0]?.id ?? 0}.${journal.rows[0]?.id ?? 0}`;
}

/** Arguments in a fixed order, so {from, to} and {to, from} are the same lookup. */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]));
  }
  return typeof v === 'string' ? v.trim().toLowerCase() : v;
}

export function lookupKey(scope: { orgId: number; role: string; today: string; version: string }, call: ToolCall): string {
  let args: unknown = call.arguments ?? '';
  try {
    args = canonical(call.arguments?.trim() ? JSON.parse(call.arguments) : {});
  } catch {
    // Unreadable arguments are cached as written; the tool refuses them anyway.
  }
  return `${scope.orgId}|${scope.role}|${scope.today}|${scope.version}|${call.name}|${JSON.stringify(args)}`;
}

/** The same question, however it was spaced or punctuated. */
export function normaliseQuestion(q: string): string {
  return q.toLowerCase().replace(/\s+/g, ' ').replace(/[?.!\s]+$/, '').trim();
}

export function answerKey(scope: { orgId: number; role: string; today: string; version: string; model: string }, question: string): string {
  return `${scope.orgId}|${scope.role}|${scope.today}|${scope.version}|${scope.model}|${normaliseQuestion(question)}`;
}
