import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Form 16 Part B (Form 130 under the Income-tax Act, 2025, from April 2026):
// the year's salary and the tax on it, worked out from the posted payrolls.
//
// Part A, the certificate of tax deducted and deposited, is the one TRACES
// issues against the quarterly returns; it cannot be made here and is
// attached to this. Part B is the employer's own statement: salary, the HRA
// exemption, the standard deduction, professional tax, chapter VI-A
// deductions from the proofs accepted, and the tax — set against what was
// deducted, quarter by quarter.
//
// Before the year ends, Part B is provisional. Section 192 has the employer
// deduct on the estimated salary of the whole year, spread over its months;
// working the tax on the salary paid so far instead (two months of a year,
// say) gives a tax far below what was rightly deducted, and would call the
// difference "refundable" when it is not. So mid-year the salary still to be
// paid is projected at the structure in force, exactly as the monthly TDS
// computation does (payroll.ts computeLine), the statement is marked
// provisional for the year to date, and the balance is what is still to be
// deducted in the months left (or, if more was deducted, what later months
// deduct less by under section 192(3)), never a refund. Once the year is over,
// or the employee has left, it is the final statement on the salary paid.
// ─────────────────────────────────────────────────────────────────────────────

import type { Executor } from '../db';
import type { Paise } from '../../types';
import { toPaiseFromSql } from '../money-sql';
import { unseal } from '../crypto/fields';
import { notFound } from '../http';
import { oldRegimeDeductions, taxComputation, type DeductionSection } from '../../payroll/statutory';
import { deductionItems } from './declarations';
import { salaryOn, structureGross } from './payroll';

const indiaDay = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
const endOfMonth = (ym: string) => { const [y, m] = ym.split('-').map(Number); return `${ym}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`; };

const p = toPaiseFromSql;
const pad = (n: number) => String(n).padStart(2, '0');

export async function form16(ex: Executor, orgId: number, employeeId: number, fyStart: number, asOf: string = indiaDay()) {
  const e = await ex.selectFrom('employees')
    .select(['id', 'code', 'name', 'pan', 'designation', 'date_of_joining', 'date_of_leaving', 'tax_regime', 'metro_city', 'declared_deductions'])
    .where('id', '=', employeeId).where('org_id', '=', orgId).executeTakeFirst();
  if (!e) throw notFound('That employee was not found.');
  const org = await ex.selectFrom('organizations').select(['name', 'legal_name', 'pan', 'tan', 'address']).where('id', '=', orgId).executeTakeFirstOrThrow();

  const months = Array.from({ length: 12 }, (_, i) => (i < 9 ? `${fyStart}-${pad(i + 4)}` : `${fyStart + 1}-${pad(i - 8)}`));
  const lines = await ex.selectFrom('payroll_lines as l').innerJoin('payroll_runs as r', 'r.id', 'l.run_id')
    .select(['r.month', 'l.gross', 'l.basic', 'l.da', 'l.hra', 'l.arrears', 'l.pt', 'l.tds'])
    .where('r.org_id', '=', orgId).where('l.employee_id', '=', e.id).where('r.status', 'in', ['posted', 'paid'])
    .where('r.month', 'in', months).orderBy('r.month').execute();
  const sum = (k: 'gross' | 'hra' | 'pt' | 'tds' | 'arrears') => lines.reduce((t, l) => t + p(l[k]), 0);
  const paidToDate = sum('gross');
  const old = e.tax_regime === 'old';
  const doj = String(e.date_of_joining).slice(0, 10);
  const dol = e.date_of_leaving ? String(e.date_of_leaving).slice(0, 10) : null;

  // Final once the year is over, March is paid, or the employee has left; provisional before.
  const lastMonth = lines.length ? lines[lines.length - 1].month : null;
  const left = !!dol && dol <= `${fyStart + 1}-03-31` && dol <= asOf;
  const provisional = !!lastMonth && asOf <= `${fyStart + 1}-03-31` && lastMonth !== months[11] && !left;
  // The months still to be paid, at the structure in force at the last month paid (computeLine's projection).
  let monthsAhead = 0;
  let monthlyGross = 0;
  let structure: Awaited<ReturnType<typeof salaryOn>> = null;
  if (provisional && lastMonth) {
    const lastIdx = months.indexOf(lastMonth);
    const stopIdx = dol && dol <= `${fyStart + 1}-03-31` ? months.indexOf(dol.slice(0, 7)) : 11;
    monthsAhead = Math.max(0, stopIdx - lastIdx);
    structure = await salaryOn(ex, e.id, endOfMonth(lastMonth));
    monthlyGross = structure ? structureGross(structure) : 0;
    if (!structure) monthsAhead = 0;
  }
  const lastPt = lines.length ? p(lines[lines.length - 1].pt) : 0;
  const gross = paidToDate + monthsAhead * monthlyGross;
  const hraReceived = sum('hra') + monthsAhead * (structure?.hra ?? 0);
  const basicDa = lines.reduce((t, l) => t + p(l.basic) + p(l.da), 0) + monthsAhead * ((structure?.basic ?? 0) + (structure?.da ?? 0));
  const ptYear = sum('pt') + monthsAhead * lastPt;

  // The year over: only accepted proofs count, as they do from January. Mid-year:
  // what the employee has declared, as the monthly deduction uses.
  const items = await deductionItems(ex, orgId, e.id, fyStart, provisional && lastMonth ? lastMonth : `${fyStart + 1}-03`);
  const ded = items
    ? oldRegimeDeductions(items, { hraReceived, basicDa, metro: !!e.metro_city })
    : { bySection: {} as Partial<Record<DeductionSection, Paise>>, hra: 0, total: p(e.declared_deductions) };
  const hraExempt = old ? ded.hra : 0;
  const chapterVIA = old ? ded.total - ded.hra : 0;
  const tax = taxComputation({ regime: e.tax_regime, grossSalary: gross, deductions: hraExempt + chapterVIA, professionalTax: ptYear });
  const deducted = sum('tds');

  const quarters = [0, 1, 2, 3].map((q) => {
    const qm = months.slice(q * 3, q * 3 + 3);
    const these = lines.filter((l) => qm.includes(l.month));
    return { quarter: q + 1, months: qm, paidPaise: these.reduce((t, l) => t + p(l.gross), 0), tdsPaise: these.reduce((t, l) => t + p(l.tds), 0) };
  });
  return {
    form: fyStart >= 2026 ? 'Form 130' : 'Form 16',
    fyStart, assessmentYear: `${fyStart + 1}-${String(fyStart + 2).slice(2)}`,
    employer: { name: org.legal_name ?? org.name, pan: org.pan, tan: org.tan, address: org.address },
    employee: {
      id: String(e.id), code: e.code, name: e.name, pan: unseal(e.pan), designation: e.designation, regime: e.tax_regime,
      from: doj > `${fyStart}-04-01` ? doj : `${fyStart}-04-01`,
      to: dol && dol < `${fyStart + 1}-03-31` ? dol : `${fyStart + 1}-03-31`,
    },
    monthsPaid: lines.length,
    /** Before the year ends: worked on the year's estimated salary, for the year to date. */
    provisional,
    asOf,
    lastMonthPaid: lastMonth,
    salaryToDatePaise: paidToDate,
    /** The months still to be paid in the year, at the structure in force, and the salary they will carry. */
    monthsAhead, monthlyGrossPaise: monthlyGross, projectedRestPaise: monthsAhead * monthlyGross,
    grossPaise: gross, arrearsPaise: sum('arrears'),
    hraExemptPaise: hraExempt,
    standardDeductionPaise: tax.standardDeduction,
    professionalTaxPaise: tax.professionalTax,
    incomeFromSalaryPaise: Math.max(0, gross - hraExempt - tax.standardDeduction - tax.professionalTax),
    chapterVIA: old ? (Object.entries(ded.bySection) as [DeductionSection, Paise][]).map(([section, amountPaise]) => ({ section, amountPaise })) : [],
    chapterVIAPaise: chapterVIA,
    taxablePaise: tax.taxable,
    slabTaxPaise: tax.slabTax, rebatePaise: tax.rebate, surchargePaise: tax.surcharge, cessPaise: tax.cess, taxPaise: tax.tax,
    deductedPaise: deducted,
    // Final: more deducted than due is refunded on the employee's return; less is theirs to pay.
    // Provisional: what the months left still deduct (less, if more was deducted, s.192(3)).
    balancePaise: tax.tax - deducted,
    quarters,
  };
}

/** Everyone paid in a year, for the list to print from. */
export async function form16Employees(ex: Executor, orgId: number, fyStart: number) {
  const months = Array.from({ length: 12 }, (_, i) => (i < 9 ? `${fyStart}-${pad(i + 4)}` : `${fyStart + 1}-${pad(i - 8)}`));
  const rows = await ex.selectFrom('payroll_lines as l').innerJoin('payroll_runs as r', 'r.id', 'l.run_id')
    .innerJoin('employees as e', 'e.id', 'l.employee_id')
    .select((eb) => ['e.id', 'e.code', 'e.name', 'e.pan', 'e.tax_regime', eb.fn.sum<string>('l.gross').as('gross'), eb.fn.sum<string>('l.tds').as('tds'), eb.fn.count<number>('l.id').as('months')])
    .where('r.org_id', '=', orgId).where('r.status', 'in', ['posted', 'paid']).where('r.month', 'in', months)
    .groupBy(['e.id', 'e.code', 'e.name', 'e.pan', 'e.tax_regime']).orderBy('e.code').execute();
  return rows.map((r) => ({
    employeeId: String(r.id), code: r.code, name: r.name, pan: unseal(r.pan), regime: r.tax_regime,
    grossPaise: p(r.gross), tdsPaise: p(r.tds), months: Number(r.months),
  }));
}
