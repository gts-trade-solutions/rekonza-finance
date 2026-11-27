import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// GSTR-1 as the file the GST portal takes (Returns → GSTR-1 → Prepare offline
// → Upload).
//
// The screen's tables are one row per document, which is what a person wants
// to read. The portal wants something else: every document broken down by tax
// rate, consumer sales rolled up by state and rate, dates written day-first,
// and the HSN summary split between registered and unregistered buyers (from
// the May 2025 period). So this reads the lines rather than the totals.
//
// Key names are the portal's and cannot be changed. They were checked against
// the open-source India Compliance app, whose files the portal accepts.
//
// Where a line goes:
//   export (LUT or with IGST)          exp,  by WOPAY / WPAY
//   SEZ                                b2b,  inv_typ SEWOP / SEWP
//   buyer with a GSTIN                 b2b,  inv_typ R, grouped by buyer
//   inter-state, no GSTIN, over limit  b2cl, grouped by state
//   any other consumer sale            b2cs, summed by state and rate
//   nil-rated, exempt or non-GST       nil (table 8), never in the tables above
// Credit notes follow the invoice: to a GSTIN → cdnr; against a B2CL invoice
// or an export → cdnur; otherwise they reduce the B2CS figures.
//
// Sold through an e-commerce operator (migration 133), table 14 lists the
// supplies by the operator's GSTIN: where the operator collected TCS under
// s.52 the sale is also in its own table above; where the operator pays the
// tax under s.9(5) the invoice charged none, and the supply is reported in
// table 14(b) only, never in the tables above (Notification 26/2022-CT made
// table 14 part of the form; the portal opened it from January 2024). A book
// that is itself an operator reports the s.9(5) supplies it paid tax on in
// table 15. A supply to an EOU or against an advance authorisation (a
// customer treated as a deemed export, s.147) is B2B with inv_typ DE.
//
// Every document's entry is kept as well as placed in its table, so that the
// return can be compared document by document with what was filed
// (gstr1-amendments.ts): a filed document changed afterwards is reported
// again in tables 9A / 9C / 10 of a later return.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor } from '../db';
import type { Paise } from '../../types';
import { toPaiseFromSql } from '../money-sql';
import { b2clThreshold, monthRange } from './returns';
import { advancesForMonth, type AdvanceRow } from './advances';
import { reverseChargeTax } from '../../tax/reverse-charge';
import { gstr1Amendments } from './gstr1-amendments';

/** From the May 2025 period the HSN table has a B2B part and a B2C part. */
const HSN_SPLIT_FROM = '2025-05';
/** The portal cuts HSN descriptions here. */
const HSN_DESC_LIMIT = 30;

type Money = { taxable: Paise; cgst: Paise; sgst: Paise; igst: Paise; cess: Paise };
const ZERO: Money = { taxable: 0, cgst: 0, sgst: 0, igst: 0, cess: 0 };
const add = (a: Money, b: Money, sign = 1): Money => ({
  taxable: a.taxable + sign * b.taxable,
  cgst: a.cgst + sign * b.cgst,
  sgst: a.sgst + sign * b.sgst,
  igst: a.igst + sign * b.igst,
  cess: a.cess + sign * b.cess,
});

/** Rupees with two decimals, as a JSON number. */
const r2 = (paise: Paise) => Math.round(paise) / 100;
/** 2026-07-14 → 14-07-2026. */
const dmy = (iso: string) => `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`;

type TaxPref = 'taxable' | 'exempt' | 'nil' | 'non_gst';

interface RateRow extends Money {
  docId: number;
  rate: number;
  taxPref: TaxPref;
}

interface DocHead {
  id: number;
  number: string;
  date: string;
  status: string;
  gstin: string | null;
  pos: string;
  branchState: string;
  supplyType: string;
  totalPaise: Paise;
  /** An invoice, or a debit note kept with them (it is reported as a note). */
  kind?: 'invoice' | 'debit_note';
  /** Under reverse charge (an invoice, or a credit note against one): rchrg Y and the tax the recipient owes. */
  reverseCharge?: boolean;
  /** Notes only: the invoice it was raised against. */
  againstTotalPaise?: Paise | null;
  againstDate?: string | null;
  againstSupplyType?: string | null;
  /** Exports only: the shipping bill the refund and the return are matched on. */
  shippingBill?: { no: string | null; date: string | null; port: string | null } | null;
  /** The buyer's GST treatment: a deemed export goes in B2B as DE. */
  treatment?: string | null;
  /** Sold through an e-commerce operator: its GSTIN and the section the tax runs under. */
  ecoGstin?: string | null;
  ecoSection?: '52' | '9_5' | null;
}

/** Which table of GSTR-1 a document went in. */
export type Gstr1Section = 'b2b' | 'b2cl' | 'exp' | 'b2cs' | 'cdnr' | 'cdnur' | 'nil' | 'eco95';

/** One document as the return carries it, for the screen and for amendments. */
export interface Gstr1DocEntry {
  docType: 'invoice' | 'debit_note' | 'credit_note';
  docId: number;
  number: string;
  date: string;
  section: Gstr1Section;
  /** The buyer's GSTIN (b2b, cdnr). */
  ctin: string | null;
  pos: string;
  /** Invoice value, as the return reports it. */
  valuePaise: Paise;
  /** Signed: a credit note takes value off. */
  taxablePaise: Paise;
  igstPaise: Paise;
  cgstPaise: Paise;
  sgstPaise: Paise;
  cessPaise: Paise;
  /** The entry placed in the table (b2b inv, b2cl inv, exp inv, cdnr nt, cdnur): what an amendment repeats. */
  entry: Record<string, unknown> | null;
  /** The keys of the table row it sits under: { exp_typ } for an export, { typ } for cdnur, { sply_ty } for B2CS. */
  group: Record<string, unknown>;
  /** Rate by rate, signed, in rupees as the file carries them. */
  rates: { rt: number; txval: number; iamt: number; camt: number; samt: number; csamt: number }[];
  eco?: { gstin: string; section: '52' | '9_5' } | null;
}

type Section = 'exp_wpay' | 'exp_wopay' | 'sez' | 'b2b' | 'b2cl' | 'b2cs';

function invoiceSection(d: { gstin: string | null; supplyType: string; totalPaise: Paise; date: string }): Section {
  if (d.supplyType === 'export_with_tax') return 'exp_wpay';
  if (d.supplyType === 'export_lut') return 'exp_wopay';
  if (d.supplyType === 'sez') return 'sez';
  if (d.gstin) return 'b2b';
  if (d.supplyType === 'inter' && d.totalPaise > b2clThreshold(d.date)) return 'b2cl';
  return 'b2cs';
}

/** Table 8 takes these, not the supply tables. */
function isNilLine(head: DocHead, line: RateRow) {
  if (head.supplyType === 'nil_or_exempt' || line.taxPref !== 'taxable') return true;
  // A zero-rated export or SEZ supply is still reported in its own table.
  return line.rate === 0 && !['export_lut', 'export_with_tax', 'sez'].includes(head.supplyType);
}

function nilKey(head: DocHead) {
  const inter = head.pos !== head.branchState;
  return head.gstin ? (inter ? 'INTRB2B' : 'INTRAB2B') : (inter ? 'INTRB2C' : 'INTRAB2C');
}

const itemDet = (l: RateRow, heads: 'all' | 'igst') =>
  heads === 'all'
    ? { rt: l.rate, txval: r2(l.taxable), iamt: r2(l.igst), camt: r2(l.cgst), samt: r2(l.sgst), csamt: r2(l.cess) }
    : { rt: l.rate, txval: r2(l.taxable), iamt: r2(l.igst), csamt: r2(l.cess) };

const wrapped = (lines: RateRow[], heads: 'all' | 'igst') =>
  lines.map((l, i) => ({ num: i + 1, itm_det: itemDet(l, heads) }));

/**
 * Serial ranges for table 13, one per series. A series is the number with its
 * running digits taken off: INV/26-27/0041 is series "INV/26-27/".
 */
function seriesRanges(docs: { number: string; status: string }[]) {
  const bySeries = new Map<string, { number: string; status: string; n: number }[]>();
  for (const d of docs) {
    const m = /^(.*?)(\d+)$/.exec(d.number);
    const key = m ? m[1] : d.number;
    const list = bySeries.get(key) ?? [];
    list.push({ ...d, n: m ? Number(m[2]) : 0 });
    bySeries.set(key, list);
  }
  return [...bySeries.values()].map((list, i) => {
    list.sort((a, b) => a.n - b.n || a.number.localeCompare(b.number));
    const cancel = list.filter((d) => d.status === 'void').length;
    return {
      num: i + 1,
      from: list[0].number,
      to: list[list.length - 1].number,
      totnum: list.length,
      cancel,
      net_issue: list.length - cancel,
    };
  });
}

export interface Gstr1PortalFile {
  gstin: string;
  fp: string;
  [section: string]: unknown;
}

/**
 * The GSTR-1 file for one month. `scope: 'iff'` gives the Invoice Furnishing
 * Facility file instead: the B2B invoices and the notes to registered buyers,
 * nothing else. Amendments of documents in returns already filed (tables 9A,
 * 9C and 10) go in with it, unless `amendments: false`.
 */
export async function gstr1PortalFile(
  ex: Executor, orgId: number, month: string,
  opts: { branchId?: number; scope?: 'gstr1' | 'iff'; amendments?: boolean } = {},
): Promise<Gstr1PortalFile> {
  const { file } = await gstr1Build(ex, orgId, month, opts);
  if (opts.amendments === false || opts.branchId) return file;
  const a = await gstr1Amendments(ex, orgId, month);
  const put = (key: string, rows: unknown[]) => { if (rows.length) file[key] = rows; };
  put('b2ba', a.file.b2ba);
  put('cdnra', a.file.cdnra);
  if (opts.scope !== 'iff') {
    put('b2cla', a.file.b2cla);
    put('expa', a.file.expa);
    put('cdnura', a.file.cdnura);
    put('b2csa', a.file.b2csa);
  }
  return file;
}

/** The file, and every document as it was placed in it. */
export async function gstr1Build(
  ex: Executor, orgId: number, month: string,
  opts: { branchId?: number; scope?: 'gstr1' | 'iff' } = {},
): Promise<{ file: Gstr1PortalFile; docs: Gstr1DocEntry[] }> {
  const { branchId, scope = 'gstr1' } = opts;
  const docs: Gstr1DocEntry[] = [];
  const period = monthRange(month);
  const branchFilter = (alias: string) => (branchId ? sql`AND ${sql.ref(`${alias}.branch_id`)} = ${branchId}` : sql``);

  // ── Invoices ──────────────────────────────────────────────────────────────
  const invHeads = await sql<{
    id: number; number: string; invoice_date: string; status: string; gstin: string | null;
    place_of_supply: string; supply_type: string; total: string; branch_state: string;
    sb_no: string | null; sb_date: string | null; sb_port: string | null;
    doc_kind: 'invoice' | 'debit_note'; reverse_charge: number;
    against_total: string | null; against_date: string | null; against_supply_type: string | null;
    treatment: string | null; eco_gstin: string | null; eco_section: '52' | '9_5' | null;
  }>`
    SELECT i.id, i.number, i.invoice_date, i.status, NULLIF(c.gstin, '') AS gstin, i.reverse_charge,
           c.gst_treatment AS treatment, COALESCE(i.eco_gstin, o.eco_gstin) AS eco_gstin, COALESCE(i.eco_section, o.eco_section) AS eco_section,
           i.place_of_supply, i.supply_type, i.total, b.state_code AS branch_state,
           i.export_shipping_bill_no AS sb_no, i.export_shipping_bill_date AS sb_date, i.export_port_code AS sb_port,
           i.doc_kind, o.total AS against_total, o.invoice_date AS against_date, o.supply_type AS against_supply_type
      FROM invoices i
      JOIN contacts c ON c.id = i.customer_id
      JOIN branches b ON b.id = i.branch_id
      LEFT JOIN invoices o ON o.id = i.against_invoice_id
     WHERE i.org_id = ${orgId} AND i.status <> 'draft'
       AND i.invoice_date BETWEEN ${period.from} AND ${period.to}
       ${branchFilter('i')}
     ORDER BY i.invoice_date, i.id
  `.execute(ex);

  const invLines = await sql<{
    doc_id: number; rate: string; tax_pref: TaxPref;
    taxable: string; cgst: string; sgst: string; igst: string; cess: string;
  }>`
    SELECT l.invoice_id AS doc_id, l.gst_rate_pct AS rate, COALESCE(it.tax_pref, 'taxable') AS tax_pref,
           SUM(l.taxable) AS taxable, SUM(l.cgst) AS cgst, SUM(l.sgst) AS sgst,
           SUM(l.igst) AS igst, SUM(l.cess) AS cess
      FROM invoice_lines l
      JOIN invoices i ON i.id = l.invoice_id
      LEFT JOIN items it ON it.id = l.item_id
     WHERE i.org_id = ${orgId} AND i.status NOT IN ('draft', 'void')
       AND i.invoice_date BETWEEN ${period.from} AND ${period.to}
       ${branchFilter('i')}
     GROUP BY l.invoice_id, l.gst_rate_pct, COALESCE(it.tax_pref, 'taxable')
     ORDER BY l.invoice_id, l.gst_rate_pct
  `.execute(ex);

  // ── Credit notes ──────────────────────────────────────────────────────────
  const cnHeads = await sql<{
    id: number; number: string; note_date: string; status: string; gstin: string | null;
    place_of_supply: string; supply_type: string; total: string; branch_state: string;
    against_total: string | null; against_date: string | null; against_supply_type: string | null;
    against_rc: number | null; treatment: string | null; eco_gstin: string | null; eco_section: '52' | '9_5' | null;
  }>`
    SELECT n.id, n.number, n.note_date, n.status, NULLIF(c.gstin, '') AS gstin,
           c.gst_treatment AS treatment, i.eco_gstin, i.eco_section,
           n.place_of_supply, n.supply_type, n.total, b.state_code AS branch_state,
           i.total AS against_total, i.invoice_date AS against_date, i.supply_type AS against_supply_type,
           i.reverse_charge AS against_rc
      FROM credit_notes n
      JOIN contacts c ON c.id = n.customer_id
      JOIN branches b ON b.id = n.branch_id
      LEFT JOIN invoices i ON i.id = n.against_invoice_id
     WHERE n.org_id = ${orgId} AND n.status <> 'draft'
       AND n.note_date BETWEEN ${period.from} AND ${period.to}
       ${branchFilter('n')}
     ORDER BY n.note_date, n.id
  `.execute(ex);

  const cnLines = await sql<{
    doc_id: number; rate: string; tax_pref: TaxPref;
    taxable: string; cgst: string; sgst: string; igst: string; cess: string;
  }>`
    SELECT l.credit_note_id AS doc_id, l.gst_rate_pct AS rate, COALESCE(it.tax_pref, 'taxable') AS tax_pref,
           SUM(l.taxable) AS taxable, SUM(l.cgst) AS cgst, SUM(l.sgst) AS sgst,
           SUM(l.igst) AS igst, SUM(l.cess) AS cess
      FROM credit_note_lines l
      JOIN credit_notes n ON n.id = l.credit_note_id
      LEFT JOIN items it ON it.id = l.item_id
     WHERE n.org_id = ${orgId} AND n.status NOT IN ('void', 'draft')
       AND n.note_date BETWEEN ${period.from} AND ${period.to}
       ${branchFilter('n')}
     GROUP BY l.credit_note_id, l.gst_rate_pct, COALESCE(it.tax_pref, 'taxable')
     ORDER BY l.credit_note_id, l.gst_rate_pct
  `.execute(ex);

  const toRate = (r: (typeof invLines.rows)[number]): RateRow => ({
    docId: Number(r.doc_id),
    rate: Number(r.rate),
    taxPref: r.tax_pref,
    taxable: toPaiseFromSql(r.taxable),
    cgst: toPaiseFromSql(r.cgst),
    sgst: toPaiseFromSql(r.sgst),
    igst: toPaiseFromSql(r.igst),
    cess: toPaiseFromSql(r.cess),
  });
  const group = (rows: RateRow[]) => {
    const m = new Map<number, RateRow[]>();
    for (const r of rows) m.set(r.docId, [...(m.get(r.docId) ?? []), r]);
    return m;
  };
  const invRates = group(invLines.rows.map(toRate));
  const cnRates = group(cnLines.rows.map(toRate));

  const sold: DocHead[] = invHeads.rows.map((r) => ({
    id: Number(r.id), number: r.number, date: String(r.invoice_date).slice(0, 10), status: r.status,
    gstin: r.gstin, pos: r.place_of_supply, branchState: r.branch_state, supplyType: r.supply_type,
    totalPaise: toPaiseFromSql(r.total),
    kind: r.doc_kind,
    reverseCharge: Number(r.reverse_charge) === 1,
    againstTotalPaise: r.against_total == null ? null : toPaiseFromSql(r.against_total),
    againstDate: r.against_date == null ? null : String(r.against_date).slice(0, 10),
    againstSupplyType: r.against_supply_type,
    treatment: r.treatment,
    ecoGstin: r.eco_gstin,
    ecoSection: r.eco_section,
    shippingBill: r.sb_no || r.sb_port
      ? { no: r.sb_no, date: r.sb_date ? String(r.sb_date).slice(0, 10) : null, port: r.sb_port }
      : null,
  }));
  // A debit note is kept with the invoices but reported with the notes, as type D.
  const invoices = sold.filter((h) => h.kind !== 'debit_note');
  const debitNotes = sold.filter((h) => h.kind === 'debit_note');
  const notes: DocHead[] = cnHeads.rows.map((r) => ({
    id: Number(r.id), number: r.number, date: String(r.note_date).slice(0, 10), status: r.status,
    gstin: r.gstin, pos: r.place_of_supply, branchState: r.branch_state, supplyType: r.supply_type,
    totalPaise: toPaiseFromSql(r.total),
    againstTotalPaise: r.against_total == null ? null : toPaiseFromSql(r.against_total),
    againstDate: r.against_date == null ? null : String(r.against_date).slice(0, 10),
    againstSupplyType: r.against_supply_type,
    // A note against a reverse-charge invoice is reported as the invoice was: rchrg Y.
    reverseCharge: Number(r.against_rc ?? 0) === 1,
    treatment: r.treatment,
    ecoGstin: r.eco_gstin,
    ecoSection: r.eco_section,
  }));

  // ── Sort every line into its table ────────────────────────────────────────
  const b2b = new Map<string, unknown[]>();
  const b2cl = new Map<string, unknown[]>();
  const b2cs = new Map<string, Money & { sply_ty: string; pos: string; rt: number }>();
  const exp = { WPAY: [] as unknown[], WOPAY: [] as unknown[] };
  const nil = new Map<string, { nil: Paise; expt: Paise; ngsup: Paise }>();
  const cdnr = new Map<string, unknown[]>();
  const cdnur: unknown[] = [];

  const addNil = (head: DocHead, l: RateRow, sign: number) => {
    const key = nilKey(head);
    const row = nil.get(key) ?? { nil: 0, expt: 0, ngsup: 0 };
    const field = l.taxPref === 'exempt' ? 'expt' : l.taxPref === 'non_gst' ? 'ngsup' : 'nil';
    row[field] += sign * l.taxable;
    nil.set(key, row);
  };
  const addB2cs = (head: DocHead, l: RateRow, sign: number) => {
    const sply_ty = head.pos === head.branchState ? 'INTRA' : 'INTER';
    const key = `${sply_ty}|${head.pos}|${l.rate}`;
    const prev = b2cs.get(key) ?? { ...ZERO, sply_ty, pos: head.pos, rt: l.rate };
    b2cs.set(key, { ...prev, ...add(prev, l, sign) });
  };

  // Table 14: supplies through an e-commerce operator, by its GSTIN.
  const eco = { clttx: new Map<string, Money>(), paytx: new Map<string, Money>() };
  const addEco = (head: DocHead, lines: RateRow[], sign: number) => {
    if (!head.ecoGstin || !head.ecoSection) return;
    const book = head.ecoSection === '9_5' ? eco.paytx : eco.clttx;
    let sum = book.get(head.ecoGstin) ?? ZERO;
    for (const l of lines) {
      // Under s.9(5) the invoice charged nothing; the operator pays the tax at the line's rate.
      let v: Money = l;
      if (head.ecoSection === '9_5') {
        const t = reverseChargeTax(l.taxable, l.rate, head.pos === head.branchState);
        v = { taxable: l.taxable, cgst: t.cgstPaise, sgst: t.sgstPaise, igst: t.igstPaise, cess: 0 };
      }
      sum = add(sum, v, sign);
    }
    book.set(head.ecoGstin, sum);
  };

  const record = (head: DocHead, docType: Gstr1DocEntry['docType'], section: Gstr1Section, lines: RateRow[], sign: number,
    entry: Record<string, unknown> | null, group: Record<string, unknown> = {}) => {
    const t = lines.reduce((acc, l) => add(acc, l, sign), ZERO);
    docs.push({
      docType, docId: head.id, number: head.number, date: head.date, section,
      ctin: section === 'b2b' || section === 'cdnr' ? head.gstin : null, pos: head.pos, valuePaise: head.totalPaise,
      taxablePaise: t.taxable, igstPaise: t.igst, cgstPaise: t.cgst, sgstPaise: t.sgst, cessPaise: t.cess,
      entry, group,
      rates: lines.map((l) => ({ rt: l.rate, txval: r2(sign * l.taxable), iamt: r2(sign * l.igst), camt: r2(sign * l.cgst), samt: r2(sign * l.sgst), csamt: r2(sign * l.cess) })),
      eco: head.ecoGstin && head.ecoSection ? { gstin: head.ecoGstin, section: head.ecoSection } : null,
    });
  };

  for (const head of invoices) {
    if (head.status === 'void') continue;
    const lines = invRates.get(head.id) ?? [];
    // Under s.9(5) the operator pays the tax and reports the supply (table 15);
    // the supplier reports it in table 14(b) alone.
    if (head.ecoSection === '9_5' && head.ecoGstin) {
      addEco(head, lines, 1);
      record(head, 'invoice', 'eco95', lines, 1, null, { etin: head.ecoGstin });
      continue;
    }
    const taxed = lines.filter((l) => !isNilLine(head, l));
    addEco(head, taxed, 1);
    for (const l of lines) if (isNilLine(head, l)) addNil(head, l, 1);
    if (!taxed.length) {
      if (lines.length) record(head, 'invoice', 'nil', lines, 1, null, { sply_ty: nilKey(head) });
      continue;
    }

    const section = invoiceSection(head);
    const base = { inum: head.number, idt: dmy(head.date), val: r2(head.totalPaise) };
    switch (section) {
      case 'b2b':
      case 'sez': {
        // A deemed export (s.147: supplies to an EOU, against an advance
        // authorisation) is taxed like any B2B supply but marked DE.
        const inv_typ = section === 'sez'
          ? (taxed.some((l) => l.igst > 0) ? 'SEWP' : 'SEWOP')
          : head.treatment === 'deemed_export' ? 'DE' : 'R';
        const list = b2b.get(head.gstin ?? '') ?? [];
        // Reverse charge: the invoice charged no GST, but the return reports the
        // tax the recipient owes on it, at each rate, with rchrg Y.
        const items = head.reverseCharge
          ? taxed.map((l) => {
              const owed = reverseChargeTax(l.taxable, l.rate, head.pos === head.branchState);
              return { ...l, cgst: owed.cgstPaise, sgst: owed.sgstPaise, igst: owed.igstPaise, cess: 0 as Paise };
            })
          : taxed;
        const entry = { ...base, pos: head.pos, rchrg: head.reverseCharge ? 'Y' : 'N', inv_typ, itms: wrapped(items, 'all') };
        list.push(entry);
        b2b.set(head.gstin ?? '', list);
        record(head, 'invoice', 'b2b', items, 1, entry);
        break;
      }
      case 'b2cl': {
        const list = b2cl.get(head.pos) ?? [];
        const entry = { ...base, itms: wrapped(taxed, 'igst') };
        list.push(entry);
        b2cl.set(head.pos, list);
        record(head, 'invoice', 'b2cl', taxed, 1, entry);
        break;
      }
      case 'b2cs':
        for (const l of taxed) addB2cs(head, l, 1);
        record(head, 'invoice', 'b2cs', taxed, 1, null, { sply_ty: head.pos === head.branchState ? 'INTRA' : 'INTER' });
        break;
      case 'exp_wpay':
      case 'exp_wopay': {
        const entry = {
          ...base,
          // The shipping bill, when it is known; the portal takes the invoice
          // without it and it can be amended in when it arrives.
          ...(head.shippingBill?.port ? { sbpcode: head.shippingBill.port } : {}),
          ...(head.shippingBill?.no ? { sbnum: head.shippingBill.no } : {}),
          ...(head.shippingBill?.date ? { sbdt: dmy(head.shippingBill.date) } : {}),
          itms: taxed.map((l) => ({ txval: r2(l.taxable), rt: l.rate, iamt: r2(l.igst), csamt: r2(l.cess) })),
        };
        (section === 'exp_wpay' ? exp.WPAY : exp.WOPAY).push(entry);
        record(head, 'invoice', 'exp', taxed, 1, entry, { exp_typ: section === 'exp_wpay' ? 'WPAY' : 'WOPAY' });
        break;
      }
    }
  }

  // Credit notes take tax off (sign -1), debit notes add it (+1); both are
  // reported where the invoice they follow was.
  const addNote = (head: DocHead, lines: RateRow[], ntty: 'C' | 'D', sign: 1 | -1) => {
    const base = { ntty, nt_num: head.number, nt_dt: dmy(head.date), val: r2(head.totalPaise) };
    const docType = ntty === 'C' ? 'credit_note' as const : 'debit_note' as const;
    // A note on a s.9(5) supply changes table 14(b) alone, as the supply did.
    if (head.ecoSection === '9_5' && head.ecoGstin) {
      addEco(head, lines, sign);
      record(head, docType, 'eco95', lines, sign, null, { etin: head.ecoGstin });
      return;
    }
    addEco(head, lines.filter((l) => !isNilLine(head, l)), sign);
    if (head.gstin) {
      // A note to a registered buyer goes in whole: the buyer has to reverse
      // the credit, nil-rated lines included.
      const inv_typ = head.supplyType === 'sez' ? (lines.some((l) => l.igst > 0) ? 'SEWP' : 'SEWOP') : 'R';
      const list = cdnr.get(head.gstin) ?? [];
      // Reverse charge: the note gave back no GST; it reports the tax the recipient reverses.
      const items = head.reverseCharge
        ? lines.map((l) => {
            const owed = reverseChargeTax(l.taxable, l.rate, head.pos === head.branchState);
            return { ...l, cgst: owed.cgstPaise, sgst: owed.sgstPaise, igst: owed.igstPaise, cess: 0 as Paise };
          })
        : lines;
      const entry = { ...base, pos: head.pos, rchrg: head.reverseCharge ? 'Y' : 'N', inv_typ, itms: wrapped(items, 'all') };
      list.push(entry);
      cdnr.set(head.gstin, list);
      record(head, docType, 'cdnr', items, sign, entry);
      return;
    }
    for (const l of lines) if (isNilLine(head, l)) addNil(head, l, sign);
    const taxed = lines.filter((l) => !isNilLine(head, l));
    if (!taxed.length) {
      if (lines.length) record(head, docType, 'nil', lines, sign, null, { sply_ty: nilKey(head) });
      return;
    }

    const original = head.againstSupplyType ?? head.supplyType;
    if (original === 'export_with_tax' || original === 'export_lut') {
      const typ = original === 'export_with_tax' ? 'EXPWP' : 'EXPWOP';
      const entry = { typ, ...base, itms: wrapped(taxed, 'igst') };
      cdnur.push(entry);
      record(head, docType, 'cdnur', taxed, sign, entry, { typ });
    } else if (
      original === 'inter' && head.againstTotalPaise != null && head.againstDate
      && head.againstTotalPaise > b2clThreshold(head.againstDate)
    ) {
      const entry = { typ: 'B2CL', ...base, pos: head.pos, itms: wrapped(taxed, 'igst') };
      cdnur.push(entry);
      record(head, docType, 'cdnur', taxed, sign, entry, { typ: 'B2CL' });
    } else {
      for (const l of taxed) addB2cs(head, l, sign);
      record(head, docType, 'b2cs', taxed, sign, null, { sply_ty: head.pos === head.branchState ? 'INTRA' : 'INTER' });
    }
  };
  for (const head of notes) if (head.status !== 'void') addNote(head, cnRates.get(head.id) ?? [], 'C', -1);
  for (const head of debitNotes) if (head.status !== 'void') addNote(head, invRates.get(head.id) ?? [], 'D', 1);

  // ── Table 12: HSN summary, net of credit notes ────────────────────────────
  const hsnRows = await sql<{
    registered: number; code: string | null; description: string | null; uqc: string | null; rate: string;
    qty: string; taxable: string; cgst: string; sgst: string; igst: string; cess: string;
  }>`
    SELECT registered, code, MAX(description) AS description, uqc, rate,
           SUM(qty) AS qty, SUM(taxable) AS taxable, SUM(cgst) AS cgst,
           SUM(sgst) AS sgst, SUM(igst) AS igst, SUM(cess) AS cess
      FROM (
        SELECT (NULLIF(c.gstin, '') IS NOT NULL) AS registered, l.hsn_sac AS code, h.description,
               COALESCE(l.uqc, 'NOS') AS uqc, l.gst_rate_pct AS rate,
               l.qty, l.taxable, l.cgst, l.sgst, l.igst, l.cess
          FROM invoice_lines l
          JOIN invoices i ON i.id = l.invoice_id
          JOIN contacts c ON c.id = i.customer_id
          LEFT JOIN hsn_codes h ON h.org_id = i.org_id AND h.code = l.hsn_sac
         WHERE i.org_id = ${orgId} AND i.status NOT IN ('draft', 'void')
           AND i.invoice_date BETWEEN ${period.from} AND ${period.to}
           ${branchFilter('i')}
        UNION ALL
        SELECT (NULLIF(c.gstin, '') IS NOT NULL), l.hsn_sac, h.description,
               COALESCE(l.uqc, 'NOS'), l.gst_rate_pct,
               -l.qty, -l.taxable, -l.cgst, -l.sgst, -l.igst, -l.cess
          FROM credit_note_lines l
          JOIN credit_notes n ON n.id = l.credit_note_id
          JOIN contacts c ON c.id = n.customer_id
          LEFT JOIN hsn_codes h ON h.org_id = n.org_id AND h.code = l.hsn_sac
         WHERE n.org_id = ${orgId} AND n.status NOT IN ('void', 'draft')
           AND n.note_date BETWEEN ${period.from} AND ${period.to}
           ${branchFilter('n')}
      ) x
     GROUP BY registered, code, uqc, rate
     ORDER BY registered DESC, code, rate
  `.execute(ex);

  const hsnEntry = (r: (typeof hsnRows.rows)[number], num: number) => {
    const code = r.code ?? '';
    const service = code.startsWith('99');
    return {
      num,
      hsn_sc: code,
      desc: (r.description ?? '').trim().slice(0, HSN_DESC_LIMIT),
      // Services have no quantity. A negative quantity (more returned than
      // sold this month) makes the portal refuse the upload, so it stops at 0.
      uqc: service ? 'NA' : (r.uqc ?? 'NOS'),
      qty: service ? 0 : Math.max(0, Math.round(Number(r.qty) * 100) / 100),
      rt: Number(r.rate),
      txval: r2(toPaiseFromSql(r.taxable)),
      iamt: r2(toPaiseFromSql(r.igst)),
      camt: r2(toPaiseFromSql(r.cgst)),
      samt: r2(toPaiseFromSql(r.sgst)),
      csamt: r2(toPaiseFromSql(r.cess)),
    };
  };
  const hsnLive = hsnRows.rows.filter((r) => toPaiseFromSql(r.taxable) !== 0 || Number(r.qty) !== 0);
  const hsn = month >= HSN_SPLIT_FROM
    ? {
        hsn_b2b: hsnLive.filter((r) => Number(r.registered) === 1).map((r, i) => hsnEntry(r, i + 1)),
        hsn_b2c: hsnLive.filter((r) => Number(r.registered) !== 1).map((r, i) => hsnEntry(r, i + 1)),
      }
    : { data: hsnLive.map((r, i) => hsnEntry(r, i + 1)) };

  // ── Assemble, leaving out empty tables ────────────────────────────────────
  const branch = await ex
    .selectFrom('branches')
    .select(['gstin'])
    .where('org_id', '=', orgId)
    .$if(!!branchId, (q) => q.where('id', '=', branchId!))
    .$if(!branchId, (q) => q.where('is_primary', '=', 1))
    .executeTakeFirst();

  const file: Gstr1PortalFile = { gstin: branch?.gstin ?? '', fp: month.slice(5, 7) + month.slice(0, 4) };
  const put = (key: string, value: unknown[] | Record<string, unknown>) => {
    const empty = Array.isArray(value)
      ? value.length === 0
      : Object.values(value).every((v) => Array.isArray(v) && v.length === 0);
    if (!empty) file[key] = value;
  };

  put('b2b', [...b2b].map(([ctin, inv]) => ({ ctin, inv })));
  put('cdnr', [...cdnr].map(([ctin, nt]) => ({ ctin, nt })));
  if (scope === 'iff') return { file, docs: docs.filter((d) => d.section === 'b2b' || d.section === 'cdnr') };

  put('b2cl', [...b2cl].map(([pos, inv]) => ({ pos, inv })));
  put('b2cs', [...b2cs.values()]
    .filter((r) => r.taxable !== 0 || r.igst + r.cgst + r.sgst + r.cess !== 0)
    .map((r) => ({
      sply_ty: r.sply_ty, pos: r.pos, typ: 'OE', rt: r.rt,
      txval: r2(r.taxable), iamt: r2(r.igst), camt: r2(r.cgst), samt: r2(r.sgst), csamt: r2(r.cess),
    })));
  put('exp', [
    ...(exp.WPAY.length ? [{ exp_typ: 'WPAY', inv: exp.WPAY }] : []),
    ...(exp.WOPAY.length ? [{ exp_typ: 'WOPAY', inv: exp.WOPAY }] : []),
  ]);
  if (nil.size) {
    file.nil = {
      inv: ['INTRB2B', 'INTRAB2B', 'INTRB2C', 'INTRAB2C']
        .filter((k) => nil.has(k))
        .map((k) => ({ sply_ty: k, nil_amt: r2(nil.get(k)!.nil), expt_amt: r2(nil.get(k)!.expt), ngsup_amt: r2(nil.get(k)!.ngsup) })),
    };
  }
  put('cdnur', cdnur);

  // Tables 11A and 11B: GST on advances for services.
  const adv = await advancesForMonth(ex, orgId, period, branchId);
  const advSection = (rows: AdvanceRow[]) => {
    const byPos = new Map<string, AdvanceRow[]>();
    for (const r of rows) byPos.set(`${r.pos}|${r.supplyType}`, [...(byPos.get(`${r.pos}|${r.supplyType}`) ?? []), r]);
    return [...byPos.values()].map((list) => ({
      pos: list[0].pos,
      sply_ty: list[0].supplyType,
      itms: list.map((r) => ({
        rt: r.ratePct, ad_amt: r2(r.taxablePaise), iamt: r2(r.igstPaise), camt: r2(r.cgstPaise), samt: r2(r.sgstPaise), csamt: 0,
      })),
    }));
  };
  put('at', advSection(adv.received));
  put('txpd', advSection(adv.adjusted));
  put('hsn', hsn);

  // A deleted document's number was issued all the same: it counts as cancelled (migration 118).
  const { rows: gone } = await sql<{ doc_type: string; number: string }>`
    SELECT d.doc_type, d.number FROM deleted_documents d
     WHERE d.org_id = ${orgId} AND d.doc_type IN ('invoice', 'debit_note', 'credit_note') AND d.number IS NOT NULL
       AND d.doc_date BETWEEN ${period.from} AND ${period.to}
       ${branchFilter('d')}
  `.execute(ex);
  const cancelled = (type: string) => gone.filter((g) => g.doc_type === type).map((g) => ({ number: g.number, status: 'void' }));
  // Table 13 item 2, invoices for inward supply from an unregistered person:
  // the self-invoices raised on reverse-charge bills. A void or deleted bill's
  // self-invoice number was issued all the same, so it counts as cancelled.
  const { rows: selfInvoices } = await sql<{ number: string; status: string }>`
    SELECT b.self_invoice_no AS number, b.status FROM bills b
     WHERE b.org_id = ${orgId} AND b.is_rcm = 1 AND b.self_invoice_no IS NOT NULL AND b.status <> 'draft'
       AND b.bill_date BETWEEN ${period.from} AND ${period.to}
       ${branchFilter('b')}
    UNION ALL
    SELECT JSON_UNQUOTE(JSON_EXTRACT(d.snapshot, '$.bill.self_invoice_no')) AS number, 'void' AS status FROM deleted_documents d
     WHERE d.org_id = ${orgId} AND d.doc_type = 'bill'
       AND JSON_UNQUOTE(JSON_EXTRACT(d.snapshot, '$.bill.self_invoice_no')) IS NOT NULL
       AND JSON_UNQUOTE(JSON_EXTRACT(d.snapshot, '$.bill.self_invoice_no')) <> 'null'
       AND JSON_UNQUOTE(JSON_EXTRACT(d.snapshot, '$.bill.status')) <> 'draft'
       AND d.doc_date BETWEEN ${period.from} AND ${period.to}
       ${branchFilter('d')}
  `.execute(ex);
  const docDet = [
    { doc_num: 1, docs: seriesRanges([...invoices, ...cancelled('invoice')]) },
    { doc_num: 2, docs: seriesRanges(selfInvoices.map((s) => ({ number: s.number, status: s.status === 'void' ? 'void' : 'issued' }))) },
    { doc_num: 4, docs: seriesRanges([...debitNotes, ...cancelled('debit_note')]) },
    { doc_num: 5, docs: seriesRanges([...notes, ...cancelled('credit_note')]) },
  ].filter((d) => d.docs.length);
  if (docDet.length) file.doc_issue = { doc_det: docDet };

  // Table 14, by operator: (a) s.52, the operator collected TCS; (b) s.9(5), the operator pays the tax.
  const ecoRows = (m: Map<string, Money>) => [...m].filter(([, v]) => v.taxable !== 0)
    .map(([etin, v]) => ({ etin, suppval: r2(v.taxable), igst: r2(v.igst), cgst: r2(v.cgst), sgst: r2(v.sgst), cess: r2(v.cess) }));
  const clttx = ecoRows(eco.clttx);
  const paytx = ecoRows(eco.paytx);
  if (clttx.length || paytx.length) file.supeco = { ...(clttx.length ? { clttx } : {}), ...(paytx.length ? { paytx } : {}) };

  // Table 15, for a book that is itself an e-commerce operator: the s.9(5)
  // supplies it paid the tax on (gst_eco_supplies), by supplier, place of
  // supply and rate. The operator does not hold each buyer's GSTIN, so they
  // are reported in the summary part, as to unregistered recipients.
  const { rows: op95 } = await sql<{ stin: string; pos: string; inter: number; rate: string; txval: string; igst: string; cgst: string; sgst: string }>`
    SELECT supplier_gstin AS stin, place_of_supply AS pos, inter, rate_pct AS rate,
           SUM(net_value) AS txval, SUM(igst) AS igst, SUM(cgst) AS cgst, SUM(sgst) AS sgst
      FROM gst_eco_supplies
     WHERE org_id = ${orgId} AND section = '9_5' AND period = ${month}
       ${branchId ? sql`AND branch_id = ${branchId}` : sql``}
     GROUP BY supplier_gstin, place_of_supply, inter, rate_pct
  `.execute(ex);
  if (op95.length) {
    file.ecob2c = op95.map((r) => ({
      stin: r.stin, pos: r.pos, sply_ty: Number(r.inter) === 1 ? 'INTER' : 'INTRA', rt: Number(r.rate),
      txval: r2(toPaiseFromSql(r.txval)), iamt: r2(toPaiseFromSql(r.igst)), camt: r2(toPaiseFromSql(r.cgst)), samt: r2(toPaiseFromSql(r.sgst)), csamt: 0,
    }));
  }

  return { file, docs };
}
