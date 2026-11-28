// Reading a bank statement as downloaded from the bank's net banking: CSV or
// Excel, with whatever the bank calls its columns and however it writes dates.
//
// Indian banks disagree on everything: "Txn Date" or "Value Date" or "Date",
// "Narration" or "Description" or "Particulars", one Amount column with Dr/Cr
// or separate "Withdrawal Amt." and "Deposit Amt.", dates as 01/10/2026,
// 01-10-26 or 01 Oct 2026. The header row is not always the first either; a
// few lines of account details often come before it.
//
// The columns are guessed (guessMapping) and the guess can be corrected on
// screen, as Zoho Books' "map fields" step allows; readWithMapping then reads
// the lines with whatever mapping was settled on.

import { findHeader } from './imports/header';

export interface StatementRow {
  date: string;
  narration: string;
  reference: string | null;
  depositPaise: number;
  withdrawalPaise: number;
  runningBalancePaise?: number | null;
}

/** Which way round a numeric date is written. */
export type DateOrder = 'dmy' | 'mdy' | 'ymd';

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n: number) => String(n).padStart(2, '0');

/** A statement date as yyyy-mm-dd: day first, as Indian banks write it, unless told otherwise. */
export function statementDate(v: unknown, order: DateOrder = 'dmy'): string | null {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
  // A time after the date ("01/11/2026 10:15:32", "01-Nov-2026 10:15 AM") is not part of the day.
  const s = String(v ?? '').trim().replace(/(?:\s+|T)\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:\s*[AP]M)?(?:Z|[+-]\d{2}:?\d{2})?$/i, '');
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/);
  if (m) return `${m[1]}-${pad(Number(m[2]))}-${pad(Number(m[3]))}`;
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (m) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const [d, mo] = order === 'mdy' ? [Number(m[2]), Number(m[1])] : [Number(m[1]), Number(m[2])];
    return mo >= 1 && mo <= 12 && d >= 1 && d <= 31 ? `${y}-${pad(mo)}-${pad(d)}` : null;
  }
  // 01-Nov-2026, 01 Nov 26, 01/Nov/2026, 01.Nov.2026
  m = s.match(/^(\d{1,2})[\s\-/.]([A-Za-z]{3})[A-Za-z]*[\s\-/.,]+(\d{2,4})$/);
  if (m && MONTHS[m[2].toLowerCase()]) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return `${y}-${pad(MONTHS[m[2].toLowerCase()])}-${pad(Number(m[1]))}`;
  }
  m = s.match(/^([A-Za-z]{3})[A-Za-z]*\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m && MONTHS[m[1].toLowerCase()]) return `${m[3]}-${pad(MONTHS[m[1].toLowerCase()])}-${pad(Number(m[2]))}`;
  // yyyymmdd, as OFX and some exports write it.
  m = s.match(/^(\d{4})(\d{2})(\d{2})(\d{6})?/);
  if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

/**
 * An amount as banks write it: 1,234.50, ₹1,234.50, INR 1234.50, 1234.50 Dr,
 * (1,234.50) or 1234.50- for a minus. A Dr or Cr after it is left to the
 * caller, which reads which side it is on.
 */
export const amount = (v: unknown): number => {
  if (typeof v === 'number') return v;
  let s = String(v ?? '').replace(/[,₹\s]/g, '').replace(/^(?:rs\.?|inr)/i, '').replace(/(Dr|Cr)\.?$/i, '');
  let sign = 1;
  if (/^\(.*\)$/.test(s)) { sign = -1; s = s.slice(1, -1); }
  if (/^[\d.]+-$/.test(s)) { sign = -1; s = s.slice(0, -1); }
  const n = parseFloat(s);
  return Number.isFinite(n) ? sign * n : 0;
};

/** Whether a Dr/Cr indicator (or the text of an amount) says money went out: D, Dr, DB, Debit, Withdrawal. */
export const isDebitMark = (text: string) => /^(d|dr|db|debit)\.?$/i.test(text.trim()) || /debit|withdraw|dr\.?$/i.test(text.trim());

const find = (headers: string[], ...names: RegExp[]) => headers.findIndex((h) => names.some((n) => n.test(h)));
const norm = (c: unknown) => String(c ?? '').trim().toLowerCase();

/** Which column holds what; -1 for none. */
export interface StatementMapping {
  headerAt: number;
  date: number;
  narration: number;
  reference: number;
  withdrawal: number;
  deposit: number;
  amount: number;
  drcr: number;
  balance: number;
  dateOrder: DateOrder;
}

export const MAPPING_FIELDS: { key: Exclude<keyof StatementMapping, 'headerAt' | 'dateOrder'>; label: string; required?: boolean }[] = [
  { key: 'date', label: 'Date', required: true },
  { key: 'narration', label: 'Description / Narration', required: true },
  { key: 'reference', label: 'Reference / Cheque no.' },
  { key: 'withdrawal', label: 'Withdrawals (Debit)' },
  { key: 'deposit', label: 'Deposits (Credit)' },
  { key: 'amount', label: 'Amount (one column)' },
  { key: 'drcr', label: 'Dr / Cr indicator' },
  { key: 'balance', label: 'Running balance' },
];

/** The header row and what each column most likely holds. Null when no header can be found. */
export function guessMapping(grid: unknown[][]): StatementMapping | null {
  // The heading row may sit under a bank's logo and account lines, and run
  // over two rows where a merged "Amount" heads "Debit" and "Credit"
  // (lib/imports/header.ts): it is the row naming a date and a narration.
  const found = findHeader(grid, (cells) => {
    const c = cells.map(norm);
    if (!c.some((x) => /date/.test(x)) || !c.some((x) => /narration|description|particular|remarks|details|payee|memo/.test(x))) return 0;
    return c.filter((x) => /date|narration|description|particular|remarks|details|ref|chq|cheque|withdraw|deposit|debit|credit|amount|balance|dr|cr/.test(x)).length;
  });
  if (!found || !found.headings.some((h) => /date/.test(norm(h)))) return null;
  const headerAt = found.bodyFrom - 1;
  const headers = found.headings.map(norm);
  const date = find(headers, /^(txn|transaction|tran|posting|value)?\.?\s*date/, /^date$/, /date/);
  const m: StatementMapping = {
    headerAt,
    date,
    narration: find(headers, /narration/, /description/, /particular/, /remarks/, /details/, /payee/, /memo/),
    reference: find(headers, /ref/, /chq|cheque/),
    withdrawal: find(headers, /withdraw/, /^debit(?!\s*\/)/, /amount debit|debit amount/, /\bdr\b(?!\s*\/)/, /paid out/),
    deposit: find(headers, /deposit/, /^credit(?!\s*\/)/, /amount credit|credit amount/, /\bcr\b(?!\s*\/)/, /paid in/),
    amount: find(headers, /^amount$/, /^amount(?! (debit|credit))/, /transaction amount/),
    // The flag beside a single amount: Dr/Cr, Cr/Dr, Debit/Credit, or a Type column holding D or C.
    drcr: find(headers, /dr\s*\/\s*cr|cr\s*\/\s*dr|debit\s*\/\s*credit|credit\s*\/\s*debit|^type$|txn type|transaction type/),
    balance: find(headers, /balance/),
    dateOrder: 'dmy',
  };
  // A "Dr/Cr" column is the flag beside a single amount, never the amounts themselves.
  if (m.drcr >= 0 && m.withdrawal === m.drcr) m.withdrawal = -1;
  if (m.drcr >= 0 && m.deposit === m.drcr) m.deposit = -1;
  m.dateOrder = guessDateOrder(grid.slice(headerAt + 1).map((r) => r[date]));
  return m;
}

/** Day first unless the dates themselves say otherwise (a 13 or more in the first place). */
export function guessDateOrder(values: unknown[]): DateOrder {
  let first = 0;
  let second = 0;
  for (const v of values) {
    const m = String(v ?? '').trim().match(/^(\d{1,2})[/.-](\d{1,2})[/.-]\d{2,4}$/);
    if (!m) continue;
    if (Number(m[1]) > 12) first++;
    if (Number(m[2]) > 12) second++;
  }
  return second > 0 && first === 0 ? 'mdy' : 'dmy';
}

/** The lines under the header, read with a settled mapping. */
export function readWithMapping(grid: unknown[][], col: StatementMapping): { rows: StatementRow[]; problem: string | null } {
  if (col.date < 0 || col.narration < 0) return { rows: [], problem: 'Choose which columns hold the date and the description.' };
  if (col.withdrawal < 0 && col.deposit < 0 && col.amount < 0) return { rows: [], problem: 'No withdrawal, deposit or amount column was found.' };
  const rows: StatementRow[] = [];
  for (const r of grid.slice(col.headerAt + 1)) {
    const date = statementDate(r[col.date], col.dateOrder);
    if (!date) continue;
    let out = col.withdrawal >= 0 ? amount(r[col.withdrawal]) : 0;
    let inn = col.deposit >= 0 ? amount(r[col.deposit]) : 0;
    // One signed column (or two holding signed figures): a minus is money out.
    if (col.withdrawal >= 0 && col.withdrawal === col.deposit) {
      inn = out > 0 ? out : 0;
      out = out < 0 ? -out : 0;
    }
    if (!out && !inn && col.amount >= 0) {
      const a = amount(r[col.amount]);
      // The flag column when it says something; else the amount's own "Dr" or "Cr".
      const kind = (col.drcr >= 0 ? norm(r[col.drcr]) : '') || String(r[col.amount] ?? '').toLowerCase();
      if (isDebitMark(kind) || a < 0) out = Math.abs(a); else inn = Math.abs(a);
    }
    if (!out && !inn) continue;
    const bal = col.balance >= 0 ? String(r[col.balance] ?? '').trim() : '';
    rows.push({
      date,
      narration: String(r[col.narration] ?? '').trim() || 'Imported line',
      reference: col.reference >= 0 ? String(r[col.reference] ?? '').trim() || null : null,
      depositPaise: Math.round(Math.abs(inn) * 100),
      withdrawalPaise: Math.round(Math.abs(out) * 100),
      ...(bal ? { runningBalancePaise: Math.round(amount(bal) * (/dr\.?$/i.test(bal) ? -100 : 100)) } : {}),
    });
  }
  return { rows, problem: rows.length ? null : 'The header was found, but no lines under it had a date and an amount.' };
}

/**
 * Rows from a grid of cells (the first sheet, or the parsed CSV with no header
 * applied). Finds the header row, then reads each line under it.
 */
export function readStatementGrid(grid: unknown[][]): { rows: StatementRow[]; problem: string | null } {
  const m = guessMapping(grid);
  if (!m) return { rows: [], problem: 'No header row with a date and a narration column was found.' };
  return readWithMapping(grid, m);
}
