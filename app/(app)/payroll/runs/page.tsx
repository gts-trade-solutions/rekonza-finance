'use client';

// Payroll runs, month by month, and the quarter's salary TDS for the return
// (Form 24Q; Form 138 from April 2026).

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Download, Loader2, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PageHeader } from '@/components/shared/page-header';
import { DataTable, type Column } from '@/components/shared/data-table';
import { Money } from '@/components/shared/money';
import { AsyncPage, LoadingRows } from '@/components/shared/async-state';
import { ReportTable } from '@/components/shared/report-shell';
import { api } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';
import { today } from '@/lib/selectors';
import { downloadWorkbook } from '@/lib/xlsx';

interface RunRow { id: string; month: string; status: 'draft' | 'posted' | 'paid'; paidOn: string | null; employees: number; grossPaise: number; netPaise: number }
interface TdsQuarter { fy: number; quarter: number; months: string[]; form: string; rows: { month: string; employeeId: string; code: string; name: string; pan: string | null; paidPaise: number; tdsPaise: number }[] }

const monthName = (m: string) => new Date(`${m}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
const STATUS: Record<RunRow['status'], string> = {
  draft: 'text-muted-foreground', posted: 'border-sky-500/40 text-sky-700 dark:text-sky-300', paid: 'border-emerald-500/40 text-emerald-700 dark:text-emerald-300',
};
const th = 'px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground';
const fyNow = () => (Number(today().slice(5, 7)) >= 4 ? Number(today().slice(0, 4)) : Number(today().slice(0, 4)) - 1);

export default function PayrollRunsPage() {
  const router = useRouter();
  const canCreate = usePermission('payroll', 'create');
  const state = useApi<{ runs: RunRow[] }>(() => api.get('/api/payroll/runs'), []);
  const [month, setMonth] = useState(today().slice(0, 7));
  const [busy, setBusy] = useState(false);

  const prepare = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ id: string }>('/api/payroll/runs', { month });
      router.push(`/payroll/runs/${r.id}`);
    } catch (e) {
      toast.error('Not prepared', { description: e instanceof Error ? e.message : String(e) });
      setBusy(false);
    }
  };

  const cols: Column<RunRow>[] = [
    { key: 'month', header: 'Month', sortValue: (r) => r.month, cell: (r) => <span className="font-medium">{monthName(r.month)}</span> },
    { key: 'status', header: 'Status', sortValue: (r) => r.status, cell: (r) => <Badge variant="outline" className={`text-[10px] capitalize ${STATUS[r.status]}`}>{r.status}{r.paidOn ? ` ${r.paidOn}` : ''}</Badge> },
    { key: 'employees', header: 'Employees', align: 'right', sortValue: (r) => r.employees, cell: (r) => <span className="tabular-nums">{r.employees}</span> },
    { key: 'gross', header: 'Gross', align: 'right', sortValue: (r) => r.grossPaise, cell: (r) => <Money value={r.grossPaise} /> },
    { key: 'net', header: 'Net pay', align: 'right', sortValue: (r) => r.netPaise, cell: (r) => <Money value={r.netPaise} className="font-medium" /> },
  ];

  return (
    <>
      <PageHeader
        title="Payroll"
        description="Each month's salaries with PF, ESI, professional tax and TDS, posted to the books and paid by bank file."
        actions={canCreate && (
          <div className="flex items-center gap-2">
            <Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="h-9 w-40" />
            <Button size="sm" className="gap-1.5" disabled={busy || !month} onClick={() => void prepare()}>
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-4" />} Prepare payroll
            </Button>
          </div>
        )}
      />
      <Tabs defaultValue="runs">
        <TabsList>
          <TabsTrigger value="runs">Months</TabsTrigger>
          <TabsTrigger value="tds">TDS on salary</TabsTrigger>
        </TabsList>
        <TabsContent value="runs" className="mt-4">
          <AsyncPage state={state} loading={<LoadingRows rows={6} />}>
            {(d) => (
              <DataTable rows={d.runs} columns={cols} getRowId={(r) => r.id} onRowClick={(r) => router.push(`/payroll/runs/${r.id}`)}
                searchable={false} emptyMessage="No payroll yet. Pick a month and prepare it." />
            )}
          </AsyncPage>
        </TabsContent>
        <TabsContent value="tds" className="mt-4"><SalaryTds /></TabsContent>
      </Tabs>
    </>
  );
}

function SalaryTds() {
  const [fy, setFy] = useState(fyNow());
  const [q, setQ] = useState(1);
  const state = useApi<TdsQuarter>(() => api.get('/api/payroll/runs', { view: 'tds', fy, quarter: q }), [fy, q]);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={String(fy)} onValueChange={(v) => setFy(Number(v))}>
          <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
          <SelectContent>{[0, 1, 2].map((i) => <SelectItem key={i} value={String(fyNow() - i)}>FY {fyNow() - i}-{String((fyNow() - i + 1) % 100).padStart(2, '0')}</SelectItem>)}</SelectContent>
        </Select>
        <Select value={String(q)} onValueChange={(v) => setQ(Number(v))}>
          <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
          <SelectContent>{['April–June', 'July–September', 'October–December', 'January–March'].map((l, i) => <SelectItem key={l} value={String(i + 1)}>Q{i + 1} · {l}</SelectItem>)}</SelectContent>
        </Select>
      </div>
      <AsyncPage state={state} loading={<LoadingRows rows={5} />}>
        {(d) => (
          <Card className="overflow-hidden p-0">
            <div className="flex items-center gap-2 border-b px-4 py-2.5">
              <p className="text-sm font-semibold">{d.form}: salary paid and tax deducted</p>
              <Button size="sm" variant="outline" className="ml-auto gap-1.5" disabled={!d.rows.length}
                onClick={() => downloadWorkbook(`${d.form.replace(' ', '-')}-${d.fy}-Q${d.quarter}.xlsx`, [{
                  name: 'Deductees', rows: [['Month', 'Employee code', 'Name', 'PAN', 'Amount paid', 'TDS'],
                    ...d.rows.map((r) => [r.month, r.code, r.name, r.pan ?? 'PANNOTAVBL', r.paidPaise / 100, r.tdsPaise / 100])],
                }])}>
                <Download className="size-3.5" /> Excel
              </Button>
            </div>
            {d.rows.length === 0 ? <p className="p-6 text-center text-sm text-muted-foreground">No posted payroll in this quarter.</p> : (
              <ReportTable>
                <thead><tr className="border-b">
                  <th className={`${th} text-left`}>Month</th><th className={`${th} text-left`}>Employee</th><th className={`${th} text-left`}>PAN</th>
                  <th className={`${th} text-right`}>Paid</th><th className={`${th} text-right`}>TDS</th>
                </tr></thead>
                <tbody className="divide-y">
                  {d.rows.map((r) => (
                    <tr key={`${r.month}-${r.employeeId}`}>
                      <td className="px-3 py-2 text-xs">{monthName(r.month)}</td>
                      <td className="px-3 py-2">{r.code} · {r.name}</td>
                      <td className="px-3 py-2 font-mono text-xs">{r.pan ?? <span className="text-amber-600">No PAN</span>}</td>
                      <td className="px-3 py-2 text-right"><Money value={r.paidPaise} /></td>
                      <td className="px-3 py-2 text-right"><Money value={r.tdsPaise} /></td>
                    </tr>
                  ))}
                </tbody>
              </ReportTable>
            )}
          </Card>
        )}
      </AsyncPage>
    </div>
  );
}
