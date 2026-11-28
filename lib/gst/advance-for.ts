// ─────────────────────────────────────────────────────────────────────────────
// What a customer's advance is for, and so whether GST is due on it now.
//
// CGST Act s.13(2): the time of supply of services is the earlier of the
// invoice and the receipt of payment, so GST on an advance for services is due
// in the month the money arrives (GSTR-1 table 11A, GSTR-3B 3.1(a)), and comes
// off in the month the advance is set against an invoice that charges it (table
// 11B). Goods have been exempt from this since Notification 66/2017-Central
// Tax: tax on goods waits for the invoice.
//
// The receipt form used to offer a tick box, off unless ticked, so an advance
// for services went untaxed unless someone knew to tick it (auditor check,
// 2026-11-28). These rules make the question explicit: answered in advance for
// a book that sells only goods or only services, asked outright for a book
// that sells both, and a GST-registered book cannot save an advance unanswered.
// ─────────────────────────────────────────────────────────────────────────────

export type AdvanceFor = 'goods' | 'services';

/** The answer a book can give before anyone is asked: from what it sells (Settings → GST, "supplies"). */
export function defaultAdvanceFor(supplies: 'goods' | 'services' | 'both' | null | undefined): AdvanceFor | null {
  return supplies === 'services' ? 'services' : supplies === 'goods' ? 'goods' : null;
}

export interface AdvanceContext {
  /** What is left over after the invoices applied, in paise. */
  excessPaise: number;
  /** A receipt in another currency is an export of services: zero-rated, no advance tax here. */
  foreign: boolean;
  /** Only a regular GST registration charges tax on an advance. */
  gstRegistration: string | null | undefined;
  advanceFor: AdvanceFor | null;
  ratePct: number;
}

/** Whether the question has to be answered on this receipt at all. */
export const advanceQuestionApplies = (c: Pick<AdvanceContext, 'excessPaise' | 'foreign' | 'gstRegistration'>) =>
  c.excessPaise > 0 && !c.foreign && c.gstRegistration === 'regular';

/** What stops the receipt being saved, in the form's words; null when nothing does. */
export function advanceProblem(c: AdvanceContext): string | null {
  if (!advanceQuestionApplies(c)) return null;
  if (!c.advanceFor) return 'Say what the advance is for: services (GST is due on it now) or goods (no GST until the invoice).';
  if (c.advanceFor === 'services' && !(c.ratePct > 0 && c.ratePct <= 40)) return 'Give the GST rate of the services the advance is for.';
  return null;
}

/** The payment's advanceGst field (lib/server/payment-input.ts): set only for an advance for services. */
export function advanceGstField(c: AdvanceContext): { ratePct: number } | undefined {
  return advanceQuestionApplies(c) && c.advanceFor === 'services' ? { ratePct: c.ratePct } : undefined;
}

/** The GST inside an advance (the amount includes it), as the server works it out. */
export const advanceTaxPaise = (excessPaise: number, ratePct: number) => Math.round((excessPaise * ratePct) / (100 + ratePct));
