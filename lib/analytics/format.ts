// ─────────────────────────────────────────────────────────────────────────────
// Numbers, written the way an Indian finance team reads them.
//
// ₹12,34,567 — lakh and crore grouping, not 1,234,567 — and on an axis, where
// space is short, ₹12.3L and ₹4.5Cr. A chart that shows "1.2M" to a room that
// thinks in lakhs makes every reader convert in their head, and some of them
// will convert it wrong.
// ─────────────────────────────────────────────────────────────────────────────

import type { Aggregation, ColumnType, NumberFormat } from './types';

const CR = 1_00_00_000;
const LAKH = 1_00_000;

const grouped = (n: number, decimals: number) =>
  n.toLocaleString('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });

/** 12.3L / 4.5Cr / 12K — Indian units, one decimal, trailing .0 dropped. */
function indianCompact(v: number): string {
  const a = Math.abs(v);
  const one = (x: number) => x.toFixed(1).replace(/\.0$/, '');
  if (a >= CR) return `${one(v / CR)}Cr`;
  if (a >= LAKH) return `${one(v / LAKH)}L`;
  if (a >= 1_000) return `${one(v / 1_000)}K`;
  return one(v);
}

/** The format a column's values should be shown in, before any override. */
export function formatForColumn(type: ColumnType | null, agg: Aggregation): NumberFormat {
  if (agg === 'count' || agg === 'countd') return 'number';
  switch (type) {
    case 'currency':
      return 'inr';
    case 'percent':
      return 'percent';
    default:
      return 'number';
  }
}

/** The sensible default aggregation for a column — a percentage is averaged, never summed. */
export function defaultAggregation(type: ColumnType | null, role: 'dimension' | 'measure'): Aggregation {
  if (role === 'dimension') return 'countd';
  return type === 'percent' ? 'avg' : 'sum';
}

/**
 * A value in full, for tooltips, tables and headline figures.
 * `null` is "no data" and is shown as a dash — never as a zero.
 */
export function formatValue(v: number | null | undefined, fmt: NumberFormat): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  switch (fmt) {
    case 'inr':
      return `${v < 0 ? '-' : ''}₹${grouped(Math.abs(v), Math.abs(v) >= 100 ? 0 : 2)}`;
    case 'inr-compact':
      return `${v < 0 ? '-' : ''}₹${indianCompact(Math.abs(v))}`;
    case 'compact':
      return indianCompact(v);
    case 'percent':
      return `${grouped(v, Math.abs(v) >= 100 ? 0 : 1)}%`;
    case 'decimal':
      return grouped(v, 2);
    case 'number':
    case 'auto':
    default:
      return grouped(v, Number.isInteger(v) ? 0 : Math.abs(v) >= 100 ? 0 : 2);
  }
}

/** The short form for an axis tick, where there is room for about six characters. */
export function formatAxis(v: number, fmt: NumberFormat): string {
  switch (fmt) {
    case 'inr':
    case 'inr-compact':
      return formatValue(v, 'inr-compact');
    case 'percent':
      return `${indianCompact(v)}%`;
    default:
      return indianCompact(v);
  }
}

/** The headline-figure form: compact for big money, full for everything else. */
export function formatHeadline(v: number | null, fmt: NumberFormat): string {
  if (v === null) return '—';
  if ((fmt === 'inr' || fmt === 'auto') && Math.abs(v) >= LAKH) return formatValue(v, 'inr-compact');
  if (fmt === 'number' && Math.abs(v) >= LAKH) return formatValue(v, 'compact');
  return formatValue(v, fmt);
}

/** Signed percentage change, or null when there is no base to compare against. */
export function pctChange(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null || previous === 0) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

export const AGG_LABELS: Record<Aggregation, string> = {
  sum: 'Sum',
  avg: 'Average',
  count: 'Count',
  countd: 'Distinct count',
  min: 'Minimum',
  max: 'Maximum',
};

/** What a column holds, in the words the review screen uses. */
export const TYPE_LABELS: Record<ColumnType, string> = {
  number: 'Number',
  currency: 'Amount (₹)',
  percent: 'Percentage',
  date: 'Date',
  text: 'Text',
  boolean: 'Yes / No',
};

export const FORMAT_LABELS: Record<NumberFormat, string> = {
  auto: 'Automatic',
  inr: 'Rupees (₹12,34,567)',
  'inr-compact': 'Rupees, short (₹12.3L)',
  number: 'Number (12,34,567)',
  compact: 'Number, short (12.3L)',
  percent: 'Percentage (12.5%)',
  decimal: 'Two decimals (1,234.50)',
};
