'use client';

// Consolidated statements: the companies you work in and may see the books
// of (all, or those chosen), account by account in columns, an Eliminations
// column for what they owe and sold each other, and the group total; the
// profit and loss and the balance sheet line by line, with the inter-company
// balances each side records and any difference between them.

import { Fragment, useState } from 'react';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
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
import { dayLabel } from '@/lib/date-range';

interface Row { code: string; name: string; by: Record<string, number>; elimination: number; total: number }
interface Sum { by: Record<string, number>; elimination: number; total: number }
interface Pair {
  fromOrgId: string; fromName: string; toOrgId: string; toName: string;
  receivablePaise: number; counterpartPayablePaise: number; salesPaise: number; counterpartPurchasesPaise: number;
  balanceDifferencePaise: number; tradeDifferencePaise: number;
}
interface Consolidated {
  from: string; to: string; companies: { orgId: string; name: string; pan: string | null; included: boolean }[];
  interCompany: Pair[];
  income: Row[]; expenses: Row[]; assets: Row[]; liabilities: Row[]; equity: Row[];
  totalIncome: Sum; totalExpense: Sum; netProfit: Sum; totalAssets: Sum; totalLiabilities: Sum; totalEquity: Sum;
  unreconciledPaise: number;
}

export default function ConsolidatedPage() {
  const [range, setRange] = useReportRange();
  const [chosen, setChosen] = useState<string[] | null>(null);
  const state = useApi(
    () => api.get<Consolidated>('/api/reports/consolidated', { from: range.from, to: range.to, ...(chosen ? { orgIds: chosen.join(',') } : {}) }),
    [range.from, range.to, chosen?.join(',')],
  );
  return (
    <>
      <PageHeader
        title="Consolidated statements"
        description="The companies you work in, side by side, with what they owe and sold each other eliminated, and the group total."
        actions={<DateRangePicker value={range} onChange={setRange} />}
      />
      <AsyncPage state={state} loading={<LoadingRows rows={10} />}>
        {(d) => {
          const included = d.companies.filter((c) => c.included);
          const ids = included.map((c) => c.orgId);
          const hasElim = d.interCompany.length > 0;
          const cols = ids.length + (hasElim ? 2 : 1) + 1;
          const head = (
            <tr className="border-b bg-muted/50 text-left text-[10px] uppercase tracking-wide text-muted-foreground">
              <th className="px-3 py-2 font-semibold">Account</th>
              {included.map((c) => <th key={c.orgId} className="px-3 py-2 text-right font-semibold">{c.name}</th>)}
              {hasElim && <th className="px-3 py-2 text-right font-semibold">Eliminations</th>}
              <th className="px-3 py-2 text-right font-semibold">Group</th>
            </tr>
          );
          const line = (label: string, s: Sum, strong = false, key?: string) => (
            <tr key={key ?? label} className={cn('border-b', strong ? 'rpt-total font-semibold' : 'rpt-line')} data-slot={strong ? 'rpt-total' : 'rpt-account'}>
              <td className="px-3 py-1.5">{label}</td>
              {ids.map((id) => <td key={id} className="px-3 py-1.5 text-right"><Money value={s.by[id] ?? 0} /></td>)}
              {hasElim && <td className="px-3 py-1.5 text-right text-muted-foreground">{s.elimination ? <Money value={s.elimination} /> : ''}</td>}
              <td className="px-3 py-1.5 text-right font-medium"><Money value={s.total} /></td>
            </tr>
          );
          const section = (title: string, list: Row[], total: Sum) => (
            <Fragment key={title}>
              <tr className="rpt-head border-b" data-slot="rpt-heading"><td colSpan={cols} className="px-3 py-2 text-xs uppercase tracking-wide">{title}</td></tr>
              {list.map((r) => line(`${r.code ? `${r.code} ` : ''}${r.name}`, r, false, `${title}-${r.code || r.name}`))}
              {line(`Total ${title.toLowerCase()}`, total, true)}
            </Fragment>
          );
          const csvRows = (title: string, list: Row[], total: Sum) => [
            [title.toUpperCase()],
            ...list.map((r) => [`${r.code ? `${r.code} ` : ''}${r.name}`, ...ids.map((id) => toRupees(r.by[id] ?? 0)), ...(hasElim ? [toRupees(r.elimination)] : []), toRupees(r.total)]),
            [`Total ${title.toLowerCase()}`, ...ids.map((id) => toRupees(total.by[id] ?? 0)), ...(hasElim ? [toRupees(total.elimination)] : []), toRupees(total.total)],
          ];
          return (
            <div className="space-y-4">
              <Card className="flex flex-wrap items-center gap-3 p-3 text-sm" data-slot="consolidated-companies">
                <span className="text-xs font-medium text-muted-foreground">Companies</span>
                {d.companies.map((c) => (
                  <label key={c.orgId} className="flex items-center gap-1.5">
                    <input type="checkbox" checked={c.included}
                      onChange={(e) => {
                        const now = d.companies.filter((x) => (x.orgId === c.orgId ? e.target.checked : x.included)).map((x) => x.orgId);
                        if (now.length) setChosen(now);
                      }} />
                    {c.name}{!c.pan && <span className="text-[10px] text-amber-700" title="Without a PAN, its dealings with the others cannot be found."> (no PAN)</span>}
                  </label>
                ))}
              </Card>
              {d.companies.length < 2 && (
                <Card className="flex items-start gap-3 border-amber-500/40 bg-amber-500/5 p-4 text-sm">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />
                  <p>You can see the books of {d.companies.length === 1 ? 'one company' : 'no company'} only. Add a company, or ask another company&apos;s admin to add you, from the company menu at the top.</p>
                </Card>
              )}
              <div className="flex justify-end">
                <Button size="sm" variant="outline" data-slot="consolidated-export" onClick={() => downloadCsv(`consolidated-${d.from}-${d.to}.csv`, [
                  [`Consolidated statements ${d.from} to ${d.to}`],
                  ['Account', ...included.map((c) => c.name), ...(hasElim ? ['Eliminations'] : []), 'Group'],
                  ...csvRows('Income', d.income, d.totalIncome),
                  ...csvRows('Expenses', d.expenses, d.totalExpense),
                  ['Net profit', ...ids.map((id) => toRupees(d.netProfit.by[id] ?? 0)), ...(hasElim ? [toRupees(d.netProfit.elimination)] : []), toRupees(d.netProfit.total)],
                  [`BALANCE SHEET ON ${d.to}`],
                  ...csvRows('Assets', d.assets, d.totalAssets),
                  ...csvRows('Liabilities', d.liabilities, d.totalLiabilities),
                  ...csvRows("Owners' equity", d.equity, d.totalEquity),
                  ...(d.interCompany.length ? [['INTER-COMPANY'], ['Between', 'Owed (their books)', 'Owing (other books)', 'Difference', 'Sold', 'Bought (other books)', 'Difference'],
                    ...d.interCompany.map((p) => [`${p.fromName} → ${p.toName}`, toRupees(p.receivablePaise), toRupees(p.counterpartPayablePaise), toRupees(p.balanceDifferencePaise), toRupees(p.salesPaise), toRupees(p.counterpartPurchasesPaise), toRupees(p.tradeDifferencePaise)])] : []),
                ])}>Export</Button>
              </div>
              <Card className="gap-0 overflow-hidden p-0">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm" data-slot="consolidated-table">
                    <thead>{head}</thead>
                    <tbody>
                      {section('Income', d.income, d.totalIncome)}
                      {section('Expenses', d.expenses, d.totalExpense)}
                      {line('Net profit', d.netProfit, true)}
                      <tr className="rpt-sub border-b" data-slot="rpt-heading"><td colSpan={cols} className="px-3 py-2 text-sm font-semibold">Balance sheet on {dayLabel(d.to)}</td></tr>
                      {section('Assets', d.assets, d.totalAssets)}
                      {section('Liabilities', d.liabilities, d.totalLiabilities)}
                      {section("Owners' equity", d.equity, d.totalEquity)}
                    </tbody>
                  </table>
                </div>
              </Card>

              <Card className="space-y-2 p-4" data-slot="consolidated-intercompany">
                <p className="text-sm font-semibold">Inter-company</p>
                {d.interCompany.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No dealings between these companies were found. A company&apos;s customer or vendor counts as a group company when its PAN, or the PAN in its GSTIN, is that company&apos;s PAN.</p>
                ) : (
                  <>
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b text-[10px] uppercase tracking-wide text-muted-foreground">
                          <th className="py-1.5 text-left">Between</th>
                          <th className="py-1.5 text-right">Owed, in its books</th><th className="py-1.5 text-right">Owing, in the other&apos;s</th><th className="py-1.5 text-right">Difference</th>
                          <th className="py-1.5 text-right">Sold</th><th className="py-1.5 text-right">Bought, in the other&apos;s</th><th className="py-1.5 text-right">Difference</th>
                        </tr>
                      </thead>
                      <tbody>
                        {d.interCompany.map((p) => (
                          <tr key={`${p.fromOrgId}-${p.toOrgId}`} className="border-b last:border-0">
                            <td className="py-1.5">{p.fromName} → {p.toName}</td>
                            <td className="py-1.5 text-right"><Money value={p.receivablePaise} /></td>
                            <td className="py-1.5 text-right"><Money value={p.counterpartPayablePaise} /></td>
                            <td className={cn('py-1.5 text-right', p.balanceDifferencePaise ? 'font-medium text-amber-700' : 'text-muted-foreground')}><Money value={p.balanceDifferencePaise} /></td>
                            <td className="py-1.5 text-right"><Money value={p.salesPaise} /></td>
                            <td className="py-1.5 text-right"><Money value={p.counterpartPurchasesPaise} /></td>
                            <td className={cn('py-1.5 text-right', p.tradeDifferencePaise ? 'font-medium text-amber-700' : 'text-muted-foreground')}><Money value={p.tradeDifferencePaise} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <p className="flex items-center gap-1.5 text-xs">
                      {d.unreconciledPaise === 0
                        ? <><CheckCircle2 className="size-3.5 text-emerald-600" /> Both sides agree: the group balance sheet balances after the eliminations.</>
                        : <><AlertTriangle className="size-3.5 text-amber-600" /> <Money value={d.unreconciledPaise} /> is owed in one book but not owing in the other (a bill not yet entered, or money in transit). Reconcile it before reading the group totals.</>}
                    </p>
                  </>
                )}
              </Card>
              <p className="text-xs text-muted-foreground">
                Eliminated: what the companies owe each other (as at the date) and their sales to each other (over the period), each side as its own book records it.
                Profit still held in stock bought from a group company is not taken out. Total expenses include the change in stock, as each company&apos;s profit and loss shows them.
              </p>
            </div>
          );
        }}
      </AsyncPage>
    </>
  );
}
