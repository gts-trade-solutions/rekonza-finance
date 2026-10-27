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
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor } from '../db';
import type { Paise } from '../../types';
import { toPaiseFromSql } from '../money-sql';
import { b2clThreshold, monthRange } from './returns';
import { advancesForMonth, type AdvanceRow } from './advances';

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
  /** Credit notes only: the invoice it was raised against. */
  againstTotalPaise?: Paise | null;
  againstDate?: string | null;
  againstSupplyType?: string | null;
  /** Exports only: the shipping bill the refund and the return are matched on. */
  shippingBill?: { no: string | null; date: string | null; port: string | null } | null;
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
 * nothing else.
 */
export async function gstr1PortalFile(
  ex: Executor, orgId: number, month: string,
  opts: { branchId?: number; scope?: 'gstr1' | 'iff' } = {},
): Promise<Gstr1PortalFile> {
  const { branchId, scope = 'gstr1' } = opts;
  const period = monthRange(month);
  const branchFilter = (alias: string) => (branchId ? sql`AND ${sql.ref(`${alias}.branch_id`)} = ${branchId}` : sql``);

  // ── Invoices ──────────────────────────────────────────────────────────────
  const invHeads = await sql<{
    id: number; number: string; invoice_date: string; status: string; gstin: string | null;
    place_of_supply: string; supply_type: string; total: string; branch_state: string;
    sb_no: string | null; sb_date: string | null; sb_port: string | null;
  }>`
    SELECT i.id, i.number, i.invoice_date, i.status, NULLIF(c.gstin, '') AS gstin,
           i.place_of_supply, i.supply_type, i.total, b.state_code AS branch_state,
           i.export_shipping_bill_no AS sb_no, i.export_shipping_bill_date AS sb_date, i.export_port_code AS sb_port
      FROM invoices i
      JOIN contacts c ON c.id = i.customer_id
      JOIN branches b ON b.id = i.branch_id
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
  }>`
    SELECT n.id, n.number, n.note_date, n.status, NULLIF(c.gstin, '') AS gstin,
           n.place_of_supply, n.supply_type, n.total, b.state_code AS branch_state,
           i.total AS against_total, i.invoice_date AS against_date, i.supply_type AS against_supply_type
      FROM credit_notes n
      JOIN contacts c ON c.id = n.customer_id
      JOIN branches b ON b.id = n.branch_id
      LEFT JOIN invoices i ON i.id = n.against_invoice_id
     WHERE n.org_id = ${orgId}
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
     WHERE n.org_id = ${orgId} AND n.status <> 'void'
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

  const invoices: DocHead[] = invHeads.rows.map((r) => ({
    id: Number(r.id), number: r.number, date: String(r.invoice_date).slice(0, 10), status: r.status,
    gstin: r.gstin, pos: r.place_of_supply, branchState: r.branch_state, supplyType: r.supply_type,
    totalPaise: toPaiseFromSql(r.total),
    shippingBill: r.sb_no || r.sb_port
      ? { no: r.sb_no, date: r.sb_date ? String(r.sb_date).slice(0, 10) : null, port: r.sb_port }
      : null,
  }));
  const notes: DocHead[] = cnHeads.rows.map((r) => ({
    id: Number(r.id), number: r.number, date: String(r.note_date).slice(0, 10), status: r.status,
    gstin: r.gstin, pos: r.place_of_supply, branchState: r.branch_state, supplyType: r.supply_type,
    totalPaise: toPaiseFromSql(r.total),
    againstTotalPaise: r.against_total == null ? null : toPaiseFromSql(r.against_total),
    againstDate: r.against_date == null ? null : String(r.against_date).slice(0, 10),
    againstSupplyType: r.against_supply_type,
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

  for (const head of invoices) {
    if (head.status === 'void') continue;
    const lines = invRates.get(head.id) ?? [];
    const taxed = lines.filter((l) => !isNilLine(head, l));
    for (const l of lines) if (isNilLine(head, l)) addNil(head, l, 1);
    if (!taxed.length) continue;

    const section = invoiceSection(head);
    const base = { inum: head.number, idt: dmy(head.date), val: r2(head.totalPaise) };
    switch (section) {
      case 'b2b':
      case 'sez': {
        const inv_typ = section === 'b2b' ? 'R' : taxed.some((l) => l.igst > 0) ? 'SEWP' : 'SEWOP';
        const list = b2b.get(head.gstin ?? '') ?? [];
        list.push({ ...base, pos: head.pos, rchrg: 'N', inv_typ, itms: wrapped(taxed, 'all') });
        b2b.set(head.gstin ?? '', list);
        break;
      }
      case 'b2cl': {
        const list = b2cl.get(head.pos) ?? [];
        list.push({ ...base, itms: wrapped(taxed, 'igst') });
        b2cl.set(head.pos, list);
        break;
      }
      case 'b2cs':
        for (const l of taxed) addB2cs(head, l, 1);
        break;
      case 'exp_wpay':
      case 'exp_wopay':
        (section === 'exp_wpay' ? exp.WPAY : exp.WOPAY).push({
          ...base,
          // The shipping bill, when it is known; the portal takes the invoice
          // without it and it can be amended in when it arrives.
          ...(head.shippingBill?.port ? { sbpcode: head.shippingBill.port } : {}),
          ...(head.shippingBill?.no ? { sbnum: head.shippingBill.no } : {}),
          ...(head.shippingBill?.date ? { sbdt: dmy(head.shippingBill.date) } : {}),
          itms: taxed.map((l) => ({ txval: r2(l.taxable), rt: l.rate, iamt: r2(l.igst), csamt: r2(l.cess) })),
        });
        break;
    }
  }

  for (const head of notes) {
    if (head.status === 'void') continue;
    const lines = cnRates.get(head.id) ?? [];
    const base = { ntty: 'C', nt_num: head.number, nt_dt: dmy(head.date), val: r2(head.totalPaise) };
    if (head.gstin) {
      // A note to a registered buyer goes in whole: the buyer has to reverse
      // the credit, nil-rated lines included.
      const inv_typ = head.supplyType === 'sez' ? (lines.some((l) => l.igst > 0) ? 'SEWP' : 'SEWOP') : 'R';
      const list = cdnr.get(head.gstin) ?? [];
      list.push({ ...base, pos: head.pos, rchrg: 'N', inv_typ, itms: wrapped(lines, 'all') });
      cdnr.set(head.gstin, list);
      continue;
    }
    for (const l of lines) if (isNilLine(head, l)) addNil(head, l, -1);
    const taxed = lines.filter((l) => !isNilLine(head, l));
    if (!taxed.length) continue;

    const original = head.againstSupplyType ?? head.supplyType;
    if (original === 'export_with_tax' || original === 'export_lut') {
      cdnur.push({ typ: original === 'export_with_tax' ? 'EXPWP' : 'EXPWOP', ...base, itms: wrapped(taxed, 'igst') });
    } else if (
      original === 'inter' && head.againstTotalPaise != null && head.againstDate
      && head.againstTotalPaise > b2clThreshold(head.againstDate)
    ) {
      cdnur.push({ typ: 'B2CL', ...base, pos: head.pos, itms: wrapped(taxed, 'igst') });
    } else {
      for (const l of taxed) addB2cs(head, l, -1);
    }
  }

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
         WHERE n.org_id = ${orgId} AND n.status <> 'void'
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
  if (scope === 'iff') return file;

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

  const docDet = [
    { doc_num: 1, docs: seriesRanges(invoices) },
    { doc_num: 5, docs: seriesRanges(notes) },
  ].filter((d) => d.docs.length);
  if (docDet.length) file.doc_issue = { doc_det: docDet };

  return file;
}
