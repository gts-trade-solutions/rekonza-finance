import { sql } from 'kysely';
import { db } from '@/lib/server/db';
import { route } from '@/lib/server/http';
import { cacheStats } from '@/lib/server/ai/cache';

// How quick and how economical the assistant has been for this book over the
// last thirty days: answers given again from the cache (instant, free), the
// typical time to an answer, and how much of each prompt the model provider
// served from its own cache (charged at a fraction of the price).

export const GET = route(
  async ({ orgId }) => {
    const since = new Date(Date.now() - 30 * 86_400_000);
    const { rows } = await sql<{
      questions: string; cached: string; avg_ms: string | null; input: string; cached_tokens: string; avg_charge: string | null; lookups: string;
    }>`
      SELECT COUNT(*) AS questions,
             COALESCE(SUM(outcome = 'answered' AND model_calls = 0), 0) AS cached,
             AVG(CASE WHEN outcome = 'answered' AND model_calls > 0 THEN duration_ms END) AS avg_ms,
             COALESCE(SUM(input_tokens), 0) AS input,
             COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
             AVG(CASE WHEN outcome = 'answered' AND model_calls > 0 THEN charged_mc END) AS avg_charge,
             COALESCE(SUM(tool_calls), 0) AS lookups
        FROM ai_usage
       WHERE org_id = ${orgId} AND provider <> 'download' AND created_at >= ${since}
    `.execute(db);
    const r = rows[0];
    const input = Number(r?.input ?? 0);
    const cached = Number(r?.cached ?? 0);
    return {
      days: 30,
      questions: Number(r?.questions ?? 0),
      answeredFromCache: cached,
      averageSeconds: r?.avg_ms == null ? null : Math.round(Number(r.avg_ms) / 100) / 10,
      promptCachePct: input > 0 ? Math.round((Number(r?.cached_tokens ?? 0) / input) * 100) : null,
      creditsSavedMc: Math.round(cached * Number(r?.avg_charge ?? 0)),
      lookups: Number(r?.lookups ?? 0),
      // Since this server last started.
      lookupsReused: cacheStats.lookups,
    };
  },
  { permission: { module: 'ai', action: 'view' } },
);
