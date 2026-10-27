'use client';

// Everything that happened, day by day.
//
// The same entries as the journal report, grouped by date rather than listed
// flat. It answers a different question — not "what does this document do to
// the books" but "what did we do on Tuesday" — which is how somebody closing a
// day or reconciling cash actually looks at it.

import { useMemo } from 'react';
import { CalendarDays } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Money } from '@/components/shared/money';
import { downloadCsv, ReportShell, ReportTable, useReportRange } from '@/components/shared/report-shell';
import { AsyncPage, LoadingRows } from '@/components/shared/async-state';
import { journal, type JournalEntryRow, type JournalResponse } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { toRupees } from '@/lib/money';

export default function DayBookPage() {
  const [range, setRange] = useReportRange();
  const state = useApi<JournalResponse>(
    () => journal.list({ from: range.from, to: range.to, limit: 400 }),
    [range.from, range.to],
  );

  const days = useMemo(() => {
    const byDate = new Map<string, JournalEntryRow[]>();
    for (const e of state.data?.entries ?? []) {
      const list = byDate.get(e.date) ?? [];
      list.push(e);
      byDate.set(e.date, list);
    }
    return [...byDate.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([date, entries]) => ({
        date,
        entries,
        total: entries.reduce((t, e) => t + e.totalDebitPaise, 0),
      }));
  }, [state.data]);

  return (
    <ReportShell
      title="Day Book"
      description="Everything that happened, day by day. The same entries as the journal, arranged the way somebody closing a day reads them."
      range={range}
      onRangeChange={setRange}
      onExport={() => {
        const d = state.data;
        if (!d) return;
        downloadCsv('day-book.csv', [
          ['Date', 'Entry', 'Source', 'Memo', 'Debit', 'Credit'],
          ...d.entries.map((e) => [
            e.date, e.entryNo, e.sourceType, e.memo ?? '',
            toRupees(e.totalDebitPaise), toRupees(e.totalCreditPaise),
          ]),
        ]);
      }}
    >
      <AsyncPage state={state} loading={<LoadingRows rows={8} />}>
        {(d) =>
          days.length === 0 ? (
            <Card className="p-10 text-center text-sm text-muted-foreground">
              Nothing posted in this period.
            </Card>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <Card className="p-4">
                  <p className="micro-label">Days with activity</p>
                  <p className="mt-1.5 tabular text-2xl font-semibold">{days.length}</p>
                </Card>
                <Card className="p-4">
                  <p className="micro-label">Entries</p>
                  <p className="mt-1.5 tabular text-2xl font-semibold">{d.summary.count}</p>
                </Card>
                <Card className="p-4">
                  <p className="micro-label">Value posted</p>
                  <Money value={d.summary.totalDebitPaise} className="mt-1.5 block text-2xl font-semibold" />
                </Card>
              </div>

              <div className="space-y-4">
                {days.map((day) => (
                  <div key={day.date} className="space-y-2">
                    <div className="flex items-center gap-2">
                      <CalendarDays className="size-3.5 text-muted-foreground" />
                      <h2 className="text-sm font-semibold">
                        {new Date(day.date).toLocaleDateString('en-IN', {
                          weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
                        })}
                      </h2>
                      <span className="text-xs text-muted-foreground">
                        {day.entries.length} entr{day.entries.length === 1 ? 'y' : 'ies'} ·{' '}
                        <Money value={day.total} />
                      </span>
                    </div>

                    <ReportTable>
                      <thead>
                        <tr className="border-b bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                          <th className="px-4 py-2 text-left font-semibold">Entry</th>
                          <th className="px-4 py-2 text-left font-semibold">Source</th>
                          <th className="px-4 py-2 text-left font-semibold">Narration</th>
                          <th className="px-4 py-2 text-left font-semibold">Accounts touched</th>
                          <th className="px-4 py-2 text-right font-semibold">Value</th>
                        </tr>
                      </thead>
                      <tbody>
                        {day.entries.map((e) => (
                          <tr key={e.id} className="border-b last:border-0 hover:bg-accent/40">
                            <td className="px-4 py-2 text-xs text-muted-foreground">#{e.entryNo}</td>
                            <td className="px-4 py-2">
                              <Badge variant="secondary" className="text-[10px] capitalize">
                                {e.sourceType.replace(/_/g, ' ')}
                              </Badge>
                            </td>
                            <td className="px-4 py-2">{e.memo ?? '—'}</td>
                            <td className="px-4 py-2 text-xs text-muted-foreground">
                              {e.lines.map((l) => l.accountName).join(', ')}
                            </td>
                            <td className="px-4 py-2 text-right font-medium">
                              <Money value={e.totalDebitPaise} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </ReportTable>
                  </div>
                ))}
              </div>
            </>
          )
        }
      </AsyncPage>
    </ReportShell>
  );
}
