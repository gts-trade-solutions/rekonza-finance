'use client';

// Profit and loss: income less expenses over a period.
//
// A period, not a position — that is the whole difference from the balance
// sheet. The same journal answers both questions; only the window changes.
//
// Three formats, as Zoho Books offers them: General groups the accounts by
// category (operating income, cost of goods sold, operating expense,
// non-operating items) with gross, operating and net profit between them;
// Horizontal is the T-form trading and profit and loss account; Schedule III
// is the Companies Act layout on its own page.
//
// Purchases are expensed when billed, so the stock lines turn them into the
// cost of what was actually sold: add the stock the period began with, take
// off the stock it ended with. Every account opens its ledger for the period.

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { TrendingDown, TrendingUp } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Money } from '@/components/shared/money';
import { BasisSelect, CompareSelect, downloadCsv, ReportShell, useReportRange, type ReportBasis } from '@/components/shared/report-shell';
import { AsyncPage, LoadingRows } from '@/components/shared/async-state';
import { reports, type GroupedProfitAndLossReport } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { comparisonRange, type CompareMode } from '@/lib/date-range';
import {
  FormatSwitch, GeneralProfitAndLoss, HorizontalProfitAndLoss, profitAndLossRows, readFormat,
} from '@/components/reports/statement-formats';

const longDate = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

export default function ProfitAndLossPage() {
  return (
    <Suspense fallback={<LoadingRows rows={10} />}>
      <ProfitAndLoss />
    </Suspense>
  );
}

function ProfitAndLoss() {
  const format = readFormat(useSearchParams().get('format'));
  const [range, setRange] = useReportRange();
  const [compare, setCompare] = useState<CompareMode>('none');
  const [basis, setBasis] = useState<ReportBasis>('accrual');
  const cmp = compare === 'none' || format !== 'general' ? null : comparisonRange(range, compare);
  const state = useApi<GroupedProfitAndLossReport>(() => reports.groupedProfitAndLoss(range.from, range.to, undefined, basis), [range.from, range.to, basis]);
  const prevState = useApi<GroupedProfitAndLossReport | null>(
    () => (cmp ? reports.groupedProfitAndLoss(cmp.from, cmp.to, undefined, basis) : Promise.resolve(null)),
    [cmp?.from, cmp?.to, basis],
  );
  const prev = cmp ? prevState.data ?? null : null;

  return (
    <ReportShell
      title={format === 'horizontal' ? 'Horizontal Profit and Loss' : 'Profit and Loss'}
      description="Income less expenses over the period. Tax collected on invoices is not income — it is held for the government and sits on the balance sheet."
      range={range}
      onRangeChange={setRange}
      extraActions={(
        <div className="flex gap-2">
          <div className="w-32"><BasisSelect value={basis} onChange={setBasis} /></div>
          {format === 'general' && <div className="w-52"><CompareSelect value={compare} onChange={setCompare} /></div>}
        </div>
      )}
      onExport={() => {
        const pl = state.data;
        if (!pl) return;
        downloadCsv(format === 'horizontal' ? 'profit-and-loss-horizontal.csv' : 'profit-and-loss.csv', [
          [`Profit and Loss${format === 'horizontal' ? ' (horizontal)' : ''}${basis === 'cash' ? ' (cash basis)' : ''}`, `${pl.from} to ${pl.to}`],
          ...profitAndLossRows(pl, format),
        ]);
      }}
    >
      <FormatSwitch value={format} statement="pl" base="/reports/profit-and-loss" />
      <AsyncPage state={state} loading={<LoadingRows rows={10} />}>
        {(pl) => {
          const profitable = pl.netProfitPaise >= 0;
          const income = pl.operatingIncome.totalPaise + pl.nonOperatingIncome.totalPaise;
          const margin = income > 0 ? (pl.netProfitPaise / income) * 100 : 0;
          return (
            <>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                {[
                  { label: 'Operating income', value: pl.operatingIncome.totalPaise, before: prev?.operatingIncome.totalPaise },
                  {
                    label: pl.grossProfitPaise >= 0 ? 'Gross profit' : 'Gross loss', value: pl.grossProfitPaise,
                    hint: 'Operating income less the cost of goods sold', before: prev?.grossProfitPaise,
                    ...(pl.grossProfitPaise < 0 ? { tone: 'bad' as const } : {}),
                  },
                  {
                    label: pl.operatingProfitPaise >= 0 ? 'Operating profit' : 'Operating loss', value: pl.operatingProfitPaise,
                    hint: 'After operating expenses', before: prev?.operatingProfitPaise,
                    ...(pl.operatingProfitPaise < 0 ? { tone: 'bad' as const } : {}),
                  },
                  {
                    label: profitable ? 'Net profit' : 'Net loss',
                    value: Math.abs(pl.netProfitPaise),
                    hint: `${margin.toFixed(1)}% of income`,
                    tone: profitable ? 'good' as const : 'bad' as const,
                    before: prev ? Math.abs(prev.netProfitPaise) : undefined,
                  },
                ].map((t) => (
                  <Card key={t.label} className="p-4">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="micro-label">{t.label}</p>
                        <p className={`mt-1.5 tabular text-2xl font-semibold ${t.tone === 'good' ? 'text-emerald-600 dark:text-emerald-400' : t.tone === 'bad' ? 'text-destructive' : ''}`}>
                          <Money value={t.value} />
                        </p>
                        {t.hint && <p className="mt-0.5 text-xs text-muted-foreground">{t.hint}</p>}
                        {t.before !== undefined && <p className="mt-0.5 text-xs text-muted-foreground">Against <Money value={t.before} /></p>}
                      </div>
                      {t.tone && (t.tone === 'good'
                        ? <TrendingUp className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                        : <TrendingDown className="size-4 shrink-0 text-destructive" />)}
                    </div>
                  </Card>
                ))}
              </div>

              <p className="text-center text-sm text-muted-foreground">
                From {longDate(pl.from)} to {longDate(pl.to)} · Basis: Accrual
              </p>

              {format === 'horizontal'
                ? <HorizontalProfitAndLoss pl={pl} />
                : <GeneralProfitAndLoss pl={pl} prev={prev} prevLabel={cmp ? `${longDate(cmp.from)} – ${longDate(cmp.to)}` : undefined} />}
            </>
          );
        }}
      </AsyncPage>
    </ReportShell>
  );
}
