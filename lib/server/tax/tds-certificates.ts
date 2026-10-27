import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Certificates around TDS.
//
// Lower-deduction certificates (section 197 of the 1961 Act, 395 of the 2025
// Act) let a deductee be deducted at a lower rate, up to an amount, between
// two dates. A bill dated inside one is deducted at its rate — but only while
// the certificate's amount lasts. A bill that would take the running total
// past the limit is deducted at the normal rate in full: deducting more than
// the certificate allows costs the vendor a refund claim, deducting less is a
// default in our name, so the safe side is the normal rate.
//
// TDS certificates (Form 131, earlier 16A) come from TRACES. Each is due
// fifteen days after the quarterly return's due date (rule 31(3), now its
// 2026 equivalent). This module says which are due and records which were sent;
// and on the other side, which customers have sent theirs for the TDS they
// withheld from our invoices, because an unclaimed certificate is tax we paid
// and cannot take credit for.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor, Trx } from '../db';
import type { Paise } from '../../types';
import { toPaiseFromSql, toSqlFromPaise } from '../money-sql';
import { badRequest, conflict, notFound } from '../http';
import { quarterRange, returnDueDate, type Quarter } from './tds-returns';
import { ACT_2025_FROM } from '../../tax/statutory-rates';

// ── Lower-deduction certificates ─────────────────────────────────────────────

export interface LowerCertificate {
  id: number;
  contactId: number;
  sectionCode: string;
  certificateNo: string;
  ratePct: number;
  validFrom: string;
  validTo: string;
  limitPaise: Paise | null;
}

const toCert = (r: {
  id: number; contact_id: number; section_code: string; certificate_no: string; rate_pct: string;
  valid_from: unknown; valid_to: unknown; amount_limit: string | null;
}): LowerCertificate => ({
  id: r.id, contactId: r.contact_id, sectionCode: r.section_code, certificateNo: r.certificate_no,
  ratePct: Number(r.rate_pct), validFrom: String(r.valid_from).slice(0, 10), validTo: String(r.valid_to).slice(0, 10),
  limitPaise: r.amount_limit === null ? null : toPaiseFromSql(r.amount_limit),
});

/** The certificate covering a bill to this vendor, under this section, on this date. */
export async function lowerCertificateFor(
  ex: Executor, orgId: number, contactId: number, sectionCode: string, date: string,
): Promise<LowerCertificate | null> {
  const r = await ex.selectFrom('tds_lower_certificates')
    .select(['id', 'contact_id', 'section_code', 'certificate_no', 'rate_pct', 'valid_from', 'valid_to', 'amount_limit'])
    .where('org_id', '=', orgId).where('contact_id', '=', contactId).where('section_code', '=', sectionCode)
    .where('is_cancelled', '=', 0).where('valid_from', '<=', date).where('valid_to', '>=', date)
    .orderBy('valid_from', 'desc').limit(1).executeTakeFirst();
  return r ? toCert(r) : null;
}

/** How much of a certificate's limit bills have used so far. */
export async function usedUnder(ex: Executor, certId: number): Promise<Paise> {
  const r = await ex.selectFrom('bills').select(sql<string>`COALESCE(SUM(subtotal), 0)`.as('used'))
    .where('tds_lower_cert_id', '=', certId).where('status', 'not in', ['void']).executeTakeFirst();
  return toPaiseFromSql(r?.used ?? '0');
}

/**
 * The rate a bill should be deducted at under a certificate, or undefined
 * when none applies — none on file, or this bill would overrun its limit.
 */
export async function certificateRate(
  ex: Executor, orgId: number, contactId: number, sectionCode: string | undefined, date: string, basePaise: Paise,
): Promise<{ cert: LowerCertificate; ratePct: number } | { cert: LowerCertificate | null; ratePct: undefined; note?: string }> {
  if (!sectionCode) return { cert: null, ratePct: undefined };
  const cert = await lowerCertificateFor(ex, orgId, contactId, sectionCode, date);
  if (!cert) return { cert: null, ratePct: undefined };
  if (cert.limitPaise !== null) {
    const used = await usedUnder(ex, cert.id);
    if (used + basePaise > cert.limitPaise) {
      return {
        cert: null, ratePct: undefined,
        note: `Certificate ${cert.certificateNo} has ₹${((cert.limitPaise - used) / 100).toFixed(2)} left; this bill is deducted at the normal rate.`,
      };
    }
  }
  return { cert, ratePct: cert.ratePct };
}

export interface LowerCertificateInput {
  contactId: number;
  sectionCode: string;
  certificateNo: string;
  ratePct: number;
  validFrom: string;
  validTo: string;
  limitPaise?: Paise | null;
  notes?: string | null;
}

export async function addLowerCertificate(trx: Trx, orgId: number, userId: number | null, input: LowerCertificateInput) {
  const no = input.certificateNo.trim().toUpperCase();
  if (!/^[A-Z0-9]{6,20}$/.test(no)) throw badRequest('A certificate number is 6 to 20 letters and digits, as printed on it.');
  if (input.validTo < input.validFrom) throw badRequest('The certificate cannot end before it starts.');
  if (!(input.ratePct >= 0 && input.ratePct <= 100)) throw badRequest('Give the rate on the certificate, 0 to 100.');
  if (input.limitPaise != null && input.limitPaise <= 0) throw badRequest('Leave the limit empty if the certificate names none.');
  const contact = await trx.selectFrom('contacts').select(['id', 'pan'])
    .where('id', '=', input.contactId).where('org_id', '=', orgId).executeTakeFirst();
  if (!contact) throw notFound('That vendor does not exist.');
  if (!contact.pan) throw badRequest('A lower-deduction certificate is issued against a PAN. Add the vendor’s PAN first.');

  const overlap = await trx.selectFrom('tds_lower_certificates').select('certificate_no')
    .where('org_id', '=', orgId).where('contact_id', '=', input.contactId).where('section_code', '=', input.sectionCode)
    .where('is_cancelled', '=', 0).where('valid_from', '<=', input.validTo).where('valid_to', '>=', input.validFrom)
    .executeTakeFirst();
  if (overlap) throw conflict(`Certificate ${overlap.certificate_no} already covers part of that period for ${input.sectionCode}.`);

  const id = Number((await trx.insertInto('tds_lower_certificates').values({
    org_id: orgId, contact_id: input.contactId, section_code: input.sectionCode, certificate_no: no,
    rate_pct: String(input.ratePct), valid_from: input.validFrom, valid_to: input.validTo,
    amount_limit: input.limitPaise == null ? null : toSqlFromPaise(input.limitPaise),
    notes: input.notes ?? null, created_by_user_id: userId,
  }).executeTakeFirstOrThrow()).insertId);
  return { id, certificateNo: no };
}

/** Withdraw a certificate entered by mistake. Bills already deducted under it keep what they were. */
export async function cancelLowerCertificate(trx: Trx, orgId: number, id: number) {
  const r = await trx.updateTable('tds_lower_certificates').set({ is_cancelled: 1 })
    .where('id', '=', id).where('org_id', '=', orgId).where('is_cancelled', '=', 0).executeTakeFirst();
  if (!Number(r.numUpdatedRows)) throw notFound('That certificate is not on file, or is already withdrawn.');
}

export async function listLowerCertificates(ex: Executor, orgId: number) {
  const rows = await ex.selectFrom('tds_lower_certificates as t').innerJoin('contacts as c', 'c.id', 't.contact_id')
    .select(['t.id', 't.contact_id', 't.section_code', 't.certificate_no', 't.rate_pct', 't.valid_from', 't.valid_to',
      't.amount_limit', 't.is_cancelled', 't.notes', 'c.display_name', 'c.pan'])
    .where('t.org_id', '=', orgId).orderBy('t.valid_to', 'desc').execute();
  return Promise.all(rows.map(async (r) => ({
    ...toCert(r),
    contactName: r.display_name,
    pan: r.pan,
    cancelled: !!r.is_cancelled,
    notes: r.notes,
    usedPaise: await usedUnder(ex, r.id),
  })));
}

// ── PAN status ───────────────────────────────────────────────────────────────

/** Record what the e-filing portal said about a PAN. */
export async function setPanStatus(trx: Trx, orgId: number, contactId: number, status: 'operative' | 'inoperative' | 'unverified', checkedOn: string) {
  const r = await trx.updateTable('contacts').set({ pan_status: status, pan_checked_on: status === 'unverified' ? null : checkedOn })
    .where('id', '=', contactId).where('org_id', '=', orgId).where('pan', 'is not', null).executeTakeFirst();
  if (!Number(r.numUpdatedRows)) throw notFound('That party has no PAN to check.');
}

// ── Form 131 / 16A ───────────────────────────────────────────────────────────

/** Certificates are due fifteen days after the quarter's return is. */
export function certificateDueDate(fy: number, q: Quarter): string {
  const d = new Date(`${returnDueDate(fy, q)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 15);
  return d.toISOString().slice(0, 10);
}

export const certificateForm = (fy: number, q: Quarter) => (quarterRange(fy, q).from >= ACT_2025_FROM ? 'Form 131' : 'Form 16A');

export interface CertificateRow {
  contactId: string;
  contactName: string;
  pan: string | null;
  /** What was deducted (issued) or withheld from us (received) in the quarter. */
  taxPaise: Paise;
  certificates: { id: string; certificateNo: string; issuedOn: string; taxPaise: Paise; fileId: string | null }[];
  coveredPaise: Paise;
  status: 'done' | 'partial' | 'due' | 'overdue';
}

export interface CertificatesView {
  fy: number;
  quarter: Quarter;
  form: string;
  dueDate: string;
  issued: CertificateRow[];
  received: CertificateRow[];
}

/**
 * Each deductee of the quarter with the certificates sent to them, and each
 * customer who withheld TDS from us with the certificates they sent.
 */
export async function certificates(ex: Executor, orgId: number, fy: number, q: Quarter, today = new Date().toISOString().slice(0, 10)): Promise<CertificatesView> {
  const range = quarterRange(fy, q);
  const due = certificateDueDate(fy, q);

  const [deducted, withheld, on] = await Promise.all([
    sql<{ contact_id: number; name: string; pan: string | null; tax: string }>`
      SELECT c.id AS contact_id, c.display_name AS name, c.pan, SUM(b.tds_amount) AS tax
        FROM bills b JOIN contacts c ON c.id = b.vendor_id
       WHERE b.org_id = ${orgId} AND b.status NOT IN ('draft', 'void') AND b.tds_amount > 0
         AND b.bill_date BETWEEN ${range.from} AND ${range.to}
       GROUP BY c.id, c.display_name, c.pan ORDER BY c.display_name`.execute(ex),
    // A customer's TDS is withheld when they pay, so it is dated by the receipt.
    sql<{ contact_id: number; name: string; pan: string | null; tax: string }>`
      SELECT c.id AS contact_id, c.display_name AS name, c.pan, SUM(p.tds_amount) AS tax
        FROM payments p JOIN contacts c ON c.id = p.contact_id
       WHERE p.org_id = ${orgId} AND p.kind = 'received' AND p.status <> 'void' AND p.tds_amount > 0
         AND p.payment_date BETWEEN ${range.from} AND ${range.to}
       GROUP BY c.id, c.display_name, c.pan ORDER BY c.display_name`.execute(ex),
    ex.selectFrom('tds_certificates').select(['id', 'direction', 'contact_id', 'certificate_no', 'issued_on', 'tax', 'file_id'])
      .where('org_id', '=', orgId).where('fy', '=', fy).where('quarter', '=', q).execute(),
  ]);

  const build = (rows: typeof deducted.rows, direction: 'issued' | 'received'): CertificateRow[] => {
    const ids = new Set(rows.map((r) => r.contact_id));
    // A certificate on file for someone with nothing in the quarter still shows.
    const extra = on.filter((c) => c.direction === direction && !ids.has(c.contact_id));
    const all = [...rows.map((r) => ({ ...r })), ...extra.map((c) => ({ contact_id: c.contact_id, name: '', pan: null, tax: '0' }))];
    return all.map((r) => {
      const mine = on.filter((c) => c.direction === direction && c.contact_id === r.contact_id);
      const tax = toPaiseFromSql(r.tax);
      const covered = mine.reduce((t, c) => t + toPaiseFromSql(c.tax), 0);
      return {
        contactId: String(r.contact_id),
        contactName: r.name,
        pan: r.pan,
        taxPaise: tax,
        certificates: mine.map((c) => ({
          id: String(c.id), certificateNo: c.certificate_no, issuedOn: String(c.issued_on).slice(0, 10),
          taxPaise: toPaiseFromSql(c.tax), fileId: c.file_id === null ? null : String(c.file_id),
        })),
        coveredPaise: covered,
        status: covered >= tax && mine.length ? 'done' : covered > 0 ? 'partial' : today > due && direction === 'issued' ? 'overdue' : 'due',
      };
    });
  };

  const issued = build(deducted.rows, 'issued');
  const received = build(withheld.rows, 'received');
  // Names for certificates on file with no activity in the quarter.
  const missing = [...issued, ...received].filter((r) => !r.contactName).map((r) => Number(r.contactId));
  if (missing.length) {
    const names = await ex.selectFrom('contacts').select(['id', 'display_name', 'pan']).where('id', 'in', missing).execute();
    for (const r of [...issued, ...received]) {
      const n = names.find((x) => String(x.id) === r.contactId);
      if (n && !r.contactName) { r.contactName = n.display_name; r.pan = n.pan; }
    }
  }
  return { fy, quarter: q, form: certificateForm(fy, q), dueDate: due, issued, received };
}

export interface CertificateInput {
  direction: 'issued' | 'received';
  contactId: number;
  fy: number;
  quarter: Quarter;
  certificateNo: string;
  issuedOn: string;
  taxPaise: Paise;
  fileId?: number | null;
  notes?: string | null;
}

export async function recordCertificate(trx: Trx, orgId: number, userId: number | null, input: CertificateInput) {
  const no = input.certificateNo.trim().toUpperCase();
  if (!/^[A-Z0-9/-]{4,30}$/.test(no)) throw badRequest('Give the certificate number as printed on it.');
  if (!(input.taxPaise >= 0)) throw badRequest('Give the tax the certificate covers.');
  const contact = await trx.selectFrom('contacts').select('id')
    .where('id', '=', input.contactId).where('org_id', '=', orgId).executeTakeFirst();
  if (!contact) throw notFound('That party does not exist.');
  if (input.fileId) {
    const f = await trx.selectFrom('files').select('id').where('id', '=', input.fileId).where('org_id', '=', orgId).executeTakeFirst();
    if (!f) throw notFound('That file is not in this book.');
  }
  const id = Number((await trx.insertInto('tds_certificates').values({
    org_id: orgId, direction: input.direction, contact_id: input.contactId, fy: input.fy, quarter: input.quarter,
    form: certificateForm(input.fy, input.quarter), certificate_no: no, issued_on: input.issuedOn,
    tax: toSqlFromPaise(input.taxPaise), file_id: input.fileId ?? null, notes: input.notes ?? null, created_by_user_id: userId,
  }).executeTakeFirstOrThrow()).insertId);
  return { id };
}
