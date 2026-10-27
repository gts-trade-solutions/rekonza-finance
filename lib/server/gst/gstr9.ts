import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// GSTR-9, the annual return, worked out from the year's documents.
//
// GSTR-9 restates the year: what was supplied (tables 4 and 5), what credit was
// taken (6) and reversed (7), how that credit compares with GSTR-2B (8), and
// what tax was paid and how (9), with HSN summaries of what went out and came
// in (17, 18). Every figure here is computed from the invoices, notes and
// bills — the same documents the monthly returns came from — and table 9 is
// the twelve monthly GSTR-3B computations added up, so the annual return and
// the monthly ones cannot tell different stories.
//
// It is a draft for the person who files it. Amendments made through later
// returns (tables 10 to 14), late fees and demands are not in the books and
// are not here; those are filled in on the portal.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor } from '../db';
import type { Paise } from '../../types';
import { toPaiseFromSql } from '../money-sql';
import { gstr3b } from './returns';

export interface TaxHeads {
  taxablePaise: Paise;
  cgstPaise: Paise;
  sgstPaise: Paise;
  igstPaise: Paise;
  cessPaise: Paise;
}

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

export interface HsnSummaryRow {
  code: string;
  uqc: string;
  qty: number;
  ratePct: number;
  taxablePaise: Paise;
  cgstPaise: Paise;
  sgstPaise: Paise;
  igstPaise: Paise;
  cessPaise: Paise;
}

export interface Gstr9 {
  /** e.g. '2026-27' */
  fy: string;
  from: string;
  to: string;
  gstin: string | null;
  table4: {
    b2c: TaxHeads;            // 4A
    b2b: TaxHeads;            // 4B
    exportsWithTax: TaxHeads; // 4C
    sezWithTax: TaxHeads;     // 4D
    /** Advances taxed on receipt and not yet invoiced: received less adjusted in the year. */
    advances: TaxHeads;       // 4F
    rcmInward: TaxHeads;      // 4G
    creditNotes: TaxHeads;    // 4I, shown negative
    total: TaxHeads;          // 4N
  };
  table5: {
    exportsLut: Paise;        // 5A
    sezLut: Paise;            // 5B
    exemptOrNil: Paise;       // 5D + 5E: the books do not tell exempt from nil apart
    creditNotes: Paise;       // 5H, on zero-rated and exempt supplies, shown negative
    total: Paise;             // 5N
  };
  table6: {
    inputs: TaxHeads;         // 6B inputs
    capitalGoods: TaxHeads;   // 6B capital goods
    inputServices: TaxHeads;  // 6B input services
    rcmUnregistered: TaxHeads; // 6C
    rcmRegistered: TaxHeads;  // 6D
    total: TaxHeads;
  };
  /** Credit reversed in the year by vendor credits (debit notes we raised). */
  table7: { vendorCreditsPaise: Paise };
  table8: {
    asPer2b: TaxHeads;        // 8A
    asPerBooks: TaxHeads;     // 8B: table 6B
    difference: TaxHeads;     // 8D: 8A − 8B
  };
  table9: {
    head: 'IGST' | 'CGST' | 'SGST' | 'CESS';
    payablePaise: Paise;
    paidThroughItcPaise: Paise;
    paidInCashPaise: Paise;
  }[];
  table17: HsnSummaryRow[];
  table18: HsnSummaryRow[];
  notes: string[];
}

type Heads = { taxable: string; cgst: string; sgst: string; igst: string; cess: string };
const heads = (r: Heads | undefined): TaxHeads => r
  ? {
      taxablePaise: toPaiseFromSql(r.taxable), cgstPaise: toPaiseFromSql(r.cgst), sgstPaise: toPaiseFromSql(r.sgst),
      igstPaise: toPaiseFromSql(r.igst), cessPaise: toPaiseFromSql(r.cess),
    }
  : zero();

/** The financial year that starts in April of `startYear`. */
export async function gstr9(ex: Executor, orgId: number, startYear: number, branchId?: number): Promise<Gstr9> {
  const from = `${startYear}-04-01`;
  const to = `${startYear + 1}-03-31`;
  const fy = `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
  const br = branchId ? sql`AND x.branch_id = ${branchId}` : sql``;
  const sum = sql`COALESCE(SUM(x.subtotal), 0) AS taxable, COALESCE(SUM(x.cgst), 0) AS cgst,
                  COALESCE(SUM(x.sgst), 0) AS sgst, COALESCE(SUM(x.igst), 0) AS igst, COALESCE(SUM(x.cess), 0) AS cess`;

  const pbr = branchId ? sql`AND p.branch_id = ${branchId}` : sql``;
  const [invoices, notes, rcm, inward, expenses, hsnOut, hsnIn, twoB, branch, advIn, advOut] = await Promise.all([
    // Which table a sale belongs to follows from its supply type and whether
    // the buyer is registered — the same split GSTR-1 made month by month.
    sql<Heads & { bucket: string }>`
      SELECT CASE
               WHEN x.supply_type = 'export_lut' THEN 'export_lut'
               WHEN x.supply_type = 'export_with_tax' THEN 'export_tax'
               WHEN x.supply_type = 'sez' AND (x.cgst + x.sgst + x.igst) > 0 THEN 'sez_tax'
               WHEN x.supply_type = 'sez' THEN 'sez_lut'
               WHEN x.supply_type = 'nil_or_exempt' THEN 'exempt'
               WHEN c.gstin IS NOT NULL AND c.gstin <> '' THEN 'b2b'
               ELSE 'b2c'
             END AS bucket, ${sum}
        FROM invoices x JOIN contacts c ON c.id = x.customer_id
       WHERE x.org_id = ${orgId} AND x.status NOT IN ('draft', 'void')
         AND x.invoice_date BETWEEN ${from} AND ${to} ${br}
       GROUP BY bucket
    `.execute(ex),
    sql<Heads & { zero_rated: number }>`
      SELECT (x.supply_type IN ('export_lut', 'sez', 'nil_or_exempt') AND (x.cgst + x.sgst + x.igst) = 0) AS zero_rated, ${sum}
        FROM credit_notes x
       WHERE x.org_id = ${orgId} AND x.status <> 'void'
         AND x.note_date BETWEEN ${from} AND ${to} ${br}
       GROUP BY zero_rated
    `.execute(ex),
    sql<Heads & { registered: number }>`
      SELECT (c.gst_treatment IN ('registered', 'registered_composition', 'sez')) AS registered, ${sum}
        FROM bills x JOIN contacts c ON c.id = x.vendor_id
       WHERE x.org_id = ${orgId} AND x.status NOT IN ('draft', 'void') AND x.is_rcm = 1
         AND x.bill_date BETWEEN ${from} AND ${to} ${br}
       GROUP BY registered
    `.execute(ex),
    // Credit on ordinary purchases, split the way table 6B asks: capital goods
    // as marked on the line, goods as inputs, services as input services.
    sql<Heads & { credit_kind: string }>`
      SELECT CASE
               WHEN l.itc_eligibility = 'capital_goods' THEN 'capital'
               WHEN COALESCE(it.kind, IF(l.hsn_sac LIKE '99%', 'service', 'goods')) = 'service' THEN 'services'
               ELSE 'inputs'
             END AS credit_kind,
             COALESCE(SUM(l.taxable), 0) AS taxable, COALESCE(SUM(l.cgst), 0) AS cgst,
             COALESCE(SUM(l.sgst), 0) AS sgst, COALESCE(SUM(l.igst), 0) AS igst, COALESCE(SUM(l.cess), 0) AS cess
        FROM bill_lines l
        JOIN bills x ON x.id = l.bill_id
        LEFT JOIN items it ON it.id = l.item_id
       WHERE x.org_id = ${orgId} AND x.status NOT IN ('draft', 'void') AND x.is_rcm = 0
         AND l.itc_eligibility IN ('eligible', 'capital_goods')
         AND x.bill_date BETWEEN ${from} AND ${to} ${br}
       GROUP BY credit_kind
    `.execute(ex),
    sql<Heads>`
      SELECT COALESCE(SUM(x.amount), 0) AS taxable, COALESCE(SUM(x.cgst), 0) AS cgst,
             COALESCE(SUM(x.sgst), 0) AS sgst, COALESCE(SUM(x.igst), 0) AS igst, 0 AS cess
        FROM expenses x
       WHERE x.org_id = ${orgId} AND x.status <> 'void' AND x.itc_eligibility IN ('eligible', 'capital_goods')
         AND x.expense_date BETWEEN ${from} AND ${to} ${br}
    `.execute(ex),
    sql<Heads & { code: string | null; uqc: string | null; qty: string; rate: string }>`
      SELECT l.hsn_sac AS code, MAX(l.uqc) AS uqc, COALESCE(SUM(l.qty), 0) AS qty, l.gst_rate_pct AS rate,
             COALESCE(SUM(l.taxable), 0) AS taxable, COALESCE(SUM(l.cgst), 0) AS cgst,
             COALESCE(SUM(l.sgst), 0) AS sgst, COALESCE(SUM(l.igst), 0) AS igst, COALESCE(SUM(l.cess), 0) AS cess
        FROM invoice_lines l JOIN invoices x ON x.id = l.invoice_id
       WHERE x.org_id = ${orgId} AND x.status NOT IN ('draft', 'void')
         AND x.invoice_date BETWEEN ${from} AND ${to} ${br}
       GROUP BY l.hsn_sac, l.gst_rate_pct
       ORDER BY taxable DESC
    `.execute(ex),
    sql<Heads & { code: string | null; uqc: string | null; qty: string; rate: string }>`
      SELECT l.hsn_sac AS code, MAX(l.uqc) AS uqc, COALESCE(SUM(l.qty), 0) AS qty, l.gst_rate_pct AS rate,
             COALESCE(SUM(l.taxable), 0) AS taxable, COALESCE(SUM(l.cgst), 0) AS cgst,
             COALESCE(SUM(l.sgst), 0) AS sgst, COALESCE(SUM(l.igst), 0) AS igst, COALESCE(SUM(l.cess), 0) AS cess
        FROM bill_lines l JOIN bills x ON x.id = l.bill_id
       WHERE x.org_id = ${orgId} AND x.status NOT IN ('draft', 'void')
         AND x.bill_date BETWEEN ${from} AND ${to} ${br}
       GROUP BY l.hsn_sac, l.gst_rate_pct
       ORDER BY taxable DESC
    `.execute(ex),
    // GSTR-2B for the twelve return periods of the year (MMYYYY), credit
    // available only; credit notes there reduce it.
    sql<Heads>`
      SELECT COALESCE(SUM(IF(doc_type = 'credit_note', -taxable, taxable)), 0) AS taxable,
             COALESCE(SUM(IF(doc_type = 'credit_note', -cgst, cgst)), 0) AS cgst,
             COALESCE(SUM(IF(doc_type = 'credit_note', -sgst, sgst)), 0) AS sgst,
             COALESCE(SUM(IF(doc_type = 'credit_note', -igst, igst)), 0) AS igst,
             COALESCE(SUM(IF(doc_type = 'credit_note', -cess, cess)), 0) AS cess
        FROM gstr2b_entries
       WHERE org_id = ${orgId} AND itc_available = 1
         AND COALESCE(ims_action, 'accepted') = 'accepted'
         AND STR_TO_DATE(CONCAT('01', return_period), '%d%m%Y') BETWEEN ${from} AND ${to}
         ${branchId ? sql`AND recipient_gstin = (SELECT gstin FROM branches WHERE id = ${branchId})` : sql``}
    `.execute(ex),
    ex.selectFrom('branches').select(['gstin']).where('org_id', '=', orgId)
      .$if(!!branchId, (q) => q.where('id', '=', branchId!))
      .$if(!branchId, (q) => q.where('is_primary', '=', 1))
      .executeTakeFirst(),
    // Advances for services taxed when received (GSTR-1 table 11A) …
    sql<Heads>`
      SELECT COALESCE(SUM(p.advance_amount - p.advance_cgst - p.advance_sgst - p.advance_igst), 0) AS taxable,
             COALESCE(SUM(p.advance_cgst), 0) AS cgst, COALESCE(SUM(p.advance_sgst), 0) AS sgst,
             COALESCE(SUM(p.advance_igst), 0) AS igst, 0 AS cess
        FROM payments p
       WHERE p.org_id = ${orgId} AND p.kind = 'received' AND p.status <> 'void' AND p.advance_gst = 1
         AND p.payment_date BETWEEN ${from} AND ${to} ${pbr}
    `.execute(ex),
    // … less those set against invoices in the year (11B).
    sql<Heads>`
      SELECT COALESCE(SUM(a.amount - a.cgst - a.sgst - a.igst), 0) AS taxable,
             COALESCE(SUM(a.cgst), 0) AS cgst, COALESCE(SUM(a.sgst), 0) AS sgst,
             COALESCE(SUM(a.igst), 0) AS igst, 0 AS cess
        FROM advance_tax_adjustments a JOIN payments p ON p.id = a.payment_id
       WHERE a.org_id = ${orgId} AND a.reversed_at IS NULL
         AND a.adjusted_on BETWEEN ${from} AND ${to} ${pbr}
    `.execute(ex),
  ]);

  const bucket = (b: string) => heads(invoices.rows.find((r) => r.bucket === b));
  const taxNotes = heads(notes.rows.find((r) => Number(r.zero_rated) === 0));
  const zeroNotes = heads(notes.rows.find((r) => Number(r.zero_rated) === 1));

  const table4 = {
    b2c: bucket('b2c'),
    b2b: bucket('b2b'),
    exportsWithTax: bucket('export_tax'),
    sezWithTax: bucket('sez_tax'),
    advances: add(heads(advIn.rows[0]), neg(heads(advOut.rows[0]))),
    rcmInward: rcm.rows.reduce((t, r) => add(t, heads(r)), zero()),
    creditNotes: neg(taxNotes),
    total: zero(),
  };
  table4.total = [table4.b2c, table4.b2b, table4.exportsWithTax, table4.sezWithTax, table4.advances, table4.rcmInward, table4.creditNotes]
    .reduce(add, zero());

  const table5 = {
    exportsLut: bucket('export_lut').taxablePaise,
    sezLut: bucket('sez_lut').taxablePaise,
    exemptOrNil: bucket('exempt').taxablePaise,
    creditNotes: -zeroNotes.taxablePaise,
    total: 0,
  };
  table5.total = table5.exportsLut + table5.sezLut + table5.exemptOrNil + table5.creditNotes;

  const kind = (k: string) => heads(inward.rows.find((r) => r.credit_kind === k));
  const table6 = {
    inputs: kind('inputs'),
    capitalGoods: kind('capital'),
    // An expense is a service bought in nearly every case: rent, fees, fuel.
    inputServices: add(kind('services'), heads(expenses.rows[0])),
    rcmUnregistered: heads(rcm.rows.find((r) => Number(r.registered) === 0)),
    rcmRegistered: heads(rcm.rows.find((r) => Number(r.registered) === 1)),
    total: zero(),
  };
  table6.total = [table6.inputs, table6.capitalGoods, table6.inputServices, table6.rcmUnregistered, table6.rcmRegistered]
    .reduce(add, zero());

  // Table 9 and the reversal in table 7 are the monthly returns added up.
  const months = Array.from({ length: 12 }, (_, i) => {
    const m = ((3 + i) % 12) + 1;
    const y = m >= 4 ? startYear : startYear + 1;
    return `${y}-${String(m).padStart(2, '0')}`;
  });
  const monthly = await Promise.all(months.map((m) => gstr3b(ex, orgId, m, branchId)));
  const table9 = (['IGST', 'CGST', 'SGST', 'CESS'] as const).map((head) => {
    const rows = monthly.map((g) => g.setOff.find((s) => s.head === head)!);
    return {
      head,
      payablePaise: rows.reduce((t, r) => t + r.liabilityPaise, 0),
      paidThroughItcPaise: rows.reduce((t, r) => t + r.creditUsedPaise, 0),
      paidInCashPaise: rows.reduce((t, r) => t + r.cashPaise, 0),
    };
  });
  const reversedPaise = monthly.reduce((t, g) => t + g.itc.reversedPaise, 0);

  const asPerBooks = [table6.inputs, table6.capitalGoods, table6.inputServices].reduce(add, zero());
  const asPer2b = heads(twoB.rows[0]);

  const hsn = (rows: (Heads & { code: string | null; uqc: string | null; qty: string; rate: string })[]): HsnSummaryRow[] =>
    rows.map((r) => ({
      code: r.code ?? 'UNCLASSIFIED',
      uqc: r.uqc ?? 'NOS',
      qty: Number(r.qty),
      ratePct: Number(r.rate),
      taxablePaise: toPaiseFromSql(r.taxable),
      cgstPaise: toPaiseFromSql(r.cgst),
      sgstPaise: toPaiseFromSql(r.sgst),
      igstPaise: toPaiseFromSql(r.igst),
      cessPaise: toPaiseFromSql(r.cess),
    }));

  const notesOut: string[] = [
    'Tables 10 to 14 (amendments through later returns), 15 (demands and refunds) and 16 (composition and deemed supplies) are not kept in the books; fill them on the portal.',
    'Table 5 shows exempt and nil-rated supplies together, because the books do not record which of the two a supply was.',
  ];
  if (asPer2b.taxablePaise === 0 && asPerBooks.taxablePaise > 0) {
    notesOut.push('No GSTR-2B has been imported for this year, so table 8A is empty. Import each month’s 2B from the ITC reconciliation screen.');
  }
  if (table17HasUnclassified(hsnOut.rows)) {
    notesOut.push('Some sales lines have no HSN code; table 17 shows them as UNCLASSIFIED and the portal will not accept that.');
  }

  return {
    fy, from, to,
    gstin: branch?.gstin ?? null,
    table4,
    table5,
    table6,
    table7: { vendorCreditsPaise: reversedPaise },
    table8: { asPer2b, asPerBooks, difference: add(asPer2b, neg(asPerBooks)) },
    table9,
    table17: hsn(hsnOut.rows),
    table18: hsn(hsnIn.rows),
    notes: notesOut,
  };
}

function table17HasUnclassified(rows: { code: string | null }[]): boolean {
  return rows.some((r) => !r.code);
}
