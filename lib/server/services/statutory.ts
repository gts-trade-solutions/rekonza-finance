import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Statutory settings that change with the business, each with the date it took
// effect, so that a document is always read under the rules of its own date.
//
//   * GST registration type. Leaving composition, or registering after
//     crossing the threshold, happens on a date; bills of supply before it and
//     tax invoices after it are both right. The current type stays on
//     organizations; each change is a row here, and registrationOn() answers
//     for any date.
//   * E-invoicing (Rule 48(4)). Applies once aggregate turnover has passed
//     ₹5 crore in any financial year since 2017-18, from the following 1 April,
//     and does not lapse if turnover falls again. An IRN is needed for supplies
//     to registered persons, SEZs and exports, and for deemed exports.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor, Trx } from '../db';
import { badRequest, conflict } from '../http';
import { assertPeriodOpen } from '../ledger/posting';

export type RegistrationType = 'regular' | 'composition' | 'unregistered';

/** Today in the server's own time zone (IST in practice), not UTC. */
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** Recipients whose invoices need an IRN once e-invoicing applies. */
const IRN_TREATMENTS = new Set(['registered', 'registered_composition', 'sez', 'sez_developer', 'overseas', 'deemed_export']);

export interface EinvoiceApplicability { applicable: boolean; from: string | null }

/** Does an invoice need an IRN? Pure, so the rule can be tested without a database. */
export function irnRequired(e: EinvoiceApplicability, branchGstin: string | null | undefined, customerTreatment: string | null | undefined, invoiceDate: string): boolean {
  if (!e.applicable || !branchGstin) return false;
  if (e.from && invoiceDate < e.from) return false;
  return IRN_TREATMENTS.has(customerTreatment ?? '');
}

export async function einvoiceApplicability(ex: Executor, orgId: number): Promise<EinvoiceApplicability> {
  const o = await ex.selectFrom('organizations').select(['aato_above_5cr', 'einvoice_from']).where('id', '=', orgId).executeTakeFirst();
  return { applicable: !!o?.aato_above_5cr, from: o?.einvoice_from ? String(o.einvoice_from).slice(0, 10) : null };
}

/**
 * Turn e-invoicing on or off, and bring the register into line: posted
 * invoices from the start date that never got an IRN become due, or stop
 * being, so the e-invoice queue and the period-close check say the same thing.
 * Invoices that already have an IRN, or had one cancelled, are left alone.
 */
export async function setEinvoicing(trx: Trx, orgId: number, input: EinvoiceApplicability): Promise<{ queued: number; cleared: number }> {
  if (input.applicable && input.from && !/^\d{4}-04-01$/.test(input.from)) {
    throw badRequest('E-invoicing starts on 1 April: the year after turnover first passed ₹5 crore.');
  }
  await trx.updateTable('organizations')
    .set({ aato_above_5cr: input.applicable ? 1 : 0, einvoice_from: input.applicable ? input.from : null })
    .where('id', '=', orgId).execute();

  const rows = await trx.selectFrom('einvoices as e')
    .innerJoin('invoices as i', 'i.id', 'e.invoice_id')
    .innerJoin('branches as b', 'b.id', 'i.branch_id')
    .innerJoin('contacts as c', 'c.id', 'i.customer_id')
    .select(['e.id', 'e.status', 'i.invoice_date', 'b.gstin', 'c.gst_treatment'])
    .where('e.org_id', '=', orgId).where('e.status', 'in', ['not_applicable', 'pending', 'failed'])
    .where('i.status', 'not in', ['draft', 'void'])
    .execute();
  const due: number[] = [];
  const notDue: number[] = [];
  for (const r of rows) {
    const need = irnRequired(input, r.gstin, r.gst_treatment, String(r.invoice_date).slice(0, 10));
    if (need && r.status === 'not_applicable') due.push(r.id);
    if (!need && r.status !== 'not_applicable') notDue.push(r.id);
  }
  if (due.length) await trx.updateTable('einvoices').set({ status: 'pending' }).where('id', 'in', due).execute();
  if (notDue.length) await trx.updateTable('einvoices').set({ status: 'not_applicable' }).where('id', 'in', notDue).execute();
  return { queued: due.length, cleared: notDue.length };
}

export interface RegistrationChange {
  id: string; effectiveFrom: string; fromType: RegistrationType; toType: RegistrationType;
  reason: string; by: string | null; at: string;
}

export async function registrationHistory(ex: Executor, orgId: number): Promise<RegistrationChange[]> {
  const rows = await ex.selectFrom('gst_registration_changes as g')
    .leftJoin('users as u', 'u.id', 'g.created_by_user_id')
    .select(['g.id', 'g.effective_from', 'g.from_type', 'g.to_type', 'g.reason', 'u.name', 'g.created_at'])
    .where('g.org_id', '=', orgId).orderBy('g.effective_from', 'desc').orderBy('g.id', 'desc').execute();
  return rows.map((r) => ({
    id: String(r.id), effectiveFrom: String(r.effective_from).slice(0, 10), fromType: r.from_type, toType: r.to_type,
    reason: r.reason, by: r.name, at: new Date(r.created_at).toISOString(),
  }));
}

/** The registration type in force on a date. */
export async function registrationOn(ex: Executor, orgId: number, date: string): Promise<RegistrationType> {
  const after = await ex.selectFrom('gst_registration_changes').select('from_type')
    .where('org_id', '=', orgId).where('effective_from', '>', date)
    .orderBy('effective_from').orderBy('id').executeTakeFirst();
  if (after) return after.from_type;
  const o = await ex.selectFrom('organizations').select('gst_registration_type').where('id', '=', orgId).executeTakeFirstOrThrow();
  return o.gst_registration_type;
}

/**
 * Record a change of registration type. It takes effect on a date that is not
 * in a closed period and not before an invoice already issued: those were
 * issued under the old type and say so on their face.
 */
export async function changeRegistration(
  trx: Trx, orgId: number, userId: number | null,
  input: { toType: RegistrationType; effectiveFrom: string; reason: string },
): Promise<RegistrationChange[]> {
  const o = await trx.selectFrom('organizations').select('gst_registration_type').where('id', '=', orgId).forUpdate().executeTakeFirstOrThrow();
  if (o.gst_registration_type === input.toType) throw badRequest(`The book is already ${input.toType}.`);
  const reason = input.reason.trim();
  if (reason.length < 4) throw badRequest('Give the reason: the order, the date of the application, or what changed.');
  if (input.effectiveFrom > today()) throw badRequest('Record a change once it has taken effect, not before.');
  await assertPeriodOpen(trx, orgId, 'sales', input.effectiveFrom);
  const last = await trx.selectFrom('gst_registration_changes').select(sql<string>`MAX(effective_from)`.as('d'))
    .where('org_id', '=', orgId).executeTakeFirst();
  if (last?.d && input.effectiveFrom <= String(last.d).slice(0, 10)) {
    throw conflict(`The last change took effect on ${String(last.d).slice(0, 10)}; a new one has to come after it.`);
  }
  const later = await trx.selectFrom('invoices').select(['number', 'invoice_date'])
    .where('org_id', '=', orgId).where('status', '<>', 'draft').where('invoice_date', '>=', input.effectiveFrom)
    .orderBy('invoice_date').executeTakeFirst();
  if (later) {
    throw conflict(
      `${later.number} of ${String(later.invoice_date).slice(0, 10)} was issued as ${o.gst_registration_type} on or after that date. ` +
        'A change can only take effect after the last invoice issued under the old type.',
    );
  }
  await trx.insertInto('gst_registration_changes').values({
    org_id: orgId, effective_from: input.effectiveFrom, from_type: o.gst_registration_type, to_type: input.toType,
    reason: reason.slice(0, 300), created_by_user_id: userId,
  }).execute();
  await trx.updateTable('organizations').set({ gst_registration_type: input.toType }).where('id', '=', orgId).execute();
  return registrationHistory(trx, orgId);
}

/** registrationOn for many dates at once, from one read of the history. */
export async function registrationResolver(ex: Executor, orgId: number): Promise<(date: string) => RegistrationType> {
  const changes = await ex.selectFrom('gst_registration_changes').select(['effective_from', 'from_type'])
    .where('org_id', '=', orgId).orderBy('effective_from').orderBy('id').execute();
  const o = await ex.selectFrom('organizations').select('gst_registration_type').where('id', '=', orgId).executeTakeFirstOrThrow();
  const list = changes.map((c) => ({ from: String(c.effective_from).slice(0, 10), before: c.from_type }));
  return (date) => list.find((c) => c.from > date)?.before ?? o.gst_registration_type;
}
