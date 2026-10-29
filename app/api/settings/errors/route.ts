import { z } from 'zod';
import { db } from '@/lib/server/db';
import { route, body, query } from '@/lib/server/http';
import { listErrors, updateError } from '@/lib/server/error-log';
import { logAudit, auditMeta } from '@/lib/server/audit';

// System health: errors the server did not expect (error-log.ts), and what was
// done about each. Admins only — a stack trace names files and tables.

export const GET = route(async ({ orgId, req }) => {
  const q = query(req, z.object({ status: z.enum(['open', 'investigating', 'resolved']).optional() }));
  const [errors, jobs] = await Promise.all([
    listErrors(db, orgId, { status: q.status }),
    db.selectFrom('jobs').select(['id', 'kind', 'status', 'attempts', 'last_error', 'finished_at', 'created_at'])
      .where('org_id', '=', orgId).where('status', '=', 'failed').orderBy('id', 'desc').limit(50).execute(),
  ]);
  return {
    errors,
    failedJobs: jobs.map((j) => ({
      id: String(j.id), kind: j.kind, attempts: j.attempts, error: j.last_error,
      at: new Date(j.finished_at ?? j.created_at).toISOString(),
    })),
  };
}, { permission: { module: 'settings', action: 'edit' } });

const Input = z.object({
  id: z.coerce.number().int().positive(),
  status: z.enum(['open', 'investigating', 'resolved']),
  rootCause: z.string().trim().max(500).nullish(),
  resolution: z.string().trim().max(500).nullish(),
});

export const PATCH = route(async ({ orgId, user, req }) => {
  const input = await body(req, Input);
  await updateError(db, orgId, user.userId, input.id, input);
  await logAudit({
    orgId, actorUserId: user.userId, actorName: user.name, action: 'update', targetType: 'error', targetId: input.id,
    detail: `System error marked ${input.status}${input.rootCause ? `; cause: ${input.rootCause}` : ''}${input.resolution ? `; fix: ${input.resolution}` : ''}`,
    ...auditMeta(req),
  });
  return { ok: true };
}, { permission: { module: 'settings', action: 'edit' } });
