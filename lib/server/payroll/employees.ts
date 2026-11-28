import 'server-only';

// Employees and their salary structure. The structure is dated: a raise adds
// a row from its date, so every past month is still worked out on the pay in
// force then.

import type { Executor, Trx } from '../db';
import type { Paise } from '../../types';
import { toPaiseFromSql, toSqlFromPaise } from '../money-sql';
import { seal, unseal } from '../crypto/fields';
import { badRequest, conflict, notFound } from '../http';
import { salaryOn, structureGross, type Structure } from './payroll';
import { epsEligible } from '../../payroll/statutory';

/**
 * The pension-scheme rule (EPS 1995, para 6A): someone who joined on or after
 * 1 September 2014 on PF wages above ₹15,000, and was not an EPS member
 * before, is taken out of EPS, so the ECR and the challan put the employer's
 * whole 12% into EPF. Only ever turns EPS off; a person kept out by choice
 * stays out. Run after the record or its joining salary changes.
 */
export async function applyEpsRule(trx: Trx, orgId: number, employeeId: number): Promise<boolean> {
  const e = await trx.selectFrom('employees').select(['id', 'date_of_joining', 'eps_member', 'eps_before_sep2014'])
    .where('id', '=', employeeId).where('org_id', '=', orgId).executeTakeFirst();
  if (!e) return false;
  const doj = String(e.date_of_joining).slice(0, 10);
  const atJoining = await salaryOn(trx, e.id, doj) ?? (await trx.selectFrom('employee_salaries').selectAll().where('employee_id', '=', e.id)
    .orderBy('effective_from').executeTakeFirst().then((r) => (r ? { basic: toPaiseFromSql(r.basic), da: toPaiseFromSql(r.da), hra: 0, special: 0, other: 0 } : null)));
  if (!atJoining) return !!e.eps_member;
  const ok = epsEligible({ dateOfJoining: doj, pfWageAtJoining: atJoining.basic + atJoining.da, memberBeforeSep2014: !!e.eps_before_sep2014 });
  if (!ok && e.eps_member) await trx.updateTable('employees').set({ eps_member: 0 }).where('id', '=', e.id).execute();
  return ok && !!e.eps_member;
}

export interface EmployeeInput {
  branchId: number;
  /**
   * The state the employee works in, for Professional Tax and LWF, where it is
   * not the branch's (a salesman in Pune on a Chennai registration). Left out,
   * it stays as it was; null means the branch's state.
   */
  workStateCode?: string | null;
  /** The cost centre (department or division) their salary is charged to. Left out, it stays as it was. */
  costCentreId?: number | null;
  code: string;
  name: string;
  gender?: 'male' | 'female' | 'other' | null;
  dateOfBirth?: string | null;
  dateOfJoining: string;
  dateOfLeaving?: string | null;
  designation?: string | null;
  department?: string | null;
  email?: string | null;
  mobile?: string | null;
  pan?: string | null;
  uan?: string | null;
  esiIpNumber?: string | null;
  pfMember?: boolean;
  epsMember?: boolean;
  /** Already in the pension scheme before 1 September 2014 (here or with an earlier employer): stays in EPS above ₹15,000. Left out, it stays as it was. */
  epsBeforeSep2014?: boolean;
  pfOnActual?: boolean;
  ptApplicable?: boolean;
  lwfApplicable?: boolean;
  disabled?: boolean;
  taxRegime?: 'new' | 'old';
  declaredDeductionsPaise?: Paise;
  /** Delhi, Mumbai, Kolkata or Chennai: half of basic and DA towards the HRA exemption, not two-fifths. */
  metroCity?: boolean;
  bankAccountName?: string | null;
  bankAccountNo?: string | null;
  bankIfsc?: string | null;
  /** Twelve digits, sealed at rest and only ever shown masked. Left out, it stays as it was. */
  aadhaarNo?: string | null;
}

const row = (i: EmployeeInput) => ({
  branch_id: i.branchId, code: i.code.trim(), name: i.name.trim(), gender: i.gender ?? null,
  ...(i.workStateCode !== undefined ? { work_state_code: i.workStateCode || null } : {}),
  ...(i.costCentreId !== undefined ? { cost_centre_id: i.costCentreId || null } : {}),
  date_of_birth: i.dateOfBirth || null, date_of_joining: i.dateOfJoining, date_of_leaving: i.dateOfLeaving || null,
  designation: i.designation || null, department: i.department || null, email: i.email || null, mobile: i.mobile || null,
  pan: seal(i.pan?.toUpperCase() || null), uan: i.uan || null, esi_ip_number: i.esiIpNumber || null,
  pf_member: i.pfMember === false ? 0 : 1, eps_member: i.epsMember === false ? 0 : 1, pf_on_actual: i.pfOnActual ? 1 : 0,
  ...(i.epsBeforeSep2014 !== undefined ? { eps_before_sep2014: i.epsBeforeSep2014 ? 1 : 0 } : {}),
  pt_applicable: i.ptApplicable === false ? 0 : 1, lwf_applicable: i.lwfApplicable === false ? 0 : 1, disabled: i.disabled ? 1 : 0,
  tax_regime: i.taxRegime ?? 'new', declared_deductions: toSqlFromPaise(i.declaredDeductionsPaise ?? 0), metro_city: i.metroCity ? 1 : 0,
  bank_account_name: i.bankAccountName || null, bank_account_no: seal(i.bankAccountNo || null), bank_ifsc: i.bankIfsc?.toUpperCase() || null,
  ...(i.aadhaarNo !== undefined ? { aadhaar_no: seal(i.aadhaarNo ? i.aadhaarNo.replace(/\s/g, '') : null) } : {}),
});

function check(i: EmployeeInput) {
  if (i.dateOfLeaving && i.dateOfLeaving < i.dateOfJoining) throw badRequest('The leaving date is before the joining date.');
  if (i.pan && !/^[A-Z]{5}\d{4}[A-Z]$/i.test(i.pan)) throw badRequest('A PAN is five letters, four digits, a letter.');
  if (i.uan && !/^\d{12}$/.test(i.uan)) throw badRequest('A UAN is twelve digits.');
  if (i.bankIfsc && !/^[A-Z]{4}0[A-Z0-9]{6}$/i.test(i.bankIfsc)) throw badRequest('An IFSC is four letters, a zero, and six letters or digits.');
  if (i.workStateCode && !/^\d{2}$/.test(i.workStateCode)) throw badRequest('Pick the state the employee works in.');
}

async function checkCostCentre(trx: Trx, orgId: number, id: number | null | undefined) {
  if (!id) return;
  const cc = await trx.selectFrom('cost_centres').select(['id', 'is_active']).where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
  if (!cc) throw notFound('That cost centre is not in this book.');
  if (!cc.is_active) throw badRequest('That cost centre is no longer in use.');
}

export async function createEmployee(trx: Trx, orgId: number, i: EmployeeInput, salary?: Structure & { effectiveFrom?: string }): Promise<number> {
  check(i);
  const branch = await trx.selectFrom('branches').select('id').where('id', '=', i.branchId).where('org_id', '=', orgId).executeTakeFirst();
  if (!branch) throw notFound('That branch is not in this book.');
  const dup = await trx.selectFrom('employees').select('id').where('org_id', '=', orgId).where('code', '=', i.code.trim()).executeTakeFirst();
  if (dup) throw conflict(`Employee code ${i.code} is already used.`);
  await checkCostCentre(trx, orgId, i.costCentreId);
  const id = Number((await trx.insertInto('employees').values({ org_id: orgId, ...row(i) }).executeTakeFirstOrThrow()).insertId);
  if (salary) await setSalary(trx, orgId, id, { ...salary, effectiveFrom: salary.effectiveFrom ?? i.dateOfJoining });
  await applyEpsRule(trx, orgId, id);
  return id;
}

export async function updateEmployee(trx: Trx, orgId: number, id: number, i: EmployeeInput): Promise<void> {
  check(i);
  const found = await trx.selectFrom('employees').select('id').where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
  if (!found) throw notFound('That employee does not exist.');
  const dup = await trx.selectFrom('employees').select('id').where('org_id', '=', orgId).where('code', '=', i.code.trim()).where('id', '<>', id).executeTakeFirst();
  if (dup) throw conflict(`Employee code ${i.code} is already used.`);
  await checkCostCentre(trx, orgId, i.costCentreId);
  await trx.updateTable('employees').set(row(i)).where('id', '=', id).execute();
  await applyEpsRule(trx, orgId, id);
}

/** A salary structure from a date; a second one on the same date replaces it. */
export async function setSalary(trx: Trx, orgId: number, employeeId: number, x: Structure & { effectiveFrom: string }): Promise<void> {
  const e = await trx.selectFrom('employees').select(['id', 'date_of_joining']).where('id', '=', employeeId).where('org_id', '=', orgId).executeTakeFirst();
  if (!e) throw notFound('That employee does not exist.');
  if (x.basic <= 0) throw badRequest('A salary needs a basic pay above zero.');
  if ([x.da, x.hra, x.special, x.other].some((v) => v < 0)) throw badRequest('Salary components cannot be negative.');
  // A month already posted on the old figures is never changed under it: the
  // next payroll pays the difference as arrears, which it works out for up to
  // twelve months back. Further back than that is refused.
  const posted = await trx.selectFrom('payroll_lines as l').innerJoin('payroll_runs as r', 'r.id', 'l.run_id')
    .select('r.month').where('l.employee_id', '=', employeeId).where('r.status', '<>', 'draft')
    .where('r.month', '>=', x.effectiveFrom.slice(0, 7)).orderBy('r.month', 'desc').executeTakeFirst();
  if (posted) {
    const [y, m] = posted.month.split('-').map(Number);
    const limit = `${m === 12 ? y : y - 1}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}`;
    if (x.effectiveFrom.slice(0, 7) < limit) {
      throw conflict(`Arrears are worked out for up to twelve months before the next payroll, from ${limit} at the earliest. Pay anything older as a bonus.`);
    }
  }
  const values = { basic: toSqlFromPaise(x.basic), da: toSqlFromPaise(x.da), hra: toSqlFromPaise(x.hra), special: toSqlFromPaise(x.special), other: toSqlFromPaise(x.other) };
  await trx.insertInto('employee_salaries').values({ employee_id: employeeId, effective_from: x.effectiveFrom, ...values })
    .onDuplicateKeyUpdate(values).execute();
  // The joining salary decides EPS (para 6A); a raise later does not.
  await applyEpsRule(trx, orgId, employeeId);
}

export async function listEmployees(ex: Executor, orgId: number, asOf: string) {
  const rows = await ex.selectFrom('employees as e').innerJoin('branches as b', 'b.id', 'e.branch_id')
    .selectAll('e').select(['b.name as branch_name', 'b.state_code'])
    .where('e.org_id', '=', orgId).orderBy('e.code').execute();
  return Promise.all(rows.map(async (e) => {
    const salary = await salaryOn(ex, e.id, asOf);
    const history = await ex.selectFrom('employee_salaries').select(['effective_from', 'basic', 'da', 'hra', 'special', 'other'])
      .where('employee_id', '=', e.id).orderBy('effective_from', 'desc').execute();
    return {
      id: String(e.id), branchId: String(e.branch_id), branchName: e.branch_name, stateCode: e.work_state_code ?? e.state_code,
      workStateCode: e.work_state_code, costCentreId: e.cost_centre_id ? String(e.cost_centre_id) : null,
      code: e.code, name: e.name, gender: e.gender, dateOfBirth: e.date_of_birth ? String(e.date_of_birth).slice(0, 10) : null,
      dateOfJoining: String(e.date_of_joining).slice(0, 10), dateOfLeaving: e.date_of_leaving ? String(e.date_of_leaving).slice(0, 10) : null,
      designation: e.designation, department: e.department, email: e.email, mobile: e.mobile, pan: unseal(e.pan), uan: e.uan,
      aadhaarMasked: (() => { const a = unseal(e.aadhaar_no); return a ? `XXXX XXXX ${a.slice(-4)}` : null; })(),
      esiIpNumber: e.esi_ip_number, pfMember: !!e.pf_member, epsMember: !!e.eps_member, epsBeforeSep2014: !!e.eps_before_sep2014, pfOnActual: !!e.pf_on_actual,
      ptApplicable: !!e.pt_applicable, lwfApplicable: !!e.lwf_applicable, disabled: !!e.disabled, taxRegime: e.tax_regime,
      declaredDeductionsPaise: toPaiseFromSql(e.declared_deductions), metroCity: !!e.metro_city,
      bankAccountName: e.bank_account_name, bankAccountNo: unseal(e.bank_account_no), bankIfsc: e.bank_ifsc,
      salary, monthlyGrossPaise: salary ? structureGross(salary) : 0,
      salaryHistory: history.map((h) => ({
        effectiveFrom: String(h.effective_from).slice(0, 10), basic: toPaiseFromSql(h.basic), da: toPaiseFromSql(h.da),
        hra: toPaiseFromSql(h.hra), special: toPaiseFromSql(h.special), other: toPaiseFromSql(h.other),
      })),
    };
  }));
}
