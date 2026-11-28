'use client';

// The trial balance, computed in SQL from the journal.
//
// Nothing is stored and nothing is cached. Every figure is derived from the
// entries on each request, which is why this and the balance sheet can never
// disagree — there is no second copy to fall out of date.

import Link from 'next/link';
import { Suspense, useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Money } from '@/components/shared/money';
import { BasisSelect, BranchSelect, useBranchName, downloadCsv, ReportShell, ReportTable, useReportRange, type ReportBasis } from '@/components/shared/report-shell';
import { SavedViews } from '@/components/shared/saved-views';
import { CustomizeButton, CustomizePanel, CustomReportView, appliedLines, customRows, useCustomReport, useCustomReportData, useOrgName } from '@/components/reports/customize-report';

import { AsyncPage, LoadingRows } from '@/components/shared/async-state';
import { reports, type TrialBalanceReport } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { toRupees } from '@/lib/money';
import { ledgerHref } from '@/lib/source-links';

export default function TrialBalancePage() {
  return <Suspense fallback={<LoadingRows rows={10} />}><TrialBalance /></Suspense>;
}

function TrialBalance() {
  const [range, setRange] = useReportRange();
  const [basis, setBasis] = useState<ReportBasis>('accrual');
  const [branch, setBranch] = useState('');
  const branchName = useBranchName(branch);
  const state = useApi<TrialBalanceReport>(() => reports.trialBalance(range.to, branch || undefined, basis), [range.to, basis, branch]);
  // Customize Report (status review 7).
  const custom = useCustomReport('trial-balance', () => ({ from: range.from, to: range.to, basis, filter: { branchId: branch || null } }));
  const cstate = useCustomReportData(custom.spec);
  const org = useOrgName();

  return (
    <ReportShell
      title="Trial Balance"
      description="Every account's closing position. If the two columns don't match to the paisa something is wrong — this is the books proving themselves."
      range={range}
      onRangeChange={setRange}
      asOfOnly
      extraActions={(
        <div className="flex gap-2">
          <div className="w-32"><BasisSelect value={basis} onChange={setBasis} /></div>
          <div className="w-40"><BranchSelect value={branch} onChange={setBranch} /></div>
          <CustomizeButton onClick={() => custom.setOpen(true)} active={!!custom.spec} />
          <div className="self-end"><SavedViews list="report-trial-balance" current={{ to: range.to, basis, branch }}
            onApply={(v) => { if (v.to) setRange({ ...range, to: String(v.to), mode: 'day' }); setBasis((v.basis as ReportBasis) ?? 'accrual'); setBranch(String(v.branch ?? '')); }} /></div>
        </div>
      )}
      headerLines={custom.spec ? appliedLines(cstate.data) : undefined}
      onExport={() => {
        if (custom.spec) { if (cstate.data) downloadCsv('trial-balance-customised.csv', customRows(cstate.data, org)); return; }
        const tb = state.data;
        if (!tb) return;
        downloadCsv('trial-balance.csv', [
          ...(branchName ? [[`Trial Balance · ${branchName}`, `as at ${tb.asOf}`]] : []),
          ['Code', 'Account', 'Type', 'Debit', 'Credit'],
          ...tb.rows.map((r) => [r.code, r.name, r.type, toRupees(r.debitSide), toRupees(r.creditSide)]),
          ['', 'TOTAL', '', toRupees(tb.totalDebit), toRupees(tb.totalCredit)],
        ]);
      }}
    >
      <CustomizePanel open={custom.open} onOpenChange={custom.setOpen} initial={custom.start()} onApply={custom.apply} saved={custom.saved} onSaved={custom.onSaved} />
      {custom.spec ? <CustomReportView state={cstate} saved={custom.saved} onEdit={() => custom.setOpen(true)} onClear={custom.clear} /> : (
      <AsyncPage state={state} loading={<LoadingRows rows={10} />}>
        {(tb) => (
          <>
            <Card
              className={
                'flex items-center gap-3 p-4 ' +
                (tb.balanced ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-destructive bg-destructive/5')
              }
            >
              <CheckCircle2
                className={
                  'size-5 shrink-0 ' +
                  (tb.balanced ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive')
                }
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">
                  {tb.balanced ? 'The books balance' : 'The books do NOT balance — investigate immediately'}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {tb.rows.length} accounts with movement · total debits <Money value={tb.totalDebit} /> ·
                  total credits <Money value={tb.totalCredit} />
                </p>
              </div>
            </Card>

            <ReportTable>
              <thead>
                <tr className="border-b bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-2.5 text-left font-semibold">Code</th>
                  <th className="px-4 py-2.5 text-left font-semibold">Account</th>
                  <th className="px-4 py-2.5 text-left font-semibold">Type</th>
                  <th className="px-4 py-2.5 text-right font-semibold">Debit</th>
                  <th className="px-4 py-2.5 text-right font-semibold">Credit</th>
                </tr>
              </thead>
              <tbody>
                {tb.rows.map((r) => (
                  <tr key={r.accountId} className="border-b last:border-0 hover:bg-accent/40">
                    <td className="px-4 py-2 font-mono text-xs text-muted-foreground">{r.code}</td>
                    <td className="px-4 py-2 font-medium">
                      <Link href={ledgerHref(r.accountId, range.from, range.to)} className="hover:underline">{r.name}</Link>
                    </td>
                    <td className="px-4 py-2 text-xs capitalize text-muted-foreground">{r.type}</td>
                    <td className="px-4 py-2 text-right">
                      {r.debitSide > 0 ? <Money value={r.debitSide} /> : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="px-4 py-2 text-right">
                      {r.creditSide > 0 ? <Money value={r.creditSide} /> : <span className="text-muted-foreground">—</span>}
                    </td>
                  </tr>
                ))}
                <tr className="rpt-total border-t-2 font-semibold" data-slot="rpt-total">
                  <td className="px-4 py-3" colSpan={3}>Total</td>
                  <td className="px-4 py-3 text-right"><Money value={tb.totalDebit} /></td>
                  <td className="px-4 py-3 text-right"><Money value={tb.totalCredit} /></td>
                </tr>
              </tbody>
            </ReportTable>
          </>
        )}
      </AsyncPage>
      )}
    </ReportShell>
  );
}
