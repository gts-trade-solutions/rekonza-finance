import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Admin approval: undoing or changing posted work waits for an admin.
//
// The client (2026-11-28): "once the user reversed, it should go to admin"; "the
// user can create the invoice and the admin will modify; if they need a
// modification in an invoice they need approval from admin"; and then, on how
// the admin answers: "not an OTP: the admin needs two buttons, Approve and
// Reject".
//
// So when someone who is not an admin
//   · undoes posted work: reverses a journal, uncategorises a bank line, voids
//     or deletes a document, reopens a pay run, undoes a disposal; or
//   · changes a saved invoice,
// nothing happens yet. The request is kept, exactly as it was sent, and the
// admins are told (the bell, with Approve and Reject; and Approvals → Requests
// to undo or change). Approve carries out that same request, as the person who
// asked, with their own rights checked again; Reject leaves everything as it
// was. The person is told the outcome either way, and the audit trail keeps who
// asked, who decided and what happened. Admins themselves act directly.
//
// It is checked in route() itself (lib/server/http.ts), from the method, the
// path and the body's `action`, so every screen is covered without each one
// knowing about it, as the change-reason rule is. Either half can be switched
// off in Settings → Controls.
//
// Carrying it out: the approved request is sent again to this same server with
// a one-time pass (X-Admin-Approval) that stands in for the person's sign-in.
// The pass is random, kept only as a hash, lives for one minute, works once,
// and only for that exact method, address and body.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash, randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import { db } from '../db';
import { ApiError, badRequest, conflict, forbidden, notFound } from '../http';
import { logAudit, auditMeta } from '../audit';
import { getPolicies } from './org-settings';
import { notify } from './notifications';
import type { SessionUser } from '../auth/session';
import type { RoleName } from '../../types';
import type { CustomPermissions } from '../../rbac';

export type AdminRequestKind = 'undo' | 'invoice_edit';
interface Asked { kind: AdminRequestKind; label: string; scope: string; body: string | null }

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
const PASS_HEADER = 'x-admin-approval';

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
export async function classify(req: Request, path: string, orgId: number): Promise<Asked | null> {
  const method = req.method;
  if (method === 'GET' || method === 'HEAD') return null;
  const isJson = (req.headers.get('content-type') ?? '').includes('json');
  const text = method === 'DELETE' ? null : isJson ? await req.clone().text() : null;
  let b: Record<string, unknown> | null = null;
  if (text) { try { b = JSON.parse(text) as Record<string, unknown>; } catch { b = null; } }
  const action = typeof b?.action === 'string' ? b.action : null;
  const url = new URL(req.url);
  const segs = path.split('/').filter(Boolean); // api, resource, …
  const resource = segs[1] ?? '';
  const idText = [...segs].reverse().find((s) => /^\d+$/.test(s)) ?? b?.id ?? b?.entryId ?? url.searchParams.get('id');
  const id = idText !== undefined && idText !== null && /^\d+$/.test(String(idText)) ? Number(idText) : null;

  let kind: AdminRequestKind | null = null;
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
  // A file upload is not kept to be sent again: those routes add records, they do not undo them.
  if (method !== 'DELETE' && !isJson && (req.headers.get('content-type') ?? '').length > 0) return null;

  const noun = action === 'void-credit-note' ? 'credit note' : NOUN[resource] ?? 'record';
  const number = await numberOf(orgId, resource, id);
  const label = `${verb} ${noun}${number ? ` ${number}` : id ? ` (record ${id})` : ''}`;
  return { kind, label, scope: sha(`${kind}|${method}|${path}${url.search}|${action ?? ''}|${id ?? ''}`), body: text };
}

async function admins(orgId: number) {
  return db.selectFrom('users').select(['id', 'name']).where('org_id', '=', orgId).where('role', '=', 'admin').where('is_active', '=', 1).execute();
}

/**
 * Called by route() before the handler. Passes for an admin, for a request
 * that is not one of these, and when the book has the rule switched off;
 * otherwise keeps the request for an admin and answers 409 sent_for_approval.
 */
export async function requireAdminApproval(req: Request, path: string, user: SessionUser): Promise<void> {
  if (user.role === 'admin') return;
  const a = await classify(req, path, user.orgId);
  if (!a) return;
  const c = (await getPolicies(db, user.orgId)).controls;
  if (a.kind === 'undo' ? !c.adminApprovalUndo : !c.adminApprovalInvoiceEdit) return;
  const list = await admins(user.orgId);
  // A company with no admin to ask could never go on: let it through (it cannot arise from the screens).
  if (!list.length) return;
  const names = list.map((u) => u.name).join(', ');

  const waiting = await db.selectFrom('admin_requests').select('id')
    .where('org_id', '=', user.orgId).where('requested_by_user_id', '=', user.userId).where('scope', '=', a.scope).where('status', '=', 'pending')
    .executeTakeFirst();
  let id = waiting ? Number(waiting.id) : 0;
  if (!waiting) {
    // The reason typed: in the reverse or void window it travels in the body, on a delete in ?reason=,
    // and a book that asks a reason of every change sends it as X-Change-Reason.
    const url = new URL(req.url);
    let bodyReason: string | null = null;
    if (a.body) { try { const r = (JSON.parse(a.body) as { reason?: unknown }).reason; bodyReason = typeof r === 'string' && r.trim() ? r.trim() : null; } catch { /* not JSON */ } }
    const reasonRaw = req.headers.get('x-change-reason');
    let headerReason: string | null = null;
    if (reasonRaw) { try { headerReason = decodeURIComponent(reasonRaw); } catch { headerReason = reasonRaw; } }
    const reason = bodyReason ?? (url.searchParams.get('reason')?.trim() || null) ?? headerReason;
    // Undoing posted work says why, before it goes to an admin: the admin decides on the reason,
    // and the reversal carries it once approved (the browser asks for it on a 428).
    if (a.kind === 'undo' && !reason) {
      throw new ApiError(428, 'Say why you are undoing it. The admin who approves it sees the reason, and it is kept with the reversal.', 'reason_required');
    }
    const r = await db.insertInto('admin_requests').values({
      org_id: user.orgId, requested_by_user_id: user.userId, kind: a.kind, label: a.label.slice(0, 200),
      method: req.method, path: `${path}${url.search}`.slice(0, 500), body: a.body, change_reason: reason?.slice(0, 500) ?? null, scope: a.scope,
    }).executeTakeFirstOrThrow();
    id = Number(r.insertId);
    await notify(db, user.orgId, list.map((u) => u.id), {
      kind: 'admin_request',
      title: `${user.name} asks to ${a.label}`,
      body: `${reason ? `Reason: ${reason}. ` : ''}Approve to carry it out, or Reject to leave it as it is.`,
      href: `/approvals?request=${id}`,
    });
    await logAudit({
      orgId: user.orgId, actorUserId: user.userId, actorName: user.name, action: 'create', targetType: 'admin_request', targetId: id,
      targetLabel: a.label, detail: `${user.name} asked to ${a.label}: sent to ${names} for approval`, reason, ...auditMeta(req),
    });
  }
  throw new ApiError(409,
    `Sent to ${names} for approval. It will be done as soon as an admin approves it; you will be told either way.`,
    'sent_for_approval', { requestId: String(id), action: a.label, admins: names });
}

/**
 * The person an approved request is being carried out for, when route() is
 * given its one-time pass instead of a sign-in. Null for anything else.
 */
export async function approvedRequestUser(req: Request, path: string): Promise<SessionUser | null> {
  const pass = req.headers.get(PASS_HEADER);
  if (!pass) return null;
  const r = await db.selectFrom('admin_requests').select(['id', 'org_id', 'requested_by_user_id', 'method', 'path', 'body'])
    .where('exec_token_hash', '=', sha(pass)).where('status', '=', 'approved').where('exec_expires_at', '>', sql<Date>`NOW()`)
    .executeTakeFirst();
  if (!r) return null;
  const url = new URL(req.url);
  if (r.method !== req.method || r.path !== `${path}${url.search}`) return null;
  const body = req.method === 'DELETE' ? null : await req.clone().text();
  if ((r.body ?? '') !== (body ?? '')) return null;
  // Used once: the pass is spent as it is accepted.
  const spent = await db.updateTable('admin_requests').set({ exec_token_hash: null }).where('id', '=', r.id).where('exec_token_hash', '=', sha(pass)).executeTakeFirst();
  if (!Number(spent.numUpdatedRows)) return null;
  const u = await db.selectFrom('users').leftJoin('custom_roles', 'custom_roles.id', 'users.custom_role_id')
    .select(['users.id', 'users.org_id', 'users.name', 'users.email', 'users.role', 'users.home_branch_id', 'users.is_active', 'custom_roles.name as custom_role_name', 'custom_roles.permissions'])
    .where('users.id', '=', r.requested_by_user_id).where('users.org_id', '=', r.org_id).executeTakeFirst();
  if (!u || !u.is_active) return null;
  const branch = u.home_branch_id ?? (await db.selectFrom('branches').select('id').where('org_id', '=', u.org_id).orderBy('is_primary', 'desc').limit(1).executeTakeFirst())?.id ?? null;
  return {
    userId: Number(u.id), orgId: Number(u.org_id), name: u.name, email: u.email, role: u.role as RoleName,
    homeBranchId: branch ? Number(branch) : null, activeBranchId: branch ? Number(branch) : null,
    permissions: u.role !== 'admin' && u.permissions ? (typeof u.permissions === 'string' ? JSON.parse(u.permissions) : u.permissions) as CustomPermissions : null,
    customRoleName: u.custom_role_name ?? null,
  };
}

export interface AdminRequestRow {
  id: string; kind: AdminRequestKind; label: string; status: string; requestedBy: string; requestedById: string;
  reason: string | null; at: string; decidedBy: string | null; decidedAt: string | null; note: string | null; result: string | null;
}

/** For an admin: every request of the book (waiting first). For anyone else: their own. */
export async function listRequests(orgId: number, user: SessionUser): Promise<AdminRequestRow[]> {
  const rows = await db.selectFrom('admin_requests as r').innerJoin('users as u', 'u.id', 'r.requested_by_user_id')
    .leftJoin('users as d', 'd.id', 'r.decided_by_user_id')
    .select(['r.id', 'r.kind', 'r.label', 'r.status', 'r.requested_by_user_id', 'u.name as requested_by', 'r.change_reason', 'r.created_at',
      'd.name as decided_by', 'r.decided_at', 'r.decision_note', 'r.result_message'])
    .where('r.org_id', '=', orgId)
    .$if(user.role !== 'admin', (q) => q.where('r.requested_by_user_id', '=', user.userId))
    .orderBy(sql`r.status = 'pending'`, 'desc').orderBy('r.id', 'desc').limit(100).execute();
  const iso = (v: unknown) => (v ? new Date(String(v instanceof Date ? v.toISOString() : v)).toISOString() : null);
  return rows.map((r) => ({
    id: String(r.id), kind: r.kind as AdminRequestKind, label: r.label, status: r.status, requestedBy: r.requested_by, requestedById: String(r.requested_by_user_id),
    reason: r.change_reason, at: iso(r.created_at)!, decidedBy: r.decided_by ?? null, decidedAt: iso(r.decided_at), note: r.decision_note, result: r.result_message,
  }));
}

/** Carries out an approved request: sends it again to this server with its one-time pass. */
export type Executor = (r: { method: string; path: string; body: string | null; changeReason: string | null; pass: string }) => Promise<{ status: number; message: string | null }>;

export function httpExecutor(origin: string): Executor {
  return async (r) => {
    const res = await fetch(`${origin}${r.path}`, {
      method: r.method,
      headers: {
        ...(r.body ? { 'Content-Type': 'application/json' } : {}),
        [PASS_HEADER]: r.pass,
        ...(r.changeReason ? { 'X-Change-Reason': encodeURIComponent(r.changeReason) } : {}),
      },
      body: r.body ?? undefined,
      signal: AbortSignal.timeout(60_000),
    });
    let message: string | null = null;
    if (!res.ok) {
      try { message = ((await res.json()) as { error?: string }).error ?? null; } catch { message = null; }
    }
    return { status: res.status, message: message ?? (res.ok ? null : `It could not be done (${res.status}).`) };
  };
}

/** An admin's Approve or Reject. Approve carries the request out at once. */
export async function decide(
  req: Request, admin: SessionUser, id: number, decision: 'approve' | 'reject', note: string | null, execute: Executor,
): Promise<{ status: string; message: string | null }> {
  if (admin.role !== 'admin') throw forbidden('Only an admin approves or rejects these requests.');
  const r = await db.selectFrom('admin_requests as r').innerJoin('users as u', 'u.id', 'r.requested_by_user_id')
    .select(['r.id', 'r.org_id', 'r.requested_by_user_id', 'r.label', 'r.status', 'r.method', 'r.path', 'r.body', 'r.change_reason', 'u.name as requested_by'])
    .where('r.id', '=', id).where('r.org_id', '=', admin.orgId).executeTakeFirst();
  if (!r) throw notFound('That request was not found.');
  if (r.status !== 'pending') throw conflict(`This request was already ${r.status === 'done' ? 'approved and done' : r.status}.`);
  if (Number(r.requested_by_user_id) === admin.userId) throw badRequest('You cannot decide your own request.');
  const trimmed = note?.trim().slice(0, 500) || null;

  if (decision === 'reject') {
    const upd = await db.updateTable('admin_requests').set({ status: 'rejected', decided_by_user_id: admin.userId, decided_at: sql`NOW()` as never, decision_note: trimmed })
      .where('id', '=', r.id).where('status', '=', 'pending').executeTakeFirst();
    if (!Number(upd.numUpdatedRows)) throw conflict('This request was decided a moment ago by someone else.');
    await notify(db, admin.orgId, [Number(r.requested_by_user_id)], {
      kind: 'admin_request_result', title: `Rejected: ${r.label}`,
      body: `${admin.name} rejected your request${trimmed ? `: ${trimmed}` : ''}. Nothing was changed.`, href: '/approvals',
    });
    await logAudit({
      orgId: admin.orgId, actorUserId: admin.userId, actorName: admin.name, action: 'reject', targetType: 'admin_request', targetId: r.id,
      targetLabel: r.label, detail: `${admin.name} rejected ${r.requested_by}'s request to ${r.label}${trimmed ? `: ${trimmed}` : ''}`, ...auditMeta(req),
    });
    return { status: 'rejected', message: null };
  }

  // Approve: claim it, hand out a one-time pass, and carry it out as the person who asked.
  const pass = randomBytes(32).toString('base64url');
  const claimed = await db.updateTable('admin_requests').set({
    status: 'approved', decided_by_user_id: admin.userId, decided_at: sql`NOW()` as never, decision_note: trimmed,
    exec_token_hash: sha(pass), exec_expires_at: sql`DATE_ADD(NOW(), INTERVAL 1 MINUTE)` as never,
  }).where('id', '=', r.id).where('status', '=', 'pending').executeTakeFirst();
  if (!Number(claimed.numUpdatedRows)) throw conflict('This request was decided a moment ago by someone else.');

  let result: { status: number; message: string | null };
  try {
    result = await execute({ method: r.method, path: r.path, body: r.body, changeReason: r.change_reason, pass });
  } catch (e) {
    result = { status: 0, message: `It could not be carried out: ${e instanceof Error ? e.message : String(e)}` };
  }
  const ok = result.status >= 200 && result.status < 300;
  await db.updateTable('admin_requests').set({
    status: ok ? 'done' : 'failed', result_status: result.status, result_message: result.message?.slice(0, 500) ?? null,
    exec_token_hash: null, exec_expires_at: null,
  }).where('id', '=', r.id).execute();
  await notify(db, admin.orgId, [Number(r.requested_by_user_id)], ok
    ? { kind: 'admin_request_result', title: `Approved and done: ${r.label}`, body: `${admin.name} approved your request${trimmed ? `: ${trimmed}` : ''}.`, href: '/approvals' }
    : { kind: 'admin_request_result', title: `Approved, but not done: ${r.label}`, body: `${admin.name} approved it, but the books refused: ${result.message ?? 'unknown reason'}`, href: '/approvals' });
  await logAudit({
    orgId: admin.orgId, actorUserId: admin.userId, actorName: admin.name, action: 'approve', targetType: 'admin_request', targetId: r.id,
    targetLabel: r.label, detail: ok
      ? `${admin.name} approved ${r.requested_by}'s request to ${r.label}; it was carried out`
      : `${admin.name} approved ${r.requested_by}'s request to ${r.label}, but it could not be done: ${result.message ?? ''}`,
    ...auditMeta(req),
  });
  return { status: ok ? 'done' : 'failed', message: result.message };
}

/** The person withdraws their own request while it waits. */
export async function withdraw(req: Request, user: SessionUser, id: number) {
  const upd = await db.updateTable('admin_requests').set({ status: 'withdrawn' })
    .where('id', '=', id).where('org_id', '=', user.orgId).where('requested_by_user_id', '=', user.userId).where('status', '=', 'pending').executeTakeFirst();
  if (!Number(upd.numUpdatedRows)) throw conflict('Only a request of your own that is still waiting can be withdrawn.');
  await logAudit({ orgId: user.orgId, actorUserId: user.userId, actorName: user.name, action: 'update', targetType: 'admin_request', targetId: id, detail: `${user.name} withdrew request ${id}`, ...auditMeta(req) });
}
