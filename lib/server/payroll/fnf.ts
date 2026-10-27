import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Full and final settlement: what is owed to (or by) someone who leaves, beyond
// the last month's salary — which that month's payroll run pays, pro rata to
// the last day.
//
//   gratuity        Payment of Gratuity Act, s.4: fifteen days' wages (basic
//                   and DA, the month taken as 26 days) for every completed
//                   year of service, a final part-year of more than six months
//                   counting as a year; five years' continuous service needed
//                   except on death or disablement; at most ₹20 lakh.
//   leave encashed  the encashable balance on the last day, at basic and DA a
//                   day (the month taken as 26 or 30 days, as the company has it)
//   notice          paid in lieu where the company ended it without notice;
//                   recovered where the employee left without serving it
//   other           recoveries (advances, assets not returned) and payments
//   TDS             entered as worked out: gratuity is exempt up to ₹20 lakh
//                   (s.10(10)) and leave encashment up to ₹25 lakh (s.10(10AA))
//
// Posted as one entry; the net is then paid like salaries.
// ─────────────────────────────────────────────────────────────────────────────

import type { Executor, Trx } from '../db';
import type { Paise } from '../../types';
import { toPaiseFromSql, toSqlFromPaise } from '../money-sql';
import { postEntry } from '../ledger/posting';
import { CODE, accountIds, requireAccount } from '../ledger/chart-of-accounts';
import { badRequest, conflict, notFound } from '../http';
import { salaryOn, structureGross } from './payroll';
import { leaveBalances } from './leave';

/** Gratuity's ceiling: ₹20 lakh. */
export const GRATUITY_CAP: Paise = 20_00_000_00;

/** Completed years of service for gratuity: a final part-year of more than six months counts. */
export function gratuityYears(joined: string, left: string): { completed: number; counted: number } {
  const a = new Date(`${joined}T00:00:00Z`), b = new Date(`${left}T00:00:00Z`);
  let completed = b.getUTCFullYear() - a.getUTCFullYear();
  const anniversary = new Date(Date.UTC(a.getUTCFullYear() + completed, a.getUTCMonth(), a.getUTCDate()));
  if (anniversary > b) completed -= 1;
  const lastAnniversary = new Date(Date.UTC(a.getUTCFullYear() + completed, a.getUTCMonth(), a.getUTCDate()));
  const sixMonths = new Date(Date.UTC(lastAnniversary.getUTCFullYear(), lastAnniversary.getUTCMonth() + 6, lastAnniversary.getUTCDate()));
  return { completed, counted: completed + (b > sixMonths ? 1 : 0) };
}

export interface FnfInput {
  employeeId: number;
  lastDay: string;
  /** Death or disablement: gratuity without the five years. */
  waiveFiveYears?: boolean;
  /** Leave to encash; by default the whole encashable balance on the last day. */
  encashDays?: number | null;
  /** Days in a month for encashment: 26 or 30, as the company's policy has it. */
  encashDivisor?: 26 | 30;
  noticePayDays?: number;
  noticeShortDays?: number;
  otherEarningsPaise?: Paise;
  otherRecoveriesPaise?: Paise;
  tdsPaise?: Paise;
  note?: string | null;
}

export interface FnfStatement {
  employeeId: number; name: string; joined: string; lastDay: string;
  monthlyBasicDaPaise: Paise; monthlyGrossPaise: Paise;
  years: { completed: number; counted: number }; gratuityEligible: boolean;
  gratuityPaise: Paise; gratuityCapped: boolean;
  encashDays: number; encashableDays: number; encashmentPaise: Paise;
  noticePayPaise: Paise; noticeRecoveryPaise: Paise;
  otherEarningsPaise: Paise; otherRecoveriesPaise: Paise; tdsPaise: Paise;
  netPaise: Paise; note: string | null;
}

export async function fnfStatement(ex: Executor, orgId: number, input: FnfInput): Promise<FnfStatement> {
  const e = await ex.selectFrom('employees').select(['id', 'name', 'date_of_joining']).where('id', '=', input.employeeId).where('org_id', '=', orgId).executeTakeFirst();
  if (!e) throw notFound('That employee was not found.');
  const joined = String(e.date_of_joining).slice(0, 10);
  if (input.lastDay < joined) throw badRequest('The last day is before they joined.');
  const salary = await salaryOn(ex, e.id, input.lastDay);
  if (!salary) throw badRequest(`${e.name} has no salary on file for that date.`);
  const basicDa = salary.basic + salary.da;
  const gross = structureGross(salary);

  const years = gratuityYears(joined, input.lastDay);
  const eligible = years.completed >= 5 || !!input.waiveFiveYears;
  const rawGratuity = eligible ? Math.round((basicDa * 15 * years.counted) / 26) : 0;
  const gratuity = Math.min(rawGratuity, GRATUITY_CAP);

  const types = await ex.selectFrom('leave_types').select(['id']).where('org_id', '=', orgId).where('encashable', '=', 1).execute();
  const balances = (await leaveBalances(ex, orgId, input.lastDay, e.id)).get(e.id);
  const encashable = types.reduce((t, x) => t + Math.max(0, balances?.get(x.id) ?? 0), 0);
  const encashDays = Math.max(0, Math.min(encashable, input.encashDays ?? encashable));
  const divisor = input.encashDivisor ?? 26;
  const encashment = Math.round((basicDa * encashDays) / divisor);

  const perDay = gross / 30;
  const noticePay = Math.round(perDay * Math.max(0, input.noticePayDays ?? 0));
  const noticeRecovery = Math.round(perDay * Math.max(0, input.noticeShortDays ?? 0));
  const otherEarnings = Math.max(0, input.otherEarningsPaise ?? 0);
  const otherRecoveries = Math.max(0, input.otherRecoveriesPaise ?? 0);
  const tds = Math.max(0, input.tdsPaise ?? 0);

  return {
    employeeId: e.id, name: e.name, joined, lastDay: input.lastDay, monthlyBasicDaPaise: basicDa, monthlyGrossPaise: gross,
    years, gratuityEligible: eligible, gratuityPaise: gratuity, gratuityCapped: rawGratuity > GRATUITY_CAP,
    encashDays, encashableDays: encashable, encashmentPaise: encashment, noticePayPaise: noticePay, noticeRecoveryPaise: noticeRecovery,
    otherEarningsPaise: otherEarnings, otherRecoveriesPaise: otherRecoveries, tdsPaise: tds,
    netPaise: gratuity + encashment + noticePay + otherEarnings - noticeRecovery - otherRecoveries - tds,
    note: input.note?.trim() || null,
  };
}

/** Post the settlement: the entry, the leave encashed, and the employee's last day. */
export async function postFnf(trx: Trx, orgId: number, userId: number | null, input: FnfInput) {
  const open = await trx.selectFrom('fnf_settlements').select('id').where('org_id', '=', orgId).where('employee_id', '=', input.employeeId).where('status', '!=', 'reversed').executeTakeFirst();
  if (open) throw conflict('This employee already has a settlement.');
  const s = await fnfStatement(trx, orgId, input);
  const acc = await accountIds(trx, orgId);
  const a = (code: string) => requireAccount(acc, code);
  const branch = await trx.selectFrom('employees').select('branch_id').where('id', '=', s.employeeId).executeTakeFirstOrThrow();
  const pay = s.encashmentPaise + s.noticePayPaise + s.otherEarningsPaise;
  const lines = [
    { accountId: a(CODE.GRATUITY), debit: s.gratuityPaise, description: `Gratuity, ${s.years.counted} year(s)` },
    { accountId: a(CODE.SALARIES), debit: pay, description: 'Leave encashed, notice pay and other payments on leaving' },
    { accountId: a(CODE.OTHER_INCOME), credit: s.noticeRecoveryPaise, description: 'Notice period not served' },
    { accountId: a(CODE.LOANS_ADVANCES), credit: s.otherRecoveriesPaise, description: 'Recovered on leaving' },
    { accountId: a(CODE.TDS_PAYABLE), credit: s.tdsPaise, description: 'TDS on the settlement' },
    s.netPaise >= 0
      ? { accountId: a(CODE.SALARIES_PAYABLE), credit: s.netPaise, description: `Full and final settlement of ${s.name}` }
      : { accountId: a(CODE.LOANS_ADVANCES), debit: -s.netPaise, description: `Owed by ${s.name} on leaving` },
  ].filter((l) => (l.debit ?? 0) > 0 || (l.credit ?? 0) > 0);
  if (lines.length < 2) throw badRequest('Nothing to settle: no gratuity, leave, notice or other amount.');
  const entry = await postEntry(trx, {
    orgId, branchId: branch.branch_id, date: s.lastDay, memo: `Full and final settlement: ${s.name}`,
    sourceType: 'fnf', userId, module: 'accountant', lines,
  });
  const id = Number((await trx.insertInto('fnf_settlements').values({
    org_id: orgId, employee_id: s.employeeId, last_day: s.lastDay, components: JSON.stringify(s), net_amount: toSqlFromPaise(s.netPaise),
    journal_entry_id: entry.id, created_by_user_id: userId,
  }).executeTakeFirstOrThrow()).insertId);
  await trx.updateTable('journal_entries').set({ source_id: id }).where('id', '=', entry.id).execute();
  if (s.encashDays > 0) {
    const type = await trx.selectFrom('leave_types').select('id').where('org_id', '=', orgId).where('encashable', '=', 1).orderBy('id').executeTakeFirst();
    if (type) {
      await trx.insertInto('leave_entries').values({
        org_id: orgId, employee_id: s.employeeId, leave_type_id: type.id, kind: 'encashed', days: s.encashDays.toFixed(2),
        from_date: s.lastDay, note: 'Encashed on leaving', created_by_user_id: userId,
      }).execute();
    }
  }
  await trx.updateTable('employees').set({ date_of_leaving: s.lastDay }).where('id', '=', s.employeeId).execute();
  return { id, entryId: entry.id, netPaise: s.netPaise };
}

/** Pay the net from a bank account. */
export async function payFnf(trx: Trx, orgId: number, userId: number | null, id: number, o: { bankAccountId: number; date: string }) {
  const f = await trx.selectFrom('fnf_settlements').selectAll().where('id', '=', id).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!f) throw notFound('That settlement was not found.');
  if (f.status !== 'posted') throw conflict(`That settlement is ${f.status}.`);
  const net = toPaiseFromSql(f.net_amount);
  if (net <= 0) throw badRequest('Nothing is owed to the employee on this settlement.');
  const bank = await trx.selectFrom('bank_accounts').select(['ledger_account_id', 'name']).where('id', '=', o.bankAccountId).where('org_id', '=', orgId).executeTakeFirst();
  if (!bank) throw notFound('That bank account does not exist.');
  const e = await trx.selectFrom('employees').select(['name', 'branch_id']).where('id', '=', f.employee_id).executeTakeFirstOrThrow();
  const acc = await accountIds(trx, orgId);
  const entry = await postEntry(trx, {
    orgId, branchId: e.branch_id, date: o.date, memo: `Full and final settlement paid to ${e.name}`, sourceType: 'fnf_payment', sourceId: id, userId, module: 'banking',
    lines: [{ accountId: requireAccount(acc, CODE.SALARIES_PAYABLE), debit: net }, { accountId: bank.ledger_account_id, credit: net }],
  });
  await trx.updateTable('fnf_settlements').set({ status: 'paid', payment_entry_id: entry.id, paid_on: o.date }).where('id', '=', id).execute();
  return entry.id;
}

export async function listFnf(ex: Executor, orgId: number) {
  const rows = await ex.selectFrom('fnf_settlements as f').innerJoin('employees as e', 'e.id', 'f.employee_id')
    .select(['f.id', 'f.employee_id', 'e.name', 'e.code', 'f.last_day', 'f.net_amount', 'f.status', 'f.components', 'f.paid_on'])
    .where('f.org_id', '=', orgId).orderBy('f.id', 'desc').execute();
  return rows.map((r) => ({
    id: String(r.id), employeeId: String(r.employee_id), name: r.name, code: r.code, lastDay: String(r.last_day).slice(0, 10),
    netPaise: toPaiseFromSql(r.net_amount), status: r.status, paidOn: r.paid_on ? String(r.paid_on).slice(0, 10) : null,
    statement: (typeof r.components === 'string' ? JSON.parse(r.components) : r.components) as FnfStatement,
  }));
}
