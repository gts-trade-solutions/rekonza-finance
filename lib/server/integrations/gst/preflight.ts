import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Checking an invoice before the portal does.
//
// The IRP rejects a document with a numeric code and a terse string — `2172`,
// `Duplicate IRN`, `Invalid HSN code(s)-2201` — with no indication of which
// line, and it counts as an attempt either way. Handing that to a user is
// useless: they cannot act on it, and the same invoice bounces again.
//
// So every rule the portal enforces that we can check ourselves, we check
// ourselves, and say which field on which line is wrong in words somebody can
// act on. That is worth building even before a GSP exists — it is the
// difference between "rejected, code 2201" and "line 3 has no HSN code".
//
// Warnings are for things the portal accepts today that will hurt later: a
// 4-digit HSN when six are required at this turnover, or a 12% rate that GST
// 2.0 abolished. They never block a submission.
// ─────────────────────────────────────────────────────────────────────────────

import { isValidGstin, GST_STATES } from '../../../tax/gst';
import type { EinvoiceSource, EinvoiceLine } from './einvoice-payload';
import { isServiceLine } from './einvoice-payload';

export type Severity = 'error' | 'warning';

export interface Problem {
  /** Where to send the user. Dotted, and line-scoped where it applies. */
  field: string;
  message: string;
  severity: Severity;
}

export interface PreflightResult {
  ok: boolean;
  errors: Problem[];
  warnings: Problem[];
}

export interface PreflightOptions {
  /**
   * The 30-day reporting window is a hard stop only above ₹10 crore turnover.
   * Below that an old invoice is still accepted, so blocking it would be us
   * inventing a rule.
   */
  aatoAbove10Cr?: boolean;
  /** Six-digit HSN is mandatory above ₹5 crore; four is enough below it. */
  aatoAbove5Cr?: boolean;
  /** Injected so the tests are not a hostage to the clock. */
  today?: string;
}

// ── Reference data ───────────────────────────────────────────────────────────

/**
 * The official unit-of-quantity codes. An invented one — 'PIECE' instead of
 * 'PCS', 'KG' instead of 'KGS' — is a rejection, and it is the mistake people
 * make when typing a unit by hand rather than picking it.
 */
export const UQC_CODES = new Set([
  'BAG', 'BAL', 'BDL', 'BKL', 'BOU', 'BOX', 'BTL', 'BUN', 'CAN', 'CBM', 'CCM',
  'CMS', 'CTN', 'DOZ', 'DRM', 'GGK', 'GMS', 'GRS', 'GYD', 'KGS', 'KLR', 'KME',
  'MLT', 'MTR', 'MTS', 'NOS', 'PAC', 'PCS', 'PRS', 'QTL', 'ROL', 'SET', 'SQF',
  'SQM', 'SQY', 'TBS', 'TGM', 'THD', 'TON', 'TUB', 'UGS', 'UNT', 'YDS', 'OTH',
]);

/**
 * Every rate the IRP will accept, including ones no longer used on new
 * supplies. The historical rates have to stay: a credit note raised today
 * against a 2024 invoice carries that invoice's rate, and rejecting it would
 * make old documents impossible to correct.
 */
const ACCEPTED_RATES = new Set([0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 7.5, 12, 18, 28, 40]);

/** GST 2.0 abolished the 12% and 28% slabs from this date. */
const GST_2_0_FROM = '2025-09-22';
const WITHDRAWN_RATES = new Set([12, 28]);

/** GST itself began here. A document dated before it cannot be registered. */
const GST_EPOCH = '2017-07-01';

/** The IRP's own tolerance on every computed total: one rupee. */
const TOLERANCE_PAISE = 100;

// ── Small helpers ────────────────────────────────────────────────────────────

const isBlank = (v: string | null | undefined): boolean => !v || v.trim() === '';

const daysBetween = (fromIso: string, toIso: string): number =>
  Math.floor((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);

const isOverseas = (t: EinvoiceSource['supplyType']): boolean =>
  t === 'export_lut' || t === 'export_with_tax';

// ── The check ────────────────────────────────────────────────────────────────

export function preflightEinvoice(
  src: EinvoiceSource,
  opts: PreflightOptions = {},
): PreflightResult {
  const problems: Problem[] = [];
  const err = (field: string, message: string) =>
    problems.push({ field, message, severity: 'error' });
  const warn = (field: string, message: string) =>
    problems.push({ field, message, severity: 'warning' });

  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const overseas = isOverseas(src.supplyType);

  checkDocument(src, today, opts, err, warn);
  checkSeller(src, err);
  checkBuyer(src, overseas, err, warn);
  checkTaxDirection(src, overseas, err);
  checkLines(src, opts, err, warn);
  checkTotals(src, err);
  if (overseas) checkExport(src, err, warn);

  return {
    ok: !problems.some((p) => p.severity === 'error'),
    errors: problems.filter((p) => p.severity === 'error'),
    warnings: problems.filter((p) => p.severity === 'warning'),
  };
}

// ── Document ─────────────────────────────────────────────────────────────────

function checkDocument(
  src: EinvoiceSource,
  today: string,
  opts: PreflightOptions,
  err: (f: string, m: string) => void,
  warn: (f: string, m: string) => void,
) {
  const no = src.number ?? '';

  if (isBlank(no)) {
    err('number', 'The document has no number.');
  } else {
    // Real portal rules, and all three catch numbering schemes that look
    // perfectly reasonable in a book but are refused at registration.
    if (no.length > 16) {
      err('number', `Invoice number "${no}" is ${no.length} characters. The portal allows 16.`);
    }
    if (!/^[A-Za-z0-9/-]+$/.test(no)) {
      err(
        'number',
        `Invoice number "${no}" has characters the portal rejects. Only letters, digits, "/" and "-" ` +
          'are allowed — no spaces, hashes or brackets.',
      );
    }
    if (/^[0/-]/.test(no)) {
      err(
        'number',
        `Invoice number "${no}" starts with "${no[0]}". The portal refuses numbers beginning with 0, ` +
          '"/" or "-", so the numbering series needs a prefix.',
      );
    }
  }

  const date = src.date?.slice(0, 10) ?? '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    err('date', 'The document has no usable date.');
    return;
  }

  if (date > today) {
    err('date', `The invoice is dated ${date}, in the future. The portal will not register it.`);
  }
  if (date < GST_EPOCH) {
    err('date', `The invoice is dated ${date}, before GST began on ${GST_EPOCH}.`);
  }

  const age = daysBetween(date, today);
  if (age > 30) {
    if (opts.aatoAbove10Cr) {
      err(
        'date',
        `The invoice is ${age} days old. Above ₹10 crore turnover the portal refuses anything past ` +
          `30 days, so this one can no longer be made valid — raise a credit note and re-invoice.`,
      );
    } else {
      warn(
        'date',
        `The invoice is ${age} days old. It can still be registered at this turnover, but once the ` +
          'business crosses ₹10 crore the 30-day limit becomes a hard stop.',
      );
    }
  }
}

// ── Seller ───────────────────────────────────────────────────────────────────

function checkSeller(src: EinvoiceSource, err: (f: string, m: string) => void) {
  const s = src.seller;

  if (isBlank(s.gstin)) {
    err('seller.gstin', 'This branch has no GSTIN, so it cannot register invoices.');
  } else if (!isValidGstin(s.gstin!)) {
    err('seller.gstin', `The branch GSTIN ${s.gstin} fails its checksum — it is mistyped.`);
  } else if (!isBlank(s.stateCode) && s.gstin!.slice(0, 2) !== s.stateCode) {
    // The first two digits of a GSTIN *are* the state. A mismatch means one of
    // the two was typed wrong, and the portal checks it.
    err(
      'seller.stateCode',
      `The branch GSTIN begins ${s.gstin!.slice(0, 2)} (${GST_STATES[s.gstin!.slice(0, 2)] ?? 'unknown'}) ` +
        `but its state is set to ${s.stateCode} (${GST_STATES[s.stateCode!] ?? 'unknown'}). One of them is wrong.`,
    );
  }

  if (isBlank(s.legalName)) err('seller.legalName', 'This branch has no legal name.');
  if (isBlank(s.address1)) err('seller.address1', 'This branch has no address.');
  if (isBlank(s.city)) {
    err('seller.city', 'This branch has no city. The portal requires it as a separate field.');
  }
  checkPincode(s.pincode, 'seller.pincode', 'this branch', err);
}

// ── Buyer ────────────────────────────────────────────────────────────────────

function checkBuyer(
  src: EinvoiceSource,
  overseas: boolean,
  err: (f: string, m: string) => void,
  warn: (f: string, m: string) => void,
) {
  const b = src.buyer;

  if (isBlank(b.legalName)) err('buyer.legalName', 'The customer has no legal name.');
  if (isBlank(b.address1)) err('buyer.address1', 'The customer has no address.');
  if (isBlank(b.city)) {
    err('buyer.city', 'The customer has no city. The portal requires it as a separate field.');
  }

  if (overseas) {
    // Nothing more to check: an export buyer is sent with state 96 and PIN
    // 999999 by convention, whatever their real address says.
    return;
  }

  if (isBlank(b.gstin)) {
    err(
      'buyer.gstin',
      'The customer has no GSTIN. Only business-to-business supplies are registered — add the GSTIN, ' +
        'or mark the customer unregistered so this invoice is left out.',
    );
  } else if (!isValidGstin(b.gstin!)) {
    err('buyer.gstin', `The customer GSTIN ${b.gstin} fails its checksum — it is mistyped.`);
  }

  checkPincode(b.pincode, 'buyer.pincode', 'the customer', err);

  const pos = src.placeOfSupply;
  if (isBlank(pos)) {
    err('placeOfSupply', 'The invoice has no place of supply.');
  } else if (!GST_STATES[pos]) {
    err('placeOfSupply', `Place of supply "${pos}" is not a GST state code.`);
  }

  // Not an error — a customer can legitimately be billed at one address and
  // the supply be made in another state — but it is the commonest cause of a
  // supply being taxed the wrong way round, so it is worth surfacing.
  if (!isBlank(b.gstin) && !isBlank(pos) && b.gstin!.slice(0, 2) !== pos) {
    warn(
      'placeOfSupply',
      `The customer is registered in ${GST_STATES[b.gstin!.slice(0, 2)] ?? b.gstin!.slice(0, 2)} but the ` +
        `place of supply is ${GST_STATES[pos] ?? pos}. Correct if the goods really are delivered there.`,
    );
  }
}

function checkPincode(
  pin: string | null | undefined,
  field: string,
  who: string,
  err: (f: string, m: string) => void,
) {
  if (isBlank(pin)) {
    err(field, `No PIN code for ${who}. The portal requires a 6-digit PIN on both parties.`);
  } else if (!/^[1-9]\d{5}$/.test(pin!.trim())) {
    err(field, `"${pin}" is not a valid PIN code — it must be six digits and cannot start with 0.`);
  }
}

// ── Which tax applies ────────────────────────────────────────────────────────

/**
 * A supply is taxed one way or the other, never both.
 *
 * Within a state it is CGST plus SGST; across states it is IGST. Sending an
 * invoice carrying both, or carrying the wrong one for the states involved, is
 * rejected — and it is the signature of a place of supply that was edited
 * after the lines were priced.
 */
function checkTaxDirection(
  src: EinvoiceSource,
  overseas: boolean,
  err: (f: string, m: string) => void,
) {
  const cgst = src.lines.reduce((t, l) => t + l.cgstPaise, 0);
  const sgst = src.lines.reduce((t, l) => t + l.sgstPaise, 0);
  const igst = src.lines.reduce((t, l) => t + l.igstPaise, 0);

  if (overseas || src.supplyType === 'sez') {
    if (src.supplyType !== 'export_with_tax' && (cgst || sgst || igst)) {
      err(
        'lines.tax',
        'A zero-rated supply carries tax. An export under a letter of undertaking, or an SEZ supply, ' +
          'is billed without GST.',
      );
    }
    return;
  }

  if (src.supplyType === 'nil_or_exempt') {
    if (cgst || sgst || igst) err('lines.tax', 'A nil-rated or exempt invoice carries GST.');
    return;
  }

  const intra = src.supplyType === 'intra';

  if (intra && igst > 0) {
    err(
      'lines.tax',
      'This is a supply within one state but the lines carry IGST. Within a state it is CGST plus SGST.',
    );
  }
  if (!intra && (cgst > 0 || sgst > 0)) {
    err(
      'lines.tax',
      'This is a supply between states but the lines carry CGST and SGST. Across states it is IGST.',
    );
  }
  if (intra && cgst !== sgst) {
    // The two halves are equal by construction. If they are not, something has
    // edited one of them, and the portal recomputes and rejects.
    err(
      'lines.tax',
      `CGST (₹${(cgst / 100).toFixed(2)}) and SGST (₹${(sgst / 100).toFixed(2)}) differ. They are always ` +
        'the same half of the tax.',
    );
  }
}

// ── Lines ────────────────────────────────────────────────────────────────────

function checkLines(
  src: EinvoiceSource,
  opts: PreflightOptions,
  err: (f: string, m: string) => void,
  warn: (f: string, m: string) => void,
) {
  if (src.lines.length === 0) {
    err('lines', 'The invoice has no lines.');
    return;
  }
  if (src.lines.length > 1000) {
    err('lines', `The invoice has ${src.lines.length} lines. The portal accepts 1000 per document.`);
  }

  const gst2 = src.date >= GST_2_0_FROM;

  for (const l of src.lines) {
    const at = `lines.${l.lineNo}`;
    const isService = isServiceLine(l.hsnSac, src.supplyKind);
    const what = l.description?.trim() || `line ${l.lineNo}`;

    if (isBlank(l.description)) err(`${at}.description`, `Line ${l.lineNo} has no description.`);

    // HSN. Mandatory on everything, and the digit count is a turnover rule.
    if (isBlank(l.hsnSac)) {
      err(
        `${at}.hsnSac`,
        `"${what}" has no HSN code. Every line needs one — set it on the item so it stops recurring.`,
      );
    } else {
      const hsn = l.hsnSac!.trim();
      if (!/^\d{4}(\d{2}(\d{2})?)?$/.test(hsn)) {
        err(
          `${at}.hsnSac`,
          `HSN "${hsn}" on "${what}" is not a valid code. It must be 4, 6 or 8 digits.`,
        );
      } else if (opts.aatoAbove5Cr && hsn.length < 6) {
        warn(
          `${at}.hsnSac`,
          `HSN "${hsn}" on "${what}" is ${hsn.length} digits. Above ₹5 crore turnover six are required.`,
        );
      }
    }

    // Quantity and unit, on goods only.
    if (!isService) {
      if (!(l.qty > 0)) {
        err(`${at}.qty`, `"${what}" has a quantity of ${l.qty}. Goods lines need a positive quantity.`);
      }
      if (isBlank(l.uqc)) {
        err(`${at}.uqc`, `"${what}" has no unit of measure.`);
      } else if (!UQC_CODES.has(l.uqc!.trim().toUpperCase())) {
        err(
          `${at}.uqc`,
          `Unit "${l.uqc}" on "${what}" is not one the portal recognises. Use its code — KGS, NOS, ` +
            'PCS, MTR, LTR as LTR is not valid so use MLT, and OTH for anything else.',
        );
      }
    }

    // Rate.
    if (!ACCEPTED_RATES.has(l.gstRatePct)) {
      err(
        `${at}.gstRatePct`,
        `GST rate ${l.gstRatePct}% on "${what}" is not a rate the portal accepts.`,
      );
    } else if (gst2 && WITHDRAWN_RATES.has(l.gstRatePct)) {
      warn(
        `${at}.gstRatePct`,
        `"${what}" is at ${l.gstRatePct}%. GST 2.0 abolished that slab on ${GST_2_0_FROM} — check whether ` +
          'this should now be 5% or 18%.',
      );
    }

    checkLineArithmetic(l, at, what, err);
  }
}

/**
 * The portal recomputes every line and rejects a mismatch beyond a rupee.
 *
 * Worth checking here because a mismatch means our own stored figures
 * disagree with each other, which is a bug in the book rather than in the
 * submission — and it is much cheaper to find now.
 */
function checkLineArithmetic(
  l: EinvoiceLine,
  at: string,
  what: string,
  err: (f: string, m: string) => void,
) {
  const taxes = l.cgstPaise + l.sgstPaise + l.igstPaise + l.cessPaise;
  const expected = l.taxablePaise + taxes;

  if (Math.abs(l.lineTotalPaise - expected) > TOLERANCE_PAISE) {
    err(
      `${at}.lineTotal`,
      `"${what}" totals ₹${(l.lineTotalPaise / 100).toFixed(2)} but its taxable value plus tax comes to ` +
        `₹${(expected / 100).toFixed(2)}. The portal recomputes this and will reject the difference.`,
    );
  }

  // The tax charged has to be the stated rate of the taxable value. A rate
  // that was changed after the line was priced shows up exactly here.
  if (l.taxablePaise > 0 && l.gstRatePct > 0) {
    const expectedTax = Math.round((l.taxablePaise * l.gstRatePct) / 100);
    const charged = l.cgstPaise + l.sgstPaise + l.igstPaise;
    if (charged > 0 && Math.abs(charged - expectedTax) > TOLERANCE_PAISE) {
      err(
        `${at}.gstRatePct`,
        `"${what}" is marked ${l.gstRatePct}% but carries ₹${(charged / 100).toFixed(2)} of tax on a ` +
          `taxable value of ₹${(l.taxablePaise / 100).toFixed(2)}, which is ₹${(expectedTax / 100).toFixed(2)} ` +
          'at that rate.',
      );
    }
  }
}

// ── Document totals ──────────────────────────────────────────────────────────

function checkTotals(src: EinvoiceSource, err: (f: string, m: string) => void) {
  const assessable = src.lines.reduce((t, l) => t + l.taxablePaise, 0);
  const taxes = src.lines.reduce(
    (t, l) => t + l.cgstPaise + l.sgstPaise + l.igstPaise + l.cessPaise,
    0,
  );
  const other = src.shippingChargePaise + src.adjustmentPaise;
  const expected = assessable + taxes + other + src.roundOffPaise;

  if (Math.abs(src.totalPaise - expected) > TOLERANCE_PAISE) {
    err(
      'total',
      `The invoice total is ₹${(src.totalPaise / 100).toFixed(2)} but its parts add up to ` +
        `₹${(expected / 100).toFixed(2)} — taxable ₹${(assessable / 100).toFixed(2)}, tax ` +
        `₹${(taxes / 100).toFixed(2)}, other charges ₹${(other / 100).toFixed(2)}, rounding ` +
        `₹${(src.roundOffPaise / 100).toFixed(2)}. The portal allows a rupee of difference, not this.`,
    );
  }

  if (src.totalPaise <= 0) {
    err('total', 'The invoice total is zero or negative, so there is nothing to register.');
  }
}

// ── Exports ──────────────────────────────────────────────────────────────────

function checkExport(
  src: EinvoiceSource,
  err: (f: string, m: string) => void,
  warn: (f: string, m: string) => void,
) {
  const e = src.export;

  if (!e?.currency) {
    warn(
      'export.currency',
      'No invoice currency recorded. An export is billed in foreign currency and the portal takes the ' +
        'code — this app has no multi-currency support yet, so it will go as INR.',
    );
  }
  if (!e?.countryCode) {
    warn('export.countryCode', 'No destination country recorded for this export.');
  }
  // Not required at registration — a shipping bill is usually filed after the
  // invoice — but without it the refund cannot later be matched, and that
  // match is the whole reason to capture it.
  if (src.supplyType === 'export_with_tax' && !e?.shippingBillNo) {
    warn(
      'export.shippingBillNo',
      'No shipping bill number. It can be added later, but the IGST refund is paid by matching this ' +
        "invoice against the shipping bill, and a mismatch there is why refunds stall.",
    );
  }
}

// ── Presenting the result ────────────────────────────────────────────────────

/**
 * One line summarising why a submission was refused, for an API error message.
 * Lists the first few and counts the rest — a wall of thirty is unreadable.
 */
export function summarise(result: PreflightResult, limit = 3): string {
  if (result.errors.length === 0) return '';
  const shown = result.errors.slice(0, limit).map((p) => p.message);
  const rest = result.errors.length - shown.length;
  return rest > 0
    ? `${shown.join(' ')} (and ${rest} more problem${rest === 1 ? '' : 's'}.)`
    : shown.join(' ');
}
