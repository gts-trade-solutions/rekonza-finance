// ─────────────────────────────────────────────────────────────────────────────
// When an e-way bill is needed, and how long it lasts.
//
// Client-safe on purpose. The invoice form should be able to say "this
// consignment will need an e-way bill" while it is being typed, not discover
// it afterwards on a separate screen — by which time the lorry may already
// have left.
//
// Every rule here has a consequence measured in a detained vehicle, so where
// the law is ambiguous this file errs towards *requiring* a bill. Generating
// one that was not strictly needed costs nothing. Not generating one that was
// costs the goods and the vehicle.
// ─────────────────────────────────────────────────────────────────────────────

import type { Paise } from '../types';

/** ₹50,000. The figure in the rule itself, and the floor everywhere. */
export const BASE_THRESHOLD_PAISE: Paise = 50_000_00;

/**
 * Intra-state thresholds, where a state has raised its own above the ₹50,000
 * floor. Movement between two states is always ₹50,000 regardless.
 *
 * ── This table needs a CA's sign-off before it is trusted. ──
 *
 * States notify these individually, several have narrowed them to specific
 * goods rather than raising them across the board, and they change without
 * much announcement. What is here reflects the commonly published figures and
 * is deliberately conservative: a state whose position is unclear is left at
 * the ₹50,000 floor, which over-collects rather than under-collects.
 *
 * Treated as data, not as constants, so correcting one is an edit here and not
 * a hunt through the codebase.
 */
export const INTRA_STATE_THRESHOLD_PAISE: Record<string, Paise> = {
  '03': 100_000_00, // Punjab
  '07': 100_000_00, // Delhi
  '08': 100_000_00, // Rajasthan
  '10': 100_000_00, // Bihar — some sources cite ₹2,00,000; kept low until confirmed
  '19': 100_000_00, // West Bengal
  '20': 100_000_00, // Jharkhand — above ₹1,00,000 for goods other than specified ones
  '23': 100_000_00, // Madhya Pradesh — applies to specified goods only
  '27': 100_000_00, // Maharashtra
  '33': 100_000_00, // Tamil Nadu
};

export function thresholdPaise(fromStateCode: string, toStateCode: string): Paise {
  if (fromStateCode !== toStateCode) return BASE_THRESHOLD_PAISE;
  return INTRA_STATE_THRESHOLD_PAISE[fromStateCode] ?? BASE_THRESHOLD_PAISE;
}

/**
 * No e-way bill can be raised against a document older than this. In force
 * from 1 January 2025, and there is no relief from it — a back-dated challan
 * simply cannot move goods.
 */
export const MAX_DOC_AGE_DAYS = 180;

/** Validity can never be pushed past this, counted from first generation. */
export const MAX_TOTAL_VALIDITY_DAYS = 360;

/** Kilometres per day of validity. Over-dimensional cargo gets a tenth of it. */
export const KM_PER_DAY = 200;
export const KM_PER_DAY_ODC = 20;

/** Part B can be extended only inside this window either side of expiry. */
export const EXTEND_WINDOW_HOURS = 8;

/**
 * Why the goods are moving. Only some of these are sales — which is the point,
 * and the reason an e-way bill register that only looks at invoices misses
 * most of the risk.
 */
export type MovementReason =
  | 'supply'            // an ordinary sale
  | 'job_work'          // material out to a job worker: no sale, still moves
  | 'job_work_returns'
  | 'own_use'           // branch transfer, or moving your own equipment
  | 'sales_return'
  | 'line_sales'
  | 'exhibition'
  | 'export'
  | 'import'
  | 'skd_ckd'
  | 'recipient_not_known'
  | 'others';

export interface EwayBillInput {
  /** Services never move, so they never need one. */
  supplyKind: 'goods' | 'service' | 'both';
  /** Invoice value including tax, excluding any exempt goods on the same document. */
  consignmentPaise: Paise;
  fromStateCode: string;
  toStateCode: string;
  reason: MovementReason;
  /**
   * True when the law treats the supply as inter-state whatever the map says.
   *
   * A supply to an SEZ unit or developer is inter-state by statute (IGST Act,
   * s.7(5)) even when the SEZ sits in the seller's own state — and so is an
   * export. Only intra-state supplies earn a state's higher threshold, so
   * testing these against the physical states would wave through a lorry to
   * an SEZ in the next district that legally needed a bill.
   */
  interStateSupply?: boolean;
  /** yyyy-mm-dd. Against the 180-day limit. */
  docDate: string;
  /**
   * The dispatching branch's own intra-state threshold, set in Settings where
   * its state's notification differs from the table above. Never below ₹50,000.
   */
  intraThresholdPaise?: Paise | null;
  /** Injected so tests do not depend on the clock. */
  today?: string;
  /**
   * Goods on the Rule 138(14) exempt annexure, or moved by non-motorised
   * transport. Caller's judgement — we do not hold the annexure as data yet.
   */
  exempt?: boolean;
}

export interface EwayBillAssessment {
  required: boolean;
  /** One sentence, showable in the UI as-is. */
  reason: string;
  /** The figure that was actually applied, so the UI can explain itself. */
  thresholdPaise: Paise | null;
  /** Reasons a bill cannot be generated at all, even though one is needed. */
  blockers: string[];
  warnings: string[];
}

const daysBetween = (fromIso: string, toIso: string): number =>
  Math.floor((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);

const rupees = (paise: Paise): string =>
  `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

/**
 * Two movements need a bill whatever they are worth, because the threshold was
 * written for sales and these are not sales — a consignment of material out to
 * a job worker in another state has no invoice value to test against.
 */
const NO_THRESHOLD_INTERSTATE: ReadonlySet<MovementReason> = new Set<MovementReason>([
  'job_work',
  'job_work_returns',
]);

export function assessEwayBill(input: EwayBillInput): EwayBillAssessment {
  const today = input.today ?? new Date().toISOString().slice(0, 10);
  const blockers: string[] = [];
  const warnings: string[] = [];

  const age = daysBetween(input.docDate.slice(0, 10), today);
  if (age > MAX_DOC_AGE_DAYS) {
    blockers.push(
      `The document is ${age} days old. Since January 2025 no e-way bill can be generated against ` +
        `anything older than ${MAX_DOC_AGE_DAYS} days, and there is no way round it.`,
    );
  }

  if (input.supplyKind === 'service') {
    return {
      required: false,
      reason: 'Services do not move, so no e-way bill applies.',
      thresholdPaise: null,
      blockers: [],
      warnings: [],
    };
  }

  if (input.exempt) {
    return {
      required: false,
      reason: 'Marked as exempt goods or non-motorised transport.',
      thresholdPaise: null,
      blockers: [],
      warnings: ['Exemption is claimed on this document rather than derived — check it is right.'],
    };
  }

  // Two different questions, and conflating them was a bug. Whether the goods
  // physically cross a state border decides the job-work rule, which is about
  // the lorry. Whether the *supply* is inter-state decides the threshold,
  // which is about the law — and a supply to an SEZ is inter-state even when
  // the lorry never leaves the state.
  const crossesBorder = input.fromStateCode !== input.toStateCode;
  const interState = crossesBorder || !!input.interStateSupply;
  const deemed = interState && !crossesBorder;

  if (crossesBorder && NO_THRESHOLD_INTERSTATE.has(input.reason)) {
    return {
      required: true,
      reason:
        input.reason === 'job_work'
          ? 'Goods going to another state for job work need an e-way bill whatever they are worth.'
          : 'Job-work goods returning from another state need an e-way bill whatever they are worth.',
      thresholdPaise: null,
      blockers,
      warnings,
    };
  }

  // A state's higher limit is for intra-state supplies only. A deemed
  // inter-state supply gets the ₹50,000 floor, wherever the SEZ happens to be.
  const limit = interState
    ? BASE_THRESHOLD_PAISE
    : Math.max(BASE_THRESHOLD_PAISE, input.intraThresholdPaise ?? thresholdPaise(input.fromStateCode, input.toStateCode));

  if (input.supplyKind === 'both') {
    warnings.push(
      'This document mixes goods and services. Only the goods count towards the threshold, so the ' +
        'figure tested here may be higher than the consignment actually is.',
    );
  }

  // Said out loud when it applies, because "inside the state, but ₹50,000" is
  // exactly the result a user would otherwise report as a bug.
  const deemedNote = deemed
    ? ' A supply to an SEZ, or for export, counts as inter-state even inside one state.'
    : '';

  if (input.consignmentPaise <= limit) {
    return {
      required: false,
      reason: interState
        ? `${rupees(input.consignmentPaise)} is within the ${rupees(limit)} inter-state threshold.${deemedNote}`
        : `${rupees(input.consignmentPaise)} is within ${rupees(limit)}, the threshold for movement inside this state.`,
      thresholdPaise: limit,
      blockers: [],
      warnings,
    };
  }

  return {
    required: true,
    reason: deemed
      ? `${rupees(input.consignmentPaise)} of goods, over the ${rupees(limit)} inter-state threshold.${deemedNote}`
      : interState
        ? `${rupees(input.consignmentPaise)} of goods moving between states, over the ${rupees(limit)} threshold.`
        : `${rupees(input.consignmentPaise)} of goods moving inside the state, over its ${rupees(limit)} threshold.`,
    thresholdPaise: limit,
    blockers,
    warnings,
  };
}

// ── Validity ─────────────────────────────────────────────────────────────────

/** One day per 200 km, or per 20 km for over-dimensional cargo. Minimum one. */
export function validityDays(distanceKm: number, isOverDimensional = false): number {
  const per = isOverDimensional ? KM_PER_DAY_ODC : KM_PER_DAY;
  return Math.max(1, Math.ceil(Math.max(0, distanceKm) / per));
}

/**
 * When a bill expires.
 *
 * Two things about this are easy to get wrong and both cost a detention.
 *
 * It is counted from when **Part B** was first supplied, not from generation —
 * so the caller passes the Part B timestamp, and a bill with no Part B has no
 * expiry because it does not authorise movement yet.
 *
 * And it runs to **midnight** of the last day, not to the same clock time.
 * A one-day bill entered at 6pm expires six hours later, not twenty-four.
 */
export function validUntil(
  partBAt: Date,
  distanceKm: number,
  isOverDimensional = false,
): Date {
  const days = validityDays(distanceKm, isOverDimensional);
  const end = new Date(partBAt);
  // Day one is the day Part B was entered, so a one-day bill ends tonight.
  end.setDate(end.getDate() + (days - 1));
  end.setHours(23, 59, 59, 0);
  return end;
}

/** Whether an extension is possible right now — 8 hours either side of expiry. */
export function canExtend(
  validUntilAt: Date,
  generatedAt: Date,
  now: Date = new Date(),
): { allowed: boolean; reason: string } {
  const windowMs = EXTEND_WINDOW_HOURS * 3_600_000;
  const opens = validUntilAt.getTime() - windowMs;
  const closes = validUntilAt.getTime() + windowMs;

  if (now.getTime() < opens) {
    const hours = Math.ceil((opens - now.getTime()) / 3_600_000);
    return {
      allowed: false,
      reason: `Too early. Extension opens ${EXTEND_WINDOW_HOURS} hours before expiry — about ${hours} hour(s) away.`,
    };
  }
  if (now.getTime() > closes) {
    return {
      allowed: false,
      reason:
        `The extension window closed ${EXTEND_WINDOW_HOURS} hours after expiry. This bill cannot be ` +
        'revived — the consignment needs a fresh one.',
    };
  }

  const totalDays = Math.floor((now.getTime() - generatedAt.getTime()) / 86_400_000);
  if (totalDays >= MAX_TOTAL_VALIDITY_DAYS) {
    return {
      allowed: false,
      reason:
        `This bill was generated ${totalDays} days ago. Validity cannot be extended past ` +
        `${MAX_TOTAL_VALIDITY_DAYS} days from generation.`,
    };
  }

  return { allowed: true, reason: 'Within the extension window.' };
}

/**
 * Vehicle number, in the format NIC accepts: no punctuation, upper case.
 * Returns null when it cannot plausibly be one, so a caller can say so rather
 * than sending something that bounces.
 */
export function normaliseVehicleNo(input: string): string | null {
  const v = input.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  // Between a defence registration and a standard state one, real numbers run
  // from 7 to 11 characters. Anything outside that is a typo.
  if (v.length < 7 || v.length > 11) return null;
  return v;
}

// ── After generation ─────────────────────────────────────────────────────────

/** A bill can be cancelled for this long after it is generated, and never after. */
export const CANCEL_WINDOW_HOURS = 24;

/** When a bill generated at `generatedAt` stops being cancellable. Null without a generation time. */
export function ewbCancelDeadline(generatedAt: Date | string | null | undefined): Date | null {
  if (!generatedAt) return null;
  const t = new Date(generatedAt).getTime();
  return Number.isNaN(t) ? null : new Date(t + CANCEL_WINDOW_HOURS * 3_600_000);
}

// The reasons the portal accepts, by its own codes, as NIC's e-way bill API
// publishes them. Anything else is refused; free text belongs in the remark.

export type VehicleChangeReason = '1' | '2' | '3' | '4';
export const VEHICLE_CHANGE_REASONS: Record<VehicleChangeReason, string> = {
  '1': 'Vehicle broke down',
  '2': 'Transhipment',
  '3': 'Other',
  '4': 'First time',
};

export type EwbExtendReason = '1' | '2' | '4' | '5' | '99';
export const EWB_EXTEND_REASONS: Record<EwbExtendReason, string> = {
  '1': 'Natural calamity',
  '2': 'Law and order',
  '4': 'Transhipment',
  '5': 'Accident',
  '99': 'Other',
};

export type EwbCancelReason = '1' | '2' | '3' | '4';
export const EWB_CANCEL_REASONS: Record<EwbCancelReason, string> = {
  '1': 'Duplicate',
  '2': 'Order cancelled',
  '3': 'Data entry mistake',
  '4': 'Other',
};
