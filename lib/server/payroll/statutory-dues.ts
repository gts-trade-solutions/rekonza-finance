import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// The statutory side of payroll, month by month: the registers an auditor or
// an inspector asks for, and paying what each month owes.
//
//   PF register    UAN, PF wages, the employee's 12%, the employer's EPF and
//                  EPS (pension), EDLI and admin charges.
//   ESI register   IP number, ESI wages, employee 0.75%, employer 3.25%.
//   PT register    the Professional Tax deducted, by employee.
//   LWF register   employee and employer Labour Welfare Fund.
//   TDS on salary  the tax deducted (paid through the TDS challans).
//   Dues           each month's PF, ESI, PT and LWF: due (from the posted
//                  runs), paid (statutory_payments), what is left, the due date.
//
// Only posted or paid runs count: a draft is not yet a liability. Paying a due
// posts Dr the payable, Cr the bank, so the payable clears in the ledger too.
// ─────────────────────────────────────────────────────────────────────────────

import type { Executor, Trx } from '../db';
import type { Paise } from '../../types';
import { toPaiseFromSql, toSqlFromPaise } from '../money-sql';
import { badRequest, notFound } from '../http';
import { postEntry } from '../ledger/posting';
import { accountIds, CODE, requireAccount } from '../ledger/chart-of-accounts';
import { unseal } from '../crypto/fields';

export type StatutoryComponent = 'pf' | 'esi' | 'pt' | 'lwf';
export const COMPONENTS: StatutoryComponent[] = ['pf', 'esi', 'pt', 'lwf'];
export const COMPONENT_LABEL: Record<StatutoryComponent, string> = { pf: 'Provident Fund', esi: 'ESI', pt: 'Professional Tax', lwf: 'Labour Welfare Fund' };
const PAYABLE: Record<StatutoryComponent, string> = { pf: CODE.PF_PAYABLE, esi: CODE.ESI_PAYABLE, pt: CODE.PT_PAYABLE, lwf: CODE.LWF_PAYABLE };

export interface RegisterLine {
  month: string;
  employeeId: string;
  code: string;
  name: string;
  uan: string | null;
  esiIp: string | null;
  pan: string | null;
  grossPaise: Paise;
  pfWagePaise: Paise;
  epsWagePaise: Paise;
  pfEmployeePaise: Paise;
  epfEmployerPaise: Paise;
  epsEmployerPaise: Paise;
  edliPaise: Paise;
  pfAdminPaise: Paise;
  esiWagePaise: Paise;
  esiEmployeePaise: Paise;
  esiEmployerPaise: Paise;
  ptPaise: Paise;
  lwfEmployeePaise: Paise;
  lwfEmployerPaise: Paise;
  tdsPaise: Paise;
}

export interface DueRow {
  month: string;
  component: StatutoryComponent;
  /** By the 15th of the next month for PF and ESI; the state's date for PT and LWF varies, so none is given. */
  dueDate: string | null;
  duePaise: Paise;
  paidPaise: Paise;
  balancePaise: Paise;
  payments: { id: string; paidOn: string; amountPaise: Paise; reference: string | null; bank: string }[];
}

const p = toPaiseFromSql;
const nextMonth15 = (month: string) => {
  const [y, m] = month.split('-').map(Number);
  return `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-15`;
};

export async function statutoryRegister(ex: Executor, orgId: number, from: string, to: string): Promise<{ lines: RegisterLine[]; dues: DueRow[] }> {
  const rows = await ex.selectFrom('payroll_lines').innerJoin('payroll_runs', 'payroll_runs.id', 'payroll_lines.run_id')
    .innerJoin('employees', 'employees.id', 'payroll_lines.employee_id')
    .select([
      'payroll_runs.month', 'employees.id as employee_id', 'employees.code', 'employees.name', 'employees.uan', 'employees.esi_ip_number', 'employees.pan',
      'payroll_lines.gross', 'payroll_lines.pf_wage', 'payroll_lines.eps_wage', 'payroll_lines.pf_employee', 'payroll_lines.pf_employer_epf',
      'payroll_lines.pf_employer_eps', 'payroll_lines.pf_edli', 'payroll_lines.pf_admin', 'payroll_lines.esi_wage', 'payroll_lines.esi_employee',
      'payroll_lines.esi_employer', 'payroll_lines.pt', 'payroll_lines.lwf_employee', 'payroll_lines.lwf_employer', 'payroll_lines.tds',
    ])
    .where('payroll_runs.org_id', '=', orgId).where('payroll_runs.status', 'in', ['posted', 'paid'])
    .where('payroll_runs.month', '>=', from).where('payroll_runs.month', '<=', to)
    .orderBy('payroll_runs.month').orderBy('employees.code').execute();
  const lines: RegisterLine[] = rows.map((r) => ({
    month: r.month, employeeId: String(r.employee_id), code: r.code, name: r.name, uan: r.uan, esiIp: r.esi_ip_number,
    // PAN is sealed at rest; a register shows it.
    pan: r.pan ? (unseal(r.pan) ?? null) : null,
    grossPaise: p(r.gross), pfWagePaise: p(r.pf_wage), epsWagePaise: p(r.eps_wage), pfEmployeePaise: p(r.pf_employee),
    epfEmployerPaise: p(r.pf_employer_epf), epsEmployerPaise: p(r.pf_employer_eps), edliPaise: p(r.pf_edli), pfAdminPaise: p(r.pf_admin),
    esiWagePaise: p(r.esi_wage), esiEmployeePaise: p(r.esi_employee), esiEmployerPaise: p(r.esi_employer), ptPaise: p(r.pt),
    lwfEmployeePaise: p(r.lwf_employee), lwfEmployerPaise: p(r.lwf_employer), tdsPaise: p(r.tds),
  }));

  const dueOf = (l: RegisterLine, c: StatutoryComponent) =>
    c === 'pf' ? l.pfEmployeePaise + l.epfEmployerPaise + l.epsEmployerPaise + l.edliPaise + l.pfAdminPaise
      : c === 'esi' ? l.esiEmployeePaise + l.esiEmployerPaise
        : c === 'pt' ? l.ptPaise : l.lwfEmployeePaise + l.lwfEmployerPaise;
  const months = [...new Set(lines.map((l) => l.month))];
  const paid = await ex.selectFrom('statutory_payments').innerJoin('bank_accounts', 'bank_accounts.id', 'statutory_payments.bank_account_id')
    .select(['statutory_payments.id', 'statutory_payments.component', 'statutory_payments.period', 'statutory_payments.amount', 'statutory_payments.paid_on', 'statutory_payments.reference', 'bank_accounts.name as bank'])
    .where('statutory_payments.org_id', '=', orgId).where('statutory_payments.period', '>=', from).where('statutory_payments.period', '<=', to)
    .orderBy('statutory_payments.paid_on').execute();
  const dues: DueRow[] = [];
  for (const month of [...new Set([...months, ...paid.map((x) => x.period)])].sort()) {
    for (const c of COMPONENTS) {
      const due = lines.filter((l) => l.month === month).reduce((t, l) => t + dueOf(l, c), 0);
      const pays = paid.filter((x) => x.period === month && x.component === c);
      if (!due && !pays.length) continue;
      const paidPaise = pays.reduce((t, x) => t + p(x.amount), 0);
      dues.push({
        month, component: c, dueDate: c === 'pf' || c === 'esi' ? nextMonth15(month) : null,
        duePaise: due, paidPaise, balancePaise: due - paidPaise,
        payments: pays.map((x) => ({ id: String(x.id), paidOn: String(x.paid_on).slice(0, 10), amountPaise: p(x.amount), reference: x.reference, bank: x.bank })),
      });
    }
  }
  return { lines, dues };
}

/** Pay a month's PF, ESI, PT or LWF: Dr the payable, Cr the bank, kept against the month. */
export async function payStatutory(trx: Trx, orgId: number, userId: number | null, input: {
  component: StatutoryComponent; period: string; amountPaise: number; date: string; bankAccountId: number; reference?: string | null;
}): Promise<{ id: number; entryId: number }> {
  if (!/^\d{4}-\d{2}$/.test(input.period)) throw badRequest('Give the month the dues are for.');
  if (!(input.amountPaise > 0)) throw badRequest('Give the amount paid.');
  if (input.date < `${input.period}-01`) throw badRequest('Dues for a month cannot be paid before that month begins.');
  const { dues } = await statutoryRegister(trx, orgId, input.period, input.period);
  const due = dues.find((d) => d.component === input.component);
  if (!due || due.duePaise <= 0) throw badRequest(`No ${COMPONENT_LABEL[input.component]} is due for ${input.period}: post that month's payroll first.`);
  if (input.amountPaise > due.balancePaise) {
    throw badRequest(`Only ₹${(due.balancePaise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })} of ${COMPONENT_LABEL[input.component]} is left to pay for ${input.period}.`);
  }
  const bank = await trx.selectFrom('bank_accounts').select(['ledger_account_id', 'name']).where('id', '=', input.bankAccountId).where('org_id', '=', orgId).executeTakeFirst();
  if (!bank) throw notFound('That bank account does not exist.');
  const acc = await accountIds(trx, orgId);
  const branch = (await trx.selectFrom('branches').select('id').where('org_id', '=', orgId).orderBy('is_primary', 'desc').executeTakeFirstOrThrow()).id;
  const label = `${COMPONENT_LABEL[input.component]} for ${input.period}`;
  // The payment first, so its entry can name it; the ledger is never edited after posting.
  const id = Number((await trx.insertInto('statutory_payments').values({
    org_id: orgId, component: input.component, period: input.period, amount: toSqlFromPaise(input.amountPaise as Paise),
    paid_on: input.date, bank_account_id: input.bankAccountId, reference: input.reference?.trim() || null,
    journal_entry_id: null, created_by_user_id: userId,
  }).executeTakeFirstOrThrow()).insertId);
  const entry = await postEntry(trx, {
    orgId, branchId: branch, date: input.date, memo: `${label} paid from ${bank.name}${input.reference ? ` (${input.reference})` : ''}`,
    sourceType: 'statutory_payment', sourceId: id, userId, module: 'banking',
    lines: [
      { accountId: requireAccount(acc, PAYABLE[input.component]), debit: input.amountPaise as Paise, description: label },
      { accountId: bank.ledger_account_id, credit: input.amountPaise as Paise, description: label },
    ],
  });
  await trx.updateTable('statutory_payments').set({ journal_entry_id: entry.id }).where('id', '=', id).execute();
  return { id, entryId: entry.id };
}
