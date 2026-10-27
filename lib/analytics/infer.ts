// ─────────────────────────────────────────────────────────────────────────────
// From a spreadsheet grid to typed columns.
//
// A pasted range or an uploaded sheet arrives as a grid of strings, numbers,
// booleans and dates, with a header row that may or may not be there, blank
// rows, a "Grand Total" line at the bottom, and numbers written the way a
// finance team writes them: 1,23,456.78, (500) for a negative, ₹ and Rs. in
// front, a Tally "Dr" or "Cr" behind.
//
// This decides, per column, what it holds (number, money, percentage, date,
// text, yes/no) and what it is for (something you add up, or something you
// group by). Everything it decides is also written down as a note, because the
// review screen is where a person catches the one guess that was wrong — and a
// guess nobody can see is a wrong number in a board pack a month later.
//
// Pure: takes a grid, returns columns and rows. Re-run with overrides whenever
// the user corrects something, so there is exactly one parser.
// ─────────────────────────────────────────────────────────────────────────────

import { detectDayOrder, isoFromDate, parseDate, type DayOrder } from './dates';
import type { Cell, ColumnProfile, ColumnRole, ColumnSchema, ColumnType } from './types';

/** What a spreadsheet library or a paste hands over. */
export type RawCell = string | number | boolean | Date | null | undefined;

export const MAX_ROWS = 50_000;
export const MAX_COLUMNS = 60;
/** A cell is a label, not a document. Longer text is shortened, and said so. */
export const MAX_TEXT = 500;

export interface ColumnOverride {
  label?: string;
  type?: ColumnType;
  role?: ColumnRole;
  /** Leave the column out of the dataset entirely. */
  skip?: boolean;
}

export interface ImportOptions {
  /** 'auto' looks at the first row and decides. */
  hasHeader?: boolean | 'auto';
  overrides?: Record<number, ColumnOverride>;
  /** Keep a detected totals row instead of dropping it. */
  keepTotals?: boolean;
}

export interface ImportIssue {
  level: 'info' | 'warning';
  message: string;
}

export interface ImportResult {
  columns: ColumnSchema[];
  rows: Cell[][];
  issues: ImportIssue[];
  hasHeader: boolean;
  /** Source columns in order, including skipped ones — for the review grid. */
  sourceColumns: { index: number; label: string; skipped: boolean }[];
  /** Rows left out: blanks, and the totals line if one was found. */
  droppedRows: number;
  totalsRowDropped: boolean;
}

// ── Reading one value ────────────────────────────────────────────────────────

/** What people type for "nothing here". */
const NULLISH = new Set(['', '-', '--', '—', '–', 'na', 'n/a', 'nil', 'null', 'none', '#n/a', 'n.a.', 'nan']);

export const isNullish = (v: RawCell): boolean =>
  v === null || v === undefined || (typeof v === 'string' && NULLISH.has(v.trim().toLowerCase()));

export interface ParsedNumber {
  value: number;
  currency: boolean;
  percent: boolean;
  drcr: boolean;
}

const CURRENCY_PREFIX = /^(₹|rs\.?|inr|\$|usd|€|eur|£|gbp)\s*/i;
const CURRENCY_SUFFIX = /\s*(₹|rs\.?|inr|\$|usd|€|eur|£|gbp)$/i;
/** Western (1,234,567) or Indian (12,34,567) grouping — nothing else. */
const GROUPED = /^(\d{1,3}(,\d{3})+|\d{1,2}(,\d{2})+,\d{3})(\.\d+)?$/;

/**
 * One cell to a number, or null if it is not one.
 *
 * Deliberately strict about the things that look like numbers and are not: a
 * phone number with spaces, a code with a leading zero, a 16-digit account
 * number JavaScript cannot hold exactly. Those stay text, which is what they are.
 */
export function parseNumber(raw: string): ParsedNumber | null {
  let s = raw.trim();
  if (!s) return null;
  let neg = false;
  let currency = false;
  let percent = false;
  let drcr = false;

  // Tally and most Indian ledgers: "1,200.00 Dr" / "450 Cr".
  const side = /^(.*\d.*?)\s*(dr|cr)\.?$/i.exec(s);
  if (side) {
    s = side[1].trim();
    drcr = true;
    if (side[2].toLowerCase() === 'cr') neg = !neg;
  }

  const unwrap = () => {
    if (/^\(.*\)$/.test(s)) {
      neg = !neg;
      s = s.slice(1, -1).trim();
    }
    if (s.startsWith('-') || s.startsWith('−')) {
      neg = !neg;
      s = s.slice(1).trim();
    } else if (s.startsWith('+')) {
      // "+91 98400…" is a phone number, not a positive number.
      if (/^\+\d{10,}$/.test(s.replace(/\s/g, ''))) return false;
      s = s.slice(1).trim();
    }
    return true;
  };

  if (!unwrap()) return null;
  if (CURRENCY_PREFIX.test(s)) {
    currency = true;
    s = s.replace(CURRENCY_PREFIX, '');
    if (!unwrap()) return null; // "₹(500)", "₹ -500"
  }
  if (CURRENCY_SUFFIX.test(s)) {
    currency = true;
    s = s.replace(CURRENCY_SUFFIX, '').trim();
  }
  // SAP and some bank exports put the minus at the end: "500-".
  if (s.endsWith('-') && /\d-$/.test(s)) {
    neg = !neg;
    s = s.slice(0, -1).trim();
  }
  if (s.endsWith('%')) {
    percent = true;
    s = s.slice(0, -1).trim();
  }

  if (s.includes(',')) {
    if (!GROUPED.test(s)) return null;
    s = s.replace(/,/g, '');
  }
  if (!/^(\d+(\.\d+)?|\.\d+)$/.test(s)) return null;

  const intPart = s.split('.')[0];
  // A leading zero on a whole number is a code — "007", a branch number —
  // and summing codes is the classic spreadsheet-import mistake.
  if (intPart.length > 1 && intPart.startsWith('0') && !s.includes('.')) return null;
  // Past 15 significant digits a double cannot hold the value exactly; an
  // account number that silently changes its last digit is worse than text.
  if (intPart.replace(/^0+/, '').length > 15) return null;

  const value = Number(s) * (neg ? -1 : 1);
  if (!Number.isFinite(value)) return null;
  return { value: Object.is(value, -0) ? 0 : value, currency, percent, drcr };
}

const TRUE_WORDS = new Set(['true', 'yes', 'y']);
const FALSE_WORDS = new Set(['false', 'no', 'n']);

export function parseBoolean(raw: string): boolean | null {
  const s = raw.trim().toLowerCase();
  if (TRUE_WORDS.has(s)) return true;
  if (FALSE_WORDS.has(s)) return false;
  return null;
}

// ── Reading a column ─────────────────────────────────────────────────────────

/** Headers that name an identifier, however numeric its values look. */
const ID_LIKE =
  /(^|[\s_./#-])(id|code|no|num|number|pin|pincode|zip|postcode|phone|mobile|gstin|pan|hsn|sac|ifsc|invoice|voucher|bill|ref|reference|serial)\.?$/i;
const SERIAL = /^(s\.?\s*no\.?|sr\.?\s*no\.?|sl\.?\s*no\.?|#|serial|row)$/i;
const YEAR_HEADER = /^(year|yr|fy|financial year|calendar year)$/i;
const PERCENT_HEADER = /%|percent|pct|\btax\s*rate\b|\bgst\s*rate\b|margin|ratio|share/i;
const CURRENCY_HEADER =
  /amount|amt\b|value|price|\brate\b|revenue|sales|cost|expense|spend|total|tax|gst|cgst|sgst|igst|cess|tds|balance|debit|credit|profit|loss|income|budget|target|forecast|salary|payment|paid|receivable|payable|\bdue\b|outstanding|turnover|fee|charge|₹|\binr\b|\brs\b|mrp|discount/i;

/** Share of a column's values that must read as a type for it to be that type. */
const THRESHOLD = 0.95;

interface ColumnReading {
  type: ColumnType;
  role: ColumnRole;
  values: Cell[];
  notes: string[];
}

function readColumn(raw: RawCell[], label: string, forced?: ColumnType): ColumnReading {
  const present = raw.filter((v) => !isNullish(v));
  const notes: string[] = [];

  const asStrings = present.map((v) => (v instanceof Date ? '' : String(v)));
  const dayOrder = detectDayOrder(asStrings);

  // Try each reading; count how many present values it accepts.
  const nums = present.map((v) =>
    typeof v === 'number' ? { value: v, currency: false, percent: false, drcr: false }
      : typeof v === 'string' ? parseNumber(v) : null,
  );
  const dates = present.map((v) =>
    v instanceof Date ? isoFromDate(v) : typeof v === 'string' ? parseDate(v, dayOrder.order) : null,
  );
  const bools = present.map((v) => (typeof v === 'boolean' ? v : typeof v === 'string' ? parseBoolean(v) : null));

  const share = (xs: unknown[]) => (present.length ? xs.filter((x) => x !== null).length / present.length : 0);
  const numShare = share(nums);
  const dateShare = share(dates);
  const boolShare = share(bools);

  const integersOnly = nums.every((n) => n === null || Number.isInteger(n.value));
  // Only when the column is *called* a year. Values alone are not enough: a
  // quantity column of 1,950 and 2,100 units would otherwise stop adding up.
  const looksLikeYears =
    YEAR_HEADER.test(label.trim()) && integersOnly && numShare >= THRESHOLD &&
    nums.every((n) => n === null || (n.value >= 1900 && n.value <= 2200));

  let type: ColumnType;
  if (forced) type = forced;
  else if (present.length === 0) type = 'text';
  else if (dateShare >= THRESHOLD) type = 'date';
  else if (boolShare >= THRESHOLD && numShare < THRESHOLD) type = 'boolean';
  else if (numShare >= THRESHOLD) {
    const anyPercent = nums.some((n) => n?.percent);
    const anyCurrency = nums.some((n) => n?.currency);
    if (looksLikeYears || ID_LIKE.test(label) || SERIAL.test(label)) type = 'text';
    else if (anyPercent || PERCENT_HEADER.test(label)) type = 'percent';
    else if (anyCurrency || CURRENCY_HEADER.test(label)) type = 'currency';
    else type = 'number';
  } else type = 'text';

  // Convert every cell, including the ones the reading rejected.
  let unreadable = 0;
  let truncated = 0;
  const values: Cell[] = raw.map((v) => {
    if (isNullish(v)) return null;
    switch (type) {
      case 'number':
      case 'currency':
      case 'percent': {
        const n = typeof v === 'number' ? v : typeof v === 'string' ? parseNumber(v)?.value ?? null : null;
        if (n === null) unreadable++;
        return n;
      }
      case 'date': {
        const d = v instanceof Date ? isoFromDate(v) : typeof v === 'string' ? parseDate(v, dayOrder.order) : null;
        if (d === null) unreadable++;
        return d;
      }
      case 'boolean': {
        const b = typeof v === 'boolean' ? v : typeof v === 'string' ? parseBoolean(v) : null;
        if (b === null) unreadable++;
        return b;
      }
      case 'text': {
        if (v instanceof Date) return isoFromDate(v);
        const s = typeof v === 'string' ? v.trim() : String(v);
        if (s.length <= MAX_TEXT) return s;
        truncated++;
        return s.slice(0, MAX_TEXT);
      }
    }
  });

  if (truncated > 0) {
    notes.push(`${truncated} long value${truncated === 1 ? ' was' : 's were'} shortened to ${MAX_TEXT} characters.`);
  }

  if (unreadable > 0) {
    notes.push(
      `${unreadable} value${unreadable === 1 ? '' : 's'} could not be read as ${type === 'date' ? 'dates' : type === 'boolean' ? 'yes/no' : 'numbers'} and ${unreadable === 1 ? 'was' : 'were'} left blank.`,
    );
  }
  if (type === 'date' && dayOrder.ambiguous && !forced) {
    notes.push('Read as day/month/year. If these are US-style dates, change the type and re-import.');
  }
  if (type === 'date' && dayOrder.order === 'mdy' && !forced) {
    notes.push('Read as month/day/year — at least one value only makes sense that way.');
  }
  if ((type === 'number' || type === 'currency') && nums.some((n) => n?.drcr) && !forced) {
    notes.push('Tally-style Dr/Cr values: debits read as positive, credits as negative.');
  }
  if (!forced && numShare >= THRESHOLD && type === 'text') {
    notes.push(
      looksLikeYears
        ? 'Numbers that look like years, so kept for grouping rather than adding up.'
        : 'Numeric, but the name marks it as an identifier — kept for grouping, never summed.',
    );
  }

  const role: ColumnRole =
    type === 'number' || type === 'currency' || type === 'percent' ? 'measure' : 'dimension';

  return { type, role, values, notes };
}

function profile(values: Cell[], type: ColumnType): ColumnProfile {
  const present = values.filter((v) => v !== null);
  const distinct = new Set(present.map((v) => String(v))).size;
  const p: ColumnProfile = {
    distinct,
    nulls: values.length - present.length,
    sample: [...new Set(present.slice(0, 200).map((v) => String(v)))].slice(0, 5),
  };
  if (type === 'number' || type === 'currency' || type === 'percent') {
    const ns = present as number[];
    if (ns.length) {
      p.min = Math.min(...ns);
      p.max = Math.max(...ns);
    }
  } else if (type === 'date') {
    const ds = (present as string[]).slice().sort();
    if (ds.length) {
      p.min = ds[0];
      p.max = ds[ds.length - 1];
    }
  }
  return p;
}

// ── Reading the grid ─────────────────────────────────────────────────────────

const TOTALS = /^\s*(grand\s*)?(sub\s*)?total(s)?\b/i;

const emptyRow = (r: RawCell[]) => r.every(isNullish);

/**
 * Whether the first row is a header.
 *
 * It is when every cell in it is text that does not read as a number or a
 * date, and at least one column below it does. A sheet of nothing but text
 * with no such contrast is read as having a header when its first row is all
 * distinct — which is how people lay out a list of names.
 */
export function detectHeader(grid: RawCell[][]): boolean {
  const first = grid[0];
  if (!first) return false;
  const cells = first.filter((c) => !isNullish(c));
  if (!cells.length) return false;
  const allText = cells.every(
    (c) => typeof c === 'string' && !parseNumber(c) && !parseDate(c) && parseBoolean(c) === null,
  );
  if (!allText) return false;

  const body = grid.slice(1, 50);
  const bodyHasNumbers = first.some((_, i) =>
    body.some((r) => {
      const v = r[i];
      return typeof v === 'number' || v instanceof Date || (typeof v === 'string' && (parseNumber(v) || parseDate(v)));
    }),
  );
  if (bodyHasNumbers) return true;
  return new Set(cells.map((c) => String(c).toLowerCase())).size === cells.length;
}

export function importGrid(input: RawCell[][], opts: ImportOptions = {}): ImportResult {
  const issues: ImportIssue[] = [];

  // Square the grid off and drop blank rows.
  const width = Math.max(0, ...input.map((r) => r.length));
  let grid = input.map((r) => Array.from({ length: width }, (_, i) => r[i] ?? null));
  const before = grid.length;
  grid = grid.filter((r) => !emptyRow(r));
  let droppedRows = before - grid.length;

  // Trailing columns with nothing in them — a spreadsheet's used range is often
  // wider than its data.
  let lastUsed = width - 1;
  while (lastUsed >= 0 && grid.every((r) => isNullish(r[lastUsed]))) lastUsed--;
  grid = grid.map((r) => r.slice(0, lastUsed + 1));

  const hasHeader = opts.hasHeader === 'auto' || opts.hasHeader === undefined ? detectHeader(grid) : opts.hasHeader;
  const headerRow = hasHeader ? grid[0] ?? [] : [];
  let body = hasHeader ? grid.slice(1) : grid;

  // A "Grand Total" line counted as data doubles every sum on every chart.
  let totalsRowDropped = false;
  if (!opts.keepTotals && body.length > 1) {
    const last = body[body.length - 1];
    if (last.some((c) => typeof c === 'string' && TOTALS.test(c))) {
      body = body.slice(0, -1);
      totalsRowDropped = true;
      droppedRows++;
      issues.push({
        level: 'info',
        message: 'The last row looked like a totals line and was left out, so it is not counted twice.',
      });
    }
  }

  if (body.length > MAX_ROWS) {
    issues.push({
      level: 'warning',
      message: `The data has ${body.length.toLocaleString('en-IN')} rows. Only the first ${MAX_ROWS.toLocaleString('en-IN')} were kept.`,
    });
    body = body.slice(0, MAX_ROWS);
  }

  const colCount = Math.min(lastUsed + 1, MAX_COLUMNS);
  if (lastUsed + 1 > MAX_COLUMNS) {
    issues.push({
      level: 'warning',
      message: `The data has ${lastUsed + 1} columns. Only the first ${MAX_COLUMNS} were kept.`,
    });
  }

  // Labels: the header, or Column 1…n, made unique.
  const seen = new Map<string, number>();
  const labels = Array.from({ length: colCount }, (_, i) => {
    const base = (hasHeader && !isNullish(headerRow[i]) ? String(headerRow[i]).trim() : `Column ${i + 1}`)
      .replace(/\s+/g, ' ')
      .slice(0, 80);
    const n = seen.get(base.toLowerCase()) ?? 0;
    seen.set(base.toLowerCase(), n + 1);
    return n === 0 ? base : `${base} (${n + 1})`;
  });

  const columns: ColumnSchema[] = [];
  const sourceColumns: ImportResult['sourceColumns'] = [];
  const kept: Cell[][] = [];

  for (let i = 0; i < colCount; i++) {
    const o = opts.overrides?.[i] ?? {};
    const label = o.label?.trim() || labels[i];
    sourceColumns.push({ index: i, label, skipped: !!o.skip });
    if (o.skip) continue;

    const reading = readColumn(body.map((r) => r[i]), label, o.type);
    const role = o.role ?? reading.role;
    columns.push({
      key: `c${i}`,
      index: columns.length,
      label,
      type: reading.type,
      role,
      notes: reading.notes.length ? reading.notes : undefined,
      profile: profile(reading.values, reading.type),
    });
    kept.push(reading.values);
  }

  // Columns were read one at a time; rows are what gets stored.
  const rows: Cell[][] = body.map((_, r) => kept.map((col) => col[r]));

  if (!rows.length) issues.push({ level: 'warning', message: 'There are no data rows to import.' });
  if (!columns.some((c) => c.role === 'measure')) {
    issues.push({
      level: 'info',
      message: 'No column holds numbers to add up, so charts will count rows. Change a column to a number if one should be summed.',
    });
  }

  return { columns, rows, issues, hasHeader, sourceColumns, droppedRows, totalsRowDropped };
}

/** The day order a column's raw strings imply. Exposed for the review screen. */
export function dayOrderOf(values: string[]): DayOrder {
  return detectDayOrder(values).order;
}
