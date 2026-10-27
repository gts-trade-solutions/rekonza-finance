// ─────────────────────────────────────────────────────────────────────────────
// The rates that ship with the software.
//
// A book uses these until it holds rows of its own (tds_rates, tcs_rates); the
// first edit on the Tax rates screen copies them in, so the business's CA can
// correct any of them. Each one says where it was taken from, and none of them
// is verified: the sources are published rate charts, not the gazette, and a
// CA should check every row before the software is relied on for a filing.
//
// Researched on 22 October 2026. Rates are effective from the date given and
// apply until a later row for the same code replaces them.
// ─────────────────────────────────────────────────────────────────────────────

import type { Paise } from '../types';

export interface TdsRate {
  /** Stable key carried by vendors and bills: the 1961-Act section. */
  code: string;
  /** How the Income-tax Act, 2025 numbers it; used for payments from 1 April 2026. */
  actRef: string | null;
  nature: string;
  effectiveFrom: string;
  /** Individuals and HUFs (PAN 4th letter P or H). */
  rateIndividualPct: number;
  rateOtherPct: number;
  rateNoPanPct: number;
  /** TDS applies once a single payment exceeds this. */
  thresholdSinglePaise: Paise | null;
  /** …or once the year's total to the payee exceeds this. */
  thresholdAnnualPaise: Paise | null;
  /** Deduct only on the part above the annual threshold. */
  onExcessOnly: boolean;
  sourceUrl: string | null;
  verified: boolean;
}

export interface TcsRate {
  code: string;
  actRef: string | null;
  nature: string;
  effectiveFrom: string;
  ratePct: number;
  rateNoPanPct: number;
  /** Collected only on a sale above this, when set. */
  thresholdPaise: Paise | null;
  sourceUrl: string | null;
  verified: boolean;
}

/** The day the Income-tax Act, 2025 took over from the 1961 Act. */
export const ACT_2025_FROM = '2026-04-01';

const TDS_SOURCE = 'https://taxguru.in/income-tax/tds-rates-income-tax-act-2025-1-april-2026.html';
const TCS_SOURCE = 'https://cleartax.in/s/section-394-income-tax-act-2025';

const lakh = (n: number): Paise => n * 1_00_000_00;
const rupees = (n: number): Paise => n * 100;

/**
 * TDS on what a business pays its suppliers. Thresholds as revised for
 * FY 2025-26, which the Income-tax Act, 2025 carried forward unchanged.
 */
export const DEFAULT_TDS_RATES: TdsRate[] = [
  {
    code: '194C', actRef: '393(1) Table Sl. 6(i)', nature: 'Payments to contractors',
    effectiveFrom: '2025-04-01', rateIndividualPct: 1, rateOtherPct: 2, rateNoPanPct: 20,
    thresholdSinglePaise: rupees(30_000), thresholdAnnualPaise: lakh(1), onExcessOnly: false,
    sourceUrl: TDS_SOURCE, verified: false,
  },
  {
    code: '194H', actRef: '393(1) Table Sl. 1(ii)', nature: 'Commission or brokerage',
    effectiveFrom: '2025-04-01', rateIndividualPct: 2, rateOtherPct: 2, rateNoPanPct: 20,
    thresholdSinglePaise: null, thresholdAnnualPaise: rupees(20_000), onExcessOnly: false,
    sourceUrl: TDS_SOURCE, verified: false,
  },
  {
    // ₹50,000 for a month or part of a month: a monthly rent bill is one payment.
    code: '194I', actRef: '393(1) Table Sl. 2(ii)(b)', nature: 'Rent of land, building or furniture',
    effectiveFrom: '2025-04-01', rateIndividualPct: 10, rateOtherPct: 10, rateNoPanPct: 20,
    thresholdSinglePaise: rupees(50_000), thresholdAnnualPaise: null, onExcessOnly: false,
    sourceUrl: TDS_SOURCE, verified: false,
  },
  {
    code: '194I-PM', actRef: '393(1) Table Sl. 2(ii)(a)', nature: 'Rent of plant, machinery or equipment',
    effectiveFrom: '2025-04-01', rateIndividualPct: 2, rateOtherPct: 2, rateNoPanPct: 20,
    thresholdSinglePaise: rupees(50_000), thresholdAnnualPaise: null, onExcessOnly: false,
    sourceUrl: TDS_SOURCE, verified: false,
  },
  {
    code: '194J', actRef: '393(1) Table Sl. 6(iii)(b)', nature: 'Professional fees',
    effectiveFrom: '2025-04-01', rateIndividualPct: 10, rateOtherPct: 10, rateNoPanPct: 20,
    thresholdSinglePaise: null, thresholdAnnualPaise: rupees(50_000), onExcessOnly: false,
    sourceUrl: TDS_SOURCE, verified: false,
  },
  {
    code: '194J-TECH', actRef: '393(1) Table Sl. 6(iii)(a)', nature: 'Fees for technical services',
    effectiveFrom: '2025-04-01', rateIndividualPct: 2, rateOtherPct: 2, rateNoPanPct: 20,
    thresholdSinglePaise: null, thresholdAnnualPaise: rupees(50_000), onExcessOnly: false,
    sourceUrl: TDS_SOURCE, verified: false,
  },
  {
    code: '194Q', actRef: '393(1) Table Sl. 8(ii)', nature: 'Purchase of goods',
    effectiveFrom: '2025-04-01', rateIndividualPct: 0.1, rateOtherPct: 0.1, rateNoPanPct: 5,
    thresholdSinglePaise: null, thresholdAnnualPaise: lakh(50), onExcessOnly: true,
    sourceUrl: TDS_SOURCE, verified: false,
  },
];

/**
 * TCS on what a business sells. TCS on ordinary sales of goods (the 0.1% of
 * old section 206C(1H)) was removed from 1 April 2025; purchase of goods is
 * covered by TDS instead. What remains is collected on specific goods.
 */
export const DEFAULT_TCS_RATES: TcsRate[] = [
  {
    code: 'TCS-LIQUOR', actRef: '394(1) Table Sl. 1', nature: 'Alcoholic liquor for human consumption',
    effectiveFrom: '2026-04-01', ratePct: 2, rateNoPanPct: 5, thresholdPaise: null,
    sourceUrl: TCS_SOURCE, verified: false,
  },
  {
    code: 'TCS-FOREST', actRef: '394(1) Table Sl. 3', nature: 'Timber or other forest produce',
    effectiveFrom: '2026-04-01', ratePct: 2, rateNoPanPct: 5, thresholdPaise: null,
    sourceUrl: TCS_SOURCE, verified: false,
  },
  {
    code: 'TCS-SCRAP', actRef: '394(1) Table Sl. 4', nature: 'Scrap',
    effectiveFrom: '2026-04-01', ratePct: 2, rateNoPanPct: 5, thresholdPaise: null,
    sourceUrl: TCS_SOURCE, verified: false,
  },
  {
    code: 'TCS-MINERAL', actRef: '394(1) Table Sl. 5', nature: 'Coal, lignite or iron ore',
    effectiveFrom: '2026-04-01', ratePct: 2, rateNoPanPct: 5, thresholdPaise: null,
    sourceUrl: TCS_SOURCE, verified: false,
  },
  {
    code: 'TCS-VEHICLE', actRef: '394(1) Table Sl. 6', nature: 'Motor vehicle or notified goods above ₹10 lakh',
    effectiveFrom: '2026-04-01', ratePct: 1, rateNoPanPct: 5, thresholdPaise: lakh(10),
    sourceUrl: TCS_SOURCE, verified: false,
  },
  {
    code: 'TCS-LUXURY', actRef: '394(1) Table Sl. 10', nature: 'Notified luxury goods above ₹10 lakh',
    effectiveFrom: '2026-04-01', ratePct: 1, rateNoPanPct: 5, thresholdPaise: lakh(10),
    sourceUrl: TCS_SOURCE, verified: false,
  },
];

/**
 * The row in force on a date: the latest one that had started by then.
 * Before the earliest row there is no known rate, and null says so rather
 * than guessing at an older one.
 */
export function rateOn<T extends { code: string; effectiveFrom: string }>(
  rows: T[],
  code: string,
  date: string,
): T | null {
  let best: T | null = null;
  for (const r of rows) {
    if (r.code !== code || r.effectiveFrom > date) continue;
    if (!best || r.effectiveFrom > best.effectiveFrom) best = r;
  }
  return best;
}

/** Every code's row in force on a date. */
export function ratesOn<T extends { code: string; effectiveFrom: string }>(rows: T[], date: string): T[] {
  const codes = [...new Set(rows.map((r) => r.code))];
  return codes.map((c) => rateOn(rows, c, date)).filter((r): r is T => r !== null);
}

/** The section reference a return should use for a payment on this date. */
export function sectionLabel(rate: { code: string; actRef: string | null }, date: string): string {
  return date >= ACT_2025_FROM && rate.actRef ? `${rate.actRef} (earlier ${rate.code.split('-')[0]})` : rate.code.split('-')[0];
}
