'use client';

// One payslip: earnings, deductions, the employer's own contributions, and the
// net pay in words. Printed a month at a time, or shared with the employee.

import { formatINR } from '@/lib/money';
import { rupeesInWords } from '@/lib/billing/words';
import { cn } from '@/lib/utils';
import type { Run, RunLine } from '@/app/(app)/payroll/runs/[id]/page';

export const monthName = (m: string) => new Date(`${m}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });

export function Payslip({ run, l, last }: { run: Run; l: RunLine; last: boolean }) {
  const earnings: [string, number][] = [
    ['Basic', l.basic], ['Dearness allowance', l.da], ['House rent allowance', l.hra], ['Special allowance', l.special],
    ['Other allowances', l.other], ['Bonus', l.bonus], ['Arrears', l.arrears],
  ];
  const deductions: [string, number][] = [
    ['Provident fund', l.pfEmployee], ['ESI', l.esiEmployee], ['Professional tax', l.pt], ['Labour welfare fund', l.lwfEmployee],
    ['Income tax (TDS)', l.tds], ['Advance recovered', l.advanceRecovery],
  ];
  const totalDeductions = deductions.reduce((t, [, v]) => t + v, 0);
  const row = (label: string, value: number) => (
    <div key={label} className="flex justify-between py-0.5"><span>{label}</span><span className="tabular-nums">{formatINR(value)}</span></div>
  );
  return (
    <div className={cn('mx-auto max-w-3xl rounded-lg border bg-white p-8 text-[13px] text-slate-900 print:max-w-none print:rounded-none print:border-0 print:p-0', !last && 'break-after-page')}>
      <div className="flex items-start justify-between border-b pb-3">
        <div>
          <p className="text-base font-semibold">{run.org.name}</p>
          <p className="text-xs text-slate-500">
            {[run.org.pfCode && `PF ${run.org.pfCode}`, run.org.esiCode && `ESI ${run.org.esiCode}`, run.org.tan && `TAN ${run.org.tan}`].filter(Boolean).join(' · ')}
          </p>
        </div>
        <div className="text-right">
          <p className="font-semibold">Payslip</p>
          <p className="text-xs text-slate-500">{monthName(run.month)}</p>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-x-8 gap-y-1 border-b py-3 text-xs">
        <span><span className="text-slate-500">Employee</span> {l.code} · {l.name}</span>
        <span><span className="text-slate-500">Designation</span> {l.designation ?? '—'}</span>
        <span><span className="text-slate-500">PAN</span> {l.pan ?? '—'}</span>
        <span><span className="text-slate-500">UAN</span> {l.uan ?? '—'}</span>
        <span><span className="text-slate-500">ESI number</span> {l.esiIpNumber ?? '—'}</span>
        <span><span className="text-slate-500">Bank</span> {l.bankAccountNo ? `•••• ${l.bankAccountNo.slice(-4)}` : '—'}</span>
        <span><span className="text-slate-500">Days paid</span> {l.paidDays} of {l.daysInMonth}{l.lopDays ? ` (${l.lopDays} without pay)` : ''}</span>
      </div>
      <div className="grid grid-cols-2 gap-8 py-3">
        <div>
          <p className="mb-1 font-semibold">Earnings</p>
          {earnings.filter(([, v]) => v).map(([k, v]) => row(k, v))}
          <div className="mt-1 flex justify-between border-t pt-1 font-medium"><span>Gross</span><span className="tabular-nums">{formatINR(l.gross)}</span></div>
          {l.reimbursement > 0 && row('Reimbursements', l.reimbursement)}
        </div>
        <div>
          <p className="mb-1 font-semibold">Deductions</p>
          {deductions.filter(([, v]) => v).map(([k, v]) => row(k, v))}
          <div className="mt-1 flex justify-between border-t pt-1 font-medium"><span>Total deductions</span><span className="tabular-nums">{formatINR(totalDeductions)}</span></div>
        </div>
      </div>
      <div className="flex items-center justify-between rounded-md bg-slate-100 px-4 py-3">
        <span className="font-semibold">Net pay</span>
        <span className="text-base font-semibold tabular-nums">{formatINR(l.netPay)}</span>
      </div>
      <p className="mt-1 text-xs text-slate-600">{rupeesInWords(l.netPay)}</p>
      <p className="mt-3 text-[11px] text-slate-500">
        Paid by the employer in addition: PF {formatINR(l.pfEmployerEpf + l.pfEmployerEps)} (pension {formatINR(l.pfEmployerEps)})
        {l.esiEmployer ? `, ESI ${formatINR(l.esiEmployer)}` : ''}{l.lwfEmployer ? `, LWF ${formatINR(l.lwfEmployer)}` : ''}.
        {l.notes ? ` ${l.notes}` : ''}
      </p>
      <p className="mt-4 text-[11px] text-slate-400">A computer-generated payslip; it needs no signature.</p>
    </div>
  );
}
