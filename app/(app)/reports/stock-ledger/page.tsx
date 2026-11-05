'use client';

// An item's stock ledger: every receipt, issue, sale, return and adjustment
// over the period, with a running balance from the opening to the closing
// quantity of the stock summary (lib/server/reports/stock-movement.ts).

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Combobox } from '@/components/ui/combobox';
import { downloadCsv, ReportShell, ReportTable, useReportRange } from '@/components/shared/report-shell';
import { AsyncPage } from '@/components/shared/async-state';
import { Money } from '@/components/shared/money';
import { api } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { useAppStore } from '@/lib/store';
import { sourceHref } from '@/lib/source-links';
import { dayLabel } from '@/lib/date-range';

interface Ledger {
  item: { id: string; name: string; sku: string | null; uqc: string };
  openingQty: number; inQty: number; outQty: number; closingQty: number; closingValuePaise: number;
  lines: { date: string; kind: string; sourceType: string; sourceId: number | null; number: string; qtyIn: number; qtyOut: number; balanceQty: number }[];
}

const HREF: Record<string, string> = { goods_receipt: '/purchases/goods-receipts', production: '/inventory/production', stock_adjustment: '/inventory/adjustments', job_work: '/gst/job-work' };
const qty = (n: number) => (n ? n.toLocaleString('en-IN', { maximumFractionDigits: 3 }) : '');

export default function StockLedgerPage() {
  const [range, setRange] = useReportRange();
  const items = useAppStore((s) => s.items);
  const options = useMemo(() => items.filter((i) => i.kind === 'goods').map((i) => ({ value: i.id, label: i.name, sublabel: i.sku ?? undefined })), [items]);
  const [itemId, setItemId] = useState('');
  const pick = itemId || options[0]?.value || '';
  const state = useApi<Ledger | null>(
    () => (pick ? api.get('/api/inventory/reports', { report: 'stock-ledger', itemId: pick, from: range.from, to: range.to }) : Promise.resolve(null)),
    [pick, range.from, range.to],
  );

  return (
    <ReportShell
      title="Stock Ledger"
      description="Every movement of one item over the period, with a running balance that ends where the stock summary does."
      range={range}
      onRangeChange={setRange}
      extraActions={<div className="w-72"><Combobox options={options} value={pick} onChange={setItemId} placeholder="Pick an item" showAvatar={false} /></div>}
      onExport={() => {
        const d = state.data;
        if (!d) return;
        downloadCsv(`stock-ledger-${d.item.name}.csv`, [
          ['Date', 'Movement', 'Document', 'In', 'Out', 'Balance'],
          [range.from, 'Opening', '', '', '', String(d.openingQty)],
          ...d.lines.map((l) => [l.date, l.kind, l.number, String(l.qtyIn || ''), String(l.qtyOut || ''), String(l.balanceQty)]),
          [range.to, 'Closing', '', String(d.inQty), String(d.outQty), String(d.closingQty)],
        ]);
      }}
    >
      <AsyncPage state={state}>
        {(d) => !d ? <p className="text-sm text-muted-foreground">No stocked items yet.</p> : (
          <ReportTable>
            <thead className="bg-muted/40 text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Date</th>
                <th className="px-3 py-2 text-left font-medium">Movement</th>
                <th className="px-3 py-2 text-left font-medium">Document</th>
                <th className="px-3 py-2 text-right font-medium">In ({d.item.uqc})</th>
                <th className="px-3 py-2 text-right font-medium">Out</th>
                <th className="px-3 py-2 text-right font-medium">Balance</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-t"><td className="px-3 py-2">{dayLabel(range.from)}</td><td className="px-3 py-2 font-medium" colSpan={4}>Opening</td><td className="px-3 py-2 text-right tabular-nums">{qty(d.openingQty) || '0'}</td></tr>
              {d.lines.map((l, i) => {
                const href = sourceHref(l.sourceType, l.sourceId ? String(l.sourceId) : null) ?? HREF[l.sourceType];
                return (
                  <tr key={i} className="border-t">
                    <td className="px-3 py-2 tabular-nums">{dayLabel(l.date)}</td>
                    <td className="px-3 py-2 capitalize">{l.kind}</td>
                    <td className="px-3 py-2">{href ? <Link href={href} className="text-primary hover:underline">{l.number}</Link> : l.number}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{qty(l.qtyIn)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{qty(l.qtyOut)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{qty(l.balanceQty) || '0'}</td>
                  </tr>
                );
              })}
              <tr className="border-t bg-muted/30 font-semibold">
                <td className="px-3 py-2">{dayLabel(range.to)}</td><td className="px-3 py-2" colSpan={2}>Closing · value <Money value={d.closingValuePaise} /></td>
                <td className="px-3 py-2 text-right tabular-nums">{qty(d.inQty)}</td><td className="px-3 py-2 text-right tabular-nums">{qty(d.outQty)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{qty(d.closingQty) || '0'}</td>
              </tr>
            </tbody>
          </ReportTable>
        )}
      </AsyncPage>
    </ReportShell>
  );
}
