'use client';

// Stock ageing: how long what is on hand has been sitting, on the
// oldest-goes-first assumption (lib/server/reports/stock-movement.ts). Old
// stock is money tied up, and often stock that will have to be written down.

import { downloadCsv, ReportShell, ReportTable, useReportRange } from '@/components/shared/report-shell';
import { AsyncPage } from '@/components/shared/async-state';
import { Money } from '@/components/shared/money';
import { api } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';

const BUCKETS = ['0–30 days', '31–60 days', '61–90 days', '91–180 days', 'Over 180 days'];

interface Ageing {
  asOf: string;
  totalsPaise: number[];
  rows: { itemId: string; name: string; uqc: string; qty: number; valuePaise: number; buckets: number[]; bucketValuesPaise: number[]; oldestDays: number | null }[];
}

export default function StockAgeingPage() {
  const [range, setRange] = useReportRange();
  const state = useApi<Ageing>(() => api.get('/api/inventory/reports', { report: 'stock-ageing', asOf: range.to }), [range.to]);
  return (
    <ReportShell
      title="Stock Ageing"
      description="The stock on hand, by how long ago it came in. What is left is taken to be the newest receipts; anything older than every receipt is opening stock."
      range={range}
      onRangeChange={setRange}
      asOfOnly
      onExport={() => {
        const d = state.data;
        if (!d) return;
        downloadCsv('stock-ageing.csv', [
          ['Item', 'Qty', 'Value', ...BUCKETS],
          ...d.rows.map((r) => [r.name, String(r.qty), String(r.valuePaise / 100), ...r.bucketValuesPaise.map((v) => String(v / 100))]),
        ]);
      }}
    >
      <AsyncPage state={state}>
        {(d) => (
          <ReportTable>
            <thead className="bg-muted/40 text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Item</th>
                <th className="px-3 py-2 text-right font-medium">On hand</th>
                <th className="px-3 py-2 text-right font-medium">Value</th>
                {BUCKETS.map((b) => <th key={b} className="px-3 py-2 text-right font-medium">{b}</th>)}
              </tr>
            </thead>
            <tbody>
              {d.rows.map((r) => (
                <tr key={r.itemId} className="border-t">
                  <td className="px-3 py-2">{r.name}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.qty.toLocaleString('en-IN')} {r.uqc}</td>
                  <td className="px-3 py-2 text-right"><Money value={r.valuePaise} /></td>
                  {r.bucketValuesPaise.map((v, i) => (
                    <td key={i} className={`px-3 py-2 text-right ${i >= 3 && v ? 'text-amber-700 dark:text-amber-300' : ''}`}><Money value={v} showZero={false} /></td>
                  ))}
                </tr>
              ))}
              {!d.rows.length && <tr className="border-t"><td className="px-3 py-2 text-muted-foreground" colSpan={8}>Nothing in stock on this date.</td></tr>}
              <tr className="border-t bg-muted/30 font-semibold">
                <td className="px-3 py-2" colSpan={2}>Total</td>
                <td className="px-3 py-2 text-right"><Money value={d.rows.reduce((t, r) => t + r.valuePaise, 0)} /></td>
                {d.totalsPaise.map((v, i) => <td key={i} className="px-3 py-2 text-right"><Money value={v} /></td>)}
              </tr>
            </tbody>
          </ReportTable>
        )}
      </AsyncPage>
    </ReportShell>
  );
}
