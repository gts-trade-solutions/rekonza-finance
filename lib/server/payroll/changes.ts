import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Edit and Delete across payroll (the client, 2026-11-25: "wherever we need
// edit and delete you should give"), on the rules the rest of the book keeps:
//
//   - What posted to the ledger is never erased (journal entries cannot be
//     deleted: db/protect). An edit reverses the old entry on its own date and
//     posts the new one, on the same record; a delete reverses it and keeps the
//     record in deleted_documents (services/doc-delete.ts) for the auditor.
//   - A master in use is not deleted. An employee on a pay run, an advance or a
//     claim stays, because the payslips, the PF and ESI returns and Form 16
//     name them; the way out is a leaving date, which takes them off the next
//     payroll and leaves every past one as it was. A kind of leave with leave
//     recorded is switched off instead.
//   - Money that left the bank and is matched to a statement line is unmatched
//     in Banking first, as for any payment (bankLineMatched).
//   - A month's PF, ESI, PT or LWF paid against a payroll keeps that payroll:
//     the payment is deleted first, or the dues would have nothing behind them.
//   - A draft payroll that took in something changed here (a claim, an advance
//     instalment) is worked out again, so it never pays on stale figures.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Trx } from '../db';
import type { Paise } from '../../types';
import { toPaiseFromSql, toSqlFromPaise } from '../money-sql';
import { badRequest, conflict, notFound } from '../http';
import { postEntry } from '../ledger/posting';
import { CODE, accountIds, requireAccount } from '../ledger/chart-of-accounts';
import { bankLineMatched, plain, recordDeletion, reverseForChange, unlinkDocument } from '../services/doc-delete';
import { monthLabel } from '../../date-range';
import { prepareRun } from './payroll';
import { fnfStatement, postFnf, type FnfInput } from './fnf';
import { daysBetween, leaveBalances } from './leave';
import { COMPONENT_LABEL, checkStatutoryPayment, payStatutory, type StatutoryComponent } from './statutory-dues';
import type { LoanInput } from './loans';
import { reverseAllSalaryPayments } from './salary-payments';

const p = toPaiseFromSql;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const pad = (n: number) => String(n).padStart(2, '0');
const lastDay = (month: string) => { const [y, m] = month.split('-').map(Number); return `${month}-${pad(new Date(y, m, 0).getDate())}`; };
const day = (v: unknown) => (v ? String(v).slice(0, 10) : null);
const rupees = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
const because = (reason?: string | null) => (reason?.trim() ? ` — ${reason.trim()}` : '');

const BANK_MATCHED = 'is matched to a line of the bank statement. Undo that match in Banking first, then change it here.';

/** Draft payrolls are worked out again after a change they took in. */
async function reprepare(trx: Trx, orgId: number, userId: number | null, months: Iterable<string>) {
  for (const month of [...new Set(months)].sort()) {
    const run = await trx.selectFrom('payroll_runs').select('status').where('org_id', '=', orgId).where('month', '=', month).executeTakeFirst();
    if (run?.status === 'draft') await prepareRun(trx, orgId, userId, month);
  }
}

/** The draft payrolls an employee is on. */
async function draftMonthsOf(trx: Trx, orgId: number, employeeIds: number[]) {
  if (!employeeIds.length) return [];
  const rows = await trx.selectFrom('payroll_lines as l').innerJoin('payroll_runs as r', 'r.id', 'l.run_id')
    .select('r.month').where('r.org_id', '=', orgId).where('r.status', '=', 'draft').where('l.employee_id', 'in', employeeIds).execute();
  return rows.map((r) => r.month);
}

// ── Employees ────────────────────────────────────────────────────────────────

/**
 * Delete an employee entered in error, as Zoho deletes an unused record. One
 * that payroll has touched stays; the refusal says what holds them and offers
 * the leaving date instead.
 */
export async function deleteEmployee(trx: Trx, orgId: number, id: number): Promise<{ name: string; code: string }> {
  const e = await trx.selectFrom('employees').select(['id', 'name', 'code']).where('id', '=', id).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!e) throw notFound('That employee does not exist.');
  const count = async (table: 'payroll_lines' | 'employee_loans' | 'reimbursement_claims' | 'tax_declarations' | 'fnf_settlements') =>
    Number((await trx.selectFrom(table).select(sql<string>`COUNT(*)`.as('n')).where('employee_id', '=', id).executeTakeFirst())?.n ?? 0);
  const [runs, loans, claims, declarations, fnf] = await Promise.all([
    count('payroll_lines'), count('employee_loans'), count('reimbursement_claims'), count('tax_declarations'), count('fnf_settlements'),
  ]);
  const taken = Number((await trx.selectFrom('leave_entries').select(sql<string>`COUNT(*)`.as('n'))
    .where('employee_id', '=', id).where('kind', 'in', ['taken', 'encashed']).where('status', '=', 'approved').executeTakeFirst())?.n ?? 0);
  const uses = [
    runs && `${runs} payroll month${runs === 1 ? '' : 's'}`,
    loans && `${loans} advance${loans === 1 ? '' : 's'}`,
    claims && `${claims} expense claim${claims === 1 ? '' : 's'}`,
    declarations && `${declarations} investment declaration${declarations === 1 ? '' : 's'}`,
    fnf && 'a full and final settlement',
    taken && `${taken} leave record${taken === 1 ? '' : 's'}`,
  ].filter(Boolean) as string[];
  if (uses.length) {
    throw conflict(
      `${e.name} is on ${uses.join(', ')}, so they cannot be deleted: payslips, the PF and ESI returns and Form 16 name them. ` +
        'Mark them inactive instead by giving a leaving date: they drop off the next payroll and stay on the past ones.',
    );
  }
  // Their own opening leave and accruals go with them; salary rows go by the key's cascade.
  await trx.deleteFrom('leave_entries').where('employee_id', '=', id).where('org_id', '=', orgId).execute();
  await unlinkDocument(trx, orgId, 'employee', id);
  await trx.deleteFrom('employees').where('id', '=', id).where('org_id', '=', orgId).execute();
  return { name: e.name, code: e.code };
}

// ── Pay runs ─────────────────────────────────────────────────────────────────

async function lockedRun(trx: Trx, orgId: number, runId: number) {
  const run = await trx.selectFrom('payroll_runs').selectAll().where('id', '=', runId).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!run) throw notFound('That payroll run does not exist.');
  return run;
}

/** Statutory dues already paid for the run's month: they keep it. */
async function statutoryPaidFor(trx: Trx, orgId: number, month: string) {
  const paid = await trx.selectFrom('statutory_payments').select('component').where('org_id', '=', orgId).where('period', '=', month).execute();
  return [...new Set(paid.map((x) => COMPONENT_LABEL[x.component as StatutoryComponent]))];
}

/**
 * Take back the salary payment of a paid run: its entry is reversed and the
 * run is posted again, so it can be reopened and corrected. Refused while the
 * payment is matched to the bank statement.
 */
export async function unpayRun(trx: Trx, orgId: number, userId: number | null, runId: number, reason?: string | null) {
  const run = await lockedRun(trx, orgId, runId);
  const live = await trx.selectFrom('payroll_payments').select('id').where('run_id', '=', runId).where('reversed', '=', 0).executeTakeFirst();
  if (run.status !== 'paid' && !live) throw conflict('Only a paid payroll has a payment to undo.');
  // Every employee's payment taken back (salary-payments.ts); refused while one is matched to the statement.
  await reverseAllSalaryPayments(trx, orgId, userId, runId, reason ?? null);
}

/**
 * Delete a month's payroll. A draft simply goes. A posted one has its entry
 * reversed, and a paid one its payment too; the run is kept in
 * deleted_documents with its lines. Approved claims it repaid go back to
 * waiting (the key sets them free), and advance instalments it recovered are
 * owed again.
 */
export async function deleteRun(trx: Trx, orgId: number, userId: number | null, runId: number, reason?: string | null) {
  const run = await lockedRun(trx, orgId, runId);
  const label = monthLabel(run.month);
  if (run.status !== 'draft') {
    const paid = await statutoryPaidFor(trx, orgId, run.month);
    if (paid.length) {
      throw conflict(`${paid.join(', ')} for ${label} has been paid against this payroll. Delete that payment first (Payroll → Statutory), then the payroll.`);
    }
  }
  const lines = await trx.selectFrom('payroll_lines').selectAll().where('run_id', '=', runId).execute();
  const net = lines.reduce((t, l) => t + p(l.net_pay), 0);
  // Salaries paid, to everyone or some, are taken back first (refused while matched to the statement).
  const livePay = await trx.selectFrom('payroll_payments').select('id').where('run_id', '=', runId).where('reversed', '=', 0).executeTakeFirst();
  if (run.status === 'paid' || livePay) {
    await reverseAllSalaryPayments(trx, orgId, userId, runId, `Payroll for ${label} deleted${because(reason)}`);
  }
  const payments = await trx.selectFrom('payroll_payments').selectAll().where('run_id', '=', runId).execute();
  const reversal = await reverseForChange(trx, orgId, run.journal_entry_id, { memo: `Payroll for ${label} deleted${because(reason)}`, userId, module: 'accountant' });
  if (run.status !== 'draft') {
    const [arrears, recoveries] = await Promise.all([
      trx.selectFrom('payroll_arrears').selectAll().where('run_id', '=', runId).execute(),
      trx.selectFrom('payroll_recoveries').selectAll().where('run_id', '=', runId).execute(),
    ]);
    await recordDeletion(trx, {
      orgId, userId, docType: 'payroll_run', docId: runId, number: `Payroll ${run.month}`, date: lastDay(run.month), totalPaise: net,
      journalEntryId: run.journal_entry_id, reversalEntryId: reversal, reason,
      snapshot: { run: plain(run), lines: lines.map(plain), arrears: arrears.map(plain), recoveries: recoveries.map(plain), payments: payments.map(plain) },
    });
  }
  await unlinkDocument(trx, orgId, 'payroll_run', runId);
  await trx.deleteFrom('payroll_runs').where('id', '=', runId).execute();
  return { month: run.month, status: run.status };
}

// ── Advances and loans ───────────────────────────────────────────────────────

/** Recovered through posted or paid payrolls, and the first month it was. */
async function recoveredOf(trx: Trx, orgId: number, loanId: number) {
  const row = await trx.selectFrom('payroll_recoveries as x').innerJoin('payroll_runs as r', 'r.id', 'x.run_id')
    .select([sql<string>`COALESCE(SUM(x.amount), 0)`.as('amount'), sql<string | null>`MIN(r.month)`.as('first')])
    .where('r.org_id', '=', orgId).where('r.status', 'in', ['posted', 'paid']).where('x.loan_id', '=', loanId).executeTakeFirst();
  return { recoveredPaise: p(row?.amount ?? '0'), firstMonth: row?.first ?? null };
}

/**
 * Change an advance. The terms (instalment, first month, notes) change on the
 * row alone. A change to the money (amount, date, bank account, employee)
 * reverses the entry that paid it out and posts it again. Once part of it has
 * been recovered it stays with its employee, cannot fall below what came back,
 * and its recovery cannot start after a month that already recovered it.
 */
export async function updateLoan(trx: Trx, orgId: number, userId: number | null, id: number, input: LoanInput) {
  const l = await trx.selectFrom('employee_loans').selectAll().where('id', '=', id).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!l) throw notFound('That advance was not found.');
  if (l.status === 'cancelled') throw conflict('It was cancelled, and its entry reversed. Give a new advance instead.');
  const e = await trx.selectFrom('employees').select(['id', 'name', 'branch_id', 'date_of_leaving'])
    .where('id', '=', input.employeeId).where('org_id', '=', orgId).executeTakeFirst();
  if (!e) throw notFound('That employee was not found.');
  const done = await recoveredOf(trx, orgId, id);
  if (done.recoveredPaise > 0 && input.employeeId !== l.employee_id) {
    throw conflict(`${rupees(done.recoveredPaise)} of it has been recovered from the employee's salary, so it stays theirs.`);
  }
  if (!(input.amountPaise > 0)) throw badRequest('Give the amount lent.');
  if (input.amountPaise < done.recoveredPaise) throw badRequest(`${rupees(done.recoveredPaise)} has already been recovered; the amount cannot be less than that.`);
  if (!(input.instalmentPaise > 0) || input.instalmentPaise > input.amountPaise) {
    throw badRequest('The monthly instalment is more than nothing and no more than the amount.');
  }
  if (!MONTH.test(input.firstMonth)) throw badRequest('The first month of recovery is YYYY-MM.');
  if (input.firstMonth < input.givenOn.slice(0, 7)) throw badRequest('Recovery cannot start before the money is given.');
  if (done.firstMonth && input.firstMonth > done.firstMonth) {
    throw badRequest(`The ${monthLabel(done.firstMonth)} payroll already recovered some of it, so recovery starts then at the latest.`);
  }
  if (e.date_of_leaving && String(e.date_of_leaving).slice(0, 10) < input.givenOn) throw conflict(`${e.name} had left by then.`);
  const bank = await trx.selectFrom('bank_accounts').select(['ledger_account_id', 'name'])
    .where('id', '=', input.bankAccountId).where('org_id', '=', orgId).executeTakeFirst();
  if (!bank) throw notFound('That bank account does not exist.');

  const moneyChanged = input.amountPaise !== p(l.amount) || input.givenOn !== day(l.given_on)
    || input.bankAccountId !== l.paid_from_bank_id || input.employeeId !== l.employee_id || input.kind !== l.kind;
  let entryId = l.journal_entry_id;
  if (moneyChanged) {
    if (l.journal_entry_id && await bankLineMatched(trx, orgId, 'journal_entry', l.journal_entry_id)) {
      throw conflict(`The payment of this advance ${BANK_MATCHED}`);
    }
    await reverseForChange(trx, orgId, l.journal_entry_id, { memo: `Advance to ${e.name} changed`, userId, module: 'banking' });
    const acc = await accountIds(trx, orgId);
    entryId = (await postEntry(trx, {
      orgId, branchId: e.branch_id, date: input.givenOn,
      memo: `${input.kind === 'loan' ? 'Loan' : 'Salary advance'} to ${e.name}, from ${bank.name}`,
      sourceType: 'employee_loan', sourceId: id, userId, module: 'banking',
      lines: [
        { accountId: requireAccount(acc, CODE.LOANS_ADVANCES), debit: input.amountPaise, description: `${e.name}: recovered from salary` },
        { accountId: bank.ledger_account_id, credit: input.amountPaise },
      ],
    })).id;
  }
  await trx.updateTable('employee_loans').set({
    employee_id: e.id, kind: input.kind, amount: toSqlFromPaise(input.amountPaise), instalment: toSqlFromPaise(input.instalmentPaise),
    given_on: input.givenOn, first_month: input.firstMonth, paid_from_bank_id: input.bankAccountId, notes: input.notes?.trim() || null,
    journal_entry_id: entryId,
  }).where('id', '=', id).execute();
  await reprepare(trx, orgId, userId, await draftMonthsOf(trx, orgId, [l.employee_id, e.id]));
  return { name: e.name, reposted: moneyChanged };
}

/**
 * Delete an advance given in error: the entry that paid it out is reversed and
 * the advance kept in deleted_documents. Refused once a posted payroll has
 * recovered any of it; a draft that meant to recover it is worked out again.
 */
export async function deleteLoan(trx: Trx, orgId: number, userId: number | null, id: number, reason?: string | null) {
  const l = await trx.selectFrom('employee_loans as l').innerJoin('employees as e', 'e.id', 'l.employee_id')
    .selectAll('l').select('e.name').where('l.id', '=', id).where('l.org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!l) throw notFound('That advance was not found.');
  const done = await recoveredOf(trx, orgId, id);
  if (done.recoveredPaise > 0) {
    throw conflict(`${rupees(done.recoveredPaise)} of it has been recovered through payroll, so it stays. Change its instalment or amount instead.`);
  }
  if (l.status === 'active' && l.journal_entry_id && await bankLineMatched(trx, orgId, 'journal_entry', l.journal_entry_id)) {
    throw conflict(`The payment of this advance ${BANK_MATCHED}`);
  }
  const drafts = await trx.selectFrom('payroll_recoveries as x').innerJoin('payroll_runs as r', 'r.id', 'x.run_id')
    .select('r.month').where('x.loan_id', '=', id).execute();
  await trx.deleteFrom('payroll_recoveries').where('loan_id', '=', id).execute();
  // A cancelled advance's entry was reversed when it was cancelled.
  const reversal = l.status === 'active'
    ? await reverseForChange(trx, orgId, l.journal_entry_id, { memo: `Advance to ${l.name} deleted${because(reason)}`, userId, module: 'banking' })
    : null;
  const { name, ...row } = l;
  await recordDeletion(trx, {
    orgId, userId, docType: 'employee_loan', docId: id, number: `${l.kind === 'loan' ? 'Loan' : 'Advance'} to ${name}`,
    date: day(l.given_on), totalPaise: p(l.amount), journalEntryId: l.journal_entry_id, reversalEntryId: reversal, reason, snapshot: plain(row),
  });
  await unlinkDocument(trx, orgId, 'employee_loan', id);
  await trx.deleteFrom('employee_loans').where('id', '=', id).execute();
  await reprepare(trx, orgId, userId, drafts.map((d) => d.month));
  return { name, kind: l.kind };
}

// ── Expense claims ───────────────────────────────────────────────────────────

async function claimForChange(trx: Trx, orgId: number, id: number) {
  const c = await trx.selectFrom('reimbursement_claims as c').leftJoin('payroll_runs as r', 'r.id', 'c.paid_in_run_id')
    .select(['c.id', 'c.status', 'c.employee_id', 'c.amount', 'c.category', 'r.status as run_status', 'r.month'])
    .where('c.id', '=', id).where('c.org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!c) throw notFound('That claim was not found.');
  if (c.run_status && c.run_status !== 'draft') {
    throw conflict(`It was repaid with the ${monthLabel(c.month!)} payroll, which is ${c.run_status}. Reopen that payroll to change it.`);
  }
  return c;
}

/**
 * Correct a claim. A claim already approved or rejected goes back to waiting,
 * because what was approved is no longer what is claimed; a draft payroll that
 * was repaying it is worked out again.
 */
export async function updateClaim(trx: Trx, orgId: number, userId: number | null, id: number, input: {
  employeeId: number; claimDate: string; category: string; description?: string | null; amountPaise: Paise;
}) {
  const c = await claimForChange(trx, orgId, id);
  const e = await trx.selectFrom('employees').select('id').where('id', '=', input.employeeId).where('org_id', '=', orgId).executeTakeFirst();
  if (!e) throw notFound('That employee was not found.');
  if (!(input.amountPaise > 0)) throw badRequest('Give the amount claimed.');
  if (!input.category.trim()) throw badRequest('Say what the expense was for.');
  await trx.updateTable('reimbursement_claims').set({
    employee_id: e.id, claim_date: input.claimDate, category: input.category.trim().slice(0, 60),
    description: input.description?.trim() || null, amount: toSqlFromPaise(input.amountPaise),
    status: 'submitted', review_note: null, reviewed_by_user_id: null, paid_in_run_id: null,
  }).where('id', '=', id).execute();
  if (c.month) await reprepare(trx, orgId, userId, [c.month]);
  return { reopened: c.status !== 'submitted' };
}

export async function deleteClaim(trx: Trx, orgId: number, userId: number | null, id: number) {
  const c = await claimForChange(trx, orgId, id);
  await unlinkDocument(trx, orgId, 'reimbursement_claim', id);
  await trx.deleteFrom('reimbursement_claims').where('id', '=', id).execute();
  if (c.month) await reprepare(trx, orgId, userId, [c.month]);
  return { category: c.category, amountPaise: p(c.amount) };
}

// ── Investment declarations ──────────────────────────────────────────────────

export async function deleteDeclaration(trx: Trx, orgId: number, id: number) {
  const d = await trx.selectFrom('tax_declarations').select(['status', 'section']).where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
  if (!d) throw notFound('That declaration was not found.');
  if (d.status === 'accepted') throw conflict('Its proof has been accepted, so it stays: it counts towards the year’s TDS and Form 16.');
  await trx.deleteFrom('tax_declarations').where('id', '=', id).execute();
  return { section: d.section };
}

// ── Leave ────────────────────────────────────────────────────────────────────

/** Unpaid leave in a month whose payroll is posted has been paid on: the payroll is reopened first. */
async function guardUnpaidLeave(trx: Trx, orgId: number, leaveTypeId: number, from: string | null, to: string | null) {
  if (!from) return;
  const type = await trx.selectFrom('leave_types').select('paid').where('id', '=', leaveTypeId).executeTakeFirst();
  if (!type || type.paid) return;
  const months = new Set<string>();
  for (let m = from.slice(0, 7); m <= (to ?? from).slice(0, 7);) {
    months.add(m);
    const [y, mo] = m.split('-').map(Number);
    m = mo === 12 ? `${y + 1}-01` : `${y}-${pad(mo + 1)}`;
  }
  const posted = await trx.selectFrom('payroll_runs').select(['month', 'status']).where('org_id', '=', orgId)
    .where('month', 'in', [...months]).where('status', '<>', 'draft').orderBy('month').executeTakeFirst();
  if (posted) throw conflict(`The ${monthLabel(posted.month)} payroll is ${posted.status} with these days unpaid. Reopen it first, then change the leave.`);
}

async function leaveEntry(trx: Trx, orgId: number, id: number) {
  const e = await trx.selectFrom('leave_entries as e').innerJoin('employees as p', 'p.id', 'e.employee_id')
    .selectAll('e').select('p.name').where('e.id', '=', id).where('e.org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!e || e.status !== 'approved') throw notFound('That leave was not found, or is already cancelled.');
  if (!['taken', 'opening', 'adjustment'].includes(e.kind)) {
    throw conflict('Accruals and lapses come from payroll, and encashment from the settlement: change those instead.');
  }
  return e;
}

/** A balance granted by hand cannot be taken away from under leave already taken against it. */
async function guardGrantRemoval(trx: Trx, orgId: number, e: { id: number; employee_id: number; leave_type_id: number; days: unknown; name: string }, newDays: number) {
  const balance = (await leaveBalances(trx, orgId, '9999-12-31', e.employee_id)).get(e.employee_id)?.get(e.leave_type_id) ?? 0;
  const after = Math.round((balance - Number(e.days) + newDays) * 100) / 100;
  if (after < 0) throw conflict(`${e.name} has taken leave against it: their balance would fall to ${after} day(s). Change that leave first.`);
}

/**
 * Correct leave recorded by hand: leave taken (kind, dates, days, note), or an
 * opening balance or adjustment (days, date, note). The same checks as
 * recording it, leaving itself out of the clash and the balance.
 */
export async function updateLeaveEntry(trx: Trx, orgId: number, id: number, input: {
  leaveTypeId?: number; from?: string; to?: string; days?: number | null; date?: string; note?: string | null;
}) {
  const e = await leaveEntry(trx, orgId, id);
  const note = input.note === undefined ? e.note : input.note?.trim() || null;
  if (e.kind !== 'taken') {
    const days = Math.round((input.days ?? Number(e.days)) * 2) / 2;
    if (!days) throw badRequest('Give the number of days.');
    await guardGrantRemoval(trx, orgId, e, days);
    await trx.updateTable('leave_entries').set({ days: String(days), from_date: input.date ?? day(e.from_date), note }).where('id', '=', id).execute();
    return { name: e.name };
  }
  const typeId = input.leaveTypeId ?? e.leave_type_id;
  const from = input.from ?? day(e.from_date)!;
  const to = input.to ?? day(e.to_date)!;
  if (to < from) throw badRequest('Leave ends on or after the day it starts.');
  const type = await trx.selectFrom('leave_types').selectAll().where('id', '=', typeId).where('org_id', '=', orgId).executeTakeFirst();
  if (!type) throw notFound('That kind of leave was not found.');
  await guardUnpaidLeave(trx, orgId, e.leave_type_id, day(e.from_date), day(e.to_date));
  await guardUnpaidLeave(trx, orgId, typeId, from, to);
  const span = daysBetween(from, to);
  const days = Math.round((input.days ?? span) * 2) / 2;
  if (!(days > 0 && days <= span)) throw badRequest(`Between half a day and ${span} day(s) for those dates.`);
  const clash = await trx.selectFrom('leave_entries').select(['from_date', 'to_date'])
    .where('employee_id', '=', e.employee_id).where('kind', '=', 'taken').where('status', '=', 'approved').where('id', '<>', id)
    .where('from_date', '<=', to).where('to_date', '>=', from).executeTakeFirst();
  if (clash) throw conflict(`${e.name} already has leave from ${day(clash.from_date)} to ${day(clash.to_date)}.`);
  if (type.paid) {
    const have = (await leaveBalances(trx, orgId, to, e.employee_id)).get(e.employee_id)?.get(type.id) ?? 0;
    // This leave's own days come back to the balance it was taken from.
    const back = e.leave_type_id === type.id && day(e.from_date)! <= to ? Number(e.days) : 0;
    if (days > have + back) throw conflict(`${e.name} has ${have + back} day(s) of ${type.name.toLowerCase()} for this. Record the rest as leave without pay.`);
  }
  await trx.updateTable('leave_entries').set({ leave_type_id: type.id, from_date: from, to_date: to, days: String(days), note }).where('id', '=', id).execute();
  return { name: e.name };
}

/** Cancel leave recorded by hand; the row stays, marked cancelled, as cancelLeave always has. */
export async function deleteLeaveEntry(trx: Trx, orgId: number, id: number) {
  const e = await leaveEntry(trx, orgId, id);
  if (e.kind === 'taken') await guardUnpaidLeave(trx, orgId, e.leave_type_id, day(e.from_date), day(e.to_date));
  else await guardGrantRemoval(trx, orgId, e, 0);
  await trx.updateTable('leave_entries').set({ status: 'cancelled' }).where('id', '=', id).execute();
  return { name: e.name, kind: e.kind };
}

/** A kind of leave nobody has used goes; one with leave recorded is switched off instead. */
export async function deleteLeaveType(trx: Trx, orgId: number, id: number) {
  const t = await trx.selectFrom('leave_types').select(['id', 'code', 'name']).where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
  if (!t) throw notFound('That kind of leave was not found.');
  const used = Number((await trx.selectFrom('leave_entries').select(sql<string>`COUNT(*)`.as('n')).where('leave_type_id', '=', id).executeTakeFirst())?.n ?? 0);
  if (used) {
    throw conflict(`${t.name} has ${used} leave record(s), so it cannot be deleted. Mark it as inactive instead: it leaves the forms, and the balances and records stay.`);
  }
  await trx.deleteFrom('leave_types').where('id', '=', id).execute();
  return { code: t.code, name: t.name };
}

// ── Full and final settlements ───────────────────────────────────────────────

async function lockedFnf(trx: Trx, orgId: number, id: number) {
  const f = await trx.selectFrom('fnf_settlements as f').innerJoin('employees as e', 'e.id', 'f.employee_id')
    .selectAll('f').select('e.name').where('f.id', '=', id).where('f.org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!f) throw notFound('That settlement was not found.');
  return f;
}

/** The leave the settlement encashed, put back. */
async function dropEncashment(trx: Trx, orgId: number, employeeId: number, lastDay: string | null) {
  if (!lastDay) return;
  const row = await trx.selectFrom('leave_entries').select('id').where('org_id', '=', orgId).where('employee_id', '=', employeeId)
    .where('kind', '=', 'encashed').where('from_date', '=', lastDay).where('status', '=', 'approved').orderBy('id', 'desc').executeTakeFirst();
  if (row) await trx.deleteFrom('leave_entries').where('id', '=', row.id).execute();
}

/** Correct a posted settlement: its entry is reversed and it is worked out and posted again, on the same record. */
export async function updateFnf(trx: Trx, orgId: number, userId: number | null, id: number, input: FnfInput) {
  const f = await lockedFnf(trx, orgId, id);
  if (f.status === 'paid') throw conflict(`It was paid on ${day(f.paid_on)}. Delete it (the payment is reversed with it) and work it out again.`);
  if (f.status !== 'posted') throw conflict(`That settlement is ${f.status}.`);
  if (input.employeeId !== f.employee_id) throw badRequest('A settlement stays with its employee.');
  await fnfStatement(trx, orgId, input);
  await reverseForChange(trx, orgId, f.journal_entry_id, { memo: `Full and final settlement of ${f.name} changed`, userId, module: 'accountant' });
  await dropEncashment(trx, orgId, f.employee_id, day(f.last_day));
  return postFnf(trx, orgId, userId, input, { replaceId: id });
}

/**
 * Delete a settlement: its entry is reversed, and a paid one's payment too
 * (unless matched to the bank statement); the leave it encashed comes back.
 * The employee's leaving date stays, because they did leave.
 */
export async function deleteFnf(trx: Trx, orgId: number, userId: number | null, id: number, reason?: string | null) {
  const f = await lockedFnf(trx, orgId, id);
  if (f.status === 'paid' && f.payment_entry_id && await bankLineMatched(trx, orgId, 'journal_entry', f.payment_entry_id)) {
    throw conflict(`The payment of this settlement ${BANK_MATCHED}`);
  }
  if (f.status === 'paid') {
    await reverseForChange(trx, orgId, f.payment_entry_id, { memo: `Settlement payment to ${f.name} deleted${because(reason)}`, userId, module: 'banking' });
  }
  const reversal = f.status === 'reversed' ? null
    : await reverseForChange(trx, orgId, f.journal_entry_id, { memo: `Full and final settlement of ${f.name} deleted${because(reason)}`, userId, module: 'accountant' });
  await dropEncashment(trx, orgId, f.employee_id, day(f.last_day));
  const { name, ...row } = f;
  await recordDeletion(trx, {
    orgId, userId, docType: 'fnf', docId: id, number: `Settlement of ${name}`, date: day(f.last_day), totalPaise: p(f.net_amount),
    journalEntryId: f.journal_entry_id, reversalEntryId: reversal, reason, snapshot: plain(row),
  });
  await unlinkDocument(trx, orgId, 'fnf', id);
  await trx.deleteFrom('fnf_settlements').where('id', '=', id).execute();
  return { name };
}

// ── Statutory payments ───────────────────────────────────────────────────────

async function lockedStatutory(trx: Trx, orgId: number, id: number) {
  const sp = await trx.selectFrom('statutory_payments').selectAll().where('id', '=', id).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!sp) throw notFound('That payment was not found.');
  if (sp.journal_entry_id && await bankLineMatched(trx, orgId, 'journal_entry', sp.journal_entry_id)) {
    throw conflict(`This ${COMPONENT_LABEL[sp.component as StatutoryComponent]} payment ${BANK_MATCHED}`);
  }
  return sp;
}

/** Correct a PF, ESI, PT or LWF payment: reversed and paid again, on the same record. */
export async function updateStatutoryPayment(trx: Trx, orgId: number, userId: number | null, id: number, input: {
  component: StatutoryComponent; period: string; amountPaise: number; date: string; bankAccountId: number; reference?: string | null;
}) {
  const sp = await lockedStatutory(trx, orgId, id);
  // Checked first, so a refused edit leaves the payment as it was.
  await checkStatutoryPayment(trx, orgId, input, { replaceId: id });
  await reverseForChange(trx, orgId, sp.journal_entry_id, {
    memo: `${COMPONENT_LABEL[sp.component as StatutoryComponent]} payment for ${sp.period} changed`, userId, module: 'banking',
  });
  return payStatutory(trx, orgId, userId, input, { replaceId: id });
}

/** Delete a statutory payment entered in error: its entry is reversed and the due is open again. */
export async function deleteStatutoryPayment(trx: Trx, orgId: number, userId: number | null, id: number, reason?: string | null) {
  const sp = await lockedStatutory(trx, orgId, id);
  const label = `${COMPONENT_LABEL[sp.component as StatutoryComponent]} for ${sp.period}`;
  const reversal = await reverseForChange(trx, orgId, sp.journal_entry_id, { memo: `${label} payment deleted${because(reason)}`, userId, module: 'banking' });
  await recordDeletion(trx, {
    orgId, userId, docType: 'statutory_payment', docId: id, number: sp.reference ? `${label} (${sp.reference})` : label,
    date: day(sp.paid_on), totalPaise: p(sp.amount), journalEntryId: sp.journal_entry_id, reversalEntryId: reversal, reason, snapshot: plain(sp),
  });
  await trx.deleteFrom('statutory_payments').where('id', '=', id).execute();
  return { label, amountPaise: p(sp.amount) };
}
