import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, query, asId } from '@/lib/server/http';
import { toPaiseFromSql } from '@/lib/server/money-sql';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { projectFigures, saveProject } from '@/lib/server/services/projects';

// Projects: the list with each one's hours, billing and profit, and saving one
// (services/projects.ts).

export const GET = route(
  async ({ orgId, req }) => {
    const q = query(req, z.object({
      status: z.enum(['active', 'completed', 'archived', 'all']).default('active'),
      customerId: z.string().optional(),
    }));
    let rows = db.selectFrom('projects as p').innerJoin('contacts as c', 'c.id', 'p.customer_id')
      .select(['p.id', 'p.name', 'p.code', 'p.billing_method', 'p.rate', 'p.fixed_amount', 'p.budget_hours', 'p.status',
        'p.start_date', 'p.end_date', 'p.customer_id', 'c.display_name as customer_name'])
      .where('p.org_id', '=', orgId);
    if (q.status !== 'all') rows = rows.where('p.status', '=', q.status);
    if (q.customerId) rows = rows.where('p.customer_id', '=', Number(q.customerId));
    const list = await rows.orderBy('p.name').execute();
    const figures = await projectFigures(db, orgId, list.map((p) => p.id));
    return {
      projects: list.map((p) => ({
        id: asId(p.id),
        name: p.name,
        code: p.code,
        customerId: asId(p.customer_id),
        customerName: p.customer_name,
        billingMethod: p.billing_method,
        ratePaise: toPaiseFromSql(p.rate),
        fixedAmountPaise: toPaiseFromSql(p.fixed_amount),
        budgetHours: p.budget_hours == null ? null : Number(p.budget_hours),
        status: p.status,
        startDate: p.start_date ? String(p.start_date).slice(0, 10) : null,
        endDate: p.end_date ? String(p.end_date).slice(0, 10) : null,
        ...figures.get(p.id)!,
      })),
    };
  },
  { permission: { module: 'projects', action: 'view' } },
);

const id = z.union([z.string(), z.number()]);
const SaveInput = z.object({
  id: id.nullish(),
  customerId: id,
  name: z.string().trim().min(1, 'Give the project a name.').max(200),
  code: z.string().trim().max(40).nullish(),
  description: z.string().trim().max(1000).nullish(),
  billingMethod: z.enum(['fixed', 'project_hours', 'task_hours', 'staff_hours']),
  ratePaise: z.number().int().nonnegative().optional(),
  fixedAmountPaise: z.number().int().nonnegative().optional(),
  budgetHours: z.number().nonnegative().nullish(),
  budgetAmountPaise: z.number().int().nonnegative().nullish(),
  sacCode: z.string().trim().max(10).nullish(),
  gstRatePct: z.number().min(0).max(28).optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  status: z.enum(['active', 'completed', 'archived']).optional(),
  tasks: z.array(z.object({ id: id.nullish(), name: z.string().trim().max(200), ratePaise: z.number().int().nonnegative().optional(), billable: z.boolean().optional() })).max(200).optional(),
  users: z.array(z.object({ userId: id, ratePaise: z.number().int().nonnegative().optional(), costRatePaise: z.number().int().nonnegative().optional() })).max(200).optional(),
});

export const POST = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, SaveInput);
    const projectId = await transaction(async (trx) => {
      const pid = await saveProject(trx, orgId, user.userId, {
        ...input,
        id: input.id ? Number(input.id) : null,
        customerId: Number(input.customerId),
        tasks: input.tasks?.map((t) => ({ ...t, id: t.id ? Number(t.id) : null })),
        users: input.users?.map((u) => ({ ...u, userId: Number(u.userId) })),
      });
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: input.id ? 'update' : 'create',
        targetType: 'project', targetId: pid, targetLabel: input.name,
        detail: input.id ? 'Project changed' : `Project for customer ${input.customerId}, billed ${input.billingMethod.replace('_', ' ')}`,
        ...auditMeta(req),
      });
      return pid;
    });
    return { id: asId(projectId) };
  },
  { permission: { module: 'projects', action: 'create' } },
);
