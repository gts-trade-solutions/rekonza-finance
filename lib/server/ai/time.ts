// ─────────────────────────────────────────────────────────────────────────────
// Dates as they are in India.
//
// "Today" for a question asked at 1 a.m. in Chennai is not the UTC date, which
// is still yesterday until 5:30 a.m. — and "what is our cash today" answered
// for yesterday is a wrong answer that looks right. The server may run in any
// time zone, so everything here works from the instant and a fixed +05:30
// offset (India has no daylight saving).
//
// Pure functions, no server imports.
// ─────────────────────────────────────────────────────────────────────────────

const IST_OFFSET_MS = 330 * 60_000;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 'YYYY-MM-DD' for the Indian calendar date at an instant. */
export function istDate(at: Date = new Date()): string {
  return new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** The instant the next Indian day begins. */
export function istMidnightAfter(at: Date = new Date()): Date {
  const [y, m, d] = istDate(at).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1) - IST_OFFSET_MS);
}

/** The instant the current Indian calendar month began. */
export function istMonthStart(at: Date = new Date()): Date {
  const [y, m] = istDate(at).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1) - IST_OFFSET_MS);
}

/** First day of the financial year a date falls in — April, unless told otherwise. */
export function fyStartOf(date: string, startMonth = 4): string {
  const [y, m] = date.split('-').map(Number);
  const year = m >= startMonth ? y : y - 1;
  return `${year}-${String(startMonth).padStart(2, '0')}-01`;
}

/** 'FY 2026-27' for any date inside it. */
export function fyLabelOf(date: string, startMonth = 4): string {
  const start = Number(fyStartOf(date, startMonth).slice(0, 4));
  return `FY ${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/** 'YYYY-MM' of the month before the one a date falls in. */
export function previousMonth(date: string): string {
  const [y, m] = date.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

/** The last day of a 'YYYY-MM' month, as 'YYYY-MM-DD'. */
export function monthEnd(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
}

/**
 * Calendar months later, holding the day of the month where it exists and
 * falling back to the month's last day where it does not: 31 January plus one
 * month is 28 (or 29) February, not 3 March.
 */
export function addMonthsClamped(d: Date, n: number): Date {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + n;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(y, m, Math.min(d.getUTCDate(), last), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()),
  );
}

/** Whole months from `a` to `b`, counted the way addMonthsClamped steps. */
export function wholeMonthsBetween(a: Date, b: Date): number {
  let k = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
  while (k > 0 && addMonthsClamped(a, k) > b) k--;
  return Math.max(0, k);
}

/** '12 Sep 2026' from 'YYYY-MM-DD'. */
export function formatDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** '12 Sep 2026' for an instant, in India. */
export const formatInstant = (at: Date): string => formatDay(istDate(at));
