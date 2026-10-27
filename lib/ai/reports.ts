// ─────────────────────────────────────────────────────────────────────────────
// A detailed report: what the assistant shows under an answer.
//
// Built on the server from the same report functions the answer's figures
// came from, and never written by the model — so the chart and the table
// cannot disagree with the books, or with each other. The model writes the
// short summary above it; this carries the detail.
//
// Money is integer paise, as everywhere else in the app. The formatting lives
// here, shared, so the card, the downloaded image and the spreadsheet write a
// figure the same way.
//
// Framework-neutral: no React, no server imports.
// ─────────────────────────────────────────────────────────────────────────────

import { formatAxis, formatValue } from '../analytics/format';

export type ReportUnit = 'inr' | 'count' | 'pct' | 'days' | 'ratio';

export interface ReportKpi {
  label: string;
  /** In the unit: paise for money. Null is "no figure", shown as a dash. */
  value: number | null;
  unit: ReportUnit;
  /** Dr or Cr, after a balance. */
  side?: 'Dr' | 'Cr';
  /** A short line under the figure. */
  note?: string;
  /** The state the figure is in, when it has one. Shown with an icon and a word, never colour alone. */
  tone?: 'good' | 'warn' | 'bad';
  /** Against the comparison period. */
  change?: { pct: number | null; upIsGood: boolean; against: string };
}

export type ReportChartKind = 'bar' | 'hbar' | 'line' | 'donut';

export interface ReportChart {
  kind: ReportChartKind;
  unit: ReportUnit;
  /** What the categories are — "Days overdue", "Customer", "Month". */
  categoryLabel: string;
  categories: string[];
  series: { name: string; values: (number | null)[] }[];
  /** Series stacked on one another rather than side by side. */
  stacked?: boolean;
  /** Categories whose order means something — age bands — shaded light to dark. */
  ordinal?: boolean;
  /** Bars below zero in the opposite colour: money in against money out. */
  signed?: boolean;
}

export interface ReportColumn {
  label: string;
  /** Absent for text. */
  unit?: ReportUnit;
}

export type ReportCell = string | number | null;

export interface ReportTable {
  columns: ReportColumn[];
  rows: ReportCell[][];
  total?: ReportCell[];
  /** Rows the report has beyond those listed. */
  more?: number;
}

export interface AiReport {
  /** Unique within its answer: the lookup and its arguments. */
  key: string;
  title: string;
  /** The date or the period: "As at 15 Sep 2026". */
  subtitle: string;
  kpis: ReportKpi[];
  chart: ReportChart | null;
  table: ReportTable | null;
  /** Plain observations, worked out by rules from the same figures. */
  insights: string[];
  source: { label: string; href: string };
}

/** At most this many reports come with one answer. */
export const MAX_REPORTS_PER_ANSWER = 3;

// ── Writing figures ──────────────────────────────────────────────────────────

/** A figure in full: ₹12,34,567 · 1,234 · 12.5% · 45 days · 1.80. */
export function formatFigure(v: number | null | undefined, unit: ReportUnit): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  switch (unit) {
    case 'inr':
      return formatValue(v / 100, 'inr');
    case 'pct':
      return formatValue(v, 'percent');
    case 'days': {
      const d = Math.round(v);
      return `${d.toLocaleString('en-IN')} day${d === 1 ? '' : 's'}`;
    }
    case 'ratio':
      return v.toFixed(2);
    case 'count':
    default:
      return Math.round(v).toLocaleString('en-IN');
  }
}

/** The short form, for an axis tick or a bar's label: ₹12.3L · 45% · 1.2K. */
export function formatFigureShort(v: number, unit: ReportUnit): string {
  switch (unit) {
    case 'inr':
      return formatAxis(v / 100, 'inr');
    case 'pct':
      return formatAxis(v, 'percent');
    case 'days':
      return `${Math.round(v)}d`;
    case 'ratio':
      return v.toFixed(1);
    default:
      return formatAxis(v, 'number');
  }
}

/** A table cell as the card shows it. */
export function formatCell(v: ReportCell, unit?: ReportUnit): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'string' || !unit) return String(v);
  return formatFigure(v, unit);
}

/** "receivables-ageing-2026-09-15.png" — what a download is saved as. */
export function reportFileName(r: Pick<AiReport, 'title'>, ext: 'png' | 'csv', at = new Date()): string {
  const slug = r.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  const day = new Date(at.getTime() + 330 * 60_000).toISOString().slice(0, 10);
  return `rekonza-${slug || 'report'}-${day}.${ext}`;
}
