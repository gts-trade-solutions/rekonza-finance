import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, asId } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { runningTimer, startTimer, stopTimer } from '@/lib/server/services/projects';

// The timer (services/projects.ts): each person's own, one at a time.

export const GET = route(
  async ({ orgId, user }) => ({ timer: await runningTimer(db, orgId, user.userId) }),
  { permission: { module: 'projects', action: 'view' } },
);

const ID = z.union([z.string(), z.number()]).transform(Number);
const Input = z.discriminatedUnion('action', [
  z.object({ action: z.literal('start'), projectId: ID, taskId: ID.nullish(), notes: z.string().trim().max(500).nullish(), billable: z.boolean().optional() }),
  z.object({ action: z.literal('stop'), notes: z.string().trim().max(500).nullish() }),
  z.object({ action: z.literal('discard') }),
]);

export const POST = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, Input);
    if (input.action === 'start') {
      const timer = await transaction((trx) => startTimer(trx, orgId, user.userId, { projectId: input.projectId, taskId: input.taskId ?? null, notes: input.notes ?? null, billable: input.billable }));
      return { timer };
    }
    return transaction(async (trx) => {
      const r = await stopTimer(trx, orgId, user.userId, { discard: input.action === 'discard', notes: input.action === 'stop' ? input.notes ?? null : null });
      if (r.entryId) {
        await logAudit({
          trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'create', targetType: 'time_entry', targetId: r.entryId,
          detail: `${(r.minutes / 60).toFixed(2)} h logged from the timer`, ...auditMeta(req),
        });
      }
      return { entryId: r.entryId ? asId(r.entryId) : null, minutes: r.minutes, timer: null };
    });
  },
  { permission: { module: 'projects', action: 'create' } },
);
