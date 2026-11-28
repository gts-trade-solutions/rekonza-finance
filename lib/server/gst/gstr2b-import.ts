import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// GSTR-2B (or GSTR-2A) from the portal, and IMS actions on it.
//
// The portal lets a taxpayer download GSTR-2B as JSON (Returns → GSTR-2B →
// Download), one file per GSTIN per month. This reads that file into
// gstr2b_entries so the reconciliation has the real statement to work against,
// not a typed-in copy. Re-importing the same month updates the figures and
// keeps whatever IMS action was already recorded on each line.
//
// The parser is forgiving about the wrapper — the file is sometimes the bare
// statement, sometimes wrapped in { data: … } with a checksum — and strict
// about the figures: a line it cannot read is reported, not guessed at. It
// reads GSTN's own GSTR-2B layout (documents with items[] carrying txval,
// igst, cgst, sgst, cess) in all its parts: B2B, B2BA, CDNR, CDNRA, ECOM,
// ISD, ISDA, IMPG and IMPGSEZ; and GSTR-2A's (itms[].itm_det). A file in
// neither layout is refused with a message saying which file to download.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Trx } from '../db';
import { badRequest } from '../http';

export interface Gstr2bLine {
  /** 15 characters; empty for an import from outside India (IMPG), which has no supplier GSTIN. */
  vendorGstin: string;
  vendorName: string | null;
  /**
   * invoice / credit_note / debit_note from a supplier (B2B, B2BA, CDNR, CDNRA, ECOM);
   * isd / isd_credit from an Input Service Distributor (ISD, ISDA);
   * bill_of_entry for imports of goods (IMPG from abroad, IMPGSEZ from a SEZ unit).
   */
  docType: 'invoice' | 'credit_note' | 'debit_note' | 'isd' | 'isd_credit' | 'bill_of_entry';
  number: string;
  /** yyyy-mm-dd */
  date: string;
  /** Rupees, as the portal gives them. */
  taxable: number;
  cgst: number;
  sgst: number;
  igst: number;
  cess: number;
  itcAvailable: boolean;
  reverseCharge: boolean;
}

export interface ParsedGstr2b {
  gstin: string;
  /** MMYYYY, the portal's own form. */
  returnPeriod: string;
  /** Which statement the file was: the GSTR-2B layout or the older GSTR-2A one. */
  layout: '2B' | '2A';
  /** yyyy-mm-dd: when the portal generated the 2B (its gendt), when the file says. */
  generatedOn: string | null;
  lines: Gstr2bLine[];
  skipped: string[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : []);
const num = (v: unknown): number => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : 0;
  return Number.isFinite(n) ? n : 0;
};
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
const has = (o: Obj, k: string) => o[k] !== undefined && o[k] !== null && o[k] !== '';
const GSTIN = /^[0-9A-Z]{15}$/;

/** The portal writes dates as dd-mm-yyyy. */
function portalDate(v: unknown): string | null {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(str(v));
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

type Sums = { taxable: number; igst: number; cgst: number; sgst: number; cess: number };
const ZERO: Sums = { taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 };
/** Rupees to four places, as the table keeps them, so many items add up without float dust. */
const r4 = (n: number) => Math.round(n * 10000) / 10000;
const tidy = (t: Sums): Sums => ({ taxable: r4(t.taxable), igst: r4(t.igst), cgst: r4(t.cgst), sgst: r4(t.sgst), cess: r4(t.cess) });

/**
 * The figures of one document, from whichever layout carries them.
 *
 * GSTN's GSTR-2B JSON (the "Download GSTR-2B details (JSON)" file, and the
 * GSP API's GSTR-2B) gives every invoice and note its rate-wise lines as
 * `items[]`, each `{ num, rt, txval, igst, cgst, sgst, cess }`, and nothing at
 * the document level but `val`, the invoice value. GSTR-2A (and the GSTR-1 a
 * supplier filed, which 2A mirrors) writes the same lines as
 * `itms[].itm_det{ txval, iamt, camt, samt, csamt }`. Some offline tools put
 * the totals on the document itself. All three are read; a document carrying
 * none of them is not guessed at: it is reported as unreadable. (Reading only
 * the document level was the bug the auditor found: a real 2B came in with
 * no tax on any invoice, and every one showed as mismatched.)
 */
function figures(d: Obj): Sums | null {
  if (Array.isArray(d.items) && d.items.length) {
    return tidy(arr(d.items).reduce<Sums>((t, it) => ({
      taxable: t.taxable + num(it.txval), igst: t.igst + num(it.igst ?? it.iamt), cgst: t.cgst + num(it.cgst ?? it.camt),
      sgst: t.sgst + num(it.sgst ?? it.samt), cess: t.cess + num(it.cess ?? it.csamt),
    }), ZERO));
  }
  if (Array.isArray(d.itms) && d.itms.length) {
    return tidy(arr(d.itms).reduce<Sums>((t, it) => {
      const x = isObj(it.itm_det) ? it.itm_det : it;
      return {
        taxable: t.taxable + num(x.txval), igst: t.igst + num(x.iamt ?? x.igst), cgst: t.cgst + num(x.camt ?? x.cgst),
        sgst: t.sgst + num(x.samt ?? x.sgst), cess: t.cess + num(x.csamt ?? x.cess),
      };
    }, ZERO));
  }
  if (['txval', 'igst', 'cgst', 'sgst', 'iamt', 'camt', 'samt'].some((k) => has(d, k))) {
    return tidy({
      taxable: num(d.txval), igst: num(d.igst ?? d.iamt), cgst: num(d.cgst ?? d.camt),
      sgst: num(d.sgst ?? d.samt), cess: num(d.cess ?? d.csamt),
    });
  }
  return null;
}

/**
 * GSTR-2A, the older and still-downloadable statement: the same documents,
 * but every invoice listed with its rate-wise items rather than totals, and
 * no availability flag — whether the supplier filed (cfs) is the nearest
 * thing, so a filed supplier's credit is taken as available. Read into the
 * same lines as 2B, so the reconciliation works on either.
 */
function parseGstr2a(root: Obj): ParsedGstr2b {
  const gstin = str(root.gstin).toUpperCase();
  const returnPeriod = str(root.fp);
  const lines: Gstr2bLine[] = [];
  const skipped: string[] = [];
  const push = (s: Obj, d: Obj, number: string, dt: unknown, docType: Gstr2bLine['docType'], rev: unknown) => {
    const date = portalDate(dt);
    const vendorGstin = str(s.ctin).toUpperCase();
    const f = figures(d);
    if (!number || !date || !GSTIN.test(vendorGstin) || !f) {
      skipped.push(`${vendorGstin || 'unknown supplier'} ${number || '(no number)'}${f ? '' : ': no taxable value or tax on it'}`);
      return;
    }
    lines.push({
      vendorGstin, vendorName: str(s.trdnm) || null, docType, number, date, ...f,
      itcAvailable: str(s.cfs).toUpperCase() !== 'N',
      reverseCharge: str(rev).toUpperCase() === 'Y',
    });
  };
  for (const key of ['b2b', 'b2ba'] as const) {
    for (const s of arr(root[key])) for (const inv of arr(s.inv)) push(s, inv, str(inv.inum), inv.idt, 'invoice', inv.rchrg);
  }
  for (const key of ['cdn', 'cdnr', 'cdna'] as const) {
    for (const s of arr(root[key])) {
      for (const nt of arr(s.nt)) {
        const kind = str(nt.ntty ?? nt.typ).toUpperCase() === 'D' ? 'debit_note' : 'credit_note';
        push(s, nt, str(nt.nt_num ?? nt.ntnum), nt.nt_dt ?? nt.dt, kind, nt.rchrg ?? nt.rev);
      }
    }
  }
  return { gstin, returnPeriod, layout: '2A', generatedOn: null, lines, skipped };
}

const WHICH_FILE = 'On gst.gov.in go to Returns → GSTR-2B → Download GSTR-2B details (JSON), or GSTR-2A → Download (JSON), and import that file.';
const NOT_2B = `That file is not a GSTR-2B or GSTR-2A JSON download. ${WHICH_FILE}`;
/** Tables only a GSTR-1 (our own sales return) has. */
const GSTR1_ONLY = ['b2cs', 'b2cl', 'hsn', 'doc_issue', 'nil', 'exp'];

/**
 * Read a GSTR-2B (or GSTR-2A) JSON file as the GST portal issues it.
 *
 * GSTR-2B's layout (GSTN's published JSON for GSTR-2B, version 1.x):
 *   { gstin, rtnprd: "MMYYYY", gendt: "dd-mm-yyyy", version,
 *     itcsumm: { … },                 the summary: not read, it is worked out again from the documents
 *     docdata: {
 *       b2b:   [{ ctin, trdnm, supfildt, supprd, inv: [{ inum, typ, dt, val, pos, rev, itcavl, rsn, items: [{ num, rt, txval, igst, cgst, sgst, cess }] }] }],
 *       b2ba:  [{ …, inv: [{ oinum, oidt, inum, dt, …, items }] }],            the amendment carries the current figures
 *       cdnr:  [{ …, nt: [{ ntnum, typ: C|D, suptyp, dt, val, pos, rev, itcavl, items }] }],
 *       cdnra: [{ …, nt: [{ ontnum, ontdt, ntnum, typ, dt, …, items }] }],
 *       ecom / ecoma: as b2b / b2ba,   supplies through an e-commerce operator under section 9(5)
 *       isd:   [{ ctin, trdnm, doclist: [{ doctyp: ISD|ISDC, docnum, docdt, oinvnum, oinvdt, igst, cgst, sgst, cess, itcelg }] }],
 *       isda:  as isd,
 *       impg:    [{ refdt, portcode, boenum, boedt, isamd, txval, igst, cess }],
 *       impgsez: [{ ctin, trdnm, boe: [{ refdt, portcode, boenum, boedt, isamd, txval, igst, cess }] }] } }
 * usually wrapped as { chksum, data: { … } }. The wrapper is optional here.
 *
 * GSTR-2A's layout (fp, and b2b / cdn at the top level with itms[].itm_det)
 * is read too. A file that is neither (a GSTR-1, a GSTR-3B, a 2B summary
 * without documents) is refused with a message saying which file to take.
 */
export function parseGstr2b(json: unknown): ParsedGstr2b {
  if (!isObj(json)) throw badRequest(NOT_2B);
  const root = isObj(json.data) ? json.data : json;
  // A GSTR-1 (what we file, not what suppliers filed for us) looks like a 2A
  // at a glance: it is told apart by the tables only GSTR-1 has.
  const salesTables = GSTR1_ONLY.filter((k) => k in root);
  if (salesTables.length && !isObj(root.docdata)) {
    throw badRequest(`That is a GSTR-1 file (it has the sales tables ${salesTables.join(', ')}), not a GSTR-2B. ${WHICH_FILE}`);
  }
  // A GSTR-2A download: a filing period and the supplier tables at the top level.
  if (/^\d{6}$/.test(str(root.fp)) && !isObj(root.docdata)
    && ['b2b', 'b2ba', 'cdn', 'cdnr', 'cdna'].some((k) => Array.isArray(root[k]))) {
    const parsed = parseGstr2a(root);
    if (!GSTIN.test(parsed.gstin)) throw badRequest('That GSTR-2A file has no GSTIN.');
    if (!parsed.lines.length && parsed.skipped.length) {
      throw badRequest(`None of the ${parsed.skipped.length} document(s) in that GSTR-2A could be read (${parsed.skipped.slice(0, 3).join('; ')}).`);
    }
    return parsed;
  }
  const gstin = str(root.gstin).toUpperCase();
  const returnPeriod = str(root.rtnprd);
  const doc = isObj(root.docdata) ? root.docdata : null;
  if (!doc) {
    if (isObj(root.itcsumm) || isObj(root.cpsumm)) {
      throw badRequest('That GSTR-2B file is the summary only, with no documents in it. Download "GSTR-2B details (JSON)", which lists every invoice.');
    }
    throw badRequest(NOT_2B);
  }
  if (!GSTIN.test(gstin) || !/^\d{6}$/.test(returnPeriod)) {
    throw badRequest('That file is not a GSTR-2B JSON download: it has no GSTIN (gstin) or return period (rtnprd, MMYYYY).');
  }

  const lines: Gstr2bLine[] = [];
  const skipped: string[] = [];
  const yes = (v: unknown) => str(v).toUpperCase() === 'Y';
  type Who = { gstin: string; name: string | null; label: string };

  const add = (who: Who, d: Obj, number: string, dt: unknown, docType: Gstr2bLine['docType'], flags: { itcAvailable: boolean; reverseCharge: boolean }) => {
    const date = portalDate(dt);
    const f = figures(d);
    // Only an import from abroad has no supplier GSTIN.
    const gstinOk = docType === 'bill_of_entry' && !who.gstin ? true : GSTIN.test(who.gstin);
    if (!number || !date || !gstinOk || !f) {
      skipped.push(`${who.label} ${number || '(no number)'}${!f ? ': no taxable value or tax on it' : !date ? ': no date' : ''}`);
      return;
    }
    lines.push({ vendorGstin: who.gstin, vendorName: who.name, docType, number, date, ...f, ...flags });
  };
  const supplier = (s: Obj): Who => {
    const g = str(s.ctin).toUpperCase();
    return { gstin: g, name: str(s.trdnm) || null, label: g || 'unknown supplier' };
  };
  // 'Y' available, 'N' not, 'T' temporarily unavailable — only Y can be claimed.
  const flagsOf = (d: Obj) => ({ itcAvailable: yes(d.itcavl), reverseCharge: yes(d.rev) });

  // Invoices, and amended invoices (the amendment carries the current figures);
  // supplies through an e-commerce operator under section 9(5) come as the operator's invoices.
  for (const key of ['b2b', 'b2ba', 'ecom', 'ecoma'] as const) {
    for (const s of arr(doc[key])) for (const inv of arr(s.inv)) add(supplier(s), inv, str(inv.inum), inv.dt, 'invoice', flagsOf(inv));
  }
  // Credit and debit notes, and their amendments.
  for (const key of ['cdnr', 'cdnra'] as const) {
    for (const s of arr(doc[key])) {
      for (const nt of arr(s.nt)) {
        add(supplier(s), nt, str(nt.ntnum), nt.dt, str(nt.typ).toUpperCase() === 'D' ? 'debit_note' : 'credit_note', flagsOf(nt));
      }
    }
  }
  // Credit distributed by an Input Service Distributor (GSTR-3B 4(A)(4)).
  // An ISDC document takes credit back. Its flag is itcelg, not itcavl.
  for (const key of ['isd', 'isda'] as const) {
    for (const s of arr(doc[key])) {
      const docs = Array.isArray(s.doclist) ? arr(s.doclist) : [s];
      for (const d of docs) {
        const credit = str(d.doctyp).toUpperCase() === 'ISDC';
        add(supplier(s), d, str(d.docnum), d.docdt, credit ? 'isd_credit' : 'isd',
          { itcAvailable: has(d, 'itcelg') ? yes(d.itcelg) : true, reverseCharge: false });
      }
    }
  }
  // Imports of goods by bill of entry (GSTR-3B 4(A)(1)): from abroad there is
  // no supplier GSTIN (ICEGATE reports the port); from a SEZ unit there is.
  // Credit on a bill of entry in 2B is always shown as available.
  const boe = (who: Who, b: Obj) => {
    const port = str(b.portcode).toUpperCase();
    add({ ...who, name: who.name ?? (port ? `Imported through ${port}` : 'Imports (customs)') }, b, str(b.boenum), b.boedt, 'bill_of_entry',
      { itcAvailable: true, reverseCharge: false });
  };
  for (const b of arr(doc.impg)) boe({ gstin: '', name: null, label: `Bill of entry at ${str(b.portcode) || 'an unknown port'}` }, b);
  for (const s of arr(doc.impgsez)) for (const b of arr(s.boe)) boe(supplier(s), b);

  if (!lines.length && skipped.length) {
    throw badRequest(
      `None of the ${skipped.length} document(s) in that GSTR-2B could be read (${skipped.slice(0, 3).join('; ')}). ` +
      'The portal\'s GSTR-2B lists each invoice with items carrying txval, igst, cgst, sgst and cess.',
    );
  }

  return { gstin, returnPeriod, layout: '2B', generatedOn: portalDate(root.gendt), lines, skipped };
}

const rupees = (n: number) => n.toFixed(4);

/** Load a parsed statement into the book. One of our own GSTINs, or refused. */
export async function importGstr2b(
  trx: Trx,
  orgId: number,
  parsed: ParsedGstr2b,
): Promise<{ inserted: number; updated: number; skipped: string[]; returnPeriod: string; gstin: string; layout: '2B' | '2A'; generatedOn: string | null; byType: Record<string, number> }> {
  const branch = await trx.selectFrom('branches').select('id')
    .where('org_id', '=', orgId).where('gstin', '=', parsed.gstin).executeTakeFirst();
  if (!branch) {
    throw badRequest(
      `This GSTR-2B is for ${parsed.gstin}, which is not one of this book's registrations. ` +
        'Check you downloaded it for the right GSTIN.',
    );
  }

  // What the book already holds for the month, so new lines can be told from
  // updated ones. The database's affected-row count cannot be trusted for it:
  // a line re-imported with the same figures reports like an insert.
  const existing = await trx.selectFrom('gstr2b_entries')
    .select(['vendor_gstin', 'doc_type', 'invoice_no'])
    .where('org_id', '=', orgId).where('return_period', '=', parsed.returnPeriod).execute();
  const held = new Set(existing.map((e) => `${e.vendor_gstin}|${e.doc_type}|${e.invoice_no}`));

  let inserted = 0;
  let updated = 0;
  for (const l of parsed.lines) {
    const values = {
      vendor_name: l.vendorName,
      recipient_gstin: parsed.gstin,
      invoice_date: l.date,
      taxable: rupees(l.taxable),
      cgst: rupees(l.cgst),
      sgst: rupees(l.sgst),
      igst: rupees(l.igst),
      cess: rupees(l.cess),
      itc_available: l.itcAvailable ? 1 : 0,
      is_reverse_charge: l.reverseCharge ? 1 : 0,
      source: 'upload' as const,
    };
    const key = `${l.vendorGstin}|${l.docType}|${l.number}`;
    await trx.insertInto('gstr2b_entries')
      .values({
        org_id: orgId,
        return_period: parsed.returnPeriod,
        vendor_gstin: l.vendorGstin,
        doc_type: l.docType,
        invoice_no: l.number,
        ...values,
        imported_at: sql<Date>`NOW()`,
      })
      // The IMS action already recorded on the line is left as it was.
      .onDuplicateKeyUpdate({ ...values, imported_at: sql<Date>`NOW()` })
      .execute();
    if (held.has(key)) updated++;
    else {
      inserted++;
      held.add(key);
    }
  }

  const byType: Record<string, number> = {};
  for (const l of parsed.lines) byType[l.docType] = (byType[l.docType] ?? 0) + 1;
  return { inserted, updated, skipped: parsed.skipped, returnPeriod: parsed.returnPeriod, gstin: parsed.gstin, layout: parsed.layout, generatedOn: parsed.generatedOn, byType };
}

export type ImsAction = 'accepted' | 'rejected' | 'pending';

/**
 * Record what was done in IMS for some lines. The portal will not let an
 * original credit note be kept pending — it is accepted or rejected — so
 * neither does this.
 */
export async function setImsAction(
  trx: Trx,
  orgId: number,
  userId: number | null,
  ids: number[],
  action: ImsAction | null,
  note?: string | null,
): Promise<number> {
  if (!ids.length) return 0;
  const rows = await trx.selectFrom('gstr2b_entries').select(['id', 'doc_type', 'invoice_no'])
    .where('org_id', '=', orgId).where('id', 'in', ids).execute();
  if (rows.length !== ids.length) throw badRequest('Some of those lines are not in this book.');
  // IMS covers supplier documents (B2B, notes, e-commerce). ISD documents and
  // bills of entry go into GSTR-2B without passing through it.
  const outside = rows.find((r) => r.doc_type === 'isd' || r.doc_type === 'isd_credit' || r.doc_type === 'bill_of_entry');
  if (outside && action !== null) {
    throw badRequest(`${outside.doc_type === 'bill_of_entry' ? 'Bill of entry' : 'ISD document'} ${outside.invoice_no} is not in IMS: it comes into GSTR-2B directly, so there is nothing to accept or reject.`);
  }
  if (action === 'pending') {
    const note = rows.find((r) => r.doc_type === 'credit_note' || r.doc_type === 'isd_credit');
    if (note) throw badRequest(`Credit note ${note.invoice_no} cannot be kept pending in IMS. Accept or reject it.`);
  }
  const res = await trx.updateTable('gstr2b_entries')
    .set({
      ims_action: action,
      ims_note: note ?? null,
      ims_action_by_user_id: action ? userId : null,
      ims_action_at: action ? new Date() : null,
    })
    .where('org_id', '=', orgId).where('id', 'in', ids)
    .executeTakeFirst();
  return Number(res.numUpdatedRows);
}
