import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Projects and timesheets: work done for a customer, the time logged to it,
// and the invoices that bill it (migration 084).
//
// The rate an hour is billed at follows the project's billing method:
//
//   fixed          a fee, billed in whole or in parts; hours are not billed
//   project_hours  every hour at the project's rate
//   task_hours     each hour at its task's rate
//   staff_hours    each hour at the rate of the person who worked it
//
// Billing goes through createInvoice, so the GST, the number and the entry are
// a hand-raised invoice's. The hours and billable expenses it takes are marked
// with the invoice, so none is billed twice; voiding the invoice releases them
// (voidInvoice in sales.ts).
//
// A re-charged expense is billed at what it cost the business: net of GST when
// the credit was claimed, gross when it was not, since the blocked tax was a
// cost. GST is then charged on it at the project's rate — recovering a cost
// from a customer is a supply, unless the business acted only as a pure agent
// (Rule 33), which is not something software can decide; the line can be
// edited off the invoice draft if it was.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor, Trx } from '../db';
import type { Paise } from '../../types';
import { toPaiseFromSql, toSqlFromPaise } from '../money-sql';
import { badRequest, conflict, notFound } from '../http';
import { createInvoice, type InvoiceLineInput } from './sales';
import { getPolicies } from './org-settings';

export type BillingMethod = 'fixed' | 'project_hours' | 'task_hours' | 'staff_hours';

export interface ProjectInput {
  id?: number | null;
  customerId: number;
  name: string;
  code?: string | null;
  description?: string | null;
  billingMethod: BillingMethod;
  ratePaise?: Paise;
  fixedAmountPaise?: Paise;
  budgetHours?: number | null;
  budgetAmountPaise?: Paise | null;
  sacCode?: string | null;
  gstRatePct?: number;
  startDate?: string | null;
  endDate?: string | null;
  status?: 'active' | 'completed' | 'archived';
  /** Tasks by id to keep or change; without an id, new. One left out is set inactive, not deleted: its hours stay. */
  tasks?: { id?: number | null; name: string; ratePaise?: Paise; billable?: boolean }[];
  users?: { userId: number; ratePaise?: Paise; costRatePaise?: Paise }[];
}

export async function saveProject(trx: Trx, orgId: number, userId: number | null, input: ProjectInput): Promise<number> {
  if (!input.name.trim()) throw badRequest('Give the project a name.');
  const customer = await trx.selectFrom('contacts').select('id').where('id', '=', input.customerId).where('org_id', '=', orgId).executeTakeFirst();
  if (!customer) throw notFound('That customer does not exist.');
  if (input.billingMethod === 'fixed' && !(input.fixedAmountPaise && input.fixedAmountPaise > 0)) throw badRequest('A fixed-fee project needs its fee.');
  if (input.billingMethod === 'project_hours' && !(input.ratePaise && input.ratePaise > 0)) throw badRequest('Billing by project hours needs the rate an hour.');
  if (input.endDate && input.startDate && input.endDate < input.startDate) throw badRequest('A project cannot end before it starts.');

  const values = {
    customer_id: input.customerId,
    name: input.name.trim().slice(0, 200),
    code: input.code?.trim() || null,
    description: input.description?.trim() || null,
    billing_method: input.billingMethod,
    rate: toSqlFromPaise(input.ratePaise ?? 0),
    fixed_amount: toSqlFromPaise(input.fixedAmountPaise ?? 0),
    budget_hours: input.budgetHours == null ? null : String(input.budgetHours),
    budget_amount: input.budgetAmountPaise == null ? null : toSqlFromPaise(input.budgetAmountPaise),
    sac_code: input.sacCode?.trim() || null,
    gst_rate_pct: String(input.gstRatePct ?? 18),
    start_date: input.startDate || null,
    end_date: input.endDate || null,
    status: input.status ?? 'active',
  };
  let id: number;
  if (input.id) {
    const found = await trx.selectFrom('projects').select('id').where('id', '=', input.id).where('org_id', '=', orgId).executeTakeFirst();
    if (!found) throw notFound('That project does not exist.');
    id = found.id;
    await trx.updateTable('projects').set(values).where('id', '=', id).execute();
  } else {
    id = Number((await trx.insertInto('projects').values({ org_id: orgId, created_by_user_id: userId, ...values }).executeTakeFirstOrThrow()).insertId);
  }

  if (input.tasks) {
    const existing = await trx.selectFrom('project_tasks').select('id').where('project_id', '=', id).execute();
    const kept = new Set<number>();
    for (const t of input.tasks) {
      if (!t.name.trim()) continue;
      const row = { name: t.name.trim().slice(0, 200), rate: toSqlFromPaise(t.ratePaise ?? 0), billable: t.billable === false ? 0 : 1, is_active: 1 };
      if (t.id && existing.some((e) => e.id === t.id)) {
        await trx.updateTable('project_tasks').set(row).where('id', '=', t.id).execute();
        kept.add(t.id);
      } else {
        kept.add(Number((await trx.insertInto('project_tasks').values({ org_id: orgId, project_id: id, ...row }).executeTakeFirstOrThrow()).insertId));
      }
    }
    const gone = existing.map((e) => e.id).filter((e) => !kept.has(e));
    if (gone.length) await trx.updateTable('project_tasks').set({ is_active: 0 }).where('id', 'in', gone).execute();
  }
  if (input.users) {
    const ids = input.users.map((u) => u.userId);
    if (ids.length) {
      const known = await trx.selectFrom('users').select('id').where('org_id', '=', orgId).where('id', 'in', ids).execute();
      if (known.length !== new Set(ids).size) throw badRequest('Someone on the project is not a user of this company.');
    }
    await trx.deleteFrom('project_users').where('project_id', '=', id).$if(ids.length > 0, (q) => q.where('user_id', 'not in', ids)).execute();
    for (const u of input.users) {
      const row = { rate: toSqlFromPaise(u.ratePaise ?? 0), cost_rate: toSqlFromPaise(u.costRatePaise ?? 0) };
      const r = await trx.updateTable('project_users').set(row).where('project_id', '=', id).where('user_id', '=', u.userId).executeTakeFirst();
      if (!Number(r.numUpdatedRows)) await trx.insertInto('project_users').values({ org_id: orgId, project_id: id, user_id: u.userId, ...row }).execute();
    }
  }
  return id;
}

// ── Time ────────────────────────────────────────────────────────────────────

export interface TimeInput {
  projectId: number;
  taskId?: number | null;
  userId: number;
  date: string;
  minutes: number;
  notes?: string | null;
  billable?: boolean;
}

export async function logTime(trx: Trx, orgId: number, actorUserId: number | null, input: TimeInput): Promise<number> {
  if (!Number.isInteger(input.minutes) || input.minutes <= 0 || input.minutes > 1440) throw badRequest('Log between one minute and 24 hours.');
  const project = await trx.selectFrom('projects').select(['id', 'status', 'billing_method']).where('id', '=', input.projectId).where('org_id', '=', orgId).executeTakeFirst();
  if (!project) throw notFound('That project does not exist.');
  if (project.status !== 'active') throw conflict('That project is not active; time can only be logged to an active project.');
  let billable = input.billable !== false;
  if (input.taskId) {
    const task = await trx.selectFrom('project_tasks').select(['id', 'billable', 'is_active']).where('id', '=', input.taskId).where('project_id', '=', project.id).executeTakeFirst();
    if (!task || !task.is_active) throw notFound('That task is not on this project.');
    if (!task.billable) billable = false;
  } else if (project.billing_method === 'task_hours') {
    throw badRequest('This project is billed by task: pick the task the time was spent on.');
  }
  const user = await trx.selectFrom('users').select('id').where('id', '=', input.userId).where('org_id', '=', orgId).executeTakeFirst();
  if (!user) throw notFound('That person is not a user of this company.');
  // With timesheet approval on, the time waits for someone else to approve it.
  const approval = (await getPolicies(trx, orgId)).controls.timesheetApproval ? 'pending' as const : null;
  return Number((await trx.insertInto('time_entries').values({
    org_id: orgId, project_id: project.id, task_id: input.taskId ?? null, user_id: input.userId, entry_date: input.date,
    minutes: input.minutes, notes: input.notes?.trim().slice(0, 500) || null, billable: billable ? 1 : 0, created_by_user_id: actorUserId,
    approval_status: approval,
  }).executeTakeFirstOrThrow()).insertId);
}

// ── The timer, and approving timesheets ─────────────────────────────────────

/** The timer running for a person, if any. */
export async function runningTimer(ex: Executor, orgId: number, userId: number) {
  const t = await ex.selectFrom('time_timers as t').innerJoin('projects as p', 'p.id', 't.project_id').leftJoin('project_tasks as k', 'k.id', 't.task_id')
    .select(['t.id', 't.project_id', 't.task_id', 't.notes', 't.billable', 't.started_at', 'p.name as project_name', 'k.name as task_name'])
    .where('t.org_id', '=', orgId).where('t.user_id', '=', userId).executeTakeFirst();
  if (!t) return null;
  return {
    id: String(t.id), projectId: String(t.project_id), projectName: t.project_name, taskId: t.task_id ? String(t.task_id) : null, taskName: t.task_name,
    notes: t.notes, billable: !!t.billable, startedAt: new Date(t.started_at).toISOString(),
  };
}

/** Start a person's timer on a project. One runs at a time: stop it first. */
export async function startTimer(trx: Trx, orgId: number, userId: number, input: { projectId: number; taskId?: number | null; notes?: string | null; billable?: boolean }) {
  if (await runningTimer(trx, orgId, userId)) throw conflict('Your timer is already running. Stop it first.');
  const project = await trx.selectFrom('projects').select(['id', 'status', 'billing_method']).where('id', '=', input.projectId).where('org_id', '=', orgId).executeTakeFirst();
  if (!project) throw notFound('That project does not exist.');
  if (project.status !== 'active') throw conflict('That project is not active; time can only be logged to an active project.');
  if (!input.taskId && project.billing_method === 'task_hours') throw badRequest('This project is billed by task: pick the task first.');
  if (input.taskId) {
    const task = await trx.selectFrom('project_tasks').select('id').where('id', '=', input.taskId).where('project_id', '=', project.id).where('is_active', '=', 1).executeTakeFirst();
    if (!task) throw notFound('That task is not on this project.');
  }
  await trx.insertInto('time_timers').values({
    org_id: orgId, user_id: userId, project_id: project.id, task_id: input.taskId ?? null, notes: input.notes?.trim().slice(0, 500) || null, billable: input.billable === false ? 0 : 1,
  }).execute();
  return runningTimer(trx, orgId, userId);
}

/**
 * Stop a person's timer: the time since it started is logged to its project,
 * on the day it started (India time), in whole minutes — at least one, at most
 * a day. Discarding stops it without logging anything.
 */
export async function stopTimer(trx: Trx, orgId: number, userId: number, opts: { discard?: boolean; notes?: string | null; now?: Date } = {}) {
  const t = await trx.selectFrom('time_timers').selectAll().where('org_id', '=', orgId).where('user_id', '=', userId).forUpdate().executeTakeFirst();
  if (!t) throw notFound('Your timer is not running.');
  await trx.deleteFrom('time_timers').where('id', '=', t.id).execute();
  if (opts.discard) return { entryId: null, minutes: 0 };
  const started = new Date(t.started_at);
  const minutes = Math.min(1440, Math.max(1, Math.round(((opts.now ?? new Date()).getTime() - started.getTime()) / 60_000)));
  const date = new Date(started.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);
  const entryId = await logTime(trx, orgId, userId, {
    projectId: t.project_id, taskId: t.task_id, userId, date, minutes, notes: opts.notes?.trim() || t.notes, billable: !!t.billable,
  });
  return { entryId, minutes };
}

/** Approve or turn back logged time. Nobody approves their own; billed time is settled already. */
export async function decideTime(trx: Trx, orgId: number, approverId: number, ids: number[], decision: 'approved' | 'rejected', note?: string | null) {
  if (!ids.length) throw badRequest('Choose the time to decide on.');
  const rows = await trx.selectFrom('time_entries').select(['id', 'user_id', 'approval_status', 'invoice_id']).where('org_id', '=', orgId).where('id', 'in', ids).forUpdate().execute();
  if (rows.length !== new Set(ids).size) throw notFound('Some of that time was not found.');
  if (rows.some((r) => r.user_id === approverId)) throw badRequest('Your own time is approved by someone else.');
  if (rows.some((r) => r.invoice_id)) throw conflict('Some of that time is billed already.');
  if (rows.some((r) => r.approval_status !== 'pending')) throw conflict('Only time waiting for approval can be approved or turned back. Refresh the list.');
  if (decision === 'rejected' && !note?.trim()) throw badRequest('Say why it is turned back, so the person can put it right.');
  await trx.updateTable('time_entries').set({ approval_status: decision, approved_by_user_id: approverId, approved_at: new Date(), approval_note: note?.trim().slice(0, 300) || null })
    .where('org_id', '=', orgId).where('id', 'in', ids).execute();
  return { count: rows.length, people: [...new Set(rows.map((r) => r.user_id))] };
}

/** Time already billed stays: the invoice is the record of it. Void the invoice to free it first. */
export async function deleteTime(trx: Trx, orgId: number, id: number) {
  const row = await trx.selectFrom('time_entries').select(['id', 'invoice_id']).where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
  if (!row) throw notFound('That time entry does not exist.');
  if (row.invoice_id) throw conflict('That time has been billed. Void the invoice first if it should not have been.');
  await trx.deleteFrom('time_entries').where('id', '=', id).execute();
}

// ── What is unbilled, and billing it ────────────────────────────────────────

export interface UnbilledLine {
  /** Task, person or project the hours are grouped under. */
  label: string;
  minutes: number;
  ratePaise: Paise;
  amountPaise: Paise;
  entryIds: number[];
}

export interface Unbilled {
  method: BillingMethod;
  time: UnbilledLine[];
  expenses: { id: number; number: string; date: string; notes: string | null; amountPaise: Paise }[];
  /** A fixed-fee project: the fee, what has been billed of it, what is left. */
  fixed: { feePaise: Paise; billedPaise: Paise; leftPaise: Paise } | null;
  totalPaise: Paise;
}

const hoursOf = (minutes: number) => Math.round((minutes / 60) * 100) / 100;

export async function unbilled(ex: Executor, orgId: number, projectId: number, through?: string): Promise<Unbilled> {
  const p = await ex.selectFrom('projects').selectAll().where('id', '=', projectId).where('org_id', '=', orgId).executeTakeFirst();
  if (!p) throw notFound('That project does not exist.');
  const method = p.billing_method as BillingMethod;

  let q = ex.selectFrom('time_entries as t')
    .leftJoin('project_tasks as k', 'k.id', 't.task_id')
    .innerJoin('users as u', 'u.id', 't.user_id')
    .leftJoin('project_users as pu', (j) => j.onRef('pu.project_id', '=', 't.project_id').onRef('pu.user_id', '=', 't.user_id'))
    .select(['t.id', 't.minutes', 't.task_id', 't.user_id', 'k.name as task_name', 'k.rate as task_rate', 'u.name as user_name', 'pu.rate as user_rate'])
    .where('t.org_id', '=', orgId).where('t.project_id', '=', projectId)
    .where('t.billable', '=', 1).where('t.invoice_id', 'is', null)
    // Time waiting for approval, or turned back, is not billed (NULL: logged while approval was off).
    .where((eb) => eb.or([eb('t.approval_status', 'is', null), eb('t.approval_status', '=', 'approved')]));
  if (through) q = q.where('t.entry_date', '<=', through);
  const entries = await q.orderBy('t.entry_date').execute();

  const groups = new Map<string, UnbilledLine>();
  if (method !== 'fixed') {
    for (const e of entries) {
      const key = method === 'task_hours' ? `t${e.task_id}` : method === 'staff_hours' ? `u${e.user_id}` : `t${e.task_id ?? 0}`;
      const label = method === 'staff_hours' ? e.user_name : e.task_name ?? p.name;
      const ratePaise = method === 'task_hours' ? toPaiseFromSql(e.task_rate ?? '0')
        : method === 'staff_hours' ? toPaiseFromSql(e.user_rate ?? '0')
        : toPaiseFromSql(p.rate);
      const g = groups.get(key) ?? { label, minutes: 0, ratePaise, amountPaise: 0, entryIds: [] };
      g.minutes += e.minutes;
      g.entryIds.push(e.id);
      groups.set(key, g);
    }
  }
  // Billed as hours (to two places) at the rate, the same sum the invoice line will make.
  const time = [...groups.values()].map((g) => ({ ...g, amountPaise: Math.round(hoursOf(g.minutes) * g.ratePaise) }))
    .filter((g) => g.ratePaise > 0);

  let eq = ex.selectFrom('expenses')
    .select(['id', 'number', 'expense_date', 'notes', 'amount', 'total', 'itc_eligibility'])
    .where('org_id', '=', orgId).where('project_id', '=', projectId).where('is_billable', '=', 1)
    .where('billed_invoice_id', 'is', null).where('status', '<>', 'void');
  if (through) eq = eq.where('expense_date', '<=', through);
  const expenses = (await eq.orderBy('expense_date').execute()).map((x) => ({
    id: x.id, number: x.number, date: String(x.expense_date).slice(0, 10), notes: x.notes,
    // Its cost to the business: net when the credit was claimed, gross when it was blocked.
    amountPaise: x.itc_eligibility === 'ineligible' ? toPaiseFromSql(x.total) : toPaiseFromSql(x.amount),
  }));

  let fixed: Unbilled['fixed'] = null;
  if (method === 'fixed') {
    const billed = await sql<{ v: string }>`
      SELECT COALESCE(SUM(subtotal), 0) AS v FROM invoices
       WHERE org_id = ${orgId} AND project_id = ${projectId} AND status NOT IN ('draft', 'void')
    `.execute(ex);
    const feePaise = toPaiseFromSql(p.fixed_amount);
    // Re-charged expenses are not part of the fee.
    const expensesBilled = await sql<{ v: string }>`
      SELECT COALESCE(SUM(IF(itc_eligibility = 'ineligible', total, amount)), 0) AS v FROM expenses
       WHERE org_id = ${orgId} AND project_id = ${projectId} AND billed_invoice_id IS NOT NULL
    `.execute(ex);
    const billedPaise = toPaiseFromSql(billed.rows[0]?.v ?? '0') - toPaiseFromSql(expensesBilled.rows[0]?.v ?? '0');
    fixed = { feePaise, billedPaise, leftPaise: Math.max(feePaise - billedPaise, 0) };
  }
  const totalPaise = time.reduce((t, l) => t + l.amountPaise, 0) + expenses.reduce((t, x) => t + x.amountPaise, 0) + (fixed?.leftPaise ?? 0);
  return { method, time, expenses, fixed, totalPaise };
}

export interface BillProjectInput {
  projectId: number;
  branchId: number;
  date: string;
  dueDate: string;
  /** Bill time and expenses up to and including this date. */
  through?: string;
  includeExpenses?: boolean;
  /** A fixed-fee project: how much of the fee to bill now; the rest of it when left out. */
  fixedPaise?: Paise;
  status?: 'draft' | 'approved';
}

export async function billProject(trx: Trx, orgId: number, userId: number | null, input: BillProjectInput) {
  const p = await trx.selectFrom('projects').selectAll().where('id', '=', input.projectId).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!p) throw notFound('That project does not exist.');
  const u = await unbilled(trx, orgId, p.id, input.through);
  const gst = Number(p.gst_rate_pct);
  const sac = p.sac_code || null;
  const lines: InvoiceLineInput[] = [];
  const entryIds: number[] = [];

  if (u.fixed) {
    const amount = input.fixedPaise ?? u.fixed.leftPaise;
    if (amount > u.fixed.leftPaise) throw badRequest(`Only ₹${(u.fixed.leftPaise / 100).toLocaleString('en-IN')} of the fee is left to bill.`);
    if (amount > 0) {
      const part = amount === u.fixed.feePaise ? '' : ` (₹${(amount / 100).toLocaleString('en-IN')} of ₹${(u.fixed.feePaise / 100).toLocaleString('en-IN')})`;
      lines.push({ description: `${p.name}: fixed fee${part}`, hsnSac: sac, qty: 1, ratePaise: amount, gstRatePct: gst });
    }
  }
  for (const t of u.time) {
    lines.push({ description: `${p.name}: ${t.label} — ${hoursOf(t.minutes)} h`, hsnSac: sac, qty: hoursOf(t.minutes), uqc: 'HRS', ratePaise: t.ratePaise, gstRatePct: gst });
    entryIds.push(...t.entryIds);
  }
  const expenses = input.includeExpenses === false ? [] : u.expenses;
  for (const x of expenses) {
    lines.push({ description: `Re-charge: ${x.notes || 'expense'} (${x.number}, ${x.date})`, hsnSac: sac, qty: 1, ratePaise: x.amountPaise, gstRatePct: gst });
  }
  if (!lines.length) throw badRequest('There is nothing unbilled on this project.');

  const inv = await createInvoice(trx, orgId, userId, {
    branchId: input.branchId, customerId: p.customer_id, date: input.date, dueDate: input.dueDate,
    status: input.status ?? 'draft', supplyKind: 'service', subject: p.name, lines,
    sourceDocType: 'project', sourceDocId: p.id,
  });
  await trx.updateTable('invoices').set({ project_id: p.id }).where('id', '=', inv.id).execute();
  // A fixed-fee project's hours are part of the fee: they go with its invoice too, so they stop showing as unbilled.
  if (u.fixed) {
    let fq = trx.updateTable('time_entries').set({ invoice_id: inv.id })
      .where('org_id', '=', orgId).where('project_id', '=', p.id).where('invoice_id', 'is', null);
    if (input.through) fq = fq.where('entry_date', '<=', input.through);
    await fq.execute();
  }
  if (entryIds.length) await trx.updateTable('time_entries').set({ invoice_id: inv.id }).where('id', 'in', entryIds).execute();
  if (expenses.length) await trx.updateTable('expenses').set({ billed_invoice_id: inv.id }).where('id', 'in', expenses.map((x) => x.id)).execute();
  return { invoice: inv, hoursBilled: hoursOf(u.time.reduce((t, l) => t + l.minutes, 0)), expensesBilled: expenses.length };
}

// ── The project's figures ───────────────────────────────────────────────────

export interface ProjectFigures {
  loggedMinutes: number;
  billableMinutes: number;
  unbilledMinutes: number;
  /** Invoiced for the project, before tax, voids left out. */
  billedPaise: Paise;
  /** Time at each person's cost rate, and the expenses booked to the project. */
  timeCostPaise: Paise;
  expenseCostPaise: Paise;
  profitPaise: Paise;
}

export async function projectFigures(ex: Executor, orgId: number, projectIds: number[]): Promise<Map<number, ProjectFigures>> {
  const out = new Map<number, ProjectFigures>();
  if (!projectIds.length) return out;
  const ids = sql.join(projectIds);
  const [time, billed, exp] = await Promise.all([
    sql<{ project_id: number; logged: string; billable: string; unbilled: string; cost: string }>`
      SELECT t.project_id, SUM(t.minutes) AS logged, SUM(IF(t.billable = 1, t.minutes, 0)) AS billable,
             SUM(IF(t.billable = 1 AND t.invoice_id IS NULL, t.minutes, 0)) AS unbilled,
             SUM(t.minutes * COALESCE(pu.cost_rate, 0) / 60) AS cost
        FROM time_entries t
        LEFT JOIN project_users pu ON pu.project_id = t.project_id AND pu.user_id = t.user_id
       WHERE t.org_id = ${orgId} AND t.project_id IN (${ids})
       GROUP BY t.project_id
    `.execute(ex),
    sql<{ project_id: number; v: string }>`
      SELECT project_id, COALESCE(SUM(subtotal), 0) AS v FROM invoices
       WHERE org_id = ${orgId} AND project_id IN (${ids}) AND status NOT IN ('draft', 'void')
       GROUP BY project_id
    `.execute(ex),
    sql<{ project_id: number; v: string }>`
      SELECT project_id, COALESCE(SUM(IF(itc_eligibility = 'ineligible', total, amount)), 0) AS v FROM expenses
       WHERE org_id = ${orgId} AND project_id IN (${ids}) AND status <> 'void'
       GROUP BY project_id
    `.execute(ex),
  ]);
  for (const id of projectIds) {
    const t = time.rows.find((r) => Number(r.project_id) === id);
    const billedPaise = toPaiseFromSql(billed.rows.find((r) => Number(r.project_id) === id)?.v ?? '0');
    const timeCostPaise = Math.round(Number(t?.cost ?? 0) * 100);
    const expenseCostPaise = toPaiseFromSql(exp.rows.find((r) => Number(r.project_id) === id)?.v ?? '0');
    out.set(id, {
      loggedMinutes: Number(t?.logged ?? 0),
      billableMinutes: Number(t?.billable ?? 0),
      unbilledMinutes: Number(t?.unbilled ?? 0),
      billedPaise, timeCostPaise, expenseCostPaise,
      profitPaise: billedPaise - timeCostPaise - expenseCostPaise,
    });
  }
  return out;
}

/**
 * Billable expenses re-charged on an invoice raised by hand: marked with it, so
 * they are not offered again. Each must be this customer's, billable, and not
 * already on an invoice.
 */
export async function chargeExpenses(trx: Trx, orgId: number, invoiceId: number, customerId: number, expenseIds: number[]) {
  if (!expenseIds.length) return;
  const rows = await trx.selectFrom('expenses').select(['id', 'number', 'is_billable', 'billable_customer_id', 'billed_invoice_id', 'status'])
    .where('org_id', '=', orgId).where('id', 'in', expenseIds).forUpdate().execute();
  for (const id of expenseIds) {
    const x = rows.find((r) => r.id === id);
    if (!x) throw notFound('One of the expenses to re-charge does not exist.');
    if (!x.is_billable || x.billable_customer_id !== customerId) throw badRequest(`${x.number} is not billable to this customer.`);
    if (x.billed_invoice_id) throw conflict(`${x.number} has already been re-charged.`);
    if (x.status === 'void') throw badRequest(`${x.number} is void.`);
  }
  await trx.updateTable('expenses').set({ billed_invoice_id: invoiceId }).where('id', 'in', expenseIds).execute();
}
