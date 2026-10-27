import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Investment declarations and proofs, for TDS under the old regime.
//
// Early in the year an employee declares what they mean to invest or spend
// (PPF, insurance, a home loan's interest, rent); TDS is worked out on those.
// Towards the year's end they bring the proofs, and from January only what has
// been proved and accepted counts — so the last three months' TDS catches up
// with any declaration that was never borne out. Under the new regime none of
// this reduces tax, and the declarations are kept only as a record.
// ─────────────────────────────────────────────────────────────────────────────

import type { Executor, Trx } from '../db';
import type { Paise } from '../../types';
import type { DeductionSection } from '../../payroll/statutory';
import { toPaiseFromSql, toSqlFromPaise } from '../money-sql';
import { badRequest, conflict, notFound } from '../http';

const p = toPaiseFromSql;

export const SECTIONS: { key: DeductionSection; label: string }[] = [
  { key: '80C', label: '80C: PF, PPF, life insurance, ELSS, tuition, home loan principal' },
  { key: '80CCD1B', label: '80CCD(1B): own NPS contribution' },
  { key: '80D', label: '80D: health insurance' },
  { key: '80E', label: '80E: interest on an education loan' },
  { key: '80G', label: '80G: donations (the deductible part)' },
  { key: '80TTA', label: '80TTA: savings-account interest' },
  { key: '24B', label: '24(b): interest on a home loan' },
  { key: 'HRA', label: 'HRA: rent paid in the year' },
  { key: 'other', label: 'Other deduction' },
];

/** From January the proofs decide, not the declarations. */
export const proofsDecide = (month: string) => Number(month.slice(5)) <= 3;

export async function saveDeclaration(trx: Trx, orgId: number, input: {
  id?: number; employeeId: number; fyStart: number; section: DeductionSection; description?: string | null; declaredPaise: Paise;
}): Promise<number> {
  const e = await trx.selectFrom('employees').select('id').where('id', '=', input.employeeId).where('org_id', '=', orgId).executeTakeFirst();
  if (!e) throw notFound('That employee was not found.');
  if (input.declaredPaise < 0) throw badRequest('A declaration is an amount of nothing or more.');
  const values = {
    section: input.section, description: input.description?.trim() || null, declared: toSqlFromPaise(input.declaredPaise),
  };
  if (input.id) {
    const d = await trx.selectFrom('tax_declarations').select(['status']).where('id', '=', input.id).where('org_id', '=', orgId).executeTakeFirst();
    if (!d) throw notFound('That declaration was not found.');
    if (d.status === 'accepted') throw conflict('Its proof has been accepted; it can no longer be changed.');
    await trx.updateTable('tax_declarations').set(values).where('id', '=', input.id).execute();
    return input.id;
  }
  return Number((await trx.insertInto('tax_declarations').values({
    org_id: orgId, employee_id: e.id, fy_start: input.fyStart, ...values,
  }).executeTakeFirstOrThrow()).insertId);
}

/** The proof is in: what it bears out, waiting to be checked. */
export async function submitProof(trx: Trx, orgId: number, id: number, provedPaise: Paise) {
  const d = await trx.selectFrom('tax_declarations').select(['status']).where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
  if (!d) throw notFound('That declaration was not found.');
  if (d.status === 'accepted') throw conflict('Its proof has already been accepted.');
  if (provedPaise < 0) throw badRequest('A proof bears out an amount of nothing or more.');
  await trx.updateTable('tax_declarations').set({ proved: toSqlFromPaise(provedPaise), status: 'submitted', review_note: null }).where('id', '=', id).execute();
}

export async function reviewProof(trx: Trx, orgId: number, userId: number | null, id: number, o: { accept: boolean; provedPaise?: Paise; note?: string | null }) {
  const d = await trx.selectFrom('tax_declarations').select(['status', 'proved']).where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
  if (!d) throw notFound('That declaration was not found.');
  if (d.status !== 'submitted') throw conflict('There is no proof waiting to be checked.');
  if (!o.accept && !o.note?.trim()) throw badRequest('Say why the proof is not accepted.');
  await trx.updateTable('tax_declarations').set({
    status: o.accept ? 'accepted' : 'rejected', reviewed_by_user_id: userId, review_note: o.note?.trim() || null,
    ...(o.accept && o.provedPaise !== undefined ? { proved: toSqlFromPaise(o.provedPaise) } : {}),
  }).where('id', '=', id).execute();
}

/**
 * The amounts that count for a month's TDS: declared ones until December,
 * accepted proofs from January. None declared at all for the year means the
 * employee's single declared-deductions figure is used instead (null).
 */
export async function deductionItems(ex: Executor, orgId: number, employeeId: number, fyStart: number, month: string) {
  const rows = await ex.selectFrom('tax_declarations').select(['section', 'declared', 'proved', 'status'])
    .where('org_id', '=', orgId).where('employee_id', '=', employeeId).where('fy_start', '=', fyStart).execute();
  if (!rows.length) return null;
  const proofs = proofsDecide(month);
  return rows.map((r) => ({
    section: r.section as DeductionSection,
    amount: proofs
      ? (r.status === 'accepted' ? p(r.proved ?? r.declared) : 0)
      : (r.status === 'rejected' ? 0 : p(r.declared)),
  }));
}

export async function listDeclarations(ex: Executor, orgId: number, fyStart: number) {
  const rows = await ex.selectFrom('tax_declarations as d').innerJoin('employees as e', 'e.id', 'd.employee_id')
    .select(['d.id', 'd.employee_id', 'e.code', 'e.name', 'e.tax_regime', 'd.section', 'd.description', 'd.declared', 'd.proved', 'd.status', 'd.review_note'])
    .where('d.org_id', '=', orgId).where('d.fy_start', '=', fyStart).orderBy('e.code').orderBy('d.section').execute();
  return rows.map((r) => ({
    id: String(r.id), employeeId: String(r.employee_id), code: r.code, name: r.name, regime: r.tax_regime,
    section: r.section, description: r.description, declaredPaise: p(r.declared), provedPaise: r.proved === null ? null : p(r.proved),
    status: r.status, reviewNote: r.review_note,
  }));
}
