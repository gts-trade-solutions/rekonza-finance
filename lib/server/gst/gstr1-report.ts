import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// GSTR-1 for the screen: every table of the form, built from the same file the
// portal takes (gstr1-json.ts), so what a person checks here is what they
// upload — and tied out to the books on two sides:
//
//   · the sales register: the documents' own totals against what the return
//     reports from their lines. They differ only where a charge on the
//     document header is not split by line, or where reverse charge or a
//     s.9(5) supply moves the tax off the document; each such document is
//     named.
//   · the general ledger: output CGST, SGST, IGST and cess as posted in the
//     month, source by source, against the tax the return carries (documents,
//     advances, an operator's s.9(5) supplies). A posting that no document of
//     the return explains (a manual journal) is shown as the difference.
//
// Table numbers are the form's (Rule 59(1), Form GSTR-1 as amended by
// Notification 26/2022-CT): 4A/4B/6B/6C B2B, 5 B2CL, 6A exports, 7 B2CS,
// 8 nil-rated / exempt / non-GST, 9A/9C/10 amendments, 9B notes, 11A/11B
// advances, 12 HSN, 13 documents issued, 14 and 15 e-commerce.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor } from '../db';
import type { Paise } from '../../types';
import { toPaiseFromSql } from '../money-sql';
import { gstr1, monthRange } from './returns';
import { gstr1Build, type Gstr1DocEntry } from './gstr1-json';
import { gstr1Amendments, type Gstr1Amendment } from './gstr1-amendments';
import { legalMinimumDigits } from '../../tax/hsn';
import { CODE } from '../ledger/chart-of-accounts';

const p = toPaiseFromSql;
const fromRupees = (n: unknown) => Math.round(Number(n ?? 0) * 100);

export interface Heads { taxablePaise: Paise; igstPaise: Paise; cgstPaise: Paise; sgstPaise: Paise; cessPaise: Paise }
const ZERO: Heads = { taxablePaise: 0, igstPaise: 0, cgstPaise: 0, sgstPaise: 0, cessPaise: 0 };
const plus = (a: Heads, b: Heads): Heads => ({
  taxablePaise: a.taxablePaise + b.taxablePaise, igstPaise: a.igstPaise + b.igstPaise, cgstPaise: a.cgstPaise + b.cgstPaise,
  sgstPaise: a.sgstPaise + b.sgstPaise, cessPaise: a.cessPaise + b.cessPaise,
});
const taxOf = (h: Heads) => h.igstPaise + h.cgstPaise + h.sgstPaise + h.cessPaise;

export interface Gstr1DocRow extends Heads {
  docType: Gstr1DocEntry['docType'];
  docId: string;
  number: string;
  date: string;
  party: string;
  gstin: string | null;
  pos: string;
  valuePaise: Paise;
  /** R, SEWP, SEWOP or DE in B2B; WPAY / WOPAY for exports; EXPWP, EXPWOP or B2CL for CDNUR; C or D for a note. */
  type: string | null;
  noteType: 'C' | 'D' | null;
  reverseCharge: boolean;
  /** Sold through an e-commerce operator: its GSTIN and the section. */
  eco: { gstin: string; section: '52' | '9_5' } | null;
  shippingBill: string | null;
  /** A credit or debit note: the invoice it corrects, its number and date (YYYY-MM-DD), as rule 53(1A) asks. */
  againstNumber: string | null;
  againstDate: string | null;
  href: string;
}

export interface Gstr1Table<R> { key: string; ref: string; title: string; help: string; rows: R[]; totals: Heads & { count: number } }

export interface Gstr1Report {
  period: { month: string; from: string; to: string };
  gstin: string | null;
  legalName: string;
  hsnDigits: number;
  tables: {
    b2b: Gstr1Table<Gstr1DocRow>;
    b2cl: Gstr1Table<Gstr1DocRow>;
    exp: Gstr1Table<Gstr1DocRow>;
    b2cs: Gstr1Table<{ splyType: string; pos: string; ratePct: number } & Heads> & { documents: Gstr1DocRow[] };
    nil: Gstr1Table<{ splyType: string; label: string; nilPaise: Paise; exemptPaise: Paise; nonGstPaise: Paise }>;
    cdnr: Gstr1Table<Gstr1DocRow>;
    cdnur: Gstr1Table<Gstr1DocRow>;
    at: Gstr1Table<{ pos: string; splyType: string; ratePct: number } & Heads>;
    atadj: Gstr1Table<{ pos: string; splyType: string; ratePct: number } & Heads>;
    hsnB2b: Gstr1Table<HsnRow>;
    hsnB2c: Gstr1Table<HsnRow>;
    docs: Gstr1Table<{ doc: string; from: string; to: string; total: number; cancelled: number; net: number }>;
    eco14: Gstr1Table<{ etin: string; section: 'tcs_52' | 'tax_9_5'; label: string } & Heads>;
    eco15: Gstr1Table<{ stin: string; pos: string; splyType: string; ratePct: number } & Heads>;
  };
  amendments: { rows: Gstr1Amendment[]; count: number; inFile: number };
  tieOut: {
    register: { label: string; booksPaise: Paise; returnPaise: Paise; differencePaise: Paise }[];
    registerReasons: { number: string; href: string; reason: string; paise: Paise }[];
    ledger: { head: 'IGST' | 'CGST' | 'SGST' | 'CESS'; code: string; ledgerPaise: Paise; returnPaise: Paise; differencePaise: Paise }[];
    ledgerBySource: { source: string; label: string; inReturn: boolean; igstPaise: Paise; cgstPaise: Paise; sgstPaise: Paise; cessPaise: Paise }[];
    tied: boolean;
  };
  issues: { level: 'error' | 'warning'; message: string }[];
  documentCount: number;
}

export interface HsnRow {
  code: string; description: string; uqc: string; qty: number; ratePct: number;
  taxablePaise: Paise; igstPaise: Paise; cgstPaise: Paise; sgstPaise: Paise; cessPaise: Paise; short: boolean;
}

const NIL_LABEL: Record<string, string> = {
  INTRB2B: 'Inter-state supplies to registered persons',
  INTRAB2B: 'Intra-state supplies to registered persons',
  INTRB2C: 'Inter-state supplies to unregistered persons',
  INTRAB2C: 'Intra-state supplies to unregistered persons',
};
const DOC_LABEL: Record<number, string> = {
  1: 'Invoices for outward supply',
  2: 'Invoices for inward supply from unregistered person',
  4: 'Debit notes',
  5: 'Credit notes',
};
const SOURCE_LABEL: Record<string, string> = {
  invoice: 'Invoices and debit notes',
  credit_note: 'Credit notes',
  payment_received: 'Advances received for services (11A)',
  advance_adjustment: 'Advances set against invoices (11B)',
  gst_eco_supply: 'Supplies under s.9(5) as the e-commerce operator (table 15)',
  gst_eco_amendment: 'Amended s.9(5) supplies as the operator',
  gst_tax_payment: 'GST paid and set off (not a supply: settles the liability)',
};
/** Postings the return does not report as supplies: the payment of the tax itself. */
const SETTLEMENT = new Set(['gst_tax_payment']);

function hrefOf(docType: Gstr1DocEntry['docType'], id: number) {
  return docType === 'credit_note' ? `/sales/credit-notes/${id}` : `/sales/invoices/${id}`;
}

function totals<R extends Partial<Heads>>(rows: R[], count = rows.length): Heads & { count: number } {
  return { ...rows.reduce<Heads>((t, r) => plus(t, { ...ZERO, ...r } as Heads), ZERO), count };
}

export async function gstr1Report(ex: Executor, orgId: number, month: string): Promise<Gstr1Report> {
  const period = monthRange(month);
  const [{ file, docs }, base, amend, org] = await Promise.all([
    gstr1Build(ex, orgId, month),
    gstr1(ex, orgId, month),
    gstr1Amendments(ex, orgId, month),
    ex.selectFrom('organizations').select(['name', 'legal_name', 'aato_above_5cr']).where('id', '=', orgId).executeTakeFirstOrThrow(),
  ]);

  // Who each document was to, and the bits the file keeps only as codes.
  const invIds = docs.filter((d) => d.docType !== 'credit_note').map((d) => d.docId);
  const cnIds = docs.filter((d) => d.docType === 'credit_note').map((d) => d.docId);
  const meta = new Map<string, { party: string; gstin: string | null; rc: boolean; sb: string | null; againstNumber: string | null; againstDate: string | null }>();
  const ymd = (v: unknown) => (v ? String(v instanceof Date ? new Date(v.getTime() - v.getTimezoneOffset() * 60_000).toISOString() : v).slice(0, 10) : null);
  if (invIds.length) {
    const r = await ex.selectFrom('invoices as i').innerJoin('contacts as c', 'c.id', 'i.customer_id')
      .leftJoin('invoices as o', 'o.id', 'i.against_invoice_id')
      .select(['i.id', 'i.doc_kind', 'c.display_name', 'c.gstin', 'i.reverse_charge', 'i.export_shipping_bill_no', 'i.export_port_code',
        'o.number as against_number', 'o.invoice_date as against_date'])
      .where('i.id', 'in', invIds).execute();
    for (const x of r) {
      meta.set(`${x.doc_kind === 'debit_note' ? 'debit_note' : 'invoice'}:${x.id}`, {
        party: x.display_name, gstin: x.gstin, rc: Number(x.reverse_charge) === 1,
        sb: x.export_shipping_bill_no ? `${x.export_port_code ?? ''} ${x.export_shipping_bill_no}`.trim() : null,
        againstNumber: x.doc_kind === 'debit_note' ? x.against_number ?? null : null,
        againstDate: x.doc_kind === 'debit_note' ? ymd(x.against_date) : null,
      });
    }
  }
  if (cnIds.length) {
    const r = await ex.selectFrom('credit_notes as n').innerJoin('contacts as c', 'c.id', 'n.customer_id')
      .leftJoin('invoices as o', 'o.id', 'n.against_invoice_id')
      .select(['n.id', 'c.display_name', 'c.gstin', 'o.number as against_number', 'o.invoice_date as against_date']).where('n.id', 'in', cnIds).execute();
    for (const x of r) meta.set(`credit_note:${x.id}`, { party: x.display_name, gstin: x.gstin, rc: false, sb: null, againstNumber: x.against_number ?? null, againstDate: ymd(x.against_date) });
  }
  const row = (d: Gstr1DocEntry): Gstr1DocRow => {
    const m = meta.get(`${d.docType}:${d.docId}`);
    const e = (d.entry ?? {}) as Record<string, unknown>;
    return {
      docType: d.docType, docId: String(d.docId), number: d.number, date: d.date, party: m?.party ?? '', gstin: d.ctin ?? m?.gstin ?? null, pos: d.pos,
      valuePaise: d.valuePaise, taxablePaise: d.taxablePaise, igstPaise: d.igstPaise, cgstPaise: d.cgstPaise, sgstPaise: d.sgstPaise, cessPaise: d.cessPaise,
      type: (e.inv_typ as string) ?? (d.group.exp_typ as string) ?? (e.typ as string) ?? null,
      noteType: d.docType === 'credit_note' ? 'C' : d.docType === 'debit_note' ? 'D' : null,
      reverseCharge: e.rchrg === 'Y', eco: d.eco ?? null, shippingBill: m?.sb ?? null,
      againstNumber: m?.againstNumber ?? null, againstDate: m?.againstDate ?? null, href: hrefOf(d.docType, d.docId),
    };
  };
  const of = (section: Gstr1DocEntry['section']) => docs.filter((d) => d.section === section).map(row);

  // ── The tables ────────────────────────────────────────────────────────────
  const b2b = of('b2b');
  const b2cl = of('b2cl');
  const exp = of('exp');
  const cdnr = of('cdnr');
  const cdnur = of('cdnur');
  const b2csDocs = of('b2cs');
  const b2csRows = ((file.b2cs as Record<string, unknown>[] | undefined) ?? []).map((r) => ({
    splyType: String(r.sply_ty), pos: String(r.pos), ratePct: Number(r.rt),
    taxablePaise: fromRupees(r.txval), igstPaise: fromRupees(r.iamt), cgstPaise: fromRupees(r.camt), sgstPaise: fromRupees(r.samt), cessPaise: fromRupees(r.csamt),
  }));
  const nilRows = (((file.nil as { inv?: Record<string, unknown>[] } | undefined)?.inv) ?? []).map((r) => ({
    splyType: String(r.sply_ty), label: NIL_LABEL[String(r.sply_ty)] ?? String(r.sply_ty),
    nilPaise: fromRupees(r.nil_amt), exemptPaise: fromRupees(r.expt_amt), nonGstPaise: fromRupees(r.ngsup_amt),
  }));
  const advRows = (key: 'at' | 'txpd') => ((file[key] as { pos: string; sply_ty: string; itms: Record<string, unknown>[] }[] | undefined) ?? [])
    .flatMap((g) => g.itms.map((i) => ({
      pos: g.pos, splyType: g.sply_ty, ratePct: Number(i.rt),
      taxablePaise: fromRupees(i.ad_amt), igstPaise: fromRupees(i.iamt), cgstPaise: fromRupees(i.camt), sgstPaise: fromRupees(i.samt), cessPaise: fromRupees(i.csamt),
    })));
  const at = advRows('at');
  const atadj = advRows('txpd');

  const digits = legalMinimumDigits(!!org.aato_above_5cr);
  const hsnFile = file.hsn as { hsn_b2b?: Record<string, unknown>[]; hsn_b2c?: Record<string, unknown>[]; data?: Record<string, unknown>[] } | undefined;
  const hsnRow = (r: Record<string, unknown>): HsnRow => {
    const code = String(r.hsn_sc ?? '');
    return {
      code, description: String(r.desc ?? ''), uqc: String(r.uqc ?? 'NOS'), qty: Number(r.qty ?? 0), ratePct: Number(r.rt ?? 0),
      taxablePaise: fromRupees(r.txval), igstPaise: fromRupees(r.iamt), cgstPaise: fromRupees(r.camt), sgstPaise: fromRupees(r.samt), cessPaise: fromRupees(r.csamt),
      short: code.length < digits,
    };
  };
  const hsnB2b = (hsnFile?.hsn_b2b ?? hsnFile?.data ?? []).map(hsnRow);
  const hsnB2c = (hsnFile?.hsn_b2c ?? []).map(hsnRow);

  const docIssue = ((file.doc_issue as { doc_det?: { doc_num: number; docs: Record<string, unknown>[] }[] } | undefined)?.doc_det ?? [])
    .flatMap((d) => d.docs.map((x) => ({
      doc: DOC_LABEL[d.doc_num] ?? `Document type ${d.doc_num}`, from: String(x.from), to: String(x.to),
      total: Number(x.totnum), cancelled: Number(x.cancel), net: Number(x.net_issue),
    })));

  const supeco = (file.supeco ?? {}) as { clttx?: Record<string, unknown>[]; paytx?: Record<string, unknown>[] };
  const ecoRow = (section: 'tcs_52' | 'tax_9_5') => (r: Record<string, unknown>) => ({
    etin: String(r.etin), section,
    label: section === 'tcs_52' ? '14(a) The operator collected TCS (section 52)' : '14(b) The operator pays the tax (section 9(5))',
    taxablePaise: fromRupees(r.suppval), igstPaise: fromRupees(r.igst), cgstPaise: fromRupees(r.cgst), sgstPaise: fromRupees(r.sgst), cessPaise: fromRupees(r.cess),
  });
  const eco14 = [...(supeco.clttx ?? []).map(ecoRow('tcs_52')), ...(supeco.paytx ?? []).map(ecoRow('tax_9_5'))];
  const eco15 = ((file.ecob2c as Record<string, unknown>[] | undefined) ?? []).map((r) => ({
    stin: String(r.stin), pos: String(r.pos), splyType: String(r.sply_ty), ratePct: Number(r.rt),
    taxablePaise: fromRupees(r.txval), igstPaise: fromRupees(r.iamt), cgstPaise: fromRupees(r.camt), sgstPaise: fromRupees(r.samt), cessPaise: fromRupees(r.csamt),
  }));

  // ── Tie-out 1: the sales register ─────────────────────────────────────────
  const { rows: reg } = await sql<{ kind: string; id: number; number: string; taxable: string; igst: string; cgst: string; sgst: string; cess: string; rc: number; eco: string | null }>`
    SELECT IF(doc_kind = 'debit_note', 'debit_note', 'invoice') AS kind, id, number, subtotal AS taxable, igst, cgst, sgst, cess, reverse_charge AS rc, eco_section AS eco
      FROM invoices WHERE org_id = ${orgId} AND status NOT IN ('draft', 'void') AND invoice_date BETWEEN ${period.from} AND ${period.to}
    UNION ALL
    SELECT 'credit_note', n.id, n.number, -n.subtotal, -n.igst, -n.cgst, -n.sgst, -n.cess, COALESCE(i.reverse_charge, 0), i.eco_section
      FROM credit_notes n LEFT JOIN invoices i ON i.id = n.against_invoice_id
     WHERE n.org_id = ${orgId} AND n.status NOT IN ('draft', 'void') AND n.note_date BETWEEN ${period.from} AND ${period.to}
  `.execute(ex);
  const headsOfReg = (r: (typeof reg)[number]): Heads => ({ taxablePaise: p(r.taxable), igstPaise: p(r.igst), cgstPaise: p(r.cgst), sgstPaise: p(r.sgst), cessPaise: p(r.cess) });
  const books = reg.reduce<Heads>((t, r) => plus(t, headsOfReg(r)), ZERO);
  const docHeads = (d: Gstr1DocEntry): Heads => ({ taxablePaise: d.taxablePaise, igstPaise: d.igstPaise, cgstPaise: d.cgstPaise, sgstPaise: d.sgstPaise, cessPaise: d.cessPaise });
  const ret = docs.reduce<Heads>((t, d) => plus(t, docHeads(d)), ZERO);
  const registerReasons: Gstr1Report['tieOut']['registerReasons'] = [];
  for (const r of reg) {
    const d = docs.find((x) => x.docType === r.kind && x.docId === Number(r.id));
    const bh = headsOfReg(r);
    const dh = d ? docHeads(d) : ZERO;
    const dTax = taxOf(dh) - taxOf(bh);
    const dVal = dh.taxablePaise - bh.taxablePaise;
    if (!dTax && !dVal) continue;
    const href = hrefOf(r.kind as Gstr1DocEntry['docType'], Number(r.id));
    if (Number(r.rc) === 1 && dTax) registerReasons.push({ number: r.number, href, paise: dTax, reason: 'Reverse charge: the buyer pays this tax; the return reports it (rchrg Y), the invoice charges none.' });
    else if (dTax || dVal) registerReasons.push({ number: r.number, href, paise: dVal || dTax, reason: d ? 'A charge on the document header (shipping, an adjustment) carries tax not split by line; the return reports it by line.' : 'Not in the return: check the document.' });
  }
  const line = (label: string, b: number, r: number) => ({ label, booksPaise: b, returnPaise: r, differencePaise: r - b });
  const register = [
    line('Taxable value', books.taxablePaise, ret.taxablePaise),
    line('IGST', books.igstPaise, ret.igstPaise),
    line('CGST', books.cgstPaise, ret.cgstPaise),
    line('SGST', books.sgstPaise, ret.sgstPaise),
    line('Cess', books.cessPaise, ret.cessPaise),
  ];

  // ── Tie-out 2: the general ledger, output tax by source ───────────────────
  const { rows: gl } = await sql<{ source_type: string; code: string; net: string }>`
    SELECT e.source_type, a.code, SUM(jl.credit - jl.debit) AS net
      FROM journal_lines jl JOIN journal_entries e ON e.id = jl.entry_id JOIN accounts a ON a.id = jl.account_id
     WHERE e.org_id = ${orgId} AND a.code IN (${CODE.GST_IGST}, ${CODE.GST_CGST}, ${CODE.GST_SGST}, ${CODE.GST_CESS})
       AND e.entry_date BETWEEN ${period.from} AND ${period.to}
     GROUP BY e.source_type, a.code
  `.execute(ex);
  const bySource = new Map<string, { igstPaise: number; cgstPaise: number; sgstPaise: number; cessPaise: number }>();
  const field: Record<string, 'igstPaise' | 'cgstPaise' | 'sgstPaise' | 'cessPaise'> = {
    [CODE.GST_IGST]: 'igstPaise', [CODE.GST_CGST]: 'cgstPaise', [CODE.GST_SGST]: 'sgstPaise', [CODE.GST_CESS]: 'cessPaise',
  };
  for (const r of gl) {
    const s = bySource.get(r.source_type) ?? { igstPaise: 0, cgstPaise: 0, sgstPaise: 0, cessPaise: 0 };
    s[field[r.code]] += p(r.net);
    bySource.set(r.source_type, s);
  }
  // What the return carries as tax on the documents the books charged it on:
  // reverse-charge tax is the buyer's, and never posted here.
  const rcTax = docs.reduce<Heads>((t, d) => ((d.entry as Record<string, unknown> | null)?.rchrg === 'Y' ? plus(t, docHeads(d)) : t), ZERO);
  const advNet = plus(totals(at), { ...ZERO, igstPaise: -totals(atadj).igstPaise, cgstPaise: -totals(atadj).cgstPaise, sgstPaise: -totals(atadj).sgstPaise, cessPaise: -totals(atadj).cessPaise });
  const e15 = totals(eco15);
  const returnTax = (k: 'igstPaise' | 'cgstPaise' | 'sgstPaise' | 'cessPaise') => ret[k] - rcTax[k] + advNet[k] + e15[k];
  const ledgerOf = (k: 'igstPaise' | 'cgstPaise' | 'sgstPaise' | 'cessPaise') =>
    [...bySource].filter(([s]) => !SETTLEMENT.has(s)).reduce((t, [, v]) => t + v[k], 0);
  const ledger = ([['IGST', CODE.GST_IGST, 'igstPaise'], ['CGST', CODE.GST_CGST, 'cgstPaise'], ['SGST', CODE.GST_SGST, 'sgstPaise'], ['CESS', CODE.GST_CESS, 'cessPaise']] as const)
    .map(([head, code, k]) => ({ head, code, ledgerPaise: ledgerOf(k), returnPaise: returnTax(k), differencePaise: returnTax(k) - ledgerOf(k) }));
  const ledgerBySource = [...bySource].map(([source, v]) => ({
    source, label: SOURCE_LABEL[source] ?? `Other postings (${source.replace(/_/g, ' ')}): not from a document of the return`,
    inReturn: source in SOURCE_LABEL && !SETTLEMENT.has(source), ...v,
  })).sort((a, b) => Number(b.inReturn) - Number(a.inReturn));

  const issues = [...base.issues];
  const short = [...hsnB2b, ...hsnB2c].filter((h) => h.short && h.code);
  if (short.length) {
    issues.push({
      level: 'error',
      message: `${short.length} HSN code(s) have fewer than ${digits} digits (${short.slice(0, 3).map((h) => h.code).join(', ')}). From April 2025 table 12 takes at least ${digits} digits for a business ${org.aato_above_5cr ? 'above' : 'up to'} ₹5 crore turnover (Notification 78/2020-CT, phase III).`,
    });
  }
  if (amend.rows.some((a) => a.cancelled || a.movedTo)) {
    issues.push({ level: 'warning', message: 'Some filed documents were voided, deleted or moved to another table since. The portal cannot amend them to nil or across tables: issue a credit note, or correct them on the portal.' });
  }

  // Tied when the ledger agrees head by head, and every difference with the
  // register is a document named with its reason.
  const tied = ledger.every((l) => l.differencePaise === 0)
    && (register.every((l) => l.differencePaise === 0) || registerReasons.length > 0);

  return {
    period,
    gstin: (file.gstin as string) || null,
    legalName: org.legal_name ?? org.name,
    hsnDigits: digits,
    tables: {
      b2b: { key: 'b2b', ref: '4A, 4B, 6B, 6C', title: 'B2B invoices', help: 'Sales to registered buyers, by GSTIN: they claim credit on these. Reverse charge (4B), SEZ with or without payment (6B) and deemed exports (6C) are marked.', rows: b2b, totals: totals(b2b) },
      b2cl: { key: 'b2cl', ref: '5', title: 'B2C (large)', help: 'Inter-state sales to unregistered buyers above ₹1 lakh (₹2.5 lakh before August 2024), invoice by invoice.', rows: b2cl, totals: totals(b2cl) },
      exp: { key: 'exp', ref: '6A', title: 'Exports', help: 'Exports with payment of IGST (WPAY) or under a Letter of Undertaking (WOPAY), with the shipping bill.', rows: exp, totals: totals(exp) },
      b2cs: { key: 'b2cs', ref: '7', title: 'B2C (others)', help: 'All other sales to unregistered buyers, summed by place of supply and rate, net of the credit notes against them.', rows: b2csRows, totals: totals(b2csRows, b2csDocs.length), documents: b2csDocs },
      nil: {
        key: 'nil', ref: '8', title: 'Nil-rated, exempt and non-GST', help: 'Supplies with no tax, by whether the buyer is registered and the supply inter- or intra-state.', rows: nilRows,
        totals: { ...ZERO, taxablePaise: nilRows.reduce((t, r) => t + r.nilPaise + r.exemptPaise + r.nonGstPaise, 0), count: nilRows.length },
      },
      cdnr: { key: 'cdnr', ref: '9B', title: 'Credit / debit notes (registered)', help: 'Notes to registered buyers: a credit note takes value off, a debit note adds it.', rows: cdnr, totals: totals(cdnr) },
      cdnur: { key: 'cdnur', ref: '9B', title: 'Credit / debit notes (unregistered)', help: 'Notes against B2C large sales and exports. Notes against other consumer sales reduce table 7 instead.', rows: cdnur, totals: totals(cdnur) },
      at: { key: 'at', ref: '11A', title: 'Advances received', help: 'Tax on advances received for services and not invoiced in the same month (goods carry no tax on advances).', rows: at, totals: totals(at) },
      atadj: { key: 'atadj', ref: '11B', title: 'Advances adjusted', help: 'Advances of earlier months set against this month\'s invoices: their tax comes off.', rows: atadj, totals: totals(atadj) },
      hsnB2b: { key: 'hsnB2b', ref: '12', title: 'HSN summary — B2B', help: `By HSN/SAC, UQC and rate, to registered buyers, net of notes. At least ${digits} digits for this book.`, rows: hsnB2b, totals: totals(hsnB2b) },
      hsnB2c: { key: 'hsnB2c', ref: '12', title: 'HSN summary — B2C', help: 'By HSN/SAC, UQC and rate, to unregistered buyers (the split the portal asks for from May 2025).', rows: hsnB2c, totals: totals(hsnB2c) },
      docs: { key: 'docs', ref: '13', title: 'Documents issued', help: 'Every series used in the month, first and last number, with the cancelled and deleted ones counted.', rows: docIssue, totals: { ...ZERO, count: docIssue.reduce((t, d) => t + d.total, 0) } },
      eco14: { key: 'eco14', ref: '14', title: 'Supplies through e-commerce operators', help: 'By the operator\'s GSTIN: where it collected TCS (section 52), and where it pays the tax (section 9(5)) — those are reported here only.', rows: eco14, totals: totals(eco14) },
      eco15: { key: 'eco15', ref: '15', title: 'Supplies under section 9(5) (as the operator)', help: 'For an e-commerce operator: the supplies of others on which it paid the tax, by supplier.', rows: eco15, totals: totals(eco15) },
    },
    amendments: { rows: amend.rows, count: amend.rows.length, inFile: amend.rows.filter((a) => a.inFile).length },
    tieOut: { register, registerReasons, ledger, ledgerBySource, tied },
    issues,
    documentCount: docs.length,
  };
}
