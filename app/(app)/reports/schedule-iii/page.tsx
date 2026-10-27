'use client';

// The financial statements in the Schedule III layout.
//
// Same figures as the ordinary balance sheet and profit and loss, grouped
// under the headings the Companies Act prescribes, with the previous period
// beside them and the ageing tables for trade receivables and payables that
// the 2021 amendment added. Notes to the accounts are the signatory's part.

import { useState } from 'react';
import { Scale } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Money } from '@/components/shared/money';
import { downloadCsv, ReportShell, ReportTable, useReportRange } from '@/components/shared/report-shell';
import { AsyncPage, LoadingRows } from '@/components/shared/async-state';
import {
  reports, type ScheduleIIIAgeing, type ScheduleIIIBalanceSheetReport, type ScheduleIIILine,
  type ScheduleIIIProfitAndLossReport,
} from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { toRupees } from '@/lib/money';

const fmt = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
const th = 'px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground';

function Lines({ lines, grouped }: { lines: ScheduleIIILine[]; grouped?: boolean }) {
  let lastGroup = '';
  return (
    <>
      {lines.map((l) => {
        const header = grouped && l.group && l.group !== lastGroup;
        if (header) lastGroup = l.group!;
        // A line with nothing in either year is left out, as a signed set of
        // statements would; the heading above it stays.
        const empty = l.currentPaise === 0 && l.previousPaise === 0;
        return (
          <FragmentRow key={l.key} header={header ? l.group : undefined} line={empty ? null : l} />
        );
      })}
    </>
  );
}

function FragmentRow({ header, line }: { header?: string; line: ScheduleIIILine | null }) {
  return (
    <>
      {header && (
        <tr className="bg-muted/30">
          <td colSpan={3} className="px-3 py-1.5 text-xs font-semibold text-muted-foreground">{header}</td>
        </tr>
      )}
      {line && (
        <tr className="border-b last:border-0" title={line.accounts.map((a) => `${a.code} ${a.name}`).join(', ')}>
          <td className="px-3 py-2 pl-6 text-sm">{line.label}</td>
          <td className="px-3 py-2 text-right"><Money value={line.currentPaise} /></td>
          <td className="px-3 py-2 text-right text-muted-foreground"><Money value={line.previousPaise} /></td>
        </tr>
      )}
    </>
  );
}

function Total({ label, values, strong }: { label: string; values: [number, number]; strong?: boolean }) {
  return (
    <tr className={strong ? 'border-t-2 bg-muted/40 font-semibold' : 'border-t font-medium'}>
      <td className="px-3 py-2.5">{label}</td>
      <td className="px-3 py-2.5 text-right"><Money value={values[0]} /></td>
      <td className="px-3 py-2.5 text-right"><Money value={values[1]} /></td>
    </tr>
  );
}

function Ageing({ title, table }: { title: string; table: ScheduleIIIAgeing }) {
  return (
    <ReportTable>
      <thead>
        <tr className="border-b bg-muted/50">
          <th className={`${th} text-left`}>{title}</th>
          {table.buckets.map((b) => <th key={b} className={`${th} text-right`}>{b}</th>)}
          <th className={`${th} text-right`}>Total</th>
        </tr>
      </thead>
      <tbody>
        {table.rows.map((r) => (
          <tr key={r.category} className="border-b last:border-0">
            <td className="px-3 py-2 text-sm">{r.category}</td>
            {r.amounts.map((a, i) => <td key={i} className="px-3 py-2 text-right"><Money value={a} showZero={false} /></td>)}
            <td className="px-3 py-2 text-right font-medium"><Money value={r.totalPaise} /></td>
          </tr>
        ))}
      </tbody>
    </ReportTable>
  );
}

export default function ScheduleIIIPage() {
  const [range, setRange] = useReportRange();
  const [tab, setTab] = useState('bs');
  const bs = useApi<ScheduleIIIBalanceSheetReport>(() => reports.scheduleIIIBalanceSheet(range.to), [range.to]);
  const pl = useApi<ScheduleIIIProfitAndLossReport>(
    () => reports.scheduleIIIProfitAndLoss(range.from, range.to), [range.from, range.to],
  );

  const exportCsv = () => {
    const row = (l: ScheduleIIILine) => [l.group ?? '', l.label, toRupees(l.currentPaise), toRupees(l.previousPaise)];
    if (tab === 'bs' && bs.data) {
      const d = bs.data;
      downloadCsv(`schedule-iii-balance-sheet-${d.asOf}.csv`, [
        ['Group', 'Particulars', fmt(d.asOf), fmt(d.previousAsOf)],
        ['I', 'EQUITY AND LIABILITIES', '', ''],
        ...d.equityAndLiabilities.map(row),
        ['', 'Total', toRupees(d.totals.equityAndLiabilities[0]), toRupees(d.totals.equityAndLiabilities[1])],
        ['II', 'ASSETS', '', ''],
        ...d.assets.map(row),
        ['', 'Total', toRupees(d.totals.assets[0]), toRupees(d.totals.assets[1])],
      ]);
    } else if (pl.data) {
      const d = pl.data;
      downloadCsv(`schedule-iii-profit-and-loss-${d.from}-${d.to}.csv`, [
        ['', 'Particulars', `${d.from} to ${d.to}`, `${d.previous.from} to ${d.previous.to}`],
        ...d.income.map(row),
        ['', 'Total income', toRupees(d.totalIncome[0]), toRupees(d.totalIncome[1])],
        ...d.expenses.map(row),
        ['', 'Total expenses', toRupees(d.totalExpenses[0]), toRupees(d.totalExpenses[1])],
        ['', 'Profit before tax', toRupees(d.profitBeforeTax[0]), toRupees(d.profitBeforeTax[1])],
      ]);
    }
  };

  return (
    <ReportShell
      title="Schedule III statements"
      description="The balance sheet and profit and loss laid out as the Companies Act requires, with the previous period beside them."
      range={range}
      onRangeChange={setRange}
      onExport={exportCsv}
    >
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="bs">Balance sheet</TabsTrigger>
          <TabsTrigger value="pl">Statement of profit and loss</TabsTrigger>
        </TabsList>

        <TabsContent value="bs" className="mt-4 space-y-4">
          <AsyncPage state={bs} loading={<LoadingRows rows={12} />}>
            {(d) => (
              <>
                <Card className={`flex items-center gap-3 p-4 ${d.balanced ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-destructive bg-destructive/5'}`}>
                  <Scale className="size-5 shrink-0" />
                  <p className="text-sm">
                    {d.balanced ? 'Equity and liabilities equal assets in both years.' : 'The statement does NOT balance — investigate before relying on it.'}
                  </p>
                </Card>
                <ReportTable>
                  <thead>
                    <tr className="border-b bg-muted/50">
                      <th className={`${th} text-left`}>Particulars</th>
                      <th className={`${th} text-right`}>As at {fmt(d.asOf)}</th>
                      <th className={`${th} text-right`}>As at {fmt(d.previousAsOf)}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr><td colSpan={3} className="px-3 py-2 text-xs font-bold uppercase tracking-wide">I. Equity and liabilities</td></tr>
                    <Lines lines={d.equityAndLiabilities} grouped />
                    <Total label="Total" values={d.totals.equityAndLiabilities} strong />
                    <tr><td colSpan={3} className="px-3 py-2 text-xs font-bold uppercase tracking-wide">II. Assets</td></tr>
                    <Lines lines={d.assets} grouped />
                    <Total label="Total" values={d.totals.assets} strong />
                  </tbody>
                </ReportTable>
                {d.msmePayablesPaise > 0 && (
                  <p className="text-xs text-muted-foreground">
                    Trade payables include <Money value={d.msmePayablesPaise} /> owed to micro and small enterprises.
                  </p>
                )}
                <Ageing title="Trade receivables ageing (from due date)" table={d.receivablesAgeing} />
                <Ageing title="Trade payables ageing (from due date)" table={d.payablesAgeing} />
              </>
            )}
          </AsyncPage>
        </TabsContent>

        <TabsContent value="pl" className="mt-4 space-y-4">
          <AsyncPage state={pl} loading={<LoadingRows rows={12} />}>
            {(d) => (
              <ReportTable>
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className={`${th} text-left`}>Particulars</th>
                    <th className={`${th} text-right`}>{fmt(d.from)} – {fmt(d.to)}</th>
                    <th className={`${th} text-right`}>{fmt(d.previous.from)} – {fmt(d.previous.to)}</th>
                  </tr>
                </thead>
                <tbody>
                  <Lines lines={d.income} />
                  <Total label="Total income" values={d.totalIncome} />
                  <tr><td colSpan={3} className="px-3 py-2 text-xs font-bold uppercase tracking-wide">Expenses</td></tr>
                  <Lines lines={d.expenses} />
                  <Total label="Total expenses" values={d.totalExpenses} />
                  <Total label="Profit before tax" values={d.profitBeforeTax} strong />
                  <tr>
                    <td colSpan={3} className="px-3 py-2 text-xs text-muted-foreground">
                      Tax expense is not posted in the books; current and deferred tax are added by the signatory.
                    </td>
                  </tr>
                </tbody>
              </ReportTable>
            )}
          </AsyncPage>
        </TabsContent>
      </Tabs>
    </ReportShell>
  );
}
