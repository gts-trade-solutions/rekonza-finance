import { z } from 'zod';
import { db } from '@/lib/server/db';
import { route, query } from '@/lib/server/http';
import { hasPermission } from '@/lib/rbac';
import { listExceptions, scanExceptions } from '@/lib/server/services/exceptions';
import { logAudit, auditMeta } from '@/lib/server/audit';

// The exceptions register (services/exceptions.ts): what the scheduler found
// wrong, who owns each, and by when.

const ListQuery = z.object({
  view: z.enum(['active', 'closed', 'all']).default('active'),
  mine: z.coerce.boolean().optional(),
  kind: z.string().max(40).optional(),
});

export const GET = route(async ({ orgId, user, role, req }) => {
  const q = query(req, ListQuery);
  const data = await listExceptions(db, orgId, { view: q.view, kind: q.kind, ownerUserId: q.mine ? user.userId : undefined });
  const users = await db.selectFrom('users').select(['id', 'name', 'role']).where('org_id', '=', orgId).where('is_active', '=', 1).orderBy('name').execute();
  return {
    ...data,
    canManage: hasPermission(role, 'exceptions', 'approve'),
    me: String(user.userId),
    users: users.map((u) => ({ id: String(u.id), name: u.name, role: u.role })),
  };
}, { permission: { module: 'exceptions', action: 'view' } });

/** Look now, rather than waiting for the scheduler's next sweep. */
export const POST = route(async ({ orgId, user, req }) => {
  const result = await scanExceptions(orgId);
  await logAudit({
    orgId, actorUserId: user.userId, actorName: user.name, action: 'create', targetType: 'exception',
    detail: `Checked for exceptions now: ${result.raised} raised, ${result.cleared} cleared, ${result.escalated} escalated`, ...auditMeta(req),
  });
  return result;
}, { permission: { module: 'exceptions', action: 'edit' } });
