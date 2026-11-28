import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Admin codes: undoing or changing posted work needs an admin's say-so.
//
// The client (2026-11-28): "once the user reversed, an OTP should go to admin,
// and when they enter it, that time the user's reversal goes through", and
// "the user can create the invoice and the admin will modify; if they need a
// modification in an invoice they need approval from admin".
//
// So when someone who is not an admin
//   · undoes posted work: reverses a journal, uncategorises a bank line, voids
//     or deletes a document, reopens a pay run, undoes a disposal; or
//   · changes a saved invoice,
// the request is stopped (428 admin_code_required) and a six-digit code goes
// to the company's admins: in their notifications, and by email when a mail
// server is set up. The admin reads it out or sends it on; the person types
// it; the same request is sent again with the code and goes through. Admins
// themselves act directly.
//
// A code belongs to one person and one request, works once, lapses after ten
// minutes, and dies after five wrong tries. Only its hash is kept. Asking for
// one and using one are both written to the audit trail, so the trail shows
// who wanted what, and that an admin agreed.
//
// It is checked in route() itself (lib/server/http.ts), from the method, the
// path and the body's `action`, so every screen is covered without each one
// knowing about it, as the change-reason rule is. Either half can be switched
// off in Settings → Controls.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash, randomInt } from 'node:crypto';
import { sql } from 'kysely';
import { db } from '../db';
import { ApiError } from '../http';
import { logAudit, auditMeta } from '../audit';
import { mailStatus, sendMail } from '../mail/mailer';
import { getPolicies } from './org-settings';
import { notify } from './notifications';
import type { SessionUser } from '../auth/session';

export type AdminCodeKind = 'undo' | 'invoice_edit';
interface Asked { kind: AdminCodeKind; label: string; scope: string }

const MINUTES = 10;
const MAX_TRIES = 5;
const MAX_CODES_PER_QUARTER_HOUR = 8;

/** Where a DELETE takes posted work out of the books. */
const UNDO_PATHS = /^\/api\/(invoices|bills|payments|sales-documents|purchase-documents|vendor-credits|expenses|journal|held-journals|banking|fixed-assets|payroll|retainers|goods-receipts|bills-of-entry|inventory|manufacturing|stock-transfers|payment-batches|gst|tds-certificates|tds-returns)(\/|$)/;
/** …but not their masters and settings: a bank rule, an employee, an import's history. */
const NOT_POSTED = /\/(rules|employees|declarations|preferences|history|templates|filing)(\/|$)/;
/** A body's `action` that undoes something: void, void-credit-note, unmatch, undo-disposal, reverse, reopen, take-back… */
const UNDO_ACTION = /(^|-)(void|undo|unmatch|uncategori[sz]e|reverse|reopen|unreconcile|take-back|unpost)(-|$)/;

const NOUN: Record<string, string> = {
  invoices: 'invoice', bills: 'bill', payments: 'payment', 'sales-documents': 'sales document', 'purchase-documents': 'purchase document',
  'vendor-credits': 'vendor credit', expenses: 'expense', journal: 'journal entry', 'held-journals': 'journal entry', banking: 'bank transaction',
  'fixed-assets': 'fixed asset entry', payroll: 'payroll entry', retainers: 'retainer', 'goods-receipts': 'goods receipt', 'bills-of-entry': 'bill of entry',
  inventory: 'stock entry', manufacturing: 'production run', 'stock-transfers': 'stock transfer', 'payment-batches': 'payment batch', gst: 'GST entry',
  'tds-certificates': 'TDS certificate', 'tds-returns': 'TDS return',
};

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** The document's own number, where it has one, so the admin knows what is being asked about. */
async function numberOf(orgId: number, resource: string, id: number | null): Promise<string | null> {
  if (!id) return null;
  const one = async (q: ReturnType<typeof sql<{ n: string | number | null }>>) => {
    const v = (await q.execute(db)).rows[0]?.n;
    return v === null || v === undefined ? null : String(v);
  };
  try {
    if (resource === 'invoices') return await one(sql`SELECT number AS n FROM invoices WHERE org_id = ${orgId} AND id = ${id}`);
    if (resource === 'bills') return await one(sql`SELECT COALESCE(vendor_invoice_no, internal_no) AS n FROM bills WHERE org_id = ${orgId} AND id = ${id}`);
    if (resource === 'payments') return await one(sql`SELECT number AS n FROM payments WHERE org_id = ${orgId} AND id = ${id}`);
    if (resource === 'journal') { const n = await one(sql`SELECT entry_no AS n FROM journal_entries WHERE org_id = ${orgId} AND id = ${id}`); return n ? `#${n}` : null; }
    if (resource === 'expenses') return await one(sql`SELECT number AS n FROM expenses WHERE org_id = ${orgId} AND id = ${id}`);
  } catch { /* a table without that column: the id will do */ }
  return null;
}

/** What this request is, if it is one an admin has to agree to. */
async function asked(req: Request, path: string, orgId: number): Promise<Asked | null> {
  const method = req.method;
  if (method === 'GET' || method === 'HEAD') return null;
  let b: Record<string, unknown> | null = null;
  if (method !== 'DELETE' && (req.headers.get('content-type') ?? '').includes('json')) {
    try { b = (await req.clone().json()) as Record<string, unknown>; } catch { b = null; }
  }
  const action = typeof b?.action === 'string' ? b.action : null;
  const segs = path.split('/').filter(Boolean); // api, resource, …
  const resource = segs[1] ?? '';
  const url = new URL(req.url);
  const idText = [...segs].reverse().find((s) => /^\d+$/.test(s)) ?? b?.id ?? b?.entryId ?? url.searchParams.get('id');
  const id = idText !== undefined && idText !== null && /^\d+$/.test(String(idText)) ? Number(idText) : null;

  let kind: AdminCodeKind | null = null;
  let verb = '';
  if (method === 'PUT' && /^\/api\/invoices\/\d+$/.test(path)) { kind = 'invoice_edit'; verb = 'change'; }
  else if (action && UNDO_ACTION.test(action)) {
    kind = 'undo';
    verb = /unmatch|uncategori/.test(action) ? 'uncategorise' : /reverse/.test(action) ? 'reverse' : /reopen/.test(action) ? 'reopen' : /undo|take-back/.test(action) ? 'undo' : 'void';
  }
  // Reversing a journal entry: PATCH /api/journal { entryId, date, reason }.
  else if (method === 'PATCH' && path === '/api/journal' && b?.entryId !== undefined && !action) { kind = 'undo'; verb = 'reverse'; }
  else if (method === 'DELETE' && UNDO_PATHS.test(path) && !NOT_POSTED.test(path)) { kind = 'undo'; verb = 'delete'; }
  if (!kind) return null;

  const noun = action === 'void-credit-note' ? 'credit note' : NOUN[resource] ?? 'record';
  const number = await numberOf(orgId, resource, id);
  const label = `${verb} ${noun}${number ? ` ${number}` : id ? ` (record ${id})` : ''}`;
  return { kind, label, scope: sha(`${kind}|${method}|${path}|${action ?? ''}|${id ?? ''}`) };
}

async function admins(orgId: number) {
  return db.selectFrom('users').select(['id', 'name', 'email']).where('org_id', '=', orgId).where('role', '=', 'admin').where('is_active', '=', 1).execute();
}

const hashOf = (orgId: number, userId: number, scope: string, code: string) => sha(`${orgId}:${userId}:${scope}:${code}`);

/** Make a code for this request and tell the admins. Throws the 428 the browser answers by asking for it. */
async function issue(req: Request, user: SessionUser, a: Asked, why?: string): Promise<never> {
  const list = await admins(user.orgId);
  const names = list.map((u) => u.name).join(', ');
  const live = await db.selectFrom('admin_codes').select(['id', 'created_at'])
    .where('org_id', '=', user.orgId).where('requested_by_user_id', '=', user.userId).where('scope', '=', a.scope)
    .where('used_at', 'is', null).where('expires_at', '>', sql<Date>`NOW()`).where('attempts', '<', MAX_TRIES)
    .orderBy('id', 'desc').executeTakeFirst();
  // The same request sent twice within a minute (a double click, a retry) keeps the code already sent.
  const fresh = live && Date.now() - new Date(live.created_at).getTime() < 60_000;
  if (!fresh) {
    const recent = await db.selectFrom('admin_codes').select(({ fn }) => fn.countAll<number>().as('n'))
      .where('org_id', '=', user.orgId).where('requested_by_user_id', '=', user.userId)
      .where('created_at', '>', sql<Date>`DATE_SUB(NOW(), INTERVAL 15 MINUTE)`).executeTakeFirst();
    if (Number(recent?.n ?? 0) >= MAX_CODES_PER_QUARTER_HOUR) {
      throw new ApiError(429, 'Too many admin codes asked for. Wait a few minutes, or ask an admin to do this for you.', 'rate_limited');
    }
    // One code at a time for a request: an older one stops working.
    await db.updateTable('admin_codes').set({ expires_at: sql`NOW()` })
      .where('org_id', '=', user.orgId).where('requested_by_user_id', '=', user.userId).where('scope', '=', a.scope).where('used_at', 'is', null).execute();
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await db.insertInto('admin_codes').values({
      org_id: user.orgId, requested_by_user_id: user.userId, kind: a.kind, scope: a.scope, label: a.label.slice(0, 200),
      code_hash: hashOf(user.orgId, user.userId, a.scope, code), expires_at: sql`DATE_ADD(NOW(), INTERVAL ${MINUTES} MINUTE)` as never,
    }).execute();
    await notify(db, user.orgId, list.map((u) => u.id), {
      kind: 'admin_code',
      title: `Code ${code}: ${user.name} wants to ${a.label}`,
      body: `Give this code to ${user.name} only if you agree. It works once, for this action only, for ${MINUTES} minutes.`,
      href: '/accountant/audit-trail',
    });
    // By email too, when the server can send mail; the notification is there either way.
    if (mailStatus().configured) {
      const to = list.map((u) => u.email).filter(Boolean);
      if (to.length) {
        await sendMail(user.orgId, {
          to, subject: `Admin code: ${user.name} wants to ${a.label}`,
          text: `${user.name} is asking to ${a.label}.\n\nCode: ${code}\n\nGive this code to ${user.name} only if you agree. It works once, for this action only, for ${MINUTES} minutes. If you did not expect this, do nothing: without the code it cannot be done.`,
        }, { userId: user.userId }).catch(() => { /* mail trouble must not stop the code reaching the bell */ });
      }
    }
    await logAudit({
      orgId: user.orgId, actorUserId: user.userId, actorName: user.name, action: 'create', targetType: 'admin_code',
      targetLabel: a.label, detail: `${user.name} asked to ${a.label}: an admin code was sent to ${names || 'the admins'}`, ...auditMeta(req),
    });
  }
  throw new ApiError(428,
    why ?? `Only an admin can agree to this. A code has been sent to ${names || 'the admins'}: ask for it and type it here.`,
    'admin_code_required', { action: a.label, admins: names, minutes: String(MINUTES) });
}

/**
 * Called by route() before the handler. Passes for an admin, for a request
 * that is not one of these, and when the book has the rule switched off;
 * otherwise wants the code in X-Admin-Code, and asks for it (428) without one.
 */
export async function requireAdminCode(req: Request, path: string, user: SessionUser): Promise<void> {
  if (user.role === 'admin') return;
  const a = await asked(req, path, user.orgId);
  if (!a) return;
  const c = (await getPolicies(db, user.orgId)).controls;
  if (a.kind === 'undo' ? !c.adminCodeUndo : !c.adminCodeInvoiceEdit) return;
  // A company with no admin to ask could never go on: let it through (it cannot arise from the screens).
  if (!(await admins(user.orgId)).length) return;

  const given = (req.headers.get('x-admin-code') ?? '').replace(/\D/g, '');
  if (!given) await issue(req, user, a);

  const row = await db.selectFrom('admin_codes').select(['id', 'code_hash', 'attempts'])
    .where('org_id', '=', user.orgId).where('requested_by_user_id', '=', user.userId).where('scope', '=', a.scope)
    .where('used_at', 'is', null).where('expires_at', '>', sql<Date>`NOW()`).orderBy('id', 'desc').executeTakeFirst();
  if (!row || row.attempts >= MAX_TRIES) {
    await issue(req, user, a, 'That code is no longer good (it lasts ten minutes and five tries). A new one has been sent to the admins: ask for it and type it here.');
    return;
  }
  if (row.code_hash !== hashOf(user.orgId, user.userId, a.scope, given)) {
    await db.updateTable('admin_codes').set({ attempts: row.attempts + 1 }).where('id', '=', row.id).execute();
    const left = MAX_TRIES - row.attempts - 1;
    throw new ApiError(428, `That code is not right. Check it with the admin and type it again${left > 0 ? ` (${left} ${left === 1 ? 'try' : 'tries'} left)` : ''}.`, 'admin_code_wrong', { action: a.label });
  }
  await db.updateTable('admin_codes').set({ used_at: sql`NOW()` }).where('id', '=', row.id).execute();
  const names = (await admins(user.orgId)).map((u) => u.name).join(', ');
  await logAudit({
    orgId: user.orgId, actorUserId: user.userId, actorName: user.name, action: 'approve', targetType: 'admin_code', targetId: row.id,
    targetLabel: a.label, detail: `${user.name} may ${a.label}: the admin code was given (sent to ${names})`, ...auditMeta(req),
  });
}
