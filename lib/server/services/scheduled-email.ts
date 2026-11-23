import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Zoho's "Send ▾ → Schedule Email" on an invoice: the email is written now and
// goes at the time chosen. It is a job on the queue (kind mail.invoice,
// lib/server/jobs), run by the worker when its time comes, through the same
// emailInvoice the Send button uses, so a scheduled email is exactly the one
// that would have gone by hand. Until then it can be called off.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor } from '../db';
import { badRequest, notFound } from '../http';
import { mailStatus } from '../mail/mailer';
import { enqueueNow } from '../jobs/queue';

/** The earliest and latest a schedule may be set for: a minute from now, a year ahead. */
const SOONEST_MS = 60_000;
const LATEST_MS = 366 * 24 * 3600_000;

export interface ScheduledEmail { id: string; at: string; to: string[]; cc: string[] }

export async function scheduleInvoiceEmail(
  ex: Executor,
  orgId: number,
  userId: number | null,
  invoiceId: number,
  at: Date,
  opts: { to?: string[]; cc?: string[]; message?: string | null; baseUrl?: string; now?: Date },
): Promise<ScheduledEmail> {
  if (!mailStatus().configured) throw badRequest('Email is not set up on this server, so nothing can be scheduled. Copy a link to send instead.');
  const now = opts.now ?? new Date();
  if (Number.isNaN(at.getTime())) throw badRequest('That date and time are not valid.');
  if (at.getTime() < now.getTime() + SOONEST_MS) throw badRequest('Choose a time at least a minute from now, or send it now.');
  if (at.getTime() > now.getTime() + LATEST_MS) throw badRequest('An email can be scheduled up to a year ahead.');
  const inv = await ex.selectFrom('invoices').select(['id', 'status']).where('id', '=', invoiceId).where('org_id', '=', orgId).executeTakeFirst();
  if (!inv) throw notFound('That invoice does not exist.');
  if (inv.status === 'void') throw badRequest('That invoice is void.');
  // As with sending now: a draft is issued (marked as sent) first, by the screen.
  if (inv.status === 'draft') throw badRequest('A draft is not an invoice yet; mark it as sent before scheduling its email.');
  const id = await enqueueNow(ex, {
    orgId, kind: 'mail.invoice', key: `invoice:${invoiceId}:${at.toISOString()}`, userId, now: at,
    payload: { invoiceId, to: opts.to ?? [], cc: opts.cc ?? [], message: opts.message ?? null, baseUrl: opts.baseUrl ?? null },
  });
  if (id == null) throw badRequest('That email is already scheduled for that time.');
  return { id: String(id), at: at.toISOString(), to: opts.to ?? [], cc: opts.cc ?? [] };
}

/** The invoice's emails still waiting to go. */
export async function scheduledInvoiceEmails(ex: Executor, orgId: number, invoiceId: number): Promise<ScheduledEmail[]> {
  const rows = await ex.selectFrom('jobs').select(['id', 'run_after', 'payload'])
    .where('org_id', '=', orgId).where('kind', '=', 'mail.invoice').where('status', '=', 'queued')
    .where(sql<boolean>`CAST(JSON_UNQUOTE(JSON_EXTRACT(payload, '$.invoiceId')) AS UNSIGNED) = ${invoiceId}`)
    .orderBy('run_after').execute();
  return rows.map((r) => {
    const p = (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload) as { to?: string[]; cc?: string[] };
    return { id: String(r.id), at: new Date(r.run_after ?? Date.now()).toISOString(), to: p.to ?? [], cc: p.cc ?? [] };
  });
}

/** Call off a scheduled email that has not gone yet. */
export async function cancelScheduledEmail(ex: Executor, orgId: number, jobId: number): Promise<{ invoiceId: number }> {
  const job = await ex.selectFrom('jobs').select(['id', 'status', 'payload'])
    .where('id', '=', jobId).where('org_id', '=', orgId).where('kind', '=', 'mail.invoice').executeTakeFirst();
  if (!job) throw notFound('That scheduled email does not exist.');
  if (job.status !== 'queued') throw badRequest('That email has already gone, or was called off.');
  await ex.updateTable('jobs').set({ status: 'cancelled' }).where('id', '=', jobId).where('status', '=', 'queued').execute();
  const p = (typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload) as { invoiceId: number };
  return { invoiceId: Number(p.invoiceId) };
}
