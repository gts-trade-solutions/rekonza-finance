'use client';

// What the business owns and owes on a single date.
//
// Three formats, as Zoho Books offers them: General groups the accounts by
// category (current assets as cash, bank, receivables and the rest; fixed and
// other assets; current, long-term and other liabilities; equities);
// Horizontal is the T-form, liabilities and equities beside the assets;
// Schedule III is the Companies Act layout on its own page.
//
// The piece people miss is earnings. No entry moves a year's profit into
// retained earnings, so the sheet works it out: profit of earlier financial
// years with retained earnings, this year's as current year earnings. Leave
// either out and the sheet fails to balance by exactly that profit. Closing
// stock is valued from the documents rather than read from a ledger.

import { BelowZeroNotice, type BelowZeroData } from '@/components/reports/below-zero-notice';
import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Scale } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Money } from '@/components/shared/money';
import { BasisSelect, BranchSelect, CompareSelect, downloadCsv, ReportShell, useBranchName, useReportRange, type ReportBasis } from '@/components/shared/report-shell';
import { SavedViews } from '@/components/shared/saved-views';
import { CustomizeButton, CustomizePanel, CustomReportView, appliedLines, customRows, useCustomReport, useCustomReportData, useOrgName } from '@/components/reports/customize-report';

import { AsyncPage, LoadingRows } from '@/components/shared/async-state';
import { reports, type GroupedBalanceSheetReport } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { comparisonRange, type CompareMode } from '@/lib/date-range';
import {
  balanceSheetRows, FormatSwitch, GeneralBalanceSheet, HorizontalBalanceSheet, readFormat,
} from '@/components/reports/statement-formats';

const asAt = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

export default function BalanceSheetPage() {
  return (
    <Suspense fallback={<LoadingRows rows={10} />}>
      <BalanceSheet />
    </Suspense>
  );
}

function BalanceSheet() {
  const format = readFormat(useSearchParams().get('format'));
  const [range, setRange] = useReportRange();
  const [compare, setCompare] = useState<CompareMode>('none');
  const [basis, setBasis] = useState<ReportBasis>('accrual');
  const [branch, setBranch] = useState('');
  const branchName = useBranchName(branch);
  const state = useApi<GroupedBalanceSheetReport>(() => reports.groupedBalanceSheet(range.to, branch || undefined, basis), [range.to, basis, branch]);
  const cmpTo = compare === 'none' || format !== 'general' ? null : comparisonRange(range, compare).to;
  const prevState = useApi<GroupedBalanceSheetReport | null>(() => (cmpTo ? reports.groupedBalanceSheet(cmpTo, branch || undefined, basis) : Promise.resolve(null)), [cmpTo, basis, branch]);
  const prev = cmpTo ? prevState.data ?? null : null;
  // Customize Report (status review 7).
  const custom = useCustomReport('balance-sheet', () => ({ from: `${range.to.slice(0, 4)}-04-01`, to: range.to, basis, filter: { branchId: branch || null } }));
  const cstate = useCustomReportData(custom.spec);
  const org = useOrgName();

  return (
    <ReportShell
      title={format === 'horizontal' ? 'Horizontal Balance Sheet' : 'Balance Sheet'}
      description="What the business owns and owes on a single date. Assets must equal liabilities plus equity."
      range={range}
      onRangeChange={setRange}
      asOfOnly
      extraActions={(
        <div className="flex gap-2">
          <div className="w-32"><BasisSelect value={basis} onChange={setBasis} /></div>
          <div className="w-40"><BranchSelect value={branch} onChange={setBranch} /></div>
          {format === 'general' && <div className="w-52"><CompareSelect value={compare} onChange={setCompare} /></div>}
          <CustomizeButton onClick={() => custom.setOpen(true)} active={!!custom.spec} />
          <div className="self-end"><SavedViews list="report-balance-sheet" current={{ to: range.to, basis, branch, compare }}
            onApply={(v) => { if (v.to) setRange({ ...range, to: String(v.to), mode: 'day' }); setBasis((v.basis as ReportBasis) ?? 'accrual'); setBranch(String(v.branch ?? '')); setCompare((v.compare as CompareMode) ?? 'none'); }} /></div>
        </div>
      )}
      headerLines={custom.spec ? appliedLines(cstate.data) : undefined}
      onExport={() => {
        if (custom.spec) { if (cstate.data) downloadCsv('balance-sheet-customised.csv', customRows(cstate.data, org)); return; }
        const bs = state.data;
        if (!bs) return;
        downloadCsv(format === 'horizontal' ? 'balance-sheet-horizontal.csv' : 'balance-sheet.csv', [
          [`Balance Sheet${format === 'horizontal' ? ' (horizontal)' : ''}${basis === 'cash' ? ' (cash basis)' : ''}`, `As of ${bs.asOf}`],
          ...balanceSheetRows(bs, format),
        ]);
      }}
    >
      <CustomizePanel open={custom.open} onOpenChange={custom.setOpen} initial={custom.start()} onApply={custom.apply} saved={custom.saved} onSaved={custom.onSaved} />
      {custom.spec ? <CustomReportView state={cstate} saved={custom.saved} onEdit={() => custom.setOpen(true)} onClear={custom.clear} /> : <>
      <FormatSwitch value={format} statement="bs" base="/reports/balance-sheet" />
      <AsyncPage state={state} loading={<LoadingRows rows={10} />}>
        {(bs) => (
          <>
            <BelowZeroNotice data={(bs as { belowZero?: BelowZeroData }).belowZero} />
            <Card className={'flex items-center gap-3 p-4 ' + (bs.balanced ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-destructive bg-destructive/5')}>
              <Scale className={'size-5 shrink-0 ' + (bs.balanced ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive')} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">
                  {bs.balanced ? 'Assets equal liabilities plus equity' : 'The sheet does NOT balance — investigate immediately'}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  <Money value={bs.assets.totalPaise} /> in assets against <Money value={bs.liabilities.totalPaise} /> owed and{' '}
                  <Money value={bs.equities.totalPaise} /> of equities.
                </p>
              </div>
            </Card>

            <p className="text-center text-sm text-muted-foreground">As of {asAt(bs.asOf)} · Basis: {basis === 'cash' ? 'Cash' : 'Accrual'}{branchName ? ` · Branch: ${branchName}` : ''}</p>

            {format === 'horizontal'
              ? <HorizontalBalanceSheet bs={bs} />
              : <GeneralBalanceSheet bs={bs} prev={prev} prevLabel={cmpTo ? `As of ${asAt(cmpTo)}` : undefined} />}
          </>
        )}
      </AsyncPage>
      </>}
    </ReportShell>
  );
}
