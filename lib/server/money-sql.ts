// ─────────────────────────────────────────────────────────────────────────────
// The money boundary between MySQL and the application.
//
// The database stores DECIMAL(19,4) and mysql2 hands it back as a string —
// "1234.5600" — precisely so the value never passes through a JavaScript
// number on the way. The application works in integer paise, which is exact by
// construction. This file is the only place the two representations meet.
//
// Everything here is integer and string arithmetic. There is no `parseFloat`
// and no `* 100`, because both reintroduce the binary-floating-point error the
// DECIMAL column exists to avoid: parseFloat('0.1') * 100 is 10.000000000000002,
// and rounding that a few thousand times is how a trial balance stops tying.
// ─────────────────────────────────────────────────────────────────────────────

import type { Paise } from '../types';

/** DECIMAL(19,4) — four decimal places, so two digits below the paisa. */
const SCALE = 4;

/**
 * "1234.5600" → 123456 paise.
 *
 * The two digits below the paisa are rounded half-up rather than truncated.
 * They should always be zero for anything this application wrote, but a value
 * entered by hand in SQL, or migrated in from elsewhere, may carry them — and
 * silently dropping a half-paisa is how opening balances end up off by a rupee
 * across ten thousand rows.
 */
export function toPaiseFromSql(value: string | number | null | undefined): Paise {
  if (value === null || value === undefined) return 0;
  const s = typeof value === 'number' ? value.toFixed(SCALE) : String(value).trim();
  if (s === '') return 0;

  const negative = s.startsWith('-');
  const body = negative ? s.slice(1) : s;
  const [intPart = '0', fracRaw = ''] = body.split('.');

  const frac = (fracRaw + '0000').slice(0, SCALE); // pad, then take four
  const wholePaise = BigInt(intPart || '0') * 100n + BigInt(frac.slice(0, 2) || '0');

  // Digits three and four are below the paisa: round them half-up.
  const subPaise = Number(frac.slice(2, 4) || '0');
  const rounded = wholePaise + (subPaise >= 50 ? 1n : 0n);

  const n = Number(negative ? -rounded : rounded);
  if (!Number.isSafeInteger(n)) {
    // 2^53 paise is roughly 90,000 crore. Hitting this means a corrupt row,
    // not a genuinely large number, and it should not pass silently.
    throw new RangeError(`Amount ${s} exceeds the safe integer range in paise`);
  }
  return n;
}

/**
 * 123456 paise → "1234.5600", ready to hand to MySQL as a DECIMAL literal.
 *
 * Returned as a string on purpose: passing a JavaScript number here would let
 * the driver format it, and the driver formats through a float.
 */
export function toSqlFromPaise(paise: Paise): string {
  if (!Number.isInteger(paise)) {
    throw new TypeError(`Expected integer paise, received ${paise}`);
  }
  const negative = paise < 0;
  const abs = BigInt(Math.abs(paise));
  const rupees = abs / 100n;
  const remainder = abs % 100n;
  const body = `${rupees}.${String(remainder).padStart(2, '0')}00`;
  return negative ? `-${body}` : body;
}

/** Rates and quantities use DECIMAL(19,6) and stay as plain numbers. */
export function toNumberFromSql(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Quantities and percentages going the other way. */
export function toSqlFromNumber(value: number, scale = 6): string {
  if (!Number.isFinite(value)) throw new TypeError(`Expected a finite number, received ${value}`);
  return value.toFixed(scale);
}

/** MySQL DATE columns come back as a Date; the application speaks 'yyyy-mm-dd'. */
export function toDateString(value: Date | string | null | undefined): string {
  if (!value) return '';
  if (typeof value === 'string') return value.slice(0, 10);
  // Local parts, not toISOString — the latter shifts to UTC and can move an
  // Indian date back by one day.
  const m = String(value.getMonth() + 1).padStart(2, '0');
  const d = String(value.getDate()).padStart(2, '0');
  return `${value.getFullYear()}-${m}-${d}`;
}

/** DATETIME / TIMESTAMP columns, as an ISO instant. */
export function toIsoString(value: Date | string | null | undefined): string | undefined {
  if (!value) return undefined;
  return typeof value === 'string' ? value : value.toISOString();
}
