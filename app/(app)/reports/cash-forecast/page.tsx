'use client';

// Cash-flow forecast: the coming weeks of bank and cash, week by week, from
// what the books already know — invoices and bills by due date, recurring
// profiles, salaries and post-dated entries. Open a week to see what is in it.

import { useState } from 'react';
import Link from 'next/link';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Money } from '@/components/shared/money';
import { downloadCsv, ReportShell, ReportTable } from '@/components/shared/report-shell';
import { AsyncPage, LoadingRows } from '@/components/shared/async-state';
import { api } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { toRupees } from '@/lib/money';
import { cn } from '@/lib/utils';

type Kind = 'receivable' | 'payable' | 'cheque' | 'recurring_invoice' | 'recurring_journal' | 'payroll' | 'post_dated';
interface Item { date: string; kind: Kind; label: string; amountPaise: number; href: string | null; overdue?: boolean }
interface Week { start: string; end: string; inPaise: number; outPaise: number; closingPaise: number; items: Item[] }
interface Forecast {
  today: string; horizon: string; openingPaise: number; accounts: { name: string; kind: string; balancePaise: number }[];
  overdueReceivablesPaise: number; overdueReceivablesCounted: boolean; overduePayablesPaise: number;
  lowestPaise: number; lowestWeek: string; weeks: Week[];
}

const KIND: Record<Kind, string> = {
  receivable: 'Invoice due', payable: 'Bill due', cheque: 'Cheque', recurring_invoice: 'Recurring invoice', recurring_journal: 'Recurring entry',
  payroll: 'Salaries', post_dated: 'Post-dated entry',
};
const short = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });

export default function CashForecastPage() {
  const [weeks, setWeeks] = useState(13);
  const [lateDays, setLateDays] = useState(0);
  const [overdue, setOverdue] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const state = useApi(
    () => api.get<Forecast>('/api/cash-forecast', { weeks, lateDays, overdue: overdue ? '1' : '0' }),
    [weeks, lateDays, overdue],
  );

  return (
    <ReportShell
      title="Cash-flow forecast"
      description="Bank and cash over the coming weeks, from invoices and bills by due date, recurring profiles, salaries and post-dated entries. Tax payments are not included."
      extraActions={
        <>
          <div className="space-y-1">
            <label className="text-[11px] font-medium text-muted-foreground">Weeks ahead</label>
            <select value={weeks} onChange={(e) => setWeeks(Number(e.target.value))} className="h-9 rounded-md border border-input bg-background px-2 text-sm">
              {[4, 8, 13, 26].map((w) => <option key={w} value={w}>{w}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-[11px] font-medium text-muted-foreground">Customers pay late by (days)</label>
            <Input type="number" min={0} max={180} value={lateDays} onChange={(e) => setLateDays(Math.max(0, Number(e.target.value) || 0))} className="h-9 w-28" />
          </div>
          <label className="flex h-9 items-center gap-2 text-xs text-muted-foreground">
            <Checkbox checked={overdue} onCheckedChange={(v) => setOverdue(!!v)} /> Count overdue invoices
          </label>
        </>
      }
      onExport={() => {
        const f = state.data;
        if (!f) return;
        downloadCsv('cash-forecast.csv', [
          ['Week from', 'Week to', 'Date', 'What', 'Detail', 'In', 'Out', 'Closing'],
          ['', '', f.today, 'Opening balance', '', '', '', toRupees(f.openingPaise)],
          ...f.weeks.flatMap((w) => [
            ...w.items.map((i) => [w.start, w.end, i.date, KIND[i.kind], i.label, i.amountPaise > 0 ? toRupees(i.amountPaise) : '', i.amountPaise < 0 ? toRupees(-i.amountPaise) : '', '']),
            [w.start, w.end, '', 'Week total', '', toRupees(w.inPaise), toRupees(w.outPaise), toRupees(w.closingPaise)],
          ]),
        ]);
      }}
    >
      <AsyncPage state={state} loading={<LoadingRows rows={10} />}>
        {(f) => {
          const totalIn = f.weeks.reduce((t, w) => t + w.inPaise, 0);
          const totalOut = f.weeks.reduce((t, w) => t + w.outPaise, 0);
          const end = f.weeks.at(-1)?.closingPaise ?? f.openingPaise;
          return (
            <>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
                <Card className="p-4">
                  <p className="micro-label">Cash and bank today</p>
                  <Money value={f.openingPaise} className="mt-1.5 block text-2xl font-semibold" />
                  <p className="mt-0.5 text-xs text-muted-foreground">{f.accounts.length} account{f.accounts.length === 1 ? '' : 's'}</p>
                </Card>
                <Card className="p-4">
                  <p className="micro-label">Coming in</p>
                  <Money value={totalIn} className="mt-1.5 block text-2xl font-semibold text-emerald-600 dark:text-emerald-400" />
                  <p className="mt-0.5 text-xs text-muted-foreground">to {short(f.horizon)}</p>
                </Card>
                <Card className="p-4">
                  <p className="micro-label">Going out</p>
                  <Money value={totalOut} className="mt-1.5 block text-2xl font-semibold" />
                  <p className="mt-0.5 text-xs text-muted-foreground">to {short(f.horizon)}</p>
                </Card>
                <Card className="p-4">
                  <p className="micro-label">At the end</p>
                  <Money value={end} className={cn('mt-1.5 block text-2xl font-semibold', end < 0 && 'text-destructive')} />
                  <p className="mt-0.5 text-xs text-muted-foreground">{short(f.horizon)}</p>
                </Card>
                <Card className={cn('p-4', f.lowestPaise < 0 && 'border-destructive/50 bg-destructive/5')}>
                  <p className="micro-label">Lowest point</p>
                  <Money value={f.lowestPaise} className={cn('mt-1.5 block text-2xl font-semibold', f.lowestPaise < 0 && 'text-destructive')} />
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {f.lowestPaise < 0 ? 'Short in the week of ' : 'Week of '}{short(f.lowestWeek)}
                  </p>
                </Card>
              </div>

              {(f.overdueReceivablesPaise > 0 || f.overduePayablesPaise > 0) && (
                <Card className="space-y-1 p-4 text-xs text-muted-foreground">
                  {f.overdueReceivablesPaise > 0 && (
                    <p>
                      <Money value={f.overdueReceivablesPaise} className="font-medium text-foreground" /> of invoices is already past due —{' '}
                      {f.overdueReceivablesCounted ? 'counted as coming in this week.' : 'not counted, since it has not come when it should. Tick "Count overdue invoices" to expect it this week.'}
                    </p>
                  )}
                  {f.overduePayablesPaise > 0 && (
                    <p><Money value={f.overduePayablesPaise} className="font-medium text-foreground" /> of bills is already past due — counted as going out this week.</p>
                  )}
                </Card>
              )}

              <ReportTable>
                <thead>
                  <tr className="border-b bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-2.5 text-left font-semibold">Week</th>
                    <th className="px-4 py-2.5 text-right font-semibold">In</th>
                    <th className="px-4 py-2.5 text-right font-semibold">Out</th>
                    <th className="px-4 py-2.5 text-right font-semibold">Net</th>
                    <th className="px-4 py-2.5 text-right font-semibold">Closing</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-b bg-muted/20">
                    <td className="px-4 py-2 text-sm text-muted-foreground" colSpan={4}>Today, {short(f.today)}</td>
                    <td className="px-4 py-2 text-right font-medium"><Money value={f.openingPaise} /></td>
                  </tr>
                  {f.weeks.map((w) => {
                    const shown = open === w.start;
                    return [
                      <tr key={w.start} className={cn('border-b hover:bg-accent/40', w.items.length && 'cursor-pointer')}
                        onClick={() => w.items.length && setOpen(shown ? null : w.start)}>
                        <td className="px-4 py-2">
                          <span className="inline-flex items-center gap-1.5">
                            {w.items.length ? (shown ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />) : <span className="w-3.5" />}
                            {short(w.start)} – {short(w.end)}
                            <span className="text-xs text-muted-foreground">{w.items.length ? `${w.items.length} item${w.items.length === 1 ? '' : 's'}` : ''}</span>
                          </span>
                        </td>
                        <td className="px-4 py-2 text-right"><Money value={w.inPaise} showZero={false} /></td>
                        <td className="px-4 py-2 text-right"><Money value={w.outPaise} showZero={false} /></td>
                        <td className="px-4 py-2 text-right"><Money value={w.inPaise - w.outPaise} /></td>
                        <td className={cn('px-4 py-2 text-right font-medium', w.closingPaise < 0 && 'text-destructive')}><Money value={w.closingPaise} /></td>
                      </tr>,
                      shown && w.items.map((i, n) => (
                        <tr key={`${w.start}-${n}`} className="border-b bg-muted/10 text-xs">
                          <td className="py-1.5 pl-10 pr-4">
                            <span className="tabular-nums text-muted-foreground">{short(i.date)}</span>{' '}
                            <span className="text-muted-foreground">{KIND[i.kind]}{i.overdue ? ' (overdue)' : ''}:</span>{' '}
                            {i.href ? <Link href={i.href} className="hover:underline">{i.label}</Link> : i.label}
                          </td>
                          <td className="px-4 py-1.5 text-right">{i.amountPaise > 0 && <Money value={i.amountPaise} />}</td>
                          <td className="px-4 py-1.5 text-right">{i.amountPaise < 0 && <Money value={-i.amountPaise} />}</td>
                          <td colSpan={2} />
                        </tr>
                      )),
                    ];
                  })}
                </tbody>
              </ReportTable>
            </>
          );
        }}
      </AsyncPage>
    </ReportShell>
  );
}
