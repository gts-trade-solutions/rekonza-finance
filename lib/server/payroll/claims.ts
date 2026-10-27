import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Reimbursement claims: an employee's expenses, with the bills attached,
// approved by someone with payroll approval and repaid with the next salary.
// A repaid expense is not salary, so it is not taxed and goes to Staff
// Reimbursements, not Salaries. Once the payroll that repays it is posted, a
// claim can no longer be changed.
// ─────────────────────────────────────────────────────────────────────────────

import type { Executor, Trx } from '../db';
import type { Paise } from '../../types';
import { toPaiseFromSql, toSqlFromPaise } from '../money-sql';
import { badRequest, conflict, notFound } from '../http';

const p = toPaiseFromSql;

export const CLAIM_CATEGORIES = ['Travel', 'Local conveyance', 'Meals', 'Fuel', 'Phone and internet', 'Medical', 'Other'] as const;

export async function saveClaim(trx: Trx, orgId: number, userId: number | null, input: {
  employeeId: number; claimDate: string; category: string; description?: string | null; amountPaise: Paise;
}): Promise<number> {
  const e = await trx.selectFrom('employees').select('id').where('id', '=', input.employeeId).where('org_id', '=', orgId).executeTakeFirst();
  if (!e) throw notFound('That employee was not found.');
  if (!(input.amountPaise > 0)) throw badRequest('Give the amount claimed.');
  if (!input.category.trim()) throw badRequest('Say what the expense was for.');
  return Number((await trx.insertInto('reimbursement_claims').values({
    org_id: orgId, employee_id: e.id, claim_date: input.claimDate, category: input.category.trim().slice(0, 60),
    description: input.description?.trim() || null, amount: toSqlFromPaise(input.amountPaise), created_by_user_id: userId,
  }).executeTakeFirstOrThrow()).insertId);
}

/** Approve or reject a claim; one already repaid by a posted payroll stays as it is. */
export async function reviewClaim(trx: Trx, orgId: number, userId: number | null, id: number, o: { approve: boolean; note?: string | null }) {
  const c = await trx.selectFrom('reimbursement_claims as c').leftJoin('payroll_runs as r', 'r.id', 'c.paid_in_run_id')
    .select(['c.id', 'c.status', 'r.status as run_status', 'r.month'])
    .where('c.id', '=', id).where('c.org_id', '=', orgId).executeTakeFirst();
  if (!c) throw notFound('That claim was not found.');
  if (c.run_status && c.run_status !== 'draft') throw conflict(`It was repaid with the ${c.month} payroll, which is ${c.run_status}.`);
  if (!o.approve && !o.note?.trim()) throw badRequest('Say why it is rejected.');
  await trx.updateTable('reimbursement_claims').set({
    status: o.approve ? 'approved' : 'rejected', review_note: o.note?.trim() || null, reviewed_by_user_id: userId,
    // Rejected, it leaves the draft payroll it was on; the next recompute drops it.
    ...(o.approve ? {} : { paid_in_run_id: null }),
  }).where('id', '=', id).execute();
}

/**
 * Put a month's approved claims on its payroll: those dated by the month's
 * end and not repaid by another. Returns each employee's total.
 */
export async function claimsForRun(trx: Trx, orgId: number, runId: number, monthEnd: string): Promise<Map<number, Paise>> {
  await trx.updateTable('reimbursement_claims').set({ paid_in_run_id: null })
    .where('org_id', '=', orgId).where('paid_in_run_id', '=', runId).execute();
  const due = await trx.selectFrom('reimbursement_claims').select(['id', 'employee_id', 'amount'])
    .where('org_id', '=', orgId).where('status', '=', 'approved').where('paid_in_run_id', 'is', null)
    .where('claim_date', '<=', monthEnd).execute();
  if (due.length) {
    await trx.updateTable('reimbursement_claims').set({ paid_in_run_id: runId }).where('id', 'in', due.map((c) => c.id)).execute();
  }
  const by = new Map<number, Paise>();
  for (const c of due) by.set(c.employee_id, (by.get(c.employee_id) ?? 0) + p(c.amount));
  return by;
}

export async function listClaims(ex: Executor, orgId: number) {
  const rows = await ex.selectFrom('reimbursement_claims as c').innerJoin('employees as e', 'e.id', 'c.employee_id')
    .leftJoin('payroll_runs as r', 'r.id', 'c.paid_in_run_id')
    .select(['c.id', 'c.employee_id', 'e.code', 'e.name', 'c.claim_date', 'c.category', 'c.description', 'c.amount',
      'c.status', 'c.review_note', 'c.paid_in_run_id', 'r.month', 'r.status as run_status'])
    .where('c.org_id', '=', orgId).orderBy('c.claim_date', 'desc').orderBy('c.id', 'desc').limit(500).execute();
  return rows.map((r) => ({
    id: String(r.id), employeeId: String(r.employee_id), code: r.code, name: r.name, claimDate: String(r.claim_date).slice(0, 10),
    category: r.category, description: r.description, amountPaise: p(r.amount), status: r.status, reviewNote: r.review_note,
    runId: r.paid_in_run_id ? String(r.paid_in_run_id) : null, runMonth: r.month ?? null, runStatus: r.run_status ?? null,
  }));
}
