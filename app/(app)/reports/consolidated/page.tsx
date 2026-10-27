'use client';

// Consolidated statements: every company you work in and may see the books
// of, account by account in columns, and their sum. Trade between these
// companies is not taken out, so a group selling within itself eliminates
// that by hand before reading the totals as the group's.

import { Fragment } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/shared/page-header';
import { AsyncPage, LoadingRows } from '@/components/shared/async-state';
import { Money } from '@/components/shared/money';
import { DateRangePicker } from '@/components/shared/date-range-picker';
import { downloadCsv, useReportRange } from '@/components/shared/report-shell';
import { api } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { toRupees } from '@/lib/money';
import { cn } from '@/lib/utils';

interface Row { code: string; name: string; by: Record<string, number>; total: number }
interface Sum { by: Record<string, number>; total: number }
interface Consolidated {
  from: string; to: string; companies: { orgId: string; name: string }[];
  income: Row[]; expenses: Row[]; totalIncome: Sum; totalExpense: Sum; netProfit: Sum;
  totalAssets: Sum; totalLiabilities: Sum; totalEquity: Sum;
}

export default function ConsolidatedPage() {
  const [range, setRange] = useReportRange();
  const state = useApi(() => api.get<Consolidated>('/api/reports/consolidated', { from: range.from, to: range.to }), [range.from, range.to]);
  return (
    <>
      <PageHeader
        title="Consolidated statements"
        description="Every company you work in and may see the books of, side by side and summed."
        actions={<DateRangePicker value={range} onChange={setRange} />}
      />
      <AsyncPage state={state} loading={<LoadingRows rows={10} />}>
        {(d) => {
          const ids = d.companies.map((c) => c.orgId);
          const head = (
            <tr className="border-b bg-muted/50 text-left text-[10px] uppercase tracking-wide text-muted-foreground">
              <th className="px-3 py-2 font-semibold">Account</th>
              {d.companies.map((c) => <th key={c.orgId} className="px-3 py-2 text-right font-semibold">{c.name}</th>)}
              <th className="px-3 py-2 text-right font-semibold">Together</th>
            </tr>
          );
          const line = (label: string, s: Sum, strong = false, key?: string) => (
            <tr key={key ?? label} className={cn('border-b', strong && 'bg-muted/40 font-semibold')}>
              <td className="px-3 py-1.5">{label}</td>
              {ids.map((id) => <td key={id} className="px-3 py-1.5 text-right"><Money value={s.by[id] ?? 0} /></td>)}
              <td className="px-3 py-1.5 text-right font-medium"><Money value={s.total} /></td>
            </tr>
          );
          const rows = (title: string, list: Row[], total: Sum) => (
            <Fragment>
              <tr className="border-b"><td colSpan={ids.length + 2} className="px-3 pt-3 pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</td></tr>
              {list.map((r) => line(`${r.code} ${r.name}`, r, false, `${title}-${r.code}`))}
              {line(`Total ${title.toLowerCase()}`, total, true)}
            </Fragment>
          );
          return (
            <div className="space-y-4">
              {d.companies.length < 2 && (
                <Card className="flex items-start gap-3 border-amber-500/40 bg-amber-500/5 p-4 text-sm">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />
                  <p>You can see the books of {d.companies.length === 1 ? 'one company' : 'no company'} only. Add a company, or ask another company&apos;s admin to add you, from the company menu at the top.</p>
                </Card>
              )}
              <div className="flex justify-end">
                <Button size="sm" variant="outline" onClick={() => downloadCsv(`consolidated-${d.from}-${d.to}.csv`, [
                  ['Account', ...d.companies.map((c) => c.name), 'Together'],
                  ...[...d.income, ...d.expenses].map((r) => [`${r.code} ${r.name}`, ...ids.map((id) => toRupees(r.by[id] ?? 0)), toRupees(r.total)]),
                  ['Net profit', ...ids.map((id) => toRupees(d.netProfit.by[id] ?? 0)), toRupees(d.netProfit.total)],
                ])}>Export</Button>
              </div>
              <Card className="gap-0 overflow-hidden p-0">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>{head}</thead>
                    <tbody>
                      {rows('Income', d.income, d.totalIncome)}
                      {rows('Expenses', d.expenses, d.totalExpense)}
                      {line('Net profit', d.netProfit, true)}
                      <tr className="border-b"><td colSpan={ids.length + 2} className="px-3 pt-4 pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Balance sheet on {d.to}</td></tr>
                      {line('Assets', d.totalAssets)}
                      {line('Liabilities', d.totalLiabilities)}
                      {line("Owners' equity", d.totalEquity)}
                    </tbody>
                  </table>
                </div>
              </Card>
              <p className="text-xs text-muted-foreground">
                Sales, purchases and balances between these companies are not taken out. Where they trade with each other, eliminate those before
                reading the totals as the group&apos;s. Total expenses include the change in stock, as each company&apos;s profit and loss shows them.
              </p>
            </div>
          );
        }}
      </AsyncPage>
    </>
  );
}
