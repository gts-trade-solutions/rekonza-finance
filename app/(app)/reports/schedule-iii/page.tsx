'use client';

// The financial statements in the Schedule III layout.
//
// Same figures as the ordinary balance sheet and profit and loss, grouped
// under the headings the Companies Act prescribes, with the previous period
// beside them and the ageing tables for trade receivables and payables that
// the 2021 amendment added. Notes to the accounts are the signatory's part.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Scale } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Money } from '@/components/shared/money';
import { BasisSelect, BranchSelect, downloadCsv, ReportShell, ReportTable, useReportRange, type ReportBasis } from '@/components/shared/report-shell';
import { AsyncPage, LoadingRows } from '@/components/shared/async-state';
import {
  reports, type ScheduleIIIAgeing, type ScheduleIIIBalanceSheetReport, type ScheduleIIILine,
  type ScheduleIIIProfitAndLossReport,
} from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { toRupees } from '@/lib/money';
import { FormatSwitch } from '@/components/reports/statement-formats';
import { ledgerHref } from '@/lib/source-links';

const fmt = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
/** The financial year's first day when the reply does not say (April, India's default). */
const aprilStart = (iso: string) => {
  const [y, m] = iso.split('-').map(Number);
  return `${m >= 4 ? y : y - 1}-04-01`;
};
const th = 'px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground';

/** Where an account's figure on a line comes from: its ledger for the period. */
interface LedgerRange { from: string; to: string }

/** What the part of a line that no account holds is. */
const REST_LABEL: Record<string, string> = {
  reserves_surplus: 'Surplus in the statement of profit and loss',
  changes_in_inventories: 'Opening stock less closing stock',
};

/**
 * The accounts that make up a line, under it, as the horizontal T-form lists
 * them. What no account carries (profit not yet closed to reserves) is shown
 * as its own line so the accounts add up to the line.
 */
function accountRows(line: ScheduleIIILine): { key: string; accountId?: string; label: string; current: number; previous: number }[] {
  const rows: { key: string; accountId?: string; label: string; current: number; previous: number }[] = line.accounts
    .filter((a) => a.currentPaise !== 0 || a.previousPaise !== 0)
    .map((a) => ({ key: a.accountId, accountId: a.code ? a.accountId : undefined, label: a.name, current: a.currentPaise, previous: a.previousPaise }));
  const restNow = line.currentPaise - line.accounts.reduce((t, a) => t + a.currentPaise, 0);
  const restBefore = line.previousPaise - line.accounts.reduce((t, a) => t + a.previousPaise, 0);
  if (restNow !== 0 || restBefore !== 0) {
    rows.push({
      key: `${line.key}-rest`,
      label: REST_LABEL[line.key] ?? 'Other balances',
      current: restNow,
      previous: restBefore,
    });
  }
  return rows;
}

function Lines({ lines, grouped, ledger }: { lines: ScheduleIIILine[]; grouped?: boolean; ledger: LedgerRange }) {
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
          <FragmentRow key={l.key} header={header ? l.group : undefined} line={empty ? null : l} ledger={ledger} />
        );
      })}
    </>
  );
}

function FragmentRow({ header, line, ledger }: { header?: string; line: ScheduleIIILine | null; ledger: LedgerRange }) {
  return (
    <>
      {header && (
        <tr className="rpt-sub" data-slot="rpt-heading">
          <td colSpan={3} className="px-3 py-1.5 pl-5 text-[13px]">{header}</td>
        </tr>
      )}
      {line && (
        <tr className="border-b border-dashed" data-slot="sch3-line">
          <td className="px-3 py-2 pl-7 text-sm font-medium">{line.label}</td>
          <td className="px-3 py-2 text-right font-medium"><Money value={line.currentPaise} /></td>
          <td className="px-3 py-2 text-right text-muted-foreground"><Money value={line.previousPaise} /></td>
        </tr>
      )}
      {line && accountRows(line).map((a) => (
        <tr key={a.key} className="rpt-line border-b border-dashed text-xs hover:bg-accent/40" data-slot="rpt-account">
          <td className="px-3 py-1.5 pl-12">
            {a.accountId ? <Link href={ledgerHref(a.accountId, ledger.from, ledger.to)} className="hover:underline">{a.label}</Link> : a.label}
          </td>
          <td className="px-3 py-1.5 text-right"><Money value={a.current} /></td>
          <td className="px-3 py-1.5 text-right text-muted-foreground"><Money value={a.previous} /></td>
        </tr>
      ))}
    </>
  );
}

function Heading({ children }: { children: React.ReactNode }) {
  return (
    <tr className="rpt-head" data-slot="rpt-heading">
      <td colSpan={3} className="px-3 py-2 text-xs font-bold uppercase tracking-wide">{children}</td>
    </tr>
  );
}

function Total({ label, values, strong }: { label: string; values: [number, number]; strong?: boolean }) {
  return (
    <tr className={strong ? 'rpt-result border-t-2' : 'rpt-total border-t'} data-slot={strong ? 'rpt-result' : 'rpt-total'}>
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
  // Opened from the profit and loss's format switch, it starts on that statement.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('tab') === 'pl') setTab('pl');
  }, []);
  const [basis, setBasis] = useState<ReportBasis>('accrual');
  const [branch, setBranch] = useState('');
  const bs = useApi<ScheduleIIIBalanceSheetReport>(() => reports.scheduleIIIBalanceSheet(range.to, branch || undefined, basis), [range.to, basis, branch]);
  const pl = useApi<ScheduleIIIProfitAndLossReport>(
    () => reports.scheduleIIIProfitAndLoss(range.from, range.to, branch || undefined, basis), [range.from, range.to, basis, branch],
  );

  const exportCsv = () => {
    const lineRow = (l: ScheduleIIILine) => [l.group ?? '', l.label, toRupees(l.currentPaise), toRupees(l.previousPaise)];
    // Each line with its accounts under it, as the screen shows them.
    const rows = (ls: ScheduleIIILine[]) => ls
      .filter((l) => l.currentPaise !== 0 || l.previousPaise !== 0)
      .flatMap((l) => [lineRow(l), ...accountRows(l).map((a) => ['', `    ${a.label}`, toRupees(a.current), toRupees(a.previous)])]);
    if (tab === 'bs' && bs.data) {
      const d = bs.data;
      downloadCsv(`schedule-iii-balance-sheet-${d.asOf}.csv`, [
        ['Group', 'Particulars', fmt(d.asOf), fmt(d.previousAsOf)],
        ['I', 'EQUITY AND LIABILITIES', '', ''],
        ...rows(d.equityAndLiabilities),
        ['', 'Total', toRupees(d.totals.equityAndLiabilities[0]), toRupees(d.totals.equityAndLiabilities[1])],
        ['II', 'ASSETS', '', ''],
        ...rows(d.assets),
        ['', 'Total', toRupees(d.totals.assets[0]), toRupees(d.totals.assets[1])],
      ]);
    } else if (pl.data) {
      const d = pl.data;
      downloadCsv(`schedule-iii-profit-and-loss-${d.from}-${d.to}.csv`, [
        ['', 'Particulars', `${d.from} to ${d.to}`, `${d.previous.from} to ${d.previous.to}`],
        ['', 'INCOME', '', ''],
        ...rows(d.income),
        ['', 'Total income', toRupees(d.totalIncome[0]), toRupees(d.totalIncome[1])],
        ['', 'EXPENSES', '', ''],
        ...rows(d.expenses),
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
      extraActions={<div className="flex gap-2"><div className="w-32"><BasisSelect value={basis} onChange={setBasis} /></div><div className="w-40"><BranchSelect value={branch} onChange={setBranch} /></div></div>}
      onExport={exportCsv}
    >
      <FormatSwitch value="schedule-iii" statement={tab === 'pl' ? 'pl' : 'bs'} base={tab === 'pl' ? '/reports/profit-and-loss' : '/reports/balance-sheet'} />
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
                    <Heading>I. Equity and liabilities</Heading>
                    <Lines lines={d.equityAndLiabilities} grouped ledger={{ from: d.fyStart ?? aprilStart(d.asOf), to: d.asOf }} />
                    <Total label="Total" values={d.totals.equityAndLiabilities} strong />
                    <Heading>II. Assets</Heading>
                    <Lines lines={d.assets} grouped ledger={{ from: d.fyStart ?? aprilStart(d.asOf), to: d.asOf }} />
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
                  <Heading>Income</Heading>
                  <Lines lines={d.income} ledger={d} />
                  <Total label="Total income" values={d.totalIncome} />
                  <Heading>Expenses</Heading>
                  <Lines lines={d.expenses} ledger={d} />
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
