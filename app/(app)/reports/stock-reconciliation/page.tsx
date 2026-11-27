'use client';

// Stock valuation vs ledger (status review 7, item 5): at any date, each
// item's value per the Inventory Valuation report beside what the Inventory
// account holds for it, the variance, and why there is one. A book in order
// reads ₹0.00. On a periodic book there is no Inventory posting to differ, and
// the page shows the P&L's cost of goods sold worked out from the valuation.

import Link from 'next/link';
import { useState } from 'react';
import { CheckCircle2, AlertTriangle, Scale } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { downloadCsv, ReportShell, useReportRange } from '@/components/shared/report-shell';
import { AsyncPage } from '@/components/shared/async-state';
import { StatTile } from '@/components/shared/stat-tile';
import { Money } from '@/components/shared/money';
import { ApiError, stockReconciliation, type StockReconciliationResponse } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';
import { formatINR } from '@/lib/money';
import { cn } from '@/lib/utils';

const dmy = (d: string) => (d ? `${d.slice(8, 10)}-${d.slice(5, 7)}-${d.slice(0, 4)}` : '');

export default function StockReconciliationPage() {
  const [range, setRange] = useReportRange();
  const state = useApi<StockReconciliationResponse>(() => stockReconciliation.get(range.to), [range.to]);
  const canTrueUp = usePermission('accountant', 'approve');
  const [busy, setBusy] = useState(false);

  const bring = async () => {
    setBusy(true);
    try {
      const r = await stockReconciliation.bringIntoLine(range.to);
      toast.success(r.movedPaise ? `${formatINR(Math.abs(r.movedPaise))} posted to bring Inventory into line` : 'Already in line: nothing to post.');
      state.refetch();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'The true-up did not post.');
    } finally { setBusy(false); }
  };

  const csv = (d: StockReconciliationResponse) => downloadCsv(`stock-valuation-vs-ledger-${d.asOf}.csv`, [
    ['Item', 'SKU', 'Method', 'Quantity', 'Value per valuation', 'Value per Inventory account', 'Variance', 'Reason'],
    ...d.lines.map((l) => [l.name, l.sku ?? '', l.valuation === 'fifo' ? 'FIFO' : 'Average', String(l.qty), (l.valuationPaise / 100).toFixed(2),
      l.ledgerPaise === null ? '' : (l.ledgerPaise / 100).toFixed(2), (l.variancePaise / 100).toFixed(2), l.reasons.join(' ')]),
    ...(d.unassigned.amountPaise ? [['Not held for any item', '', '', '', '', (d.unassigned.amountPaise / 100).toFixed(2), (-d.unassigned.amountPaise / 100).toFixed(2), 'Entries posted to Inventory without an item']] : []),
    ['Total', '', '', '', (d.totals.valuationPaise / 100).toFixed(2), (d.totals.ledgerPaise / 100).toFixed(2), (d.totals.variancePaise / 100).toFixed(2), ''],
  ]);

  return (
    <ReportShell
      title="Stock Valuation vs Ledger"
      description="Each item's value per the Inventory Valuation report against the Inventory account, the variance, and its reason."
      range={range} onRangeChange={setRange} asOfOnly
      onExport={() => { if (state.data) csv(state.data); }}
      extraActions={canTrueUp && state.data?.method === 'perpetual' && state.data.totals.variancePaise !== 0 ? (
        <Button size="sm" variant="outline" className="gap-1.5" disabled={busy} onClick={() => void bring()} data-slot="stock-rec-true-up">
          <Scale className="size-3.5" /> Bring into line
        </Button>
      ) : null}
    >
      <AsyncPage state={state}>
        {(d) => (
          <div className="space-y-4" data-slot="stock-rec" data-method={d.method}>
            <div className="grid gap-3 sm:grid-cols-3">
              <StatTile label="Value per valuation report" value={formatINR(d.totals.valuationPaise)} />
              <StatTile label={d.method === 'perpetual' ? 'Inventory account (GL / TB)' : 'Inventory in the statements'}
                value={formatINR(d.method === 'perpetual' ? d.totals.ledgerPaise : d.totals.inStatementsPaise)} />
              <StatTile label="Variance" value={formatINR(d.totals.variancePaise)} tone={d.totals.variancePaise === 0 ? 'positive' : 'danger'} />
            </div>
            <p className={cn('flex items-start gap-2 rounded-[6px] px-4 py-3 text-[13px]', d.totals.variancePaise === 0 ? 'bg-[#e7f6ee] text-[#1e7a46]' : 'bg-[#fdecee] text-[#c0392b]')}
              data-slot="stock-rec-verdict">
              {d.totals.variancePaise === 0 ? <CheckCircle2 className="mt-0.5 size-4 shrink-0" /> : <AlertTriangle className="mt-0.5 size-4 shrink-0" />}
              <span>
                {d.totals.variancePaise === 0
                  ? `At ${dmy(d.asOf)} the stock valuation and the ledger agree to the paisa: variance ₹0.00.`
                  : `At ${dmy(d.asOf)} the Inventory account differs from the valuation by ${formatINR(d.totals.variancePaise)}. Each item's reason is below.`}
              </span>
            </p>
            <ul className="list-disc space-y-1 pl-5 text-[12.5px] text-muted-foreground" data-slot="stock-rec-notes">
              {d.notes.map((n, i) => <li key={i}>{n}</li>)}
            </ul>

            <div className="overflow-x-auto rounded-[6px] border">
              <table className="w-full text-[13px]" data-slot="stock-rec-table">
                <thead className="bg-muted/50 text-[11.5px] uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Item</th>
                    <th className="px-3 py-2 text-left font-medium">Method</th>
                    <th className="px-3 py-2 text-right font-medium">Quantity</th>
                    <th className="px-3 py-2 text-right font-medium">Per valuation</th>
                    <th className="px-3 py-2 text-right font-medium">Per Inventory account</th>
                    <th className="px-3 py-2 text-right font-medium">Variance</th>
                    <th className="px-3 py-2 text-left font-medium">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {d.lines.length === 0 && (
                    <tr><td colSpan={7} className="px-3 py-8 text-center text-muted-foreground">No stock at this date. Record a bill for a goods item that tracks stock, and it shows here.</td></tr>
                  )}
                  {d.lines.map((l) => (
                    <tr key={l.itemId} className="border-t" data-slot="stock-rec-row" data-item={l.name}>
                      <td className="px-3 py-2"><Link href={`/sales/items/${l.itemId}`} className="font-medium text-link hover:underline">{l.name}</Link>
                        {l.sku && <span className="block text-[11.5px] text-muted-foreground">{l.sku}</span>}</td>
                      <td className="px-3 py-2 text-muted-foreground">{l.valuation === 'fifo' ? 'FIFO' : 'Average'}</td>
                      <td className="px-3 py-2 text-right tabular">{l.qty} {l.uqc}</td>
                      <td className="px-3 py-2 text-right" data-slot="rec-valuation"><Money value={l.valuationPaise} /></td>
                      <td className="px-3 py-2 text-right" data-slot="rec-ledger">{l.ledgerPaise === null ? <span className="text-muted-foreground">Not posted (periodic)</span> : <Money value={l.ledgerPaise} />}</td>
                      <td className={cn('px-3 py-2 text-right font-medium', l.variancePaise !== 0 && 'text-[#c0392b]')} data-slot="rec-variance"><Money value={l.variancePaise} /></td>
                      <td className="px-3 py-2 text-[12px] text-muted-foreground">{l.reasons.join(' ') || (d.method === 'perpetual' ? 'In line.' : 'Carried from the valuation.')}</td>
                    </tr>
                  ))}
                  {d.unassigned.amountPaise !== 0 && (
                    <tr className="border-t bg-amber-50/60" data-slot="stock-rec-unassigned">
                      <td className="px-3 py-2 font-medium" colSpan={4}>Not held for any item</td>
                      <td className="px-3 py-2 text-right"><Money value={d.unassigned.amountPaise} /></td>
                      <td className="px-3 py-2 text-right font-medium text-[#c0392b]"><Money value={-d.unassigned.amountPaise} /></td>
                      <td className="px-3 py-2 text-[12px] text-muted-foreground">
                        Posted to Inventory without naming an item:{' '}
                        {d.unassigned.entries.slice(0, 6).map((e, i) => (
                          <span key={i}>{i > 0 && '; '}{e.entryNo ? `entry #${e.entryNo}` : 'starting split'} of {dmy(e.date)} ({formatINR(e.amountPaise)}){e.memo ? ` "${e.memo}"` : ''}</span>
                        ))}.
                      </td>
                    </tr>
                  )}
                </tbody>
                <tfoot>
                  <tr className="border-t bg-muted/40 font-semibold" data-slot="stock-rec-total">
                    <td className="px-3 py-2" colSpan={3}>Total</td>
                    <td className="px-3 py-2 text-right"><Money value={d.totals.valuationPaise} /></td>
                    <td className="px-3 py-2 text-right">{d.method === 'perpetual' ? <Money value={d.totals.ledgerPaise} /> : <span className="text-muted-foreground">—</span>}</td>
                    <td className="px-3 py-2 text-right" data-slot="rec-total-variance"><Money value={d.totals.variancePaise} /></td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>

            <section className="rounded-[6px] border p-4 text-[13px]" data-slot="stock-rec-proof">
              <h2 className="mb-2 font-semibold">Cost of goods sold in the P&amp;L, {dmy(d.proof.from)} to {dmy(d.asOf)}</h2>
              <dl className="grid max-w-md grid-cols-[1fr_auto] gap-x-6 gap-y-1">
                <dt>Opening stock not in the ledger</dt><dd className="text-right"><Money value={d.proof.openingStockPaise} /></dd>
                <dt>Direct costs (cost of goods sold, purchases, freight)</dt><dd className="text-right"><Money value={d.proof.directCostsPaise} /></dd>
                <dt>Less closing stock not in the ledger</dt><dd className="text-right"><Money value={-d.proof.closingStockPaise} /></dd>
                <dt className="font-semibold">Cost of goods sold</dt><dd className="text-right font-semibold" data-slot="proof-cogs"><Money value={d.proof.costOfGoodsSoldPaise} /></dd>
              </dl>
              <p className="mt-2 text-[12px] text-muted-foreground">
                {d.method === 'perpetual'
                  ? 'On a perpetual book the stock is in the ledger, so the P&L reads the Cost of Goods Sold account; nothing is added or taken off.'
                  : 'On a periodic book cost of goods sold is opening stock + purchases − closing stock, with closing stock from the valuation above.'}{' '}
                See the <Link href="/reports/inventory-valuation" className="text-link hover:underline">Inventory Valuation Summary</Link>,{' '}
                <Link href="/reports/profit-and-loss" className="text-link hover:underline">Profit and Loss</Link> and{' '}
                <Link href="/reports/trial-balance" className="text-link hover:underline">Trial Balance</Link>.
              </p>
            </section>
          </div>
        )}
      </AsyncPage>
    </ReportShell>
  );
}
