'use client';

// Cost centres: departments, projects, sites or vehicles that income and
// expense are counted against, and the profit and loss of each. What carries
// no centre is shown beside them, so the columns add up to the whole P&L.

import { Fragment, useState } from 'react';
import { Loader2, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { PageHeader } from '@/components/shared/page-header';
import { AsyncPage, LoadingRows } from '@/components/shared/async-state';
import { Field } from '@/components/shared/form-bits';
import { Money } from '@/components/shared/money';
import { DateRangePicker } from '@/components/shared/date-range-picker';
import { downloadCsv, useReportRange } from '@/components/shared/report-shell';
import { api } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';
import { toRupees } from '@/lib/money';
import { cn } from '@/lib/utils';

interface Centre { id: string; code: string; name: string; category: string | null; isActive: boolean }
interface Column {
  id: string | null; code: string; name: string; category: string | null; incomePaise: number; expensePaise: number; netPaise: number;
  accounts: { code: string; name: string; type: 'income' | 'expense'; amountPaise: number }[];
}

export default function CostCentresPage() {
  const canEdit = usePermission('accountant', 'edit');
  const canSeeReport = usePermission('reports.financial', 'view');
  const [range, setRange] = useReportRange();
  const state = useApi(
    () => api.get<{ centres: Centre[]; columns?: Column[] }>('/api/cost-centres', canSeeReport ? { from: range.from, to: range.to } : {}),
    [range.from, range.to, canSeeReport],
  );
  const [f, setF] = useState({ code: '', name: '', category: '' });
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const save = async (payload: Record<string, unknown>, done: string) => {
    setBusy(true);
    try {
      await api.post('/api/cost-centres', payload);
      toast.success(done);
      await state.refetch();
      return true;
    } catch (e) {
      toast.error('Not saved', { description: e instanceof Error ? e.message : String(e) });
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title="Cost centres" description="Income and expense counted by department, project, site or vehicle. Name one on an invoice, bill or expense, or on a journal line." />
      <AsyncPage state={state} loading={<LoadingRows rows={6} />}>
        {(d) => (
          <div className="space-y-4">
            <Card className="space-y-3 p-5">
              <h3 className="text-sm font-semibold">Centres</h3>
              {d.centres.length === 0 ? (
                <p className="text-sm text-muted-foreground">None yet. Until there is one, the forms do not ask.</p>
              ) : (
                <ul className="divide-y rounded-md border text-sm">
                  {d.centres.map((c) => (
                    <li key={c.id} className={cn('flex flex-wrap items-center gap-3 px-3 py-2', !c.isActive && 'opacity-60')}>
                      <span className="font-mono text-xs">{c.code}</span>
                      <span className="font-medium">{c.name}</span>
                      {c.category && <Badge variant="outline" className="text-[10px]">{c.category}</Badge>}
                      {canEdit && (
                        <label className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
                          In use <Switch checked={c.isActive} onCheckedChange={(v) => void save({ ...c, isActive: v }, v ? `${c.name} back in use` : `${c.name} retired`)} />
                        </label>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {canEdit && (
                <div className="grid gap-2 sm:grid-cols-[120px_1fr_180px_auto] sm:items-end">
                  <Field label="Code"><Input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} placeholder="NORTH" className="font-mono" /></Field>
                  <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="North depot" /></Field>
                  <Field label="Category"><Input value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} placeholder="Department, Project…" /></Field>
                  <Button size="sm" className="w-fit gap-1.5" disabled={busy || !f.code || !f.name}
                    onClick={() => void save({ ...f, category: f.category || null }, `${f.name} added`).then((ok) => ok && setF({ code: '', name: '', category: f.category }))}>
                    {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />} Add
                  </Button>
                </div>
              )}
            </Card>

            {d.columns && (
              <Card className="space-y-3 p-5">
                <div className="flex flex-wrap items-end justify-between gap-3">
                  <h3 className="text-sm font-semibold">Profit and loss by cost centre</h3>
                  <div className="flex items-end gap-2">
                    <DateRangePicker value={range} onChange={setRange} label="Period" />
                    <Button size="sm" variant="outline" onClick={() => downloadCsv('cost-centres.csv', [
                      ['Cost centre', 'Category', 'Income', 'Expense', 'Net'],
                      ...d.columns!.map((c) => [`${c.code} ${c.name}`, c.category ?? '', toRupees(c.incomePaise), toRupees(c.expensePaise), toRupees(c.netPaise)]),
                    ])}>Export</Button>
                  </div>
                </div>
                <div className="overflow-x-auto rounded-md border">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b bg-muted/50 text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                        <th className="px-3 py-2 font-semibold">Cost centre</th>
                        <th className="px-3 py-2 text-right font-semibold">Income</th>
                        <th className="px-3 py-2 text-right font-semibold">Expense</th>
                        <th className="px-3 py-2 text-right font-semibold">Net</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.columns.map((c) => {
                        const key = c.id ?? 'none';
                        return (
                          <Fragment key={key}>
                            <tr className={cn('border-b hover:bg-accent/40', c.accounts.length && 'cursor-pointer', c.id === null && 'text-muted-foreground')}
                              onClick={() => c.accounts.length && setOpen(open === key ? null : key)}>
                              <td className="px-3 py-2">
                                <span className="font-mono text-xs">{c.code}</span> {c.name}
                                {c.category && <span className="ml-2 text-xs text-muted-foreground">{c.category}</span>}
                              </td>
                              <td className="px-3 py-2 text-right"><Money value={c.incomePaise} /></td>
                              <td className="px-3 py-2 text-right"><Money value={c.expensePaise} /></td>
                              <td className={cn('px-3 py-2 text-right font-medium', c.netPaise < 0 && 'text-destructive')}><Money value={c.netPaise} /></td>
                            </tr>
                            {open === key && c.accounts.map((a) => (
                              <tr key={`${key}-${a.code}`} className="border-b bg-muted/10 text-xs">
                                <td className="py-1.5 pl-8 pr-3"><span className="font-mono text-muted-foreground">{a.code}</span> {a.name}</td>
                                <td className="px-3 py-1.5 text-right">{a.type === 'income' && <Money value={a.amountPaise} />}</td>
                                <td className="px-3 py-1.5 text-right">{a.type === 'expense' && <Money value={a.amountPaise} />}</td>
                                <td />
                              </tr>
                            ))}
                          </Fragment>
                        );
                      })}
                      <tr className="border-t-2 bg-muted/40 font-semibold">
                        <td className="px-3 py-2">Total</td>
                        <td className="px-3 py-2 text-right"><Money value={d.columns.reduce((t, c) => t + c.incomePaise, 0)} /></td>
                        <td className="px-3 py-2 text-right"><Money value={d.columns.reduce((t, c) => t + c.expensePaise, 0)} /></td>
                        <td className="px-3 py-2 text-right"><Money value={d.columns.reduce((t, c) => t + c.netPaise, 0)} /></td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </Card>
            )}
          </div>
        )}
      </AsyncPage>
    </>
  );
}
