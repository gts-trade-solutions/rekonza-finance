'use client';

// Shared "ranked list with a bar chart" report — used by sales-by-customer,
// sales-by-item, purchases-by-vendor and expenses-by-category.

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Card } from '@/components/ui/card';
import { Money } from '@/components/shared/money';
import { ReportTable } from '@/components/shared/report-shell';
import { axisProps, axisRupee, rupeeFormatter, tooltipStyle } from '@/components/charts/chart-bits';
import type { Paise } from '@/lib/types';

export interface RankedRow {
  key: string;
  label: string;
  sublabel?: string;
  qty?: number;
  amountPaise: Paise;
}

export function RankedReport({
  rows,
  valueHeader,
  labelHeader,
  showQty = false,
  qtyHeader = 'Qty',
  emptyMessage = 'Nothing to show for this period.',
}: {
  rows: RankedRow[];
  valueHeader: string;
  labelHeader: string;
  showQty?: boolean;
  qtyHeader?: string;
  emptyMessage?: string;
}) {
  const total = rows.reduce((t, r) => t + r.amountPaise, 0);
  const chartData = rows.slice(0, 8).map((r) => ({
    name: r.label.length > 16 ? r.label.slice(0, 15) + '…' : r.label,
    value: r.amountPaise / 100,
  }));

  if (rows.length === 0) {
    return (
      <ReportTable>
        <tbody>
          <tr>
            <td className="px-4 py-10 text-center text-sm text-muted-foreground">{emptyMessage}</td>
          </tr>
        </tbody>
      </ReportTable>
    );
  }

  return (
    <>
      <Card className="no-print p-4">
        <ResponsiveContainer width="100%" height={240}>
          <BarChart data={chartData} margin={{ left: -6, right: 8, top: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
            <XAxis dataKey="name" {...axisProps} interval={0} angle={-20} textAnchor="end" height={56} />
            <YAxis tickFormatter={axisRupee} {...axisProps} width={62} />
            <Tooltip formatter={rupeeFormatter} cursor={{ fill: 'var(--accent)' }} contentStyle={tooltipStyle} />
            <Bar dataKey="value" name={valueHeader} fill="var(--chart-1)" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </Card>

      <ReportTable>
        <thead>
          <tr className="border-b bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
            <th className="w-12 px-4 py-2.5 text-left font-semibold">#</th>
            <th className="px-4 py-2.5 text-left font-semibold">{labelHeader}</th>
            {showQty && <th className="px-4 py-2.5 text-right font-semibold">{qtyHeader}</th>}
            <th className="px-4 py-2.5 text-right font-semibold">{valueHeader}</th>
            <th className="w-24 px-4 py-2.5 text-right font-semibold">Share</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.key} className="border-b last:border-0 hover:bg-accent/40">
              <td className="px-4 py-2 text-xs text-muted-foreground tabular">{i + 1}</td>
              <td className="px-4 py-2">
                <p className="font-medium">{r.label}</p>
                {r.sublabel && <p className="text-xs text-muted-foreground">{r.sublabel}</p>}
              </td>
              {showQty && <td className="px-4 py-2 text-right tabular">{r.qty ?? 0}</td>}
              <td className="px-4 py-2 text-right"><Money value={r.amountPaise} /></td>
              <td className="px-4 py-2 text-right text-xs text-muted-foreground tabular">
                {total > 0 ? `${((r.amountPaise / total) * 100).toFixed(1)}%` : '—'}
              </td>
            </tr>
          ))}
          <tr className="border-t-2 bg-muted/40 font-semibold">
            <td className="px-4 py-3" colSpan={showQty ? 3 : 2}>Total</td>
            <td className="px-4 py-3 text-right"><Money value={total} /></td>
            <td className="px-4 py-3 text-right text-xs">100%</td>
          </tr>
        </tbody>
      </ReportTable>
    </>
  );
}
