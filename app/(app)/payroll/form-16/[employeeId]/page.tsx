'use client';

// One employee's Form 16 (Form 130 from April 2026), set out to print: Part A,
// the tax deducted and deposited by quarter with the 24Q receipt numbers and
// the challans that carried it (the same links Form 24Q reports), and Part B,
// the salary and the tax on it.

import Link from 'next/link';
import { Suspense, use } from 'react';
import { useSearchParams } from 'next/navigation';
import { ArrowLeft, Printer } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { AsyncPage, LoadingRows } from '@/components/shared/async-state';
import { api } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { formatINR } from '@/lib/money';
import { cn } from '@/lib/utils';
import { printPage } from '@/lib/output-guard';
import { useDocumentTitle } from '@/lib/use-document-title';

interface Form16 {
  form: string; fyStart: number; assessmentYear: string;
  employer: { name: string; pan: string | null; tan: string | null; address: string | null };
  employee: { code: string; name: string; pan: string | null; designation: string | null; regime: 'new' | 'old'; from: string; to: string };
  monthsPaid: number; provisional: boolean; asOf: string; lastMonthPaid: string | null; salaryToDatePaise: number;
  monthsAhead: number; monthlyGrossPaise: number; projectedRestPaise: number; grossPaise: number; arrearsPaise: number; hraExemptPaise: number; standardDeductionPaise: number;
  professionalTaxPaise: number; incomeFromSalaryPaise: number; chapterVIA: { section: string; amountPaise: number }[]; chapterVIAPaise: number;
  taxablePaise: number; slabTaxPaise: number; rebatePaise: number; surchargePaise: number; cessPaise: number; taxPaise: number;
  deductedPaise: number; balancePaise: number; quarters: { quarter: number; months: string[]; paidPaise: number; tdsPaise: number }[];
  partA: {
    quarters: { quarter: number; receiptNo: string | null; paidPaise: number; deductedPaise: number; depositedPaise: number }[];
    challans: { challanId: string; month: string; bsrCode: string; date: string; serial: string; amountPaise: number }[];
    totals: { paidPaise: number; deductedPaise: number; depositedPaise: number };
  };
}

const dmy = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
const SECTION: Record<string, string> = {
  '80C': '80C', '80CCD1B': '80CCD(1B)', '80D': '80D', '80E': '80E', '80G': '80G', '80TTA': '80TTA', '24B': '24(b) home-loan interest', other: 'Other',
};

export default function Form16Page({ params }: { params: Promise<{ employeeId: string }> }) {
  const { employeeId } = use(params);
  return (
    <Suspense fallback={<LoadingRows rows={10} />}>
      <Form16View employeeId={employeeId} />
    </Suspense>
  );
}

function Form16View({ employeeId }: { employeeId: string }) {
  const fy = Number(useSearchParams().get('fy'));
  const state = useApi(() => api.get<Form16>('/api/payroll/form16', { fy, employeeId }), [fy, employeeId]);
  useDocumentTitle(state.data ? `Form 16 ${state.data.employee.name} AY ${state.data.assessmentYear}` : null);
  return (
    <AsyncPage state={state} loading={<LoadingRows rows={10} />}>
      {(f) => {
        const row = (label: string, v: number, o: { strong?: boolean; less?: boolean; indent?: boolean } = {}) => (
          <tr className={cn(o.strong && 'font-semibold')}>
            <td className={cn('py-1 pr-4', o.indent && 'pl-5')}>{label}</td>
            <td className="py-1 text-right tabular-nums">{o.less && v ? `(${formatINR(v)})` : formatINR(v)}</td>
          </tr>
        );
        const old = f.employee.regime === 'old';
        return (
          <div className="space-y-4">
            <div className="flex items-center gap-2 no-print">
              <Link href="/payroll/form-16" className={cn(buttonVariants({ size: 'sm', variant: 'ghost' }), 'gap-1.5')}><ArrowLeft className="size-3.5" /> Back</Link>
              <Button size="sm" className="ml-auto gap-1.5" onClick={() => printPage()}><Printer className="size-3.5" /> Print</Button>
            </div>
            <div className="mx-auto max-w-3xl rounded-lg border bg-white p-8 text-[13px] text-slate-900 print:max-w-none print:rounded-none print:border-0 print:p-0" data-slot="form16-part-a">
              <div className="border-b pb-3 text-center">
                <p className="text-base font-semibold">{f.form}, Part A</p>
                <p className="text-xs text-slate-500">Certificate under section 203 of tax deducted at source on salary · Financial year {f.fyStart}-{String(f.fyStart + 1).slice(2)} · Assessment year {f.assessmentYear}</p>
              </div>
              <div className="grid grid-cols-2 gap-6 border-b py-3 text-xs">
                <div><p className="mb-1 font-semibold">Deductor</p><p>{f.employer.name}</p><p>PAN {f.employer.pan ?? '—'} · TAN {f.employer.tan ?? '—'}</p></div>
                <div><p className="mb-1 font-semibold">Employee</p><p>{f.employee.name}</p><p>PAN {f.employee.pan ?? '—'}</p><p>Period {dmy(f.employee.from)} to {dmy(f.employee.to)}</p></div>
              </div>
              <p className="mt-3 mb-1 font-semibold">Summary of amount paid and tax deducted and deposited</p>
              <table className="w-full text-xs">
                <thead><tr className="border-b text-left text-slate-500"><th className="py-1">Quarter</th><th className="py-1">Receipt no. of 24Q</th><th className="py-1 text-right">Amount paid</th><th className="py-1 text-right">Tax deducted</th><th className="py-1 text-right">Tax deposited</th></tr></thead>
                <tbody>
                  {f.partA.quarters.map((q) => (
                    <tr key={q.quarter} className="border-b last:border-0">
                      <td className="py-1">Q{q.quarter}</td><td className="py-1 font-mono">{q.receiptNo ?? '— (not filed yet)'}</td>
                      <td className="py-1 text-right tabular-nums">{formatINR(q.paidPaise)}</td><td className="py-1 text-right tabular-nums">{formatINR(q.deductedPaise)}</td>
                      <td className="py-1 text-right tabular-nums">{formatINR(q.depositedPaise)}</td>
                    </tr>
                  ))}
                  <tr className="font-semibold"><td className="py-1" colSpan={2}>Total</td><td className="py-1 text-right tabular-nums">{formatINR(f.partA.totals.paidPaise)}</td><td className="py-1 text-right tabular-nums">{formatINR(f.partA.totals.deductedPaise)}</td><td className="py-1 text-right tabular-nums">{formatINR(f.partA.totals.depositedPaise)}</td></tr>
                </tbody>
              </table>
              <p className="mt-3 mb-1 font-semibold">Tax deposited through challan (ITNS 281)</p>
              {f.partA.challans.length === 0 ? <p className="text-xs text-slate-500">No challan is linked to this employee&apos;s tax yet (Payroll → Statutory Reports → TDS on salary).</p> : (
                <table className="w-full text-xs">
                  <thead><tr className="border-b text-left text-slate-500"><th className="py-1">Month</th><th className="py-1">BSR code</th><th className="py-1">Date deposited</th><th className="py-1">Challan serial no.</th><th className="py-1 text-right">Tax deposited for the employee</th></tr></thead>
                  <tbody>
                    {f.partA.challans.map((c) => (
                      <tr key={`${c.challanId}-${c.month}`} className="border-b last:border-0"><td className="py-1">{c.month}</td><td className="py-1 font-mono">{c.bsrCode}</td><td className="py-1">{dmy(c.date)}</td><td className="py-1 font-mono">{c.serial}</td><td className="py-1 text-right tabular-nums">{formatINR(c.amountPaise)}</td></tr>
                    ))}
                  </tbody>
                </table>
              )}
              <p className="mt-2 text-[11px] text-slate-500">The TRACES-issued Part A carries the same figures once the 24Q is processed; this one is drawn from the challans and links recorded here.</p>
            </div>
            <div className="mx-auto max-w-3xl rounded-lg border bg-white p-8 text-[13px] text-slate-900 print:max-w-none print:rounded-none print:border-0 print:p-0" data-slot="form16-part-b">
              <div className="border-b pb-3 text-center">
                <p className="text-base font-semibold">{f.form}, Part B{f.provisional ? ' (provisional)' : ''}</p>
                <p className="text-xs text-slate-500">Details of salary paid and tax deducted · Financial year {f.fyStart}-{String(f.fyStart + 1).slice(2)} · Assessment year {f.assessmentYear}</p>
              </div>
              <div className="grid grid-cols-2 gap-6 border-b py-3 text-xs">
                <div>
                  <p className="mb-1 font-semibold">Employer</p>
                  <p>{f.employer.name}</p>
                  {f.employer.address && <p className="text-slate-600">{f.employer.address}</p>}
                  <p>PAN {f.employer.pan ?? '—'} · TAN {f.employer.tan ?? '—'}</p>
                </div>
                <div>
                  <p className="mb-1 font-semibold">Employee</p>
                  <p>{f.employee.name} ({f.employee.code}){f.employee.designation ? `, ${f.employee.designation}` : ''}</p>
                  <p>PAN {f.employee.pan ?? '—'}</p>
                  <p>Employed {dmy(f.employee.from)} to {dmy(f.employee.to)} · {old ? 'Old regime' : 'New regime'}</p>
                </div>
              </div>
              {f.provisional && (
                <p className="mt-3 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900" data-slot="form16-provisional">
                  Provisional, for the year to date ({dmy(f.asOf)}). The year is not over, so the tax is worked out, as section 192 requires of the monthly deduction,
                  on the year&apos;s estimated salary: the salary paid up to {f.lastMonthPaid} and {f.monthsAhead} month{f.monthsAhead === 1 ? '' : 's'} still to be paid at the
                  current structure. The final {f.form} is issued after 31 March on the salary actually paid.
                </p>
              )}
              <table className="mt-3 w-full">
                <tbody>
                  {f.provisional && row('Salary paid to date', f.salaryToDatePaise, { indent: true })}
                  {f.provisional && row(`Salary still to be paid this year (estimated: ${f.monthsAhead} × ${formatINR(f.monthlyGrossPaise)})`, f.projectedRestPaise, { indent: true })}
                  {row(f.provisional ? '1. Gross salary for the year (estimated)' : '1. Gross salary', f.grossPaise, { strong: true })}
                  {f.arrearsPaise > 0 && row('of which arrears for earlier months', f.arrearsPaise, { indent: true })}
                  {old && row('2. Less: house rent allowance exempt', f.hraExemptPaise, { less: true })}
                  {row(`${old ? '3' : '2'}. Less: standard deduction`, f.standardDeductionPaise, { less: true })}
                  {old && row('4. Less: professional tax', f.professionalTaxPaise, { less: true })}
                  {row(`${old ? '5' : '3'}. Income chargeable under the head Salaries`, f.incomeFromSalaryPaise, { strong: true })}
                  {old && (
                    <>
                      <tr><td className="pt-2 font-medium">6. Deductions under chapter VI-A, as proved</td><td /></tr>
                      {f.chapterVIA.length === 0 ? row('None proved', 0, { indent: true }) : f.chapterVIA.map((c) => row(SECTION[c.section] ?? c.section, c.amountPaise, { indent: true }))}
                      {row('Total deductions', f.chapterVIAPaise, { less: true })}
                    </>
                  )}
                  {row(`${old ? '7' : '4'}. Total taxable income`, f.taxablePaise, { strong: true })}
                  {row('Tax on total income', f.slabTaxPaise, { indent: true })}
                  {f.rebatePaise > 0 && row('Less: rebate under s.87A', f.rebatePaise, { indent: true, less: true })}
                  {f.surchargePaise > 0 && row('Surcharge', f.surchargePaise, { indent: true })}
                  {row('Health and education cess at 4%', f.cessPaise, { indent: true })}
                  {row('Tax payable', f.taxPaise, { strong: true })}
                  {row('Tax deducted at source', f.deductedPaise)}
                  {f.provisional
                    ? row(f.balancePaise >= 0
                      ? `Tax still to be deducted in the ${f.monthsAhead} month${f.monthsAhead === 1 ? '' : 's'} left`
                      : 'Deducted ahead of the estimate so far: later months deduct less (section 192(3))', Math.abs(f.balancePaise), { strong: true })
                    : row(f.balancePaise >= 0 ? 'Tax still payable by the employee' : 'Deducted in excess, refundable on the return', Math.abs(f.balancePaise), { strong: true })}
                </tbody>
              </table>
              <p className="mt-4 mb-1 font-semibold">Tax deducted, quarter by quarter</p>
              <table className="w-full text-xs">
                <thead><tr className="border-b text-left text-slate-500"><th className="py-1">Quarter</th><th className="py-1">Months</th><th className="py-1 text-right">Salary paid</th><th className="py-1 text-right">Tax deducted</th></tr></thead>
                <tbody>
                  {f.quarters.map((q) => (
                    <tr key={q.quarter} className="border-b last:border-0">
                      <td className="py-1">Q{q.quarter}</td><td className="py-1">{q.months[0]} to {q.months[2]}</td>
                      <td className="py-1 text-right tabular-nums">{formatINR(q.paidPaise)}</td><td className="py-1 text-right tabular-nums">{formatINR(q.tdsPaise)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-4 text-[11px] text-slate-500">
                Worked out from {f.monthsPaid} posted payroll month{f.monthsPaid === 1 ? '' : 's'}{f.provisional ? `, and ${f.monthsAhead} month${f.monthsAhead === 1 ? '' : 's'} estimated` : ''}.
              </p>
              <div className="mt-10 flex justify-end text-xs">
                <div className="text-center"><div className="mb-1 h-10 w-56 border-b" /><p>Signature of the person responsible for deduction of tax</p></div>
              </div>
            </div>
          </div>
        );
      }}
    </AsyncPage>
  );
}
