import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Trying again, later, without anybody pressing a button.
//
// A submission that failed because the portal was down is not a problem with
// the document, and asking a person to keep pressing Register until NIC comes
// back is not a process. So an outage queues a retry here: a row in `jobs`,
// run by the worker in this server process a few minutes later, then later
// again, until it goes through or the attempts run out.
//
// Only outages are retried. A refusal is about the document and would come
// back identically, so it is shown to a person instead of being burned through
// more attempts that would read like an outage in the register.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import { db, type Executor, type Trx } from '../db';
import { ApiError } from '../http';

export type JobKind = 'einvoice.register' | 'ewb.generate';
export const JOB_KINDS: JobKind[] = ['einvoice.register', 'ewb.generate'];

/** Minutes before each retry: the first after the failure a person saw, then after each failed retry. */
export const RETRY_DELAYS_MIN = [2, 10, 30] as const;
/** Retries after that first failure. With the attempt a person made, four tries in all. */
export const MAX_RETRIES = RETRY_DELAYS_MIN.length;

/** A running job whose worker has not reported back in this long is taken to have died. */
const STALE_AFTER_MS = 10 * 60_000;

const minutes = (m: number) => m * 60_000;

export interface ClaimedJob {
  id: number;
  org_id: number;
  kind: string;
  payload: Record<string, unknown>;
  /** Including the one just claimed. */
  attempts: number;
  max_attempts: number;
  created_by_user_id: number | null;
}

export type JobOutcome =
  | { kind: 'done'; result?: unknown }
  | { kind: 'retry'; error: string }
  | { kind: 'fail'; error: string };

/** A retry waiting for a document: when, and which try of how many it will be. */
export interface QueuedRetry {
  at: string;
  attempt: number;
  of: number;
}

const jobKey = sql<string>`JSON_UNQUOTE(JSON_EXTRACT(payload, '$.key'))`;

/**
 * Queue a retry for one document, unless one is already waiting.
 *
 * The key names the document ("invoice:12", "challan:4"), so "Register all"
 * during an outage queues one retry per invoice rather than one per click.
 */
export async function enqueueRetry(
  ex: Executor,
  args: {
    orgId: number;
    kind: JobKind;
    key: string;
    payload: Record<string, unknown>;
    userId: number | null;
    now?: Date;
  },
): Promise<{ id: number; runAfter: Date }> {
  const now = args.now ?? new Date();
  const existing = await ex
    .selectFrom('jobs')
    .select(['id', 'run_after'])
    .where('org_id', '=', args.orgId)
    .where('kind', '=', args.kind)
    .where('status', 'in', ['queued', 'running'])
    .where(sql<boolean>`${jobKey} = ${args.key}`)
    .executeTakeFirst();
  if (existing) return { id: existing.id, runAfter: existing.run_after ?? now };

  const runAfter = new Date(now.getTime() + minutes(RETRY_DELAYS_MIN[0]));
  const inserted = await ex
    .insertInto('jobs')
    .values({
      org_id: args.orgId,
      kind: args.kind,
      payload: JSON.stringify({ ...args.payload, key: args.key }),
      status: 'queued',
      max_attempts: MAX_RETRIES,
      run_after: runAfter,
      created_by_user_id: args.userId,
    })
    .executeTakeFirstOrThrow();
  return { id: Number(inserted.insertId), runAfter };
}

const parsePayload = (v: unknown): Record<string, unknown> =>
  typeof v === 'string' ? (JSON.parse(v) as Record<string, unknown>) : ((v ?? {}) as Record<string, unknown>);

/**
 * Take the next job that is due, so no other worker can.
 *
 * SKIP LOCKED lets two server processes claim side by side without waiting on
 * each other, and without ever taking the same row.
 */
export async function claimDueJob(
  trx: Trx,
  workerId: string,
  now: Date,
  opts: { orgId?: number } = {},
): Promise<ClaimedJob | null> {
  let q = trx
    .selectFrom('jobs')
    .select(['id', 'org_id', 'kind', 'payload', 'attempts', 'max_attempts', 'created_by_user_id', 'started_at'])
    .where('status', '=', 'queued')
    .where('kind', 'in', JOB_KINDS)
    .where((eb) => eb.or([eb('run_after', 'is', null), eb('run_after', '<=', now)]));
  if (opts.orgId !== undefined) q = q.where('org_id', '=', opts.orgId);

  const row = await q.orderBy('priority').orderBy('id').limit(1).forUpdate().skipLocked().executeTakeFirst();
  if (!row) return null;

  const attempts = row.attempts + 1;
  await trx
    .updateTable('jobs')
    .set({ status: 'running', attempts, locked_by: workerId, locked_at: now, started_at: row.started_at ?? now })
    .where('id', '=', row.id)
    .execute();

  return {
    id: row.id,
    org_id: row.org_id,
    kind: row.kind,
    payload: parsePayload(row.payload),
    attempts,
    max_attempts: row.max_attempts,
    created_by_user_id: row.created_by_user_id,
  };
}

/** Write down what a job's run came to: done, again later, or given up. */
export async function settleJob(
  ex: Executor,
  job: ClaimedJob,
  outcome: JobOutcome,
  now: Date = new Date(),
): Promise<'completed' | 'queued' | 'failed'> {
  if (outcome.kind === 'done') {
    await ex
      .updateTable('jobs')
      .set({
        status: 'completed',
        finished_at: now,
        locked_by: null,
        locked_at: null,
        last_error: null,
        result: JSON.stringify(outcome.result ?? null),
      })
      .where('id', '=', job.id)
      .execute();
    return 'completed';
  }

  if (outcome.kind === 'retry' && job.attempts < job.max_attempts) {
    const delay = RETRY_DELAYS_MIN[Math.min(job.attempts, RETRY_DELAYS_MIN.length - 1)];
    await ex
      .updateTable('jobs')
      .set({
        status: 'queued',
        run_after: new Date(now.getTime() + minutes(delay)),
        locked_by: null,
        locked_at: null,
        last_error: outcome.error.slice(0, 2000),
      })
      .where('id', '=', job.id)
      .execute();
    return 'queued';
  }

  await ex
    .updateTable('jobs')
    .set({
      status: 'failed',
      finished_at: now,
      locked_by: null,
      locked_at: null,
      last_error: outcome.error.slice(0, 2000),
    })
    .where('id', '=', job.id)
    .execute();
  return 'failed';
}

/** Put back jobs whose worker went away mid-run: a restart, a crash, a deploy. */
export async function recoverStaleJobs(
  ex: Executor,
  now: Date = new Date(),
  opts: { orgId?: number } = {},
): Promise<number> {
  let q = ex
    .updateTable('jobs')
    .set({ status: 'queued', locked_by: null, locked_at: null })
    .where('status', '=', 'running')
    .where('kind', 'in', JOB_KINDS)
    .where('locked_at', '<', new Date(now.getTime() - STALE_AFTER_MS));
  if (opts.orgId !== undefined) q = q.where('org_id', '=', opts.orgId);
  const res = await q.executeTakeFirst();
  return Number(res.numUpdatedRows ?? 0);
}

/** The retries waiting, by document key, for a register to show. */
export async function queuedRetries(ex: Executor, orgId: number, kind: JobKind): Promise<Map<string, QueuedRetry>> {
  const rows = await ex
    .selectFrom('jobs')
    .select(['run_after', 'attempts', 'max_attempts', jobKey.as('job_key')])
    .where('org_id', '=', orgId)
    .where('kind', '=', kind)
    .where('status', 'in', ['queued', 'running'])
    .execute();

  const out = new Map<string, QueuedRetry>();
  for (const r of rows) {
    if (!r.job_key) continue;
    // Counted as a person counts: their own attempt was the first try.
    out.set(r.job_key, {
      at: (r.run_after ?? new Date()).toISOString(),
      attempt: r.attempts + 2,
      of: r.max_attempts + 1,
    });
  }
  return out;
}

const istClock = (d: Date) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);

/**
 * Turn a portal outage into a queued retry, and say when it will run.
 *
 * Anything else is thrown back untouched: a refusal is for a person to read.
 */
export async function retryAfterOutage(
  err: unknown,
  args: {
    orgId: number;
    kind: JobKind;
    key: string;
    payload: Record<string, unknown>;
    userId: number | null;
    ex?: Executor;
    now?: Date;
  },
): Promise<never> {
  if (!(err instanceof ApiError) || err.code !== 'portal_unavailable') throw err;
  const { runAfter } = await enqueueRetry(args.ex ?? db, args);
  throw new ApiError(
    503,
    `${err.message} It will be tried again automatically at ${istClock(runAfter)}.`,
    'portal_unavailable',
    { retryAt: runAfter.toISOString() },
  );
}
