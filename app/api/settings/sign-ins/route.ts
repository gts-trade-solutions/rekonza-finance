import { z } from 'zod';
import { sql } from 'kysely';
import { db } from '@/lib/server/db';
import { route, body, notFound } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { hasPermission } from '@/lib/rbac';

// Who signed in, from where, and when each session ended. An admin sees the
// whole book; everyone else sees their own. Sessions are named by the first
// 16 hex of their token's hash: enough to pick one out, useless as a cookie.

const status = (r: { revoked_at: Date | null; expires_at: Date; end_reason: string | null }) =>
  r.revoked_at ? (r.end_reason ?? 'revoked') : new Date(r.expires_at) < new Date() ? 'expired' : 'active';

export const GET = route(async ({ orgId, user }) => {
  const all = hasPermission(user.role, 'settings', 'edit');
  let sessions = db.selectFrom('sessions').innerJoin('users', 'users.id', 'sessions.user_id')
    .select([
      sql<string>`LEFT(sessions.token_hash, 16)`.as('id'), 'users.name', 'users.email', 'sessions.ip', 'sessions.user_agent',
      'sessions.created_at', 'sessions.last_seen_at', 'sessions.expires_at', 'sessions.revoked_at', 'sessions.end_reason',
    ])
    .where('sessions.org_id', '=', orgId).orderBy('sessions.created_at', 'desc').limit(200);
  if (!all) sessions = sessions.where('sessions.user_id', '=', user.userId);

  let failed = db.selectFrom('audit_log').select(['actor_name', 'detail', 'ip', 'user_agent', 'created_at'])
    .where('org_id', '=', orgId).where('action', '=', 'login').where('detail', 'like', 'Failed%')
    .orderBy('created_at', 'desc').limit(100);
  if (!all) failed = failed.where('actor_user_id', '=', user.userId);

  return {
    scope: all ? 'organization' : 'self',
    sessions: (await sessions.execute()).map((r) => ({
      id: r.id, name: r.name, email: r.email, ip: r.ip, userAgent: r.user_agent,
      startedAt: r.created_at, lastSeenAt: r.last_seen_at, endedAt: r.revoked_at ?? (status(r) === 'expired' ? r.expires_at : null),
      status: status(r), current: r.id === user.sessionId,
    })),
    failed: (await failed.execute()).map((r) => ({ name: r.actor_name, detail: r.detail, ip: r.ip, userAgent: r.user_agent, at: r.created_at })),
  };
});

const Input = z.discriminatedUnion('action', [
  z.object({ action: z.literal('end'), id: z.string().regex(/^[0-9a-f]{16}$/) }),
  z.object({ action: z.literal('end-others') }),
]);

/** End one session (yours, or anyone's for an admin), or every session of yours but this one. */
export const POST = route(async ({ orgId, user, req }) => {
  const input = await body(req, Input);
  const all = hasPermission(user.role, 'settings', 'edit');
  let q = db.updateTable('sessions').set({ revoked_at: new Date(), end_reason: 'revoked' })
    .where('org_id', '=', orgId).where('revoked_at', 'is', null).where('expires_at', '>', new Date());
  if (input.action === 'end') {
    q = q.where(sql<boolean>`LEFT(token_hash, 16) = ${input.id}`);
    if (!all) q = q.where('user_id', '=', user.userId);
  } else {
    q = q.where('user_id', '=', user.userId);
    if (user.sessionId) q = q.where(sql<boolean>`LEFT(token_hash, 16) <> ${user.sessionId}`);
  }
  const ended = Number((await q.executeTakeFirst()).numUpdatedRows ?? 0);
  if (input.action === 'end' && !ended) throw notFound('That session has already ended.');
  await logAudit({
    orgId, actorUserId: user.userId, actorName: user.name, action: 'login', targetType: 'session', targetId: String(user.userId),
    detail: input.action === 'end' ? 'Ended a session' : `Ended ${ended} other session${ended === 1 ? '' : 's'}`, ...auditMeta(req),
  });
  return { ended };
});
