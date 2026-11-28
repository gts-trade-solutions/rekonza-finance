import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, idParam, asId, forbidden, notFound } from '@/lib/server/http';
import { hasPermission } from '@/lib/rbac';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { updateTime } from '@/lib/server/services/projects';

// Edit one time entry (services/projects.ts updateTime). As with logging and
// removing time, a person changes their own; someone else's needs the right
// to edit projects. Billed time is refused: the invoice is its record.

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a yyyy-mm-dd date.');
const Input = z.object({
  taskId: z.union([z.string(), z.number()]).nullish(),
  date: DATE,
  minutes: z.number().int().min(1).max(1440),
  notes: z.string().trim().max(500).nullish(),
  billable: z.boolean().optional(),
});

export const PUT = route(
  async ({ orgId, user, role, params, req }) => {
    const entryId = idParam(params);
    const input = await body(req, Input);
    const row = await db.selectFrom('time_entries').select(['user_id']).where('id', '=', entryId).where('org_id', '=', orgId).executeTakeFirst();
    if (!row) throw notFound('That time entry does not exist.');
    if (row.user_id !== user.userId && !hasPermission(role, 'projects', 'edit')) throw forbidden('You can change your own time only.');
    const r = await transaction(async (trx) => {
      const done = await updateTime(trx, orgId, entryId, { ...input, taskId: input.taskId ? Number(input.taskId) : null });
      const again = done.approvalStatus === 'pending' && done.before.approval !== 'pending';
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update', targetType: 'time_entry', targetId: entryId,
        detail: `Time entry changed to ${(input.minutes / 60).toFixed(2)} h on ${input.date}${again ? '; waiting for approval again' : ''}`,
        payload: { before: done.before, after: done.after }, ...auditMeta(req),
      });
      return done;
    });
    return { id: asId(entryId), approvalStatus: r.approvalStatus };
  },
  { permission: { module: 'projects', action: 'create' } },
);
