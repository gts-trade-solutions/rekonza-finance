// ─────────────────────────────────────────────────────────────────────────────
// Dates: reading them out of spreadsheets, and grouping them into periods.
//
// Two problems, both specific to the people using this.
//
// Reading. `04/05/2026` is the 4th of May in India and the 5th of April in the
// United States, and a spreadsheet does not say which. The import looks across
// the whole column for a value that settles it — a 13 or above in either
// position — and when none exists it reads day-first, as an Indian file almost
// always is, and says so on the review screen rather than deciding silently.
//
// Grouping. Finance reports by financial year, April to March. A calendar-only
// tool puts January–March in the wrong year and every quarter in the wrong
// place, so the financial year and its quarters are first-class grains here.
//
// Everything is done in UTC on plain `yyyy-mm-dd` strings, so a date never
// shifts by a day because of the time zone of the machine drawing the chart.
// ─────────────────────────────────────────────────────────────────────────────

import type { DateGrain } from './types';

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_INDEX: Record<string, number> = Object.fromEntries(
  [
    ['jan', 1], ['feb', 2], ['mar', 3], ['apr', 4], ['may', 5], ['jun', 6],
    ['jul', 7], ['aug', 8], ['sep', 9], ['sept', 9], ['oct', 10], ['nov', 11], ['dec', 12],
    ['january', 1], ['february', 2], ['march', 3], ['april', 4], ['june', 6], ['july', 7],
    ['august', 8], ['september', 9], ['october', 10], ['november', 11], ['december', 12],
  ],
);

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

export function isoFromParts(y: number, m: number, d: number): string | null {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  // Rejects 31 February and friends: the Date constructor silently rolls them over.
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** Two-digit years: 00–69 are this century, 70–99 the last. Excel's own rule. */
const fullYear = (y: number) => (y >= 100 ? y : y < 70 ? 2000 + y : 1900 + y);

/** `2026-09-11` from a JavaScript Date, reading its UTC fields. */
export function isoFromDate(d: Date): string | null {
  if (Number.isNaN(d.getTime())) return null;
  return isoFromParts(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

export type DayOrder = 'dmy' | 'mdy';

/**
 * One cell to an ISO date, or null if it is not one.
 *
 * `order` only matters for the all-numeric forms with the year last; every
 * other form is unambiguous on its own.
 */
export function parseDate(raw: string, order: DayOrder = 'dmy'): string | null {
  const s = raw.trim();
  if (!s) return null;

  // 2026-09-11, 2026/09/11, with or without a time after it.
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s].*)?$/.exec(s);
  if (m) return isoFromParts(+m[1], +m[2], +m[3]);

  // 11/09/2026, 11-09-26, 11.09.2026 — the ambiguous family.
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})(?:\s.*)?$/.exec(s);
  if (m) {
    const a = +m[1];
    const b = +m[2];
    const y = fullYear(+m[3]);
    return order === 'dmy' ? isoFromParts(y, b, a) : isoFromParts(y, a, b);
  }

  // 11-Sep-2026, 11 Sep 2026, 11-Sept-26
  m = /^(\d{1,2})[-\s/.]([A-Za-z]{3,9})[-\s/.,]+(\d{2}|\d{4})$/.exec(s);
  if (m && MONTH_INDEX[m[2].toLowerCase()]) {
    return isoFromParts(fullYear(+m[3]), MONTH_INDEX[m[2].toLowerCase()], +m[1]);
  }

  // Sep 11, 2026 / September 11 2026
  m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(s);
  if (m && MONTH_INDEX[m[1].toLowerCase()]) {
    return isoFromParts(+m[3], MONTH_INDEX[m[1].toLowerCase()], +m[2]);
  }

  // Month and year only: Sep-26, Sep 2026, September 2026. The first of the
  // month stands for the period — that is how a monthly report is labelled.
  m = /^([A-Za-z]{3,9})[-\s/.']+(\d{2}|\d{4})$/.exec(s);
  if (m && MONTH_INDEX[m[1].toLowerCase()]) {
    return isoFromParts(fullYear(+m[2]), MONTH_INDEX[m[1].toLowerCase()], 1);
  }

  return null;
}

/**
 * Settle day-first versus month-first from the whole column.
 *
 * One value with a first part above 12 proves day-first; one with a second
 * part above 12 proves month-first. With neither, it is genuinely ambiguous and
 * day-first is the assumption — reported, not hidden.
 */
export function detectDayOrder(values: string[]): { order: DayOrder; ambiguous: boolean } {
  let dayFirst = false;
  let monthFirst = false;
  for (const v of values) {
    const m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})/.exec(v.trim());
    if (!m) continue;
    if (+m[1] > 12) dayFirst = true;
    if (+m[2] > 12) monthFirst = true;
    if (dayFirst || monthFirst) break;
  }
  if (monthFirst && !dayFirst) return { order: 'mdy', ambiguous: false };
  if (dayFirst) return { order: 'dmy', ambiguous: false };
  const anyNumeric = values.some((v) => /^\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}/.test(v.trim()));
  return { order: 'dmy', ambiguous: anyNumeric };
}

// ── Periods ──────────────────────────────────────────────────────────────────

const parts = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return { y, m, d };
};

/** The financial year a date falls in, named by the year it starts. */
export function fyStartYear(iso: string, fyStartMonth = 4): number {
  const { y, m } = parts(iso);
  return m >= fyStartMonth ? y : y - 1;
}

export const fyLabel = (startYear: number, short = false) =>
  short
    ? `FY${String(startYear % 100).padStart(2, '0')}-${String((startYear + 1) % 100).padStart(2, '0')}`
    : `FY ${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;

/** ISO-8601 week: weeks start on Monday, and week 1 holds the year's first Thursday. */
function isoWeek(iso: string): { year: number; week: number } {
  const { y, m, d } = parts(iso);
  const date = new Date(Date.UTC(y, m - 1, d));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return { year: date.getUTCFullYear(), week };
}

export interface Bucket {
  /** Sorts chronologically as a plain string. */
  key: string;
  label: string;
}

/**
 * The period a date belongs to, at a grain.
 *
 * The key sorts correctly as text for every grain, which is what lets the
 * query engine order periods without parsing its own labels back.
 */
export function bucketOf(iso: string, grain: DateGrain, fyStartMonth = 4): Bucket {
  const { y, m, d } = parts(iso);
  switch (grain) {
    case 'year':
      return { key: `${y}`, label: `${y}` };
    case 'fy': {
      const fy = fyStartYear(iso, fyStartMonth);
      return { key: `${fy}`, label: fyLabel(fy) };
    }
    case 'quarter': {
      const q = Math.floor((m - 1) / 3) + 1;
      return { key: `${y}-${q}`, label: `Q${q} ${y}` };
    }
    case 'fq': {
      const fy = fyStartYear(iso, fyStartMonth);
      const q = Math.floor(((m - fyStartMonth + 12) % 12) / 3) + 1;
      return { key: `${fy}-${q}`, label: `Q${q} ${fyLabel(fy, true)}` };
    }
    case 'month':
      return { key: `${y}-${pad(m)}`, label: `${MONTHS[m - 1]} ${y}` };
    case 'week': {
      const w = isoWeek(iso);
      return { key: `${w.year}-${pad(w.week)}`, label: `W${w.week} ${w.year}` };
    }
    case 'day':
      return { key: iso, label: `${d} ${MONTHS[m - 1]} ${y}` };
  }
}

/** The first day of the period `iso` falls in. */
function periodStart(iso: string, grain: DateGrain, fyStartMonth: number): Date {
  const { y, m, d } = parts(iso);
  switch (grain) {
    case 'year':
      return new Date(Date.UTC(y, 0, 1));
    case 'fy':
      return new Date(Date.UTC(fyStartYear(iso, fyStartMonth), fyStartMonth - 1, 1));
    case 'quarter':
      return new Date(Date.UTC(y, Math.floor((m - 1) / 3) * 3, 1));
    case 'fq': {
      const offset = (m - fyStartMonth + 12) % 12;
      const startMonth0 = (fyStartMonth - 1 + Math.floor(offset / 3) * 3) % 12;
      const startYear = startMonth0 + 1 > m ? y - 1 : y;
      return new Date(Date.UTC(startYear, startMonth0, 1));
    }
    case 'month':
      return new Date(Date.UTC(y, m - 1, 1));
    case 'week': {
      const t = new Date(Date.UTC(y, m - 1, d));
      t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7));
      return t;
    }
    case 'day':
      return new Date(Date.UTC(y, m - 1, d));
  }
}

function step(t: Date, grain: DateGrain): Date {
  const n = new Date(t);
  switch (grain) {
    case 'year':
    case 'fy':
      n.setUTCFullYear(n.getUTCFullYear() + 1);
      break;
    case 'quarter':
    case 'fq':
      n.setUTCMonth(n.getUTCMonth() + 3);
      break;
    case 'month':
      n.setUTCMonth(n.getUTCMonth() + 1);
      break;
    case 'week':
      n.setUTCDate(n.getUTCDate() + 7);
      break;
    case 'day':
      n.setUTCDate(n.getUTCDate() + 1);
      break;
  }
  return n;
}

/** Past this many periods a continuous axis stops being readable. */
export const MAX_PERIODS = 400;

/**
 * Every period from the first date to the last, with none skipped.
 *
 * A trend drawn only through the months that had data puts March next to May
 * and makes a gap look like a straight line. Filling the axis is what lets a
 * missing month show as a missing month. Returns null when the span would be
 * too long to draw at this grain, so the caller can suggest a coarser one.
 */
export function periodSequence(
  minIso: string,
  maxIso: string,
  grain: DateGrain,
  fyStartMonth = 4,
): Bucket[] | null {
  const out: Bucket[] = [];
  const end = periodStart(maxIso, grain, fyStartMonth).getTime();
  for (let t = periodStart(minIso, grain, fyStartMonth); t.getTime() <= end; t = step(t, grain)) {
    out.push(bucketOf(isoFromDate(t)!, grain, fyStartMonth));
    if (out.length > MAX_PERIODS) return null;
  }
  return out;
}

/** A sensible default grain for a span of dates — about 6 to 40 points. */
export function suggestGrain(minIso: string, maxIso: string): DateGrain {
  const days = (Date.parse(`${maxIso}T00:00:00Z`) - Date.parse(`${minIso}T00:00:00Z`)) / 86_400_000;
  if (days <= 45) return 'day';
  if (days <= 200) return 'week';
  if (days <= 1200) return 'month';
  if (days <= 3000) return 'fq';
  return 'fy';
}

export const GRAIN_LABELS: Record<DateGrain, string> = {
  day: 'Day',
  week: 'Week',
  month: 'Month',
  quarter: 'Quarter (calendar)',
  fq: 'Quarter (financial year)',
  year: 'Year (calendar)',
  fy: 'Financial year',
};
