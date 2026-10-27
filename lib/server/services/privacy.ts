import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// The Digital Personal Data Protection Act, 2023, as it touches a set of books.
//
// The people in the books — customers and suppliers who are individuals,
// employees, users — may ask to see what is held about them, to correct it,
// to have it erased, or complain. Each request is logged with the date it is
// due, and its answer kept, so the book can show it dealt with each.
//
// Erasure meets the tax laws, which win: invoices, bills and payroll must be
// kept for years (the CGST Act's section 36, the Income-tax Act's rule 6F, and
// so on). So a party with documents still inside the retention period has
// only what the books do not need cleared — email, phone, bank details,
// notes. Once the last document is out of it, the name and every identifying
// detail go too, and the documents stay under "Erased contact 123".
//
// Breaches are logged with when the Board and the people affected were told.
// ─────────────────────────────────────────────────────────────────────────────

import type { Executor, Trx } from '../db';
import { toPaiseFromSql } from '../money-sql';
import { badRequest, conflict, notFound } from '../http';
import { unseal } from '../crypto/fields';

export interface PrivacySettings {
  grievanceOfficer: { name: string; email: string; phone: string };
  /** Years after the end of the financial year of a party's last document that it must be kept. */
  retentionYears: number;
  /** Days in which a request is answered. The DPDP Rules, 2025 allow at most 90 for a grievance. */
  responseDays: number;
}

export const DEFAULT_PRIVACY: PrivacySettings = {
  grievanceOfficer: { name: '', email: '', phone: '' }, retentionYears: 8, responseDays: 30,
};

const parsed = (v: unknown) => { if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return v; } };
const ymd = (d: Date) => d.toISOString().slice(0, 10);

export async function getPrivacySettings(ex: Executor, orgId: number): Promise<PrivacySettings> {
  const rows = await ex.selectFrom('settings').select(['setting_key', 'value']).where('org_id', '=', orgId).where('scope', '=', 'privacy').execute();
  const out = structuredClone(DEFAULT_PRIVACY);
  for (const r of rows) {
    const v = parsed(r.value);
    if (r.setting_key === 'grievanceOfficer' && v && typeof v === 'object') out.grievanceOfficer = { ...out.grievanceOfficer, ...(v as object) };
    if (r.setting_key === 'retentionYears') out.retentionYears = Number(v) || DEFAULT_PRIVACY.retentionYears;
    if (r.setting_key === 'responseDays') out.responseDays = Number(v) || DEFAULT_PRIVACY.responseDays;
  }
  return out;
}

export async function setPrivacySettings(trx: Trx, orgId: number, userId: number | null, patch: Partial<PrivacySettings>) {
  if (patch.retentionYears !== undefined && !(Number.isInteger(patch.retentionYears) && patch.retentionYears >= 6 && patch.retentionYears <= 20)) {
    throw badRequest('Keep records at least 6 years — the tax laws ask for that much or more — and at most 20.');
  }
  if (patch.responseDays !== undefined && !(Number.isInteger(patch.responseDays) && patch.responseDays >= 1 && patch.responseDays <= 90)) {
    throw badRequest('Answer requests within 1 to 90 days.');
  }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    await trx.insertInto('settings').values({ org_id: orgId, scope: 'privacy', setting_key: key, value: JSON.stringify(value), updated_by_user_id: userId })
      .onDuplicateKeyUpdate({ value: JSON.stringify(value), updated_by_user_id: userId }).execute();
  }
  return getPrivacySettings(trx, orgId);
}

// ── Requests ─────────────────────────────────────────────────────────────────

export type RequestKind = 'access' | 'correction' | 'erasure' | 'grievance' | 'consent_withdrawal';
export type SubjectType = 'contact' | 'employee' | 'user' | 'other';

export async function logRequest(
  trx: Trx, orgId: number, userId: number | null,
  input: { subjectType: SubjectType; subjectId?: number | null; subjectName: string; kind: RequestKind; details?: string | null; receivedOn: string },
) {
  const settings = await getPrivacySettings(trx, orgId);
  if (input.subjectType === 'contact' && input.subjectId) {
    const c = await trx.selectFrom('contacts').select('display_name').where('id', '=', input.subjectId).where('org_id', '=', orgId).executeTakeFirst();
    if (!c) throw notFound('That party was not found.');
    input = { ...input, subjectName: c.display_name };
  }
  const due = new Date(`${input.receivedOn}T00:00:00Z`);
  due.setUTCDate(due.getUTCDate() + settings.responseDays);
  const id = Number((await trx.insertInto('privacy_requests').values({
    org_id: orgId, subject_type: input.subjectType, subject_id: input.subjectId ?? null, subject_name: input.subjectName.trim(),
    kind: input.kind, details: input.details?.trim() || null, received_on: input.receivedOn, due_on: ymd(due), created_by_user_id: userId,
  }).executeTakeFirstOrThrow()).insertId);
  return { id, dueOn: ymd(due) };
}

export async function closeRequest(trx: Trx, orgId: number, userId: number | null, id: number, input: { status: 'done' | 'refused'; response: string }) {
  if (!input.response.trim()) throw badRequest('Record what was done or why it was refused: it is the answer the person is owed.');
  const r = await trx.updateTable('privacy_requests').set({
    status: input.status, response: input.response.trim(), handled_by_user_id: userId, closed_at: new Date(),
  }).where('id', '=', id).where('org_id', '=', orgId).where('status', '=', 'open').executeTakeFirst();
  if (!Number(r.numUpdatedRows)) throw conflict('That request is not open.');
}

export async function listRequests(ex: Executor, orgId: number) {
  const rows = await ex.selectFrom('privacy_requests as r').leftJoin('users as u', 'u.id', 'r.handled_by_user_id')
    .selectAll('r').select('u.name as handled_by').where('r.org_id', '=', orgId)
    .orderBy('r.status').orderBy('r.due_on').orderBy('r.id', 'desc').limit(500).execute();
  const today = ymd(new Date());
  return rows.map((r) => ({
    id: String(r.id), subjectType: r.subject_type, subjectId: r.subject_id ? String(r.subject_id) : null, subjectName: r.subject_name,
    kind: r.kind, details: r.details, receivedOn: String(r.received_on).slice(0, 10), dueOn: String(r.due_on).slice(0, 10),
    status: r.status, response: r.response, handledBy: r.handled_by, closedAt: r.closed_at ? new Date(r.closed_at).toISOString() : null,
    overdue: r.status === 'open' && String(r.due_on).slice(0, 10) < today,
  }));
}

// ── What is held about someone ───────────────────────────────────────────────

/** Everything the books hold about a party, for a request to see it. */
export async function contactData(ex: Executor, orgId: number, contactId: number) {
  const c = await ex.selectFrom('contacts').selectAll().where('id', '=', contactId).where('org_id', '=', orgId).executeTakeFirst();
  if (!c) throw notFound('That contact was not found.');
  const [invoices, bills, payments] = await Promise.all([
    ex.selectFrom('invoices').select(['number', 'invoice_date as date', 'total', 'status']).where('org_id', '=', orgId).where('customer_id', '=', contactId).orderBy('invoice_date').execute(),
    ex.selectFrom('bills').select(['internal_no as number', 'bill_date as date', 'total', 'status']).where('org_id', '=', orgId).where('vendor_id', '=', contactId).orderBy('bill_date').execute(),
    ex.selectFrom('payments').select(['number', 'payment_date as date', 'amount', 'kind']).where('org_id', '=', orgId).where('contact_id', '=', contactId).orderBy('payment_date').execute(),
  ]);
  const doc = (r: { number: string; date: unknown; total?: unknown; amount?: unknown; status?: string; kind?: string }) => ({
    number: r.number, date: String(r.date).slice(0, 10), amountPaise: toPaiseFromSql((r.total ?? r.amount) as string), status: r.status ?? r.kind,
  });
  return {
    held: {
      name: c.display_name, legalName: c.legal_name, email: c.email, phone: c.phone, gstin: c.gstin, pan: c.pan,
      billingAddress: [c.billing_address, c.billing_city, c.billing_pincode].filter(Boolean).join(', ') || null,
      shippingAddress: [c.shipping_address, c.shipping_city, c.shipping_pincode].filter(Boolean).join(', ') || null,
      bank: c.bank_account_no ? { name: c.bank_account_name, accountNo: unseal(c.bank_account_no), ifsc: c.bank_ifsc, bank: c.bank_name } : null,
      udyam: c.msme_udyam_no, notes: c.notes,
    },
    why: 'Held to raise and record invoices, bills and payments, and to file the GST and income-tax returns they appear in.',
    documents: { invoices: invoices.map(doc), bills: bills.map(doc), payments: payments.map(doc) },
  };
}

/** The date until which a party's documents must be kept, if it has any. */
export async function retainedUntil(ex: Executor, orgId: number, contactId: number): Promise<string | null> {
  const r = await ex.selectFrom('contacts as c')
    .select((eb) => [
      eb.selectFrom('invoices').select((e) => e.fn.max('invoice_date').as('d')).where('org_id', '=', orgId).whereRef('customer_id', '=', 'c.id').as('inv'),
      eb.selectFrom('bills').select((e) => e.fn.max('bill_date').as('d')).where('org_id', '=', orgId).whereRef('vendor_id', '=', 'c.id').as('bill'),
      eb.selectFrom('payments').select((e) => e.fn.max('payment_date').as('d')).where('org_id', '=', orgId).whereRef('contact_id', '=', 'c.id').as('pay'),
    ])
    .where('c.id', '=', contactId).where('c.org_id', '=', orgId).executeTakeFirst();
  if (!r) throw notFound('That contact was not found.');
  const last = [r.inv, r.bill, r.pay].filter(Boolean).map((d) => String(d).slice(0, 10)).sort().at(-1);
  if (!last) return null;
  const years = (await getPrivacySettings(ex, orgId)).retentionYears;
  const fyEndYear = Number(last.slice(5, 7)) >= 4 ? Number(last.slice(0, 4)) + 1 : Number(last.slice(0, 4));
  return `${fyEndYear + years}-03-31`;
}

/**
 * Erase what can be erased. Inside the retention period that is what the
 * books do not need; after it, everything that identifies the person.
 */
export async function eraseContact(trx: Trx, orgId: number, contactId: number, today = ymd(new Date())) {
  const until = await retainedUntil(trx, orgId, contactId);
  const contactDetails = {
    email: null, phone: null, notes: null, bank_account_name: null, bank_account_no: null, bank_ifsc: null, bank_name: null,
  };
  if (until && until >= today) {
    await trx.updateTable('contacts').set(contactDetails).where('id', '=', contactId).where('org_id', '=', orgId).execute();
    return { full: false as const, keptUntil: until };
  }
  await trx.updateTable('contacts').set({
    ...contactDetails, display_name: `Erased contact ${contactId}`, legal_name: null, pan: null, gstin: null,
    billing_address: null, billing_city: null, billing_pincode: null, shipping_address: null, shipping_city: null, shipping_pincode: null,
    msme_udyam_no: null, is_archived: 1, erased_at: new Date(),
  }).where('id', '=', contactId).where('org_id', '=', orgId).execute();
  return { full: true as const, keptUntil: null };
}

// ── Breaches ─────────────────────────────────────────────────────────────────

// ── Consent ──────────────────────────────────────────────────────────────────

/** What a person's data is used for, and so what they are asked to agree to. */
export const CONSENT_PURPOSES = {
  payroll: 'Working out salary, and payslips',
  statutory: 'PF, ESI, professional tax and TDS filings',
  bank: 'Paying salary into their bank account',
  aadhaar: 'Keeping their Aadhaar number',
} as const;
export type ConsentPurpose = keyof typeof CONSENT_PURPOSES;
/** Changed when the wording people are shown changes. */
export const CONSENT_NOTICE = '2026-10';

export async function recordConsent(trx: Trx, orgId: number, userId: number | null, input: {
  subjectType: 'employee' | 'contact'; subjectId: number; purpose: ConsentPurpose; givenBy?: string | null;
}) {
  if (!(input.purpose in CONSENT_PURPOSES)) throw badRequest('That is not a purpose consent is asked for.');
  const table = input.subjectType === 'employee' ? 'employees' : 'contacts';
  const who = await trx.selectFrom(table).select('id').where('id', '=', input.subjectId).where('org_id', '=', orgId).executeTakeFirst();
  if (!who) throw notFound('That person was not found.');
  const open = await trx.selectFrom('consents').select('id').where('org_id', '=', orgId).where('subject_type', '=', input.subjectType)
    .where('subject_id', '=', input.subjectId).where('purpose', '=', input.purpose).where('withdrawn_at', 'is', null).executeTakeFirst();
  if (open) throw conflict('Consent for that is already recorded.');
  return Number((await trx.insertInto('consents').values({
    org_id: orgId, subject_type: input.subjectType, subject_id: input.subjectId, purpose: input.purpose,
    notice_version: CONSENT_NOTICE, given_by: input.givenBy?.trim() || null, recorded_by_user_id: userId,
  }).executeTakeFirstOrThrow()).insertId);
}

/** Withdrawn as easily as given; the record of both stays. */
export async function withdrawConsent(trx: Trx, orgId: number, id: number) {
  const r = await trx.updateTable('consents').set({ withdrawn_at: new Date() })
    .where('id', '=', id).where('org_id', '=', orgId).where('withdrawn_at', 'is', null).executeTakeFirst();
  if (!Number(r.numUpdatedRows)) throw notFound('There is no consent standing to withdraw.');
}

export async function listConsents(ex: Executor, orgId: number, subjectType: 'employee' | 'contact', subjectId: number) {
  const rows = await ex.selectFrom('consents as c').leftJoin('users as u', 'u.id', 'c.recorded_by_user_id')
    .select(['c.id', 'c.purpose', 'c.notice_version', 'c.given_at', 'c.given_by', 'c.withdrawn_at', 'u.name as recorded_by'])
    .where('c.org_id', '=', orgId).where('c.subject_type', '=', subjectType).where('c.subject_id', '=', subjectId)
    .orderBy('c.given_at', 'desc').execute();
  return rows.map((r) => ({
    id: String(r.id), purpose: r.purpose, label: CONSENT_PURPOSES[r.purpose as ConsentPurpose] ?? r.purpose, notice: r.notice_version,
    givenAt: new Date(r.given_at).toISOString(), givenBy: r.given_by, withdrawnAt: r.withdrawn_at ? new Date(r.withdrawn_at).toISOString() : null,
    recordedBy: r.recorded_by,
  }));
}

/** Employees with no standing consent to salary processing: the gap to close. */
export async function employeesWithoutConsent(ex: Executor, orgId: number) {
  const rows = await ex.selectFrom('employees as e')
    .leftJoin('consents as c', (j) => j.onRef('c.subject_id', '=', 'e.id').on('c.subject_type', '=', 'employee').on('c.purpose', '=', 'payroll').on('c.withdrawn_at', 'is', null))
    .select(['e.id', 'e.code', 'e.name']).where('e.org_id', '=', orgId).where('e.date_of_leaving', 'is', null).where('c.id', 'is', null)
    .orderBy('e.code').execute();
  return rows.map((r) => ({ id: String(r.id), code: r.code, name: r.name }));
}

export async function logBreach(
  trx: Trx, orgId: number, userId: number | null,
  input: { discoveredAt: string; description: string; dataAffected?: string | null; peopleAffected?: number | null; measures?: string | null },
) {
  if (!input.description.trim()) throw badRequest('Say what happened.');
  return Number((await trx.insertInto('privacy_breaches').values({
    org_id: orgId, discovered_at: new Date(input.discoveredAt), description: input.description.trim(),
    data_affected: input.dataAffected?.trim() || null, people_affected: input.peopleAffected ?? null,
    measures: input.measures?.trim() || null, created_by_user_id: userId,
  }).executeTakeFirstOrThrow()).insertId);
}

export async function markBreach(trx: Trx, orgId: number, id: number, step: 'board_informed' | 'board_report' | 'people_informed') {
  const column = `${step}_at` as 'board_informed_at' | 'board_report_at' | 'people_informed_at';
  await trx.updateTable('privacy_breaches').set({ [column]: new Date() }).where('id', '=', id).where('org_id', '=', orgId).execute();
}

export async function listBreaches(ex: Executor, orgId: number) {
  const rows = await ex.selectFrom('privacy_breaches').selectAll().where('org_id', '=', orgId).orderBy('discovered_at', 'desc').execute();
  const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
  return rows.map((b) => ({
    id: String(b.id), discoveredAt: new Date(b.discovered_at).toISOString(), description: b.description, dataAffected: b.data_affected,
    peopleAffected: b.people_affected, measures: b.measures,
    boardInformedAt: iso(b.board_informed_at), boardReportAt: iso(b.board_report_at), peopleInformedAt: iso(b.people_informed_at),
    // The Board is to have the detailed report within 72 hours of the breach becoming known.
    reportDueBy: new Date(new Date(b.discovered_at).getTime() + 72 * 3600_000).toISOString(),
  }));
}
