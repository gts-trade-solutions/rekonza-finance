// ─────────────────────────────────────────────────────────────────────────────
// The vocabulary of Analytics.
//
// Three layers, each only knowing the one below it:
//
//   a Dataset       — rows and a column schema, as imported
//   a ChartSpec     — "this measure, by this dimension, as this chart"
//   a QueryResult   — the aggregated numbers a spec produces from a dataset
//
// The spec never holds data and the result never holds layout. That is what
// lets the same spec re-run against a filtered slice, a refreshed snapshot or a
// different chart type without anything being re-imported — the same division
// Tableau makes between a data source, a viz and its query.
//
// Framework-neutral: no React, no server imports. The engine runs in the
// browser for instant feedback while building, and in tests without either.
// ─────────────────────────────────────────────────────────────────────────────

/** What a column holds. Decides parsing, formatting and the default aggregation. */
export type ColumnType = 'number' | 'currency' | 'percent' | 'date' | 'text' | 'boolean';

/**
 * Whether a column is something you *count by* or something you *add up*.
 *
 * Not the same as its type: an invoice number or a PIN code is numeric and a
 * dimension, and summing either is nonsense. The import decides this from the
 * data and the header, and the user can change it.
 */
export type ColumnRole = 'dimension' | 'measure';

export interface ColumnProfile {
  /** Non-empty distinct values. */
  distinct: number;
  /** Empty cells. */
  nulls: number;
  min?: number | string;
  max?: number | string;
  /** A few real values, shown on the review screen. */
  sample: string[];
}

export interface ColumnSchema {
  /** Stable key for specs to refer to. Survives a rename. */
  key: string;
  /** Position in each row array. */
  index: number;
  label: string;
  type: ColumnType;
  role: ColumnRole;
  /** Things the import did that the user should know about, in words. */
  notes?: string[];
  profile?: ColumnProfile;
}

/**
 * A cell, as stored. Dates are ISO `yyyy-mm-dd` strings — sortable as text,
 * free of time zones, and unambiguous in a way `12/04/2026` never is.
 */
export type Cell = string | number | boolean | null;

export interface DatasetData {
  columns: ColumnSchema[];
  rows: Cell[][];
}

// ── Chart specifications ─────────────────────────────────────────────────────

export type Aggregation = 'sum' | 'avg' | 'count' | 'countd' | 'min' | 'max';

/**
 * How a date column is grouped. `fy` and `fq` follow the Indian financial year
 * (April to March) — the period a finance team actually reports on, and one a
 * calendar-only tool gets wrong in every quarter.
 */
export type DateGrain = 'year' | 'fy' | 'quarter' | 'fq' | 'month' | 'week' | 'day';

export type ChartType =
  | 'kpi'
  | 'bar'
  | 'stacked'
  | 'line'
  | 'area'
  | 'donut'
  | 'scatter'
  | 'heatmap'
  | 'variance'
  | 'table'
  | 'pivot';

export interface DimensionRef {
  column: string;
  /** Only for date columns. */
  grain?: DateGrain;
}

export interface MeasureRef {
  /** Null counts rows — "how many invoices", with no column to add up. */
  column: string | null;
  agg: Aggregation;
  /** Overrides the generated label ("Sum of Revenue"). */
  label?: string;
}

export type FilterOp = 'in' | 'between';

export interface Filter {
  column: string;
  op: FilterOp;
  /** For `in`. `null` in the list matches blank cells. */
  values?: Cell[];
  /** For `between`: ISO dates or numbers, either end optional. */
  from?: string | number | null;
  to?: string | number | null;
}

export type NumberFormat = 'auto' | 'inr' | 'inr-compact' | 'number' | 'compact' | 'percent' | 'decimal';

export type SortOrder = 'value-desc' | 'value-asc' | 'label' | 'natural';

export interface ChartSpec {
  type: ChartType;
  title?: string;
  /** The x-axis for charts, the rows for a pivot, the trend for a KPI. */
  category?: DimensionRef | null;
  /** The colour breakdown, or a pivot's columns. At most eight survive. */
  series?: DimensionRef | null;
  /** One or two. Two only when they can honestly share one axis. */
  measures: MeasureRef[];
  /** Tile-level filters, applied after the report-wide ones. */
  filters?: Filter[];
  sort?: SortOrder;
  /** Keep the top N categories and fold the rest into "Other". */
  limit?: number | null;
  format?: NumberFormat;
  showLabels?: boolean;
  orientation?: 'auto' | 'horizontal' | 'vertical';
  /**
   * For variance and comparisons: which way is good. Revenue over budget is
   * favourable; cost over budget is not. Decides which side of the diverging
   * pair a bar takes — and the legend says "favourable", never just "blue".
   */
  favourable?: 'higher' | 'lower';
}

// ── Reports ──────────────────────────────────────────────────────────────────

/** Widths on a 12-column grid: quarter, third, half, two-thirds, full. */
export type TileWidth = 3 | 4 | 6 | 8 | 12;

export interface Tile {
  id: string;
  width: TileWidth;
  spec: ChartSpec;
}

export interface ReportLayout {
  tiles: Tile[];
}

// ── Query results ────────────────────────────────────────────────────────────

export interface MeasureMeta {
  label: string;
  format: NumberFormat;
  agg: Aggregation;
}

export interface QueryResult {
  categoryLabel: string | null;
  seriesLabel: string | null;
  measures: MeasureMeta[];
  /** In display order, after sorting, top-N and folding. */
  categories: string[];
  /** Empty when there is no series dimension. */
  series: string[];
  /**
   * `values[m][c][s]` — measure m, category c, series s. With no series the
   * last index is always 0. `null` means no rows landed there, which is not
   * the same as zero and is never drawn as zero.
   */
  values: (number | null)[][][];
  /** Per measure, across every row in the slice. */
  totals: (number | null)[];
  /** How many categories and series were folded into "Other". */
  folded: { categories: number; series: number };
  /** Rows the chart was drawn from, after filters. */
  rowCount: number;
  /** True when the category axis is time, so gaps are real and order is fixed. */
  temporal: boolean;
}

/** The label every folded tail shares. */
export const OTHER = 'Other';
/** How blank cells appear on an axis or a legend. */
export const BLANK = '(Blank)';
