import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// GSTR-9, the annual return (CGST Act s.44, Rule 80), table by table, worked
// out from the year's documents.
//
// GSTR-9 restates the year a registration has already reported month by
// month: what it supplied with tax (table 4) and without (5), the credit it
// took (6) and reversed (7), how that credit compares with what suppliers
// filed in GSTR-2B (8), the tax it paid and how (9), what of this year was
// corrected or claimed in the next year's returns up to 30 November (10 to
// 14), demands and refunds (15), supplies from composition dealers, deemed
// supplies of job work and goods on approval (16), HSN summaries (17, 18)
// and the late fee (19).
//
// Every figure comes from the documents themselves — invoices, debit and
// credit notes, bills, expenses, bills of entry, advances, the ITC reversal
// registers — never from a stored summary, and table 6A and table 9 are the
// monthly GSTR-3B computations added up, so the annual return and the monthly
// ones tell one story. Rows the books cannot know (TRAN-1/TRAN-2 credit,
// demands and refunds, the late fee paid) are entered by the preparer and kept
// in the settings table (scope 'gstr9', one row per financial year).
//
// The rows follow the form as amended for FY 2023-24 onwards (Notification
// 12/2024-Central Tax): 4G1 for supplies on which an e-commerce operator pays
// the tax under s.9(5), 5C1 for the supplier's side of the same, and 6A1 /
// 6A2 to separate credit of the year before that was claimed in this year's
// GSTR-3B.
//
// Credit follows the GSTR-2B decisions recorded against each bill
// (gst_itc_claims): a bill whose credit was held back, or claimed in a later
// month, is reported where it was actually claimed — so credit of this year
// claimed in the next year's returns up to 30 November (s.16(4) as amended by
// the Finance Act, 2022) appears in tables 8C and 13, and credit never claimed
// in 8E and 8K, as lapsed.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor } from '../db';
import type { Paise } from '../../types';
import { toPaiseFromSql } from '../money-sql';
import { CODE } from '../ledger/chart-of-accounts';
import { advancesForMonth } from './advances';
import { monthRange } from './returns';
import { gstr3bForm } from './gstr3b-form';
import { TAX_HEADS, type TaxHead } from './set-off';
import { calendarProfile } from '../tax/compliance-calendar';

// ── Shapes ───────────────────────────────────────────────────────────────────

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

// ── Arithmetic on heads ──────────────────────────────────────────────────────

const zero = (): TaxHeads => ({ taxablePaise: 0, cgstPaise: 0, sgstPaise: 0, igstPaise: 0, cessPaise: 0 });
const add = (a: TaxHeads, b: TaxHeads): TaxHeads => ({
  taxablePaise: a.taxablePaise + b.taxablePaise,
  cgstPaise: a.cgstPaise + b.cgstPaise,
  sgstPaise: a.sgstPaise + b.sgstPaise,
  igstPaise: a.igstPaise + b.igstPaise,
  cessPaise: a.cessPaise + b.cessPaise,
});
const neg = (a: TaxHeads): TaxHeads => ({
  taxablePaise: -a.taxablePaise, cgstPaise: -a.cgstPaise, sgstPaise: -a.sgstPaise,
  igstPaise: -a.igstPaise, cessPaise: -a.cessPaise,
});
const sum = (...xs: TaxHeads[]) => xs.reduce(add, zero());
const taxOnly = (h: TaxHeads): TaxHeads => ({ ...h, taxablePaise: 0 });
export const taxOf = (h: TaxHeads) => h.cgstPaise + h.sgstPaise + h.igstPaise + h.cessPaise;
const isZero = (h: TaxHeads) => !h.taxablePaise && !taxOf(h);
const sumTypes = (b: ByCreditType) => sum(b.inputs, b.capitalGoods, b.inputServices);
const emptyTypes = (): ByCreditType => ({ inputs: zero(), capitalGoods: zero(), inputServices: zero() });

type Heads = { taxable: string; cgst: string; sgst: string; igst: string; cess: string };
const p = toPaiseFromSql;
const heads = (r: Partial<Heads> | undefined, sign = 1): TaxHeads => r
  ? {
      taxablePaise: sign * p(r.taxable ?? '0'), cgstPaise: sign * p(r.cgst ?? '0'), sgstPaise: sign * p(r.sgst ?? '0'),
      igstPaise: sign * p(r.igst ?? '0'), cessPaise: sign * p(r.cess ?? '0'),
    }
  : zero();
const day = (v: unknown) => String(v).slice(0, 10);

// ── Periods ──────────────────────────────────────────────────────────────────

/** The twelve months of the financial year starting April `startYear`, as YYYY-MM. */
export const fyMonths = (startYear: number) => Array.from({ length: 12 }, (_, i) => {
  const m = ((3 + i) % 12) + 1;
  const y = m >= 4 ? startYear : startYear + 1;
  return `${y}-${String(m).padStart(2, '0')}`;
});

const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

// ── Inputs ───────────────────────────────────────────────────────────────────

const zero15 = (): Table15Amounts => ({ igstPaise: 0, cgstPaise: 0, sgstPaise: 0, cessPaise: 0, interestPaise: 0, penaltyPaise: 0, lateFeePaise: 0 });

export function emptyGstr9Inputs(): Gstr9Inputs {
  return {
    tran1: { cgstPaise: 0, sgstPaise: 0 },
    tran2: { cgstPaise: 0, sgstPaise: 0 },
    otherItc: [],
    tran1Reversed: { cgstPaise: 0, sgstPaise: 0 },
    tran2Reversed: { cgstPaise: 0, sgstPaise: 0 },
    otherReversals: [],
    table15: Object.fromEntries(TABLE15_KEYS.map((k) => [k, zero15()])) as Record<Table15Key, Table15Amounts>,
    lateFeePaid: { cgstPaise: 0, sgstPaise: 0 },
    penaltyPaise: 0,
    otherPaidPaise: 0,
  };
}

/** The preparer's entries for a year, laid over empty ones so a partial save reads whole. */
export async function gstr9Inputs(ex: Executor, orgId: number, startYear: number): Promise<Gstr9Inputs> {
  const row = await ex.selectFrom('settings').select('value')
    .where('org_id', '=', orgId).where('scope', '=', 'gstr9').where('setting_key', '=', String(startYear))
    .executeTakeFirst();
  const base = emptyGstr9Inputs();
  if (!row) return base;
  const v = (typeof row.value === 'string' ? JSON.parse(row.value) : row.value) as Partial<Gstr9Inputs>;
  return {
    ...base, ...v,
    tran1: { ...base.tran1, ...(v.tran1 ?? {}) },
    tran2: { ...base.tran2, ...(v.tran2 ?? {}) },
    tran1Reversed: { ...base.tran1Reversed, ...(v.tran1Reversed ?? {}) },
    tran2Reversed: { ...base.tran2Reversed, ...(v.tran2Reversed ?? {}) },
    lateFeePaid: { ...base.lateFeePaid, ...(v.lateFeePaid ?? {}) },
    table15: Object.fromEntries(TABLE15_KEYS.map((k) => [k, { ...zero15(), ...(v.table15?.[k] ?? {}) }])) as Record<Table15Key, Table15Amounts>,
    otherItc: v.otherItc ?? [],
    otherReversals: v.otherReversals ?? [],
  };
}

/** True when nothing has been entered: Delete has nothing to take away. */
export function inputsAreEmpty(i: Gstr9Inputs): boolean {
  const e = emptyGstr9Inputs();
  return JSON.stringify(i) === JSON.stringify(e);
}

// ── Where a sale goes ────────────────────────────────────────────────────────

type SaleRow = '4A' | '4B' | '4C' | '4D' | '4E' | '5A' | '5B' | '5C' | '5C1' | '5D' | '5E' | '5F';

/**
 * The row of tables 4 and 5 a line of a sale belongs on. The buyer decides
 * between B2C (4A) and B2B (4B) as it did in GSTR-1; a supply to an EOU or
 * against an advance authorisation is a deemed export (s.147, Notification
 * 48/2017-CT) whatever else it is; and a supply with no tax payable by us —
 * zero-rated under a LUT, on reverse charge, through an operator who pays
 * under s.9(5), exempt, nil-rated or non-GST — goes to table 5.
 */
function saleRow(h: { supply_type: string; reverse_charge: number; eco_section: string | null; gstin: string | null; treatment: string },
  rate: number, taxPref: string, hasTax: boolean): SaleRow {
  if (Number(h.reverse_charge) === 1) return '5C';
  if (h.eco_section === '9_5') return '5C1';
  if (h.supply_type === 'export_lut') return '5A';
  if (h.supply_type === 'export_with_tax') return hasTax ? '4C' : '5A';
  if (h.supply_type === 'sez') return hasTax ? '4D' : '5B';
  if (taxPref === 'exempt') return '5D';
  if (taxPref === 'nil') return '5E';
  if (taxPref === 'non_gst') return '5F';
  if (h.supply_type === 'nil_or_exempt') return '5D';
  if (rate === 0 && !hasTax) return '5E';
  if (h.treatment === 'deemed_export') return '4E';
  return h.gstin ? '4B' : '4A';
}

/** Whether `code` is a table-5 row. */
const isNilRow = (r: SaleRow) => r.startsWith('5');

// ── The return ───────────────────────────────────────────────────────────────

/** The financial year that starts in April of `startYear`. */
export async function gstr9(ex: Executor, orgId: number, startYear: number, branchId?: number, opts: { today?: string } = {}): Promise<Gstr9> {
  const today = opts.today ?? localToday();
  const from = `${startYear}-04-01`;
  const to = `${startYear + 1}-03-31`;
  const nextFrom = `${startYear + 1}-04-01`;
  // Section 16(4) and section 34(2), as the Finance Act, 2022 amended them:
  // the year's credit and its notes may be taken up to 30 November after it.
  const nextTo = `${startYear + 1}-11-30`;
  const months = fyMonths(startYear);
  const fy = `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
  const br = (alias: string) => (branchId ? sql`AND ${sql.ref(`${alias}.branch_id`)} = ${branchId}` : sql``);

  const [org, branch, profile, inputs, filing] = await Promise.all([
    ex.selectFrom('organizations').select(['name', 'legal_name', 'aato_above_5cr']).where('id', '=', orgId).executeTakeFirstOrThrow(),
    ex.selectFrom('branches').select(['gstin', 'state_code']).where('org_id', '=', orgId)
      .$if(!!branchId, (q) => q.where('id', '=', branchId!))
      .$if(!branchId, (q) => q.where('is_primary', '=', 1))
      .executeTakeFirst(),
    calendarProfile(ex, orgId),
    gstr9Inputs(ex, orgId, startYear),
    ex.selectFrom('compliance_filings').select(['done_on', 'reference'])
      .where('org_id', '=', orgId).where('item_key', '=', 'gstr9').where('period', '=', String(startYear))
      .executeTakeFirst(),
  ]);

  // ── Tables 4 and 5: sales, line by line ──────────────────────────────────
  type SaleHead = { id: number; doc_kind: string; supply_type: string; reverse_charge: number; eco_section: string | null; gstin: string | null; treatment: string } & Heads;
  type SaleLine = { doc_id: number; rate: string; tax_pref: string } & Heads;
  const [invHeads, invLines, cnHeads, cnLines] = await Promise.all([
    sql<SaleHead>`
      SELECT i.id, i.doc_kind, i.supply_type, i.reverse_charge, i.eco_section, NULLIF(c.gstin, '') AS gstin, c.gst_treatment AS treatment,
             i.subtotal AS taxable, i.cgst, i.sgst, i.igst, i.cess
        FROM invoices i JOIN contacts c ON c.id = i.customer_id
       WHERE i.org_id = ${orgId} AND i.status NOT IN ('draft', 'void')
         AND i.invoice_date BETWEEN ${from} AND ${to} ${br('i')}
    `.execute(ex),
    sql<SaleLine>`
      SELECT l.invoice_id AS doc_id, l.gst_rate_pct AS rate, COALESCE(it.tax_pref, 'taxable') AS tax_pref,
             SUM(l.taxable) AS taxable, SUM(l.cgst) AS cgst, SUM(l.sgst) AS sgst, SUM(l.igst) AS igst, SUM(l.cess) AS cess
        FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id LEFT JOIN items it ON it.id = l.item_id
       WHERE i.org_id = ${orgId} AND i.status NOT IN ('draft', 'void')
         AND i.invoice_date BETWEEN ${from} AND ${to} ${br('i')}
       GROUP BY l.invoice_id, l.gst_rate_pct, COALESCE(it.tax_pref, 'taxable')
    `.execute(ex),
    // A credit note follows the invoice it corrects for reverse charge and
    // the operator's s.9(5) supplies: it reduces the row the invoice was in.
    sql<SaleHead>`
      SELECT n.id, 'credit_note' AS doc_kind, n.supply_type, COALESCE(o.reverse_charge, 0) AS reverse_charge, o.eco_section,
             NULLIF(c.gstin, '') AS gstin, c.gst_treatment AS treatment,
             n.subtotal AS taxable, n.cgst, n.sgst, n.igst, n.cess
        FROM credit_notes n JOIN contacts c ON c.id = n.customer_id LEFT JOIN invoices o ON o.id = n.against_invoice_id
       WHERE n.org_id = ${orgId} AND n.status NOT IN ('void', 'draft')
         AND n.note_date BETWEEN ${from} AND ${to} ${br('n')}
    `.execute(ex),
    sql<SaleLine>`
      SELECT l.credit_note_id AS doc_id, l.gst_rate_pct AS rate, COALESCE(it.tax_pref, 'taxable') AS tax_pref,
             SUM(l.taxable) AS taxable, SUM(l.cgst) AS cgst, SUM(l.sgst) AS sgst, SUM(l.igst) AS igst, SUM(l.cess) AS cess
        FROM credit_note_lines l JOIN credit_notes n ON n.id = l.credit_note_id LEFT JOIN items it ON it.id = l.item_id
       WHERE n.org_id = ${orgId} AND n.status NOT IN ('void', 'draft')
         AND n.note_date BETWEEN ${from} AND ${to} ${br('n')}
       GROUP BY l.credit_note_id, l.gst_rate_pct, COALESCE(it.tax_pref, 'taxable')
    `.execute(ex),
  ]);

  const t4 = new Map<string, TaxHeads>();
  const t5 = new Map<string, number>();
  const put4 = (k: string, v: TaxHeads) => t4.set(k, add(t4.get(k) ?? zero(), v));
  const put5 = (k: string, paise: number) => t5.set(k, (t5.get(k) ?? 0) + paise);

  const placeSales = (hs: SaleHead[], ls: SaleLine[], kind: 'invoice' | 'credit_note') => {
    const linesOf = new Map<number, SaleLine[]>();
    for (const l of ls) linesOf.set(Number(l.doc_id), [...(linesOf.get(Number(l.doc_id)) ?? []), l]);
    for (const h of hs) {
      const isNote = kind === 'credit_note';
      const isDebit = h.doc_kind === 'debit_note';
      const sign = isNote ? -1 : 1;
      let lineSum = zero();
      const parts: { row: SaleRow; v: TaxHeads }[] = [];
      for (const l of linesOf.get(Number(h.id)) ?? []) {
        const v = heads(l, sign);
        lineSum = add(lineSum, v);
        parts.push({ row: saleRow(h, Number(l.rate), l.tax_pref, taxOf(v) !== 0), v });
      }
      // Charges on the document's own header with tax of their own belong
      // with its main supply, so the tables total what the documents total.
      const rest = add(heads(h, sign), neg(lineSum));
      if (!isZero(rest)) parts.push({ row: saleRow(h, taxOf(rest) ? 1 : 0, 'taxable', taxOf(rest) !== 0), v: rest });
      for (const { row, v } of parts) {
        if (isZero(v)) continue;
        if (isNilRow(row)) {
          // A note on a supply without tax: 5H (credit) or 5I (debit).
          if (isNote) put5('5H', v.taxablePaise);
          else if (isDebit) put5('5I', v.taxablePaise);
          else put5(row, v.taxablePaise);
          continue;
        }
        // Notes on B2C supplies net into 4A, as the B2CS summary nets them in
        // GSTR-1; notes on B2B, exports, SEZ and deemed exports are 4I / 4J.
        if (row === '4A') put4('4A', v);
        else if (isNote) put4('4I', v);
        else if (isDebit) put4('4J', v);
        else put4(row, v);
      }
    }
  };
  placeSales(invHeads.rows, invLines.rows, 'invoice');
  placeSales(cnHeads.rows, cnLines.rows, 'credit_note');

  // 4F: advances for services taxed on receipt (GSTR-1 table 11A) less those
  // set against invoices during the year (11B), month by month as filed.
  let advances = zero();
  for (const m of months) {
    const a = await advancesForMonth(ex, orgId, monthRange(m), branchId);
    advances = add(advances, { taxablePaise: a.net.taxablePaise, cgstPaise: a.net.cgstPaise, sgstPaise: a.net.sgstPaise, igstPaise: a.net.igstPaise, cessPaise: 0 });
  }

  // 4G: tax on inward supplies under reverse charge, as billed.
  const [rcmInwardRes, ecoRes] = await Promise.all([
    sql<Heads>`
      SELECT COALESCE(SUM(b.subtotal), 0) AS taxable, COALESCE(SUM(b.cgst), 0) AS cgst, COALESCE(SUM(b.sgst), 0) AS sgst,
             COALESCE(SUM(b.igst), 0) AS igst, COALESCE(SUM(b.cess), 0) AS cess
        FROM bills b
       WHERE b.org_id = ${orgId} AND b.status NOT IN ('draft', 'void') AND b.is_rcm = 1
         AND b.bill_date BETWEEN ${from} AND ${to} ${br('b')}
    `.execute(ex),
    // 4G1: as an e-commerce operator, the supplies on which it pays the tax under s.9(5).
    sql<Heads>`
      SELECT COALESCE(SUM(e.net_value), 0) AS taxable, COALESCE(SUM(e.cgst), 0) AS cgst, COALESCE(SUM(e.sgst), 0) AS sgst,
             COALESCE(SUM(e.igst), 0) AS igst, 0 AS cess
        FROM gst_eco_supplies e
       WHERE e.org_id = ${orgId} AND e.section = '9_5' AND e.entry_date BETWEEN ${from} AND ${to} ${br('e')}
    `.execute(ex),
  ]);

  const g4 = (k: string) => t4.get(k) ?? zero();
  const table4 = {
    b2c: g4('4A'), b2b: g4('4B'), exportsWithTax: g4('4C'), sezWithTax: g4('4D'), deemedExports: g4('4E'),
    advances, rcmInward: heads(rcmInwardRes.rows[0]), ecoPays: heads(ecoRes.rows[0]),
    subtotalAG: zero(),
    creditNotes: g4('4I'), debitNotes: g4('4J'),
    // Every figure above is worked out from the documents as they stand now,
    // so a document amended after it was first reported is already counted
    // at its amended value: there is nothing left over for 4K and 4L.
    amendmentsPlus: zero(), amendmentsMinus: zero(),
    subtotalIL: zero(), total: zero(),
  };
  table4.subtotalAG = sum(table4.b2c, table4.b2b, table4.exportsWithTax, table4.sezWithTax, table4.deemedExports, table4.advances, table4.rcmInward, table4.ecoPays);
  table4.subtotalIL = sum(table4.creditNotes, table4.debitNotes, table4.amendmentsPlus, table4.amendmentsMinus);
  table4.total = add(table4.subtotalAG, table4.subtotalIL);

  const g5 = (k: string) => t5.get(k) ?? 0;
  const table5 = {
    zeroRated: g5('5A'), sez: g5('5B'), reverseCharge: g5('5C'), ecoSupplies: g5('5C1'),
    exempt: g5('5D'), nil: g5('5E'), nonGst: g5('5F'), subtotalAF: 0,
    creditNotes: g5('5H'), debitNotes: g5('5I'), amendmentsPlus: 0, amendmentsMinus: 0, subtotalHK: 0,
    notTaxable: 0, totalTurnover: 0,
  };
  table5.subtotalAF = table5.zeroRated + table5.sez + table5.reverseCharge + table5.ecoSupplies + table5.exempt + table5.nil + table5.nonGst;
  table5.subtotalHK = table5.creditNotes + table5.debitNotes + table5.amendmentsPlus + table5.amendmentsMinus;
  table5.notTaxable = table5.subtotalAF + table5.subtotalHK;
  // 5N: total turnover, advances included — 4N and 5M, less 4G (what we
  // bought on reverse charge is someone else's turnover, not ours).
  table5.totalTurnover = table4.total.taxablePaise + table5.notTaxable - table4.rcmInward.taxablePaise;

  // ── Table 6: credit, bill by bill, where it was claimed ──────────────────
  const fromMonth = months[0];
  const toMonth = months[11];
  const nextToMonth = nextTo.slice(0, 7);
  type BillLine = {
    bill_id: number; bill_date: string; is_rcm: number; treatment: string; gstin: string | null; eligibility: string;
    kind: string; decision: string | null; claim_period: string | null;
  } & Heads;
  const billLines = await sql<BillLine>`
    SELECT b.id AS bill_id, b.bill_date, b.is_rcm, c.gst_treatment AS treatment, NULLIF(c.gstin, '') AS gstin,
           l.itc_eligibility AS eligibility, COALESCE(it.kind, IF(l.hsn_sac LIKE '99%', 'service', 'goods')) AS kind,
           g.decision, g.claim_period,
           SUM(l.taxable) AS taxable, SUM(l.cgst) AS cgst, SUM(l.sgst) AS sgst, SUM(l.igst) AS igst, SUM(l.cess) AS cess
      FROM bill_lines l
      JOIN bills b ON b.id = l.bill_id
      JOIN contacts c ON c.id = b.vendor_id
      LEFT JOIN items it ON it.id = l.item_id
      LEFT JOIN gst_itc_claims g ON g.org_id = b.org_id AND g.bill_id = b.id
     WHERE b.org_id = ${orgId} AND b.status NOT IN ('draft', 'void') ${br('b')}
       AND (b.bill_date BETWEEN ${from} AND ${to}
            OR (g.decision = 'claim_later' AND g.claim_period BETWEEN ${fromMonth} AND ${toMonth}))
     GROUP BY b.id, b.bill_date, b.is_rcm, c.gst_treatment, c.gstin, l.itc_eligibility,
              COALESCE(it.kind, IF(l.hsn_sac LIKE '99%', 'service', 'goods')), g.decision, g.claim_period
  `.execute(ex);

  const inward = emptyTypes();
  const rcmUnregistered = emptyTypes();
  const rcmRegistered = emptyTypes();
  let importServices = zero();
  let previousYear = zero();
  let blocked = zero();
  let nextYear = zero();        // 8C: ordinary inward supplies of this year claimed in the next
  let table13 = zero();         // 13: all of this year's credit claimed in the next
  let notAvailed = zero();      // 8E: not claimed by 30 November after the year
  let deferredOut = 0;          // for the tie-out: in this year's ledgers, not this year's return
  const typeOf = (l: BillLine): keyof ByCreditType =>
    l.eligibility === 'capital_goods' ? 'capitalGoods' : l.kind === 'service' ? 'inputServices' : 'inputs';
  const registeredTreatments = new Set(['registered', 'registered_composition', 'sez', 'sez_developer', 'deemed_export', 'tax_deductor', 'uin']);

  for (const l of billLines.rows) {
    const v = taxOnly(heads(l));
    if (!taxOf(v)) continue;
    const billMonth = day(l.bill_date).slice(0, 7);
    // When the credit was taken: the bill's own month, a named later month,
    // or not yet (held back until the supplier files).
    const claimMonth = l.decision === 'defer' ? null : l.decision === 'claim_later' && l.claim_period ? l.claim_period : billMonth;
    const thisYearBill = billMonth >= fromMonth && billMonth <= toMonth;
    const claimedThisYear = !!claimMonth && claimMonth >= fromMonth && claimMonth <= toMonth;
    const claimable = l.eligibility !== 'ineligible';
    // Ineligible credit never reaches the input ledgers (it is cost), so only
    // claimable credit moves between years in the tie-out.
    if (thisYearBill && !claimedThisYear && claimable) deferredOut += taxOf(v);

    if (!thisYearBill) {
      if (claimedThisYear) previousYear = add(previousYear, v);
      continue;
    }
    if (!claimedThisYear) {
      if (claimMonth && claimMonth > toMonth && claimMonth <= nextToMonth) {
        table13 = add(table13, v);
        if (Number(l.is_rcm) !== 1) nextYear = add(nextYear, v);
      } else if (claimable) {
        notAvailed = add(notAvailed, v);
      }
      continue;
    }
    if (Number(l.is_rcm) === 1) {
      // Imported services are always reverse charge: 6F, IGST and cess only.
      if (l.treatment === 'overseas') importServices = add(importServices, v);
      else {
        const bucket = l.gstin || registeredTreatments.has(l.treatment) ? rcmRegistered : rcmUnregistered;
        bucket[typeOf(l)] = add(bucket[typeOf(l)], v);
      }
    } else {
      inward[typeOf(l)] = add(inward[typeOf(l)], v);
    }
    // Blocked under s.17(5): shown in 6 as it was in GSTR-3B 4(A), and taken
    // back out in 7E (Circular 170/02/2022-GST).
    if (!claimable) blocked = add(blocked, v);
  }

  // Expenses keep only claimable tax in their GST columns: input services, or capital goods.
  const exp = await sql<Heads & { cg: number }>`
    SELECT (x.itc_eligibility = 'capital_goods') AS cg, 0 AS taxable, COALESCE(SUM(x.cgst), 0) AS cgst, COALESCE(SUM(x.sgst), 0) AS sgst,
           COALESCE(SUM(x.igst), 0) AS igst, 0 AS cess
      FROM expenses x
     WHERE x.org_id = ${orgId} AND x.status <> 'void' AND x.itc_eligibility IN ('eligible', 'capital_goods')
       AND x.expense_date BETWEEN ${from} AND ${to} ${br('x')}
     GROUP BY cg
  `.execute(ex);
  for (const r of exp.rows) {
    const k = Number(r.cg) === 1 ? 'capitalGoods' : 'inputServices';
    inward[k] = add(inward[k], heads(r));
  }

  // The input-tax ledgers by what posted to them: vendor credits (a
  // supplier's credit note reduces credit, as GSTR-2B nets it) and Rule 37
  // reclaims (6H), in the year and, for table 12, in the next year to November.
  const ledgerBy = (where: ReturnType<typeof sql>, a: string, b: string) => sql<Omit<Heads, 'taxable'>>`
    SELECT COALESCE(SUM(CASE WHEN ac.code = ${CODE.ITC_CGST} THEN jl.debit - jl.credit ELSE 0 END), 0) AS cgst,
           COALESCE(SUM(CASE WHEN ac.code = ${CODE.ITC_SGST} THEN jl.debit - jl.credit ELSE 0 END), 0) AS sgst,
           COALESCE(SUM(CASE WHEN ac.code = ${CODE.ITC_IGST} THEN jl.debit - jl.credit ELSE 0 END), 0) AS igst,
           COALESCE(SUM(CASE WHEN ac.code = ${CODE.ITC_CESS} THEN jl.debit - jl.credit ELSE 0 END), 0) AS cess
      FROM journal_lines jl
      JOIN journal_entries e ON e.id = jl.entry_id
      JOIN accounts ac ON ac.id = jl.account_id
     WHERE e.org_id = ${orgId} AND ${where} AND e.entry_date BETWEEN ${a} AND ${b} ${br('e')}
  `.execute(ex).then((r) => heads({ taxable: '0', ...r.rows[0] }));
  const [vendorCredits, reclaimed, vcNextYear] = await Promise.all([
    ledgerBy(sql`e.source_type = 'vendor_credit'`, from, to),
    ledgerBy(sql`e.source_type = 'itc_reclaim_37'`, from, to),
    // Table 12: a supplier's credit note in the next year against a bill of this one.
    ledgerBy(sql`e.source_type = 'vendor_credit' AND EXISTS (
      SELECT 1 FROM vendor_credits vc JOIN bills ob ON ob.id = vc.against_bill_id
       WHERE vc.id = e.source_id AND ob.bill_date BETWEEN ${from} AND ${to})`, nextFrom, nextTo),
  ]);
  // A vendor credit credits the input ledgers, so its debit less credit is
  // negative: added to 6B, it takes the credit off as GSTR-2B nets it.
  inward.inputs = add(inward.inputs, vendorCredits);

  // 6E: IGST and cess paid at customs on bills of entry (8G is the IGST paid on them all).
  const boe = await sql<{ cg: number; ineligible: number; igst: string; cess: string }>`
    SELECT (x.itc_eligibility = 'capital_goods') AS cg, (x.itc_eligibility = 'ineligible') AS ineligible,
           COALESCE(SUM(x.igst), 0) AS igst, COALESCE(SUM(x.cess), 0) AS cess
      FROM bills_of_entry x
     WHERE x.org_id = ${orgId} AND x.status = 'recorded' AND x.boe_date BETWEEN ${from} AND ${to} ${br('x')}
     GROUP BY cg, ineligible
  `.execute(ex);
  const importGoods = { inputs: zero(), capitalGoods: zero() };
  let importIgstPaid = zero();
  for (const r of boe.rows) {
    const v: TaxHeads = { ...zero(), igstPaise: p(r.igst), cessPaise: p(r.cess) };
    const k = Number(r.cg) === 1 ? 'capitalGoods' : 'inputs';
    importGoods[k] = add(importGoods[k], v);
    importIgstPaid = add(importIgstPaid, { ...zero(), igstPaise: p(r.igst) });
    if (Number(r.ineligible) === 1) blocked = add(blocked, v);
  }
  const imports = add(importGoods.inputs, importGoods.capitalGoods);

  // 6A: the credit claimed in the year's GSTR-3B, 4(A) in total; and table 9.
  const quarterly = profile.frequency === 'quarterly';
  const periods = quarterly ? [1, 2, 3, 4].map((q) => `${startYear}-Q${q}`) : months;
  const forms = [];
  for (const key of periods) forms.push(await gstr3bForm(ex, orgId, key, { branchId, today }));
  const itc3b = forms.reduce((t, f) => add(t, taxOnly(sum(f.rows['4A1'], f.rows['4A2'], f.rows['4A3'], f.rows['4A4'], f.rows['4A5']))), zero());
  const thisYear = add(itc3b, neg(previousYear));

  const isd = zero();
  const tran1: TaxHeads = { ...zero(), cgstPaise: inputs.tran1.cgstPaise, sgstPaise: inputs.tran1.sgstPaise };
  const tran2: TaxHeads = { ...zero(), cgstPaise: inputs.tran2.cgstPaise, sgstPaise: inputs.tran2.sgstPaise };
  const otherItc = inputs.otherItc.reduce((t, o) => add(t, { taxablePaise: 0, igstPaise: o.igstPaise, cgstPaise: o.cgstPaise, sgstPaise: o.sgstPaise, cessPaise: o.cessPaise }), zero());
  const subtotalBH = sum(sumTypes(inward), sumTypes(rcmUnregistered), sumTypes(rcmRegistered), imports, importServices, isd, reclaimed);
  const subtotalKM = sum(tran1, tran2, otherItc);
  const table6 = {
    itc3b, previousYear, thisYear,
    inward, rcmUnregistered, rcmRegistered, importGoods, importServices, isd, reclaimed,
    subtotalBH,
    // 6J: what the documents say was claimed against what the monthly returns
    // claimed for this year. Nil when every claim went through GSTR-3B as booked.
    difference: add(subtotalBH, neg(thisYear)),
    tran1, tran2, other: otherItc, otherDetail: inputs.otherItc,
    subtotalKM,
    total: add(subtotalBH, subtotalKM),
    imports,
  };

  // ── Table 7: reversals ────────────────────────────────────────────────────
  const reversals = await sql<{ rule: string } & Omit<Heads, 'taxable'>>`
    SELECT r.rule, COALESCE(SUM(r.cgst), 0) AS cgst, COALESCE(SUM(r.sgst), 0) AS sgst,
           COALESCE(SUM(r.igst), 0) AS igst, COALESCE(SUM(r.cess), 0) AS cess
      FROM itc_reversals r
     WHERE r.org_id = ${orgId}
       AND ((r.rule IN ('37', '42', '43') AND r.period BETWEEN ${fromMonth} AND ${toMonth})
            OR (r.rule = '42-annual' AND r.period = ${String(startYear)}))
       ${branchId ? sql`AND EXISTS (SELECT 1 FROM journal_entries je WHERE je.id = r.journal_entry_id AND je.branch_id = ${branchId})` : sql``}
     GROUP BY r.rule
  `.execute(ex);
  const rule = (...keys: string[]) => reversals.rows.filter((r) => keys.includes(r.rule)).reduce((t, r) => add(t, heads({ taxable: '0', ...r })), zero());
  const otherRev = inputs.otherReversals.reduce((t, o) => add(t, { taxablePaise: 0, igstPaise: o.igstPaise, cgstPaise: o.cgstPaise, sgstPaise: o.sgstPaise, cessPaise: o.cessPaise }), zero());
  const table7 = {
    rule37: rule('37'), rule39: zero(), rule42: rule('42', '42-annual'), rule43: rule('43'),
    section17_5: blocked,
    tran1: { ...zero(), cgstPaise: inputs.tran1Reversed.cgstPaise, sgstPaise: inputs.tran1Reversed.sgstPaise },
    tran2: { ...zero(), cgstPaise: inputs.tran2Reversed.cgstPaise, sgstPaise: inputs.tran2Reversed.sgstPaise },
    other: otherRev, otherDetail: inputs.otherReversals,
    total: zero(), netAvailable: zero(),
  };
  table7.total = sum(table7.rule37, table7.rule39, table7.rule42, table7.rule43, table7.section17_5, table7.tran1, table7.tran2, table7.other);
  table7.netAvailable = add(table6.total, neg(table7.total));

  // ── Table 8: credit against GSTR-2B ───────────────────────────────────────
  const twoB = await sql<Heads>`
    SELECT COALESCE(SUM(IF(doc_type = 'credit_note', -taxable, taxable)), 0) AS taxable,
           COALESCE(SUM(IF(doc_type = 'credit_note', -cgst, cgst)), 0) AS cgst,
           COALESCE(SUM(IF(doc_type = 'credit_note', -sgst, sgst)), 0) AS sgst,
           COALESCE(SUM(IF(doc_type = 'credit_note', -igst, igst)), 0) AS igst,
           COALESCE(SUM(IF(doc_type = 'credit_note', -cess, cess)), 0) AS cess
      FROM gstr2b_entries
     WHERE org_id = ${orgId} AND itc_available = 1 AND is_reverse_charge = 0
       AND COALESCE(ims_action, 'accepted') = 'accepted'
       AND STR_TO_DATE(CONCAT('01', return_period), '%d%m%Y') BETWEEN ${from} AND ${to}
       ${branchId ? sql`AND recipient_gstin = (SELECT gstin FROM branches WHERE id = ${branchId})` : sql``}
  `.execute(ex);
  const asPer2b = taxOnly(heads(twoB.rows[0]));
  const asPerTable6 = add(sumTypes(inward), reclaimed);
  const importDifference = add(importIgstPaid, neg({ ...zero(), igstPaise: imports.igstPaise }));
  const importNotAvailed = importDifference.igstPaise > 0 ? importDifference : zero();
  const table8 = {
    asPer2b, asPerTable6, nextYear,
    difference: add(asPer2b, neg(add(asPerTable6, nextYear))),
    notAvailed,
    // Blocked credit is shown as availed in 6 and reversed in 7E, as GSTR-3B
    // reported it since Circular 170/02/2022-GST, so it is not here as well.
    ineligible: zero(),
    importIgstPaid, importIgstAvailed: { ...zero(), igstPaise: imports.igstPaise },
    importDifference, importNotAvailed,
    lapsed: add(notAvailed, importNotAvailed),
  };

  // ── Table 9: tax paid, the monthly returns added up ──────────────────────
  const payments = await ex.selectFrom('gst_tax_payments')
    .select(['period', 'cash_igst', 'cash_cgst', 'cash_sgst', 'cash_cess', 'interest', 'late_fee', 'setoff'])
    .where('org_id', '=', orgId).where('return_type', '=', 'GSTR3B').where('period', 'in', periods)
    .$if(!!branchId, (q) => q.where('branch_id', '=', branchId!))
    .execute();
  const paidFor = new Map<string, typeof payments>();
  for (const r of payments) paidFor.set(r.period, [...(paidFor.get(r.period) ?? []), r]);

  const t9: Record<TaxHead, Table9Row> = Object.fromEntries(TAX_HEADS.map((h) => [h, {
    head: h, payablePaise: 0, paidInCashPaise: 0, itc: { IGST: 0, CGST: 0, SGST: 0, CESS: 0 }, paidThroughItcPaise: 0,
  }])) as Record<TaxHead, Table9Row>;
  const interest = { payablePaise: 0, paidPaise: 0 };
  const lateFee = { payablePaise: 0, paidPaise: 0 };
  forms.forEach((f, i) => {
    const key = periods[i];
    for (const row of f.payment) {
      t9[row.head].payablePaise += row.payablePaise;
      interest.payablePaise += row.interestPaise;
      lateFee.payablePaise += row.lateFeePaise;
    }
    const recorded = paidFor.get(key);
    if (recorded?.length) {
      // What was actually paid, as recorded against the return: the cash, and
      // the credit set off by the head it came from and the head it met.
      for (const r of recorded) {
        t9.IGST.paidInCashPaise += p(r.cash_igst);
        t9.CGST.paidInCashPaise += p(r.cash_cgst);
        t9.SGST.paidInCashPaise += p(r.cash_sgst);
        t9.CESS.paidInCashPaise += p(r.cash_cess);
        interest.paidPaise += p(r.interest);
        lateFee.paidPaise += p(r.late_fee);
        const so = (typeof r.setoff === 'string' ? JSON.parse(r.setoff) : r.setoff) as Partial<Record<TaxHead, Partial<Record<TaxHead, number>>>> | null;
        for (const credit of TAX_HEADS) {
          for (const liability of TAX_HEADS) {
            const n = Number(so?.[credit]?.[liability] ?? 0);
            if (n) t9[liability].itc[credit] += n;
          }
        }
      }
    } else {
      // Not recorded: what the return itself works out.
      for (const row of f.payment) {
        t9[row.head].paidInCashPaise += row.cashPaise;
        for (const credit of TAX_HEADS) t9[row.head].itc[credit] += row.itc[credit];
        interest.paidPaise += row.interestPaise;
        lateFee.paidPaise += row.lateFeePaise;
      }
    }
  });
  for (const h of TAX_HEADS) t9[h].paidThroughItcPaise = TAX_HEADS.reduce((t, c) => t + t9[h].itc[c], 0);
  const table9 = TAX_HEADS.map((h) => t9[h]);

  // ── Tables 10 to 14: this year in the next year's returns ────────────────
  const [dnNext, cnNext, r37Next] = await Promise.all([
    sql<Heads>`
      SELECT COALESCE(SUM(i.subtotal), 0) AS taxable, COALESCE(SUM(i.cgst), 0) AS cgst, COALESCE(SUM(i.sgst), 0) AS sgst,
             COALESCE(SUM(i.igst), 0) AS igst, COALESCE(SUM(i.cess), 0) AS cess
        FROM invoices i JOIN invoices o ON o.id = i.against_invoice_id
       WHERE i.org_id = ${orgId} AND i.doc_kind = 'debit_note' AND i.status NOT IN ('draft', 'void')
         AND i.invoice_date BETWEEN ${nextFrom} AND ${nextTo} AND o.invoice_date BETWEEN ${from} AND ${to} ${br('i')}
    `.execute(ex),
    sql<Heads>`
      SELECT COALESCE(SUM(n.subtotal), 0) AS taxable, COALESCE(SUM(n.cgst), 0) AS cgst, COALESCE(SUM(n.sgst), 0) AS sgst,
             COALESCE(SUM(n.igst), 0) AS igst, COALESCE(SUM(n.cess), 0) AS cess
        FROM credit_notes n JOIN invoices o ON o.id = n.against_invoice_id
       WHERE n.org_id = ${orgId} AND n.status NOT IN ('draft', 'void')
         AND n.note_date BETWEEN ${nextFrom} AND ${nextTo} AND o.invoice_date BETWEEN ${from} AND ${to} ${br('n')}
    `.execute(ex),
    sql<Omit<Heads, 'taxable'>>`
      SELECT COALESCE(SUM(r.cgst), 0) AS cgst, COALESCE(SUM(r.sgst), 0) AS sgst,
             COALESCE(SUM(r.igst), 0) AS igst, COALESCE(SUM(r.cess), 0) AS cess
        FROM itc_reversals r JOIN bills b ON b.id = r.bill_id
       WHERE r.org_id = ${orgId} AND r.rule = '37' AND r.period BETWEEN ${nextFrom.slice(0, 7)} AND ${nextToMonth}
         AND b.bill_date BETWEEN ${from} AND ${to} ${br('b')}
    `.execute(ex),
  ]);
  const table10 = heads(dnNext.rows[0]);
  const table11 = heads(cnNext.rows[0]);
  // A vendor credit credits the input ledgers: debit less credit is negative, so it is turned round.
  const table12 = add(neg(vcNextYear), heads({ taxable: '0', ...r37Next.rows[0] }));
  const table14: Gstr9['table14'] = [
    ...TAX_HEADS.map((h) => {
      const k = h === 'IGST' ? 'igstPaise' : h === 'CGST' ? 'cgstPaise' : h === 'SGST' ? 'sgstPaise' : 'cessPaise';
      // The tax on 10 net of 11, where it adds up to more tax: it went
      // through the next year's GSTR-3B with those notes, so it is paid.
      const d = Math.max(0, table10[k] - table11[k]);
      return { head: h as TaxHead | 'INTEREST', payablePaise: d, paidPaise: d };
    }),
    { head: 'INTEREST', payablePaise: 0, paidPaise: 0 },
  ];

  // ── Table 16 ──────────────────────────────────────────────────────────────
  const [composition, jobWork, approval] = await Promise.all([
    sql<{ v: string }>`
      SELECT COALESCE(SUM(b.subtotal), 0) AS v FROM bills b JOIN contacts c ON c.id = b.vendor_id
       WHERE b.org_id = ${orgId} AND b.status NOT IN ('draft', 'void') AND c.gst_treatment = 'registered_composition'
         AND b.bill_date BETWEEN ${from} AND ${to} ${br('b')}
    `.execute(ex),
    // Inputs sent to a job worker and not back within a year are treated as
    // supplied on the day they went (s.143(3)); counted in the year the year ran out.
    sql<{ value: string; rate: string | null; inter: number }>`
      SELECT (cl.qty - COALESCE(back.qty, 0)) * cl.rate AS value, it.gst_rate_pct AS rate,
             (COALESCE(c.state_code, br.state_code) <> br.state_code) AS inter
        FROM challan_lines cl
        JOIN delivery_challans d ON d.id = cl.challan_id
        JOIN contacts c ON c.id = d.customer_id
        JOIN branches br ON br.id = d.branch_id
        LEFT JOIN items it ON it.id = cl.item_id
        LEFT JOIN (SELECT challan_line_id, SUM(qty_received + qty_waste) AS qty FROM job_work_receipt_lines GROUP BY challan_line_id) back
               ON back.challan_line_id = cl.id
       WHERE d.org_id = ${orgId} AND d.challan_type = 'job_work' AND d.status NOT IN ('cancelled', 'draft')
         AND DATE_ADD(d.challan_date, INTERVAL 1 YEAR) BETWEEN ${from} AND ${to}
         AND cl.qty - COALESCE(back.qty, 0) > 0 ${br('d')}
    `.execute(ex),
    // Goods sent on approval and neither returned nor invoiced within six
    // months are supplied when the six months end (s.31(7)).
    sql<{ value: string; rate: string | null; inter: number }>`
      SELECT (cl.qty - cl.qty_invoiced) * cl.rate AS value, it.gst_rate_pct AS rate,
             (COALESCE(c.state_code, br.state_code) <> br.state_code) AS inter
        FROM challan_lines cl
        JOIN delivery_challans d ON d.id = cl.challan_id
        JOIN contacts c ON c.id = d.customer_id
        JOIN branches br ON br.id = d.branch_id
        LEFT JOIN items it ON it.id = cl.item_id
       WHERE d.org_id = ${orgId} AND d.challan_type = 'supply_on_approval' AND d.status IN ('open', 'partially_invoiced')
         AND DATE_ADD(d.challan_date, INTERVAL 6 MONTH) BETWEEN ${from} AND ${to}
         AND cl.qty - cl.qty_invoiced > 0 ${br('d')}
    `.execute(ex),
  ]);
  const deemed = (rows: { value: string; rate: string | null; inter: number }[]): TaxHeads => rows.reduce((t, r) => {
    const value = Math.round(p(r.value));
    const tax = Math.round((value * Number(r.rate ?? 0)) / 100);
    const inter = Number(r.inter) === 1;
    return add(t, { taxablePaise: value, igstPaise: inter ? tax : 0, cgstPaise: inter ? 0 : Math.floor(tax / 2), sgstPaise: inter ? 0 : tax - Math.floor(tax / 2), cessPaise: 0 });
  }, zero());
  const table16 = { composition: p(composition.rows[0]?.v ?? '0'), deemedSupply: deemed(jobWork.rows), approval: deemed(approval.rows) };

  // ── Tables 17 and 18: HSN summaries ───────────────────────────────────────
  // Notification 78/2020-CT: at least four digits up to ₹5 crore of aggregate
  // turnover, six above it. The summary is rolled up to that many digits, so
  // an eight-digit code and its six-digit heading land on one line.
  const aboveFive = !!org.aato_above_5cr || table5.totalTurnover > 5_00_00_000_00;
  const hsnDigits: 4 | 6 = aboveFive ? 6 : 4;
  type HsnRaw = Heads & { code: string | null; description: string | null; uqc: string | null; qty: string; rate: string };
  const [hsnOut, hsnIn] = await Promise.all([
    sql<HsnRaw>`
      SELECT code, MAX(description) AS description, uqc, rate, SUM(qty) AS qty, SUM(taxable) AS taxable,
             SUM(cgst) AS cgst, SUM(sgst) AS sgst, SUM(igst) AS igst, SUM(cess) AS cess FROM (
        SELECT LEFT(l.hsn_sac, ${hsnDigits}) AS code, h.description, COALESCE(l.uqc, 'NOS') AS uqc, l.gst_rate_pct AS rate,
               l.qty, l.taxable, l.cgst, l.sgst, l.igst, l.cess
          FROM invoice_lines l JOIN invoices x ON x.id = l.invoice_id
          LEFT JOIN hsn_codes h ON h.org_id = x.org_id AND h.code = l.hsn_sac
         WHERE x.org_id = ${orgId} AND x.status NOT IN ('draft', 'void') AND x.invoice_date BETWEEN ${from} AND ${to} ${br('x')}
        UNION ALL
        SELECT LEFT(l.hsn_sac, ${hsnDigits}), h.description, COALESCE(l.uqc, 'NOS'), l.gst_rate_pct,
               -l.qty, -l.taxable, -l.cgst, -l.sgst, -l.igst, -l.cess
          FROM credit_note_lines l JOIN credit_notes x ON x.id = l.credit_note_id
          LEFT JOIN hsn_codes h ON h.org_id = x.org_id AND h.code = l.hsn_sac
         WHERE x.org_id = ${orgId} AND x.status NOT IN ('draft', 'void') AND x.note_date BETWEEN ${from} AND ${to} ${br('x')}
      ) t GROUP BY code, uqc, rate ORDER BY taxable DESC
    `.execute(ex),
    sql<HsnRaw>`
      SELECT LEFT(l.hsn_sac, ${hsnDigits}) AS code, MAX(h.description) AS description, COALESCE(l.uqc, 'NOS') AS uqc,
             l.gst_rate_pct AS rate, SUM(l.qty) AS qty, SUM(l.taxable) AS taxable,
             SUM(l.cgst) AS cgst, SUM(l.sgst) AS sgst, SUM(l.igst) AS igst, SUM(l.cess) AS cess
        FROM bill_lines l JOIN bills x ON x.id = l.bill_id
        LEFT JOIN hsn_codes h ON h.org_id = x.org_id AND h.code = l.hsn_sac
       WHERE x.org_id = ${orgId} AND x.status NOT IN ('draft', 'void') AND x.bill_date BETWEEN ${from} AND ${to} ${br('x')}
       GROUP BY LEFT(l.hsn_sac, ${hsnDigits}), COALESCE(l.uqc, 'NOS'), l.gst_rate_pct
       ORDER BY taxable DESC
    `.execute(ex),
  ]);
  const hsn = (rows: HsnRaw[]): HsnSummaryRow[] => rows
    .filter((r) => p(r.taxable) !== 0 || Number(r.qty) !== 0)
    .map((r) => {
      const code = r.code ?? '';
      // Services carry no quantity: UQC NA, as the portal asks.
      const service = code.startsWith('99');
      return {
        code: code || 'UNCLASSIFIED',
        description: r.description,
        uqc: service ? 'NA' : (r.uqc ?? 'NOS'),
        qty: service ? 0 : Math.round(Number(r.qty) * 100) / 100,
        ratePct: Number(r.rate),
        taxablePaise: p(r.taxable), cgstPaise: p(r.cgst), sgstPaise: p(r.sgst), igstPaise: p(r.igst), cessPaise: p(r.cess),
      };
    });

  // ── Table 19: late fee (s.47(2), Notification 7/2023-CT) ─────────────────
  const dueDate = `${startYear + 1}-12-31`;
  const filedOn = filing ? day(filing.done_on) : null;
  const asOf = filedOn ?? today;
  const daysLate = Math.max(0, daysBetween(dueDate, asOf));
  // From FY 2022-23: ₹50 a day (₹25 + ₹25) up to ₹5 crore of turnover, capped
  // at 0.04% of the turnover in the state; ₹100 a day above ₹5 crore up to ₹20
  // crore, the same cap; ₹200 a day above ₹20 crore, capped at 0.5%. Half is
  // CGST and half SGST.
  const turnover = Math.max(0, table5.totalTurnover);
  const above20 = turnover > 20_00_00_000_00;
  const perDayHalf = above20 ? 100_00 : aboveFive ? 50_00 : 25_00;
  const capHalf = Math.round(turnover * (above20 ? 0.0025 : 0.0002));
  const feeHalf = Math.min(perDayHalf * daysLate, capHalf);
  const table19 = {
    dueDate, filedOn, daysLate,
    cgst: { payablePaise: feeHalf, paidPaise: inputs.lateFeePaid.cgstPaise },
    sgst: { payablePaise: feeHalf, paidPaise: inputs.lateFeePaid.sgstPaise },
    basis: daysLate > 0
      ? `${daysLate} day${daysLate === 1 ? '' : 's'} after the due date of ${dueDate}: ₹${(perDayHalf * 2) / 100} a day (half CGST, half SGST), capped at ${above20 ? '0.5%' : '0.04%'} of the turnover in the state. The portal works out the final figure when the return is filed.`
      : `Due by ${dueDate}. Filed by then, no late fee is payable.`,
  };

  // ── The GL tie-out ────────────────────────────────────────────────────────
  // What the ledgers say against what the return says. Only postings made by
  // the documents count: a set-off or payment entry clears the ledgers once
  // the tax is paid, and is not a supply or a claim.
  const OUTPUT = [CODE.GST_CGST, CODE.GST_SGST, CODE.GST_IGST, CODE.GST_CESS];
  const INPUT = [CODE.ITC_CGST, CODE.ITC_SGST, CODE.ITC_IGST, CODE.ITC_CESS];
  const moves = await sql<{ code: string; source_type: string; net: string }>`
    SELECT ac.code, e.source_type, SUM(jl.credit - jl.debit) AS net
      FROM journal_lines jl
      JOIN journal_entries e ON e.id = jl.entry_id
      JOIN accounts ac ON ac.id = jl.account_id
     WHERE e.org_id = ${orgId} AND e.entry_date BETWEEN ${from} AND ${to} ${br('e')}
       AND ac.code IN (${sql.join([...OUTPUT, CODE.RCM_PAYABLE, ...INPUT])})
     GROUP BY ac.code, e.source_type
  `.execute(ex);
  const SETTLEMENT = (s: string) => /^gst_(set_?off|payment|tax_payment)|^gstr3b|_payment$/.test(s) && !['payment_received', 'payment_made'].includes(s);
  const LABEL: Record<string, string> = {
    manual: 'Manual journals', opening: 'Opening balances', bank_txn: 'Bank statement postings', retainer: 'Retainer invoices',
    retainer_application: 'Retainers applied', recurring_journal: 'Recurring journals',
  };
  const tie = (key: TieOutLine['key'], label: string, codes: string[], sign: 1 | -1, returnPaise: number, docSources: Set<string>, known: { label: string; paise: number }[]): TieOutLine => {
    const rows = moves.rows.filter((r) => codes.includes(r.code) && !SETTLEMENT(r.source_type));
    const booksPaise = rows.reduce((t, r) => t + sign * p(r.net), 0);
    const outside = new Map<string, number>();
    for (const r of rows) if (!docSources.has(r.source_type)) outside.set(r.source_type, (outside.get(r.source_type) ?? 0) + sign * p(r.net));
    const reasons = [
      ...known.filter((k) => k.paise !== 0),
      ...[...outside].filter(([, v]) => v !== 0).map(([s, v]) => ({ label: `${LABEL[s] ?? s.replace(/_/g, ' ')} (no GST document behind it)`, paise: v })),
    ];
    const differencePaise = booksPaise - returnPaise;
    return { key, label, booksPaise, returnPaise, differencePaise, reasons, unexplainedPaise: differencePaise - reasons.reduce((t, r) => t + r.paise, 0) };
  };
  // Input credit the ledgers can see: 6I less the reversals that were posted
  // (rules 37, 42, 43) and the blocked credit of 7E, which was never in them —
  // it went to cost. TRAN credit and the preparer's other rows have no posting.
  const ledgerCredit = taxOf(subtotalBH) - taxOf(sum(table7.rule37, table7.rule42, table7.rule43, table7.section17_5));
  const tieOut: TieOutLine[] = [
    tie('output', 'Output tax (CGST, SGST, IGST, cess ledgers) against table 4N, less 4G',
      OUTPUT, 1, taxOf(table4.total) - taxOf(table4.rcmInward),
      new Set(['invoice', 'credit_note', 'payment_received', 'advance_adjustment', 'retainer', 'retainer_application', 'gst_eco_supply', 'gst_eco_amendment']),
      []),
    tie('rcm', 'GST payable under reverse charge against table 4G',
      [CODE.RCM_PAYABLE], 1, taxOf(table4.rcmInward), new Set(['bill']), []),
    tie('input', 'Input tax (ITC ledgers) against table 6I, less the reversals posted and blocked credit (7A, 7C, 7D, 7E)',
      INPUT, -1, ledgerCredit,
      new Set(['bill', 'expense', 'vendor_credit', 'bill_of_entry', 'itc_reversal_37', 'itc_reversal_42', 'itc_reversal_43', 'itc_reclaim_37', 'goods_receipt', 'payment_made']),
      [{ label: 'Credit of this year held back after matching GSTR-2B, or claimed after the year', paise: deferredOut }]),
  ];

  // ── Notes ─────────────────────────────────────────────────────────────────
  const draft = today <= to;
  const notes: string[] = [];
  if (draft) notes.push(`FY ${fy} is still running: this is what the return will say on the documents entered so far.`);
  notes.push('Every figure is worked out from the documents as they stand now, so a document amended after it was first reported is counted at its amended value; 4K, 4L, 5J and 5K have nothing left to carry.');
  notes.push('Table 6A and table 9 are the year\'s GSTR-3B returns added up; 6J is the difference between those returns and the documents, and is nil when every claim went through GSTR-3B as booked.');
  if (!isZero(table6.difference)) notes.push('6J is not nil: credit was claimed in GSTR-3B differently from the bills of the year. Check the GSTR-2B decisions on the ITC reconciliation screen, and the ITC reversals.');
  if (asPer2b.cgstPaise + asPer2b.igstPaise + asPer2b.sgstPaise === 0 && taxOf(sumTypes(inward)) > 0) {
    notes.push('No GSTR-2B has been brought in for this year, so 8A is empty. Import each month\'s 2B on the ITC reconciliation screen.');
  }
  if (hsn(hsnOut.rows).some((r) => r.code === 'UNCLASSIFIED')) {
    notes.push('Some sales lines have no HSN code: table 17 shows them as UNCLASSIFIED, which the portal will not accept.');
  }
  if (!aboveFive) notes.push('Turnover up to ₹5 crore: HSN codes in tables 17 and 18 are given at four digits (Notification 78/2020-CT).');
  if (table16.deemedSupply.taxablePaise > 0) notes.push('16B: goods sent for job work are not back within a year of the challan, so they are treated as supplied on the day they were sent (s.143(3)). Tax and interest are due on them.');
  if (table16.approval.taxablePaise > 0) notes.push('16C: goods sent on approval were neither returned nor invoiced within six months; they are supplied when the six months ran out (s.31(7)).');
  if (table4.ecoPays.taxablePaise || table5.ecoSupplies) notes.push('Rows 4G1 and 5C1 (supplies under s.9(5)) were added to the form for FY 2023-24 onwards; the offline tool\'s file below does not carry them yet, so enter them on the portal\'s own screen.');
  if (quarterly) notes.push('Filed quarterly under QRMP: table 9 adds up the four quarterly GSTR-3B returns.');

  const isNil = isZero(table4.total) && table5.totalTurnover === 0 && isZero(table6.total) && isZero(table7.total)
    && table9.every((r) => r.payablePaise === 0);

  return {
    fy, startYear, from, to,
    gstin: branch?.gstin ?? null,
    legalName: org.legal_name ?? org.name,
    tradeName: org.legal_name && org.legal_name !== org.name ? org.name : null,
    aatoAbove5Cr: aboveFive,
    hsnDigits,
    draft,
    isNil,
    table4, table5, table6, table7, table8, table9,
    table9Other: {
      interest, lateFee,
      penalty: { payablePaise: inputs.penaltyPaise, paidPaise: inputs.penaltyPaise },
      other: { payablePaise: inputs.otherPaidPaise, paidPaise: inputs.otherPaidPaise },
      periods, recordedPayments: [...paidFor.keys()].length,
    },
    table10, table11, table12, table13, table14,
    table15: inputs.table15,
    table16,
    table17: hsn(hsnOut.rows),
    table18: hsn(hsnIn.rows),
    table19,
    tieOut,
    inputs,
    legacy: { vendorCreditsPaise: -taxOf(vendorCredits) },
    deferredCreditPaise: deferredOut,
    notes,
  };
}

/** The due date and the period key the filing bar and the calendar use. */
export const gstr9Period = (startYear: number) => ({ period: String(startYear), dueDate: `${startYear + 1}-12-31` });

/** Tables 6B/6C/6D in total, for the screens that want one figure. */
export const creditTypesTotal = sumTypes;
