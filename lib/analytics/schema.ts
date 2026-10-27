// ─────────────────────────────────────────────────────────────────────────────
// What the API accepts.
//
// Report layouts and chart specs come from the browser, so they are validated
// on the way in like anything else a user sends. Datasets are checked by hand
// rather than through zod: a schema library walking fifty thousand rows cell by
// cell is slow for no gain, and the rules for a row are short.
// ─────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';
import { MAX_COLUMNS, MAX_ROWS } from './infer';
import type { Cell, ColumnSchema } from './types';

const key = z.string().trim().min(1).max(20);

const Dimension = z.object({
  column: key,
  grain: z.enum(['year', 'fy', 'quarter', 'fq', 'month', 'week', 'day']).optional(),
});

const Measure = z.object({
  column: key.nullable(),
  agg: z.enum(['sum', 'avg', 'count', 'countd', 'min', 'max']),
  label: z.string().trim().max(80).optional(),
});

const CellValue = z.union([z.string().max(500), z.number(), z.boolean(), z.null()]);

export const FilterSchema = z.object({
  column: key,
  op: z.enum(['in', 'between']),
  values: z.array(CellValue).max(1000).optional(),
  from: z.union([z.string().max(40), z.number(), z.null()]).optional(),
  to: z.union([z.string().max(40), z.number(), z.null()]).optional(),
});

export const ChartSpecSchema = z.object({
  type: z.enum(['kpi', 'bar', 'stacked', 'line', 'area', 'donut', 'scatter', 'heatmap', 'variance', 'table', 'pivot']),
  title: z.string().trim().max(150).optional(),
  category: Dimension.nullable().optional(),
  series: Dimension.nullable().optional(),
  // Two at most: the one-axis rule means a third would need a third scale.
  measures: z.array(Measure).min(1).max(2),
  filters: z.array(FilterSchema).max(20).optional(),
  sort: z.enum(['value-desc', 'value-asc', 'label', 'natural']).optional(),
  limit: z.number().int().min(1).max(100).nullable().optional(),
  format: z.enum(['auto', 'inr', 'inr-compact', 'number', 'compact', 'percent', 'decimal']).optional(),
  showLabels: z.boolean().optional(),
  orientation: z.enum(['auto', 'horizontal', 'vertical']).optional(),
  favourable: z.enum(['higher', 'lower']).optional(),
});

export const TileSchema = z.object({
  id: z.string().trim().min(1).max(40),
  width: z.union([z.literal(3), z.literal(4), z.literal(6), z.literal(8), z.literal(12)]),
  spec: ChartSpecSchema,
});

export const LayoutSchema = z.object({
  tiles: z.array(TileSchema).max(40),
});

export const ReportFiltersSchema = z.array(FilterSchema).max(20);

export const ColumnSchemaSchema = z.object({
  key,
  index: z.number().int().min(0).max(MAX_COLUMNS),
  label: z.string().trim().min(1).max(80),
  type: z.enum(['number', 'currency', 'percent', 'date', 'text', 'boolean']),
  role: z.enum(['dimension', 'measure']),
  notes: z.array(z.string().max(300)).max(10).optional(),
  profile: z
    .object({
      distinct: z.number().int().min(0),
      nulls: z.number().int().min(0),
      min: z.union([z.number(), z.string().max(40)]).optional(),
      max: z.union([z.number(), z.string().max(40)]).optional(),
      sample: z.array(z.string().max(200)).max(10),
    })
    .optional(),
});

/** Largest payload accepted, as JSON. Enough for 50,000 rows of a dozen columns. */
export const MAX_DATASET_BYTES = 12 * 1024 * 1024;

/**
 * Check rows against their schema, in one pass. Returns the problem, or null.
 *
 * Each cell must match its column: numbers are finite numbers, dates are ISO
 * `yyyy-mm-dd`, yes/no is a boolean, text is a string of sane length — and
 * any cell may be empty.
 */
export function checkRows(columns: ColumnSchema[], rows: unknown): string | null {
  if (!Array.isArray(rows)) return 'Rows must be a list.';
  if (rows.length > MAX_ROWS) return `At most ${MAX_ROWS.toLocaleString('en-IN')} rows can be stored.`;
  const n = columns.length;
  const ISO = /^\d{4}-\d{2}-\d{2}$/;
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    if (!Array.isArray(row) || row.length !== n) return `Row ${r + 1} has ${Array.isArray(row) ? row.length : 0} cells; expected ${n}.`;
    for (let c = 0; c < n; c++) {
      const v = row[c] as Cell;
      if (v === null) continue;
      switch (columns[c].type) {
        case 'number':
        case 'currency':
        case 'percent':
          if (typeof v !== 'number' || !Number.isFinite(v)) return `Row ${r + 1}, "${columns[c].label}": not a number.`;
          break;
        case 'date':
          if (typeof v !== 'string' || !ISO.test(v)) return `Row ${r + 1}, "${columns[c].label}": not a date.`;
          break;
        case 'boolean':
          if (typeof v !== 'boolean') return `Row ${r + 1}, "${columns[c].label}": not yes/no.`;
          break;
        case 'text':
          if (typeof v !== 'string' || v.length > 500) return `Row ${r + 1}, "${columns[c].label}": text too long.`;
          break;
      }
    }
  }
  return null;
}
