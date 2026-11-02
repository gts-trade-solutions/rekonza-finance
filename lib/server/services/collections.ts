import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Collections: chasing what customers owe (migration 090).
//
// The workbench lists every customer with money overdue, oldest first, with
// the last follow-up, the promise to pay if there is one, and when to chase
// next. A promise whose date has passed with the customer still owing at
// least the promised amount is a broken promise, and is shown as one: it is
// the single most useful thing for a collector to know.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor, Trx } from '../db';
import type { Paise } from '../../types';
import { toPaiseFromSql, toSqlFromPaise } from '../money-sql';
import { badRequest, notFound } from '../http';

export interface FollowUpInput {
  contactId: number;
  invoiceId?: number | null;
  kind: 'call' | 'email' | 'whatsapp' | 'visit' | 'note';
  note: string;
  promisedDate?: string | null;
  promisedPaise?: Paise | null;
  nextFollowup?: string | null;
}

export async function logFollowUp(trx: Trx, orgId: number, user: { id: number | null; name: string | null }, input: FollowUpInput) {
  if (!input.note.trim()) throw badRequest('Say what happened: who you spoke to and what they said.');
  const c = await trx.selectFrom('contacts').select('id').where('id', '=', input.contactId).where('org_id', '=', orgId).executeTakeFirst();
  if (!c) throw notFound('That customer does not exist.');
  if (input.invoiceId) {
    const inv = await trx.selectFrom('invoices').select('customer_id').where('id', '=', input.invoiceId).where('org_id', '=', orgId).executeTakeFirst();
    if (!inv || inv.customer_id !== input.contactId) throw badRequest('That invoice is not this customer’s.');
  }
  if (input.promisedPaise != null && input.promisedPaise <= 0) throw badRequest('A promise to pay is for an amount above zero.');
  if (input.promisedPaise != null && !input.promisedDate) throw badRequest('Say when they promised to pay.');
  const r = await trx.insertInto('collection_followups').values({
    org_id: orgId, contact_id: input.contactId, invoice_id: input.invoiceId ?? null, kind: input.kind, note: input.note.trim().slice(0, 1000),
    promised_date: input.promisedDate ?? null, promised_amount: input.promisedPaise != null ? toSqlFromPaise(input.promisedPaise) : null,
    next_followup: input.nextFollowup ?? input.promisedDate ?? null, user_id: user.id, author_name: user.name,
  }).executeTakeFirstOrThrow();
  return Number(r.insertId);
}

export interface CollectionRow {
  contactId: string; name: string; phone: string | null; email: string | null;
  overduePaise: Paise; totalDuePaise: Paise; overdueInvoices: number; oldestDays: number;
  lastFollowUp: { at: string; kind: string; note: string; by: string | null } | null;
  promise: { date: string; amountPaise: Paise; broken: boolean } | null;
  nextFollowup: string | null;
  /** Due for a chase today: the next follow-up date has come, or none is set. */
  dueToday: boolean;
}

export async function collectionsWorkbench(ex: Executor, orgId: number, today: string): Promise<CollectionRow[]> {
  const { rows } = await sql<{ contact_id: number; name: string; phone: string | null; email: string | null; overdue: string; due: string; n: number; oldest: string }>`
    SELECT c.id AS contact_id, c.display_name AS name, c.phone, c.email,
           SUM(IF(i.due_date < ${today}, i.total - i.amount_paid, 0)) AS overdue,
           SUM(i.total - i.amount_paid) AS due,
           SUM(i.due_date < ${today}) AS n,
           MIN(IF(i.due_date < ${today}, i.due_date, NULL)) AS oldest
      FROM invoices i JOIN contacts c ON c.id = i.customer_id
     WHERE i.org_id = ${orgId} AND i.status NOT IN ('draft', 'void') AND i.total > i.amount_paid
     GROUP BY c.id, c.display_name, c.phone, c.email
    HAVING overdue > 0
  `.execute(ex);
  if (!rows.length) return [];
  const ids = rows.map((r) => r.contact_id);
  const follow = await ex.selectFrom('collection_followups').selectAll()
    .where('org_id', '=', orgId).where('contact_id', 'in', ids).orderBy('id', 'desc').execute();
  const day = (d: unknown) => String(d).slice(0, 10);
  const ageOf = (d: string) => Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${d}T00:00:00Z`)) / 86_400_000);
  return rows.map((r) => {
    const mine = follow.filter((f) => f.contact_id === r.contact_id);
    const last = mine[0];
    const promised = mine.find((f) => f.promised_date);
    const totalDue = toPaiseFromSql(r.due);
    const promise = promised ? {
      date: day(promised.promised_date), amountPaise: toPaiseFromSql(promised.promised_amount ?? '0'),
      // Broken: the day has passed and nothing like the promised sum came in since it was made.
      broken: day(promised.promised_date) < today && totalDue > 0 && toPaiseFromSql(promised.promised_amount ?? '0') > 0,
    } : null;
    const next = mine.find((f) => f.next_followup)?.next_followup ?? null;
    return {
      contactId: String(r.contact_id), name: r.name, phone: r.phone, email: r.email,
      overduePaise: toPaiseFromSql(r.overdue), totalDuePaise: totalDue, overdueInvoices: Number(r.n),
      oldestDays: r.oldest ? ageOf(day(r.oldest)) : 0,
      lastFollowUp: last ? { at: new Date(last.created_at).toISOString(), kind: last.kind, note: last.note, by: last.author_name } : null,
      promise, nextFollowup: next ? day(next) : null,
      dueToday: !next || day(next) <= today,
    };
  }).sort((a, b) => b.oldestDays - a.oldestDays);
}

export async function followUpsFor(ex: Executor, orgId: number, contactId: number) {
  const rows = await ex.selectFrom('collection_followups as f').leftJoin('invoices as i', 'i.id', 'f.invoice_id')
    .select(['f.id', 'f.kind', 'f.note', 'f.promised_date', 'f.promised_amount', 'f.next_followup', 'f.author_name', 'f.created_at', 'i.number as invoice_number'])
    .where('f.org_id', '=', orgId).where('f.contact_id', '=', contactId).orderBy('f.id', 'desc').limit(200).execute();
  return rows.map((f) => ({
    id: String(f.id), kind: f.kind, note: f.note, by: f.author_name, at: new Date(f.created_at).toISOString(), invoiceNumber: f.invoice_number,
    promisedDate: f.promised_date ? String(f.promised_date).slice(0, 10) : null,
    promisedPaise: f.promised_amount != null ? toPaiseFromSql(f.promised_amount) : null,
    nextFollowup: f.next_followup ? String(f.next_followup).slice(0, 10) : null,
  }));
}
