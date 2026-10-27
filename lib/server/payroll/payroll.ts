import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Payroll runs.
//
// A run is one month. Preparing it works out every employee's line from the
// salary structure in force at the month's end, the days they were employed
// and paid, and the statutory rules (lib/payroll/statutory.ts). It stays a
// draft, recomputed as days and extras are corrected, until it is posted:
//
//   Dr Salaries & Wages             gross earnings
//   Dr Staff Reimbursements         reimbursements
//   Dr Employer PF, ESI and LWF     the employer's own share and PF charges
//     Cr PF Payable                 both shares, admin and EDLI
//     Cr ESI Payable                both shares
//     Cr Professional Tax Payable
//     Cr Labour Welfare Fund Payable
//     Cr TDS Payable                tax on salary (s.192; s.392 of the 2025 Act)
//     Cr Loans & Advances           advances recovered
//     Cr Salaries Payable           net pay
//
// Paying it clears Salaries Payable from a bank account.
//
// Gross includes arrears from a back-dated revision; reimbursements include
// approved claims; advances recovered include loan instalments (loans.ts).
// TDS under the old regime follows the employee's declarations and, from
// January, the proofs accepted (declarations.ts).
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor, Trx } from '../db';
import type { Paise } from '../../types';
import { toPaiseFromSql, toSqlFromPaise } from '../money-sql';
import { unseal } from '../crypto/fields';
import { badRequest, conflict, notFound } from '../http';
import { accrueLeave, unpaidDays } from './leave';
import { claimsForRun } from './claims';
import { allocateRecovery, loansDue } from './loans';
import { deductionItems } from './declarations';
import { postEntry, reverseEntry } from '../ledger/posting';
import { CODE, accountIds, requireAccount } from '../ledger/chart-of-accounts';
import {
  annualTax, esi, esiPeriodOf, labourWelfare, monthlyTds, monthsLeftInFy, oldRegimeDeductions, pf, professionalTax,
} from '../../payroll/statutory';

const p = toPaiseFromSql;
const s = toSqlFromPaise;
const pad = (n: number) => String(n).padStart(2, '0');
const lastDay = (month: string) => {
  const [y, m] = month.split('-').map(Number);
  return `${month}-${pad(new Date(y, m, 0).getDate())}`;
};
const fyStartOf = (month: string) => (Number(month.slice(5)) >= 4 ? `${month.slice(0, 4)}-04` : `${Number(month.slice(0, 4)) - 1}-04`);
const prorate = (monthly: Paise, paid: number, days: number) => (days > 0 ? Math.round((monthly * paid) / days / 100) * 100 : 0);

export interface Structure { basic: Paise; da: Paise; hra: Paise; special: Paise; other: Paise }
export const structureGross = (x: Structure) => x.basic + x.da + x.hra + x.special + x.other;

export interface LineInput {
  lopDays?: number;
  bonusPaise?: Paise;
  reimbursementPaise?: Paise;
  advanceRecoveryPaise?: Paise;
  notes?: string | null;
}

/** The structure in force on a date. */
export async function salaryOn(ex: Executor, employeeId: number, date: string): Promise<Structure | null> {
  const r = await ex.selectFrom('employee_salaries').selectAll()
    .where('employee_id', '=', employeeId).where('effective_from', '<=', date)
    .orderBy('effective_from', 'desc').executeTakeFirst();
  return r ? { basic: p(r.basic), da: p(r.da), hra: p(r.hra), special: p(r.special), other: p(r.other) } : null;
}

type EmployeeRow = Awaited<ReturnType<typeof activeEmployees>>[number];

async function activeEmployees(ex: Executor, orgId: number, month: string) {
  return ex.selectFrom('employees as e').innerJoin('branches as b', 'b.id', 'e.branch_id')
    .select([
      'e.id', 'e.name', 'e.gender', 'e.date_of_joining', 'e.date_of_leaving', 'e.pf_member', 'e.eps_member', 'e.pf_on_actual',
      'e.pt_applicable', 'e.lwf_applicable', 'e.disabled', 'e.tax_regime', 'e.declared_deductions', 'e.metro_city', 'b.state_code',
    ])
    .where('e.org_id', '=', orgId)
    .where('e.date_of_joining', '<=', lastDay(month))
    .where((eb) => eb.or([eb('e.date_of_leaving', 'is', null), eb('e.date_of_leaving', '>=', `${month}-01`)]))
    .orderBy('e.code').execute();
}

/** Days on the books in a month: from joining, to leaving. */
export function employedDays(e: { date_of_joining: unknown; date_of_leaving: unknown }, month: string) {
  const end = lastDay(month);
  const daysInMonth = Number(end.slice(8));
  const doj = String(e.date_of_joining).slice(0, 10);
  const dol = e.date_of_leaving ? String(e.date_of_leaving).slice(0, 10) : null;
  const from = doj > `${month}-01` ? Number(doj.slice(8)) : 1;
  const to = dol && dol < end ? Number(dol.slice(8)) : daysInMonth;
  return { daysInMonth, employed: Math.max(0, to - from + 1) };
}

const monthsBefore = (month: string, n: number) => {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 - n, 1));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
};

/**
 * Arrears: for each of the last twelve months already posted, what the
 * structure now in force for that month would have paid on the same days,
 * less what was paid and what earlier arrears already made up.
 */
async function arrearsFor(ex: Executor, orgId: number, runId: number, month: string, employeeId: number) {
  const paid = await ex.selectFrom('payroll_lines as l').innerJoin('payroll_runs as r', 'r.id', 'l.run_id')
    .select(['r.month', 'l.days_in_month', 'l.paid_days', 'l.basic', 'l.da', 'l.hra', 'l.special', 'l.other'])
    .where('r.org_id', '=', orgId).where('l.employee_id', '=', employeeId).where('r.id', '<>', runId)
    .where('r.status', 'in', ['posted', 'paid']).where('r.month', '<', month).where('r.month', '>=', monthsBefore(month, 12))
    .orderBy('r.month').execute();
  if (!paid.length) return [];
  const before = await ex.selectFrom('payroll_arrears as a').innerJoin('payroll_runs as r', 'r.id', 'a.run_id')
    .select(['a.for_month', sql<string>`SUM(a.amount)`.as('amount'), sql<string>`SUM(a.basic_da)`.as('basic_da')])
    .where('r.org_id', '=', orgId).where('a.employee_id', '=', employeeId).where('a.run_id', '<>', runId).where('r.status', 'in', ['posted', 'paid'])
    .groupBy('a.for_month').execute();
  const madeUp = new Map(before.map((b) => [b.for_month, { amount: p(b.amount), basicDa: p(b.basic_da) }]));
  const out: { forMonth: string; amount: Paise; basicDa: Paise }[] = [];
  for (const l of paid) {
    const now = await salaryOn(ex, employeeId, lastDay(l.month));
    if (!now) continue;
    const days = l.days_in_month;
    const paidDays = Number(l.paid_days);
    const due = (x: Paise) => prorate(x, paidDays, days);
    const dueBasicDa = due(now.basic) + due(now.da);
    const dueAll = dueBasicDa + due(now.hra) + due(now.special) + due(now.other);
    const was = madeUp.get(l.month) ?? { amount: 0, basicDa: 0 };
    const amount = dueAll - (p(l.basic) + p(l.da) + p(l.hra) + p(l.special) + p(l.other)) - was.amount;
    const basicDa = dueBasicDa - (p(l.basic) + p(l.da)) - was.basicDa;
    // A revision downwards is not clawed back from a month already paid.
    if (amount > 0) out.push({ forMonth: l.month, amount, basicDa: Math.max(0, Math.min(basicDa, amount)) });
  }
  return out;
}

/** Work out one employee's month. */
async function computeLine(ex: Executor, orgId: number, runId: number, month: string, e: EmployeeRow, input: LineInput, claims: Paise) {
  const end = lastDay(month);
  const structure = await salaryOn(ex, e.id, end);
  if (!structure) return null;
  const { daysInMonth, employed } = employedDays(e, month);
  const dol = e.date_of_leaving ? String(e.date_of_leaving).slice(0, 10) : null;
  const lop = Math.min(employed, Math.max(0, input.lopDays ?? 0));
  const paidDays = employed - lop;

  const earn = {
    basic: prorate(structure.basic, paidDays, daysInMonth),
    da: prorate(structure.da, paidDays, daysInMonth),
    hra: prorate(structure.hra, paidDays, daysInMonth),
    special: prorate(structure.special, paidDays, daysInMonth),
    other: prorate(structure.other, paidDays, daysInMonth),
  };
  const bonus = input.bonusPaise ?? 0;
  const arrears = await arrearsFor(ex, orgId, runId, month, e.id);
  const arrearsTotal = arrears.reduce((t, a) => t + a.amount, 0);
  const arrearsBasicDa = arrears.reduce((t, a) => t + a.basicDa, 0);
  const reimbursement = (input.reimbursementPaise ?? 0) + claims;
  const gross = earn.basic + earn.da + earn.hra + earn.special + earn.other + bonus + arrearsTotal;

  // Arrears of basic and DA carry PF, counted with this month's wage.
  const pfr = pf({ pfWage: earn.basic + earn.da + arrearsBasicDa, member: !!e.pf_member, epsMember: !!e.eps_member, onActual: !!e.pf_on_actual });

  // Covered at any point earlier in the contribution period means covered now.
  const period = esiPeriodOf(month);
  const earlier = await sql<{ n: number }>`
    SELECT COUNT(*) AS n FROM payroll_lines l JOIN payroll_runs r ON r.id = l.run_id
     WHERE r.org_id = ${orgId} AND l.employee_id = ${e.id} AND r.id <> ${runId}
       AND r.month >= ${period.from} AND r.month < ${month} AND l.esi_employer > 0
  `.execute(ex);
  // Bonus is left out of ESI wages; it is not paid at intervals of two months or less.
  const esiWage = gross - bonus;
  const esir = esi({ esiWage, rateWage: structureGross(structure), paidDays, disabled: !!e.disabled, coveredThisPeriod: Number(earlier.rows[0]?.n ?? 0) > 0 });

  const pt = e.pt_applicable ? professionalTax({ stateCode: e.state_code, month, gross, gender: e.gender }) : 0;
  const lwf = e.lwf_applicable ? labourWelfare(e.state_code, month) : { employee: 0, employer: 0 };

  // Income tax: the year so far, this month, and the structure for the months
  // left (none once someone has left), less what was already deducted.
  const fyFrom = fyStartOf(month);
  const sofar = await sql<{ gross: string; tds: string; pt: string; basic_da: string; hra: string }>`
    SELECT COALESCE(SUM(l.gross), 0) AS gross, COALESCE(SUM(l.tds), 0) AS tds, COALESCE(SUM(l.pt), 0) AS pt,
           COALESCE(SUM(l.basic + l.da), 0) AS basic_da, COALESCE(SUM(l.hra), 0) AS hra
      FROM payroll_lines l JOIN payroll_runs r ON r.id = l.run_id
     WHERE r.org_id = ${orgId} AND l.employee_id = ${e.id} AND r.id <> ${runId} AND r.month >= ${fyFrom} AND r.month < ${month}
  `.execute(ex);
  const left = monthsLeftInFy(month);
  const leaving = !!dol && dol <= end;
  const ahead = leaving ? 0 : left - 1;
  const projectedGross = p(sofar.rows[0].gross) + gross + ahead * structureGross(structure);
  const projectedPt = p(sofar.rows[0].pt) + pt + ahead * pt;
  // Old-regime deductions from the employee's declarations, or their single
  // declared figure when they have made none for the year.
  const items = await deductionItems(ex, orgId, e.id, Number(fyFrom.slice(0, 4)), month);
  const deductions = items
    ? oldRegimeDeductions(items, {
        hraReceived: p(sofar.rows[0].hra) + earn.hra + ahead * structure.hra,
        basicDa: p(sofar.rows[0].basic_da) + earn.basic + earn.da + arrearsBasicDa + ahead * (structure.basic + structure.da),
        metro: !!e.metro_city,
      }).total
    : p(e.declared_deductions);
  const year = annualTax({ regime: e.tax_regime, grossSalary: projectedGross, deductions, professionalTax: projectedPt });
  const tds = monthlyTds({ annualTax: year.tax, deductedSoFar: p(sofar.rows[0].tds), monthsLeft: leaving ? 1 : left });

  // Loan instalments come last, and only out of what is left to pay.
  const manualAdvance = input.advanceRecoveryPaise ?? 0;
  const beforeLoans = gross + reimbursement - pfr.employee - esir.employee - pt - lwf.employee - tds - manualAdvance;
  const recoveries = allocateRecovery(await loansDue(ex, orgId, runId, month, e.id), beforeLoans);
  const loanRecovery = recoveries.reduce((t, r) => t + r.amount, 0);
  const net = beforeLoans - loanRecovery;
  return {
    line: {
      days_in_month: daysInMonth, lop_days: String(lop), paid_days: String(paidDays),
      basic: s(earn.basic), da: s(earn.da), hra: s(earn.hra), special: s(earn.special), other: s(earn.other),
      bonus: s(bonus), arrears: s(arrearsTotal), reimbursement: s(reimbursement), claims: s(claims), gross: s(gross),
      pf_wage: s(pfr.contributionWage), eps_wage: s(pfr.epsWage), pf_employee: s(pfr.employee),
      pf_employer_epf: s(pfr.employerEpf), pf_employer_eps: s(pfr.employerEps), pf_admin: s(pfr.admin), pf_edli: s(pfr.edli),
      esi_wage: s(esir.covered ? esiWage : 0), esi_employee: s(esir.employee), esi_employer: s(esir.employer),
      pt: s(pt), lwf_employee: s(lwf.employee), lwf_employer: s(lwf.employer), tds: s(tds),
      advance_recovery: s(manualAdvance + loanRecovery), loan_recovery: s(loanRecovery), net_pay: s(net), notes: input.notes ?? null,
    },
    arrears,
    recoveries,
  };
}

/**
 * Prepare (or recompute) the draft run for a month. Inputs not given keep
 * what the line already had, so correcting one employee's days leaves the
 * rest as they were. Reimbursement and advance recovery typed in by hand are
 * kept apart from approved claims and loan instalments, which are worked out
 * afresh each time.
 */
export async function prepareRun(trx: Trx, orgId: number, userId: number | null, month: string, inputs: Record<number, LineInput> = {}): Promise<number> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw badRequest('A payroll month is YYYY-MM.');
  let run = await trx.selectFrom('payroll_runs').select(['id', 'status']).where('org_id', '=', orgId).where('month', '=', month).forUpdate().executeTakeFirst();
  if (run && run.status !== 'draft') throw conflict(`Payroll for ${month} is already ${run.status}. Reopen it to change it.`);
  if (!run) {
    const id = Number((await trx.insertInto('payroll_runs').values({ org_id: orgId, month, created_by_user_id: userId }).executeTakeFirstOrThrow()).insertId);
    run = { id, status: 'draft' };
  }
  const existing = await trx.selectFrom('payroll_lines').selectAll().where('run_id', '=', run.id).execute();
  const before = new Map(existing.map((l) => [l.employee_id, l]));
  const employees = await activeEmployees(trx, orgId, month);
  // The month's leave accrues with its payroll, and unpaid leave is its unpaid days.
  await accrueLeave(trx, orgId, month);
  const unpaid = await unpaidDays(trx, orgId, month);
  const claims = await claimsForRun(trx, orgId, run.id, lastDay(month));
  await trx.deleteFrom('payroll_lines').where('run_id', '=', run.id).execute();
  await trx.deleteFrom('payroll_arrears').where('run_id', '=', run.id).execute();
  await trx.deleteFrom('payroll_recoveries').where('run_id', '=', run.id).execute();
  for (const e of employees) {
    const was = before.get(e.id);
    const given = inputs[e.id] ?? {};
    const input: LineInput = {
      lopDays: given.lopDays ?? (was ? Number(was.lop_days) : unpaid.get(e.id) ?? 0),
      bonusPaise: given.bonusPaise ?? (was ? p(was.bonus) : 0),
      reimbursementPaise: given.reimbursementPaise ?? (was ? p(was.reimbursement) - p(was.claims) : 0),
      advanceRecoveryPaise: given.advanceRecoveryPaise ?? (was ? p(was.advance_recovery) - p(was.loan_recovery) : 0),
      notes: given.notes !== undefined ? given.notes : was?.notes ?? null,
    };
    const done = await computeLine(trx, orgId, run.id, month, e, input, claims.get(e.id) ?? 0);
    if (!done) continue;
    await trx.insertInto('payroll_lines').values({ run_id: run.id, employee_id: e.id, ...done.line }).execute();
    for (const a of done.arrears) {
      await trx.insertInto('payroll_arrears').values({ run_id: run.id, employee_id: e.id, for_month: a.forMonth, amount: s(a.amount), basic_da: s(a.basicDa) }).execute();
    }
    for (const r of done.recoveries) {
      await trx.insertInto('payroll_recoveries').values({ run_id: run.id, loan_id: r.loanId, employee_id: e.id, amount: s(r.amount) }).execute();
    }
  }
  return run.id;
}

const SUMS = ['gross', 'reimbursement', 'pf_employee', 'pf_employer_epf', 'pf_employer_eps', 'pf_admin', 'pf_edli',
  'esi_employee', 'esi_employer', 'pt', 'lwf_employee', 'lwf_employer', 'tds', 'advance_recovery', 'net_pay'] as const;
type Totals = Record<(typeof SUMS)[number], Paise>;

async function totalsOf(ex: Executor, runId: number): Promise<Totals & { count: number }> {
  const lines = await ex.selectFrom('payroll_lines').selectAll().where('run_id', '=', runId).execute();
  const t = Object.fromEntries(SUMS.map((k) => [k, lines.reduce((a, l) => a + p(l[k]), 0)])) as Totals;
  return { ...t, count: lines.length };
}

export async function postRun(trx: Trx, orgId: number, userId: number | null, runId: number): Promise<number> {
  const run = await trx.selectFrom('payroll_runs').selectAll().where('id', '=', runId).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!run) throw notFound('That payroll run does not exist.');
  if (run.status !== 'draft') throw conflict(`Payroll for ${run.month} is already ${run.status}.`);
  const t = await totalsOf(trx, runId);
  if (!t.count) throw badRequest('There is nobody on this payroll. Add employees and their salary first.');
  const acc = await accountIds(trx, orgId);
  const a = (code: string) => requireAccount(acc, code);
  const employer = t.pf_employer_epf + t.pf_employer_eps + t.pf_admin + t.pf_edli + t.esi_employer + t.lwf_employer;
  const branch = await trx.selectFrom('branches').select('id').where('org_id', '=', orgId).orderBy('is_primary', 'desc').executeTakeFirstOrThrow();
  const lines = [
    { accountId: a(CODE.SALARIES), debit: t.gross, description: `Salaries for ${run.month}` },
    { accountId: a(CODE.STAFF_REIMBURSEMENTS), debit: t.reimbursement },
    { accountId: a(CODE.EMPLOYER_CONTRIBUTIONS), debit: employer, description: 'Employer PF, ESI and LWF' },
    { accountId: a(CODE.PF_PAYABLE), credit: t.pf_employee + t.pf_employer_epf + t.pf_employer_eps + t.pf_admin + t.pf_edli },
    { accountId: a(CODE.ESI_PAYABLE), credit: t.esi_employee + t.esi_employer },
    { accountId: a(CODE.PT_PAYABLE), credit: t.pt },
    { accountId: a(CODE.LWF_PAYABLE), credit: t.lwf_employee + t.lwf_employer },
    { accountId: a(CODE.TDS_PAYABLE), credit: t.tds, description: 'TDS on salary' },
    { accountId: a(CODE.LOANS_ADVANCES), credit: t.advance_recovery, description: 'Advances recovered from salary' },
    { accountId: a(CODE.SALARIES_PAYABLE), credit: t.net_pay, description: `Net salaries for ${run.month}` },
  ].filter((l) => (l.debit ?? 0) !== 0 || (l.credit ?? 0) !== 0);
  const entry = await postEntry(trx, {
    orgId, branchId: branch.id, date: lastDay(run.month), memo: `Payroll for ${run.month} (${t.count} employee${t.count === 1 ? '' : 's'})`,
    sourceType: 'payroll', sourceId: runId, userId, module: 'accountant', lines,
  });
  await trx.updateTable('payroll_runs').set({ status: 'posted', journal_entry_id: entry.id }).where('id', '=', runId).execute();
  return entry.id;
}

/** Pay the net salaries from a bank account. */
export async function payRun(trx: Trx, orgId: number, userId: number | null, runId: number, o: { bankAccountId: number; date: string }): Promise<number> {
  const run = await trx.selectFrom('payroll_runs').selectAll().where('id', '=', runId).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!run) throw notFound('That payroll run does not exist.');
  if (run.status !== 'posted') throw conflict(run.status === 'paid' ? `Payroll for ${run.month} is already paid.` : 'Post the payroll before paying it.');
  if (o.date < `${run.month}-01`) throw badRequest('Salaries cannot be paid before the month they are for.');
  const bank = await trx.selectFrom('bank_accounts').select(['ledger_account_id', 'name']).where('id', '=', o.bankAccountId).where('org_id', '=', orgId).executeTakeFirst();
  if (!bank) throw notFound('That bank account does not exist.');
  const t = await totalsOf(trx, runId);
  const acc = await accountIds(trx, orgId);
  const branch = (await trx.selectFrom('branches').select('id').where('org_id', '=', orgId).orderBy('is_primary', 'desc').executeTakeFirstOrThrow()).id;
  const entry = await postEntry(trx, {
    orgId, branchId: branch, date: o.date, memo: `Salaries for ${run.month} paid from ${bank.name}`,
    sourceType: 'payroll_payment', sourceId: runId, userId, module: 'banking',
    lines: [
      { accountId: requireAccount(acc, CODE.SALARIES_PAYABLE), debit: t.net_pay },
      { accountId: bank.ledger_account_id, credit: t.net_pay },
    ],
  });
  await trx.updateTable('payroll_runs').set({ status: 'paid', paid_on: o.date, paid_from_bank_id: o.bankAccountId, payment_entry_id: entry.id })
    .where('id', '=', runId).execute();
  return entry.id;
}

/** Take a posted run back to draft: its entry is reversed, never deleted. */
export async function reopenRun(trx: Trx, orgId: number, userId: number | null, runId: number, reason: string): Promise<void> {
  const run = await trx.selectFrom('payroll_runs').selectAll().where('id', '=', runId).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!run) throw notFound('That payroll run does not exist.');
  if (run.status === 'paid') throw conflict('Salaries for this month have been paid. Record a correction in next month’s payroll instead.');
  if (run.status !== 'posted') throw conflict('Only a posted payroll can be reopened.');
  if (reason.trim().length < 4) throw badRequest('Give the reason for reopening it.');
  if (run.journal_entry_id) {
    await reverseEntry(trx, orgId, run.journal_entry_id, { memo: `Payroll for ${run.month} reopened — ${reason.trim()}`, userId, module: 'accountant' });
  }
  await trx.updateTable('payroll_runs').set({ status: 'draft', journal_entry_id: null }).where('id', '=', runId).execute();
}

export interface RunLine {
  employeeId: string; code: string; name: string; designation: string | null; pan: string | null; uan: string | null;
  mobile: string | null; email: string | null;
  esiIpNumber: string | null; bankAccountName: string | null; bankAccountNo: string | null; bankIfsc: string | null;
  daysInMonth: number; lopDays: number; paidDays: number;
  basic: Paise; da: Paise; hra: Paise; special: Paise; other: Paise; bonus: Paise; arrears: Paise; reimbursement: Paise; claims: Paise; gross: Paise;
  pfWage: Paise; epsWage: Paise; pfEmployee: Paise; pfEmployerEpf: Paise; pfEmployerEps: Paise; pfAdmin: Paise; pfEdli: Paise;
  esiWage: Paise; esiEmployee: Paise; esiEmployer: Paise; pt: Paise; lwfEmployee: Paise; lwfEmployer: Paise;
  tds: Paise; advanceRecovery: Paise; loanRecovery: Paise; netPay: Paise; notes: string | null;
}

export async function runDetail(ex: Executor, orgId: number, runId: number) {
  const run = await ex.selectFrom('payroll_runs').selectAll().where('id', '=', runId).where('org_id', '=', orgId).executeTakeFirst();
  if (!run) throw notFound('That payroll run does not exist.');
  const rows = await ex.selectFrom('payroll_lines as l').innerJoin('employees as e', 'e.id', 'l.employee_id')
    .select([
      'l.employee_id', 'e.code', 'e.name', 'e.designation', 'e.pan', 'e.uan', 'e.esi_ip_number', 'e.mobile', 'e.email',
      'e.bank_account_name', 'e.bank_account_no', 'e.bank_ifsc',
      'l.days_in_month', 'l.lop_days', 'l.paid_days', 'l.basic', 'l.da', 'l.hra', 'l.special', 'l.other', 'l.bonus', 'l.arrears', 'l.claims', 'l.loan_recovery',
      'l.reimbursement', 'l.gross', 'l.pf_wage', 'l.eps_wage', 'l.pf_employee', 'l.pf_employer_epf', 'l.pf_employer_eps',
      'l.pf_admin', 'l.pf_edli', 'l.esi_wage', 'l.esi_employee', 'l.esi_employer', 'l.pt', 'l.lwf_employee',
      'l.lwf_employer', 'l.tds', 'l.advance_recovery', 'l.net_pay', 'l.notes',
    ])
    .where('l.run_id', '=', runId).orderBy('e.code').execute();
  const lines: RunLine[] = rows.map((r) => ({
    employeeId: String(r.employee_id), code: r.code, name: r.name, designation: r.designation, pan: unseal(r.pan), uan: r.uan,
    mobile: r.mobile, email: r.email,
    esiIpNumber: r.esi_ip_number, bankAccountName: r.bank_account_name, bankAccountNo: unseal(r.bank_account_no), bankIfsc: r.bank_ifsc,
    daysInMonth: r.days_in_month, lopDays: Number(r.lop_days), paidDays: Number(r.paid_days),
    basic: p(r.basic), da: p(r.da), hra: p(r.hra), special: p(r.special), other: p(r.other), bonus: p(r.bonus), arrears: p(r.arrears),
    reimbursement: p(r.reimbursement), claims: p(r.claims), gross: p(r.gross), pfWage: p(r.pf_wage), epsWage: p(r.eps_wage),
    pfEmployee: p(r.pf_employee), pfEmployerEpf: p(r.pf_employer_epf), pfEmployerEps: p(r.pf_employer_eps),
    pfAdmin: p(r.pf_admin), pfEdli: p(r.pf_edli), esiWage: p(r.esi_wage), esiEmployee: p(r.esi_employee),
    esiEmployer: p(r.esi_employer), pt: p(r.pt), lwfEmployee: p(r.lwf_employee), lwfEmployer: p(r.lwf_employer),
    tds: p(r.tds), advanceRecovery: p(r.advance_recovery), loanRecovery: p(r.loan_recovery), netPay: p(r.net_pay), notes: r.notes,
  }));
  const org = await ex.selectFrom('organizations').select(['name', 'legal_name', 'pf_establishment_code', 'esi_employer_code', 'tan'])
    .where('id', '=', orgId).executeTakeFirstOrThrow();
  return {
    id: String(run.id), month: run.month, status: run.status, paidOn: run.paid_on ? String(run.paid_on).slice(0, 10) : null,
    journalEntryId: run.journal_entry_id ? String(run.journal_entry_id) : null,
    org: { name: org.legal_name ?? org.name, pfCode: org.pf_establishment_code, esiCode: org.esi_employer_code, tan: org.tan },
    lines,
  };
}

export async function listRuns(ex: Executor, orgId: number) {
  const rows = await ex.selectFrom('payroll_runs as r')
    .leftJoin('payroll_lines as l', 'l.run_id', 'r.id')
    .select(['r.id', 'r.month', 'r.status', 'r.paid_on',
      sql<number>`COUNT(l.id)`.as('employees'),
      sql<string>`COALESCE(SUM(l.gross), 0)`.as('gross'),
      sql<string>`COALESCE(SUM(l.net_pay), 0)`.as('net')])
    .where('r.org_id', '=', orgId).groupBy(['r.id', 'r.month', 'r.status', 'r.paid_on']).orderBy('r.month', 'desc').execute();
  return rows.map((r) => ({
    id: String(r.id), month: r.month, status: r.status, paidOn: r.paid_on ? String(r.paid_on).slice(0, 10) : null,
    employees: Number(r.employees), grossPaise: p(r.gross), netPaise: p(r.net),
  }));
}

/** Form 24Q (Form 138 from April 2026): salary paid and tax deducted, employee by employee, for a quarter. */
export async function salaryTdsQuarter(ex: Executor, orgId: number, fy: number, q: 1 | 2 | 3 | 4) {
  const months = Array.from({ length: 3 }, (_, i) => {
    const m = 4 + (q - 1) * 3 + i;
    return m > 12 ? `${fy + 1}-${pad(m - 12)}` : `${fy}-${pad(m)}`;
  });
  const rows = await ex.selectFrom('payroll_lines as l').innerJoin('payroll_runs as r', 'r.id', 'l.run_id')
    .innerJoin('employees as e', 'e.id', 'l.employee_id')
    .select(['r.month', 'r.status', 'e.id', 'e.code', 'e.name', 'e.pan', 'l.gross', 'l.tds'])
    .where('r.org_id', '=', orgId).where('r.month', 'in', months).where('r.status', '<>', 'draft')
    .orderBy('e.code').orderBy('r.month').execute();
  return {
    fy, quarter: q, months, form: fy >= 2026 ? 'Form 138' : 'Form 24Q',
    rows: rows.map((r) => ({ month: r.month, employeeId: String(r.id), code: r.code, name: r.name, pan: unseal(r.pan), paidPaise: p(r.gross), tdsPaise: p(r.tds) })),
  };
}
