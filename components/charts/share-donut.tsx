'use client';

// A donut plus a legend that carries both the amount and the share.
//
// A slice on its own tells you the ordering but not the magnitude — you can see
// that rent is the biggest expense without seeing that it is 41% of the total,
// or what it cost. Putting the percentage next to the rupee figure is the
// difference between a picture and a number you can act on.

import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import { formatINR } from '@/lib/money';
import { CHART_COLORS, tooltipStyle } from './chart-bits';

export interface DonutSlice {
  name: string;
  /** In paise, as everything in this app is. */
  value: number;
}

export function ShareDonut({
  data,
  height = 200,
  emptyMessage = 'Nothing to chart for this period.',
  centreLabel,
}: {
  data: DonutSlice[];
  height?: number;
  emptyMessage?: string;
  centreLabel?: string;
}) {
  const total = data.reduce((t, d) => t + d.value, 0);
  const slices = data
    .filter((d) => d.value > 0)
    .map((d, i) => ({
      ...d,
      pct: total > 0 ? (d.value / total) * 100 : 0,
      fill: CHART_COLORS[i % CHART_COLORS.length],
      // Recharts charts in rupees; the store holds paise.
      rupees: d.value / 100,
    }));

  if (slices.length === 0) {
    return (
      <div
        className="grid place-items-center text-center text-sm text-muted-foreground"
        style={{ height }}
      >
        {emptyMessage}
      </div>
    );
  }

  return (
    <div>
      <div className="relative">
        <ResponsiveContainer width="100%" height={height}>
          <PieChart>
            <Pie
              data={slices}
              dataKey="rupees"
              nameKey="name"
              innerRadius="58%"
              outerRadius="88%"
              paddingAngle={2}
              stroke="none"
            >
              {slices.map((sl, i) => (
                <Cell key={i} fill={sl.fill} />
              ))}
            </Pie>
            <Tooltip
              contentStyle={tooltipStyle}
              formatter={(v: unknown, name: unknown) => {
                const sl = slices.find((x) => x.name === name);
                return [
                  `₹${Number(v ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })} · ${sl ? sl.pct.toFixed(1) : '0'}%`,
                  String(name),
                ];
              }}
            />
          </PieChart>
        </ResponsiveContainer>

        {/* The total belongs in the hole — that is what the hole is for. */}
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <div className="text-center">
            <p className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
              {centreLabel ?? 'Total'}
            </p>
            <p className="tabular text-sm font-semibold">{formatINR(total)}</p>
          </div>
        </div>
      </div>

      <ul className="mt-3 space-y-1.5">
        {slices.map((sl) => (
          <li key={sl.name} className="flex items-center gap-2 text-xs">
            <span className="size-2.5 shrink-0 rounded-sm" style={{ background: sl.fill }} />
            <span className="truncate text-muted-foreground">{sl.name}</span>
            <span className="ml-auto shrink-0 tabular font-medium">{formatINR(sl.value)}</span>
            <span className="w-12 shrink-0 text-right tabular text-muted-foreground">
              {sl.pct.toFixed(1)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
