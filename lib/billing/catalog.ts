// ─────────────────────────────────────────────────────────────────────────────
// What the AI assistant costs.
//
// One file, read by the server when it charges and by the browser when it
// shows a price, so the two can never quote different numbers. Changing a price
// here changes it everywhere, and existing subscribers keep the price they
// signed up for (see billing_plan_links).
//
// The unit is the credit. A question is charged the credits its tokens actually
// cost — the way API token billing works — rather than a flat fee per question,
// so a one-line balance check costs less than a quarter-by-quarter analysis.
//
//   1 credit  ≈ US$0.003 of model cost at the default model (AI_CREDIT_COST_USD)
//   a typical question uses 1–3 credits
//
// Every price here is before GST. GST is added at checkout and shown on the
// tax invoice, the way Indian B2B software is sold and the way a customer's
// accountant expects to claim the input credit.
//
// Framework-neutral on purpose: no React, no server imports.
// ─────────────────────────────────────────────────────────────────────────────

/** Credits are stored as integer millicredits, so fractional charges are exact. */
export const MC_PER_CREDIT = 1000;

/** GST on software services. The server may override it (BILLING_GST_RATE). */
export const DEFAULT_GST_RATE_PCT = 18;

/** Used only to translate credits into "about N questions" for people. */
export const TYPICAL_CREDITS_PER_QUESTION = 2;

// ── Plans ────────────────────────────────────────────────────────────────────

export type PlanCode = 'starter' | 'growth' | 'business';
export type BillingPeriod = 'monthly' | 'yearly';

export interface PlanDef {
  code: PlanCode;
  name: string;
  tagline: string;
  /** Before GST. */
  monthlyPaise: number;
  /** Before GST. Ten months' price: two months free for paying a year ahead. */
  yearlyPaise: number;
  /** Granted at the start of every month of the plan, and not carried over. */
  creditsPerMonth: number;
  highlights: string[];
}

export const PLANS: PlanDef[] = [
  {
    code: 'starter',
    name: 'Starter',
    tagline: 'For an owner who checks the numbers weekly.',
    monthlyPaise: 499_00,
    yearlyPaise: 4_990_00,
    creditsPerMonth: 400,
    highlights: ['400 credits every month', 'About 200 questions', 'Top up any time'],
  },
  {
    code: 'growth',
    name: 'Growth',
    tagline: 'For a finance team that asks every day.',
    monthlyPaise: 1_499_00,
    yearlyPaise: 14_990_00,
    creditsPerMonth: 1_500,
    highlights: ['1,500 credits every month', 'About 750 questions', 'Per-user monthly limits'],
  },
  {
    code: 'business',
    name: 'Business',
    tagline: 'For accountants and firms running many questions.',
    monthlyPaise: 3_999_00,
    yearlyPaise: 39_990_00,
    creditsPerMonth: 5_000,
    highlights: ['5,000 credits every month', 'About 2,500 questions', 'Lowest price per credit'],
  },
];

// ── Top-up packs ─────────────────────────────────────────────────────────────

export type PackCode = 'pack_100' | 'pack_500' | 'pack_2000';

export interface PackDef {
  code: PackCode;
  credits: number;
  /** Before GST. */
  pricePaise: number;
}

/** Bought once, no subscription needed. Dearer per credit than a plan. */
export const PACKS: PackDef[] = [
  { code: 'pack_100', credits: 100, pricePaise: 149_00 },
  { code: 'pack_500', credits: 500, pricePaise: 599_00 },
  { code: 'pack_2000', credits: 2_000, pricePaise: 1_999_00 },
];

/** Top-up credits last a year from purchase; plan credits last their month. */
export const TOPUP_VALIDITY_DAYS = 365;

/** Granted once, the first time an admin turns the assistant on. */
export const TRIAL_CREDITS = 50;
export const TRIAL_DAYS = 30;

// ── Detailed reports ─────────────────────────────────────────────────────────

/**
 * An answer that comes with a detailed report — key figures, a chart and a
 * table — is charged its tokens plus this share, for building the report. At
 * least a tenth of a credit on top, and still never more than the question
 * reserved.
 */
export const REPORT_MARKUP_PCT = 15;
export const REPORT_MIN_SURCHARGE_MC = 100;

/**
 * Downloading a report, as an image or a spreadsheet. Each person's first
 * download is free; after that each new report costs this. The same report
 * again, in either format, costs nothing — it has been paid for.
 */
export const REPORT_DOWNLOAD_CREDITS = 1;
export const FREE_REPORT_DOWNLOADS = 1;

// ── Helpers ──────────────────────────────────────────────────────────────────

export const planByCode = (code: string): PlanDef | undefined => PLANS.find((p) => p.code === code);
export const packByCode = (code: string): PackDef | undefined => PACKS.find((p) => p.code === code);

export const planPricePaise = (plan: PlanDef, period: BillingPeriod): number =>
  period === 'yearly' ? plan.yearlyPaise : plan.monthlyPaise;

/** A price before GST, split into what the customer pays. */
export function withGst(taxablePaise: number, ratePct: number): {
  taxablePaise: number;
  gstPaise: number;
  totalPaise: number;
} {
  const gstPaise = Math.round((taxablePaise * ratePct) / 100);
  return { taxablePaise, gstPaise, totalPaise: taxablePaise + gstPaise };
}

export const creditsFromMc = (mc: number): number => mc / MC_PER_CREDIT;

/**
 * 312.4, 2.1, 500 — one decimal when there is one, none when there is not.
 * Rounded down: showing 1.0 credit when 0.96 remain would promise a question
 * the wallet cannot pay for.
 */
export function formatCredits(mc: number): string {
  const tenths = Math.floor(Math.abs(mc) / 100) * (mc < 0 ? -1 : 1);
  const whole = tenths % 10 === 0;
  return (tenths / 10).toLocaleString('en-IN', {
    minimumFractionDigits: whole ? 0 : 1,
    maximumFractionDigits: 1,
  });
}

/** A charge, rounded up to the tenth: a 0.04-credit question shows as 0.1, never 0. */
export function formatCharge(mc: number): string {
  const tenths = Math.ceil(mc / 100);
  return (tenths / 10).toLocaleString('en-IN', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

/** Rupees per credit, for comparing a plan with a pack. */
export const paisePerCredit = (pricePaise: number, credits: number): number => pricePaise / credits;
