import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Leave: a ledger per employee and kind of leave.
//
//   given   opening balance, accrual (monthly, or yearly in April or the month
//           someone joins), adjustment
//   used    taken, encashed, lapsed
//
// The balance is what was given less what was used. A payroll month accrues
// its leave (once: an accrual is unique to its month) and each April lapses
// what is over the kind's carry-forward limit. Paid leave cannot be taken
// beyond the balance — the rest is unpaid — and unpaid leave becomes the
// month's unpaid days when the payroll is prepared.
//
// The leave rules differ by state Shops and Establishments Act and by
// company; the defaults are a starting point, each kind editable.
// ─────────────────────────────────────────────────────────────────────────────

import type { Executor, Trx } from '../db';
import { badRequest, conflict, notFound } from '../http';

export interface LeaveType {
  id: string; code: string; name: string; paid: boolean; annualDays: number; accrual: 'monthly' | 'yearly';
  carryForwardMax: number | null; encashable: boolean; isActive: boolean;
}

const DEFAULTS = [
  { code: 'EL', name: 'Earned leave', paid: 1, annual_days: '15', accrual: 'monthly' as const, carry_forward_max: '45', encashable: 1 },
  { code: 'CL', name: 'Casual leave', paid: 1, annual_days: '12', accrual: 'yearly' as const, carry_forward_max: '0', encashable: 0 },
  { code: 'SL', name: 'Sick leave', paid: 1, annual_days: '12', accrual: 'yearly' as const, carry_forward_max: '0', encashable: 0 },
  { code: 'LOP', name: 'Leave without pay', paid: 0, annual_days: '0', accrual: 'yearly' as const, carry_forward_max: null, encashable: 0 },
];

const num = (v: unknown) => Number(v ?? 0);
const half = (n: number) => Math.round(n * 2) / 2;
/** Balances keep the quarter days monthly accrual gives (1.25 a month for 15 a year). */
const cents = (n: number) => Math.round(n * 100) / 100;
const pad = (n: number) => String(n).padStart(2, '0');
const monthEnd = (month: string) => { const [y, m] = month.split('-').map(Number); return `${month}-${pad(new Date(y, m, 0).getDate())}`; };
const prevMonth = (month: string) => { const [y, m] = month.split('-').map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${pad(m - 1)}`; };
const monthsLeftInFy = (month: string) => { const m = Number(month.slice(5)); return m >= 4 ? 16 - m : 4 - m; };

export async function listLeaveTypes(ex: Executor, orgId: number): Promise<LeaveType[]> {
  let rows = await ex.selectFrom('leave_types').selectAll().where('org_id', '=', orgId).orderBy('paid', 'desc').orderBy('code').execute();
  if (!rows.length) {
    // Seeded on first look, so a book starts from the usual kinds.
    await ex.insertInto('leave_types').values(DEFAULTS.map((d) => ({ org_id: orgId, ...d }))).execute();
    rows = await ex.selectFrom('leave_types').selectAll().where('org_id', '=', orgId).orderBy('paid', 'desc').orderBy('code').execute();
  }
  return rows.map((r) => ({
    id: String(r.id), code: r.code, name: r.name, paid: !!r.paid, annualDays: num(r.annual_days), accrual: r.accrual,
    carryForwardMax: r.carry_forward_max === null ? null : num(r.carry_forward_max), encashable: !!r.encashable, isActive: !!r.is_active,
  }));
}

export async function saveLeaveType(
  trx: Trx, orgId: number,
  input: { id?: number | null; code: string; name: string; paid: boolean; annualDays: number; accrual: 'monthly' | 'yearly'; carryForwardMax: number | null; encashable: boolean; isActive?: boolean },
) {
  const code = input.code.trim().toUpperCase();
  if (!/^[A-Z]{1,10}$/.test(code)) throw badRequest('A leave code is up to ten letters, such as EL.');
  if (!(input.annualDays >= 0 && input.annualDays <= 366)) throw badRequest('Days a year are between 0 and 366.');
  const values = {
    code, name: input.name.trim(), paid: input.paid ? 1 : 0, annual_days: String(input.annualDays), accrual: input.accrual,
    carry_forward_max: input.carryForwardMax === null ? null : String(input.carryForwardMax),
    encashable: input.paid && input.encashable ? 1 : 0, is_active: input.isActive === false ? 0 : 1,
  };
  if (input.id) {
    await trx.updateTable('leave_types').set(values).where('id', '=', input.id).where('org_id', '=', orgId).execute();
    return input.id;
  }
  return Number((await trx.insertInto('leave_types').values({ org_id: orgId, ...values }).executeTakeFirstOrThrow()).insertId);
}

const GIVEN = ['opening', 'accrual', 'adjustment'];

/** Balances on a date: employee → leave type → days. */
export async function leaveBalances(ex: Executor, orgId: number, asOf: string, employeeId?: number) {
  let q = ex.selectFrom('leave_entries').select(['employee_id', 'leave_type_id', 'kind', 'days'])
    .where('org_id', '=', orgId).where('status', '=', 'approved')
    .where((eb) => eb.or([eb('from_date', 'is', null), eb('from_date', '<=', asOf)]))
    .where((eb) => eb.or([eb('period', 'is', null), eb('period', '<=', asOf.slice(0, 7))]));
  if (employeeId) q = q.where('employee_id', '=', employeeId);
  const out = new Map<number, Map<number, number>>();
  for (const r of await q.execute()) {
    const per = out.get(r.employee_id) ?? new Map<number, number>();
    per.set(r.leave_type_id, cents((per.get(r.leave_type_id) ?? 0) + (GIVEN.includes(r.kind) ? 1 : -1) * num(r.days)));
    out.set(r.employee_id, per);
  }
  return out;
}

/** Calendar days from one date to another, both counted. */
export const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 864e5) + 1;

export async function recordLeave(
  trx: Trx, orgId: number, userId: number | null,
  input: { employeeId: number; leaveTypeId: number; from: string; to: string; days?: number | null; note?: string | null },
) {
  if (input.to < input.from) throw badRequest('Leave ends on or after the day it starts.');
  const type = await trx.selectFrom('leave_types').selectAll().where('id', '=', input.leaveTypeId).where('org_id', '=', orgId).executeTakeFirst();
  if (!type) throw notFound('That kind of leave was not found.');
  const emp = await trx.selectFrom('employees').select(['name', 'date_of_joining', 'date_of_leaving']).where('id', '=', input.employeeId).where('org_id', '=', orgId).executeTakeFirst();
  if (!emp) throw notFound('That employee was not found.');
  const span = daysBetween(input.from, input.to);
  const days = half(input.days ?? span);
  if (!(days > 0 && days <= span)) throw badRequest(`Between half a day and ${span} day(s) for those dates.`);
  const clash = await trx.selectFrom('leave_entries').select(['from_date', 'to_date'])
    .where('employee_id', '=', input.employeeId).where('kind', '=', 'taken').where('status', '=', 'approved')
    .where('from_date', '<=', input.to).where('to_date', '>=', input.from).executeTakeFirst();
  if (clash) throw conflict(`${emp.name} already has leave from ${String(clash.from_date).slice(0, 10)} to ${String(clash.to_date).slice(0, 10)}.`);
  if (type.paid) {
    const have = (await leaveBalances(trx, orgId, input.to, input.employeeId)).get(input.employeeId)?.get(type.id) ?? 0;
    if (days > have) throw conflict(`${emp.name} has ${have} day(s) of ${type.name.toLowerCase()} left. Record the rest as leave without pay.`);
  }
  return Number((await trx.insertInto('leave_entries').values({
    org_id: orgId, employee_id: input.employeeId, leave_type_id: type.id, kind: 'taken', days: String(days),
    from_date: input.from, to_date: input.to, note: input.note?.trim() || null, created_by_user_id: userId,
  }).executeTakeFirstOrThrow()).insertId);
}

export async function grantLeave(
  trx: Trx, orgId: number, userId: number | null,
  input: { employeeId: number; leaveTypeId: number; kind: 'opening' | 'adjustment'; days: number; date: string; note?: string | null },
) {
  if (!input.days) throw badRequest('Give the number of days.');
  return Number((await trx.insertInto('leave_entries').values({
    org_id: orgId, employee_id: input.employeeId, leave_type_id: input.leaveTypeId, kind: input.kind, days: String(half(input.days)),
    from_date: input.date, note: input.note?.trim() || null, created_by_user_id: userId,
  }).executeTakeFirstOrThrow()).insertId);
}

export async function cancelLeave(trx: Trx, orgId: number, id: number) {
  const r = await trx.updateTable('leave_entries').set({ status: 'cancelled' }).where('id', '=', id).where('org_id', '=', orgId)
    .where('kind', 'in', ['taken', 'opening', 'adjustment']).where('status', '=', 'approved').executeTakeFirst();
  if (!Number(r.numUpdatedRows)) throw notFound('That leave was not found, or is already cancelled.');
}

/**
 * The month's accruals, and in April the lapse of what is over each kind's
 * carry-forward limit. Safe to run again: each is unique to its month.
 */
export async function accrueLeave(trx: Trx, orgId: number, month: string) {
  const types = (await trx.selectFrom('leave_types').selectAll().where('org_id', '=', orgId).where('is_active', '=', 1).where('paid', '=', 1).execute());
  if (!types.length) return 0;
  const end = monthEnd(month);
  const employees = await trx.selectFrom('employees').select(['id', 'date_of_joining', 'date_of_leaving']).where('org_id', '=', orgId)
    .where('date_of_joining', '<=', end).where((eb) => eb.or([eb('date_of_leaving', 'is', null), eb('date_of_leaving', '>=', `${month}-01`)])).execute();
  const april = month.slice(5) === '04';
  const before = april ? await leaveBalances(trx, orgId, monthEnd(prevMonth(month))) : null;
  let made = 0;
  for (const e of employees) {
    const joinedThisMonth = String(e.date_of_joining).slice(0, 7) === month;
    for (const t of types) {
      const rows: { kind: 'accrual' | 'lapsed'; days: number }[] = [];
      if (april && t.carry_forward_max !== null) {
        const over = (before!.get(e.id)?.get(t.id) ?? 0) - num(t.carry_forward_max);
        if (over > 0) rows.push({ kind: 'lapsed', days: over });
      }
      if (t.accrual === 'monthly') rows.push({ kind: 'accrual', days: num(t.annual_days) / 12 });
      else if (april || joinedThisMonth) rows.push({ kind: 'accrual', days: half((num(t.annual_days) * monthsLeftInFy(month)) / 12) });
      for (const r of rows) {
        if (!(r.days > 0)) continue;
        const res = await trx.insertInto('leave_entries').values({
          org_id: orgId, employee_id: e.id, leave_type_id: t.id, kind: r.kind, days: cents(r.days).toFixed(2), period: month,
          from_date: r.kind === 'accrual' ? end : `${month}-01`, note: r.kind === 'lapsed' ? 'Over the carry-forward limit' : null,
        }).onDuplicateKeyUpdate({ days: (eb) => eb.ref('days') }).executeTakeFirst();
        if (Number(res.numInsertedOrUpdatedRows ?? 0) === 1) made++;
      }
    }
  }
  return made;
}

/** Unpaid leave in a month, per employee: the payroll's unpaid days. */
export async function unpaidDays(ex: Executor, orgId: number, month: string) {
  const end = monthEnd(month);
  const rows = await ex.selectFrom('leave_entries as e').innerJoin('leave_types as t', 't.id', 'e.leave_type_id')
    .select(['e.employee_id', 'e.from_date', 'e.to_date', 'e.days'])
    .where('e.org_id', '=', orgId).where('e.kind', '=', 'taken').where('e.status', '=', 'approved').where('t.paid', '=', 0)
    .where('e.from_date', '<=', end).where('e.to_date', '>=', `${month}-01`).execute();
  const out = new Map<number, number>();
  for (const r of rows) {
    const from = String(r.from_date).slice(0, 10), to = String(r.to_date).slice(0, 10);
    const span = daysBetween(from, to);
    const inside = daysBetween(from < `${month}-01` ? `${month}-01` : from, to > end ? end : to);
    // A part-day leave keeps its fraction; one running across months is split by days.
    out.set(r.employee_id, half((out.get(r.employee_id) ?? 0) + (num(r.days) * inside) / span));
  }
  return out;
}

export async function leaveRegister(ex: Executor, orgId: number, opts: { employeeId?: number; from?: string } = {}) {
  let q = ex.selectFrom('leave_entries as e').innerJoin('employees as p', 'p.id', 'e.employee_id').innerJoin('leave_types as t', 't.id', 'e.leave_type_id')
    .select(['e.id', 'e.kind', 'e.days', 'e.from_date', 'e.to_date', 'e.period', 'e.note', 'e.status', 'p.id as employee_id', 'p.name', 't.code', 't.name as type_name'])
    .where('e.org_id', '=', orgId).where('e.kind', 'in', ['taken', 'opening', 'adjustment', 'encashed']);
  if (opts.employeeId) q = q.where('e.employee_id', '=', opts.employeeId);
  if (opts.from) q = q.where('e.from_date', '>=', opts.from);
  const rows = await q.orderBy('e.from_date', 'desc').orderBy('e.id', 'desc').limit(300).execute();
  return rows.map((r) => ({
    id: String(r.id), kind: r.kind, days: num(r.days), from: r.from_date ? String(r.from_date).slice(0, 10) : null,
    to: r.to_date ? String(r.to_date).slice(0, 10) : null, note: r.note, status: r.status,
    employeeId: String(r.employee_id), employeeName: r.name, typeCode: r.code, typeName: r.type_name,
  }));
}
