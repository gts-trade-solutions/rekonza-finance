// The shape of GSTR-9 as lib/server/gst/gstr9.ts works it out, shared by the
// server and by the screen (through lib/api/client.ts), so what the screen
// draws is exactly what the return holds. Amounts are in paise.

import type { Paise } from '../types';
import type { TaxHead } from '../server/gst/set-off';

export interface TaxHeads {
  taxablePaise: Paise;
  cgstPaise: Paise;
  sgstPaise: Paise;
  igstPaise: Paise;
  cessPaise: Paise;
}

/** Credit of one kind split the way tables 6B to 6E ask: inputs, capital goods, input services. */
export interface ByCreditType { inputs: TaxHeads; capitalGoods: TaxHeads; inputServices: TaxHeads }

export interface HsnSummaryRow {
  code: string;
  description: string | null;
  uqc: string;
  qty: number;
  ratePct: number;
  taxablePaise: Paise;
  cgstPaise: Paise;
  sgstPaise: Paise;
  igstPaise: Paise;
  cessPaise: Paise;
}

/** One head's line in table 9: what was payable, paid in cash, and paid by each credit. */
export interface Table9Row {
  head: TaxHead;
  payablePaise: Paise;
  paidInCashPaise: Paise;
  /** The credit of each head that met this head's liability (s.49(5), Rule 88A). */
  itc: Record<TaxHead, Paise>;
  paidThroughItcPaise: Paise;
}

/** What the preparer enters: the rows no document in the books can supply. */
export interface Gstr9Inputs {
  /** 6K and 6L: transition credit (CGST and SGST only). */
  tran1: { cgstPaise: Paise; sgstPaise: Paise };
  tran2: { cgstPaise: Paise; sgstPaise: Paise };
  /** 6M: any other credit availed and not shown above. */
  otherItc: { description: string; igstPaise: Paise; cgstPaise: Paise; sgstPaise: Paise; cessPaise: Paise }[];
  /** 7F and 7G: transition credit reversed. */
  tran1Reversed: { cgstPaise: Paise; sgstPaise: Paise };
  tran2Reversed: { cgstPaise: Paise; sgstPaise: Paise };
  /** 7H: other reversals, each described. */
  otherReversals: { description: string; igstPaise: Paise; cgstPaise: Paise; sgstPaise: Paise; cessPaise: Paise }[];
  /** Table 15, row by row (A to G). */
  table15: Record<Table15Key, Table15Amounts>;
  /** 19: the late fee paid with the return. */
  lateFeePaid: { cgstPaise: Paise; sgstPaise: Paise };
  /** Table 9: penalty and other amounts paid in cash during the year. */
  penaltyPaise: Paise;
  otherPaidPaise: Paise;
}

export type Table15Key = 'refundClaimed' | 'refundSanctioned' | 'refundRejected' | 'refundPending' | 'demand' | 'demandPaid' | 'demandPending';
export interface Table15Amounts {
  igstPaise: Paise; cgstPaise: Paise; sgstPaise: Paise; cessPaise: Paise;
  interestPaise: Paise; penaltyPaise: Paise; lateFeePaise: Paise;
}
export const TABLE15_KEYS: Table15Key[] = ['refundClaimed', 'refundSanctioned', 'refundRejected', 'refundPending', 'demand', 'demandPaid', 'demandPending'];

/** One line of the GL tie-out: the ledgers against the return, with the difference and why. */
export interface TieOutLine {
  key: 'output' | 'rcm' | 'input';
  label: string;
  booksPaise: Paise;
  returnPaise: Paise;
  differencePaise: Paise;
  /** Known reasons, each with its amount; whatever they do not cover is `unexplainedPaise`. */
  reasons: { label: string; paise: Paise }[];
  unexplainedPaise: Paise;
}

export interface Gstr9 {
  /** e.g. '2026-27' */
  fy: string;
  startYear: number;
  from: string;
  to: string;
  gstin: string | null;
  legalName: string;
  tradeName: string | null;
  /** Whether the year's turnover was above ₹5 crore: six-digit HSN in tables 17 and 18. */
  aatoAbove5Cr: boolean;
  hsnDigits: 4 | 6;
  /** The year is still running: the return is a draft of what it will say. */
  draft: boolean;
  /** Nothing supplied, received or claimed: a nil return. */
  isNil: boolean;
  table4: {
    b2c: TaxHeads;            // 4A
    b2b: TaxHeads;            // 4B
    exportsWithTax: TaxHeads; // 4C
    sezWithTax: TaxHeads;     // 4D
    deemedExports: TaxHeads;  // 4E
    /** Advances taxed on receipt and not yet invoiced: received less adjusted in the year. */
    advances: TaxHeads;       // 4F
    rcmInward: TaxHeads;      // 4G
    ecoPays: TaxHeads;        // 4G1
    subtotalAG: TaxHeads;     // 4H
    creditNotes: TaxHeads;    // 4I, shown negative
    /** Debit notes carrying tax (CGST Act s.34(3)): they add to the year's supplies. */
    debitNotes: TaxHeads;     // 4J
    amendmentsPlus: TaxHeads; // 4K
    amendmentsMinus: TaxHeads; // 4L
    subtotalIL: TaxHeads;     // 4M
    total: TaxHeads;          // 4N
  };
  table5: {
    zeroRated: Paise;         // 5A
    sez: Paise;               // 5B
    reverseCharge: Paise;     // 5C
    ecoSupplies: Paise;       // 5C1
    exempt: Paise;            // 5D
    nil: Paise;               // 5E
    nonGst: Paise;            // 5F
    subtotalAF: Paise;        // 5G
    creditNotes: Paise;       // 5H, negative
    debitNotes: Paise;        // 5I
    amendmentsPlus: Paise;    // 5J
    amendmentsMinus: Paise;   // 5K
    subtotalHK: Paise;        // 5L
    notTaxable: Paise;        // 5M
    totalTurnover: Paise;     // 5N
  };
  table6: {
    itc3b: TaxHeads;          // 6A
    previousYear: TaxHeads;   // 6A1
    thisYear: TaxHeads;       // 6A2
    inward: ByCreditType;     // 6B
    rcmUnregistered: ByCreditType; // 6C
    rcmRegistered: ByCreditType;   // 6D
    importGoods: { inputs: TaxHeads; capitalGoods: TaxHeads }; // 6E
    importServices: TaxHeads; // 6F
    isd: TaxHeads;            // 6G
    reclaimed: TaxHeads;      // 6H
    subtotalBH: TaxHeads;     // 6I
    difference: TaxHeads;     // 6J
    tran1: TaxHeads;          // 6K
    tran2: TaxHeads;          // 6L
    other: TaxHeads;          // 6M
    otherDetail: Gstr9Inputs['otherItc'];
    subtotalKM: TaxHeads;     // 6N
    total: TaxHeads;          // 6O
    /** 6E in total, as earlier screens and tests read it. */
    imports: TaxHeads;
  };
  table7: {
    rule37: TaxHeads;         // 7A
    rule39: TaxHeads;         // 7B
    rule42: TaxHeads;         // 7C
    rule43: TaxHeads;         // 7D
    section17_5: TaxHeads;    // 7E
    tran1: TaxHeads;          // 7F
    tran2: TaxHeads;          // 7G
    other: TaxHeads;          // 7H
    otherDetail: Gstr9Inputs['otherReversals'];
    total: TaxHeads;          // 7I
    netAvailable: TaxHeads;   // 7J
  };
  table8: {
    asPer2b: TaxHeads;        // 8A
    asPerTable6: TaxHeads;    // 8B
    nextYear: TaxHeads;       // 8C
    difference: TaxHeads;     // 8D
    notAvailed: TaxHeads;     // 8E
    ineligible: TaxHeads;     // 8F
    importIgstPaid: TaxHeads; // 8G
    importIgstAvailed: TaxHeads; // 8H
    importDifference: TaxHeads;  // 8I
    importNotAvailed: TaxHeads;  // 8J
    lapsed: TaxHeads;         // 8K
  };
  table9: Table9Row[];
  table9Other: {
    interest: { payablePaise: Paise; paidPaise: Paise };
    lateFee: { payablePaise: Paise; paidPaise: Paise };
    penalty: { payablePaise: Paise; paidPaise: Paise };
    other: { payablePaise: Paise; paidPaise: Paise };
    /** The return periods the year was filed for, and how many had their payment recorded. */
    periods: string[];
    recordedPayments: number;
  };
  table10: TaxHeads;          // 10: declared through amendments (+), net of debit notes
  table11: TaxHeads;          // 11: reduced through amendments (−), net of credit notes
  table12: TaxHeads;          // 12: reversal of ITC availed in the previous year
  table13: TaxHeads;          // 13: ITC of this year availed in the next
  table14: { head: TaxHead | 'INTEREST'; payablePaise: Paise; paidPaise: Paise }[];
  table15: Record<Table15Key, Table15Amounts>;
  table16: {
    composition: Paise;       // 16A: value only
    deemedSupply: TaxHeads;   // 16B
    approval: TaxHeads;       // 16C
  };
  table17: HsnSummaryRow[];
  table18: HsnSummaryRow[];
  table19: {
    dueDate: string;
    filedOn: string | null;
    daysLate: number;
    cgst: { payablePaise: Paise; paidPaise: Paise };
    sgst: { payablePaise: Paise; paidPaise: Paise };
    basis: string;
  };
  tieOut: TieOutLine[];
  inputs: Gstr9Inputs;
  /**
   * Earlier screens read these: table 7's vendor-credit figure and table 8's
   * book side. Kept so they keep working.
   */
  legacy: { vendorCreditsPaise: Paise };
  /**
   * Claimable credit on this year's bills that the year's returns did not
   * take (held back after matching GSTR-2B, or claimed later): in the
   * ledgers, not in 7J. GSTR-9C table 12C.
   */
  deferredCreditPaise: Paise;
  notes: string[];
}

