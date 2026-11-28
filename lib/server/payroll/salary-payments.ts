import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Paying salaries, employee by employee.
//
// A posted payroll owes each employee their net pay, held in Salaries Payable.
// It is paid from a bank account — everyone at once (one bank transfer file,
// one entry, one line on the statement) or some now and the rest later (a
// salary held back, an account that bounced) — and every employee's payment is
// kept on its own:
//
//   Dr Salaries Payable   one line per employee, naming them
//   Cr Bank               the total
//
// so Salaries Payable can be read off person by person, and one payment can be
// taken back without the others. Wages must be paid by the 7th or 10th of the
// next month (Code on Wages, 2019, section 17; Payment of Wages Act, 1936,
// section 5), so the register shows who is still unpaid.
//
// Taking a payment back reverses it: the entry itself when it paid only that
// employee, or an entry of the opposite sides for that employee alone when it
// paid several. A payment matched to the bank statement is unmatched first.
// ─────────────────────────────────────────────────────────────────────────────

import type { Executor, Trx } from '../db';
import type { Paise } from '../../types';
import { toPaiseFromSql, toSqlFromPaise } from '../money-sql';
import { badRequest, conflict, notFound } from '../http';
import { refuseFutureDate } from './paid-dates';
import { postEntry, reverseEntry } from '../ledger/posting';
import { CODE, accountIds, requireAccount } from '../ledger/chart-of-accounts';
import { bankLineMatched } from '../services/doc-delete';
import { unseal } from '../crypto/fields';
import { monthLabel } from '../../date-range';

const p = toPaiseFromSql;
/** RTGS carries ₹2 lakh and above; below that, NEFT (as payment-batches.ts). */
const RTGS_FROM: Paise = 2_00_000_00;

export interface SalaryPaymentRow {
  employeeId: string; code: string; name: string; netPaise: Paise; paidPaise: Paise; unpaidPaise: Paise;
  bankAccountName: string | null; bankAccountNo: string | null; bankIfsc: string | null;
  payments: { id: string; paidOn: string; amountPaise: Paise; bank: string; reference: string | null; entryId: string; reversed: boolean; reverseReason: string | null }[];
}

/** Each employee's net pay for the run, what is paid and what is not. */
export async function salaryPayments(ex: Executor, orgId: number, runId: number): Promise<{ month: string; status: string; rows: SalaryPaymentRow[]; netPaise: Paise; paidPaise: Paise }> {
  const run = await ex.selectFrom('payroll_runs').select(['id', 'month', 'status']).where('id', '=', runId).where('org_id', '=', orgId).executeTakeFirst();
  if (!run) throw notFound('That payroll run does not exist.');
  const [lines, pays] = await Promise.all([
    ex.selectFrom('payroll_lines as l').innerJoin('employees as e', 'e.id', 'l.employee_id')
      .select(['l.employee_id', 'e.code', 'e.name', 'l.net_pay', 'e.bank_account_name', 'e.bank_account_no', 'e.bank_ifsc'])
      .where('l.run_id', '=', runId).orderBy('e.code').execute(),
    ex.selectFrom('payroll_payments as x').innerJoin('bank_accounts as b', 'b.id', 'x.bank_account_id')
      .select(['x.id', 'x.employee_id', 'x.amount', 'x.paid_on', 'x.reference', 'x.journal_entry_id', 'x.reversed', 'x.reverse_reason', 'b.name as bank'])
      .where('x.run_id', '=', runId).orderBy('x.id').execute(),
  ]);
  const rows = lines.map((l) => {
    const mine = pays.filter((x) => x.employee_id === l.employee_id);
    const paid = mine.filter((x) => !x.reversed).reduce((t, x) => t + p(x.amount), 0);
    return {
      employeeId: String(l.employee_id), code: l.code, name: l.name, netPaise: p(l.net_pay), paidPaise: paid, unpaidPaise: Math.max(0, p(l.net_pay) - paid),
      bankAccountName: l.bank_account_name, bankAccountNo: unseal(l.bank_account_no), bankIfsc: l.bank_ifsc,
      payments: mine.map((x) => ({
        id: String(x.id), paidOn: String(x.paid_on).slice(0, 10), amountPaise: p(x.amount), bank: x.bank, reference: x.reference,
        entryId: String(x.journal_entry_id), reversed: !!x.reversed, reverseReason: x.reverse_reason,
      })),
    };
  });
  return { month: run.month, status: run.status, rows, netPaise: rows.reduce((t, r) => t + r.netPaise, 0), paidPaise: rows.reduce((t, r) => t + r.paidPaise, 0) };
}

/** The run is paid when nobody with net pay is left unpaid. */
async function settleStatus(trx: Trx, runId: number) {
  const run = await trx.selectFrom('payroll_runs').select(['org_id', 'status']).where('id', '=', runId).executeTakeFirstOrThrow();
  const s = await salaryPayments(trx, run.org_id, runId);
  const unpaid = s.rows.some((r) => r.unpaidPaise > 0);
  const live = await trx.selectFrom('payroll_payments').select(['paid_on', 'bank_account_id', 'journal_entry_id'])
    .where('run_id', '=', runId).where('reversed', '=', 0).orderBy('paid_on', 'desc').orderBy('id', 'desc').executeTakeFirst();
  await trx.updateTable('payroll_runs').set(unpaid || !live
    ? { status: 'posted', paid_on: null, paid_from_bank_id: null, payment_entry_id: null }
    : { status: 'paid', paid_on: String(live.paid_on).slice(0, 10), paid_from_bank_id: live.bank_account_id, payment_entry_id: live.journal_entry_id })
    .where('id', '=', runId).execute();
  return !unpaid;
}

/**
 * Pay the chosen employees' unpaid net salary (all of them when `employeeIds`
 * is null) from a bank account, in one entry.
 */
export async function paySalaries(
  trx: Trx, orgId: number, userId: number | null, runId: number,
  o: { bankAccountId: number; date: string; employeeIds: number[] | null; reference?: string | null },
): Promise<{ entryId: number; paidPaise: Paise; employees: number; fullyPaid: boolean }> {
  const run = await trx.selectFrom('payroll_runs').selectAll().where('id', '=', runId).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!run) throw notFound('That payroll run does not exist.');
  if (run.status === 'draft') throw conflict('Post the payroll before paying it.');
  if (run.status === 'paid') throw conflict(`Payroll for ${monthLabel(run.month)} is already paid.`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(o.date)) throw badRequest('Give the date the salaries were paid.');
  if (o.date < `${run.month}-01`) throw badRequest('Salaries cannot be paid before the month they are for.');
  refuseFutureDate(o.date, 'This salary payment');
  const bank = await trx.selectFrom('bank_accounts').select(['id', 'ledger_account_id', 'name']).where('id', '=', o.bankAccountId).where('org_id', '=', orgId).executeTakeFirst();
  if (!bank) throw notFound('That bank account does not exist.');
  const s = await salaryPayments(trx, orgId, runId);
  const chosen = s.rows.filter((r) => r.unpaidPaise > 0 && (!o.employeeIds || o.employeeIds.includes(Number(r.employeeId))));
  if (!chosen.length) throw badRequest(o.employeeIds ? 'Those employees are already paid for this month.' : 'Everyone is already paid for this month.');
  const total = chosen.reduce((t, r) => t + r.unpaidPaise, 0);
  const acc = await accountIds(trx, orgId);
  const branch = (await trx.selectFrom('branches').select('id').where('org_id', '=', orgId).orderBy('is_primary', 'desc').executeTakeFirstOrThrow()).id;
  const one = chosen.length === 1 ? chosen[0] : null;
  const entry = await postEntry(trx, {
    orgId, branchId: branch, date: o.date, sourceType: 'payroll_payment', sourceId: runId, userId, module: 'banking',
    memo: one
      ? `Salary for ${monthLabel(run.month)} paid to ${one.name} (${one.code}) from ${bank.name}${o.reference ? ` — ${o.reference}` : ''}`
      : `Salaries for ${monthLabel(run.month)} paid from ${bank.name} (${chosen.length} employees)${o.reference ? ` — ${o.reference}` : ''}`,
    lines: [
      ...chosen.map((r) => ({ accountId: requireAccount(acc, CODE.SALARIES_PAYABLE), debit: r.unpaidPaise, description: `Net salary ${monthLabel(run.month)}: ${r.name} (${r.code})` })),
      { accountId: bank.ledger_account_id, credit: total, description: `Salaries ${monthLabel(run.month)}` },
    ],
  });
  await trx.insertInto('payroll_payments').values(chosen.map((r) => ({
    org_id: orgId, run_id: runId, employee_id: Number(r.employeeId), amount: toSqlFromPaise(r.unpaidPaise), paid_on: o.date,
    bank_account_id: bank.id, reference: o.reference?.trim() || null, journal_entry_id: entry.id, created_by_user_id: userId,
  }))).execute();
  const fullyPaid = await settleStatus(trx, runId);
  return { entryId: entry.id, paidPaise: total, employees: chosen.length, fullyPaid };
}

/**
 * Take one employee's salary payment back, with a reason. The run goes back to
 * posted (someone is unpaid again); the payment stays on record, marked.
 */
export async function reverseSalaryPayment(trx: Trx, orgId: number, userId: number | null, paymentId: number, reason: string | null) {
  const x = await trx.selectFrom('payroll_payments as x').innerJoin('payroll_runs as r', 'r.id', 'x.run_id').innerJoin('employees as e', 'e.id', 'x.employee_id')
    .innerJoin('bank_accounts as b', 'b.id', 'x.bank_account_id')
    .select(['x.id', 'x.run_id', 'x.amount', 'x.journal_entry_id', 'x.reversed', 'x.paid_on', 'r.month', 'e.name', 'e.code', 'b.ledger_account_id'])
    .where('x.id', '=', paymentId).where('x.org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!x) throw notFound('That salary payment was not found.');
  if (x.reversed) throw conflict('That payment has already been taken back.');
  if (await bankLineMatched(trx, orgId, 'journal_entry', x.journal_entry_id)) {
    throw conflict('That payment is matched to a line of the bank statement. Undo the match in Banking first.');
  }
  const why = reason?.trim() ? ` — ${reason.trim()}` : '';
  // The entry itself is reversed only when it paid this employee alone; one
  // that paid others (even others already taken back) gets an entry of its own.
  const sharing = await trx.selectFrom('payroll_payments').select('id').where('journal_entry_id', '=', x.journal_entry_id)
    .where('id', '<>', paymentId).execute();
  let reversal: number;
  const already = await trx.selectFrom('journal_entries').select('id').where('reversal_of_entry_id', '=', x.journal_entry_id).executeTakeFirst();
  if (!sharing.length && !already) {
    reversal = (await reverseEntry(trx, orgId, x.journal_entry_id, { memo: `Salary payment to ${x.name} for ${monthLabel(x.month)} taken back${why}`, userId, module: 'banking' })).id;
  } else {
    // The entry paid others too: the opposite sides for this employee alone.
    const acc = await accountIds(trx, orgId);
    const branch = (await trx.selectFrom('branches').select('id').where('org_id', '=', orgId).orderBy('is_primary', 'desc').executeTakeFirstOrThrow()).id;
    reversal = (await postEntry(trx, {
      orgId, branchId: branch, date: String(x.paid_on).slice(0, 10), sourceType: 'payroll_payment', sourceId: x.run_id, userId, module: 'banking',
      memo: `Salary payment to ${x.name} (${x.code}) for ${monthLabel(x.month)} taken back${why}`,
      lines: [
        { accountId: x.ledger_account_id, debit: p(x.amount), description: `Salary to ${x.name} taken back` },
        { accountId: requireAccount(acc, CODE.SALARIES_PAYABLE), credit: p(x.amount), description: `Net salary ${monthLabel(x.month)}: ${x.name} (${x.code}) unpaid again` },
      ],
    })).id;
  }
  await trx.updateTable('payroll_payments').set({ reversed: 1, reversal_entry_id: reversal, reversed_at: new Date(), reverse_reason: reason?.trim() || null })
    .where('id', '=', paymentId).execute();
  await settleStatus(trx, x.run_id);
  return { runId: x.run_id, month: x.month, name: x.name, amountPaise: p(x.amount), reversalEntryId: reversal };
}

/**
 * Take back every live payment of a run (Undo payment, Delete, Edit): each
 * entry reversed whole where all its payments are live, otherwise each
 * payment on its own. A payroll paid before payments were kept per employee
 * has its one payment entry reversed, as before.
 */
export async function reverseAllSalaryPayments(trx: Trx, orgId: number, userId: number | null, runId: number, reason: string | null) {
  const run = await trx.selectFrom('payroll_runs').selectAll().where('id', '=', runId).where('org_id', '=', orgId).executeTakeFirstOrThrow();
  const live = await trx.selectFrom('payroll_payments').select(['id', 'journal_entry_id']).where('run_id', '=', runId).where('reversed', '=', 0).execute();
  if (!live.length && run.payment_entry_id) {
    if (await bankLineMatched(trx, orgId, 'journal_entry', run.payment_entry_id)) {
      throw conflict(`The salary payment for ${monthLabel(run.month)} is matched to a line of the bank statement. Undo that match in Banking first, then change it here.`);
    }
    const done = await trx.selectFrom('journal_entries').select('id').where('reversal_of_entry_id', '=', run.payment_entry_id).executeTakeFirst();
    if (!done) await reverseEntry(trx, orgId, run.payment_entry_id, { memo: `Salary payment for ${monthLabel(run.month)} undone${reason?.trim() ? ` — ${reason.trim()}` : ''}`, userId, module: 'banking' });
    await trx.updateTable('payroll_runs').set({ status: 'posted', paid_on: null, paid_from_bank_id: null, payment_entry_id: null }).where('id', '=', runId).execute();
    return { reversed: 1 };
  }
  for (const entryId of [...new Set(live.map((x) => x.journal_entry_id))]) {
    if (await bankLineMatched(trx, orgId, 'journal_entry', entryId)) {
      throw conflict(`A salary payment for ${monthLabel(run.month)} is matched to a line of the bank statement. Undo that match in Banking first, then change it here.`);
    }
  }
  const byEntry = new Map<number, number[]>();
  for (const x of live) byEntry.set(x.journal_entry_id, [...(byEntry.get(x.journal_entry_id) ?? []), x.id]);
  for (const [entryId, ids] of byEntry) {
    const all = await trx.selectFrom('payroll_payments').select('id').where('journal_entry_id', '=', entryId).execute();
    const already = await trx.selectFrom('journal_entries').select('id').where('reversal_of_entry_id', '=', entryId).executeTakeFirst();
    if (all.length === ids.length && !already) {
      const rev = await reverseEntry(trx, orgId, entryId, { memo: `Salaries for ${monthLabel(run.month)} taken back${reason?.trim() ? ` — ${reason.trim()}` : ''}`, userId, module: 'banking' });
      await trx.updateTable('payroll_payments').set({ reversed: 1, reversal_entry_id: rev.id, reversed_at: new Date(), reverse_reason: reason?.trim() || null })
        .where('id', 'in', ids).execute();
    } else {
      for (const id of ids) await reverseSalaryPayment(trx, orgId, userId, id, reason);
    }
  }
  await settleStatus(trx, runId);
  return { reversed: live.length };
}

/**
 * The bank's bulk-upload rows for the salaries still unpaid: one transfer per
 * employee, NEFT below ₹2 lakh and RTGS from it, the same columns as supplier
 * payment batches. Employees without bank details are named, not left out
 * silently.
 */
export async function salaryBankFile(ex: Executor, orgId: number, runId: number, o: { bankAccountId?: number | null; date: string }) {
  const s = await salaryPayments(ex, orgId, runId);
  const bank = o.bankAccountId
    ? await ex.selectFrom('bank_accounts').select(['account_number', 'name']).where('id', '=', o.bankAccountId).where('org_id', '=', orgId).executeTakeFirst()
    : null;
  const [y, m, d] = o.date.split('-');
  const ok = s.rows.filter((r) => r.unpaidPaise > 0 && r.bankAccountNo && r.bankIfsc);
  return {
    columns: ['Payment type', 'Beneficiary name', 'Beneficiary account no', 'IFSC', 'Amount', 'Value date', 'Debit account no', 'Remarks', 'Employee code'],
    rows: ok.map((r) => [
      r.unpaidPaise >= RTGS_FROM ? 'RTGS' : 'NEFT', r.bankAccountName || r.name, r.bankAccountNo!, r.bankIfsc!, (r.unpaidPaise / 100).toFixed(2),
      `${d}/${m}/${y}`, (bank?.account_number ?? '').replace(/\s/g, ''), `SALARY ${monthLabel(s.month).toUpperCase()}`.slice(0, 30), r.code,
    ]),
    totalPaise: ok.reduce((t, r) => t + r.unpaidPaise, 0),
    missing: s.rows.filter((r) => r.unpaidPaise > 0 && !(r.bankAccountNo && r.bankIfsc)).map((r) => `${r.code} ${r.name}`),
  };
}
