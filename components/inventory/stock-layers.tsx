'use client';

// An item's FIFO layers, as the auditors asked to see them on the item page:
// each receipt (a bill line or a production run), how many came in, how many
// went back to the supplier, how many of it are still on hand, its rate and the
// value of what is left. What is on hand is the newest units, so the layers are
// read from the latest receipt back; the total is the Inventory Valuation
// report's figure for the item.

import Link from 'next/link';
import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Money } from '@/components/shared/money';
import { AsyncPage } from '@/components/shared/async-state';
import { stockReconciliation, type ItemLayersResponse } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';

const dmy = (d: string) => (d ? `${d.slice(8, 10)}-${d.slice(5, 7)}-${d.slice(0, 4)}` : '');
const today = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);

export function StockLayers({ itemId }: { itemId: string }) {
  const [asOf, setAsOf] = useState(today());
  const state = useApi<ItemLayersResponse>(() => stockReconciliation.layers(itemId, asOf), [itemId, asOf]);
  return (
    <div className="space-y-3 px-6 py-5" data-slot="item-layers">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13px] text-muted-foreground">
          What is in stock, receipt by receipt. Under FIFO the oldest units are sold first, so what is left is the newest.{' '}
          <Link href="/reports/stock-reconciliation" className="text-link hover:underline">Stock valuation vs ledger</Link>
        </p>
        <label className="flex items-center gap-2 text-[13px]">As at
          <Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value || today())} className="h-8 w-40" data-slot="item-layers-date" />
        </label>
      </div>
      <AsyncPage state={state}>
        {(d) => (
          <>
            {d.valuation !== 'fifo' && (
              <p className="rounded-[6px] bg-[#eef4fd] px-3 py-2 text-[12.5px]">This item is valued at weighted average cost, so its layers are shown for reference: its value is the quantity at the year&apos;s average.</p>
            )}
            <div className="overflow-x-auto rounded-[6px] border">
              <table className="w-full text-[13px]" data-slot="item-layers-table">
                <thead className="bg-muted/50 text-[11.5px] uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Date</th>
                    <th className="px-3 py-2 text-left font-medium">Receipt</th>
                    <th className="px-3 py-2 text-right font-medium">Came in</th>
                    <th className="px-3 py-2 text-right font-medium">Sent back</th>
                    <th className="px-3 py-2 text-right font-medium">On hand</th>
                    <th className="px-3 py-2 text-right font-medium">Rate</th>
                    <th className="px-3 py-2 text-right font-medium">Value on hand</th>
                  </tr>
                </thead>
                <tbody>
                  {d.layers.length === 0 && d.olderQty === 0 && (
                    <tr><td colSpan={7} className="px-3 py-8 text-center text-muted-foreground">No receipts yet. Record a bill for this item and its layer shows here.</td></tr>
                  )}
                  {d.layers.map((l, i) => (
                    <tr key={i} className="border-t" data-slot="item-layer-row">
                      <td className="px-3 py-2">{dmy(l.date)}</td>
                      <td className="px-3 py-2">
                        {l.documentId ? <Link href={l.source === 'bill' ? `/purchases/bills/${l.documentId}` : '/inventory/production'} className="text-link hover:underline">{l.document}</Link> : l.document}
                        {l.party && <span className="block text-[11.5px] text-muted-foreground">{l.party}</span>}
                      </td>
                      <td className="px-3 py-2 text-right tabular">{l.receivedQty}</td>
                      <td className="px-3 py-2 text-right tabular">{l.returnedQty || '—'}</td>
                      <td className="px-3 py-2 text-right tabular font-medium" data-slot="layer-on-hand">{l.onHandQty}</td>
                      <td className="px-3 py-2 text-right"><Money value={l.ratePaise} /></td>
                      <td className="px-3 py-2 text-right" data-slot="layer-value"><Money value={l.valuePaise} showZero={false} /></td>
                    </tr>
                  ))}
                  {d.olderQty > 0 && (
                    <tr className="border-t">
                      <td className="px-3 py-2" colSpan={4}>Opening stock (older than every receipt)</td>
                      <td className="px-3 py-2 text-right tabular font-medium">{d.olderQty}</td>
                      <td className="px-3 py-2 text-right"><Money value={d.olderRatePaise} /></td>
                      <td className="px-3 py-2 text-right"><Money value={d.olderValuePaise} /></td>
                    </tr>
                  )}
                </tbody>
                <tfoot>
                  <tr className="border-t bg-muted/40 font-semibold">
                    <td className="px-3 py-2" colSpan={4}>In stock at {dmy(d.asOf)}</td>
                    <td className="px-3 py-2 text-right tabular" data-slot="layers-qty">{d.qty}</td>
                    <td />
                    <td className="px-3 py-2 text-right" data-slot="layers-value"><Money value={d.valuePaise} /></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </>
        )}
      </AsyncPage>
    </div>
  );
}
