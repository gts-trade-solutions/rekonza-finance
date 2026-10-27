import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Share links: one invoice, or one employee's payslip for a month, opened by
// whoever holds the link, without signing in. Read-only and the recipient's
// copy only; it lapses on its expiry date and can be revoked sooner. The token is random and only its hash is kept,
// so the table alone cannot open anything.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash, randomBytes } from 'node:crypto';
import type { Executor, Trx } from '../db';
import { notFound } from '../http';

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

export async function createShareLink(trx: Trx, orgId: number, userId: number | null, input: { invoiceId: number; days?: number }) {
  const inv = await trx.selectFrom('invoices').select(['id', 'status']).where('id', '=', input.invoiceId).where('org_id', '=', orgId).executeTakeFirst();
  if (!inv) throw notFound('That invoice does not exist.');
  if (inv.status === 'draft') throw notFound('A draft is not an invoice yet; issue it before sending it.');
  const token = randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + Math.min(Math.max(input.days ?? 30, 1), 180) * 86_400_000);
  await trx.insertInto('share_links').values({
    org_id: orgId, token_hash: hash(token), doc_type: 'invoice', doc_id: inv.id, expires_at: expiresAt, created_by_user_id: userId,
  }).execute();
  return { path: `/share/${token}`, expiresAt: expiresAt.toISOString() };
}

/** A link to one employee's payslip in a posted payroll month. */
export async function createPayslipLink(trx: Trx, orgId: number, userId: number | null, input: { runId: number; employeeId: number; days?: number }) {
  const line = await trx.selectFrom('payroll_lines as l').innerJoin('payroll_runs as r', 'r.id', 'l.run_id')
    .select(['r.status']).where('r.id', '=', input.runId).where('r.org_id', '=', orgId).where('l.employee_id', '=', input.employeeId).executeTakeFirst();
  if (!line) throw notFound('That employee is not on that payroll.');
  if (line.status === 'draft') throw notFound('A draft payroll is not final; post it before sending payslips.');
  const token = randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + Math.min(Math.max(input.days ?? 30, 1), 180) * 86_400_000);
  await trx.insertInto('share_links').values({
    org_id: orgId, token_hash: hash(token), doc_type: 'payslip', doc_id: input.runId, sub_id: input.employeeId, expires_at: expiresAt, created_by_user_id: userId,
  }).execute();
  return { path: `/share/${token}`, expiresAt: expiresAt.toISOString() };
}

/** What a link opens, counting the opening; null when it is unknown, expired or revoked. */
export async function openShareLink(ex: Executor, token: string): Promise<{ orgId: number; docType: 'invoice' | 'payslip'; docId: number; subId: number | null } | null> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const link = await ex.selectFrom('share_links').select(['id', 'org_id', 'doc_type', 'doc_id', 'sub_id', 'expires_at', 'revoked_at'])
    .where('token_hash', '=', hash(token)).executeTakeFirst();
  if (!link || link.revoked_at || new Date(link.expires_at) < new Date()) return null;
  await ex.updateTable('share_links').set((eb) => ({ opens: eb('opens', '+', 1), last_opened_at: new Date() })).where('id', '=', link.id).execute();
  return { orgId: link.org_id, docType: link.doc_type, docId: link.doc_id, subId: link.sub_id };
}

export async function listShareLinks(ex: Executor, orgId: number, invoiceId: number) {
  const rows = await ex.selectFrom('share_links as s').leftJoin('users as u', 'u.id', 's.created_by_user_id')
    .select(['s.id', 's.expires_at', 's.revoked_at', 's.opens', 's.last_opened_at', 's.created_at', 'u.name'])
    .where('s.org_id', '=', orgId).where('s.doc_type', '=', 'invoice').where('s.doc_id', '=', invoiceId).orderBy('s.id', 'desc').execute();
  return rows.map((r) => ({
    id: String(r.id), createdAt: new Date(r.created_at).toISOString(), createdBy: r.name, expiresAt: new Date(r.expires_at).toISOString(),
    revoked: !!r.revoked_at, opens: r.opens, lastOpenedAt: r.last_opened_at ? new Date(r.last_opened_at).toISOString() : null,
  }));
}

/** Every live link to an invoice stops working. */
export async function revokeShareLinks(trx: Trx, orgId: number, invoiceId: number) {
  const r = await trx.updateTable('share_links').set({ revoked_at: new Date() })
    .where('org_id', '=', orgId).where('doc_type', '=', 'invoice').where('doc_id', '=', invoiceId).where('revoked_at', 'is', null)
    .where('expires_at', '>', new Date()).executeTakeFirst();
  return Number(r.numUpdatedRows);
}
