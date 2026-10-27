'use client';

// Tally's Day Book: every voucher in a period, in the order it was entered,
// with the party on the line and the amount on its side. A row opens to show
// the ledgers it posted to and its narration.

import { Fragment, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { AsyncPage, LoadingRows } from '@/components/shared/async-state';
import { DateRangePicker } from '@/components/shared/date-range-picker';
import { Money } from '@/components/shared/money';
import { ReportTable } from '@/components/shared/report-shell';
import { tally, type DayBookView } from '@/lib/api/tally';
import { useApi } from '@/lib/api/use-api';
import type { RangeValue } from '@/lib/date-range';
import { cn } from '@/lib/utils';
import { longDate, tallyDate } from './format';

export function DayBook({ companyId, range, onRange }: { companyId: string; range: RangeValue; onRange: (r: RangeValue) => void }) {
  const state = useApi<DayBookView>(() => tally.dayBook(companyId, range.from, range.to), [companyId, range.from, range.to]);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="space-y-3" data-slot="tally-day-book">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {longDate(range.from)} to {longDate(range.to)}
        </p>
        <DateRangePicker value={range} onChange={onRange} />
      </div>

      <AsyncPage state={state} loading={<LoadingRows rows={10} />}>
        {(d) =>
          d.rows.length === 0 ? (
            <Card className="p-8 text-center text-sm text-muted-foreground">No vouchers in this period.</Card>
          ) : (
            <>
              <ReportTable>
                <thead>
                  <tr className="border-b bg-muted/50 text-xs text-muted-foreground">
                    <th className="w-24 px-4 py-2.5 text-left font-semibold">Date</th>
                    <th className="px-4 py-2.5 text-left font-semibold">Particulars</th>
                    <th className="px-4 py-2.5 text-left font-semibold">Vch Type</th>
                    <th className="px-4 py-2.5 text-left font-semibold">Vch No.</th>
                    <th className="px-4 py-2.5 text-right font-semibold">Debit Amount</th>
                    <th className="px-4 py-2.5 text-right font-semibold">Credit Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {d.rows.map((r) => {
                    const expanded = open.has(r.id);
                    return (
                      <Fragment key={r.id}>
                        <tr
                          className={cn('cursor-pointer border-b hover:bg-accent/40', (r.isCancelled || r.isOptional) && 'text-muted-foreground')}
                          onClick={() => toggle(r.id)}
                          data-slot="tally-voucher"
                        >
                          <td className="whitespace-nowrap px-4 py-2 font-mono text-xs">{tallyDate(r.date)}</td>
                          <td className="px-4 py-2">
                            <span className="flex items-center gap-1.5">
                              <ChevronRight className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-90')} />
                              <span className={cn('font-medium', r.isCancelled && 'line-through')}>{r.particulars}</span>
                              {r.isOptional && <Badge variant="outline" className="text-[9px]">Optional</Badge>}
                              {r.isCancelled && <Badge variant="outline" className="text-[9px]">Cancelled</Badge>}
                            </span>
                          </td>
                          <td className="px-4 py-2 text-xs">{r.voucherType}</td>
                          <td className="px-4 py-2 font-mono text-xs">{r.number ?? '—'}</td>
                          <td className="px-4 py-2 text-right">{r.debitPaise !== null ? <Money value={r.debitPaise} /> : ''}</td>
                          <td className="px-4 py-2 text-right">{r.creditPaise !== null ? <Money value={r.creditPaise} /> : ''}</td>
                        </tr>
                        {/* Opened, the voucher's ledgers sit under their own Debit and Credit
                            columns, credits indented — Tally's detailed view. */}
                        {expanded &&
                          r.entries.map((e, i) => (
                            <tr key={`${r.id}-${i}`} className="bg-muted/20 text-xs text-muted-foreground">
                              <td />
                              <td className={cn('px-4 py-1', e.creditPaise > 0 ? 'pl-14' : 'pl-9')} colSpan={3}>
                                {e.debitPaise > 0 ? 'Dr' : 'Cr'} {e.ledger}
                              </td>
                              <td className="px-4 py-1 text-right">{e.debitPaise > 0 ? <Money value={e.debitPaise} /> : ''}</td>
                              <td className="px-4 py-1 text-right">{e.creditPaise > 0 ? <Money value={e.creditPaise} /> : ''}</td>
                            </tr>
                          ))}
                        {expanded && (
                          <tr className="border-b bg-muted/20">
                            <td />
                            <td colSpan={5} className="px-4 pb-2.5 pl-9 pt-1 text-xs text-muted-foreground">
                              {r.entries.length === 0 && (r.isCancelled ? 'Cancelled in Tally — it posts nothing. ' : 'This voucher moves no money. ')}
                              {r.narration && <span className="italic">{r.narration}</span>}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                  <tr className="border-t-2 bg-muted/40 font-semibold">
                    <td className="px-4 py-3" colSpan={4}>
                      Total · {d.rows.length.toLocaleString('en-IN')} voucher{d.rows.length === 1 ? '' : 's'}
                    </td>
                    <td className="px-4 py-3 text-right"><Money value={d.totalDebitPaise} /></td>
                    <td className="px-4 py-3 text-right"><Money value={d.totalCreditPaise} /></td>
                  </tr>
                </tbody>
              </ReportTable>
              {d.truncated && (
                <p className="text-xs text-muted-foreground">Showing the first 3,000 vouchers. Pick a shorter period to see the rest.</p>
              )}
              <p className="text-xs text-muted-foreground">Optional and cancelled vouchers are listed but not counted in the totals, as in Tally.</p>
            </>
          )
        }
      </AsyncPage>
    </div>
  );
}
