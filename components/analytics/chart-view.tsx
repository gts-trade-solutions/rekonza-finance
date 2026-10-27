'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Drawing a query result.
//
// One component per chart form, all sharing the same marks, so every chart in
// a report reads as one system:
//
//   bars       ≤24px thick, 4px rounded at the data end, square at the baseline
//   lines      2px, round joins; one end dot, ringed in the card colour
//   gaps       2px of the card colour between touching marks — never a border
//   grid       solid hairlines, horizontal only, one step off the surface
//   text       always in text colours — a series colour marks, it never writes
//   legend     present for two series or more; absent for one, whose title
//              already says what it is
//   labels     selective: a bar's tip, a line's end — never a number on every point
//   tooltips   the value leads, the name follows, keyed by a short line
//
// Labels come from people's own spreadsheets, so they are rendered as React
// text (escaped), never as HTML.
// ─────────────────────────────────────────────────────────────────────────────

import { useMemo, useState, type ReactNode } from 'react';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, LabelList, Line, LineChart, Pie, PieChart,
  ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis,
} from 'recharts';
import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';
import { GRAIN_LABELS } from '@/lib/analytics/dates';
import { formatAxis, formatHeadline, formatValue, pctChange } from '@/lib/analytics/format';
import {
  DIVERGING, MAX_SCATTER_SERIES, MAX_SERIES, OTHER_COLOR, SEQUENTIAL, SERIES_COLORS, colorsFor, sequentialStep,
} from '@/lib/analytics/palette';
import { runQuery, stableOrder } from '@/lib/analytics/query';
import type { ChartSpec, ChartType, DatasetData, Filter, NumberFormat, QueryResult } from '@/lib/analytics/types';
import { cn } from '@/lib/utils';

/**
 * How many series a chart keeps before folding the rest into "Other".
 *
 * A chart tells series apart by colour, and the palette has eight. A grid tells
 * them apart by the column heading, so a pivot of twelve months keeps all twelve.
 */
export const seriesCap = (type: ChartType) =>
  type === 'pivot' || type === 'heatmap' || type === 'table' ? 36 : type === 'scatter' ? MAX_SCATTER_SERIES : MAX_SERIES;

/** The query behind one tile. */
export const queryTile = (data: DatasetData, spec: ChartSpec, filters: Filter[] = []) =>
  runQuery(data, spec, filters, { maxSeries: seriesCap(spec.type) });

// ── Shared chrome ────────────────────────────────────────────────────────────

const AXIS = { tickLine: false, axisLine: false, fontSize: 11, stroke: 'var(--muted-foreground)' } as const;
const GRID = { stroke: 'var(--border)', strokeWidth: 1 } as const;
const BAR_MAX = 24;

/** "Revenue by Region", "Rows by Month and Channel". */
export function autoTitle(spec: ChartSpec, result: QueryResult): string {
  if (spec.title) return spec.title;
  // A headline figure is named for what it counts; its date is the trend, not a breakdown.
  if (spec.type === 'kpi') {
    return result.measures.length === 2 ? `${result.measures[0].label} against ${result.measures[1].label}` : result.measures[0].label;
  }
  const m = result.measures.map((x) => x.label).join(' and ');
  if (spec.type === 'variance' && result.measures.length === 2) {
    return `${result.measures[0].label} against ${result.measures[1].label}${result.categoryLabel ? ` by ${result.categoryLabel}` : ''}`;
  }
  if (!result.categoryLabel) return m;
  return `${m} by ${result.categoryLabel}${result.seriesLabel ? ` and ${result.seriesLabel}` : ''}`;
}

/** What Recharts hands a custom tooltip. `P` is the datum behind the hovered mark. */
interface TipProps<P = unknown> {
  active?: boolean;
  payload?: readonly { dataKey?: unknown; value?: unknown; payload?: P }[];
  label?: unknown;
}

interface TipRow {
  key: string;
  color?: string;
  label: string;
  value: string;
}

/** Values lead, names follow; a short stroke of the series colour keys each row. */
export function TipBox({ title, rows, note }: { title: string; rows: TipRow[]; note?: string }) {
  return (
    <div className="min-w-40 rounded-md border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md">
      <p className="mb-1.5 font-medium">{title}</p>
      <div className="space-y-1">
        {rows.map((r) => (
          <div key={r.key} className="flex items-center gap-2">
            {r.color && <span className="h-0.5 w-3 shrink-0 rounded-full" style={{ background: r.color }} />}
            <span className="font-semibold tabular-nums">{r.value}</span>
            <span className="truncate text-muted-foreground">{r.label}</span>
          </div>
        ))}
      </div>
      {note && <p className="mt-1.5 text-[11px] text-muted-foreground">{note}</p>}
    </div>
  );
}

/** Legend: rects for filled marks, lines for lines. Text stays in text colours. */
export function Legend({ items, shape = 'rect' }: { items: { label: string; color: string }[]; shape?: 'rect' | 'line' }) {
  if (items.length < 2) return null;
  return (
    <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" role="list">
      {items.map((it) => (
        <span key={it.label} className="flex items-center gap-1.5" role="listitem">
          <span
            className={shape === 'line' ? 'h-0.5 w-3.5 rounded-full' : 'size-2.5 rounded-[2px]'}
            style={{ background: it.color }}
          />
          <span className="max-w-40 truncate">{it.label}</span>
        </span>
      ))}
    </div>
  );
}

function Empty({ children, height }: { children: string; height: number }) {
  return (
    <div className="grid place-items-center px-6 text-center text-sm text-muted-foreground" style={{ height }}>
      {children}
    </div>
  );
}

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * A value axis on round steps — 1, 2, 2.5 or 5 of a power of ten — so a lakh
 * axis reads ₹10L, ₹20L, ₹30L and never ₹9.5L, ₹19L, ₹28.5L. Always includes
 * zero: every value axis here measures size from nothing.
 */
export function niceScale(values: number[], count = 5): { domain: [number, number]; ticks: number[] } {
  let lo = Math.min(0, ...values);
  let hi = Math.max(0, ...values);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) [lo, hi] = [0, 1];
  if (lo === hi) hi = lo + 1;
  const raw = (hi - lo) / Math.max(1, count - 1);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw * 0.999) ?? 10 * mag;
  const start = Math.floor(lo / step) * step;
  const end = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  for (let t = start; t <= end + step / 2; t += step) ticks.push(Number(t.toPrecision(12)));
  return { domain: [start, end], ticks };
}

/** Every plotted value — or, stacked, each bar's positive and negative totals. */
function plotted(result: QueryResult, stacked = false): number[] {
  const keys = seriesKeys(result);
  if (!stacked) return keys.flatMap((k) => result.values[k.m].map((c) => c[k.s])).filter((v): v is number => v !== null);
  return result.categories.flatMap((_, c) => {
    let pos = 0;
    let neg = 0;
    for (const k of keys) {
      const v = result.values[k.m][c][k.s] ?? 0;
      if (v > 0) pos += v;
      else neg += v;
    }
    return [pos, neg];
  });
}

/** The plotted series: measures, or the values of the colour field. */
function seriesKeys(result: QueryResult): { key: string; label: string; m: number; s: number }[] {
  if (result.series.length) return result.series.map((label, s) => ({ key: `s${s}`, label, m: 0, s }));
  return result.measures.map((meta, m) => ({ key: `m${m}`, label: meta.label, m, s: 0 }));
}

function rowsFor(result: QueryResult) {
  const keys = seriesKeys(result);
  return result.categories.map((cat, c) => {
    const row: Record<string, string | number | null> = { __cat: cat };
    for (const k of keys) row[k.key] = result.values[k.m][c][k.s];
    return row;
  });
}

function useSeriesColors(spec: ChartSpec, data: DatasetData, result: QueryResult) {
  return useMemo(() => {
    const keys = seriesKeys(result);
    if (result.series.length) {
      const map = colorsFor(result.series, stableOrder(data, spec.series));
      return new Map(keys.map((k) => [k.key, map.get(k.label) ?? OTHER_COLOR]));
    }
    return new Map(keys.map((k, i) => [k.key, SERIES_COLORS[i]]));
  }, [spec.series, data, result]);
}

// ── The switch ───────────────────────────────────────────────────────────────

export function ChartView({
  spec,
  result,
  data,
  filters = [],
  height = 260,
}: {
  spec: ChartSpec;
  result: QueryResult;
  data: DatasetData;
  filters?: Filter[];
  height?: number;
}) {
  if (result.rowCount === 0) return <Empty height={height}>No rows match these filters.</Empty>;
  const anyValue = result.values.some((m) => m.some((c) => c.some((v) => v !== null)));
  if (!anyValue && spec.type !== 'kpi') return <Empty height={height}>There is nothing to chart in this slice.</Empty>;

  switch (spec.type) {
    case 'kpi':
      return <KpiView spec={spec} result={result} />;
    case 'bar':
    case 'stacked':
      return <BarView spec={spec} result={result} data={data} height={height} stacked={spec.type === 'stacked'} />;
    case 'line':
    case 'area':
      return <LineView spec={spec} result={result} data={data} height={height} area={spec.type === 'area'} />;
    case 'donut':
      return <DonutView spec={spec} result={result} data={data} height={height} />;
    case 'scatter':
      return <ScatterView spec={spec} result={result} data={data} height={height} />;
    case 'heatmap':
      return <HeatmapView result={result} />;
    case 'variance':
      return <VarianceView spec={spec} result={result} height={height} />;
    case 'pivot':
      return <PivotView spec={spec} result={result} data={data} filters={filters} />;
    case 'table':
    default:
      return <ResultTable result={result} />;
  }
}

// ── Headline figure ──────────────────────────────────────────────────────────

function KpiView({ spec, result }: { spec: ChartSpec; result: QueryResult }) {
  const main = result.measures[0];
  const value = result.totals[0];
  const up = (spec.favourable ?? 'higher') === 'higher';

  // Against a second measure — "revenue against budget".
  if (result.measures.length === 2) {
    const other = result.totals[1];
    const diff = value !== null && other !== null ? value - other : null;
    const pct = pctChange(value, other);
    return (
      <div className="flex h-full flex-col justify-center gap-1 py-2">
        <p className="text-3xl font-semibold tracking-tight">{formatHeadline(value, main.format)}</p>
        <p className="text-xs text-muted-foreground">
          against {formatHeadline(other, result.measures[1].format)} {result.measures[1].label.toLowerCase()}
        </p>
        <Delta pct={pct} good={diff === null ? null : up ? diff >= 0 : diff <= 0} suffix={diff !== null ? `${diff >= 0 ? '+' : ''}${formatHeadline(diff, main.format)}` : undefined} />
      </div>
    );
  }

  // With a trend: the latest period against the one before it.
  const series = result.temporal ? result.values[0].map((c) => c[0]) : [];
  const points = series.map((v, i) => ({ i, v }));
  let latest: number | null = null;
  let prior: number | null = null;
  let latestLabel = '';
  let priorLabel = '';
  for (let i = series.length - 1; i >= 0; i--) {
    if (series[i] === null) continue;
    if (latest === null) {
      latest = series[i];
      latestLabel = result.categories[i];
    } else {
      prior = series[i];
      priorLabel = result.categories[i];
      break;
    }
  }

  return (
    <div className="flex h-full flex-col justify-between gap-2 py-1">
      <div className="space-y-1">
        <p className="text-3xl font-semibold tracking-tight">{formatHeadline(value, main.format)}</p>
        {latest !== null && prior !== null && (
          <Delta
            pct={pctChange(latest, prior)}
            good={latest === prior ? null : up ? latest > prior : latest < prior}
            suffix={`${latestLabel} against ${priorLabel}`}
          />
        )}
      </div>
      {points.length > 2 && (
        <div className="h-10" aria-hidden>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={points} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
              <Line
                dataKey="v"
                stroke="var(--viz-other)"
                strokeWidth={1.5}
                dot={(p: { index?: number; cx?: number; cy?: number }) =>
                  p.index === lastIndex(series) ? (
                    <circle key="end" cx={p.cx} cy={p.cy} r={3} fill="var(--viz-1)" stroke="var(--card)" strokeWidth={2} />
                  ) : (
                    <g key={p.index} />
                  )
                }
                isAnimationActive={false}
                connectNulls={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

const lastIndex = (xs: (number | null)[]) => {
  for (let i = xs.length - 1; i >= 0; i--) if (xs[i] !== null) return i;
  return -1;
};

/** Direction by icon and sign, then colour — colour never carries it alone. */
function Delta({ pct, good, suffix }: { pct: number | null; good: boolean | null; suffix?: string }) {
  const Icon = pct === null || pct === 0 ? Minus : pct > 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <p className="flex flex-wrap items-center gap-1 text-xs">
      <span
        className={cn(
          'inline-flex items-center gap-0.5 font-medium',
          good === null ? 'text-muted-foreground' : good ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-700 dark:text-red-400',
        )}
      >
        <Icon className="size-3.5" aria-hidden />
        {pct === null ? 'n/a' : `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`}
      </span>
      {suffix && <span className="text-muted-foreground">{suffix}</span>}
    </p>
  );
}

// ── Bars ─────────────────────────────────────────────────────────────────────

function BarView({
  spec, result, data, height, stacked,
}: { spec: ChartSpec; result: QueryResult; data: DatasetData; height: number; stacked: boolean }) {
  const keys = seriesKeys(result);
  const colors = useSeriesColors(spec, data, result);
  const rows = rowsFor(result);
  const fmt = result.measures[0].format;
  const longest = Math.max(...result.categories.map((c) => c.length));
  const horizontal =
    spec.orientation === 'horizontal' ||
    (spec.orientation !== 'vertical' && !result.temporal && (result.categories.length > 8 || longest > 14));
  const single = keys.length === 1;
  const showLabels = spec.showLabels ?? (single && horizontal && result.categories.length <= 12);
  const plotHeight = horizontal ? Math.max(height, result.categories.length * 28 + 40) : height;
  const labelWidth = Math.min(170, Math.max(56, longest * 6.4));
  const scale = niceScale(plotted(result, stacked));

  const tip = ({ active, payload, label }: TipProps) =>
    active && payload?.length ? (
      <TipBox
        title={String(label)}
        rows={payload.map((p) => {
          const k = keys.find((x) => x.key === p.dataKey)!;
          return { key: k.key, color: colors.get(k.key), label: k.label, value: formatValue(p.value as number | null, result.measures[k.m].format) };
        })}
      />
    ) : null;

  return (
    <div>
      <Legend items={keys.map((k) => ({ label: k.label, color: colors.get(k.key)! }))} />
      <ResponsiveContainer width="100%" height={plotHeight}>
        <BarChart
          data={rows}
          layout={horizontal ? 'vertical' : 'horizontal'}
          margin={{ top: 8, right: showLabels ? 56 : 12, bottom: 4, left: 4 }}
          barGap={2}
          barCategoryGap="22%"
        >
          <CartesianGrid {...GRID} vertical={horizontal} horizontal={!horizontal} />
          {horizontal ? (
            <>
              <XAxis type="number" {...AXIS} domain={scale.domain} ticks={scale.ticks} tickFormatter={(v: number) => formatAxis(v, fmt)} />
              <YAxis
                type="category"
                dataKey="__cat"
                {...AXIS}
                width={labelWidth}
                interval={0}
                tickFormatter={(v: string) => truncate(v, 24)}
              />
            </>
          ) : (
            <>
              <XAxis dataKey="__cat" {...AXIS} interval="preserveStartEnd" minTickGap={16} tickFormatter={(v: string) => truncate(v, 16)} />
              <YAxis {...AXIS} width={56} domain={scale.domain} ticks={scale.ticks} tickFormatter={(v: number) => formatAxis(v, fmt)} />
            </>
          )}
          <Tooltip content={tip} cursor={{ fill: 'var(--muted)', opacity: 0.5 }} />
          {keys.map((k, i) => {
            const top = !stacked || i === keys.length - 1;
            const radius: [number, number, number, number] = top
              ? horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]
              : [0, 0, 0, 0];
            return (
              <Bar
                key={k.key}
                dataKey={k.key}
                name={k.label}
                fill={colors.get(k.key)}
                stackId={stacked ? 'stack' : undefined}
                maxBarSize={BAR_MAX}
                radius={radius}
                // The 2px surface gap between stacked segments and adjacent bars.
                stroke="var(--card)"
                strokeWidth={stacked ? 2 : 0}
                isAnimationActive={false}
              >
                {showLabels && single && (
                  <LabelList
                    dataKey={k.key}
                    position={horizontal ? 'right' : 'top'}
                    className="fill-foreground"
                    fontSize={11}
                    formatter={(v: unknown) => (v === null || v === undefined ? '' : formatAxis(Number(v), fmt))}
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

// ── Lines and areas ──────────────────────────────────────────────────────────

function LineView({
  spec, result, data, height, area,
}: { spec: ChartSpec; result: QueryResult; data: DatasetData; height: number; area: boolean }) {
  const keys = seriesKeys(result);
  const colors = useSeriesColors(spec, data, result);
  const rows = rowsFor(result);
  const fmt = result.measures[0].format;

  // Direct end-labels only while the lines stay apart at the right edge. When
  // they converge, stacking labels detaches them from their lines — the
  // legend and the tooltip carry identity instead.
  const ends = keys
    .map((k) => {
      const col = rows.map((r) => r[k.key] as number | null);
      const i = lastIndex(col);
      return { key: k.key, label: k.label, i, v: i >= 0 ? col[i]! : null };
    })
    .filter((e) => e.v !== null);
  const values = rows.flatMap((r) => keys.map((k) => r[k.key] as number | null)).filter((v): v is number => v !== null);
  const range = values.length ? Math.max(...values) - Math.min(0, ...values) : 0;
  const sorted = [...ends].sort((a, b) => a.v! - b.v!);
  const separated = sorted.every((e, i) => i === 0 || Math.abs(e.v! - sorted[i - 1].v!) > range * 0.09);
  const endLabels = keys.length <= 4 && separated;
  const scale = niceScale(values);

  const tip = ({ active, payload, label }: TipProps) =>
    active && payload?.length ? (
      <TipBox
        title={String(label)}
        rows={keys.map((k) => {
          const p = payload.find((x) => x.dataKey === k.key);
          const v = (p?.value ?? null) as number | null;
          return { key: k.key, color: colors.get(k.key), label: k.label, value: v === null ? 'No data' : formatValue(v, result.measures[k.m].format) };
        })}
      />
    ) : null;

  const endLabel = (k: { key: string; label: string }) =>
    function EndLabel(p: { index?: number; x?: number | string; y?: number | string; value?: unknown }) {
      const e = ends.find((x) => x.key === k.key);
      if (!e || p.index !== e.i || p.x === undefined || p.y === undefined) return null;
      const text = keys.length === 1 ? formatAxis(Number(p.value), fmt) : truncate(k.label, 12);
      return (
        <text x={Number(p.x) + 8} y={Number(p.y)} dy={4} fontSize={11} className="fill-foreground">
          {text}
        </text>
      );
    };

  const Chart = area ? AreaChart : LineChart;
  return (
    <div>
      <Legend items={keys.map((k) => ({ label: k.label, color: colors.get(k.key)! }))} shape="line" />
      <ResponsiveContainer width="100%" height={height}>
        <Chart data={rows} margin={{ top: 8, right: endLabels ? 72 : 16, bottom: 4, left: 4 }}>
          <CartesianGrid {...GRID} vertical={false} />
          <XAxis dataKey="__cat" {...AXIS} interval="preserveStartEnd" minTickGap={24} />
          <YAxis {...AXIS} width={56} domain={scale.domain} ticks={scale.ticks} tickFormatter={(v: number) => formatAxis(v, fmt)} />
          <Tooltip content={tip} cursor={{ stroke: 'var(--muted-foreground)', strokeWidth: 1 }} />
          {keys.map((k) => {
            const color = colors.get(k.key)!;
            const e = ends.find((x) => x.key === k.key);
            const dot = (p: { index?: number; cx?: number; cy?: number }) =>
              e && p.index === e.i ? (
                <circle key={`end-${k.key}`} cx={p.cx} cy={p.cy} r={4} fill={color} stroke="var(--card)" strokeWidth={2} />
              ) : (
                <g key={`${k.key}-${p.index}`} />
              );
            const common = {
              dataKey: k.key,
              name: k.label,
              stroke: color,
              strokeWidth: 2,
              strokeLinejoin: 'round' as const,
              strokeLinecap: 'round' as const,
              dot,
              activeDot: { r: 5, stroke: 'var(--card)', strokeWidth: 2 },
              connectNulls: false,
              isAnimationActive: false,
            };
            return area ? (
              // Straight segments: a curve between two months invents values
              // for days nobody recorded.
              <Area key={k.key} {...common} type="linear" fill={color} fillOpacity={0.1}>
                {endLabels && <LabelList dataKey={k.key} content={endLabel(k)} />}
              </Area>
            ) : (
              <Line key={k.key} {...common} type="linear">
                {endLabels && <LabelList dataKey={k.key} content={endLabel(k)} />}
              </Line>
            );
          })}
        </Chart>
      </ResponsiveContainer>
    </div>
  );
}

// ── Donut ────────────────────────────────────────────────────────────────────

function DonutView({ spec, result, data, height }: { spec: ChartSpec; result: QueryResult; data: DatasetData; height: number }) {
  const fmt = result.measures[0].format;
  const total = result.totals[0] ?? 0;
  const colorMap = useMemo(
    () => colorsFor(result.categories, stableOrder(data, spec.category)),
    [result.categories, data, spec.category],
  );
  const slices = result.categories
    .map((cat, c) => ({ name: cat, value: result.values[0][c][0] ?? 0 }))
    .filter((s) => s.value > 0)
    .map((s) => ({ ...s, pct: total ? (s.value / total) * 100 : 0, fill: colorMap.get(s.name) ?? OTHER_COLOR }));

  // Beside the ring when the tile is wide enough, beneath it when it is not —
  // measured on the tile, not the window, since a third-width tile on a wide
  // screen is still narrow.
  return (
    <div className="@container">
    <div className="flex flex-col items-center gap-4 @[30rem]:flex-row">
      <div className="relative w-full max-w-[200px] shrink-0" style={{ height: Math.min(height, 200) }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={slices}
              dataKey="value"
              nameKey="name"
              innerRadius="60%"
              outerRadius="92%"
              stroke="var(--card)"
              strokeWidth={2}
              isAnimationActive={false}
            >
              {slices.map((s) => (
                <Cell key={s.name} fill={s.fill} />
              ))}
            </Pie>
            <Tooltip
              content={({ active, payload }: TipProps<{ name: string; value: number; pct: number; fill: string }>) => {
                const p = payload?.[0]?.payload;
                return active && p ? (
                  <TipBox title={p.name} rows={[{ key: 'v', color: p.fill, label: `${p.pct.toFixed(1)}% of the total`, value: formatValue(p.value, fmt) }]} />
                ) : null;
              }}
            />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 grid place-items-center text-center">
          <div>
            <p className="text-[11px] text-muted-foreground">Total</p>
            <p className="text-sm font-semibold">{formatHeadline(total, fmt)}</p>
          </div>
        </div>
      </div>
      {/* The legend doubles as a summary: each slice's name, size and share.
          Exact figures are one click away in the table view. */}
      <ul className="w-full min-w-0 space-y-1.5 text-xs">
        {slices.map((s) => (
          <li key={s.name} className="flex items-center gap-2" title={`${s.name}: ${formatValue(s.value, fmt)}`}>
            <span className="size-2.5 shrink-0 rounded-[2px]" style={{ background: s.fill }} />
            <span className="min-w-0 flex-1 truncate">{s.name}</span>
            <span className="shrink-0 tabular-nums font-medium">{formatAxis(s.value, fmt)}</span>
            <span className="w-11 shrink-0 text-right tabular-nums text-muted-foreground">{s.pct.toFixed(1)}%</span>
          </li>
        ))}
      </ul>
    </div>
    </div>
  );
}

// ── Scatter ──────────────────────────────────────────────────────────────────

function ScatterView({ spec, result, data, height }: { spec: ChartSpec; result: QueryResult; data: DatasetData; height: number }) {
  const [mx, my] = result.measures;
  const groups = result.series.length ? result.series.slice(0, MAX_SCATTER_SERIES) : [''];
  const colorMap = useMemo(
    () => (result.series.length ? colorsFor(groups, stableOrder(data, spec.series)) : new Map([['', SERIES_COLORS[0]]])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [result.series, data, spec.series],
  );
  const sets = groups.map((g, s) => ({
    group: g,
    color: colorMap.get(g) ?? OTHER_COLOR,
    points: result.categories
      .map((cat, c) => ({ name: cat, x: result.values[0][c][s], y: result.values[1]?.[c][s] }))
      .filter((p) => p.x !== null && p.y !== null && p.y !== undefined),
  }));

  // A visible 8px dot inside a 24px invisible hit area — nobody should have to
  // land dead-centre on a point to read it.
  const shape = (color: string) =>
    function Point(p: { cx?: number; cy?: number }) {
      return (
        <g>
          <circle cx={p.cx} cy={p.cy} r={12} fill="transparent" />
          <circle cx={p.cx} cy={p.cy} r={4.5} fill={color} stroke="var(--card)" strokeWidth={2} />
        </g>
      );
    };

  return (
    <div>
      <Legend items={sets.filter((s) => s.group).map((s) => ({ label: s.group, color: s.color }))} />
      <ResponsiveContainer width="100%" height={height}>
        <ScatterChart margin={{ top: 8, right: 16, bottom: 20, left: 4 }}>
          <CartesianGrid {...GRID} />
          <XAxis type="number" dataKey="x" name={mx.label} {...AXIS} tickFormatter={(v: number) => formatAxis(v, mx.format)}
            label={{ value: mx.label, position: 'insideBottom', offset: -12, fontSize: 11, fill: 'var(--muted-foreground)' }} />
          <YAxis type="number" dataKey="y" name={my?.label} {...AXIS} width={56} tickFormatter={(v: number) => formatAxis(v, my?.format ?? 'number')} />
          <ZAxis range={[60, 60]} />
          <Tooltip
            cursor={false}
            content={({ active, payload }: TipProps<{ name: string; x: number; y: number }>) => {
              const p = payload?.[0]?.payload;
              return active && p ? (
                <TipBox
                  title={p.name}
                  rows={[
                    { key: 'x', label: mx.label, value: formatValue(p.x, mx.format) },
                    { key: 'y', label: my.label, value: formatValue(p.y, my.format) },
                  ]}
                />
              ) : null;
            }}
          />
          {sets.map((s) => (
            <Scatter key={s.group || 'all'} data={s.points} shape={shape(s.color)} isAnimationActive={false} />
          ))}
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
}

// ── Heatmap ──────────────────────────────────────────────────────────────────

function HeatmapView({ result }: { result: QueryResult }) {
  const fmt = result.measures[0].format;
  const all = result.values[0].flat().filter((v): v is number => v !== null);
  const min = Math.min(...all);
  const max = Math.max(...all);
  return (
    <div className="space-y-2">
      <div className="overflow-x-auto">
        <table className="w-full border-separate text-xs" style={{ borderSpacing: 2 }}>
          <thead>
            <tr>
              <th className="px-2 py-1 text-left font-medium text-muted-foreground">{result.categoryLabel}</th>
              {result.series.map((s) => (
                <th key={s} className="max-w-24 truncate px-2 py-1 text-center font-medium text-muted-foreground">{s}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.categories.map((cat, c) => (
              <tr key={cat}>
                <th scope="row" className="max-w-40 truncate px-2 py-1 text-left font-normal text-muted-foreground">{cat}</th>
                {result.series.map((s, i) => {
                  const v = result.values[0][c][i];
                  const step = v === null ? -1 : sequentialStep(v, min, max);
                  return (
                    <td
                      key={s}
                      title={`${cat} · ${s}: ${formatValue(v, fmt)}`}
                      className={cn(
                        'h-8 min-w-14 rounded-[2px] px-1.5 text-center tabular-nums',
                        v === null && 'bg-muted/40 text-muted-foreground',
                        // Ink chosen by the fill's darkness, so it always clears contrast.
                        step >= 4 ? 'text-white' : 'text-foreground',
                      )}
                      style={v === null ? undefined : { background: SEQUENTIAL[step] }}
                    >
                      {v === null ? '—' : formatAxis(v, fmt)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <span className="tabular-nums">{formatAxis(min, fmt)}</span>
        <div className="flex h-2 flex-1 max-w-48 overflow-hidden rounded-[2px]">
          {SEQUENTIAL.map((c) => <span key={c} className="flex-1" style={{ background: c }} />)}
        </div>
        <span className="tabular-nums">{formatAxis(max, fmt)}</span>
      </div>
    </div>
  );
}

// ── Variance ─────────────────────────────────────────────────────────────────

function VarianceView({ spec, result, height }: { spec: ChartSpec; result: QueryResult; height: number }) {
  const [a, b] = result.measures;
  const higherIsGood = (spec.favourable ?? 'higher') === 'higher';
  const rows = result.categories
    .map((cat, c) => {
      const va = result.values[0][c][0];
      const vb = result.values[1]?.[c][0] ?? null;
      const diff = va !== null && vb !== null ? va - vb : null;
      return { __cat: cat, a: va, b: vb, diff, pct: pctChange(va, vb) };
    })
    .filter((r) => r.diff !== null);
  if (!rows.length) return <Empty height={height}>Neither value is recorded for the same categories.</Empty>;

  const extent = Math.max(...rows.map((r) => Math.abs(r.diff!)), 1);
  const good = (d: number) => (higherIsGood ? d >= 0 : d <= 0);
  const signed = (v: number, fmt: NumberFormat) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${formatAxis(Math.abs(v), fmt)}`;

  // Drawn as a grid rather than an SVG chart: the category, the bar either
  // side of zero, and the figure in its own column. Every label has a fixed
  // place, so none can land on a bar or on another label — the way a
  // management pack lays out a variance, and exactly as crisp on paper.
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-[2px]" style={{ background: DIVERGING.positive }} />
          Favourable
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-[2px]" style={{ background: DIVERGING.negative }} />
          Unfavourable
        </span>
        <span>
          {a.label} against {b.label}
          {higherIsGood ? '' : ' · lower is better'}
        </span>
      </div>
      <div role="list" className="space-y-0.5">
        {rows.map((r, i) => {
          const share = (Math.abs(r.diff!) / extent) * 50;
          const up = r.diff! >= 0;
          const color = good(r.diff!) ? DIVERGING.positive : DIVERGING.negative;
          return (
            <VarianceRow
              key={`${r.__cat}-${i}`}
              label={r.__cat}
              tip={
                <TipBox
                  title={r.__cat}
                  rows={[
                    { key: 'a', label: a.label, value: formatValue(r.a, a.format) },
                    { key: 'b', label: b.label, value: formatValue(r.b, b.format) },
                    {
                      key: 'd',
                      color,
                      label: good(r.diff!) ? 'favourable' : 'unfavourable',
                      value: `${signed(r.diff!, a.format)}${r.pct !== null ? ` (${r.pct > 0 ? '+' : ''}${r.pct.toFixed(1)}%)` : ''}`,
                    },
                  ]}
                />
              }
            >
              <div className="relative h-5">
                <span className="absolute inset-y-0 left-1/2 w-px bg-muted-foreground/60" aria-hidden />
                <span
                  className={cn('absolute top-1/2 h-3.5 -translate-y-1/2', up ? 'rounded-r-[4px]' : 'rounded-l-[4px]')}
                  style={{ left: up ? '50%' : `${50 - share}%`, width: `max(${share}%, 2px)`, background: color }}
                />
              </div>
              <span className="whitespace-nowrap text-right text-xs tabular-nums">
                {signed(r.diff!, a.format)}
                {r.pct !== null && (
                  <span className="ml-1.5 inline-block w-11 text-muted-foreground">
                    {r.pct > 0 ? '+' : r.pct < 0 ? '−' : ''}
                    {Math.abs(r.pct).toFixed(1)}%
                  </span>
                )}
              </span>
            </VarianceRow>
          );
        })}
      </div>
    </div>
  );
}

/** One variance row, with its tooltip on hover or focus. */
function VarianceRow({ label, tip, children }: { label: string; tip: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div
      role="listitem"
      tabIndex={0}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      className="relative grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)_auto] items-center gap-3 rounded-[3px] px-1 py-1 outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/25"
    >
      <span className="truncate text-right text-xs text-muted-foreground" title={label}>
        {label}
      </span>
      {children}
      {open && <div className="pointer-events-none absolute left-1/2 top-full z-20 mt-1 -translate-x-1/2 no-print">{tip}</div>}
    </div>
  );
}

// ── Tables ───────────────────────────────────────────────────────────────────

/** Every chart's table view: the same numbers, exactly, with nothing to hover. */
export function ResultTable({ result }: { result: QueryResult }) {
  const keys = seriesKeys(result);
  const showTotal = !result.series.length && result.categories.length > 1 && result.categoryLabel;
  return (
    <div className="max-h-[420px] overflow-auto">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-card">
          <tr className="border-b">
            <th className="px-2 py-1.5 text-left font-medium text-muted-foreground">{result.categoryLabel ?? ''}</th>
            {keys.map((k) => (
              <th key={k.key} className="px-2 py-1.5 text-right font-medium text-muted-foreground">{k.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.categories.map((cat, c) => (
            <tr key={`${cat}-${c}`} className="border-b border-border/60 last:border-0">
              <td className="max-w-56 truncate px-2 py-1.5">{cat}</td>
              {keys.map((k) => (
                <td key={k.key} className="px-2 py-1.5 text-right tabular-nums">
                  {formatValue(result.values[k.m][c][k.s], result.measures[k.m].format)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {showTotal && (
          <tfoot>
            <tr className="border-t font-medium">
              <td className="px-2 py-1.5">Total</td>
              {keys.map((k) => (
                <td key={k.key} className="px-2 py-1.5 text-right tabular-nums">
                  {formatValue(result.totals[k.m], result.measures[k.m].format)}
                </td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

/**
 * Rows by columns, with totals on both edges.
 *
 * The totals are queried, not added up from the cells: the total of an
 * average column is the average of its rows, and the total of a distinct count
 * is not the sum of the counts beside it.
 */
function PivotView({ spec, result, data, filters }: { spec: ChartSpec; result: QueryResult; data: DatasetData; filters: Filter[] }) {
  const fmt: NumberFormat = result.measures[0].format;
  const hasCols = result.series.length > 0;
  const seriesDate = data.columns.find((c) => c.key === spec.series?.column)?.type === 'date';
  // Each edge is its own query over the same rows. Folding ranks by the first
  // measure either way, so the rows and columns kept here are the ones the
  // grid kept, and "Other" totals what "Other" holds.
  const rowTotals = useMemo(
    () => (hasCols ? runQuery(data, { ...spec, series: null }, filters) : null),
    [hasCols, data, spec, filters],
  );
  const colTotals = useMemo(
    () =>
      hasCols
        ? runQuery(data, { ...spec, category: spec.series, series: null, limit: seriesCap('pivot'), sort: 'natural' }, filters)
        : null,
    [hasCols, data, spec, filters],
  );
  const rowTotal = (cat: string) => {
    if (!rowTotals) return null;
    const i = rowTotals.categories.indexOf(cat);
    return i < 0 ? null : rowTotals.values[0][i][0];
  };
  const colTotal = (s: string) => {
    if (!colTotals) return null;
    const i = colTotals.categories.indexOf(s);
    return i < 0 ? null : colTotals.values[0][i][0];
  };

  if (!hasCols) return <ResultTable result={result} />;

  return (
    <div className="max-h-[440px] overflow-auto">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-card">
          <tr className="border-b">
            <th className="px-2 py-1.5 text-left font-medium text-muted-foreground">
              {result.categoryLabel}{' '}
              {/* Columns of a date are periods: "Financial year", not the column's own name. */}
              <span className="font-normal">/ {seriesDate ? GRAIN_LABELS[spec.series?.grain ?? 'month'] : result.seriesLabel}</span>
            </th>
            {result.series.map((s) => (
              <th key={s} className="px-2 py-1.5 text-right font-medium text-muted-foreground">{s}</th>
            ))}
            <th className="border-l px-2 py-1.5 text-right font-medium">Total</th>
          </tr>
        </thead>
        <tbody>
          {result.categories.map((cat, c) => (
            <tr key={`${cat}-${c}`} className="border-b border-border/60 last:border-0 hover:bg-muted/40">
              <td className="max-w-56 truncate px-2 py-1.5">{cat}</td>
              {result.series.map((s, i) => (
                <td key={s} className="px-2 py-1.5 text-right tabular-nums">{formatValue(result.values[0][c][i], fmt)}</td>
              ))}
              <td className="border-l px-2 py-1.5 text-right font-medium tabular-nums">{formatValue(rowTotal(cat), fmt)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t-2 font-medium">
            <td className="px-2 py-1.5">Total</td>
            {result.series.map((s) => (
              <td key={s} className="px-2 py-1.5 text-right tabular-nums">{formatValue(colTotal(s), fmt)}</td>
            ))}
            <td className="border-l px-2 py-1.5 text-right tabular-nums">{formatValue(result.totals[0], fmt)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
