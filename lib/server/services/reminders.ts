import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Payment reminders.
//
// On the days a book chooses — a few days before an invoice falls due, on the
// day, and at intervals after — the scheduler queues a reminder for each
// invoice still owed: one per invoice per stage, written out and addressed to
// the customer's phone (WhatsApp, SMS) or email. A stage is queued only within
// a week of its day, so switching reminders on does not flood the queue with
// every old invoice at once.
//
// The message holds {link} where the invoice's link goes: the link is made
// when the reminder is sent, from the address the app is used at. Without a
// provider connected, a person sends each one from the queue and marks it.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import { db, transaction, type Executor, type Trx } from '../db';
import { toPaiseFromSql } from '../money-sql';
import { badRequest, notFound } from '../http';
import { getPolicies } from './org-settings';
import { indiaToday } from './held-journals';

const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const rupees = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dmy = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/** The reminder's words, with {link} for the invoice's link. */
export function reminderText(o: { org: string; customer: string; number: string; balancePaise: number; dueDate: string; today: string }) {
  const when = o.dueDate > o.today ? `falls due on ${dmy(o.dueDate)}` : o.dueDate === o.today ? 'falls due today' : `fell due on ${dmy(o.dueDate)}`;
  return `Dear ${o.customer}, a reminder that invoice ${o.number} for ${rupees(o.balancePaise)} ${when}. You can see it and pay here: {link}\n— ${o.org}`;
}

/** Queue the reminders a book's invoices have reached today. Returns how many. */
export async function queueReminders(trx: Trx, orgId: number, today: string): Promise<number> {
  const rule = (await getPolicies(trx, orgId)).reminders;
  if (!rule.enabled || !rule.stages.length) return 0;
  const org = await trx.selectFrom('organizations').select(['name', 'legal_name']).where('id', '=', orgId).executeTakeFirstOrThrow();
  const earliest = addDays(today, -Math.max(...rule.stages) - 7);
  const latest = addDays(today, -Math.min(...rule.stages));
  const open = await trx.selectFrom('invoices as i').innerJoin('contacts as c', 'c.id', 'i.customer_id')
    .select(['i.id', 'i.number', 'i.due_date', 'i.total', 'i.amount_paid', 'c.display_name', 'c.phone', 'c.email'])
    .where('i.org_id', '=', orgId).where('i.status', 'in', ['approved', 'sent', 'overdue', 'partially_paid'])
    .where('i.due_date', '>=', earliest).where('i.due_date', '<=', latest).execute();
  if (!open.length) return 0;
  const done = await trx.selectFrom('payment_reminders').select(['invoice_id', 'stage_days']).where('invoice_id', 'in', open.map((i) => i.id)).execute();
  const have = new Set(done.map((d) => `${d.invoice_id}:${d.stage_days}`));
  let queued = 0;
  for (const inv of open) {
    const balance = toPaiseFromSql(inv.total) - toPaiseFromSql(inv.amount_paid);
    if (balance <= 0) continue;
    const due = String(inv.due_date).slice(0, 10);
    // The latest stage reached in the last week, if it has not gone out.
    const stage = rule.stages.filter((s) => addDays(due, s) <= today && addDays(due, s + 6) >= today).sort((a, b) => b - a)[0];
    if (stage === undefined || have.has(`${inv.id}:${stage}`)) continue;
    const to = rule.channel === 'email' ? inv.email : inv.phone;
    await trx.insertInto('payment_reminders').values({
      org_id: orgId, invoice_id: inv.id, stage_days: stage, channel: rule.channel, to_address: to || null,
      subject: `Invoice ${inv.number}: payment reminder`, queued_on: today,
      message: reminderText({ org: org.legal_name ?? org.name, customer: inv.display_name, number: inv.number, balancePaise: balance, dueDate: due, today }),
    }).execute();
    queued++;
  }
  return queued;
}

/** The scheduler's sweep, once a day per book with reminders on. */
export async function runReminders(day = indiaToday()): Promise<number> {
  const { rows } = await sql<{ org_id: number }>`
    SELECT DISTINCT org_id FROM settings WHERE scope = 'policy' AND setting_key = 'reminders'
       AND JSON_UNQUOTE(JSON_EXTRACT(value, '$.enabled')) = 'true'`.execute(db);
  let queued = 0;
  for (const r of rows) {
    try {
      queued += await transaction((trx) => queueReminders(trx, Number(r.org_id), day));
    } catch (err) {
      console.error('[reminders]', r.org_id, err);
    }
  }
  return queued;
}

export async function listReminders(ex: Executor, orgId: number, status: 'queued' | 'sent' | 'skipped') {
  const rows = await ex.selectFrom('payment_reminders as r').innerJoin('invoices as i', 'i.id', 'r.invoice_id')
    .innerJoin('contacts as c', 'c.id', 'i.customer_id').leftJoin('users as u', 'u.id', 'r.sent_by_user_id')
    .select(['r.id', 'r.invoice_id', 'r.stage_days', 'r.channel', 'r.to_address', 'r.subject', 'r.message', 'r.status', 'r.queued_on', 'r.sent_at',
      'i.number', 'i.due_date', 'i.total', 'i.amount_paid', 'i.status as invoice_status', 'c.display_name', 'u.name as sent_by'])
    .where('r.org_id', '=', orgId).where('r.status', '=', status)
    .orderBy(status === 'queued' ? 'r.queued_on' : 'r.sent_at', status === 'queued' ? 'asc' : 'desc').limit(300).execute();
  return rows.map((r) => ({
    id: String(r.id), invoiceId: String(r.invoice_id), number: r.number, customer: r.display_name, stageDays: r.stage_days,
    channel: r.channel, to: r.to_address, subject: r.subject, message: r.message, status: r.status,
    queuedOn: String(r.queued_on).slice(0, 10), sentAt: r.sent_at ? new Date(r.sent_at).toISOString() : null, sentBy: r.sent_by,
    dueDate: String(r.due_date).slice(0, 10), balancePaise: toPaiseFromSql(r.total) - toPaiseFromSql(r.amount_paid),
    // Paid since it was queued: nothing to remind about.
    settled: toPaiseFromSql(r.total) - toPaiseFromSql(r.amount_paid) <= 0 || r.invoice_status === 'void',
  }));
}

export async function markReminder(trx: Trx, orgId: number, userId: number | null, id: number, status: 'sent' | 'skipped') {
  const r = await trx.selectFrom('payment_reminders').select(['status']).where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
  if (!r) throw notFound('That reminder was not found.');
  if (r.status !== 'queued') throw badRequest(`It was already ${r.status}.`);
  await trx.updateTable('payment_reminders').set({ status, sent_at: new Date(), sent_by_user_id: userId }).where('id', '=', id).execute();
}
