import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, asId, forbidden } from '@/lib/server/http';
import { hasPermission } from '@/lib/rbac';
import { reportModule } from '@/lib/report-groups';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { deleteSchedule, listSchedules, PERIODS, runSchedule, saveSchedule } from '@/lib/server/services/report-schedules';
import { indiaToday } from '@/lib/server/services/held-journals';
import { SCHEDULABLE } from '@/lib/server/reports/tabulate';

// Scheduled reports: what is made when, for whom, and the files made so far.

export const GET = route(
  async ({ orgId, role }) => {
    const [data, users] = await Promise.all([
      listSchedules(db, orgId),
      db.selectFrom('users').select(['id', 'name']).where('org_id', '=', orgId).where('is_active', '=', 1).orderBy('name').execute(),
    ]);
    // Only the files of reports this person may see.
    return {
      ...data,
      files: data.files.filter((f) => hasPermission(role, reportModule(f.report), 'view')),
      users: users.map((u) => ({ id: asId(u.id), name: u.name })),
      reports: Object.entries(SCHEDULABLE).filter(([k]) => hasPermission(role, reportModule(k), 'view')).map(([value, label]) => ({ value, label })),
      periods: Object.entries(PERIODS).map(([value, label]) => ({ value, label })),
    };
  },
  { permission: { module: 'reports', action: 'view' } },
);

const Id = z.union([z.string(), z.number()]).transform(Number);
const Input = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('save'), id: Id.nullish(), name: z.string().max(100), report: z.string(), period: z.string(),
    frequency: z.enum(['daily', 'weekly', 'monthly']), firstRun: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    recipients: z.array(Id).min(1), isActive: z.boolean().optional(),
  }),
  z.object({ action: z.literal('delete'), id: Id }),
  z.object({ action: z.literal('run'), id: Id }),
]);

export const POST = route(
  async ({ orgId, user, role, req }) => {
    const input = await body(req, Input);
    return transaction(async (trx) => {
      if (input.action === 'save') {
        if (!hasPermission(role, reportModule(input.report), 'view')) throw forbidden('Your role does not include that report.');
        const id = await saveSchedule(trx, orgId, user.userId, input);
        await logAudit({ trx, orgId, actorUserId: user.userId, actorName: user.name, action: input.id ? 'update' : 'create', targetType: 'report_schedule', targetId: id, detail: `${input.name || input.report}: ${input.frequency}, ${input.period}`, ...auditMeta(req) });
        return { id: asId(id) };
      }
      if (input.action === 'delete') {
        await deleteSchedule(trx, orgId, input.id);
        await logAudit({ trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'void', targetType: 'report_schedule', targetId: input.id, detail: 'Schedule deleted', ...auditMeta(req) });
        return { id: asId(input.id) };
      }
      const r = await runSchedule(trx, orgId, input.id, indiaToday());
      return { fileId: asId(r.fileId), recipients: r.recipients };
    });
  },
  { permission: { module: 'reports', action: 'view' } },
);
