// ─────────────────────────────────────────────────────────────────────────────
// TDS engine — threshold logic over a dated rate row. When paying vendors, the
// law requires withholding tax once a single payment, or the year's total to
// the payee, exceeds the section's threshold.
//
// The rates themselves are data, not code: each book has dated rows the CA can
// correct (lib/server/tax/rates.ts), falling back to the shipped list in
// lib/tax/statutory-rates.ts. This module is the pure arithmetic.
// ─────────────────────────────────────────────────────────────────────────────

import type { Paise, TdsSection } from '../types';
import { DEFAULT_TDS_RATES, ratesOn, type TdsRate } from './statutory-rates';

/**
 * The sections a vendor or bill can be mapped to, for pickers. Rates shown are
 * the shipped ones in force today; the deduction itself always uses the
 * book's own row for the bill's date.
 */
export const TDS_SECTIONS: TdsSection[] = ratesOn(DEFAULT_TDS_RATES, '9999-12-31').map((r) => ({
  code: r.code,
  description: r.nature,
  ratePctWithPan: r.rateOtherPct,
  ratePctWithoutPan: r.rateNoPanPct,
  thresholdSinglePaise: r.thresholdSinglePaise ?? 0,
  thresholdAnnualPaise: r.thresholdAnnualPaise ?? 0,
}));

export function tdsSection(code: string): TdsSection | undefined {
  return TDS_SECTIONS.find((s) => s.code === code);
}

/**
 * An individual or HUF, from the fourth letter of the PAN: P for a person, H
 * for a Hindu undivided family. Contractors are deducted at the lower rate.
 */
export function isIndividualPan(pan: string | null | undefined): boolean {
  const c = pan?.trim().toUpperCase()[3];
  return c === 'P' || c === 'H';
}

/**
 * Decide TDS for a bill.
 * @param billTaxable  taxable value of this bill (TDS is on the base, not GST)
 * @param fyPaidSoFar  taxable value billed by this vendor earlier in the FY
 *
 * Thresholds are crossed when the amount *exceeds* them, as the Act words it:
 * a ₹50,000 professional fee in a year with nothing else is not deducted.
 */
export function computeTds(opts: {
  rate: TdsRate | null | undefined;
  pan: string | null | undefined;
  billTaxable: Paise;
  fyPaidSoFar: Paise;
  lowerRatePct?: number; // lower-deduction certificate override
}): { applies: boolean; ratePct: number; basePaise: Paise; tdsPaise: Paise; reason: string } {
  const sec = opts.rate;
  if (!sec) return { applies: false, ratePct: 0, basePaise: 0, tdsPaise: 0, reason: 'No TDS section mapped' };

  const single = sec.thresholdSinglePaise;
  const annual = sec.thresholdAnnualPaise;
  const crossesSingle = single !== null && opts.billTaxable > single;
  const yearTotal = opts.fyPaidSoFar + opts.billTaxable;
  const crossesAnnual = annual !== null && yearTotal > annual;
  if (!crossesSingle && !crossesAnnual) {
    const limits = [
      single !== null ? `single ₹${single / 100}` : null,
      annual !== null ? `annual ₹${annual / 100}` : null,
    ].filter(Boolean).join(', ');
    return { applies: false, ratePct: 0, basePaise: 0, tdsPaise: 0, reason: `Below ${sec.code} thresholds (${limits})` };
  }

  // Purchase of goods is deducted only on what the year's purchases exceed the
  // threshold by, so the bill that crosses it is deducted on its excess alone.
  const basePaise = sec.onExcessOnly && annual !== null
    ? Math.min(opts.billTaxable, yearTotal - annual)
    : opts.billTaxable;

  const hasPan = !!opts.pan?.trim();
  const ratePct = opts.lowerRatePct
    ?? (!hasPan ? sec.rateNoPanPct : isIndividualPan(opts.pan) ? sec.rateIndividualPct : sec.rateOtherPct);
  const tdsPaise = Math.round((basePaise * ratePct) / 100);
  const why = crossesSingle ? 'single-payment threshold' : 'annual threshold';
  const panNote = hasPan ? '' : ` (no PAN → ${sec.rateNoPanPct}%)`;
  return {
    applies: true,
    ratePct,
    basePaise,
    tdsPaise,
    reason: `${sec.code} @ ${ratePct}% — ${why} crossed${panNote}`,
  };
}
