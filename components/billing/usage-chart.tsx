'use client';

// Credits spent per day over the last thirty days. One series, so no legend —
// the title says what it is. Thin bars rounded at the data end, a recessive
// grid, and a tooltip that leads with the value.

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { formatCredits } from '@/lib/billing/catalog';

const AXIS = { tickLine: false, axisLine: false, fontSize: 11, stroke: 'var(--muted-foreground)' } as const;

const label = (date: string) => {
  const [, m, d] = date.split('-').map(Number);
  return `${d} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]}`;
};

export function UsageChart({ days }: { days: { date: string; creditsMc: number; questions: number }[] }) {
  const rows = days.map((d) => ({ ...d, credits: d.creditsMc / 1000, label: label(d.date) }));
  const max = Math.max(1, ...rows.map((r) => r.credits));
  const step = max <= 5 ? 1 : max <= 10 ? 2 : max <= 25 ? 5 : max <= 50 ? 10 : Math.ceil(max / 5 / 10) * 10;
  const top = Math.ceil(max / step) * step;
  const ticks = Array.from({ length: top / step + 1 }, (_, i) => i * step);

  return (
    <div className="h-48" data-slot="usage-chart">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap="28%">
          <CartesianGrid vertical={false} stroke="var(--border)" />
          <XAxis dataKey="label" {...AXIS} interval="preserveStartEnd" minTickGap={24} />
          <YAxis {...AXIS} width={36} domain={[0, top]} ticks={ticks} allowDecimals={false} />
          <Tooltip
            cursor={{ fill: 'var(--muted)', opacity: 0.5 }}
            content={({ active, payload }) => {
              const r = payload?.[0]?.payload as (typeof rows)[number] | undefined;
              return active && r ? (
                <div className="rounded-md border bg-popover px-3 py-2 text-xs shadow-md">
                  <p className="font-semibold tabular-nums">{formatCredits(r.creditsMc)} credits</p>
                  <p className="text-muted-foreground">
                    {r.questions} question{r.questions === 1 ? '' : 's'} · {r.label}
                  </p>
                </div>
              ) : null;
            }}
          />
          <Bar dataKey="credits" fill="var(--viz-1)" radius={[4, 4, 0, 0]} maxBarSize={18} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
