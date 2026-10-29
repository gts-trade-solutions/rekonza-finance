import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Errors nobody expected, kept where someone will see them.
//
// A console line is read by nobody once the server is hosted. So an error the
// code did not foresee is also written here: when, where, by whose request,
// the message and the stack, and how many times it has happened since. Repeats
// of the same error share a row (the fingerprint: its name, its message with
// the numbers taken out, and where it was thrown), so a fault hit two hundred
// times reads as one problem, not two hundred. Someone then records what caused
// it and how it was fixed, and closing it is part of the record.
//
// The person who met the error is shown the row's reference, so what they
// report can be found. Writing here must never itself fail a request: a fault
// in the error log is logged to the console and forgotten.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash, randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import { db, type Executor } from './db';
import { badRequest, notFound } from './http';

export interface ErrorContext {
  orgId: number | null;
  userId: number | null;
  method: string;
  path: string;
}

/** The first line of the stack that is ours, not a library's: where it was thrown. */
function origin(stack: string | undefined): string {
  const lines = (stack ?? '').split('\n').slice(1).map((l) => l.trim());
  return lines.find((l) => !l.includes('node_modules') && !l.includes('node:')) ?? lines[0] ?? '';
}

export function fingerprint(err: unknown): string {
  const e = err instanceof Error ? err : new Error(String(err));
  // Numbers vary between occurrences of the same fault (ids, amounts, line numbers in SQL).
  const message = e.message.replace(/\d+/g, '#').slice(0, 300);
  const where = origin(e.stack).replace(/:\d+:\d+\)?$/, '');
  return createHash('sha256').update(`${e.name}|${message}|${where}`).digest('hex').slice(0, 16);
}

/** Record an unexpected error; returns the reference to show, or null if it could not be kept. */
export async function recordError(err: unknown, ctx: ErrorContext, ex: Executor = db): Promise<string | null> {
  try {
    const e = err instanceof Error ? err : new Error(String(err));
    const fp = fingerprint(e);
    const ref = randomBytes(4).toString('hex').toUpperCase();
    // A fault that comes back after it was marked fixed is open again.
    await sql`
      INSERT INTO error_events (org_id, fingerprint, ref, method, path, error_name, message, stack, last_user_id)
      VALUES (${ctx.orgId}, ${fp}, ${ref}, ${ctx.method.slice(0, 10)}, ${ctx.path.slice(0, 255)},
              ${e.name.slice(0, 100)}, ${e.message.slice(0, 1000)}, ${(e.stack ?? '').slice(0, 8000)}, ${ctx.userId})
      ON DUPLICATE KEY UPDATE
        occurrences = occurrences + 1,
        last_seen_at = CURRENT_TIMESTAMP,
        last_user_id = VALUES(last_user_id),
        path = VALUES(path),
        status = IF(status = 'resolved', 'open', status)
    `.execute(ex);
    const row = await ex.selectFrom('error_events').select('ref').where('fingerprint', '=', fp).executeTakeFirst();
    return row?.ref ?? ref;
  } catch (logErr) {
    console.error('[error-log] could not record', logErr);
    return null;
  }
}

export interface ErrorRow {
  id: string;
  ref: string;
  method: string | null;
  path: string | null;
  name: string | null;
  message: string | null;
  stack: string | null;
  occurrences: number;
  firstSeen: string;
  lastSeen: string;
  status: 'open' | 'investigating' | 'resolved';
  rootCause: string | null;
  resolution: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
}

/**
 * This book's errors, newest first. Errors met before anyone signed in belong
 * to no book and are shown to every admin, since someone has to see them.
 */
export async function listErrors(ex: Executor, orgId: number, opts: { status?: string } = {}): Promise<ErrorRow[]> {
  const rows = await ex.selectFrom('error_events as e').leftJoin('users as u', 'u.id', 'e.resolved_by_user_id')
    .select(['e.id', 'e.ref', 'e.method', 'e.path', 'e.error_name', 'e.message', 'e.stack', 'e.occurrences', 'e.first_seen_at', 'e.last_seen_at',
      'e.status', 'e.root_cause', 'e.resolution', 'e.resolved_at', 'u.name as resolved_by'])
    .where((eb) => eb.or([eb('e.org_id', '=', orgId), eb('e.org_id', 'is', null)]))
    .$if(!!opts.status, (qb) => qb.where('e.status', '=', opts.status as 'open'))
    .orderBy('e.last_seen_at', 'desc').limit(200).execute();
  return rows.map((r) => ({
    id: String(r.id), ref: r.ref, method: r.method, path: r.path, name: r.error_name, message: r.message, stack: r.stack,
    occurrences: Number(r.occurrences), firstSeen: new Date(r.first_seen_at).toISOString(), lastSeen: new Date(r.last_seen_at).toISOString(),
    status: r.status, rootCause: r.root_cause, resolution: r.resolution, resolvedBy: r.resolved_by ?? null,
    resolvedAt: r.resolved_at ? new Date(r.resolved_at).toISOString() : null,
  }));
}

/** Move an error along: being looked at, or fixed — and a fix says what caused it and what was done. */
export async function updateError(
  ex: Executor, orgId: number, userId: number, id: number,
  input: { status: 'open' | 'investigating' | 'resolved'; rootCause?: string | null; resolution?: string | null },
) {
  const row = await ex.selectFrom('error_events').select(['id', 'org_id']).where('id', '=', id).executeTakeFirst();
  if (!row || (row.org_id !== null && Number(row.org_id) !== orgId)) throw notFound('No such error.');
  if (input.status === 'resolved' && (!input.rootCause?.trim() || !input.resolution?.trim())) {
    throw badRequest('Say what caused it and what was done about it before marking it resolved.');
  }
  await ex.updateTable('error_events').set({
    status: input.status,
    root_cause: input.rootCause?.trim().slice(0, 500) || null,
    resolution: input.resolution?.trim().slice(0, 500) || null,
    resolved_by_user_id: input.status === 'resolved' ? userId : null,
    resolved_at: input.status === 'resolved' ? new Date() : null,
  }).where('id', '=', id).execute();
}
