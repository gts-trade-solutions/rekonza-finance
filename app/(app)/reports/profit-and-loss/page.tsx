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
import { tileColors } from '@/components/shared/stat-tile';
import { Money } from '@/components/shared/money';
import { BasisSelect, BranchSelect, CompareSelect, downloadCsv, ReportShell, useBranchName, useReportRange, type ReportBasis } from '@/components/shared/report-shell';
import { SavedViews } from '@/components/shared/saved-views';
import { CustomizeButton, CustomizePanel, CustomReportView, appliedLines, customRows, useCustomReport, useCustomReportData, useOrgName } from '@/components/reports/customize-report';

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
  const [branch, setBranch] = useState('');
  const branchName = useBranchName(branch);
  const cmp = compare === 'none' || format !== 'general' ? null : comparisonRange(range, compare);
  const state = useApi<GroupedProfitAndLossReport>(() => reports.groupedProfitAndLoss(range.from, range.to, branch || undefined, basis), [range.from, range.to, basis, branch]);
  const prevState = useApi<GroupedProfitAndLossReport | null>(
    () => (cmp ? reports.groupedProfitAndLoss(cmp.from, cmp.to, branch || undefined, basis) : Promise.resolve(null)),
    [cmp?.from, cmp?.to, basis, branch],
  );
  const prev = cmp ? prevState.data ?? null : null;
  // Customize Report (status review 7): the filters, columns and comparisons Zoho's panel offers.
  const custom = useCustomReport('profit-and-loss', () => ({ from: range.from, to: range.to, basis, filter: { branchId: branch || null } }));
  const cstate = useCustomReportData(custom.spec);
  const org = useOrgName();

  return (
    <ReportShell
      title={format === 'horizontal' ? 'Horizontal Profit and Loss' : 'Profit and Loss'}
      description="Income less expenses over the period. Tax collected on invoices is not income — it is held for the government and sits on the balance sheet."
      range={range}
      onRangeChange={setRange}
      extraActions={(
        <div className="flex gap-2">
          <div className="w-32"><BasisSelect value={basis} onChange={setBasis} /></div>
          <div className="w-40"><BranchSelect value={branch} onChange={setBranch} /></div>
          {format === 'general' && <div className="w-52"><CompareSelect value={compare} onChange={setCompare} /></div>}
          <CustomizeButton onClick={() => custom.setOpen(true)} active={!!custom.spec} />
          <div className="self-end"><SavedViews list="report-profit-and-loss" current={{ from: range.from, to: range.to, mode: range.mode, basis, branch, compare }}
            onApply={(v) => { if (v.from && v.to) setRange({ from: String(v.from), to: String(v.to), mode: 'custom' }); setBasis((v.basis as ReportBasis) ?? 'accrual'); setBranch(String(v.branch ?? '')); setCompare((v.compare as CompareMode) ?? 'none'); }} /></div>
        </div>
      )}
      headerLines={custom.spec ? appliedLines(cstate.data) : undefined}
      onExport={() => {
        if (custom.spec) { if (cstate.data) downloadCsv('profit-and-loss-customised.csv', customRows(cstate.data, org)); return; }
        const pl = state.data;
        if (!pl) return;
        downloadCsv(format === 'horizontal' ? 'profit-and-loss-horizontal.csv' : 'profit-and-loss.csv', [
          [`Profit and Loss${format === 'horizontal' ? ' (horizontal)' : ''}${basis === 'cash' ? ' (cash basis)' : ''}${branchName ? ` · ${branchName}` : ''}`, `${pl.from} to ${pl.to}`],
          ...profitAndLossRows(pl, format),
        ]);
      }}
    >
      <CustomizePanel open={custom.open} onOpenChange={custom.setOpen} initial={custom.start()} onApply={custom.apply} saved={custom.saved} onSaved={custom.onSaved} />
      {custom.spec ? <CustomReportView state={cstate} saved={custom.saved} onEdit={() => custom.setOpen(true)} onClear={custom.clear} /> : <>
      <FormatSwitch value={format} statement="pl" base="/reports/profit-and-loss" />
      <AsyncPage state={state} loading={<LoadingRows rows={10} />}>
        {(pl) => {
          const profitable = pl.netProfitPaise >= 0;
          const income = pl.operatingIncome.totalPaise + pl.nonOperatingIncome.totalPaise;
          const margin = income > 0 ? (pl.netProfitPaise / income) * 100 : 0;
          return (
            <>
              {/* Compact figure boxes: the figures at a glance, the statement below them in view. */}
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4" data-slot="pl-figures">
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
                  <Card key={t.label} data-slot="pl-figure" className={`gap-0 px-3.5 py-2 ${tileColors(t.label, t.tone === 'good' ? 'positive' : t.tone === 'bad' ? 'danger' : 'default').card}`}>
                    <div className="flex items-center justify-between gap-2">
                      <p className={`truncate text-[12px] ${tileColors(t.label, t.tone === 'good' ? 'positive' : t.tone === 'bad' ? 'danger' : 'default').label}`} title={t.hint}>{t.label}</p>
                      {t.tone && (t.tone === 'good'
                        ? <TrendingUp className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                        : <TrendingDown className="size-3.5 shrink-0 text-destructive" />)}
                    </div>
                    <p className={`tabular text-[15px] font-medium leading-snug ${t.tone === 'good' ? 'text-emerald-600 dark:text-emerald-400' : t.tone === 'bad' ? 'text-destructive' : ''}`}>
                      <Money value={t.value} />
                    </p>
                    {(t.hint || t.before !== undefined) && (
                      <p className="truncate text-[11px] text-muted-foreground">
                        {t.before !== undefined ? <>Against <Money value={t.before} /></> : t.hint}
                      </p>
                    )}
                  </Card>
                ))}
              </div>

              <p className="text-center text-sm text-muted-foreground">
                From {longDate(pl.from)} to {longDate(pl.to)} · Basis: {basis === 'cash' ? 'Cash' : 'Accrual'}{branchName ? ` · Branch: ${branchName}` : ''}
              </p>

              {format === 'horizontal'
                ? <HorizontalProfitAndLoss pl={pl} />
                : <GeneralProfitAndLoss pl={pl} prev={prev} prevLabel={cmp ? `${longDate(cmp.from)} – ${longDate(cmp.to)}` : undefined} />}
            </>
          );
        }}
      </AsyncPage>
      </>}
    </ReportShell>
  );
}
