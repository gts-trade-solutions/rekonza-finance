'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Building one chart.
//
// The Tableau arrangement, because it is the one analysts already know: the
// fields on the left, the shelves they go onto in the middle, the chart on the
// right, redrawn on every change. Fields can be dragged or simply clicked —
// a click puts the field where it most likely belongs, which is right most of
// the time and never more than one more click from right.
//
// The chart type follows the data until the user picks one. "Show Me" in
// Tableau does the same: two measures in different units become a scatter, a
// date becomes a line, a budget beside an actual becomes a variance. When the
// user does pick, a type that cannot honestly draw what is on the shelves says
// why, in a sentence, instead of drawing something misleading.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState, type DragEvent, type ReactNode } from 'react';
import {
  ArrowRightLeft, CalendarDays, ChartArea, ChartBar, ChartBarStacked, ChartColumnBig, ChartLine, ChartPie,
  ChartScatter, Gauge, Grid2x2, GripVertical, Hash, IndianRupee, Percent, Search, Sigma, Sparkles, Table, Table2,
  ToggleLeft, TriangleAlert, Type, X, type LucideIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';
import { GRAIN_LABELS, suggestGrain } from '@/lib/analytics/dates';
import { AGG_LABELS, FORMAT_LABELS, defaultAggregation } from '@/lib/analytics/format';
import { columnOf, dateSpan, measureLabel, runQuery } from '@/lib/analytics/query';
import { CHART_LABELS, assessCharts } from '@/lib/analytics/recommend';
import { newTileId } from '@/lib/analytics/starter';
import type {
  Aggregation, ChartSpec, ChartType, ColumnSchema, DatasetData, DateGrain, DimensionRef, Filter, MeasureRef,
  NumberFormat, SortOrder, Tile, TileWidth,
} from '@/lib/analytics/types';
import { cn } from '@/lib/utils';
import { ChartView, ResultTable, autoTitle, queryTile, seriesCap } from './chart-view';
import { OptionSelect } from './option-select';
import { WIDTH_LABELS } from './tile-card';

const ROWS = '__rows__';
type Shelf = 'category' | 'values' | 'series';

const isNumeric = (c: ColumnSchema) => c.type === 'number' || c.type === 'currency' || c.type === 'percent';

export const CHART_ICONS: Record<ChartType, LucideIcon> = {
  kpi: Gauge,
  bar: ChartBar,
  stacked: ChartBarStacked,
  line: ChartLine,
  area: ChartArea,
  donut: ChartPie,
  variance: ArrowRightLeft,
  scatter: ChartScatter,
  heatmap: Grid2x2,
  pivot: Table2,
  table: Table,
};

function fieldIcon(c: ColumnSchema | null): LucideIcon {
  if (!c) return Sigma;
  switch (c.type) {
    case 'date':
      return CalendarDays;
    case 'boolean':
      return ToggleLeft;
    case 'currency':
      return IndianRupee;
    case 'percent':
      return Percent;
    case 'number':
      return Hash;
    default:
      return Type;
  }
}

const defaultWidth = (t: ChartType): TileWidth =>
  t === 'kpi' ? 3 : t === 'pivot' || t === 'table' || t === 'heatmap' ? 12 : t === 'line' || t === 'area' ? 8 : 6;

function blankSpec(data: DatasetData): ChartSpec {
  const money =
    data.columns.find((c) => c.role === 'measure' && c.type === 'currency') ?? data.columns.find((c) => c.role === 'measure');
  return {
    type: 'kpi',
    measures: [money ? { column: money.key, agg: defaultAggregation(money.type, 'measure') } : { column: null, agg: 'count' }],
  };
}

/** Drop what the schema does not need, so saved layouts stay small and valid. */
function clean(s: ChartSpec): ChartSpec {
  const out: ChartSpec = { type: s.type, measures: s.measures.slice(0, 2) };
  if (s.title?.trim()) out.title = s.title.trim().slice(0, 150);
  if (s.category) out.category = s.category;
  if (s.series) out.series = s.series;
  if (s.filters?.length) out.filters = s.filters;
  if (s.sort) out.sort = s.sort;
  if (s.limit) out.limit = s.limit;
  if (s.format && s.format !== 'auto') out.format = s.format;
  if (s.showLabels !== undefined) out.showLabels = s.showLabels;
  if (s.orientation && s.orientation !== 'auto') out.orientation = s.orientation;
  if (s.favourable) out.favourable = s.favourable;
  return out;
}

export function ChartBuilder({
  open,
  onOpenChange,
  data,
  filters,
  initial,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  data: DatasetData;
  filters: Filter[];
  /** The tile being edited, or null for a new one. */
  initial: Tile | null;
  onSave: (tile: Tile) => void;
}) {
  const [spec, setSpec] = useState<ChartSpec>(() => blankSpec(data));
  const [width, setWidth] = useState<TileWidth>(3);
  const [widthTouched, setWidthTouched] = useState(false);
  const [auto, setAuto] = useState(true);
  const [hint, setHint] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [asTable, setAsTable] = useState(false);
  const [over, setOver] = useState<Shelf | null>(null);

  // Start fresh each time the builder opens.
  useEffect(() => {
    if (!open) return;
    if (initial) {
      setSpec(initial.spec);
      setWidth(initial.width);
      setWidthTouched(true);
      setAuto(false);
    } else {
      setSpec(blankSpec(data));
      setWidth(3);
      setWidthTouched(false);
      setAuto(true);
    }
    setHint(null);
    setQ('');
    setAsTable(false);
  }, [open, initial, data]);

  // The type is chosen from a probe query: fit rules need to know how many
  // categories there are and whether any value is negative.
  const probe = useMemo(() => runQuery(data, { ...spec, type: 'bar' }, filters), [data, spec, filters]);
  const fits = useMemo(() => assessCharts(spec, data, probe), [spec, data, probe]);
  const best = fits.find((f) => f.recommended)?.type ?? 'table';
  const type: ChartType = auto ? best : spec.type;
  const fit = fits.find((f) => f.type === type)!;
  const effective = useMemo(() => ({ ...spec, type }), [spec, type]);
  const result = useMemo(
    () => (seriesCap(type) === seriesCap('bar') ? probe : queryTile(data, effective, filters)),
    [type, probe, data, effective, filters],
  );
  const shownWidth: TileWidth = widthTouched ? width : defaultWidth(type);

  const cat = columnOf(data, spec.category?.column);
  const temporal = cat?.type === 'date';
  const used = new Set([spec.category?.column, spec.series?.column, ...spec.measures.map((m) => m.column ?? ROWS)]);

  // ── Changing the shelves ──

  const grainFor = (c: ColumnSchema): DateGrain => {
    const s = dateSpan(data, c.key);
    return s ? suggestGrain(s.min, s.max) : 'month';
  };
  const dimFor = (c: ColumnSchema): DimensionRef => (c.type === 'date' ? { column: c.key, grain: grainFor(c) } : { column: c.key });
  const measureFor = (c: ColumnSchema | null): MeasureRef =>
    c ? { column: c.key, agg: defaultAggregation(c.type, isNumeric(c) ? c.role : 'dimension') } : { column: null, agg: 'count' };

  const update = (fn: (s: ChartSpec) => ChartSpec) => {
    setSpec(fn);
    setHint(null);
  };

  const place = (key: string, shelf: Shelf) => {
    const c = key === ROWS ? null : columnOf(data, key);
    if (key !== ROWS && !c) return; // something dragged in from outside the builder
    update((s) => {
      if (shelf === 'values') {
        const m = measureFor(c);
        if (s.measures.some((x) => x.column === m.column)) return s;
        const onlyRows = s.measures.length === 1 && s.measures[0].column === null;
        return { ...s, measures: onlyRows ? [m] : s.measures.length < 2 ? [...s.measures, m] : [s.measures[0], m] };
      }
      if (!c) return s; // "Rows" is a count, not something to split by
      const d = dimFor(c);
      if (shelf === 'category') return { ...s, category: d, series: s.series?.column === c.key ? null : s.series };
      return { ...s, series: d, category: s.category?.column === c.key ? null : s.category };
    });
  };

  /** A click puts the field where it most likely belongs. */
  const smartAdd = (key: string) => {
    if (key === ROWS) return place(key, 'values');
    const c = columnOf(data, key);
    if (!c) return;
    if (c.role === 'measure') return place(key, 'values');
    if (!spec.category) return place(key, 'category');
    if (spec.category.column === key || spec.series?.column === key) return;
    // A date goes along the axis, and what was there moves to colour — so
    // "Revenue by Region" plus Month becomes "Revenue by Month and Region".
    if (c.type === 'date' && !temporal && !spec.series) {
      update((s) => ({ ...s, category: dimFor(c), series: s.category }));
      return;
    }
    place(key, spec.series ? (c.type === 'date' ? 'category' : 'series') : 'series');
  };

  const dropProps = (shelf: Shelf) => ({
    onDragOver: (e: DragEvent) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      if (over !== shelf) setOver(shelf);
    },
    onDragLeave: () => setOver((o) => (o === shelf ? null : o)),
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      setOver(null);
      const k = e.dataTransfer.getData('text/plain');
      if (k) place(k, shelf);
    },
  });

  const pickType = (t: ChartType) => {
    const f = fits.find((x) => x.type === t)!;
    if (!f.fits) {
      setHint(`${CHART_LABELS[t]}: ${f.reason}`);
      return;
    }
    setSpec((s) => ({ ...s, type: t }));
    setAuto(false);
    setHint(null);
  };

  const save = () => {
    onSave({ id: initial?.id ?? newTileId(), width: shownWidth, spec: clean(effective) });
    onOpenChange(false);
  };

  // ── Field list ──

  const match = (c: ColumnSchema) => !q || c.label.toLowerCase().includes(q.toLowerCase());
  const dims = data.columns.filter((c) => c.role === 'dimension' && match(c));
  const meas = data.columns.filter((c) => c.role === 'measure' && match(c));

  const categoryLabel =
    type === 'kpi' ? 'Trend over' : type === 'pivot' || type === 'table' || type === 'heatmap' ? 'Rows' : type === 'scatter' ? 'One point per' : temporal ? 'Over time' : 'Category';
  const seriesLabel = type === 'pivot' || type === 'table' || type === 'heatmap' ? 'Columns' : 'Colour';
  const valuesLabel = type === 'scatter' ? 'Values · across, then up' : type === 'variance' ? 'Values · actual, then comparison' : 'Values';

  const aggOptions = (m: MeasureRef) => {
    const c = columnOf(data, m.column);
    const allowed: Aggregation[] = !c ? ['count'] : isNumeric(c) ? ['sum', 'avg', 'min', 'max', 'count', 'countd'] : ['count', 'countd'];
    return allowed.map((a) => ({ value: a, label: AGG_LABELS[a] }));
  };

  const favourableMatters = type === 'variance' || (type === 'kpi' && (spec.measures.length === 2 || temporal));
  const title = autoTitle(effective, result);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-6xl"
        data-slot="chart-builder"
      >
        <SheetHeader className="border-b pr-12">
          <SheetTitle>{initial ? 'Edit chart' : 'Add a chart'}</SheetTitle>
          <SheetDescription>
            Click a field, or drag it onto a shelf. The chart redraws as you go.
          </SheetDescription>
        </SheetHeader>

        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto md:grid-cols-[14rem_20rem_minmax(0,1fr)] md:overflow-hidden">
          {/* ── Fields ── */}
          <aside className="flex min-h-0 flex-col border-b md:border-b-0 md:border-r" aria-label="Fields">
            <div className="border-b p-3">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search fields" className="h-8 pl-7 text-xs" />
              </div>
            </div>
            <div className="max-h-64 flex-1 overflow-y-auto p-2 thin-scroll md:max-h-none">
              <FieldGroup label="Group by">
                {dims.map((c) => (
                  <FieldButton key={c.key} id={c.key} label={c.label} icon={fieldIcon(c)} used={used.has(c.key)} onAdd={smartAdd} />
                ))}
                {!dims.length && <p className="px-2 py-1 text-[11px] text-muted-foreground">None match.</p>}
              </FieldGroup>
              <FieldGroup label="Measures">
                {!q && <FieldButton id={ROWS} label="Rows (count)" icon={Sigma} used={used.has(ROWS)} onAdd={smartAdd} />}
                {meas.map((c) => (
                  <FieldButton key={c.key} id={c.key} label={c.label} icon={fieldIcon(c)} used={used.has(c.key)} onAdd={smartAdd} />
                ))}
              </FieldGroup>
            </div>
          </aside>

          {/* ── Shelves, type and options ── */}
          <div className="min-h-0 space-y-5 overflow-y-auto border-b p-4 thin-scroll md:border-b-0 md:border-r">
            <section>
              <div className="mb-2 flex items-center justify-between">
                <p className="micro-label">Chart</p>
                <button
                  type="button"
                  onClick={() => {
                    setAuto(true);
                    setHint(null);
                  }}
                  className={cn(
                    'flex items-center gap-1 rounded-[3px] px-1.5 py-0.5 text-[11px]',
                    auto ? 'bg-primary/10 font-medium text-primary' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                  )}
                  aria-pressed={auto}
                >
                  <Sparkles className="size-3" /> Automatic
                </button>
              </div>
              <div className="grid grid-cols-4 gap-1.5" role="radiogroup" aria-label="Chart type">
                {fits.map((f) => {
                  const Icon = CHART_ICONS[f.type];
                  const selected = f.type === type;
                  return (
                    <button
                      key={f.type}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      aria-disabled={!f.fits}
                      title={f.fits ? CHART_LABELS[f.type] : f.reason}
                      onClick={() => pickType(f.type)}
                      data-chart-type={f.type}
                      className={cn(
                        'relative flex flex-col items-center gap-1 rounded-[3px] border px-1 py-2 text-[10px] leading-tight transition-colors',
                        selected ? 'border-primary bg-primary/5 font-medium text-foreground' : 'hover:border-primary/40 hover:bg-accent/50',
                        !f.fits && 'border-dashed text-muted-foreground/60 hover:bg-transparent',
                      )}
                    >
                      <Icon className={cn('size-4', selected ? 'text-primary' : !f.fits ? 'opacity-50' : 'text-muted-foreground')} />
                      <span className="text-center">{CHART_LABELS[f.type]}</span>
                      {f.recommended && (
                        <span className="absolute -right-1 -top-1.5 rounded-[2px] bg-primary px-1 text-[9px] font-medium text-primary-foreground">
                          Best
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
              <p className={cn('mt-2 text-[11px] leading-relaxed', hint ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground')}>
                {hint ?? (auto ? `Automatic picks ${CHART_LABELS[best]}. ${fit.reason}` : fit.reason)}
              </p>
            </section>

            <ShelfBox label={categoryLabel} over={over === 'category'} drop={dropProps('category')}>
              {spec.category && cat ? (
                <Pill icon={fieldIcon(cat)} label={cat.label} onRemove={() => update((s) => ({ ...s, category: null }))}>
                  {cat.type === 'date' && (
                    <OptionSelect<DateGrain>
                      value={spec.category.grain ?? 'month'}
                      onChange={(g) => update((s) => ({ ...s, category: { column: s.category!.column, grain: g } }))}
                      options={Object.entries(GRAIN_LABELS).map(([value, label]) => ({ value: value as DateGrain, label }))}
                      className="h-7 w-32 text-xs"
                      label="Group dates by"
                    />
                  )}
                </Pill>
              ) : (
                <EmptyShelf>{type === 'kpi' ? 'Optional: a date, for the trend' : 'Drop a field to group by'}</EmptyShelf>
              )}
            </ShelfBox>

            <ShelfBox label={valuesLabel} over={over === 'values'} drop={dropProps('values')}>
              <div className="space-y-1.5">
                {spec.measures.map((m, i) => {
                  const c = columnOf(data, m.column);
                  return (
                    <Pill
                      key={`${m.column}-${i}`}
                      icon={fieldIcon(c)}
                      label={c ? c.label : 'Rows'}
                      title={measureLabel(m, data.columns)}
                      onRemove={
                        spec.measures.length > 1
                          ? () => update((s) => ({ ...s, measures: s.measures.filter((_, j) => j !== i) }))
                          : undefined
                      }
                    >
                      {c && (
                        <OptionSelect<Aggregation>
                          value={m.agg}
                          onChange={(agg) => update((s) => ({ ...s, measures: s.measures.map((x, j) => (j === i ? { ...x, agg } : x)) }))}
                          options={aggOptions(m)}
                          className="h-7 w-32 text-xs"
                          label={`How to combine ${c.label}`}
                        />
                      )}
                    </Pill>
                  );
                })}
                {spec.measures.length < 2 && (
                  <EmptyShelf>{type === 'variance' || type === 'scatter' ? 'Drop a second value' : 'Optional: a second value to compare'}</EmptyShelf>
                )}
              </div>
            </ShelfBox>

            <ShelfBox label={seriesLabel} over={over === 'series'} drop={dropProps('series')}>
              {spec.series && columnOf(data, spec.series.column) ? (
                <Pill
                  icon={fieldIcon(columnOf(data, spec.series.column))}
                  label={columnOf(data, spec.series.column)!.label}
                  onRemove={() => update((s) => ({ ...s, series: null }))}
                >
                  {columnOf(data, spec.series.column)!.type === 'date' && (
                    <OptionSelect<DateGrain>
                      value={spec.series.grain ?? 'fy'}
                      onChange={(g) => update((s) => ({ ...s, series: { column: s.series!.column, grain: g } }))}
                      options={Object.entries(GRAIN_LABELS).map(([value, label]) => ({ value: value as DateGrain, label }))}
                      className="h-7 w-32 text-xs"
                      label="Group dates by"
                    />
                  )}
                </Pill>
              ) : (
                <EmptyShelf>Optional: a field to split by</EmptyShelf>
              )}
            </ShelfBox>

            <section className="space-y-3 border-t pt-4">
              <p className="micro-label">Options</p>
              <label className="block space-y-1 text-[11px] text-muted-foreground">
                Title
                <Input
                  value={spec.title ?? ''}
                  onChange={(e) => setSpec((s) => ({ ...s, title: e.target.value }))}
                  placeholder={autoTitle({ ...effective, title: undefined }, result)}
                  maxLength={150}
                  className="h-8 text-xs"
                />
              </label>

              {cat && !temporal && type !== 'kpi' && (
                <div className="grid grid-cols-2 gap-2">
                  <label className="space-y-1 text-[11px] text-muted-foreground">
                    Order
                    <OptionSelect<SortOrder>
                      value={spec.sort ?? 'value-desc'}
                      onChange={(sort) => setSpec((s) => ({ ...s, sort }))}
                      options={[
                        { value: 'value-desc', label: 'Largest first' },
                        { value: 'value-asc', label: 'Smallest first' },
                        { value: 'label', label: 'A to Z' },
                        { value: 'natural', label: 'As in the data' },
                      ]}
                      className="h-8 text-xs"
                    />
                  </label>
                  <label className="space-y-1 text-[11px] text-muted-foreground">
                    Show
                    <OptionSelect<string>
                      value={String(spec.limit ?? 0)}
                      onChange={(v) => setSpec((s) => ({ ...s, limit: Number(v) || null }))}
                      options={[
                        { value: '0', label: 'All' },
                        ...[5, 10, 15, 20, 25, 50].map((n) => ({ value: String(n), label: `Top ${n}` })),
                      ]}
                      className="h-8 text-xs"
                    />
                  </label>
                </div>
              )}

              <div className="grid grid-cols-2 gap-2">
                <label className="space-y-1 text-[11px] text-muted-foreground">
                  Numbers
                  <OptionSelect<NumberFormat>
                    value={spec.format ?? 'auto'}
                    onChange={(format) => setSpec((s) => ({ ...s, format }))}
                    options={Object.entries(FORMAT_LABELS).map(([value, label]) => ({ value: value as NumberFormat, label }))}
                    className="h-8 text-xs"
                  />
                </label>
                <label className="space-y-1 text-[11px] text-muted-foreground">
                  Size on the report
                  <OptionSelect<string>
                    value={String(shownWidth)}
                    onChange={(v) => {
                      setWidth(Number(v) as TileWidth);
                      setWidthTouched(true);
                    }}
                    options={([3, 4, 6, 8, 12] as TileWidth[]).map((w) => ({ value: String(w), label: WIDTH_LABELS[w] }))}
                    className="h-8 text-xs"
                  />
                </label>
              </div>

              {(type === 'bar' || type === 'stacked') && (
                <label className="block space-y-1 text-[11px] text-muted-foreground">
                  Bars
                  <OptionSelect<'auto' | 'horizontal' | 'vertical'>
                    value={spec.orientation ?? 'auto'}
                    onChange={(orientation) => setSpec((s) => ({ ...s, orientation }))}
                    options={[
                      { value: 'auto', label: 'Automatic' },
                      { value: 'horizontal', label: 'Horizontal — long names read best' },
                      { value: 'vertical', label: 'Vertical' },
                    ]}
                    className="h-8 text-xs"
                  />
                </label>
              )}

              {favourableMatters && (
                <label className="block space-y-1 text-[11px] text-muted-foreground">
                  Which way is good
                  <OptionSelect<'higher' | 'lower'>
                    value={spec.favourable ?? 'higher'}
                    onChange={(favourable) => setSpec((s) => ({ ...s, favourable }))}
                    options={[
                      { value: 'higher', label: 'Higher is better — revenue, margin' },
                      { value: 'lower', label: 'Lower is better — cost, days overdue' },
                    ]}
                    className="h-8 text-xs"
                  />
                </label>
              )}

              {(type === 'bar' || type === 'line') && (
                <label className="flex items-center justify-between gap-3 text-xs">
                  <span>
                    Value labels
                    <span className="block text-[11px] text-muted-foreground">On bar ends, or the end of a line.</span>
                  </span>
                  <Switch checked={spec.showLabels ?? false} onCheckedChange={(v) => setSpec((s) => ({ ...s, showLabels: v }))} />
                </label>
              )}
            </section>
          </div>

          {/* ── Preview ── */}
          <div className="min-h-0 overflow-y-auto bg-muted/30 p-4 thin-scroll">
            <p className="micro-label mb-2">Preview</p>
            <div className={cn('rounded-[3px] border bg-card', type === 'kpi' && 'max-w-xs')} data-slot="builder-preview">
              <header className="flex items-start gap-2 px-4 pt-3">
                <h3 className={cn('min-w-0 flex-1 font-semibold', type === 'kpi' ? 'text-xs text-muted-foreground' : 'text-[13px]')}>{title}</h3>
                {fit.fits && type !== 'kpi' && type !== 'pivot' && type !== 'table' && (
                  <button
                    type="button"
                    onClick={() => setAsTable((v) => !v)}
                    className="grid size-7 place-items-center rounded-[3px] text-muted-foreground hover:bg-accent hover:text-foreground"
                    aria-label={asTable ? 'Show as chart' : 'Show as table'}
                    aria-pressed={asTable}
                  >
                    {asTable ? <ChartColumnBig className="size-3.5" /> : <Table2 className="size-3.5" />}
                  </button>
                )}
              </header>
              <div className="px-4 pb-4 pt-2">
                {!fit.fits ? (
                  <div className="flex flex-col items-center gap-3 px-4 py-12 text-center">
                    <TriangleAlert className="size-5 text-amber-600" />
                    <p className="max-w-sm text-sm text-muted-foreground">
                      {CHART_LABELS[type]} can’t show this. {fit.reason}
                    </p>
                    <Button size="sm" variant="outline" onClick={() => pickType(best)}>
                      Use {CHART_LABELS[best]} instead
                    </Button>
                  </div>
                ) : asTable && type !== 'kpi' ? (
                  <ResultTable result={result} />
                ) : (
                  <ChartView spec={effective} result={result} data={data} filters={filters} height={320} />
                )}
              </div>
            </div>
            <p className="mt-2 text-[11px] text-muted-foreground">
              Drawn from {result.rowCount.toLocaleString('en-IN')} rows
              {filters.length ? ', after the report’s filters' : ''}.
            </p>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t px-4 py-3">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={!fit.fits} data-slot="builder-save">
            {initial ? 'Save chart' : 'Add to report'}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ── Pieces ───────────────────────────────────────────────────────────────────

function FieldGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mb-3">
      <p className="micro-label px-2 pb-1">{label}</p>
      <div className="space-y-px">{children}</div>
    </div>
  );
}

function FieldButton({
  id, label, icon: Icon, used, onAdd,
}: { id: string; label: string; icon: LucideIcon; used: boolean; onAdd: (id: string) => void }) {
  return (
    <button
      type="button"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', id);
        e.dataTransfer.effectAllowed = 'copy';
      }}
      onClick={() => onAdd(id)}
      className={cn(
        'group flex w-full cursor-grab items-center gap-2 rounded-[3px] px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent active:cursor-grabbing',
        used && 'bg-primary/5 font-medium',
      )}
      data-slot="builder-field"
      data-field={id}
      title={`Add ${label}`}
    >
      <Icon className={cn('size-3.5 shrink-0', used ? 'text-primary' : 'text-muted-foreground')} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <GripVertical className="size-3.5 shrink-0 text-muted-foreground/0 group-hover:text-muted-foreground/60" />
    </button>
  );
}

function ShelfBox({
  label, over, drop, children,
}: {
  label: string;
  over: boolean;
  drop: { onDragOver: (e: DragEvent) => void; onDragLeave: () => void; onDrop: (e: DragEvent) => void };
  children: ReactNode;
}) {
  return (
    <section {...drop} aria-label={label} data-slot="builder-shelf">
      <p className="micro-label mb-1.5">{label}</p>
      <div className={cn('rounded-[3px] transition-shadow', over && 'ring-2 ring-primary/40 ring-offset-2 ring-offset-background')}>
        {children}
      </div>
    </section>
  );
}

function EmptyShelf({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-[3px] border border-dashed px-3 py-2.5 text-[11px] text-muted-foreground">{children}</div>
  );
}

function Pill({
  icon: Icon, label, title, onRemove, children,
}: { icon: LucideIcon; label: string; title?: string; onRemove?: () => void; children?: ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 rounded-[3px] border bg-surface py-1 pl-2 pr-1 text-xs" title={title}>
      <Icon className="size-3.5 shrink-0 text-primary" />
      <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
      {children}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="grid size-6 shrink-0 place-items-center rounded-[3px] text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label={`Remove ${label}`}
        >
          <X className="size-3" />
        </button>
      )}
    </div>
  );
}
