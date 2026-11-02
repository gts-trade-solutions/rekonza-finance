import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, idParam, asId, forbidden, notFound } from '@/lib/server/http';
import { hasPermission } from '@/lib/rbac';
import { toPaiseFromSql } from '@/lib/server/money-sql';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { queueIrns } from '@/lib/server/gst/auto-irn';
import { billProject, projectFigures, unbilled } from '@/lib/server/services/projects';

/** One project: its set-up, time, expenses, invoices, figures and what is unbilled. */
export const GET = route(
  async ({ orgId, role, params }) => {
    const pid = idParam(params);
    const p = await db.selectFrom('projects as p').innerJoin('contacts as c', 'c.id', 'p.customer_id')
      .selectAll('p').select(['c.display_name as customer_name'])
      .where('p.id', '=', pid).where('p.org_id', '=', orgId).executeTakeFirst();
    if (!p) throw notFound('That project does not exist.');
    const seeSales = hasPermission(role, 'sales', 'view');
    const [tasks, users, entries, expenses, invoices, figures, open] = await Promise.all([
      db.selectFrom('project_tasks').selectAll().where('project_id', '=', pid).orderBy('id').execute(),
      db.selectFrom('project_users as pu').innerJoin('users as u', 'u.id', 'pu.user_id')
        .select(['pu.user_id', 'pu.rate', 'pu.cost_rate', 'u.name']).where('pu.project_id', '=', pid).orderBy('u.name').execute(),
      db.selectFrom('time_entries as t').innerJoin('users as u', 'u.id', 't.user_id').leftJoin('project_tasks as k', 'k.id', 't.task_id')
        .leftJoin('invoices as i', 'i.id', 't.invoice_id')
        .select(['t.id', 't.entry_date', 't.minutes', 't.notes', 't.billable', 't.invoice_id', 't.user_id', 't.task_id', 'u.name as user_name', 'k.name as task_name', 'i.number as invoice_number'])
        .where('t.project_id', '=', pid).orderBy('t.entry_date', 'desc').orderBy('t.id', 'desc').limit(500).execute(),
      db.selectFrom('expenses').select(['id', 'number', 'expense_date', 'notes', 'total', 'is_billable', 'billed_invoice_id', 'status'])
        .where('org_id', '=', orgId).where('project_id', '=', pid).orderBy('expense_date', 'desc').execute(),
      seeSales
        ? db.selectFrom('invoices').select(['id', 'number', 'invoice_date', 'status', 'subtotal', 'total'])
          .where('org_id', '=', orgId).where('project_id', '=', pid).orderBy('invoice_date', 'desc').execute()
        : Promise.resolve([]),
      projectFigures(db, orgId, [pid]),
      unbilled(db, orgId, pid),
    ]);
    return {
      project: {
        id: asId(p.id), name: p.name, code: p.code, description: p.description,
        customerId: asId(p.customer_id), customerName: p.customer_name,
        billingMethod: p.billing_method, ratePaise: toPaiseFromSql(p.rate), fixedAmountPaise: toPaiseFromSql(p.fixed_amount),
        budgetHours: p.budget_hours == null ? null : Number(p.budget_hours),
        budgetAmountPaise: p.budget_amount == null ? null : toPaiseFromSql(p.budget_amount),
        sacCode: p.sac_code, gstRatePct: Number(p.gst_rate_pct), status: p.status,
        startDate: p.start_date ? String(p.start_date).slice(0, 10) : null,
        endDate: p.end_date ? String(p.end_date).slice(0, 10) : null,
      },
      tasks: tasks.map((t) => ({ id: asId(t.id), name: t.name, ratePaise: toPaiseFromSql(t.rate), billable: !!t.billable, isActive: !!t.is_active })),
      users: users.map((u) => ({ userId: asId(u.user_id), name: u.name, ratePaise: toPaiseFromSql(u.rate), costRatePaise: toPaiseFromSql(u.cost_rate) })),
      entries: entries.map((e) => ({
        id: asId(e.id), date: String(e.entry_date).slice(0, 10), minutes: e.minutes, notes: e.notes, billable: !!e.billable,
        userId: asId(e.user_id), userName: e.user_name, taskId: e.task_id ? asId(e.task_id) : null, taskName: e.task_name,
        invoiceId: e.invoice_id ? asId(e.invoice_id) : null, invoiceNumber: e.invoice_number,
      })),
      expenses: expenses.map((x) => ({
        id: asId(x.id), number: x.number, date: String(x.expense_date).slice(0, 10), notes: x.notes, totalPaise: toPaiseFromSql(x.total),
        billable: !!x.is_billable, billed: !!x.billed_invoice_id, status: x.status,
      })),
      invoices: invoices.map((i) => ({
        id: asId(i.id), number: i.number, date: String(i.invoice_date).slice(0, 10), status: i.status,
        subtotalPaise: toPaiseFromSql(i.subtotal), totalPaise: toPaiseFromSql(i.total),
      })),
      figures: figures.get(pid)!,
      unbilled: {
        method: open.method,
        time: open.time.map(({ entryIds, ...l }) => ({ ...l, entries: entryIds.length })),
        expenses: open.expenses.map((x) => ({ ...x, id: asId(x.id) })),
        fixed: open.fixed,
        totalPaise: open.totalPaise,
      },
    };
  },
  { permission: { module: 'projects', action: 'view' } },
);

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a yyyy-mm-dd date.');
const ActionInput = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('bill'),
    date: DATE, dueDate: DATE, through: DATE.optional(),
    includeExpenses: z.boolean().optional(), fixedPaise: z.number().int().positive().optional(),
    status: z.enum(['draft', 'approved']).optional(),
  }),
  z.object({ action: z.literal('status'), status: z.enum(['active', 'completed', 'archived']) }),
]);

/** Bill what is unbilled, or close, archive or reopen the project. */
export const POST = route(
  async ({ orgId, user, role, branchId, params, req }) => {
    const pid = idParam(params);
    const input = await body(req, ActionInput);
    if (input.action === 'status') {
      if (!hasPermission(role, 'projects', 'edit')) throw forbidden('You cannot change projects.');
      const r = await db.updateTable('projects').set({ status: input.status }).where('id', '=', pid).where('org_id', '=', orgId).executeTakeFirst();
      if (!Number(r.numUpdatedRows)) throw notFound('That project does not exist.');
      await logAudit({ orgId, actorUserId: user.userId, actorName: user.name, action: 'update', targetType: 'project', targetId: pid, detail: `Marked ${input.status}`, ...auditMeta(req) });
      return { id: asId(pid), status: input.status };
    }
    // Billing raises an invoice, which is sales' to raise.
    if (!hasPermission(role, 'sales', 'create')) throw forbidden('Billing a project raises an invoice; your role cannot raise invoices.');
    const r = await transaction(async (trx) => {
      const out = await billProject(trx, orgId, user.userId, { projectId: pid, branchId, ...input });
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'create', targetType: 'invoice', targetId: out.invoice.id,
        targetLabel: out.invoice.number, detail: `Billed project ${pid}: ${out.hoursBilled} h, ${out.expensesBilled} expense(s)`, ...auditMeta(req),
      });
      return out;
    });
    if (r.invoice.journalEntryId) await queueIrns(db, orgId, { invoiceId: r.invoice.id, userId: user.userId }).catch((err) => console.error('[auto-irn]', err));
    return { invoiceId: asId(r.invoice.id), number: r.invoice.number, totalPaise: r.invoice.totalPaise, hoursBilled: r.hoursBilled, warnings: r.invoice.warnings ?? [] };
  },
  { permission: { module: 'projects', action: 'view' } },
);
