'use client';

// Form 16 Part B (Form 130 from April 2026) for everyone paid in a year. Part
// A comes from TRACES once the quarterly returns are filed; Part B is printed
// here and the two go to the employee together.

import Link from 'next/link';
import { useState } from 'react';
import { FileText } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/shared/page-header';
import { AsyncPage, LoadingRows } from '@/components/shared/async-state';
import { Money } from '@/components/shared/money';
import { api } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';

interface Row { employeeId: string; code: string; name: string; pan: string | null; regime: 'new' | 'old'; grossPaise: number; tdsPaise: number; months: number }

const lastFy = () => { const d = new Date(); return (d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1) - 1; };
const fyLabel = (y: number) => `${y}-${String(y + 1).slice(2)}`;

export default function Form16ListPage() {
  const [fy, setFy] = useState(lastFy());
  const state = useApi(() => api.get<{ fy: number; employees: Row[] }>('/api/payroll/form16', { fy }), [fy]);
  const form = fy >= 2026 ? 'Form 130' : 'Form 16';
  return (
    <>
      <PageHeader
        title={`${form}, Part B`}
        description="The year's salary and the tax on it, employee by employee, from the posted payrolls. Part A is downloaded from TRACES after the fourth quarter's return; the two go out together by 15 June."
        actions={(
          <select value={fy} onChange={(e) => setFy(Number(e.target.value))} aria-label="Financial year"
            className="h-9 w-36 rounded-md border border-input bg-background px-2 text-sm">
            {[lastFy() + 1, lastFy(), lastFy() - 1, lastFy() - 2].map((y) => <option key={y} value={y}>FY {fyLabel(y)}</option>)}
          </select>
        )}
      />
      <AsyncPage state={state} loading={<LoadingRows rows={6} />}>
        {(d) => d.employees.length === 0 ? (
          <Card className="p-6 text-sm text-muted-foreground">No payroll was posted in FY {fyLabel(d.fy)}.</Card>
        ) : (
          <Card className="gap-0 overflow-hidden p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50 text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                  <th className="px-3 py-2 font-semibold">Employee</th>
                  <th className="px-3 py-2 font-semibold">PAN</th>
                  <th className="px-3 py-2 text-right font-semibold">Months</th>
                  <th className="px-3 py-2 text-right font-semibold">Salary</th>
                  <th className="px-3 py-2 text-right font-semibold">Tax deducted</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y">
                {d.employees.map((r) => (
                  <tr key={r.employeeId}>
                    <td className="px-3 py-2"><p className="font-medium">{r.name}</p><p className="text-xs text-muted-foreground">{r.code} · {r.regime === 'new' ? 'New regime' : 'Old regime'}</p></td>
                    <td className="px-3 py-2 font-mono text-xs">{r.pan ?? <span className="font-sans text-destructive">No PAN: TDS at 20%</span>}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.months}</td>
                    <td className="px-3 py-2 text-right"><Money value={r.grossPaise} /></td>
                    <td className="px-3 py-2 text-right"><Money value={r.tdsPaise} /></td>
                    <td className="px-3 py-2 text-right">
                      <Link href={`/payroll/form-16/${r.employeeId}?fy=${d.fy}`} className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
                        <FileText className="size-3.5" /> Part B
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </AsyncPage>
    </>
  );
}
