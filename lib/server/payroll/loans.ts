import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Salary advances and loans to employees.
//
// Giving one moves money out of the bank into Loans & Advances:
//
//   Dr Loans & Advances      what the employee now owes
//     Cr Bank                paid to them
//
// Each payroll month recovers an instalment until the balance is gone, and
// the recovery is kept loan by loan (payroll_recoveries), so the balance is
// the amount less what posted payrolls have taken back. A recovery never
// takes net pay below nothing; what it could not take is left for next month.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor, Trx } from '../db';
import type { Paise } from '../../types';
import { toPaiseFromSql, toSqlFromPaise } from '../money-sql';
import { badRequest, conflict, notFound } from '../http';
import { postEntry, reverseEntry } from '../ledger/posting';
import { CODE, accountIds, requireAccount } from '../ledger/chart-of-accounts';

const p = toPaiseFromSql;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export interface LoanInput {
  employeeId: number;
  kind: 'advance' | 'loan';
  amountPaise: Paise;
  instalmentPaise: Paise;
  givenOn: string;
  firstMonth: string;
  bankAccountId: number;
  notes?: string | null;
}

export async function giveLoan(trx: Trx, orgId: number, userId: number | null, input: LoanInput): Promise<number> {
  const e = await trx.selectFrom('employees').select(['id', 'name', 'branch_id', 'date_of_leaving'])
    .where('id', '=', input.employeeId).where('org_id', '=', orgId).executeTakeFirst();
  if (!e) throw notFound('That employee was not found.');
  if (e.date_of_leaving && String(e.date_of_leaving).slice(0, 10) < input.givenOn) throw conflict(`${e.name} had left by then.`);
  if (!(input.amountPaise > 0)) throw badRequest('Give the amount lent.');
  if (!(input.instalmentPaise > 0) || input.instalmentPaise > input.amountPaise) {
    throw badRequest('The monthly instalment is more than nothing and no more than the amount.');
  }
  if (!MONTH.test(input.firstMonth)) throw badRequest('The first month of recovery is YYYY-MM.');
  if (input.firstMonth < input.givenOn.slice(0, 7)) throw badRequest('Recovery cannot start before the money is given.');
  const bank = await trx.selectFrom('bank_accounts').select(['ledger_account_id', 'name'])
    .where('id', '=', input.bankAccountId).where('org_id', '=', orgId).executeTakeFirst();
  if (!bank) throw notFound('That bank account does not exist.');

  const id = Number((await trx.insertInto('employee_loans').values({
    org_id: orgId, employee_id: e.id, kind: input.kind, amount: toSqlFromPaise(input.amountPaise),
    instalment: toSqlFromPaise(input.instalmentPaise), given_on: input.givenOn, first_month: input.firstMonth,
    paid_from_bank_id: input.bankAccountId, notes: input.notes?.trim() || null, created_by_user_id: userId,
  }).executeTakeFirstOrThrow()).insertId);
  const acc = await accountIds(trx, orgId);
  const entry = await postEntry(trx, {
    orgId, branchId: e.branch_id, date: input.givenOn,
    memo: `${input.kind === 'loan' ? 'Loan' : 'Salary advance'} to ${e.name}, from ${bank.name}`,
    sourceType: 'employee_loan', sourceId: id, userId, module: 'banking',
    lines: [
      { accountId: requireAccount(acc, CODE.LOANS_ADVANCES), debit: input.amountPaise, description: `${e.name}: recovered from salary` },
      { accountId: bank.ledger_account_id, credit: input.amountPaise },
    ],
  });
  await trx.updateTable('employee_loans').set({ journal_entry_id: entry.id }).where('id', '=', id).execute();
  return id;
}

/** Recovered so far, loan by loan: posted and paid payrolls, before a month if one is given, leaving one run out. */
async function recovered(ex: Executor, orgId: number, loanIds: number[], o: { beforeMonth?: string; exceptRun?: number } = {}) {
  if (!loanIds.length) return new Map<number, Paise>();
  const rows = await ex.selectFrom('payroll_recoveries as x').innerJoin('payroll_runs as r', 'r.id', 'x.run_id')
    .select(['x.loan_id', sql<string>`SUM(x.amount)`.as('amount')])
    .where('r.org_id', '=', orgId).where('r.status', 'in', ['posted', 'paid']).where('x.loan_id', 'in', loanIds)
    .$if(!!o.beforeMonth, (qb) => qb.where('r.month', '<', o.beforeMonth!))
    .$if(!!o.exceptRun, (qb) => qb.where('r.id', '<>', o.exceptRun!))
    .groupBy('x.loan_id').execute();
  return new Map(rows.map((r) => [Number(r.loan_id), p(r.amount)]));
}

/** What each of an employee's loans asks of a month's salary, oldest first. */
export async function loansDue(ex: Executor, orgId: number, runId: number, month: string, employeeId: number) {
  const loans = await ex.selectFrom('employee_loans').select(['id', 'amount', 'instalment'])
    .where('org_id', '=', orgId).where('employee_id', '=', employeeId).where('status', '=', 'active')
    .where('first_month', '<=', month).orderBy('given_on').orderBy('id').execute();
  const done = await recovered(ex, orgId, loans.map((l) => l.id), { beforeMonth: month, exceptRun: runId });
  return loans
    .map((l) => ({ loanId: l.id, due: Math.min(p(l.instalment), p(l.amount) - (done.get(l.id) ?? 0)) }))
    .filter((l) => l.due > 0);
}

/** Share what a month could recover across the loans, oldest first. */
export function allocateRecovery(due: { loanId: number; due: Paise }[], available: Paise) {
  let left = Math.max(0, available);
  return due.map((d) => {
    const amount = Math.min(d.due, left);
    left -= amount;
    return { loanId: d.loanId, amount };
  }).filter((r) => r.amount > 0);
}

export async function cancelLoan(trx: Trx, orgId: number, userId: number | null, id: number, reason: string) {
  const l = await trx.selectFrom('employee_loans').selectAll().where('id', '=', id).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!l) throw notFound('That advance was not found.');
  if (l.status === 'cancelled') throw conflict('It is already cancelled.');
  if (reason.trim().length < 4) throw badRequest('Give the reason for cancelling it.');
  const any = await trx.selectFrom('payroll_recoveries').select('id').where('loan_id', '=', id).executeTakeFirst();
  if (any) throw conflict('Some of it has been recovered through payroll. Recover the rest rather than cancelling it.');
  if (l.journal_entry_id) await reverseEntry(trx, orgId, l.journal_entry_id, { memo: `Advance cancelled — ${reason.trim()}`, userId, module: 'banking' });
  await trx.updateTable('employee_loans').set({ status: 'cancelled', notes: [l.notes, `Cancelled: ${reason.trim()}`].filter(Boolean).join(' · ').slice(0, 300) })
    .where('id', '=', id).execute();
}

export async function listLoans(ex: Executor, orgId: number) {
  const rows = await ex.selectFrom('employee_loans as l').innerJoin('employees as e', 'e.id', 'l.employee_id')
    .select(['l.id', 'l.employee_id', 'e.code', 'e.name', 'l.kind', 'l.amount', 'l.instalment', 'l.given_on', 'l.first_month', 'l.status', 'l.notes'])
    .where('l.org_id', '=', orgId).orderBy('l.given_on', 'desc').orderBy('l.id', 'desc').execute();
  const done = await recovered(ex, orgId, rows.map((r) => r.id));
  return rows.map((r) => {
    const recoveredPaise = done.get(r.id) ?? 0;
    return {
      id: String(r.id), employeeId: String(r.employee_id), code: r.code, name: r.name, kind: r.kind,
      amountPaise: p(r.amount), instalmentPaise: p(r.instalment), givenOn: String(r.given_on).slice(0, 10), firstMonth: r.first_month,
      status: r.status, notes: r.notes, recoveredPaise, balancePaise: r.status === 'cancelled' ? 0 : p(r.amount) - recoveredPaise,
    };
  });
}
