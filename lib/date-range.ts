// ─────────────────────────────────────────────────────────────────────────────
// Date range maths for every filter in the app.
//
// Pure functions only — no React, no store. The one thing they need from the
// outside is what "today" means, which is passed in rather than read from the
// clock. The demo pins today to a fixed date so the seeded book always looks
// the same; a filter that quietly called `new Date()` would drift away from it
// and start returning empty results.
//
// India runs an April–March financial year, so "this year" is almost never the
// calendar year and quarters are Apr–Jun, Jul–Sep, Oct–Dec, Jan–Mar. Getting
// that wrong is not a cosmetic bug: it puts transactions in the wrong return
// period.
// ─────────────────────────────────────────────────────────────────────────────

export interface DateRange {
  from: string; // yyyy-mm-dd, inclusive
  to: string; // yyyy-mm-dd, inclusive
}

export type RangeMode = 'preset' | 'day' | 'month' | 'quarter' | 'fy' | 'custom' | 'all';

export interface RangeValue extends DateRange {
  /** How this range was chosen — drives which tab reopens and how it is labelled. */
  mode: RangeMode;
  /** Preset key, or the month/quarter/FY identifier that was picked. */
  key?: string;
}

/** The month a financial year opens in. April in India; 0-indexed for Date. */
export const FY_START_MONTH = 3;

const iso = (d: Date): string => {
  // Build from local parts, not toISOString — that shifts to UTC and can move
  // the date back a day for anyone east of Greenwich, which is everyone here.
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
};

const parse = (s: string): Date => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};

const addDays = (s: string, n: number): string => {
  const d = parse(s);
  d.setDate(d.getDate() + n);
  return iso(d);
};

export const startOfMonth = (s: string): string => `${s.slice(0, 7)}-01`;

export const endOfMonth = (s: string): string => {
  const d = parse(s);
  return iso(new Date(d.getFullYear(), d.getMonth() + 1, 0));
};

/** Weeks run Monday to Sunday, which is how Indian businesses read a week. */
export const startOfWeek = (s: string): string => {
  const d = parse(s);
  const shift = (d.getDay() + 6) % 7; // Sunday(0) → 6, Monday(1) → 0
  d.setDate(d.getDate() - shift);
  return iso(d);
};

// ── Financial years ──────────────────────────────────────────────────────────

/** The FY a date falls in, identified by its opening calendar year. */
export function fyOf(dateStr: string): number {
  const d = parse(dateStr);
  return d.getMonth() < FY_START_MONTH ? d.getFullYear() - 1 : d.getFullYear();
}

export function fyRange(startYear: number): DateRange {
  return {
    from: `${startYear}-04-01`,
    to: `${startYear + 1}-03-31`,
  };
}

/** '2026-27' — the form every Indian invoice series and return uses. */
export function fyLabel(startYear: number): string {
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

/** FY quarters, in FY order rather than calendar order. */
export const FY_QUARTERS = [
  { key: 'Q1', label: 'Q1 · Apr – Jun', startMonth: 3 },
  { key: 'Q2', label: 'Q2 · Jul – Sep', startMonth: 6 },
  { key: 'Q3', label: 'Q3 · Oct – Dec', startMonth: 9 },
  { key: 'Q4', label: 'Q4 · Jan – Mar', startMonth: 0 },
] as const;

export function quarterRange(fyStartYear: number, quarter: string): DateRange {
  const q = FY_QUARTERS.find((x) => x.key === quarter) ?? FY_QUARTERS[0];
  // Q4 is Jan–Mar, which lands in the *following* calendar year.
  const year = q.startMonth < FY_START_MONTH ? fyStartYear + 1 : fyStartYear;
  const from = new Date(year, q.startMonth, 1);
  const to = new Date(year, q.startMonth + 3, 0);
  return { from: iso(from), to: iso(to) };
}

/** Which FY quarter a date sits in. */
export function quarterOf(dateStr: string): string {
  const m = parse(dateStr).getMonth();
  if (m >= 3 && m <= 5) return 'Q1';
  if (m >= 6 && m <= 8) return 'Q2';
  if (m >= 9 && m <= 11) return 'Q3';
  return 'Q4';
}

// ── Months ───────────────────────────────────────────────────────────────────

export const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** `monthKey` is 'yyyy-mm'. */
export function monthRange(monthKey: string): DateRange {
  const from = `${monthKey}-01`;
  return { from, to: endOfMonth(from) };
}

export function monthLabel(monthKey: string): string {
  const [y, m] = monthKey.split('-').map(Number);
  return `${MONTH_NAMES[m - 1]} ${y}`;
}

/** The twelve months of a financial year, in FY order (April first). */
export function fyMonths(fyStartYear: number): { key: string; label: string }[] {
  return Array.from({ length: 12 }, (_, i) => {
    const monthIdx = (FY_START_MONTH + i) % 12;
    const year = FY_START_MONTH + i > 11 ? fyStartYear + 1 : fyStartYear;
    const key = `${year}-${String(monthIdx + 1).padStart(2, '0')}`;
    return { key, label: `${MONTH_NAMES[monthIdx]} ${String(year).slice(2)}` };
  });
}

// ── Presets ──────────────────────────────────────────────────────────────────

export interface PresetDef {
  key: string;
  label: string;
  /** Grouping in the picker, so "this X" and "last X" don't interleave. */
  group: 'Current' | 'Previous';
  resolve: (today: string) => DateRange;
}

export const PRESETS: PresetDef[] = [
  { key: 'today', label: 'Today', group: 'Current', resolve: (t) => ({ from: t, to: t }) },
  { key: 'this_week', label: 'This week', group: 'Current', resolve: (t) => ({ from: startOfWeek(t), to: t }) },
  { key: 'this_month', label: 'This month', group: 'Current', resolve: (t) => ({ from: startOfMonth(t), to: t }) },
  {
    key: 'this_quarter',
    label: 'This quarter',
    group: 'Current',
    resolve: (t) => ({ from: quarterRange(fyOf(t), quarterOf(t)).from, to: t }),
  },
  {
    key: 'this_fy',
    label: 'This financial year',
    group: 'Current',
    resolve: (t) => ({ from: fyRange(fyOf(t)).from, to: t }),
  },
  { key: 'last_7', label: 'Last 7 days', group: 'Current', resolve: (t) => ({ from: addDays(t, -6), to: t }) },
  { key: 'last_30', label: 'Last 30 days', group: 'Current', resolve: (t) => ({ from: addDays(t, -29), to: t }) },
  { key: 'last_90', label: 'Last 90 days', group: 'Current', resolve: (t) => ({ from: addDays(t, -89), to: t }) },

  { key: 'yesterday', label: 'Yesterday', group: 'Previous', resolve: (t) => ({ from: addDays(t, -1), to: addDays(t, -1) }) },
  {
    key: 'prev_week',
    label: 'Previous week',
    group: 'Previous',
    resolve: (t) => {
      const start = addDays(startOfWeek(t), -7);
      return { from: start, to: addDays(start, 6) };
    },
  },
  {
    key: 'prev_month',
    label: 'Previous month',
    group: 'Previous',
    resolve: (t) => {
      const end = addDays(startOfMonth(t), -1);
      return { from: startOfMonth(end), to: end };
    },
  },
  {
    key: 'prev_quarter',
    label: 'Previous quarter',
    group: 'Previous',
    resolve: (t) => {
      const cur = quarterRange(fyOf(t), quarterOf(t));
      const end = addDays(cur.from, -1);
      return quarterRange(fyOf(end), quarterOf(end));
    },
  },
  {
    key: 'prev_fy',
    label: 'Previous financial year',
    group: 'Previous',
    resolve: (t) => fyRange(fyOf(t) - 1),
  },
];

// ── Resolution and labelling ─────────────────────────────────────────────────

/** Widest range the app ever needs — used by the "All dates" option on lists. */
export const ALL_TIME: DateRange = { from: '1900-01-01', to: '2999-12-31' };

export function presetRange(key: string, today: string): DateRange {
  const p = PRESETS.find((x) => x.key === key);
  return p ? p.resolve(today) : { from: today, to: today };
}

/** Build a value from a preset key, ready to store in component state. */
export function fromPreset(key: string, today: string): RangeValue {
  return { ...presetRange(key, today), mode: 'preset', key };
}

const fmt = (s: string): string =>
  parse(s).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

const fmtShort = (s: string): string =>
  parse(s).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });

/** What the picker's trigger button reads. */
export function describeRange(v: RangeValue): string {
  switch (v.mode) {
    case 'all':
      return 'All dates';
    case 'preset':
      return PRESETS.find((p) => p.key === v.key)?.label ?? 'Custom range';
    case 'day':
      return fmt(v.from);
    case 'month':
      return v.key ? monthLabel(v.key) : fmt(v.from);
    case 'quarter': {
      const q = FY_QUARTERS.find((x) => v.key?.endsWith(x.key));
      const year = v.key?.split(':')[0];
      return q && year ? `${q.key} FY ${fyLabel(Number(year))}` : 'Quarter';
    }
    case 'fy':
      return `FY ${fyLabel(Number(v.key))}`;
    default:
      // Same year on both ends? Then say the year once.
      return v.from.slice(0, 4) === v.to.slice(0, 4)
        ? `${fmtShort(v.from)} – ${fmt(v.to)}`
        : `${fmt(v.from)} – ${fmt(v.to)}`;
  }
}

/** Longer form for print headers and CSV exports. */
export function describeRangeLong(v: RangeValue): string {
  if (v.mode === 'all') return 'All dates';
  if (v.from === v.to) return `On ${fmt(v.from)}`;
  return `${fmt(v.from)} to ${fmt(v.to)}`;
}

/** True when a date falls inside the range, inclusive at both ends. */
export const withinRange = (date: string, r: DateRange): boolean =>
  date >= r.from && date <= r.to;

/**
 * Financial years worth offering: everything from the earliest transaction to
 * the one containing today. Offering FYs with no data in them is noise, and
 * offering only the current one hides genuine history.
 */
export function availableFys(dates: string[], today: string): number[] {
  const current = fyOf(today);
  const earliest = dates.length ? fyOf(dates.reduce((a, b) => (a < b ? a : b))) : current;
  const out: number[] = [];
  for (let y = current; y >= Math.min(earliest, current - 1); y--) out.push(y);
  return out;
}

// ── Comparisons ──────────────────────────────────────────────────────────────

export type CompareMode = 'none' | 'previous' | 'last_year';

export const COMPARE_LABEL: Record<CompareMode, string> = {
  none: 'No comparison',
  previous: 'Previous period',
  last_year: 'Same period last year',
};

/** Move a date by whole months; the end of a month stays the end of a month. */
const addMonths = (s: string, n: number): string => {
  const d = parse(s);
  const atEnd = s === endOfMonth(s);
  const moved = new Date(d.getFullYear(), d.getMonth() + n, 1);
  if (atEnd) return endOfMonth(iso(moved));
  return iso(new Date(moved.getFullYear(), moved.getMonth(), Math.min(d.getDate(), Number(endOfMonth(iso(moved)).slice(8)))));
};

/**
 * The period to set beside a report's: the one just before it, or the same
 * one a year earlier. A run of whole months steps back by that many months —
 * October against September, a quarter against the quarter before — and any
 * other range by its own length in days.
 */
export function comparisonRange(r: DateRange, mode: Exclude<CompareMode, 'none'>): DateRange {
  if (mode === 'last_year') return { from: addMonths(r.from, -12), to: addMonths(r.to, -12) };
  if (r.from === startOfMonth(r.from) && r.to === endOfMonth(r.to)) {
    const months = (Number(r.to.slice(0, 4)) - Number(r.from.slice(0, 4))) * 12 + Number(r.to.slice(5, 7)) - Number(r.from.slice(5, 7)) + 1;
    return { from: addMonths(r.from, -months), to: addMonths(r.to, -months) };
  }
  const days = Math.round((parse(r.to).getTime() - parse(r.from).getTime()) / 864e5) + 1;
  return { from: addDays(r.from, -days), to: addDays(r.from, -1) };
}
