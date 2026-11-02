// The documents besides the invoice that print, save as a PDF, go by email
// and open from a link or the portal, as each does in Zoho Books: quotes,
// sales orders, delivery challans, credit notes, retainer invoices, payment
// receipts, purchase orders, vendor credits, payment advices and bills.
// lib/server/services/document-print.ts reads one into this shape and
// components/print/document-print.tsx sets it out.

import type { PrintTemplate } from './print-template';

export type PrintKind =
  | 'estimate' | 'sales-order' | 'challan' | 'credit-note' | 'retainer' | 'payment-received'
  | 'purchase-order' | 'vendor-credit' | 'payment-made' | 'bill';

export const PRINT_KINDS: PrintKind[] = [
  'estimate', 'sales-order', 'challan', 'credit-note', 'retainer', 'payment-received',
  'purchase-order', 'vendor-credit', 'payment-made', 'bill',
];

export const isPrintKind = (v: unknown): v is PrintKind => typeof v === 'string' && (PRINT_KINDS as string[]).includes(v);

/** Whose document it is: the customer's or the vendor's. */
export const PRINT_SIDE: Record<PrintKind, 'customer' | 'vendor'> = {
  estimate: 'customer', 'sales-order': 'customer', challan: 'customer', 'credit-note': 'customer', retainer: 'customer', 'payment-received': 'customer',
  'purchase-order': 'vendor', 'vendor-credit': 'vendor', 'payment-made': 'vendor', bill: 'vendor',
};

/** What a person calls one, in a sentence: "quote QT-12". */
export const PRINT_NOUN: Record<PrintKind, string> = {
  estimate: 'quote', 'sales-order': 'sales order', challan: 'delivery challan', 'credit-note': 'credit note', retainer: 'retainer invoice',
  'payment-received': 'payment receipt', 'purchase-order': 'purchase order', 'vendor-credit': 'vendor credit', 'payment-made': 'payment advice', bill: 'bill',
};

/** Which can be emailed: a bill is the vendor's own document, kept for the record. */
export const EMAILABLE: Record<PrintKind, boolean> = {
  estimate: true, 'sales-order': true, challan: true, 'credit-note': true, retainer: true, 'payment-received': true,
  'purchase-order': true, 'vendor-credit': true, 'payment-made': true, bill: false,
};

/** Which can be cloned: the ones that post nothing and move no stock. */
export const CLONABLE: Record<PrintKind, boolean> = {
  estimate: true, 'sales-order': true, challan: false, 'credit-note': false, retainer: false, 'payment-received': false,
  'purchase-order': true, 'vendor-credit': false, 'payment-made': false, bill: false,
};

export interface PrintParty {
  label: string;
  name: string;
  address: string | null;
  city: string | null;
  pincode: string | null;
  stateCode: string | null;
  /** Undefined: not printed at all (an unregistered business has no GSTIN line). */
  gstin?: string | null;
  email?: string | null;
  phone?: string | null;
}

export interface PrintLine {
  description: string | null;
  hsnSac: string | null;
  qty: number | null;
  uqc: string | null;
  ratePaise: number | null;
  discountPct: number;
  taxablePaise: number;
  gstRatePct: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  cessPaise: number;
  totalPaise: number;
}

export interface PrintDoc {
  kind: PrintKind;
  id: string;
  number: string;
  /** What it is called on paper: "Quotation", "Delivery Challan", "Receipt Voucher" … */
  title: string;
  /** Words the law wants on its face, or that say what it is against. */
  endorsement: string | null;
  date: string;
  status: string;
  /** Stamped on the sheet: a draft, or a cancelled document. */
  tag: 'Draft' | 'Cancelled' | null;
  /** The copies it prints in (a challan travels in triplicate, Rule 55). */
  copies: string[];
  seller: PrintParty & {
    tradeName: string | null;
    pan: string | null;
    logoUrl: string | null;
    signatoryName: string | null;
    printLanguage: string | null;
    template: PrintTemplate;
  };
  party: PrintParty;
  partyId: string;
  shipTo: PrintParty | null;
  placeOfSupply: string | null;
  /** intra (CGST + SGST), inter (IGST), or no tax columns at all. */
  taxColumns: 'split' | 'integrated' | 'none';
  /** The rows beside the parties: number, dates, reference, mode … */
  facts: { label: string; value: string }[];
  lines: PrintLine[];
  totals: { label: string; paise: number }[];
  totalLabel: string;
  totalPaise: number;
  /** After the total: paid, applied, balance due. */
  after: { label: string; paise: number }[];
  /** A payment's invoices or bills, or a credit's applications. */
  allocations: { label: string; rows: { number: string; date: string | null; paise: number }[] } | null;
  notes: string | null;
  terms: string | null;
}
