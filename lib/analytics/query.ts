// ─────────────────────────────────────────────────────────────────────────────
// The query engine: a chart specification in, aggregated numbers out.
//
// Every chart, table and headline figure in Analytics is drawn from what this
// returns, so the numbers on one tile can never disagree with another built
// from the same slice.
//
// Three things it is careful about, because each is a real way for a
// dashboard to lie:
//
//   "Other" is re-aggregated from the rows, never summed from the results.
//   The average of the folded categories is not the average of their
//   averages, and a distinct count is not the sum of distinct counts.
//
//   Missing periods stay missing. A time axis is filled end to end, so a month
//   with no rows shows as a gap rather than March sitting next to May.
//
//   No data is null, not zero. "No sales recorded" and "sales of ₹0" are
//   different facts, and only one of them is drawn at the baseline.
// ─────────────────────────────────────────────────────────────────────────────

import { bucketOf, periodSequence } from './dates';
import { AGG_LABELS, formatForColumn } from './format';
import { MAX_SERIES } from './palette';
import {
  BLANK, OTHER,
  type Cell, type ChartSpec, type ColumnSchema, type DatasetData, type DimensionRef, type Filter,
  type MeasureMeta, type MeasureRef, type QueryResult,
} from './types';

export interface QueryOptions {
  /** 4 is April — the Indian financial year. */
  fyStartMonth?: number;
  /** Fewer than eight for scatter, where every pair of colours must separate. */
  maxSeries?: number;
}

// Sentinel keys that can never collide with a real value and sort last.
const BLANK_KEY = '\uffff\u0001blank';
const OTHER_KEY = '\uffff\u0002other';

// ── Columns ──────────────────────────────────────────────────────────────────

export function columnOf(data: DatasetData, key: string | null | undefined): ColumnSchema | null {
  if (!key) return null;
  return data.columns.find((c) => c.key === key) ?? null;
}

/** "Revenue", "Average Discount %", "Distinct Customer", "Rows". */
export function measureLabel(m: MeasureRef, columns: ColumnSchema[]): string {
  if (m.label) return m.label;
  if (m.column === null) return 'Rows';
  const col = columns.find((c) => c.key === m.column);
  const name = col?.label ?? m.column;
  switch (m.agg) {
    case 'sum':
      return name;
    case 'avg':
      return `Average ${name}`;
    case 'count':
      return `Count of ${name}`;
    case 'countd':
      return `Distinct ${name}`;
    case 'min':
      return `Lowest ${name}`;
    case 'max':
      return `Highest ${name}`;
  }
}

export function measureMeta(m: MeasureRef, spec: ChartSpec, columns: ColumnSchema[]): MeasureMeta {
  const col = m.column ? columns.find((c) => c.key === m.column) ?? null : null;
  const format = spec.format && spec.format !== 'auto' ? spec.format : formatForColumn(col?.type ?? null, m.column ? m.agg : 'count');
  return { label: measureLabel(m, columns), format, agg: m.column ? m.agg : 'count' };
}

// ── Filters ──────────────────────────────────────────────────────────────────

const cellKey = (c: Cell): string => (c === null ? BLANK_KEY : typeof c === 'boolean' ? (c ? 'true' : 'false') : String(c));

type Predicate = (row: Cell[]) => boolean;

function compile(data: DatasetData, filters: Filter[]): Predicate[] {
  const out: Predicate[] = [];
  for (const f of filters) {
    const col = columnOf(data, f.column);
    if (!col) continue; // a filter on a column that no longer exists filters nothing
    const i = col.index;

    if (f.op === 'in') {
      if (!f.values) continue;
      const allowed = new Set(f.values.map(cellKey));
      out.push((r) => allowed.has(cellKey(r[i])));
      continue;
    }

    const numeric = col.type === 'number' || col.type === 'currency' || col.type === 'percent';
    const lo = f.from === null || f.from === undefined || f.from === '' ? null : numeric ? Number(f.from) : String(f.from);
    const hi = f.to === null || f.to === undefined || f.to === '' ? null : numeric ? Number(f.to) : String(f.to);
    if (lo === null && hi === null) continue;
    out.push((r) => {
      const v = r[i];
      if (v === null || typeof v === 'boolean') return false;
      if (lo !== null && v < lo) return false;
      if (hi !== null && v > hi) return false;
      return true;
    });
  }
  return out;
}

export function applyFilters(data: DatasetData, filters: Filter[]): Cell[][] {
  const preds = compile(data, filters);
  if (!preds.length) return data.rows;
  return data.rows.filter((r) => preds.every((p) => p(r)));
}

// ── Grouping ─────────────────────────────────────────────────────────────────

interface Keyed {
  key: string;
  label: string;
}

function keyer(data: DatasetData, dim: DimensionRef | null | undefined, fyStartMonth: number) {
  const col = columnOf(data, dim?.column);
  if (!col) return null;
  const i = col.index;
  const grain = col.type === 'date' ? dim?.grain ?? 'month' : undefined;
  return {
    col,
    grain,
    of(row: Cell[]): Keyed {
      const v = row[i];
      if (v === null || v === '') return { key: BLANK_KEY, label: BLANK };
      if (grain && typeof v === 'string') return bucketOf(v, grain, fyStartMonth);
      if (typeof v === 'boolean') return { key: v ? 'true' : 'false', label: v ? 'Yes' : 'No' };
      const s = String(v);
      return { key: s, label: s };
    },
  };
}

// ── Aggregation ──────────────────────────────────────────────────────────────

interface Acc {
  sum: number;
  n: number;
  min: number;
  max: number;
  set: Set<string> | null;
}

const newAcc = (m: MeasureRef): Acc => ({
  sum: 0, n: 0, min: Infinity, max: -Infinity, set: m.column && m.agg === 'countd' ? new Set() : null,
});

function feed(acc: Acc, m: MeasureRef, cell: Cell) {
  if (m.column === null) {
    acc.n++;
    return;
  }
  if (cell === null) return;
  switch (m.agg) {
    case 'count':
      acc.n++;
      return;
    case 'countd':
      acc.set!.add(cellKey(cell));
      return;
    default:
      if (typeof cell !== 'number') return;
      acc.sum += cell;
      acc.n++;
      if (cell < acc.min) acc.min = cell;
      if (cell > acc.max) acc.max = cell;
  }
}

function read(acc: Acc | undefined, m: MeasureRef): number | null {
  if (!acc) return null;
  if (m.column === null || m.agg === 'count') return acc.n;
  if (m.agg === 'countd') return acc.set!.size;
  if (acc.n === 0) return null;
  switch (m.agg) {
    case 'sum':
      return acc.sum;
    case 'avg':
      return acc.sum / acc.n;
    case 'min':
      return acc.min;
    case 'max':
      return acc.max;
  }
  return null;
}

function aggregate(
  rows: Cell[][],
  measures: MeasureRef[],
  columns: ColumnSchema[],
  groupOf: (row: Cell[]) => string,
): Map<string, number | null>[] {
  const idx = measures.map((m) => (m.column ? columns.find((c) => c.key === m.column)?.index ?? -1 : -1));
  const accs = measures.map(() => new Map<string, Acc>());
  for (const row of rows) {
    const g = groupOf(row);
    measures.forEach((m, k) => {
      let a = accs[k].get(g);
      if (!a) accs[k].set(g, (a = newAcc(m)));
      feed(a, m, idx[k] >= 0 ? row[idx[k]] : null);
    });
  }
  return measures.map((m, k) => {
    const out = new Map<string, number | null>();
    for (const [g, a] of accs[k]) out.set(g, read(a, m));
    return out;
  });
}

// ── Ordering ─────────────────────────────────────────────────────────────────

const labelCompare = (a: string, b: string) => a.localeCompare(b, 'en-IN', { numeric: true, sensitivity: 'base' });

/** Normal keys first, then (Blank), then Other — whatever the sort. */
const tailRank = (k: string) => (k === OTHER_KEY ? 2 : k === BLANK_KEY ? 1 : 0);

/** Period keys sort as text into time order ("2025-04" before "2025-05"). */
const chrono = (a: string, b: string) => tailRank(a) - tailRank(b) || (a < b ? -1 : a > b ? 1 : 0);

function rank(keys: string[], by: Map<string, number | null>, dir: 1 | -1): string[] {
  return keys.slice().sort((a, b) => {
    const t = tailRank(a) - tailRank(b);
    if (t) return t;
    const va = by.get(a);
    const vb = by.get(b);
    if (va == null && vb == null) return labelCompare(a, b);
    if (va == null) return 1;
    if (vb == null) return -1;
    // Ties break alphabetically, so the order never depends on which row
    // happened to arrive first — the same data always draws the same chart.
    return (va - vb) * dir || labelCompare(a, b);
  });
}

// ── The query ────────────────────────────────────────────────────────────────

export function runQuery(
  data: DatasetData,
  spec: ChartSpec,
  reportFilters: Filter[] = [],
  opts: QueryOptions = {},
): QueryResult {
  const fy = opts.fyStartMonth ?? 4;
  const maxSeries = opts.maxSeries ?? MAX_SERIES;
  const measures: MeasureRef[] = spec.measures.length ? spec.measures : [{ column: null, agg: 'count' }];
  const metas = measures.map((m) => measureMeta(m, spec, data.columns));

  const rows = applyFilters(data, [...reportFilters, ...(spec.filters ?? [])]);
  const cat = keyer(data, spec.category, fy);
  const ser = keyer(data, spec.series, fy);
  const temporal = !!cat?.grain;

  const labels = new Map<string, string>([[BLANK_KEY, BLANK], [OTHER_KEY, OTHER]]);
  const catOf = (r: Cell[]) => {
    if (!cat) return 'all';
    const k = cat.of(r);
    labels.set(k.key, k.label);
    return k.key;
  };
  const serOf = (r: Cell[]) => {
    if (!ser) return 'all';
    const k = ser.of(r);
    labels.set(`s:${k.key}`, k.label);
    return k.key;
  };

  // Pass 1 — rank categories and series by the first measure, to decide what
  // survives and what folds. Ranking is done on the filtered slice: the top
  // ten of a filtered view are the top ten of what is on screen.
  const primary = [measures[0]];
  const catRank = aggregate(rows, primary, data.columns, catOf)[0];
  const serRank = ser ? aggregate(rows, primary, data.columns, serOf)[0] : new Map<string, number | null>();

  let keepCat: Set<string> | null = null;
  const limit = spec.limit && spec.limit > 0 ? spec.limit : null;
  if (cat && !temporal && limit && catRank.size > limit) {
    keepCat = new Set(rank([...catRank.keys()].filter((k) => k !== BLANK_KEY), catRank, -1).slice(0, limit));
  }
  let keepSer: Set<string> | null = null;
  if (ser && serRank.size > maxSeries) {
    const real = [...serRank.keys()].filter((k) => k !== BLANK_KEY);
    // Periods keep the most recent, not the largest: a pivot of the eight
    // biggest months, out of order, answers nobody's question.
    keepSer = new Set(ser.grain ? real.sort(chrono).slice(-maxSeries) : rank(real, serRank, -1).slice(0, maxSeries));
  }

  const foldCat = (k: string) => (keepCat && k !== BLANK_KEY && !keepCat.has(k) ? OTHER_KEY : k);
  const foldSer = (k: string) => (keepSer && k !== BLANK_KEY && !keepSer.has(k) ? OTHER_KEY : k);

  // Pass 2 — aggregate once, from the rows, with the folded keys. This is the
  // step that keeps "Other" honest for averages and distinct counts.
  const SEP = '\u0000';
  const cells = aggregate(rows, measures, data.columns, (r) => `${foldCat(catOf(r))}${SEP}${foldSer(serOf(r))}`);
  const byCat = aggregate(rows, primary, data.columns, (r) => foldCat(catOf(r)))[0];
  const bySer = ser ? aggregate(rows, primary, data.columns, (r) => foldSer(serOf(r)))[0] : null;

  // Categories, in display order.
  let catKeys: string[];
  if (!cat) catKeys = ['all'];
  else if (temporal) {
    const real = [...byCat.keys()].filter((k) => k !== BLANK_KEY);
    const dates = rows.map((r) => r[cat.col.index]).filter((v): v is string => typeof v === 'string').sort();
    const seq = dates.length ? periodSequence(dates[0], dates[dates.length - 1], cat.grain!, fy) : null;
    if (seq) {
      for (const b of seq) labels.set(b.key, b.label);
      catKeys = seq.map((b) => b.key);
    } else catKeys = real.sort();
    if (byCat.has(BLANK_KEY)) catKeys.push(BLANK_KEY);
  } else {
    const keys = [...byCat.keys()];
    switch (spec.sort ?? 'value-desc') {
      case 'value-asc':
        catKeys = rank(keys, byCat, 1);
        break;
      case 'label':
        catKeys = keys.sort((a, b) => tailRank(a) - tailRank(b) || labelCompare(labels.get(a)!, labels.get(b)!));
        break;
      case 'natural':
        catKeys = keys.sort((a, b) => tailRank(a) - tailRank(b));
        break;
      default:
        catKeys = rank(keys, byCat, -1);
    }
  }

  // Series, largest first so the legend reads in order of weight — except
  // periods, which read in time order: FY 2024-25 before FY 2025-26, always.
  const serKeys = ser && bySer ? (ser.grain ? [...bySer.keys()].sort(chrono) : rank([...bySer.keys()], bySer, -1)) : ['all'];

  const values = measures.map((_, k) =>
    catKeys.map((c) => serKeys.map((s) => (cells[k].has(`${c}${SEP}${s}`) ? cells[k].get(`${c}${SEP}${s}`)! : null))),
  );

  const totals = aggregate(rows, measures, data.columns, () => 'all').map((m) => m.get('all') ?? null);

  return {
    categoryLabel: cat ? cat.col.label : null,
    seriesLabel: ser ? ser.col.label : null,
    measures: metas,
    categories: cat ? catKeys.map((k) => labels.get(k) ?? k) : ['Total'],
    series: ser ? serKeys.map((k) => labels.get(`s:${k}`) ?? labels.get(k) ?? k) : [],
    values,
    totals,
    folded: {
      categories: keepCat ? catRank.size - keepCat.size : 0,
      series: keepSer ? serRank.size - keepSer.size : 0,
    },
    rowCount: rows.length,
    temporal,
  };
}

// ── For the rest of the UI ───────────────────────────────────────────────────

/**
 * A dimension's values across the whole dataset, most frequent first. This is
 * the order colours are handed out in, and it is taken from the unfiltered
 * data on purpose — see `colorsFor`.
 */
export function stableOrder(data: DatasetData, dim: DimensionRef | null | undefined, fyStartMonth = 4): string[] {
  const k = keyer(data, dim, fyStartMonth);
  if (!k) return [];
  const counts = new Map<string, { label: string; n: number }>();
  for (const r of data.rows) {
    const { key, label } = k.of(r);
    const e = counts.get(key);
    if (e) e.n++;
    else counts.set(key, { label, n: 1 });
  }
  return [...counts.values()].sort((a, b) => b.n - a.n || labelCompare(a.label, b.label)).map((e) => e.label);
}

/** The values a filter can choose from, with how many rows each has. */
export function distinctValues(
  data: DatasetData,
  columnKey: string,
  cap = 500,
): { value: Cell; label: string; count: number }[] {
  const col = columnOf(data, columnKey);
  if (!col) return [];
  const m = new Map<string, { value: Cell; label: string; count: number }>();
  for (const r of data.rows) {
    const v = r[col.index];
    const key = cellKey(v);
    const e = m.get(key);
    if (e) e.count++;
    else m.set(key, { value: v, label: v === null ? BLANK : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v), count: 1 });
  }
  return [...m.values()].sort((a, b) => b.count - a.count || labelCompare(a.label, b.label)).slice(0, cap);
}

/** The earliest and latest date in a column, for the date filter's bounds. */
export function dateSpan(data: DatasetData, columnKey: string): { min: string; max: string } | null {
  const col = columnOf(data, columnKey);
  if (!col || col.type !== 'date') return null;
  let min: string | null = null;
  let max: string | null = null;
  for (const r of data.rows) {
    const v = r[col.index];
    if (typeof v !== 'string') continue;
    if (min === null || v < min) min = v;
    if (max === null || v > max) max = v;
  }
  return min && max ? { min, max } : null;
}

export { AGG_LABELS };
