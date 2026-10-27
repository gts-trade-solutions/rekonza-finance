'use client';

// Ageing, shared by receivables and payables.
//
// Both age from the *due* date, not the document date. An invoice on sixty-day
// terms is not overdue on day thirty, and ageing from when it was raised would
// show a collections problem that does not exist.
//
// The two sides differ only in wording and in what the numbers mean for you —
// money you are owed against money you owe — so one component serves both.

import { DoubtfulDebtsCard } from '@/components/shared/doubtful-debts';
import { Money } from '@/components/shared/money';
import { downloadCsv, ReportShell, ReportTable, useReportRange } from '@/components/shared/report-shell';
import { AsyncPage, LoadingRows } from '@/components/shared/async-state';
import { AGEING_BUCKETS, reports, type AgeingReport as AgeingData } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { toRupees } from '@/lib/money';

const COPY = {
  ar: {
    title: 'Receivables Ageing',
    description:
      "Who owes you money and how long they have been sitting on it. The further right a figure appears, the harder it usually gets to collect.",
    party: 'Customer',
    totalLabel: 'Total outstanding',
    emptyMessage: 'Nothing outstanding — every invoice is settled.',
    oldestHint: 'Chase these first',
    shareLabel: 'of receivables',
    file: 'ar-ageing.csv',
  },
  ap: {
    title: 'Payables Ageing',
    description:
      'What you owe and for how long. Anything sitting past its terms is a supplier relationship being spent down, and for an MSME supplier it is a tax exposure too.',
    party: 'Vendor',
    totalLabel: 'Total owed',
    emptyMessage: 'Nothing owed — every bill is settled.',
    oldestHint: 'Settle these first',
    shareLabel: 'of payables',
    file: 'ap-ageing.csv',
  },
} as const;

export function AgeingReport({ side }: { side: 'ar' | 'ap' }) {
  const copy = COPY[side];
  const [range, setRange] = useReportRange();
  const state = useApi<AgeingData>(() => reports.ageing(side, range.to), [side, range.to]);

  return (
    <ReportShell
      title={copy.title}
      description={copy.description}
      range={range}
      onRangeChange={setRange}
      asOfOnly
      onExport={() => {
        const d = state.data;
        if (!d) return;
        downloadCsv(copy.file, [
          [copy.party, ...AGEING_BUCKETS, 'Total'],
          ...d.rows.map((r) => [
            r.name,
            ...AGEING_BUCKETS.map((b) => toRupees(r.buckets[b] ?? 0)),
            toRupees(r.totalPaise),
          ]),
          ['TOTAL', ...AGEING_BUCKETS.map((b) => toRupees(d.totals[b] ?? 0)), toRupees(d.grandTotalPaise)],
        ]);
      }}
    >
      <AsyncPage state={state} loading={<LoadingRows rows={8} />}>
        {(d) => {
          // Everything but the Current bucket is past its due date.
          const overdue = AGEING_BUCKETS.slice(1).reduce((t, b) => t + (d.totals[b] ?? 0), 0);
          const oldest = d.totals['60+'] ?? 0;

          return (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-lg border p-4">
                  <p className="text-xs text-muted-foreground">{copy.totalLabel}</p>
                  <Money value={d.grandTotalPaise} className="mt-1 block text-2xl font-semibold" />
                </div>
                <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
                  <p className="text-xs text-muted-foreground">Past due</p>
                  <Money value={overdue} className="mt-1 block text-2xl font-semibold" />
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {d.grandTotalPaise > 0
                      ? `${((overdue / d.grandTotalPaise) * 100).toFixed(0)}% ${copy.shareLabel}`
                      : '—'}
                  </p>
                </div>
                <div className="rounded-lg border border-red-500/40 bg-red-500/5 p-4">
                  <p className="text-xs text-muted-foreground">Over 60 days</p>
                  <Money value={oldest} className="mt-1 block text-2xl font-semibold" />
                  <p className="mt-0.5 text-xs text-muted-foreground">{copy.oldestHint}</p>
                </div>
              </div>

              <ReportTable>
                <thead>
                  <tr className="border-b bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-2.5 text-left font-semibold">{copy.party}</th>
                    {AGEING_BUCKETS.map((b) => (
                      <th key={b} className="px-4 py-2.5 text-right font-semibold">{b}</th>
                    ))}
                    <th className="px-4 py-2.5 text-right font-semibold">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {d.rows.length === 0 ? (
                    <tr>
                      <td colSpan={AGEING_BUCKETS.length + 2} className="px-4 py-10 text-center text-sm text-muted-foreground">
                        {copy.emptyMessage}
                      </td>
                    </tr>
                  ) : (
                    d.rows.map((r) => (
                      <tr key={r.contactId} className="border-b last:border-0 hover:bg-accent/40">
                        <td className="px-4 py-2 font-medium">{r.name}</td>
                        {AGEING_BUCKETS.map((b, i) => (
                          <td key={b} className="px-4 py-2 text-right">
                            <Money
                              value={r.buckets[b] ?? 0}
                              showZero={false}
                              className={i >= 4 && (r.buckets[b] ?? 0) > 0 ? 'text-destructive' : undefined}
                            />
                          </td>
                        ))}
                        <td className="px-4 py-2 text-right font-medium"><Money value={r.totalPaise} /></td>
                      </tr>
                    ))
                  )}
                  {d.rows.length > 0 && (
                    <tr className="border-t-2 bg-muted/40 font-semibold">
                      <td className="px-4 py-3">Total</td>
                      {AGEING_BUCKETS.map((b) => (
                        <td key={b} className="px-4 py-3 text-right">
                          <Money value={d.totals[b] ?? 0} showZero={false} />
                        </td>
                      ))}
                      <td className="px-4 py-3 text-right"><Money value={d.grandTotalPaise} /></td>
                    </tr>
                  )}
                </tbody>
              </ReportTable>

              <p className="text-xs leading-relaxed text-muted-foreground">
                Aged from each document&rsquo;s due date, not the date it was raised — an invoice on sixty-day
                terms is not late on day thirty. This total always equals the{' '}
                {side === 'ar' ? 'Accounts Receivable' : 'Accounts Payable'} balance on the trial balance;
                if the two ever differ, a document has been settled in one place and not the other.
              </p>
              {side === 'ar' && <DoubtfulDebtsCard asOf={range.to} />}
            </>
          );
        }}
      </AsyncPage>
    </ReportShell>
  );
}
