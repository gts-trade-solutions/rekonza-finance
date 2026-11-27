// ─────────────────────────────────────────────────────────────────────────────
// The two withholding roles of GST, as rules both the server and the screens
// read: tax deducted at source by a deductor (CGST Act s.51, return GSTR-7) and
// tax collected at source by an e-commerce operator (s.52, return GSTR-8).
//
// Kept apart from the posting code so that the figure a person sees in the
// "Deduct GST TDS" window before they confirm is worked out by the very same
// function the server posts with — the two cannot round differently.
//
// GST TDS, section 51
//   Who: departments of the Central or a State Government, local authorities,
//   governmental agencies, and the persons notified under s.51(1)(d)
//   (Notification 33/2017-CT: bodies set up by Parliament or a legislature,
//   societies and PSUs of those governments).
//   What: 1% CGST + 1% SGST (or UTGST) on an intra-State supply, 2% IGST on an
//   inter-State one (s.20 IGST Act), on the payment made or credited to the
//   supplier of taxable goods or services, excluding the tax on the invoice
//   (Explanation to s.51(1)).
//   When not: where the total value of supply under the contract does not
//   exceed ₹2,50,000 (first proviso), and where the supplier and the place of
//   supply are both in a State other than the deductor's registration (second
//   proviso: that State's tax is not the deductor's to withhold).
//
// E-commerce TCS, section 52
//   What: TCS on the net value of taxable supplies made through the operator
//   by other suppliers, where the operator collects the consideration. 1% in
//   all (0.5% CGST + 0.5% SGST, or 1% IGST) until 9 July 2024; 0.5% (0.25% +
//   0.25%, or 0.5% IGST) from 10 July 2024 (Notification 15/2024-CT and
//   01/2024-IT, on the 53rd GST Council's recommendation). The rate in force on
//   the date the supplies are booked decides.
//   Section 9(5) supplies (restaurant, passenger transport, accommodation and
//   housekeeping services notified under it) are different: the operator is the
//   person liable to pay the tax itself, at the supply's own rate, so they are
//   left out of GSTR-8 and reported in GSTR-3B table 3.1.1(i) instead.
// ─────────────────────────────────────────────────────────────────────────────

/** The contract value at or below which no GST TDS is deducted (s.51(1), first proviso). */
export const GST_TDS_THRESHOLD_PAISE = 2_50_000_00;
/** 2% in all: 1% CGST + 1% SGST, or 2% IGST. */
export const GST_TDS_RATE_PCT = 2;
/** The day the e-commerce TCS rate halved (Notification 15/2024-CT). */
export const ECO_TCS_HALVED_FROM = '2024-07-10';

export interface WithholdingHeads {
  igstPaise: number;
  cgstPaise: number;
  sgstPaise: number;
}

export const NO_HEADS: WithholdingHeads = { igstPaise: 0, cgstPaise: 0, sgstPaise: 0 };
export const headsTotal = (h: WithholdingHeads) => h.igstPaise + h.cgstPaise + h.sgstPaise;

const pct = (paise: number, rate: number) => Math.round((paise * rate) / 100);

/** Split a rate over the heads: all IGST across States, half CGST and half SGST within one. */
export function splitHeads(basePaise: number, ratePct: number, inter: boolean): WithholdingHeads {
  if (inter) return { igstPaise: pct(basePaise, ratePct), cgstPaise: 0, sgstPaise: 0 };
  const half = pct(basePaise, ratePct / 2);
  return { igstPaise: 0, cgstPaise: half, sgstPaise: half };
}

export interface GstTdsWorking extends WithholdingHeads {
  applies: boolean;
  inter: boolean;
  ratePct: number;
  /** Why it is deducted the way it is, or why not at all, in words. */
  reason: string;
}

/**
 * GST TDS on one payment or credit to a supplier.
 *
 * `supplierState` is the State of the supplier's registration (the first two
 * digits of their GSTIN); `placeOfSupply` the State the supply is made in;
 * `recipientState` the State of the deductor's own registration.
 */
export function gstTdsHeads(o: {
  taxablePaise: number;
  contractValuePaise: number;
  supplierState: string;
  placeOfSupply: string;
  recipientState: string;
}): GstTdsWorking {
  const none = (reason: string): GstTdsWorking => ({ ...NO_HEADS, applies: false, inter: false, ratePct: 0, reason });
  if (!(o.taxablePaise > 0)) return none('Nothing paid or credited to deduct from.');
  if (o.contractValuePaise <= GST_TDS_THRESHOLD_PAISE) {
    return none('The contract is worth ₹2,50,000 or less (excluding tax), so section 51 does not apply to it.');
  }
  const inter = o.supplierState !== o.placeOfSupply;
  if (!inter && o.placeOfSupply !== o.recipientState) {
    return none(
      'The supplier and the place of supply are both in a State other than yours, so no TDS is deducted (second proviso to section 51(1)).',
    );
  }
  return {
    ...splitHeads(o.taxablePaise, GST_TDS_RATE_PCT, inter),
    applies: true,
    inter,
    ratePct: GST_TDS_RATE_PCT,
    reason: inter
      ? 'An inter-State supply: 2% IGST (section 51 read with section 20 of the IGST Act).'
      : 'An intra-State supply: 1% CGST and 1% SGST (section 51).',
  };
}

/** The e-commerce TCS rate on a date: 1% until 9 July 2024, 0.5% from 10 July 2024. */
export function ecoTcsRatePct(date: string): number {
  return date < ECO_TCS_HALVED_FROM ? 1 : 0.5;
}

/** The net value an operator's supplies are taxed on: supplies less what came back. */
export function ecoNetValue(v: { grossRegisteredPaise: number; returnsRegisteredPaise: number; grossUnregisteredPaise: number; returnsUnregisteredPaise: number }) {
  return v.grossRegisteredPaise - v.returnsRegisteredPaise + v.grossUnregisteredPaise - v.returnsUnregisteredPaise;
}

/**
 * The tax on one supplier's supplies through the operator in a month: TCS at
 * the rate of the day under s.52, or the supply's own GST under s.9(5). A
 * negative net (more returned than sold) gives negative heads: the TCS of an
 * earlier month coming back.
 */
export function ecoHeads(o: {
  section: '52' | '9_5';
  netPaise: number;
  date: string;
  inter: boolean;
  /** The supply's own GST rate, for s.9(5). */
  gstRatePct?: number;
}): WithholdingHeads & { ratePct: number } {
  const ratePct = o.section === '52' ? ecoTcsRatePct(o.date) : (o.gstRatePct ?? 0);
  const sign = o.netPaise < 0 ? -1 : 1;
  const h = splitHeads(Math.abs(o.netPaise), ratePct, o.inter);
  return { igstPaise: sign * h.igstPaise, cgstPaise: sign * h.cgstPaise, sgstPaise: sign * h.sgstPaise, ratePct };
}

/** Both returns fall due on the 10th of the next month (Rules 66(1) and 67(1)). */
export function withholdingDueDate(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return m === 12 ? `${y + 1}-01-10` : `${y}-${String(m + 1).padStart(2, '0')}-10`;
}

const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** The GSTIN's own mod-36 check character, over its first fourteen. */
export function gstinCheckChar(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = CHARS.indexOf(first14[i]);
    const prod = v * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(prod / 36) + (prod % 36);
  }
  return CHARS[(36 - (sum % 36)) % 36];
}

/**
 * What is wrong with the GSTIN a deductor or an operator registered under,
 * or null. A deductor's registration (Rule 12) has D as its 14th character and
 * is usually built on the TAN; an operator's TCS registration has C and is
 * built on the PAN. The check character is the same mod-36 as any GSTIN's.
 */
export function roleGstinProblem(gstin: string, role: 'tds' | 'tcs'): string | null {
  const g = gstin.trim().toUpperCase();
  const letter = role === 'tds' ? 'D' : 'C';
  const what = role === 'tds' ? 'A GST TDS registration' : 'An e-commerce TCS registration';
  if (!/^[0-9]{2}[0-9A-Z]{10}[1-9A-Z][0-9A-Z][0-9A-Z]$/.test(g)) return 'A GSTIN is 15 letters and digits, as on the registration certificate.';
  if (g[13] !== letter) return `${what} has ${letter} as its 14th character (this one has ${g[13]}).`;
  if (gstinCheckChar(g.slice(0, 14)) !== g[14]) return 'That GSTIN does not pass its check character. Check it against the registration certificate.';
  return null;
}
