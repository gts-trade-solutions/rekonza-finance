import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, idParam } from '@/lib/server/http';
import { hasPermission } from '@/lib/rbac';
import { actOnException, exceptionDetail } from '@/lib/server/services/exceptions';
import { logAudit, auditMeta } from '@/lib/server/audit';

export const GET = route(async ({ orgId, params }) => exceptionDetail(db, orgId, idParam(params)),
  { permission: { module: 'exceptions', action: 'view' } });

const Input = z.object({
  action: z.enum(['assign', 'start', 'note', 'resolve', 'waive', 'reopen']),
  ownerUserId: z.coerce.number().int().positive().nullish(),
  note: z.string().trim().max(1000).nullish(),
});

/** Work an exception: take it on, note progress, hand it on, close it. */
export const POST = route(async ({ orgId, user, role, req, params }) => {
  const id = idParam(params);
  const input = await body(req, Input);
  await transaction(async (trx) => {
    await actOnException(trx, orgId, { userId: user.userId, canManage: hasPermission(role, 'exceptions', 'approve') }, id, input);
    await logAudit({
      trx, orgId, actorUserId: user.userId, actorName: user.name, action: input.action === 'resolve' || input.action === 'waive' ? 'approve' : 'update',
      targetType: 'exception', targetId: id, detail: `Exception ${input.action}${input.note ? `: ${input.note}` : ''}`,
      reason: input.action === 'resolve' || input.action === 'waive' ? input.note : undefined, ...auditMeta(req),
    });
  });
  return exceptionDetail(db, orgId, id);
}, { permission: { module: 'exceptions', action: 'edit' } });
