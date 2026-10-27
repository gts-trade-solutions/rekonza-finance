'use client';

// Profit and loss: income less expenses over a period.
//
// A period, not a position — that is the whole difference from the balance
// sheet. The same journal answers both questions; only the window changes.
//
// Purchases are expensed when billed, so the stock lines turn them into the
// cost of what was actually sold: add the stock the period began with, take
// off the stock it ended with. Tally lays its trading account out the same way.
//
// Every account opens its ledger for the period, and the figures can stand
// beside the period before or the same period last year.

import { useState } from 'react';
import Link from 'next/link';
import { TrendingDown, TrendingUp } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Money } from '@/components/shared/money';
import { CompareSelect, downloadCsv, ReportShell, ReportTable, useReportRange } from '@/components/shared/report-shell';
import { AsyncPage, LoadingRows } from '@/components/shared/async-state';
import { reports, type AccountBalanceRow, type ProfitAndLossReport } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { comparisonRange, COMPARE_LABEL, type CompareMode, type DateRange } from '@/lib/date-range';
import { ledgerHref } from '@/lib/source-links';
import { toRupees } from '@/lib/money';

/** 1 Apr 2026, read in local time so the date never slips a day. */
const longDate = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

/** The change from the earlier figure, as a percentage where that means something. */
function Change({ now, then }: { now: number; then: number }) {
  const diff = now - then;
  const pct = then !== 0 ? (diff / Math.abs(then)) * 100 : null;
  return (
    <span className={diff === 0 ? 'text-muted-foreground' : ''}>
      <Money value={diff} />
      {pct !== null && <span className="ml-1 text-xs text-muted-foreground">{pct > 0 ? '+' : ''}{pct.toFixed(0)}%</span>}
    </span>
  );
}

function Section({ title, rows, total, prev, prevTotal, range }: {
  title: string; rows: AccountBalanceRow[]; total: number;
  prev: AccountBalanceRow[] | null; prevTotal: number; range: DateRange;
}) {
  const cols = prev ? 4 : 2;
  // Accounts with a figure in either period, so one that went quiet still shows.
  const then = new Map((prev ?? []).map((r) => [r.accountId, r.balancePaise]));
  const all = [...rows, ...(prev ?? []).filter((p) => !rows.some((r) => r.accountId === p.accountId)).map((p) => ({ ...p, balancePaise: 0 }))];
  return (
    <>
      <tr className="bg-muted/40">
        <td className="px-4 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground" colSpan={cols}>
          {title}
        </td>
      </tr>
      {all.length === 0 ? (
        <tr className="border-b last:border-0">
          <td className="px-4 py-2 text-sm text-muted-foreground" colSpan={cols}>
            Nothing in this period.
          </td>
        </tr>
      ) : (
        all.map((r) => (
          <tr key={r.accountId} className="border-b last:border-0 hover:bg-accent/40">
            <td className="px-4 py-2">
              <Link href={ledgerHref(r.accountId, range.from, range.to)} className="hover:underline">
                <span className="font-mono text-xs text-muted-foreground">{r.code}</span> {r.name}
              </Link>
            </td>
            <td className="px-4 py-2 text-right"><Money value={r.balancePaise} /></td>
            {prev && (
              <>
                <td className="px-4 py-2 text-right text-muted-foreground"><Money value={then.get(r.accountId) ?? 0} /></td>
                <td className="px-4 py-2 text-right"><Change now={r.balancePaise} then={then.get(r.accountId) ?? 0} /></td>
              </>
            )}
          </tr>
        ))
      )}
      <tr className="border-b font-medium last:border-0">
        <td className="px-4 py-2">Total {title.toLowerCase()}</td>
        <td className="px-4 py-2 text-right"><Money value={total} /></td>
        {prev && (
          <>
            <td className="px-4 py-2 text-right text-muted-foreground"><Money value={prevTotal} /></td>
            <td className="px-4 py-2 text-right"><Change now={total} then={prevTotal} /></td>
          </>
        )}
      </tr>
    </>
  );
}

export default function ProfitAndLossPage() {
  const [range, setRange] = useReportRange();
  const [compare, setCompare] = useState<CompareMode>('none');
  const cmp = compare === 'none' ? null : comparisonRange(range, compare);
  const state = useApi<ProfitAndLossReport>(
    () => reports.profitAndLoss(range.from, range.to),
    [range.from, range.to],
  );
  const prevState = useApi<ProfitAndLossReport | null>(
    () => (cmp ? reports.profitAndLoss(cmp.from, cmp.to) : Promise.resolve(null)),
    [cmp?.from, cmp?.to],
  );
  const prev = cmp ? prevState.data ?? null : null;

  return (
    <ReportShell
      title="Profit and Loss"
      description="Income less expenses over the period. Tax collected on invoices is not income — it is held for the government and sits on the balance sheet."
      range={range}
      onRangeChange={setRange}
      extraActions={<div className="w-52"><CompareSelect value={compare} onChange={setCompare} /></div>}
      onExport={() => {
        const pl = state.data;
        if (!pl) return;
        const then = (rows: AccountBalanceRow[] | undefined, id: string) => toRupees(rows?.find((r) => r.accountId === id)?.balancePaise ?? 0);
        const extra = (v: number | undefined) => (prev ? [toRupees(v ?? 0)] : []);
        downloadCsv('profit-and-loss.csv', [
          ['Section', 'Code', 'Account', 'Amount', ...(prev && cmp ? [`${COMPARE_LABEL[compare]} (${cmp.from} to ${cmp.to})`] : [])],
          ...pl.incomeRows.map((r) => ['Income', r.code, r.name, toRupees(r.balancePaise), ...(prev ? [then(prev.incomeRows, r.accountId)] : [])]),
          ['', '', 'Total income', toRupees(pl.totalIncome), ...extra(prev?.totalIncome)],
          ...pl.expenseRows.map((r) => ['Expenses', r.code, r.name, toRupees(r.balancePaise), ...(prev ? [then(prev.expenseRows, r.accountId)] : [])]),
          ['', '', 'Total expenses', toRupees(pl.totalExpense), ...extra(prev?.totalExpense)],
          ['Stock', '', 'Add: opening stock', toRupees(pl.openingStockPaise), ...extra(prev?.openingStockPaise)],
          ['Stock', '', 'Less: closing stock', toRupees(-pl.closingStockPaise), ...extra(prev ? -prev.closingStockPaise : 0)],
          ['', '', 'Net profit', toRupees(pl.netProfit), ...extra(prev?.netProfit)],
        ]);
      }}
    >
      <AsyncPage state={state} loading={<LoadingRows rows={10} />}>
        {(pl) => {
          const profitable = pl.netProfit >= 0;
          const margin = pl.totalIncome > 0 ? (pl.netProfit / pl.totalIncome) * 100 : 0;
          const stockChange = pl.closingStockPaise - pl.openingStockPaise;
          const hasStock = pl.openingStockPaise !== 0 || pl.closingStockPaise !== 0 || !!prev?.openingStockPaise || !!prev?.closingStockPaise;
          const cols = prev ? 4 : 2;
          const both = (now: number, then: number | undefined) => prev && (
            <>
              <td className="px-4 py-2 text-right text-muted-foreground"><Money value={then ?? 0} /></td>
              <td className="px-4 py-2 text-right"><Change now={now} then={then ?? 0} /></td>
            </>
          );

          return (
            <>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                {[
                  { label: 'Income', value: pl.totalIncome, before: prev?.totalIncome },
                  {
                    label: 'Expenses',
                    value: pl.totalExpense - stockChange,
                    hint: hasStock ? 'After the change in stock on hand' : undefined,
                    before: prev ? prev.totalExpense - (prev.closingStockPaise - prev.openingStockPaise) : undefined,
                  },
                  { label: 'Gross profit', value: pl.grossProfit, hint: 'Income less the cost of goods sold', before: prev?.grossProfit },
                  {
                    label: profitable ? 'Net profit' : 'Net loss',
                    value: Math.abs(pl.netProfit),
                    hint: `${margin.toFixed(1)}% of income`,
                    tone: profitable ? 'good' : 'bad',
                    before: prev ? Math.abs(prev.netProfit) : undefined,
                  },
                ].map((t) => (
                  <Card key={t.label} className="p-4">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="micro-label">{t.label}</p>
                        <p
                          className={`mt-1.5 tabular text-2xl font-semibold ${
                            t.tone === 'good'
                              ? 'text-emerald-600 dark:text-emerald-400'
                              : t.tone === 'bad'
                                ? 'text-destructive'
                                : ''
                          }`}
                        >
                          <Money value={t.value} />
                        </p>
                        {t.hint && <p className="mt-0.5 text-xs text-muted-foreground">{t.hint}</p>}
                        {t.before !== undefined && (
                          <p className="mt-0.5 text-xs text-muted-foreground">Against <Money value={t.before} /></p>
                        )}
                      </div>
                      {t.tone && (
                        profitable
                          ? <TrendingUp className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                          : <TrendingDown className="size-4 shrink-0 text-destructive" />
                      )}
                    </div>
                  </Card>
                ))}
              </div>

              <ReportTable>
                <thead>
                  <tr className="border-b bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-2.5 text-left font-semibold">Account</th>
                    <th className="px-4 py-2.5 text-right font-semibold">Amount</th>
                    {prev && cmp && (
                      <>
                        <th className="px-4 py-2.5 text-right font-semibold" title={`${cmp.from} to ${cmp.to}`}>
                          {longDate(cmp.from)} – {longDate(cmp.to)}
                        </th>
                        <th className="px-4 py-2.5 text-right font-semibold">Change</th>
                      </>
                    )}
                  </tr>
                </thead>
                <tbody>
                  <Section title="Income" rows={pl.incomeRows} total={pl.totalIncome} prev={prev?.incomeRows ?? null} prevTotal={prev?.totalIncome ?? 0} range={range} />
                  <Section title="Expenses" rows={pl.expenseRows} total={pl.totalExpense} prev={prev?.expenseRows ?? null} prevTotal={prev?.totalExpense ?? 0} range={range} />
                  {hasStock && (
                    <>
                      <tr className="bg-muted/40">
                        <td className="px-4 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground" colSpan={cols}>
                          Stock on hand
                        </td>
                      </tr>
                      <tr className="border-b">
                        <td className="px-4 py-2">
                          Add: opening stock
                          <span className="mt-0.5 block text-xs text-muted-foreground">
                            On the shelf at the start of {longDate(pl.from)}
                          </span>
                        </td>
                        <td className="px-4 py-2 text-right"><Money value={pl.openingStockPaise} /></td>
                        {both(pl.openingStockPaise, prev?.openingStockPaise)}
                      </tr>
                      <tr className="border-b">
                        <td className="px-4 py-2">
                          Less: closing stock
                          <span className="mt-0.5 block text-xs text-muted-foreground">
                            Still unsold at the end of {longDate(pl.to)}, at weighted average cost
                          </span>
                        </td>
                        <td className="px-4 py-2 text-right"><Money value={-pl.closingStockPaise} /></td>
                        {both(-pl.closingStockPaise, prev ? -prev.closingStockPaise : 0)}
                      </tr>
                      <tr className="border-b font-medium">
                        <td className="px-4 py-2">Cost of goods sold</td>
                        <td className="px-4 py-2 text-right"><Money value={pl.costOfGoodsSoldPaise} /></td>
                        {both(pl.costOfGoodsSoldPaise, prev?.costOfGoodsSoldPaise)}
                      </tr>
                    </>
                  )}
                  <tr className="border-t-2 bg-muted/40 text-base font-semibold">
                    <td className="px-4 py-3">{profitable ? 'Net profit' : 'Net loss'}</td>
                    <td
                      className={`px-4 py-3 text-right ${
                        profitable ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive'
                      }`}
                    >
                      <Money value={Math.abs(pl.netProfit)} />
                    </td>
                    {both(pl.netProfit, prev?.netProfit)}
                  </tr>
                </tbody>
              </ReportTable>
            </>
          );
        }}
      </AsyncPage>
    </ReportShell>
  );
}
