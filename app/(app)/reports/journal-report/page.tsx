'use client';

// Every entry with its full double-entry detail.
//
// This is the raw material. Every other report is a view over these rows, so
// when a figure elsewhere looks wrong this is where it is settled.
//
// Reversals are shown as what they are — a correction posted alongside the
// original, linked to it, with the original left exactly as it was. Nothing in
// the ledger is ever edited or removed.

import { useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Combobox } from '@/components/ui/combobox';
import { Money } from '@/components/shared/money';
import { downloadCsv, ReportShell, useReportRange } from '@/components/shared/report-shell';
import { AsyncPage, LoadingRows } from '@/components/shared/async-state';
import { journal, type JournalResponse } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { toRupees } from '@/lib/money';

const SOURCES = [
  { value: 'all', label: 'Everything' },
  { value: 'invoice', label: 'Invoices' },
  { value: 'bill', label: 'Bills' },
  { value: 'payment_received', label: 'Receipts' },
  { value: 'payment_made', label: 'Payments' },
  { value: 'expense', label: 'Expenses' },
  { value: 'bank_txn', label: 'Bank lines' },
  { value: 'transfer', label: 'Transfers' },
  { value: 'manual', label: 'Manual journals' },
  { value: 'opening_balance', label: 'Opening balances' },
];

export default function JournalReportPage() {
  const [range, setRange] = useReportRange();
  const [source, setSource] = useState('all');

  const state = useApi<JournalResponse>(
    () => journal.list({ from: range.from, to: range.to, sourceType: source, limit: 300 }),
    [range.from, range.to, source],
  );

  return (
    <ReportShell
      title="Journal Report"
      description="Every entry with its full double-entry detail. This is the raw material every other report is built from."
      range={range}
      onRangeChange={setRange}
      extraActions={
        <div className="w-52 space-y-1">
          <label className="text-[11px] font-medium text-muted-foreground">Source</label>
          <Combobox options={SOURCES} value={source} onChange={setSource} showAvatar={false} />
        </div>
      }
      onExport={() => {
        const d = state.data;
        if (!d) return;
        downloadCsv('journal-report.csv', [
          ['Entry', 'Date', 'Source', 'Memo', 'Account code', 'Account', 'Description', 'Debit', 'Credit'],
          ...d.entries.flatMap((e) =>
            e.lines.map((l) => [
              e.entryNo, e.date, e.sourceType, e.memo ?? '', l.accountCode, l.accountName,
              l.description ?? '', toRupees(l.debitPaise), toRupees(l.creditPaise),
            ]),
          ),
        ]);
      }}
    >
      <AsyncPage state={state} loading={<LoadingRows rows={8} />}>
        {(d) =>
          d.entries.length === 0 ? (
            <Card className="p-10 text-center text-sm text-muted-foreground">
              Nothing posted in this period.
            </Card>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">
                {d.summary.count} entr{d.summary.count === 1 ? 'y' : 'ies'} totalling{' '}
                <Money value={d.summary.totalDebitPaise} className="font-medium text-foreground" /> on each
                side. Every one balanced when it was posted, which is why the trial balance ties.
              </p>

              <div className="space-y-3">
                {d.entries.map((e) => {
                  const balanced = e.totalDebitPaise === e.totalCreditPaise;
                  return (
                    <Card key={e.id} className="overflow-hidden p-0">
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b bg-muted/40 px-4 py-2.5">
                        <span className="font-medium">Entry #{e.entryNo}</span>
                        <span className="text-sm text-muted-foreground">
                          {new Date(e.date).toLocaleDateString('en-IN', {
                            day: 'numeric', month: 'short', year: 'numeric',
                          })}
                        </span>
                        <Badge variant="secondary" className="text-[10px] capitalize">
                          {e.sourceType.replace(/_/g, ' ')}
                        </Badge>
                        {e.reversalOf && (
                          <Badge variant="outline" className="gap-1 text-[10px]">
                            <RotateCcw className="size-2.5" /> Reverses #{e.reversalOf}
                          </Badge>
                        )}
                        <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
                          {e.memo}
                        </span>
                        {!balanced && (
                          <Badge variant="outline" className="border-destructive/40 text-[10px] text-destructive">
                            Out of balance
                          </Badge>
                        )}
                      </div>

                      <table className="w-full text-sm">
                        <tbody>
                          {e.lines.map((l) => (
                            <tr key={l.lineNo} className="border-b last:border-0">
                              <td className="px-4 py-2">
                                <span className="font-mono text-xs text-muted-foreground">{l.accountCode}</span>{' '}
                                {l.accountName}
                                {l.contactName && (
                                  <span className="ml-2 text-xs text-muted-foreground">{l.contactName}</span>
                                )}
                              </td>
                              <td className="px-4 py-2 text-xs text-muted-foreground">{l.description ?? '—'}</td>
                              <td className="w-32 px-4 py-2 text-right">
                                <Money value={l.debitPaise} showZero={false} />
                              </td>
                              <td className="w-32 px-4 py-2 text-right">
                                <Money value={l.creditPaise} showZero={false} />
                              </td>
                            </tr>
                          ))}
                          <tr className="bg-muted/30 font-medium">
                            <td className="px-4 py-2" colSpan={2}>
                              {balanced ? 'Balanced' : 'OUT OF BALANCE'}
                            </td>
                            <td className="px-4 py-2 text-right"><Money value={e.totalDebitPaise} /></td>
                            <td className="px-4 py-2 text-right"><Money value={e.totalCreditPaise} /></td>
                          </tr>
                        </tbody>
                      </table>
                    </Card>
                  );
                })}
              </div>
            </>
          )
        }
      </AsyncPage>
    </ReportShell>
  );
}
