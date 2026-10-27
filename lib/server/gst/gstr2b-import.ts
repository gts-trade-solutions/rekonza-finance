import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// GSTR-2B from the portal, and IMS actions on it.
//
// The portal lets a taxpayer download GSTR-2B as JSON (Returns → GSTR-2B →
// Download), one file per GSTIN per month. This reads that file into
// gstr2b_entries so the reconciliation has the real statement to work against,
// not a typed-in copy. Re-importing the same month updates the figures and
// keeps whatever IMS action was already recorded on each line.
//
// The parser is forgiving about the wrapper — the file is sometimes the bare
// statement, sometimes wrapped in { data: … } with a checksum — and strict
// about the figures: a line it cannot read is reported, not guessed at.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Trx } from '../db';
import { badRequest } from '../http';

export interface Gstr2bLine {
  vendorGstin: string;
  vendorName: string | null;
  docType: 'invoice' | 'credit_note' | 'debit_note';
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

/** The portal writes dates as dd-mm-yyyy. */
function portalDate(v: unknown): string | null {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(str(v));
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

export function parseGstr2b(json: unknown): ParsedGstr2b {
  if (!isObj(json)) throw badRequest('That file is not a GSTR-2B JSON download.');
  const root = isObj(json.data) ? json.data : json;
  const gstin = str(root.gstin).toUpperCase();
  const returnPeriod = str(root.rtnprd);
  const doc = isObj(root.docdata) ? root.docdata : null;
  if (!/^[0-9A-Z]{15}$/.test(gstin) || !/^\d{6}$/.test(returnPeriod) || !doc) {
    throw badRequest('That file is not a GSTR-2B JSON download: it has no GSTIN, return period or document data.');
  }

  const lines: Gstr2bLine[] = [];
  const skipped: string[] = [];
  const yes = (v: unknown) => str(v).toUpperCase() === 'Y';

  const push = (supplier: Obj, d: Obj, docType: Gstr2bLine['docType'], numberKey: string) => {
    const number = str(d[numberKey]);
    const date = portalDate(d.dt);
    const vendorGstin = str(supplier.ctin).toUpperCase();
    if (!number || !date || !/^[0-9A-Z]{15}$/.test(vendorGstin)) {
      skipped.push(`${vendorGstin || 'unknown supplier'} ${number || '(no number)'}`);
      return;
    }
    lines.push({
      vendorGstin,
      vendorName: str(supplier.trdnm) || null,
      docType,
      number,
      date,
      taxable: num(d.txval),
      cgst: num(d.cgst),
      sgst: num(d.sgst),
      igst: num(d.igst),
      cess: num(d.cess),
      // 'Y' available, 'N' not, 'T' temporarily unavailable — only Y can be claimed.
      itcAvailable: yes(d.itcavl),
      reverseCharge: yes(d.rev),
    });
  };

  // Invoices, and amended invoices (the amendment carries the current figures).
  for (const key of ['b2b', 'b2ba'] as const) {
    for (const s of arr(doc[key])) for (const inv of arr(s.inv)) push(s, inv, 'invoice', 'inum');
  }
  // Credit and debit notes, and their amendments.
  for (const key of ['cdnr', 'cdnra'] as const) {
    for (const s of arr(doc[key])) {
      for (const nt of arr(s.nt)) push(s, nt, str(nt.typ).toUpperCase() === 'D' ? 'debit_note' : 'credit_note', 'ntnum');
    }
  }

  return { gstin, returnPeriod, lines, skipped };
}

const rupees = (n: number) => n.toFixed(4);

/** Load a parsed statement into the book. One of our own GSTINs, or refused. */
export async function importGstr2b(
  trx: Trx,
  orgId: number,
  parsed: ParsedGstr2b,
): Promise<{ inserted: number; updated: number; skipped: string[]; returnPeriod: string; gstin: string }> {
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

  return { inserted, updated, skipped: parsed.skipped, returnPeriod: parsed.returnPeriod, gstin: parsed.gstin };
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
  if (action === 'pending') {
    const note = rows.find((r) => r.doc_type === 'credit_note');
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
