// Outward supplies under reverse charge — Zoho Books' "This transaction is
// applicable for reverse charge" on a quote, sales order or invoice.
//
// Under reverse charge (CGST Act s.9(3)/(4); notified services such as a GTA's
// or an advocate's) the *recipient* pays the GST to the government, not the
// supplier. So the supplier's document charges none and posts no output tax,
// but it still has to say that tax is payable on reverse charge and how much
// (Rule 46(p)), and GSTR-1 reports the invoice with rchrg "Y" and the tax the
// recipient owes. The rate stays on every line; only the amount moves to the
// buyer.

import type { DocTaxBreakup, Paise, SupplyType } from '../types';

const ZERO = { cgstPaise: 0 as Paise, sgstPaise: 0 as Paise, igstPaise: 0 as Paise, cessPaise: 0 as Paise };

/**
 * Whether a supply can be put under reverse charge: only to a registered buyer
 * (who can pay the tax and take the credit) on an ordinary taxable supply —
 * never an export, an SEZ supply or a nil-rated or exempt one.
 */
export function reverseChargeProblem(input: { buyerGstin: string | null | undefined; supplyType: SupplyType }): string | null {
  if (!input.buyerGstin?.trim()) return 'Reverse charge applies only to a registered buyer: add the customer’s GSTIN, or untick reverse charge.';
  if (input.supplyType !== 'intra' && input.supplyType !== 'inter') {
    return 'Reverse charge does not apply to an export, an SEZ supply or a nil-rated or exempt one.';
  }
  return null;
}

/** A costed document with its GST taken off: the buyer pays it. Rates, taxable values and HSN stay as they are. */
export function withoutTax<L extends { taxable: Paise; tax: DocTaxBreakup; total: Paise }, D extends { lines: L[]; tax: DocTaxBreakup }>(costed: D): D {
  return {
    ...costed,
    tax: { ...costed.tax, ...ZERO },
    lines: costed.lines.map((l) => ({ ...l, tax: { ...l.tax, ...ZERO }, total: l.taxable })),
  };
}

/**
 * The tax the recipient owes on a reverse-charge line: what the supplier would
 * have charged, at the line's rate — CGST and SGST in halves within a state,
 * IGST across states. Printed on the document and reported in GSTR-1.
 */
export function reverseChargeTax(taxablePaise: Paise, ratePct: number, intra: boolean): { cgstPaise: Paise; sgstPaise: Paise; igstPaise: Paise } {
  if (intra) {
    const half = Math.round((taxablePaise * ratePct) / 200) as Paise;
    return { cgstPaise: half, sgstPaise: half, igstPaise: 0 as Paise };
  }
  return { cgstPaise: 0 as Paise, sgstPaise: 0 as Paise, igstPaise: Math.round((taxablePaise * ratePct) / 100) as Paise };
}

/** Rule 46(p)'s words, as Zoho prints them on a reverse-charge document. */
export const REVERSE_CHARGE_NOTE = 'Tax is payable on reverse charge basis: the recipient pays the GST below to the government.';
