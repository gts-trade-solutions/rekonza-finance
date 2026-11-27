import { z } from 'zod';
import { transaction } from '@/lib/server/db';
import { route, body, idParam, asId } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { deleteTask, updateTask } from '@/lib/server/services/projects';

// One task on a project, changed or deleted on its own (services/projects.ts).
// A task with time logged to it is set inactive rather than deleted: its hours
// stay where they are.

const Input = z.object({
  name: z.string().trim().min(1, 'Give the task a name.').max(200),
  ratePaise: z.number().int().nonnegative().optional(),
  billable: z.boolean().optional(),
});

export const PATCH = route(
  async ({ orgId, user, params, req }) => {
    const pid = idParam(params);
    const tid = idParam(params, 'taskId');
    const input = await body(req, Input);
    await transaction(async (trx) => {
      const r = await updateTask(trx, orgId, pid, tid, input);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update', targetType: 'project', targetId: pid,
        targetLabel: input.name, detail: `Task ${r.before === input.name ? input.name : `${r.before} renamed ${input.name}`} changed`, ...auditMeta(req),
      });
    });
    return { id: asId(tid) };
  },
  { permission: { module: 'projects', action: 'edit' } },
);

export const DELETE = route(
  async ({ orgId, user, params, req }) => {
    const pid = idParam(params);
    const tid = idParam(params, 'taskId');
    const r = await transaction(async (trx) => {
      const done = await deleteTask(trx, orgId, pid, tid);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: done.removed ? 'delete' : 'update', targetType: 'project', targetId: pid,
        targetLabel: done.name, detail: done.removed ? `Task ${done.name} deleted` : `Task ${done.name} set inactive: time is logged to it`, ...auditMeta(req),
      });
      return done;
    });
    return { id: asId(tid), removed: r.removed, name: r.name };
  },
  { permission: { module: 'projects', action: 'edit' } },
);
