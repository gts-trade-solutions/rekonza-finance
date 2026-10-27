'use client';

// The trial balance, computed in SQL from the journal.
//
// Nothing is stored and nothing is cached. Every figure is derived from the
// entries on each request, which is why this and the balance sheet can never
// disagree — there is no second copy to fall out of date.

import Link from 'next/link';
import { CheckCircle2 } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Money } from '@/components/shared/money';
import { downloadCsv, ReportShell, ReportTable, useReportRange } from '@/components/shared/report-shell';
import { AsyncPage, LoadingRows } from '@/components/shared/async-state';
import { reports, type TrialBalanceReport } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { toRupees } from '@/lib/money';
import { ledgerHref } from '@/lib/source-links';

export default function TrialBalancePage() {
  const [range, setRange] = useReportRange();
  const state = useApi<TrialBalanceReport>(() => reports.trialBalance(range.to), [range.to]);

  return (
    <ReportShell
      title="Trial Balance"
      description="Every account's closing position. If the two columns don't match to the paisa something is wrong — this is the books proving themselves."
      range={range}
      onRangeChange={setRange}
      asOfOnly
      onExport={() => {
        const tb = state.data;
        if (!tb) return;
        downloadCsv('trial-balance.csv', [
          ['Code', 'Account', 'Type', 'Debit', 'Credit'],
          ...tb.rows.map((r) => [r.code, r.name, r.type, toRupees(r.debitSide), toRupees(r.creditSide)]),
          ['', 'TOTAL', '', toRupees(tb.totalDebit), toRupees(tb.totalCredit)],
        ]);
      }}
    >
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
                <tr className="border-t-2 bg-muted/40 font-semibold">
                  <td className="px-4 py-3" colSpan={3}>Total</td>
                  <td className="px-4 py-3 text-right"><Money value={tb.totalDebit} /></td>
                  <td className="px-4 py-3 text-right"><Money value={tb.totalCredit} /></td>
                </tr>
              </tbody>
            </ReportTable>
          </>
        )}
      </AsyncPage>
    </ReportShell>
  );
}
