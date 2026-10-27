'use client';

// Tally's ledgers: the list with each one's opening and closing, and a ledger's
// vouchers with the running balance — Tally's Ledger Vouchers report. The
// running balance is worked out from the vouchers here, so the page also says
// whether it lands where Tally said the ledger stood.

import { useMemo, useState } from 'react';
import { ArrowLeft, CheckCircle2, Search, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { AsyncPage, LoadingRows } from '@/components/shared/async-state';
import { DateRangePicker } from '@/components/shared/date-range-picker';
import { Money } from '@/components/shared/money';
import { ReportTable } from '@/components/shared/report-shell';
import { tally, type LedgerListView, type LedgerVouchersView } from '@/lib/api/tally';
import { useApi } from '@/lib/api/use-api';
import type { RangeValue } from '@/lib/date-range';
import { drcr, longDate, tallyDate } from './format';

export function LedgerList({ companyId, onOpen }: { companyId: string; onOpen: (ledgerId: string) => void }) {
  const state = useApi<LedgerListView>(() => tally.ledgers(companyId), [companyId]);
  const [q, setQ] = useState('');

  return (
    <div className="space-y-3" data-slot="tally-ledgers">
      <div className="relative max-w-sm">
        <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search ledgers or groups" className="pl-8" />
      </div>
      <AsyncPage state={state} loading={<LoadingRows rows={10} />}>
        {(d) => {
          const term = q.trim().toLowerCase();
          const rows = term
            ? d.rows.filter((r) => `${r.name} ${r.group} ${r.primaryGroup} ${r.gstin ?? ''}`.toLowerCase().includes(term))
            : d.rows;
          return (
            <>
              <ReportTable>
                <thead>
                  <tr className="border-b bg-muted/50 text-xs text-muted-foreground">
                    <th className="px-4 py-2.5 text-left font-semibold">Ledger</th>
                    <th className="px-4 py-2.5 text-left font-semibold">Under</th>
                    <th className="px-4 py-2.5 text-right font-semibold">Opening ({d.fyFrom ? tallyDate(d.fyFrom) : '—'})</th>
                    <th className="px-4 py-2.5 text-right font-semibold">Closing{d.asOf ? ` (${tallyDate(d.asOf)})` : ''}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="cursor-pointer border-b last:border-0 hover:bg-accent/40" onClick={() => onOpen(r.id)} data-slot="tally-ledger-row">
                      <td className="px-4 py-2">
                        <p className="font-medium">{r.name}</p>
                        {r.gstin && <p className="font-mono text-[10px] text-muted-foreground">{r.gstin}</p>}
                      </td>
                      <td className="px-4 py-2 text-xs text-muted-foreground">
                        {r.group}
                        {r.group !== r.primaryGroup && <span className="block text-[10px]">{r.primaryGroup}</span>}
                      </td>
                      <td className="num px-4 py-2 text-right text-xs">{drcr(r.openingPaise)}</td>
                      <td className="num px-4 py-2 text-right">{drcr(r.closingPaise)}</td>
                    </tr>
                  ))}
                </tbody>
              </ReportTable>
              <p className="text-xs text-muted-foreground">
                {rows.length.toLocaleString('en-IN')} of {d.rows.length.toLocaleString('en-IN')} ledgers. Open one to see its vouchers.
              </p>
            </>
          );
        }}
      </AsyncPage>
    </div>
  );
}

export function LedgerVouchers({
  companyId,
  ledgerId,
  range,
  onRange,
  onBack,
}: {
  companyId: string;
  ledgerId: string;
  range: RangeValue;
  onRange: (r: RangeValue) => void;
  onBack: () => void;
}) {
  const state = useApi<LedgerVouchersView>(
    () => tally.ledger(companyId, ledgerId, range.from, range.to),
    [companyId, ledgerId, range.from, range.to],
  );
  const title = useMemo(() => state.data?.ledger.name ?? 'Ledger', [state.data]);

  return (
    <div className="space-y-3" data-slot="tally-ledger-vouchers">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" onClick={onBack}>
          <ArrowLeft className="size-3.5" /> Ledgers
        </Button>
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold">{title}</p>
          {state.data && (
            <p className="text-xs text-muted-foreground">
              Under {state.data.ledger.group} · {longDate(range.from)} to {longDate(range.to)}
            </p>
          )}
        </div>
        <DateRangePicker value={range} onChange={onRange} />
      </div>

      <AsyncPage state={state} loading={<LoadingRows rows={10} />}>
        {(d) => (
          <>
            {d.check && (
              <Card
                className={
                  'flex-row items-start gap-3 p-3 text-xs ' +
                  (d.check.matches ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-warning/50 bg-warning/5')
                }
                data-slot="tally-ledger-check"
              >
                {d.check.matches ? (
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                ) : (
                  <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
                )}
                <p className="leading-relaxed">
                  {d.check.matches ? (
                    <>
                      These vouchers add up to <span className="font-medium">{drcr(d.check.tallyPaise)}</span> on{' '}
                      {longDate(d.check.asOf)} — the same balance Tally reported.
                    </>
                  ) : (
                    <>
                      Tally reported <span className="font-medium">{drcr(d.check.tallyPaise)}</span> on {longDate(d.check.asOf)}, but
                      the vouchers received so far add up to <span className="font-medium">{drcr(d.check.fromVouchersPaise)}</span>. Some
                      vouchers have not arrived yet — they will with the next sync.
                    </>
                  )}
                </p>
              </Card>
            )}
            <ReportTable>
              <thead>
                <tr className="border-b bg-muted/50 text-xs text-muted-foreground">
                  <th className="w-24 px-4 py-2.5 text-left font-semibold">Date</th>
                  <th className="px-4 py-2.5 text-left font-semibold">Particulars</th>
                  <th className="px-4 py-2.5 text-left font-semibold">Vch Type</th>
                  <th className="px-4 py-2.5 text-left font-semibold">Vch No.</th>
                  <th className="px-4 py-2.5 text-right font-semibold">Debit</th>
                  <th className="px-4 py-2.5 text-right font-semibold">Credit</th>
                  <th className="px-4 py-2.5 text-right font-semibold">Balance</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-b bg-muted/20 text-xs">
                  <td className="px-4 py-2" colSpan={6}>
                    Opening Balance
                  </td>
                  <td className="num px-4 py-2 text-right font-medium">{drcr(d.openingPaise)}</td>
                </tr>
                {d.rows.map((r) => (
                  <tr key={r.voucherId} className="border-b hover:bg-accent/40">
                    <td className="whitespace-nowrap px-4 py-2 font-mono text-xs">{tallyDate(r.date)}</td>
                    <td className="px-4 py-2">
                      <span className="font-medium">{r.particulars}</span>
                      {r.others > 0 && <span className="ml-1.5 text-xs text-muted-foreground">+{r.others} more</span>}
                      {r.narration && <p className="truncate text-[11px] text-muted-foreground">{r.narration}</p>}
                    </td>
                    <td className="px-4 py-2 text-xs">{r.voucherType}</td>
                    <td className="px-4 py-2 font-mono text-xs">{r.number ?? '—'}</td>
                    <td className="px-4 py-2 text-right">{r.debitPaise ? <Money value={r.debitPaise} /> : ''}</td>
                    <td className="px-4 py-2 text-right">{r.creditPaise ? <Money value={r.creditPaise} /> : ''}</td>
                    <td className="num px-4 py-2 text-right text-xs">{drcr(r.balancePaise)}</td>
                  </tr>
                ))}
                <tr className="border-t-2 bg-muted/40 font-semibold">
                  <td className="px-4 py-3" colSpan={4}>
                    Current Total
                  </td>
                  <td className="px-4 py-3 text-right"><Money value={d.totalDebitPaise} /></td>
                  <td className="px-4 py-3 text-right"><Money value={d.totalCreditPaise} /></td>
                  <td />
                </tr>
                <tr className="bg-muted/40 font-semibold">
                  <td className="px-4 pb-3" colSpan={6}>
                    Closing Balance
                  </td>
                  <td className="num px-4 pb-3 text-right">{drcr(d.closingPaise)}</td>
                </tr>
              </tbody>
            </ReportTable>
            {d.rows.length === 0 && <p className="text-xs text-muted-foreground">No vouchers touch this ledger in the period.</p>}
            {d.truncated && <p className="text-xs text-muted-foreground">Showing the first 5,000 vouchers. Pick a shorter period.</p>}
          </>
        )}
      </AsyncPage>
    </div>
  );
}
