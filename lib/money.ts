// ─────────────────────────────────────────────────────────────────────────────
// Money utilities. ALL money in the app is integer paise (₹1 = 100 paise).
// No component or service may do raw float arithmetic on money — it goes
// through these helpers. This module is production code (reused post-MVP).
// ─────────────────────────────────────────────────────────────────────────────

import type { Paise } from './types';

/** ₹ rupees (possibly fractional user input) → integer paise, round half-up. */
export function toPaise(rupees: number | string): Paise {
  const n = typeof rupees === 'string' ? parseFloat(rupees || '0') : rupees;
  if (!isFinite(n)) return 0;
  return Math.round(n * 100);
}

/** Integer paise → rupee number (for form fields; display should use formatINR). */
export function toRupees(paise: Paise): number {
  return paise / 100;
}

/** Multiply paise by a percentage, round half-up. e.g. gst = pctOf(taxable, 18) */
export function pctOf(paise: Paise, pct: number): Paise {
  return Math.round((paise * pct) / 100);
}

/** Multiply unit price by quantity (qty may be fractional, e.g. 2.5 KGS). */
export function mulQty(ratePaise: Paise, qty: number): Paise {
  return Math.round(ratePaise * qty);
}

/**
 * Round a total to the nearest whole rupee (Indian invoice convention).
 * Returns the rounded total and the signed round-off delta.
 */
export function roundToRupee(paise: Paise): { rounded: Paise; roundOff: Paise } {
  const rounded = Math.round(paise / 100) * 100;
  return { rounded, roundOff: rounded - paise };
}

const inrFmt = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const inrFmtWhole = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

/** ₹12,34,567.89 — Indian digit grouping. */
export function formatINR(paise: Paise): string {
  return inrFmt.format(paise / 100);
}

/** ₹12,34,568 — for dashboards/tiles where paise are noise. */
export function formatINRWhole(paise: Paise): string {
  return inrFmtWhole.format(paise / 100);
}

/** Compact: ₹12.3L / ₹1.2Cr — Indian units for tiles and charts. */
export function formatINRCompact(paise: Paise): string {
  const r = Math.abs(paise) / 100;
  const sign = paise < 0 ? '-' : '';
  if (r >= 1_00_00_000) return `${sign}₹${(r / 1_00_00_000).toFixed(2)}Cr`;
  if (r >= 1_00_000) return `${sign}₹${(r / 1_00_000).toFixed(2)}L`;
  if (r >= 1_000) return `${sign}₹${(r / 1_000).toFixed(1)}K`;
  return `${sign}₹${r.toFixed(0)}`;
}

/** Sum an array of paise values safely. */
export function sumPaise(values: Paise[]): Paise {
  return values.reduce((a, b) => a + b, 0);
}
