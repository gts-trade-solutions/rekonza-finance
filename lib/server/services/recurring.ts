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
import { createInvoice, markInvoiceSent } from './sales';
import { createBill, createExpense } from './purchases';

export type Frequency = 'weekly' | 'monthly' | 'quarterly' | 'yearly';

/** Move a date forward one period. 31 Jan rolls to 28 or 29 Feb, never into March. */
export function advancePeriod(date: string, frequency: Frequency): string {
  const d = new Date(`${date}T00:00:00Z`);
  const day = d.getUTCDate();
  if (frequency === 'weekly') d.setUTCDate(day + 7);
  else if (frequency === 'monthly') d.setUTCMonth(d.getUTCMonth() + 1);
  else if (frequency === 'quarterly') d.setUTCMonth(d.getUTCMonth() + 3);
  else d.setUTCFullYear(d.getUTCFullYear() + 1);
  if (frequency !== 'weekly' && d.getUTCDate() !== day) d.setUTCDate(0);
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

export interface TemplateLine { itemId: number | null; description: string | null; qty: number; ratePaise: number; gstRatePct: number; hsnSac: string | null }

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

  const invoice = await createInvoice(trx, orgId, userId, {
    branchId: profile.branch_id, customerId: profile.customer_id, date: runDate, dueDate: due.toISOString().slice(0, 10),
    status: 'approved', subject: profile.profile_name, paymentTerms: profile.payment_terms,
    sourceDocType: 'recurring', sourceDocId: id,
    lines: template.map((l) => ({
      itemId: l.itemId, description: l.description, hsnSac: l.hsnSac, qty: l.qty, ratePaise: l.ratePaise, gstRatePct: l.gstRatePct,
    })),
  });
  // Auto-send moves it straight to sent; otherwise it waits for a human.
  if (profile.auto_send) await markInvoiceSent(trx, orgId, userId, invoice.id);
  await trx.updateTable('recurring_invoices').set({
    last_generated_at: runDate, next_run: advancePeriod(runDate, profile.frequency as Frequency), last_error: null,
  }).where('id', '=', id).execute();
  return { name: profile.profile_name, invoice, runDate, autoSent: !!profile.auto_send };
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
