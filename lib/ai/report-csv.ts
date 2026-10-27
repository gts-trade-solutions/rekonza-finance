// ─────────────────────────────────────────────────────────────────────────────
// A report as a spreadsheet.
//
// Every figure in full — rupees to the paisa, not the rounded figure the card
// shows — so what is downloaded can be added up and checked. It opens in Excel
// with the rupee sign intact, because a byte-order mark says it is UTF-8. And
// text that begins like a formula is written as text: a customer whose name
// starts with "=" is a name in the sheet, never a formula that runs.
//
// Framework-neutral, so the tests read exactly what the browser writes.
// ─────────────────────────────────────────────────────────────────────────────

import type { AiReport, ReportCell, ReportUnit } from './reports';

const BOM = String.fromCharCode(0xfeff);
const FORMULA_START = new Set(['=', '+', '-', '@']);

/** Text a spreadsheet would read as a formula, prefixed so it stays text. */
export function safeText(s: string): string {
  const first = s.charCodeAt(0);
  return FORMULA_START.has(s[0]) || first === 9 || first === 13 ? `'${s}` : s;
}

/** A figure for a spreadsheet: rupees with two decimals, a percentage as a plain number. */
function figure(v: ReportCell, unit?: ReportUnit): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return safeText(v);
  switch (unit) {
    case 'inr':
      return (v / 100).toFixed(2);
    case 'pct':
      return v.toFixed(1);
    case 'ratio':
      return v.toFixed(2);
    default:
      return String(Math.round(v * 100) / 100);
  }
}

function unitWord(unit: ReportUnit, side?: 'Dr' | 'Cr'): string {
  switch (unit) {
    case 'inr':
      return side ? `INR ${side}` : 'INR';
    case 'pct':
      return '%';
    case 'days':
      return 'days';
    case 'ratio':
      return 'ratio';
    default:
      return '';
  }
}

/** Quoted when it holds a comma, a quote or a line break; quotes doubled. */
function cell(s: string): string {
  return /[",]/.test(s) || s.includes('\n') || s.includes(String.fromCharCode(13)) ? `"${s.replace(/"/g, '""')}"` : s;
}

export interface CsvMeta {
  orgName: string;
  generatedAt: Date;
  /** The site's address, so the source in the sheet can be opened. */
  origin?: string;
}

export function reportToCsv(r: AiReport, meta: CsvMeta): string {
  const lines: string[] = [];
  const row = (cells: string[]) => lines.push(cells.map(cell).join(','));
  const gap = () => lines.push('');

  row(['REKONZA AI report']);
  row([safeText(r.title)]);
  row([safeText(r.subtitle)]);
  row(['Organisation', safeText(meta.orgName)]);
  row(['Generated', meta.generatedAt.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })]);
  row(['Source', `${r.source.label} — ${meta.origin ?? ''}${r.source.href}`]);
  row(['Amounts', 'Indian rupees, to the paisa']);
  gap();

  if (r.kpis.length) {
    row(['Key figures']);
    row(['Figure', 'Value', 'Unit', 'Note']);
    for (const k of r.kpis) row([safeText(k.label), figure(k.value, k.unit), unitWord(k.unit, k.side), safeText(k.note ?? '')]);
    gap();
  }

  const t = r.table;
  if (t) {
    row(['Detail']);
    row(t.columns.map((c) => safeText(c.label)));
    for (const values of t.rows) row(values.map((v, i) => figure(v, t.columns[i]?.unit)));
    if (t.total) row(t.total.map((v, i) => figure(v, t.columns[i]?.unit)));
    if (t.more) row([`${t.more} more not listed — open the report in the app for all of them`]);
    gap();
  }

  const c = r.chart;
  if (c) {
    row(['Chart data']);
    row([safeText(c.categoryLabel), ...c.series.map((s) => safeText(s.name))]);
    c.categories.forEach((cat, i) => row([safeText(cat), ...c.series.map((s) => figure(s.values[i], c.unit))]));
    gap();
  }

  if (r.insights.length) {
    row(['Observations']);
    for (const note of r.insights) row([safeText(note)]);
  }

  return BOM + lines.join('\n');
}
