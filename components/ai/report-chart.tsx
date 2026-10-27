'use client';

// ─────────────────────────────────────────────────────────────────────────────
// A report's chart.
//
// The same marks as every chart in Analytics — bars at most 24px thick with a
// 4px round at the data end, 2px lines, hairline horizontal grid, text in text
// colours, a legend only for two series or more, tooltips that lead with the
// value — drawn from the report the server built, so the figures are the books'.
//
// Colour by the job it does. One series is one colour. This period against the
// one before takes the first two categorical slots. Age bands are one hue,
// light to dark, because their order means something. Money in against money
// out takes the diverging pair. The slices of a whole take the categorical
// order, with "Other" in grey. Every chart has its table view beside it.
// ─────────────────────────────────────────────────────────────────────────────

import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, LabelList, Line, LineChart, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { Legend, TipBox, niceScale } from '@/components/analytics/chart-view';
import { DIVERGING, OTHER_COLOR, SEQUENTIAL, SERIES_COLORS } from '@/lib/analytics/palette';
import { formatFigure, formatFigureShort, type ReportChart } from '@/lib/ai/reports';

const AXIS = { tickLine: false, axisLine: false, fontSize: 11, stroke: 'var(--muted-foreground)' } as const;
const GRID = { stroke: 'var(--border)', strokeWidth: 1 } as const;
const BAR_MAX = 24;

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

interface TipProps {
  active?: boolean;
  payload?: readonly { dataKey?: unknown; value?: unknown }[];
  label?: unknown;
}

type Row = Record<string, string | number | null>;

function keysOf(chart: ReportChart) {
  return chart.series.map((s, i) => ({ key: `s${i}`, name: s.name, color: SERIES_COLORS[i] ?? OTHER_COLOR }));
}

function rowsOf(chart: ReportChart): Row[] {
  return chart.categories.map((cat, i) => {
    const row: Row = { __cat: cat };
    chart.series.forEach((s, j) => (row[`s${j}`] = s.values[i] ?? null));
    return row;
  });
}

/** The ramp's darker end for a set of ordered bands, lightest first. The palest steps vanish on the card. */
function ordinalColors(n: number): string[] {
  const steps = SEQUENTIAL.slice(Math.max(1, SEQUENTIAL.length - n));
  return Array.from({ length: n }, (_, i) => steps[Math.min(steps.length - 1, i)]);
}

function tipFor(chart: ReportChart, keys: ReturnType<typeof keysOf>) {
  return function Tip({ active, payload, label }: TipProps) {
    if (!active || !payload?.length) return null;
    return (
      <TipBox
        title={String(label)}
        rows={payload.map((p) => {
          const k = keys.find((x) => x.key === p.dataKey) ?? keys[0];
          return { key: k.key, color: keys.length > 1 ? k.color : undefined, label: k.name, value: formatFigure(p.value as number, chart.unit) };
        })}
      />
    );
  };
}

// ── Bars ─────────────────────────────────────────────────────────────────────

function Bars({ chart, height, horizontal }: { chart: ReportChart; height: number; horizontal: boolean }) {
  const keys = keysOf(chart);
  const rows = rowsOf(chart);
  const single = keys.length === 1;
  const values = chart.stacked
    ? rows.flatMap((r) => {
        const vs = keys.map((k) => Number(r[k.key] ?? 0));
        return [vs.filter((v) => v > 0).reduce((t, v) => t + v, 0), vs.filter((v) => v < 0).reduce((t, v) => t + v, 0)];
      })
    : rows.flatMap((r) => keys.map((k) => Number(r[k.key] ?? 0)));
  const scale = niceScale(values);
  const ordinal = single && chart.ordinal ? ordinalColors(rows.length) : null;
  const colorAt = (v: number, i: number) =>
    chart.signed ? (v >= 0 ? DIVERGING.positive : DIVERGING.negative) : ordinal ? ordinal[i] : keys[0].color;
  const showLabels = single && rows.length <= 12;
  const longest = Math.max(...chart.categories.map((c) => c.length), 4);
  const labelWidth = Math.min(150, Math.max(56, longest * 6.2));
  const plotHeight = horizontal ? Math.max(height, rows.length * 26 + 36) : height;
  const short = (v: number) => formatFigureShort(v, chart.unit);

  return (
    <div>
      <Legend items={keys.map((k) => ({ label: k.name, color: k.color }))} />
      <ResponsiveContainer width="100%" height={plotHeight}>
        <BarChart
          data={rows}
          layout={horizontal ? 'vertical' : 'horizontal'}
          margin={{ top: 16, right: showLabels && horizontal ? 56 : 12, bottom: 4, left: 4 }}
          barGap={2}
          barCategoryGap="22%"
        >
          <CartesianGrid {...GRID} vertical={horizontal} horizontal={!horizontal} />
          {horizontal ? (
            <>
              <XAxis type="number" {...AXIS} domain={scale.domain} ticks={scale.ticks} tickFormatter={short} />
              <YAxis type="category" dataKey="__cat" {...AXIS} width={labelWidth} interval={0} tickFormatter={(v: string) => truncate(v, 22)} />
            </>
          ) : (
            <>
              <XAxis dataKey="__cat" {...AXIS} interval={0} tickFormatter={(v: string) => truncate(v, 14)} />
              <YAxis {...AXIS} width={52} domain={scale.domain} ticks={scale.ticks} tickFormatter={short} />
            </>
          )}
          <Tooltip content={tipFor(chart, keys)} cursor={{ fill: 'var(--muted)', opacity: 0.5 }} />
          {keys.map((k, i) => {
            const top = !chart.stacked || i === keys.length - 1;
            const radius: [number, number, number, number] = top ? (horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]) : [0, 0, 0, 0];
            return (
              <Bar
                key={k.key}
                dataKey={k.key}
                name={k.name}
                fill={k.color}
                stackId={chart.stacked ? 'stack' : undefined}
                maxBarSize={BAR_MAX}
                radius={radius}
                // The 2px gap of card colour between stacked segments.
                stroke="var(--card)"
                strokeWidth={chart.stacked ? 2 : 0}
                isAnimationActive={false}
              >
                {single && (chart.signed || ordinal) && rows.map((r, j) => <Cell key={j} fill={colorAt(Number(r[k.key] ?? 0), j)} />)}
                {showLabels && (
                  <LabelList
                    dataKey={k.key}
                    position={horizontal ? 'right' : 'top'}
                    // Text in the text colour, never the bar's — said as an
                    // attribute too, since the downloaded image reads that.
                    className="fill-foreground"
                    fill="var(--foreground)"
                    fontSize={11}
                    formatter={(v: unknown) => (v === null || v === undefined ? '' : short(Number(v)))}
                  />
                )}
              </Bar>
            );
          })}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// ── A trend ──────────────────────────────────────────────────────────────────

function Trend({ chart, height }: { chart: ReportChart; height: number }) {
  const keys = keysOf(chart);
  const rows = rowsOf(chart);
  const scale = niceScale(rows.flatMap((r) => keys.map((k) => Number(r[k.key] ?? 0))));
  const last = rows.length - 1;
  const short = (v: number) => formatFigureShort(v, chart.unit);
  const dot = (color: string) =>
    function EndDot(p: { index?: number; cx?: number; cy?: number }) {
      return p.index === last ? <circle cx={p.cx} cy={p.cy} r={4} fill={color} stroke="var(--card)" strokeWidth={2} /> : <g />;
    };
  const common = (k: (typeof keys)[number]) => ({
    dataKey: k.key,
    name: k.name,
    stroke: k.color,
    strokeWidth: 2,
    strokeLinejoin: 'round' as const,
    strokeLinecap: 'round' as const,
    dot: dot(k.color),
    activeDot: { r: 5, stroke: 'var(--card)', strokeWidth: 2 },
    isAnimationActive: false,
  });
  const axes = (
    <>
      <CartesianGrid {...GRID} vertical={false} />
      <XAxis dataKey="__cat" {...AXIS} interval="preserveStartEnd" minTickGap={20} />
      <YAxis {...AXIS} width={52} domain={scale.domain} ticks={scale.ticks} tickFormatter={short} />
      <Tooltip content={tipFor(chart, keys)} cursor={{ stroke: 'var(--muted-foreground)', strokeWidth: 1 }} />
    </>
  );

  return (
    <div>
      <Legend items={keys.map((k) => ({ label: k.name, color: k.color }))} shape="line" />
      <ResponsiveContainer width="100%" height={height}>
        {keys.length === 1 ? (
          // One series over time: an area, straight between months — a curve
          // would invent figures for days nobody recorded.
          <AreaChart data={rows} margin={{ top: 8, right: 16, bottom: 4, left: 4 }}>
            {axes}
            <Area type="linear" {...common(keys[0])} fill={keys[0].color} fillOpacity={0.1} />
          </AreaChart>
        ) : (
          <LineChart data={rows} margin={{ top: 8, right: 16, bottom: 4, left: 4 }}>
            {axes}
            {keys.map((k) => (
              <Line key={k.key} type="linear" {...common(k)} />
            ))}
          </LineChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}

// ── Parts of a whole ─────────────────────────────────────────────────────────

function Donut({ chart, height }: { chart: ReportChart; height: number }) {
  const values = chart.series[0]?.values ?? [];
  const slices = chart.categories
    .map((name, i) => ({ name, value: Number(values[i] ?? 0), fill: name === 'Other' ? OTHER_COLOR : SERIES_COLORS[i] ?? OTHER_COLOR }))
    .filter((s) => s.value > 0);
  const total = slices.reduce((t, s) => t + s.value, 0);

  return (
    <div className="@container">
      <div className="flex flex-col items-center gap-4 @[26rem]:flex-row">
        <div className="relative w-full max-w-[180px] shrink-0" style={{ height: Math.min(height, 180) }}>
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={slices} dataKey="value" nameKey="name" innerRadius="60%" outerRadius="92%" stroke="var(--card)" strokeWidth={2} isAnimationActive={false}>
                {slices.map((s) => (
                  <Cell key={s.name} fill={s.fill} />
                ))}
              </Pie>
              <Tooltip
                content={({ active, payload }: { active?: boolean; payload?: readonly { payload?: { name: string; value: number; fill: string } }[] }) => {
                  const p = payload?.[0]?.payload;
                  return active && p ? (
                    <TipBox
                      title={p.name}
                      rows={[{ key: 'v', color: p.fill, label: `${total ? ((p.value / total) * 100).toFixed(1) : 0}% of the total`, value: formatFigure(p.value, chart.unit) }]}
                    />
                  ) : null;
                }}
              />
            </PieChart>
          </ResponsiveContainer>
          <div className="pointer-events-none absolute inset-0 grid place-items-center text-center">
            <div>
              <p className="text-[11px] text-muted-foreground">Total</p>
              <p className="text-sm font-semibold">{formatFigureShort(total, chart.unit)}</p>
            </div>
          </div>
        </div>
        <ul className="w-full min-w-0 space-y-1.5 text-xs">
          {slices.map((s) => (
            <li key={s.name} className="flex items-center gap-2" title={`${s.name}: ${formatFigure(s.value, chart.unit)}`}>
              <span className="size-2.5 shrink-0 rounded-[2px]" style={{ background: s.fill }} />
              <span className="min-w-0 flex-1 truncate">{s.name}</span>
              <span className="shrink-0 font-medium tabular-nums">{formatFigureShort(s.value, chart.unit)}</span>
              <span className="w-11 shrink-0 text-right tabular-nums text-muted-foreground">
                {total ? ((s.value / total) * 100).toFixed(1) : '0.0'}%
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// ── The switch, and the table view ───────────────────────────────────────────

export function ReportChartView({ chart, height = 220, compact = false }: { chart: ReportChart; height?: number; compact?: boolean }) {
  if (!chart.categories.length || !chart.series.length) return null;
  switch (chart.kind) {
    case 'line':
      return <Trend chart={chart} height={height} />;
    case 'donut':
      return <Donut chart={chart} height={height} />;
    default:
      // Six age bands do not fit side by side in the corner panel: they lie down.
      return <Bars chart={chart} height={height} horizontal={chart.kind === 'hbar' || (compact && chart.categories.length > 4)} />;
  }
}

/** The chart's figures exactly, as a table: nothing to hover, nothing read by colour alone. */
export function ChartTable({ chart }: { chart: ReportChart }) {
  return (
    <div className="overflow-x-auto thin-scroll">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b">
            <th className="px-2 py-1.5 text-left font-medium text-muted-foreground">{chart.categoryLabel}</th>
            {chart.series.map((s) => (
              <th key={s.name} className="px-2 py-1.5 text-right font-medium text-muted-foreground">
                {s.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {chart.categories.map((cat, i) => (
            <tr key={`${cat}-${i}`} className="border-b border-border/60 last:border-0">
              <td className="max-w-56 truncate px-2 py-1.5">{cat}</td>
              {chart.series.map((s) => (
                <td key={s.name} className="px-2 py-1.5 text-right tabular-nums">
                  {formatFigure(s.values[i], chart.unit)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
