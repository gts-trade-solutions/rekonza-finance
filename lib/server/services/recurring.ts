import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Running a recurring profile: one journal entry, or one invoice, for the
// period the profile is up to, and the schedule rolled forward a period.
//
// The screen's "Run now" and the scheduler both come here, so an entry the
// scheduler posts is the entry a person would have posted. Neither catches up
// on missed periods: the scheduler leaves a profile that has fallen more than
// a period behind for a person to look at (scheduler.ts).
// ─────────────────────────────────────────────────────────────────────────────

import type { Trx } from '../db';
import { toPaiseFromSql } from '../money-sql';
import { postEntry } from '../ledger/posting';
import { conflict, notFound } from '../http';
import { createInvoice, markInvoiceSent, type InvoiceLineInput } from './sales';
import { unbilled } from './projects';
import { createPaymentLink, gatewayStatus } from './payment-links';
import { createBill, createExpense } from './purchases';

export type Frequency = 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'yearly';

/**
 * Move a date forward `every` periods (Zoho's "Repeat Every": 2 Weeks, 6
 * Months, 3 Years …). 31 Jan rolls to 28 or 29 Feb, never into March.
 */
export function advancePeriod(date: string, frequency: Frequency, every = 1): string {
  const n = Math.max(1, Math.floor(every) || 1);
  const d = new Date(`${date}T00:00:00Z`);
  const day = d.getUTCDate();
  if (frequency === 'daily') d.setUTCDate(day + n);
  else if (frequency === 'weekly') d.setUTCDate(day + 7 * n);
  else if (frequency === 'monthly') d.setUTCMonth(d.getUTCMonth() + n);
  else if (frequency === 'quarterly') d.setUTCMonth(d.getUTCMonth() + 3 * n);
  else d.setUTCFullYear(d.getUTCFullYear() + n);
  if (frequency !== 'weekly' && frequency !== 'daily' && d.getUTCDate() !== day) d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
}

const ymd = (v: unknown) => String(v).slice(0, 10);

export async function runRecurringJournal(trx: Trx, orgId: number, userId: number | null, id: number, date?: string) {
  const profile = await trx.selectFrom('recurring_journals').selectAll()
    .where('id', '=', id).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!profile) throw notFound('That profile does not exist.');
  if (!profile.is_active) throw conflict(`${profile.name} is paused. Resume it before running it.`);
  const runDate = date ?? ymd(profile.next_run);
  if (profile.end_date && runDate > ymd(profile.end_date)) throw conflict(`${profile.name} ended on ${ymd(profile.end_date)}.`);

  const amountPaise = toPaiseFromSql(profile.amount);
  const entry = await postEntry(trx, {
    orgId, branchId: profile.branch_id, date: runDate, memo: profile.memo || profile.name,
    sourceType: 'recurring', sourceId: id, userId, module: 'accountant',
    lines: [
      { accountId: profile.debit_account_id, debit: amountPaise },
      { accountId: profile.credit_account_id, credit: amountPaise },
    ],
  });
  await trx.updateTable('recurring_journals').set({
    last_posted_at: runDate, next_run: advancePeriod(runDate, profile.frequency as Frequency), last_error: null,
  }).where('id', '=', id).execute();
  return { name: profile.name, entry, runDate, amountPaise };
}

export const TERM_DAYS: Record<string, number> = { due_on_receipt: 0, net_15: 15, net_30: 30, net_45: 45, net_60: 60 };

/** A profile's line as written; the discount is kept apart from the rate, as Zoho's item table has it. */
export interface TemplateLine { itemId: number | null; description: string | null; qty: number; ratePaise: number; gstRatePct: number; hsnSac: string | null; discountPct?: number }

export async function runRecurringInvoice(trx: Trx, orgId: number, userId: number | null, id: number, date?: string) {
  const profile = await trx.selectFrom('recurring_invoices').selectAll()
    .where('id', '=', id).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!profile) throw notFound('That profile does not exist.');
  if (!profile.is_active) throw conflict(`${profile.profile_name} is paused. Resume it before running it.`);
  const runDate = date ?? ymd(profile.next_run);
  if (profile.end_date && runDate > ymd(profile.end_date)) throw conflict(`${profile.profile_name} ended on ${ymd(profile.end_date)}.`);

  const template = (typeof profile.template === 'string' ? JSON.parse(profile.template) : profile.template) as TemplateLine[];
  const due = new Date(`${runDate}T00:00:00Z`);
  due.setUTCDate(due.getUTCDate() + (TERM_DAYS[profile.payment_terms ?? 'net_30'] ?? 30));

  // Zoho's "Create Invoices as Drafts": each invoice waits as a draft for someone to check.
  const asDraft = !!profile.create_as_draft;
  // Zoho's "Associate Project(s) Hours": each project's billable, unbilled hours
  // up to the invoice date go on as lines at the project's rates, and are
  // marked billed with the invoice, so the next one does not bill them again.
  const projectIds = (typeof profile.project_ids === 'string' ? JSON.parse(profile.project_ids) : profile.project_ids ?? []) as number[];
  const hourLines: InvoiceLineInput[] = [];
  const entryIds: number[] = [];
  for (const pid of projectIds) {
    const project = await trx.selectFrom('projects').select(['id', 'name', 'customer_id', 'gst_rate_pct', 'sac_code', 'status'])
      .where('id', '=', Number(pid)).where('org_id', '=', orgId).executeTakeFirst();
    if (!project || project.status !== 'active' || (project.customer_id && project.customer_id !== profile.customer_id)) continue;
    const u = await unbilled(trx, orgId, project.id, runDate);
    for (const t of u.time) {
      const hours = Math.round((t.minutes / 60) * 100) / 100;
      hourLines.push({ description: `${project.name}: ${t.label} — ${hours} h`, hsnSac: project.sac_code || null, qty: hours, uqc: 'HRS', ratePaise: t.ratePaise, gstRatePct: Number(project.gst_rate_pct) });
      entryIds.push(...t.entryIds);
    }
  }
  const invoice = await createInvoice(trx, orgId, userId, {
    branchId: profile.branch_id, customerId: profile.customer_id, date: runDate, dueDate: due.toISOString().slice(0, 10),
    status: asDraft ? 'draft' : 'approved', subject: profile.profile_name, paymentTerms: profile.payment_terms,
    orderNumber: profile.order_number, salespersonId: profile.salesperson_id, notes: profile.notes, terms: profile.terms,
    // Zoho's Entity type, the totals' Shipping Charges and adjustment, and the
    // Rounding Off Preference (migration 126), as on the profile at the time.
    billOfSupply: profile.entity_type === 'bill_of_supply' || undefined,
    shippingChargePaise: toPaiseFromSql(profile.shipping_charge ?? '0'),
    adjustmentPaise: toPaiseFromSql(profile.adjustment ?? '0'),
    adjustmentLabel: profile.adjustment_label || null,
    roundTotal: profile.round_off !== 'none',
    sourceDocType: 'recurring', sourceDocId: id,
    lines: [
      ...template.map((l) => ({
        itemId: l.itemId, description: l.description, hsnSac: l.hsnSac, qty: l.qty, ratePaise: l.ratePaise, gstRatePct: l.gstRatePct, discountPct: l.discountPct ?? 0,
      })),
      ...hourLines,
    ],
  });
  if (entryIds.length) await trx.updateTable('time_entries').set({ invoice_id: invoice.id }).where('id', 'in', entryIds).execute();
  if (projectIds.length === 1) await trx.updateTable('invoices').set({ project_id: Number(projectIds[0]) }).where('id', '=', invoice.id).execute();
  // Auto-send moves it straight to sent; otherwise it waits for a human. A draft is never sent.
  const send = !!profile.auto_send && !asDraft;
  if (send) await markInvoiceSent(trx, orgId, userId, invoice.id);
  // Zoho's "Associate Payment Options": a payment link on each issued invoice,
  // when online payments are connected. A link that cannot be made does not
  // undo the invoice; why is kept on the profile for its record to show.
  let linkNote: string | null = null;
  let paymentLink: string | null = null;
  if (profile.payment_link && !asDraft) {
    try {
      if ((await gatewayStatus(trx, orgId)).connected) paymentLink = (await createPaymentLink(trx, orgId, userId, invoice.id)).url;
      else linkNote = 'No payment link: online payments are not connected (Settings → Integrations).';
    } catch (e) {
      linkNote = `No payment link on ${invoice.number}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500);
    }
  }
  await trx.updateTable('recurring_invoices').set({
    last_generated_at: runDate, next_run: advancePeriod(runDate, profile.frequency as Frequency, profile.repeat_every), last_error: linkNote,
  }).where('id', '=', id).execute();
  return { name: profile.profile_name, invoice, runDate, autoSent: send, hoursBilled: entryIds.length, paymentLink };
}

/** A recurring bill's line, as written on the profile. */
export interface BillTemplateLine {
  itemId: number | null; accountId: number | null; description: string | null;
  qty: number; ratePaise: number; gstRatePct: number; hsnSac: string | null;
}
/** A recurring expense: what it is booked to, and what is paid each time. */
export interface ExpenseTemplate {
  accountId: number; amountPaise: number; gstRatePct: number;
  itcEligibility: 'eligible' | 'ineligible' | 'capital_goods'; notes: string | null;
}

/**
 * Raise one bill, or record one expense, from a recurring purchase profile.
 *
 * A bill is given a placeholder for the vendor's own number, RB<profile>/<date>,
 * because theirs is not known until their bill arrives: whoever files it
 * replaces the placeholder with the number on the vendor's paper.
 */
export async function runRecurringPurchase(trx: Trx, orgId: number, userId: number | null, id: number, date?: string) {
  const profile = await trx.selectFrom('recurring_purchases').selectAll()
    .where('id', '=', id).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!profile) throw notFound('That profile does not exist.');
  if (!profile.is_active) throw conflict(`${profile.profile_name} is paused. Resume it before running it.`);
  const runDate = date ?? ymd(profile.next_run);
  if (profile.end_date && runDate > ymd(profile.end_date)) throw conflict(`${profile.profile_name} ended on ${ymd(profile.end_date)}.`);
  const template = typeof profile.template === 'string' ? JSON.parse(profile.template) : profile.template;

  let made: { kind: 'bill' | 'expense'; id: number; number: string; totalPaise: number };
  if (profile.kind === 'bill') {
    if (!profile.vendor_id) throw conflict(`${profile.profile_name} has no vendor to bill from.`);
    const due = new Date(`${runDate}T00:00:00Z`);
    due.setUTCDate(due.getUTCDate() + profile.due_days);
    const lines = template as BillTemplateLine[];
    const bill = await createBill(trx, orgId, userId, {
      branchId: profile.branch_id, vendorId: profile.vendor_id,
      vendorInvoiceNo: `RB${id}/${runDate.slice(2).replace(/-/g, '')}`,
      date: runDate, dueDate: due.toISOString().slice(0, 10),
      notes: `${profile.profile_name} — raised from a recurring profile. Replace the bill number with the vendor's own when their bill arrives.`,
      lines: lines.map((l) => ({
        itemId: l.itemId, accountId: l.accountId, description: l.description, hsnSac: l.hsnSac,
        qty: l.qty, ratePaise: l.ratePaise, gstRatePct: l.gstRatePct,
      })),
    });
    await trx.updateTable('bills').set({ recurring_id: id }).where('id', '=', bill.id).execute();
    made = { kind: 'bill', id: bill.id, number: bill.internalNo, totalPaise: bill.totalPaise };
  } else {
    if (!profile.paid_through_bank_account_id) throw conflict(`${profile.profile_name} does not say what it is paid from.`);
    const t = template as ExpenseTemplate;
    const exp = await createExpense(trx, orgId, userId, {
      branchId: profile.branch_id, date: runDate, accountId: t.accountId,
      paidThroughBankAccountId: profile.paid_through_bank_account_id, amountPaise: t.amountPaise,
      gstRatePct: t.gstRatePct, vendorId: profile.vendor_id, itcEligibility: t.itcEligibility,
      notes: t.notes ?? profile.profile_name,
    });
    await trx.updateTable('expenses').set({ recurring_id: id }).where('id', '=', exp.id).execute();
    made = { kind: 'expense', id: exp.id, number: exp.number, totalPaise: exp.totalPaise };
  }
  await trx.updateTable('recurring_purchases').set({
    last_generated_at: runDate, next_run: advancePeriod(runDate, profile.frequency as Frequency), last_error: null,
  }).where('id', '=', id).execute();
  return { name: profile.profile_name, made, runDate };
}
