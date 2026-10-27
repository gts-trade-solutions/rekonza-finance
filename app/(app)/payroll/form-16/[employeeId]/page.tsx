'use client';

// One employee's Form 16 Part B (Form 130 from April 2026), set out to print.

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

interface Form16 {
  form: string; fyStart: number; assessmentYear: string;
  employer: { name: string; pan: string | null; tan: string | null; address: string | null };
  employee: { code: string; name: string; pan: string | null; designation: string | null; regime: 'new' | 'old'; from: string; to: string };
  monthsPaid: number; grossPaise: number; arrearsPaise: number; hraExemptPaise: number; standardDeductionPaise: number;
  professionalTaxPaise: number; incomeFromSalaryPaise: number; chapterVIA: { section: string; amountPaise: number }[]; chapterVIAPaise: number;
  taxablePaise: number; slabTaxPaise: number; rebatePaise: number; surchargePaise: number; cessPaise: number; taxPaise: number;
  deductedPaise: number; balancePaise: number; quarters: { quarter: number; months: string[]; paidPaise: number; tdsPaise: number }[];
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
            <div className="mx-auto max-w-3xl rounded-lg border bg-white p-8 text-[13px] text-slate-900 print:max-w-none print:rounded-none print:border-0 print:p-0">
              <div className="border-b pb-3 text-center">
                <p className="text-base font-semibold">{f.form}, Part B</p>
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
              <table className="mt-3 w-full">
                <tbody>
                  {row('1. Gross salary', f.grossPaise, { strong: true })}
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
                  {row(f.balancePaise >= 0 ? 'Tax still payable by the employee' : 'Deducted in excess, refundable on the return', Math.abs(f.balancePaise), { strong: true })}
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
                Part A, the certificate of tax deducted and deposited with its challan and receipt numbers, is issued through TRACES and is attached to this.
                Worked out from {f.monthsPaid} posted payroll month{f.monthsPaid === 1 ? '' : 's'}.
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
