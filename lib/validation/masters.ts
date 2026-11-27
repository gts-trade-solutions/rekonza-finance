// ─────────────────────────────────────────────────────────────────────────────
// The rules a customer, vendor or item must meet, written once and used by
// both the single-record forms (app/api/contacts, app/api/items) and the bulk
// import (lib/server/imports/run.ts). The auditors' point (status review 7,
// item 3): what an import accepts must be exactly what the form accepts, so
// neither can be looser than the other. Plain functions with no server code,
// so the screens can use them too.
//
// Each check returns problems as { field, value, message }: the field as the
// person sees it ("GSTIN"), what they typed, and a plain reason, so an import
// row reads "Row 7, GSTIN: 33ABCDE1234F1Z9 fails the GSTIN check digit".
// ─────────────────────────────────────────────────────────────────────────────

import { GST_STATES, isValidGstin } from '../tax/gst';
import { checkHsnCode, type HsnDigits } from '../tax/hsn';

export interface FieldProblem { field: string; value?: string | null; message: string }

export const GSTIN_SHAPE = /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]Z[A-Z0-9]$/;
export const PAN_SHAPE = /^[A-Z]{5}\d{4}[A-Z]$/;
/** The same test zod's .email() makes: something@something.something, no spaces. */
export const EMAIL_SHAPE = /^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9-]*\.)+[A-Za-z]{2,}$/;

/**
 * A telephone number: digits with the usual spaces, dashes, dots and
 * brackets, an optional + and country code, 7 to 15 digits in all (ITU-T
 * E.164 allows at most 15). After +91 an Indian number is ten digits.
 */
export function phoneProblem(raw: string | null | undefined, field = 'Phone'): FieldProblem | null {
  const v = (raw ?? '').trim();
  if (!v) return null;
  if (!/^\+?[\d\s().-]+$/.test(v)) return { field, value: v, message: `${v} is not a phone number: use digits, with + for the country code.` };
  const digits = v.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return { field, value: v, message: `${v} has ${digits.length} digits; a phone number has 7 to 15.` };
  // After +91 an Indian number (a mobile, or an STD code and number) is ten digits.
  if (v.startsWith('+91') && digits.length !== 12) return { field, value: v, message: `${v}: after +91 an Indian number has 10 digits.` };
  return null;
}

/** An Indian PIN code: six digits, the first not 0 (India Post). Only checked for an address in India. */
export function pinProblem(raw: string | null | undefined, country?: string | null, field = 'PIN code'): FieldProblem | null {
  const v = (raw ?? '').trim();
  if (!v) return null;
  if (country && !/^(IN|India)$/i.test(country)) return null;
  const compact = v.replace(/\s/g, '');
  if (!/^[1-9]\d{5}$/.test(compact)) return { field, value: v, message: `${v} is not a PIN code: it is six digits, and does not start with 0.` };
  return null;
}

export function emailProblem(raw: string | null | undefined, field = 'Email'): FieldProblem | null {
  const v = (raw ?? '').trim();
  if (!v) return null;
  return EMAIL_SHAPE.test(v) ? null : { field, value: v, message: `${v} is not an email address.` };
}

const REGISTERED = ['registered', 'registered_composition', 'sez', 'sez_developer', 'deemed_export', 'tax_deductor'];

/**
 * A customer's or vendor's tax and contact details, checked as the form
 * checks them. `stateCode` is the two-digit GST state.
 */
export function contactProblems(c: {
  gstin?: string | null; pan?: string | null; gstTreatment?: string | null; stateCode?: string | null; country?: string | null;
  email?: string | null; phone?: string | null; mobile?: string | null; pincode?: string | null; shippingPincode?: string | null;
}): FieldProblem[] {
  const out: FieldProblem[] = [];
  const gstin = c.gstin?.trim().toUpperCase() || null;
  const pan = c.pan?.trim().toUpperCase() || null;
  if (c.gstTreatment && REGISTERED.includes(c.gstTreatment) && !gstin) out.push({ field: 'GSTIN', message: 'A registered party needs its GSTIN / UIN.' });
  if (c.gstTreatment === 'overseas' && gstin) out.push({ field: 'GSTIN', value: gstin, message: 'An overseas party has no Indian GSTIN. Leave it empty, or choose another GST treatment.' });
  if (c.gstTreatment === 'overseas' && c.country === 'IN') out.push({ field: 'Country', value: c.country, message: 'An overseas party is outside India: give the country it is in.' });
  if (c.gstTreatment && c.gstTreatment !== 'overseas' && c.stateCode === '96') {
    out.push({ field: 'State', value: c.stateCode, message: 'This party is in India: give its state. State 96 is only for a party outside India.' });
  }
  if (c.stateCode && !GST_STATES[c.stateCode]) out.push({ field: 'State', value: c.stateCode, message: `${c.stateCode} is not a GST state code.` });
  if (gstin) {
    if (!GSTIN_SHAPE.test(gstin)) out.push({ field: 'GSTIN', value: gstin, message: `${gstin} is not a GSTIN: it is 15 characters, like 33AABCS1234F1Z5.` });
    // The fifteenth character is a check digit over the other fourteen: one
    // character mistyped fails it, and the IRP refuses an invoice carrying it.
    else if (!isValidGstin(gstin)) out.push({ field: 'GSTIN', value: gstin, message: `${gstin} fails the GSTIN check digit, so a character is wrong.` });
    else if (c.stateCode && gstin.slice(0, 2) !== c.stateCode) {
      out.push({ field: 'GSTIN', value: gstin, message: `${gstin} is registered in state ${gstin.slice(0, 2)} (${GST_STATES[gstin.slice(0, 2)] ?? 'unknown'}), not ${c.stateCode} (${GST_STATES[c.stateCode] ?? 'unknown'}). The first two digits of a GSTIN are its state.` });
    }
  }
  if (pan) {
    if (!PAN_SHAPE.test(pan)) out.push({ field: 'PAN', value: pan, message: `${pan} is not a PAN: it is five letters, four digits and a letter, like AABCS1234F.` });
    else if (gstin && GSTIN_SHAPE.test(gstin) && gstin.slice(2, 12) !== pan) out.push({ field: 'PAN', value: pan, message: `The PAN inside the GSTIN is ${gstin.slice(2, 12)}, not ${pan}. One of them is wrong.` });
  }
  const e = emailProblem(c.email);
  if (e) out.push(e);
  for (const [v, f] of [[c.phone, 'Phone'], [c.mobile, 'Mobile']] as const) {
    const p = phoneProblem(v, f);
    if (p) out.push(p);
  }
  for (const [v, f] of [[c.pincode, 'PIN code'], [c.shippingPincode, 'Shipping PIN code']] as const) {
    const p = pinProblem(v, c.country, f);
    if (p) out.push(p);
  }
  return out;
}

/**
 * The GST units of quantity (UQC) the GST portal accepts, as the item form
 * offers them. A unit outside this list is accepted only if the book already
 * uses it (a unit kept from before), as the form shows such a unit as "Your
 * unit"; anything else is a typing mistake ("PIECE" for PCS, "KG" for KGS)
 * that GSTR-1's HSN summary and the e-invoice refuse.
 */
export const GST_UNITS = new Set([
  'NOS', 'PCS', 'SET', 'PRS', 'BOX', 'PAC', 'CTN', 'DOZ', 'KGS', 'GMS', 'QTL', 'TON', 'MTS', 'LTR', 'MLT', 'KLR', 'MTR', 'CMS', 'KME',
  'SQF', 'SQM', 'SQY', 'CBM', 'CCM', 'YDS', 'GYD', 'BAG', 'BAL', 'BDL', 'BKL', 'BTL', 'BUN', 'CAN', 'DRM', 'ROL', 'TBS', 'TUB', 'UNT',
  'GGK', 'GRS', 'TGM', 'THD', 'BOU', 'UGS', 'OTH',
]);
/** What people write for a unit, as the GST code. */
export const UNIT_WORDS: Record<string, string> = {
  NO: 'NOS', NUMBER: 'NOS', NUMBERS: 'NOS', PC: 'PCS', PIECE: 'PCS', PIECES: 'PCS', KG: 'KGS', KGS: 'KGS', KILOGRAM: 'KGS', KILOGRAMS: 'KGS',
  G: 'GMS', GM: 'GMS', GRAM: 'GMS', GRAMS: 'GMS', L: 'LTR', LT: 'LTR', LITRE: 'LTR', LITRES: 'LTR', LITER: 'LTR', ML: 'MLT', M: 'MTR', METRE: 'MTR', METER: 'MTR',
  DOZEN: 'DOZ', PAIR: 'PRS', PAIRS: 'PRS', PACK: 'PAC', CARTON: 'CTN', BOTTLE: 'BTL', ROLL: 'ROL', UNIT: 'UNT', UNITS: 'UNT',
};

export function unitProblem(raw: string | null | undefined, known: Set<string> = new Set()): { unit: string | null; problem: FieldProblem | null } {
  const v = (raw ?? '').trim().toUpperCase();
  if (!v) return { unit: null, problem: null };
  const unit = GST_UNITS.has(v) || known.has(v) ? v : UNIT_WORDS[v.replace(/[^A-Z]/g, '')] ?? null;
  if (unit) return { unit, problem: null };
  return { unit: null, problem: { field: 'Unit', value: raw ?? '', message: `${raw} is not a GST unit (UQC). Use a code such as NOS, PCS, KGS, LTR, MTR or BOX.` } };
}

/** An item's codes and numbers, checked as the item form checks them. */
export function itemProblems(i: {
  kind: 'goods' | 'service'; hsnSac?: string | null; gstRatePct?: number | null; unit?: string | null;
  openingQty?: number | null; salePricePaise?: number | null; purchasePricePaise?: number | null;
}, ctx: { hsnDigits: HsnDigits; knownUnits?: Set<string>; gstRates: readonly number[] }): FieldProblem[] {
  const out: FieldProblem[] = [];
  if (i.hsnSac) {
    const check = checkHsnCode(i.hsnSac, { digits: ctx.hsnDigits, kind: i.kind });
    if (!check.ok) out.push({ field: 'HSN/SAC', value: i.hsnSac, message: check.problem ?? `${i.hsnSac} is not an HSN or SAC code.` });
  }
  if (i.gstRatePct != null && !ctx.gstRates.includes(i.gstRatePct)) {
    out.push({ field: 'GST rate', value: String(i.gstRatePct), message: `${i.gstRatePct}% is not a GST rate (${ctx.gstRates.join(', ')}).` });
  }
  if (i.unit) {
    const u = unitProblem(i.unit, ctx.knownUnits);
    if (u.problem) out.push(u.problem);
  }
  if (i.openingQty != null && i.openingQty < 0) out.push({ field: 'Opening quantity', value: String(i.openingQty), message: `${i.openingQty} is negative: opening stock cannot be below nothing.` });
  if (i.salePricePaise != null && i.salePricePaise < 0) out.push({ field: 'Sale price', value: String(i.salePricePaise / 100), message: 'A price cannot be negative.' });
  if (i.purchasePricePaise != null && i.purchasePricePaise < 0) out.push({ field: 'Purchase price', value: String(i.purchasePricePaise / 100), message: 'A price cannot be negative.' });
  return out;
}
