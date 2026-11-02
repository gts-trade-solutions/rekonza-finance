import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, query, asId, forbidden } from '@/lib/server/http';
import { hasPermission } from '@/lib/rbac';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { deleteTime, logTime } from '@/lib/server/services/projects';
import { getPolicies } from '@/lib/server/services/org-settings';

// The timesheet: time logged to projects. Anyone who may log time logs their
// own; logging or removing someone else's needs the right to edit projects.

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a yyyy-mm-dd date.');

export const GET = route(
  async ({ orgId, user, role, req }) => {
    const q = query(req, z.object({
      from: DATE.optional(), to: DATE.optional(), projectId: z.string().optional(),
      userId: z.string().optional(), mine: z.coerce.boolean().optional(),
      // Time waiting for approval, from everyone but the one asking.
      approvals: z.coerce.boolean().optional(),
    }));
    if (q.approvals && !hasPermission(role, 'projects', 'approve')) throw forbidden('You cannot approve timesheets.');
    // Without the right to manage projects, a person sees their own time only.
    const own = !q.approvals && (q.mine || !hasPermission(role, 'projects', 'edit'));
    let rows = db.selectFrom('time_entries as t').innerJoin('projects as p', 'p.id', 't.project_id')
      .innerJoin('contacts as c', 'c.id', 'p.customer_id').innerJoin('users as u', 'u.id', 't.user_id')
      .leftJoin('project_tasks as k', 'k.id', 't.task_id').leftJoin('invoices as i', 'i.id', 't.invoice_id').leftJoin('users as a', 'a.id', 't.approved_by_user_id')
      .select(['t.id', 't.entry_date', 't.minutes', 't.notes', 't.billable', 't.invoice_id', 't.project_id', 't.user_id',
        'p.name as project_name', 'c.display_name as customer_name', 'u.name as user_name', 'k.name as task_name', 'i.number as invoice_number',
        't.approval_status', 't.approval_note', 'a.name as approved_by'])
      .where('t.org_id', '=', orgId);
    if (q.approvals) rows = rows.where('t.approval_status', '=', 'pending').where('t.user_id', '<>', user.userId);
    if (own) rows = rows.where('t.user_id', '=', user.userId);
    else if (q.userId) rows = rows.where('t.user_id', '=', Number(q.userId));
    if (q.projectId) rows = rows.where('t.project_id', '=', Number(q.projectId));
    if (q.from) rows = rows.where('t.entry_date', '>=', q.from);
    if (q.to) rows = rows.where('t.entry_date', '<=', q.to);
    const list = await rows.orderBy('t.entry_date', 'desc').orderBy('t.id', 'desc').limit(1000).execute();
    return {
      entries: list.map((e) => ({
        id: asId(e.id), date: String(e.entry_date).slice(0, 10), minutes: e.minutes, notes: e.notes, billable: !!e.billable,
        projectId: asId(e.project_id), projectName: e.project_name, customerName: e.customer_name,
        userId: asId(e.user_id), userName: e.user_name, taskName: e.task_name,
        invoiceId: e.invoice_id ? asId(e.invoice_id) : null, invoiceNumber: e.invoice_number,
        approvalStatus: e.approval_status, approvalNote: e.approval_note, approvedBy: e.approved_by,
      })),
      ownOnly: own,
      approvalOn: (await getPolicies(db, orgId)).controls.timesheetApproval,
      canApprove: hasPermission(role, 'projects', 'approve'),
    };
  },
  { permission: { module: 'projects', action: 'view' } },
);

const id = z.union([z.string(), z.number()]);
const LogInput = z.object({
  projectId: id,
  taskId: id.nullish(),
  userId: id.nullish(),
  date: DATE,
  minutes: z.number().int().min(1).max(1440),
  notes: z.string().trim().max(500).nullish(),
  billable: z.boolean().optional(),
});

export const POST = route(
  async ({ orgId, user, role, req }) => {
    const input = await body(req, LogInput);
    const who = input.userId ? Number(input.userId) : user.userId;
    if (who !== user.userId && !hasPermission(role, 'projects', 'edit')) throw forbidden('You can log your own time only.');
    const entryId = await transaction(async (trx) => {
      const tid = await logTime(trx, orgId, user.userId, {
        projectId: Number(input.projectId), taskId: input.taskId ? Number(input.taskId) : null, userId: who,
        date: input.date, minutes: input.minutes, notes: input.notes, billable: input.billable,
      });
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'create', targetType: 'time_entry', targetId: tid,
        detail: `${(input.minutes / 60).toFixed(2)} h on project ${input.projectId}, ${input.date}`, ...auditMeta(req),
      });
      return tid;
    });
    return { id: asId(entryId) };
  },
  { permission: { module: 'projects', action: 'create' } },
);

export const DELETE = route(
  async ({ orgId, user, role, req }) => {
    const { id: raw } = query(req, z.object({ id: z.string() }));
    const entryId = Number(raw);
    const row = await db.selectFrom('time_entries').select(['user_id']).where('id', '=', entryId).where('org_id', '=', orgId).executeTakeFirst();
    if (row && row.user_id !== user.userId && !hasPermission(role, 'projects', 'edit')) throw forbidden('You can remove your own time only.');
    await transaction(async (trx) => {
      await deleteTime(trx, orgId, entryId);
      await logAudit({ trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'void', targetType: 'time_entry', targetId: entryId, detail: 'Time entry removed', ...auditMeta(req) });
    });
    return { id: asId(entryId) };
  },
  { permission: { module: 'projects', action: 'create' } },
);
