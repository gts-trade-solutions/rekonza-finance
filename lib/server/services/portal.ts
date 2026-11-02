import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// The customer and vendor portal (migration 091).
//
// A customer or vendor opens their own account from a link the business sends:
// no password, nothing to install. A customer sees their invoices (and pays
// them online when the business takes online payment), accepts or declines
// quotes, and reads their statement. A vendor sees their purchase orders,
// bills and payments, their statement, and can send in a bill, which lands
// with the purchasing team as a file to enter.
//
// The link carries a random token of which only the hash is kept; it lapses
// on its date and can be withdrawn. Everything is read for that one contact:
// a token never reaches another party's records.
//
// Made to work as Zoho Books' portal does (migration 094): sign in by email
// with a one-time code (portal-login.ts); a customer also sees sales orders,
// retainers, credit notes, projects and shared documents, comments on any of
// their documents and keeps their own address and phone up to date; a vendor
// accepts or declines purchase orders, sees vendor credits, and asks for a
// change of bank details — which the business must approve, never applied on
// its own. What portal users do is logged for the Portal activities report.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash, randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import type { Executor, Trx } from '../db';
import { toPaiseFromSql } from '../money-sql';
import { badRequest, conflict, notFound } from '../http';
import { partyStatement } from '../reports/party-statement';
import { seal, unseal } from '../crypto/fields';

export type PortalSide = 'customer' | 'vendor';
const hash = (t: string) => createHash('sha256').update(t).digest('hex');

export async function createPortalLink(trx: Trx, orgId: number, userId: number | null, input: { contactId: number; side: PortalSide; days?: number; email?: string | null }) {
  const c = await trx.selectFrom('contacts').select(['id', 'kind', 'email']).where('id', '=', input.contactId).where('org_id', '=', orgId).executeTakeFirst();
  if (!c) throw notFound('That contact does not exist.');
  if (input.side === 'customer' && c.kind === 'vendor') throw badRequest('That contact is a vendor; give them vendor access.');
  if (input.side === 'vendor' && c.kind === 'customer') throw badRequest('That contact is a customer; give them customer access.');
  const token = randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + Math.min(Math.max(input.days ?? 90, 1), 365) * 86_400_000);
  await trx.insertInto('portal_access').values({
    org_id: orgId, contact_id: c.id, side: input.side, token_hash: hash(token), email: input.email ?? c.email ?? null,
    expires_at: expiresAt, created_by_user_id: userId,
  }).execute();
  return { path: `/portal/${token}`, expiresAt: expiresAt.toISOString() };
}

export async function openPortal(ex: Executor, token: string): Promise<{ orgId: number; contactId: number; side: PortalSide } | null> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const row = await ex.selectFrom('portal_access').select(['id', 'org_id', 'contact_id', 'side', 'expires_at', 'revoked_at'])
    .where('token_hash', '=', hash(token)).executeTakeFirst();
  if (!row || row.revoked_at || new Date(row.expires_at) < new Date()) return null;
  await ex.updateTable('portal_access').set((eb) => ({ opens: eb('opens', '+', 1), last_opened_at: new Date() })).where('id', '=', row.id).execute();
  return { orgId: row.org_id, contactId: row.contact_id, side: row.side };
}

export async function listPortalLinks(ex: Executor, orgId: number, contactId: number) {
  const rows = await ex.selectFrom('portal_access').selectAll().where('org_id', '=', orgId).where('contact_id', '=', contactId).orderBy('id', 'desc').limit(20).execute();
  return rows.map((r) => ({
    id: String(r.id), side: r.side, email: r.email, createdAt: new Date(r.created_at).toISOString(), expiresAt: new Date(r.expires_at).toISOString(),
    live: !r.revoked_at && new Date(r.expires_at) > new Date(), opens: r.opens, lastOpenedAt: r.last_opened_at ? new Date(r.last_opened_at).toISOString() : null,
  }));
}

export async function revokePortalLinks(trx: Trx, orgId: number, contactId: number) {
  const r = await trx.updateTable('portal_access').set({ revoked_at: new Date() })
    .where('org_id', '=', orgId).where('contact_id', '=', contactId).where('revoked_at', 'is', null).executeTakeFirst();
  return Number(r.numUpdatedRows);
}

const day = (v: unknown) => String(v).slice(0, 10);
const fyStart = (today: string) => `${Number(today.slice(0, 4)) - (Number(today.slice(5, 7)) < 4 ? 1 : 0)}-04-01`;

/** Everything a contact sees on their portal. */
export async function portalOverview(ex: Executor, orgId: number, contactId: number, side: PortalSide) {
  const today = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
  const [org, contact, branch] = await Promise.all([
    ex.selectFrom('organizations').select(['name', 'legal_name', 'email', 'phone', 'logo_file_id']).where('id', '=', orgId).executeTakeFirstOrThrow(),
    ex.selectFrom('contacts').select(['display_name', 'gstin']).where('id', '=', contactId).executeTakeFirstOrThrow(),
    ex.selectFrom('branches').select('gstin').where('org_id', '=', orgId).orderBy('is_primary', 'desc').executeTakeFirst(),
  ]);
  const statement = await partyStatement(ex, orgId, contactId, side, fyStart(today), today);
  const base = {
    side,
    business: { name: org.legal_name || org.name, email: org.email, phone: org.phone, gstin: branch?.gstin ?? null },
    contact: { name: contact.display_name, gstin: contact.gstin },
    // Without the source links: those are the business's own screens.
    statement: {
      from: statement.from, to: statement.to, openingPaise: statement.openingPaise, closingPaise: statement.closingPaise,
      lines: statement.lines.map((l) => ({ date: l.date, kind: l.kind, number: l.number, detail: l.detail, chargePaise: l.chargePaise, paymentPaise: l.paymentPaise, balancePaise: l.balancePaise })),
    },
  };
  if (side === 'customer') {
    const [invoices, quotes, payments, gateway] = await Promise.all([
      ex.selectFrom('invoices').select(['id', 'number', 'doc_kind', 'invoice_date', 'due_date', 'total', 'amount_paid', 'status'])
        .where('org_id', '=', orgId).where('customer_id', '=', contactId).where('status', 'not in', ['draft', 'void'])
        .orderBy('invoice_date', 'desc').limit(100).execute(),
      ex.selectFrom('estimates').select(['id', 'number', 'estimate_date', 'expiry_date', 'total', 'status'])
        .where('org_id', '=', orgId).where('customer_id', '=', contactId).where('status', 'in', ['sent', 'accepted', 'declined', 'expired', 'converted'])
        .orderBy('estimate_date', 'desc').limit(50).execute(),
      ex.selectFrom('payments').select(['id', 'number', 'payment_date', 'amount', 'mode']).where('org_id', '=', orgId).where('contact_id', '=', contactId)
        .where('kind', '=', 'received').where('status', '<>', 'void').orderBy('payment_date', 'desc').limit(50).execute(),
      ex.selectFrom('payment_gateways').select('id').where('org_id', '=', orgId).where('is_active', '=', 1).executeTakeFirst(),
    ]);
    const extras = await portalExtras(ex, orgId, contactId, 'customer', [
      ...invoices.map((i) => ({ type: 'invoice', id: String(i.id) })), ...quotes.map((q) => ({ type: 'estimate', id: String(q.id) })),
    ]);
    return {
      ...base,
      ...extras,
      side: 'customer' as const,
      canPayOnline: !!gateway,
      invoices: invoices.map((i) => ({
        id: String(i.id), number: i.number, kind: i.doc_kind, date: day(i.invoice_date), dueDate: day(i.due_date),
        totalPaise: toPaiseFromSql(i.total), balancePaise: toPaiseFromSql(i.total) - toPaiseFromSql(i.amount_paid), status: i.status,
        overdue: day(i.due_date) < today && toPaiseFromSql(i.total) > toPaiseFromSql(i.amount_paid),
      })),
      quotes: quotes.map((q) => ({ id: String(q.id), number: q.number, date: day(q.estimate_date), validUntil: day(q.expiry_date), totalPaise: toPaiseFromSql(q.total), status: q.status })),
      payments: payments.map((p) => ({ id: String(p.id), number: p.number, date: day(p.payment_date), amountPaise: toPaiseFromSql(p.amount), mode: p.mode })),
    };
  }
  const [orders, bills, payments] = await Promise.all([
    ex.selectFrom('purchase_orders').select(['id', 'number', 'order_date', 'expected_date', 'total', 'status', 'vendor_response', 'vendor_response_note'])
      .where('org_id', '=', orgId).where('vendor_id', '=', contactId).where('status', '<>', 'draft').orderBy('order_date', 'desc').limit(50).execute(),
    ex.selectFrom('bills').select(['id', 'internal_no', 'vendor_invoice_no', 'bill_date', 'due_date', 'total', 'amount_paid', 'status'])
      .where('org_id', '=', orgId).where('vendor_id', '=', contactId).where('status', 'not in', ['draft', 'void']).orderBy('bill_date', 'desc').limit(100).execute(),
    ex.selectFrom('payments').select(['id', 'number', 'payment_date', 'amount', 'tds_amount', 'mode', 'reference']).where('org_id', '=', orgId).where('contact_id', '=', contactId)
      .where('kind', '=', 'made').where('status', '<>', 'void').orderBy('payment_date', 'desc').limit(50).execute(),
  ]);
  const extras = await portalExtras(ex, orgId, contactId, 'vendor', [
    ...orders.map((o) => ({ type: 'purchase_order', id: String(o.id) })), ...bills.map((b) => ({ type: 'bill', id: String(b.id) })),
  ]);
  return {
    ...base,
    ...extras,
    side: 'vendor' as const,
    orders: orders.map((o) => ({ id: String(o.id), number: o.number, date: day(o.order_date), expected: o.expected_date ? day(o.expected_date) : null, totalPaise: toPaiseFromSql(o.total), status: o.status, response: o.vendor_response, responseNote: o.vendor_response_note })),
    bills: bills.map((b) => ({
      id: String(b.id), ourNumber: b.internal_no, yourNumber: b.vendor_invoice_no, date: day(b.bill_date), dueDate: day(b.due_date),
      totalPaise: toPaiseFromSql(b.total), balancePaise: toPaiseFromSql(b.total) - toPaiseFromSql(b.amount_paid), status: b.status,
    })),
    payments: payments.map((p) => ({ id: String(p.id), number: p.number, date: day(p.payment_date), amountPaise: toPaiseFromSql(p.amount), tdsPaise: toPaiseFromSql(p.tds_amount), mode: p.mode, reference: p.reference })),
  };
}

/** A customer accepting or declining a quote from the portal. Only a quote that was sent and still stands can be answered. */
export async function answerQuote(trx: Trx, orgId: number, contactId: number, estimateId: number, decision: 'accepted' | 'declined') {
  const q = await trx.selectFrom('estimates').select(['id', 'number', 'status', 'expiry_date', 'customer_id']).where('id', '=', estimateId).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!q || q.customer_id !== contactId) throw notFound('That quote is not yours.');
  if (q.status !== 'sent') throw conflict(`That quote is already ${q.status}.`);
  const today = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
  if (day(q.expiry_date) < today) throw conflict('That quote has expired. Ask for a fresh one.');
  await trx.updateTable('estimates').set({ status: decision }).where('id', '=', q.id).execute();
  return { number: q.number };
}

/** Which documents a contact may open from the portal. */
export async function ownsInvoice(ex: Executor, orgId: number, contactId: number, invoiceId: number) {
  const r = await sql<{ n: number }>`SELECT COUNT(*) AS n FROM invoices WHERE id = ${invoiceId} AND org_id = ${orgId} AND customer_id = ${contactId} AND status NOT IN ('draft', 'void')`.execute(ex);
  return Number(r.rows[0]?.n ?? 0) > 0;
}

// ── Zoho's portal, the rest of it (migration 094) ────────────────────────────

/** Files a business shares with a contact sit in this folder on the contact; uploads land in the other. */
export const PORTAL_SHARED_FOLDER = 'Shared on the portal';
export const PORTAL_UPLOAD_FOLDER = 'From the portal';

/** The documents a portal user may comment on, and whose they are. */
const OWNED: Record<string, { table: string; owner: 'customer_id' | 'vendor_id'; side: PortalSide; label: string; numberCol: string }> = {
  invoice: { table: 'invoices', owner: 'customer_id', side: 'customer', label: 'invoice', numberCol: 'number' },
  estimate: { table: 'estimates', owner: 'customer_id', side: 'customer', label: 'quote', numberCol: 'number' },
  sales_order: { table: 'sales_orders', owner: 'customer_id', side: 'customer', label: 'sales order', numberCol: 'number' },
  credit_note: { table: 'credit_notes', owner: 'customer_id', side: 'customer', label: 'credit note', numberCol: 'number' },
  purchase_order: { table: 'purchase_orders', owner: 'vendor_id', side: 'vendor', label: 'purchase order', numberCol: 'number' },
  bill: { table: 'bills', owner: 'vendor_id', side: 'vendor', label: 'bill', numberCol: 'vendor_invoice_no' },
  vendor_credit: { table: 'vendor_credits', owner: 'vendor_id', side: 'vendor', label: 'vendor credit', numberCol: 'number' },
};
export const PORTAL_COMMENT_TYPES = Object.keys(OWNED) as [string, ...string[]];

export async function logPortalActivity(
  ex: Executor,
  a: { orgId: number; contactId: number; side: PortalSide; action: string; targetType?: string | null; targetId?: number | null; detail?: string | null; ip?: string | null },
) {
  await ex.insertInto('portal_activity').values({
    org_id: a.orgId, contact_id: a.contactId, side: a.side, action: a.action.slice(0, 40),
    target_type: a.targetType ?? null, target_id: a.targetId ?? null, detail: a.detail?.slice(0, 300) ?? null, ip: a.ip ?? null,
  }).execute();
}

/** What the portal shows beyond the core: the other documents, files, profile and comments. */
export async function portalExtras(ex: Executor, orgId: number, contactId: number, side: PortalSide, refs: { type: string; id: string }[]) {
  const c = await ex.selectFrom('contacts')
    .select(['email', 'phone', 'billing_address', 'billing_city', 'billing_pincode', 'shipping_address', 'shipping_city', 'shipping_pincode',
      'bank_name', 'bank_account_name', 'bank_account_no', 'bank_ifsc'])
    .where('id', '=', contactId).where('org_id', '=', orgId).executeTakeFirstOrThrow();
  const files = await ex.selectFrom('files').select(['id', 'filename', 'content_type', 'size_bytes', 'folder', 'created_at'])
    .where('org_id', '=', orgId).where('attached_to_type', '=', 'contact').where('attached_to_id', '=', contactId)
    .where('deleted_at', 'is', null).where('folder', 'in', [PORTAL_SHARED_FOLDER, PORTAL_UPLOAD_FOLDER])
    .orderBy('created_at', 'desc').limit(50).execute();
  const profile = {
    email: c.email, phone: c.phone,
    billingAddress: c.billing_address, billingCity: c.billing_city, billingPincode: c.billing_pincode,
    shippingAddress: c.shipping_address, shippingCity: c.shipping_city, shippingPincode: c.shipping_pincode,
  };
  const documents = files.map((f) => ({
    id: String(f.id), filename: f.filename, contentType: f.content_type, sizeBytes: Number(f.size_bytes),
    fromYou: f.folder === PORTAL_UPLOAD_FOLDER, at: new Date(f.created_at).toISOString(),
  }));

  // The portal conversation on the contact's own documents, oldest first under
  // each: what they wrote and the business's replies, never its staff notes.
  const loadComments = async (all: { type: string; id: string }[]) => {
    const comments: Record<string, { author: string; body: string; at: string; fromPortal: boolean }[]> = {};
    const byType = new Map<string, number[]>();
    for (const r of all) if (OWNED[r.type]) byType.set(r.type, [...(byType.get(r.type) ?? []), Number(r.id)]);
    for (const [type, ids] of byType) {
      if (!ids.length) continue;
      const rows = await ex.selectFrom('comments').select(['target_id', 'author_name', 'body', 'created_at', 'user_id'])
        .where('org_id', '=', orgId).where('target_type', '=', type).where('target_id', 'in', ids).where('portal_visible', '=', 1).orderBy('created_at').execute();
      for (const r of rows) {
        const k = `${type}:${r.target_id}`;
        (comments[k] ??= []).push({ author: r.author_name, body: r.body, at: new Date(r.created_at).toISOString(), fromPortal: r.user_id === null });
      }
    }
    return comments;
  };

  if (side === 'customer') {
    const [salesOrders, retainers, creditNotes, projects] = await Promise.all([
      ex.selectFrom('sales_orders').select(['id', 'number', 'order_date', 'expected_ship_date', 'total', 'invoiced_amount', 'status'])
        .where('org_id', '=', orgId).where('customer_id', '=', contactId).where('status', '<>', 'cancelled').orderBy('order_date', 'desc').limit(50).execute(),
      ex.selectFrom('retainer_invoices').select(['id', 'number', 'retainer_date', 'amount', 'amount_paid', 'applied_amount', 'status', 'description'])
        .where('org_id', '=', orgId).where('customer_id', '=', contactId).where('status', 'not in', ['draft', 'void']).orderBy('retainer_date', 'desc').limit(50).execute(),
      ex.selectFrom('credit_notes').select(['id', 'number', 'note_date', 'total', 'applied_amount', 'status', 'reason'])
        .where('org_id', '=', orgId).where('customer_id', '=', contactId).where('status', '<>', 'void').orderBy('note_date', 'desc').limit(50).execute(),
      sql<{ id: number; name: string; status: string; billing_method: string; minutes: string; billable: string; billed: string }>`
        SELECT p.id, p.name, p.status, p.billing_method,
               COALESCE(SUM(t.minutes), 0) AS minutes,
               COALESCE(SUM(CASE WHEN t.billable = 1 THEN t.minutes ELSE 0 END), 0) AS billable,
               COALESCE(SUM(CASE WHEN t.invoice_id IS NOT NULL THEN t.minutes ELSE 0 END), 0) AS billed
          FROM projects p LEFT JOIN time_entries t ON t.project_id = p.id
         WHERE p.org_id = ${orgId} AND p.customer_id = ${contactId}
         GROUP BY p.id, p.name, p.status, p.billing_method ORDER BY p.name`.execute(ex),
    ]);
    const comments = await loadComments([...refs, ...salesOrders.map((o) => ({ type: 'sales_order', id: String(o.id) })), ...creditNotes.map((n) => ({ type: 'credit_note', id: String(n.id) }))]);
    return {
      profile, documents, comments,
      salesOrders: salesOrders.map((o) => ({ id: String(o.id), number: o.number, date: day(o.order_date), expected: o.expected_ship_date ? day(o.expected_ship_date) : null, totalPaise: toPaiseFromSql(o.total), invoicedPaise: toPaiseFromSql(o.invoiced_amount), status: o.status })),
      retainers: retainers.map((r) => ({ id: String(r.id), number: r.number, date: day(r.retainer_date), amountPaise: toPaiseFromSql(r.amount), paidPaise: toPaiseFromSql(r.amount_paid), appliedPaise: toPaiseFromSql(r.applied_amount), status: r.status, description: r.description })),
      creditNotes: creditNotes.map((n) => ({ id: String(n.id), number: n.number, date: day(n.note_date), totalPaise: toPaiseFromSql(n.total), unusedPaise: toPaiseFromSql(n.total) - toPaiseFromSql(n.applied_amount), status: n.status, reason: n.reason })),
      projects: projects.rows.map((p) => ({ id: String(p.id), name: p.name, status: p.status, billingMethod: p.billing_method, hours: Number(p.minutes) / 60, billableHours: Number(p.billable) / 60, billedHours: Number(p.billed) / 60 })),
    };
  }
  const [credits, pending] = await Promise.all([
    ex.selectFrom('vendor_credits').select(['id', 'number', 'credit_date', 'total', 'applied_amount', 'status', 'reason'])
      .where('org_id', '=', orgId).where('vendor_id', '=', contactId).where('status', '<>', 'void').orderBy('credit_date', 'desc').limit(50).execute(),
    ex.selectFrom('portal_requests').select(['id', 'created_at']).where('org_id', '=', orgId).where('contact_id', '=', contactId)
      .where('kind', '=', 'bank_details').where('status', '=', 'pending').executeTakeFirst(),
  ]);
  const acct = unseal(c.bank_account_no);
  const comments = await loadComments([...refs, ...credits.map((v) => ({ type: 'vendor_credit', id: String(v.id) }))]);
  return {
    profile, documents, comments,
    bank: { bankName: c.bank_name, accountName: c.bank_account_name, accountLast4: acct ? acct.slice(-4) : null, ifsc: c.bank_ifsc },
    bankChangePendingSince: pending ? new Date(pending.created_at).toISOString() : null,
    credits: credits.map((v) => ({ id: String(v.id), number: v.number, date: day(v.credit_date), totalPaise: toPaiseFromSql(v.total), unusedPaise: toPaiseFromSql(v.total) - toPaiseFromSql(v.applied_amount), status: v.status, reason: v.reason })),
  };
}

/** A comment from the portal on one of the contact's own documents; the business sees it under the document. */
export async function portalComment(
  trx: Trx, orgId: number, contactId: number, side: PortalSide, authorName: string, input: { targetType: string; targetId: number; body: string },
) {
  const o = OWNED[input.targetType];
  if (!o || o.side !== side) throw badRequest('That cannot be commented on from here.');
  const body = input.body.trim();
  if (!body) throw badRequest('Write the comment first.');
  const { rows } = await sql<{ number: string }>`
    SELECT ${sql.ref(o.numberCol)} AS number FROM ${sql.table(o.table)}
     WHERE id = ${input.targetId} AND org_id = ${orgId} AND ${sql.ref(o.owner)} = ${contactId}`.execute(trx);
  if (!rows.length) throw notFound(`That ${o.label} is not yours.`);
  await trx.insertInto('comments').values({
    org_id: orgId, target_type: input.targetType, target_id: input.targetId, user_id: null,
    author_name: `${authorName} (portal)`.slice(0, 150), body: body.slice(0, 2000), portal_visible: 1,
  }).execute();
  return { label: o.label, number: rows[0].number };
}

const PIN = /^[1-9]\d{5}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A customer or vendor keeping their own address, email and phone up to date, as Zoho's portal lets them. */
export async function updatePortalProfile(
  trx: Trx, orgId: number, contactId: number,
  input: { email?: string | null; phone?: string | null; billingAddress?: string | null; billingCity?: string | null; billingPincode?: string | null; shippingAddress?: string | null; shippingCity?: string | null; shippingPincode?: string | null },
) {
  const clean = (v: string | null | undefined, max: number) => (v === undefined ? undefined : (v ?? '').trim().slice(0, max) || null);
  const values: Record<string, string | null | undefined> = {
    email: clean(input.email, 190), phone: clean(input.phone, 30),
    billing_address: clean(input.billingAddress, 500), billing_city: clean(input.billingCity, 60), billing_pincode: clean(input.billingPincode, 6),
    shipping_address: clean(input.shippingAddress, 500), shipping_city: clean(input.shippingCity, 60), shipping_pincode: clean(input.shippingPincode, 6),
  };
  if (values.email && !EMAIL.test(values.email)) throw badRequest('That email address does not look right.');
  for (const pin of [values.billing_pincode, values.shipping_pincode]) if (pin && !PIN.test(pin)) throw badRequest('A PIN code is six digits.');
  const set = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined)) as Record<string, string | null>;
  if (!Object.keys(set).length) throw badRequest('Nothing to change.');
  const before = await trx.selectFrom('contacts').selectAll().where('id', '=', contactId).where('org_id', '=', orgId).executeTakeFirstOrThrow();
  // A new email waits for the business, as new bank details do: it is where
  // invoices and sign-in codes go, so whoever holds a link must not move it.
  let emailPending: string | null = null;
  if ('email' in set) {
    const wanted = set.email;
    delete set.email;
    if (wanted && wanted.toLowerCase() !== (before.email ?? '').toLowerCase()) {
      await trx.updateTable('portal_requests').set({ status: 'rejected', decided_at: new Date() })
        .where('org_id', '=', orgId).where('contact_id', '=', contactId).where('kind', '=', 'email').where('status', '=', 'pending').execute();
      await trx.insertInto('portal_requests').values({ org_id: orgId, contact_id: contactId, kind: 'email', payload: JSON.stringify({ email: wanted }) }).execute();
      emailPending = wanted;
    }
  }
  if (Object.keys(set).length) await trx.updateTable('contacts').set(set).where('id', '=', contactId).where('org_id', '=', orgId).execute();
  const changed = Object.keys(set).filter((k) => (before as unknown as Record<string, unknown>)[k] !== set[k]);
  return { changed: changed.map((k) => k.replace(/_/g, ' ')), emailPending };
}

/**
 * A vendor asking to be paid into a different account. Kept as a request the
 * business must approve (decidePortalRequest), never applied by the portal:
 * a changed account number is how a supplier's payment is stolen.
 */
export async function requestBankChange(
  trx: Trx, orgId: number, contactId: number, input: { bankName: string; accountName: string; accountNo: string; ifsc: string },
) {
  const accountNo = input.accountNo.replace(/\s/g, '');
  const ifsc = input.ifsc.trim().toUpperCase();
  if (!/^\d{6,20}$/.test(accountNo)) throw badRequest('The account number is 6 to 20 digits.');
  if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) throw badRequest('That IFSC does not look right: four letters, a zero, then six letters or digits.');
  if (!input.accountName.trim()) throw badRequest('Give the name the account is in.');
  await trx.updateTable('portal_requests').set({ status: 'rejected', decided_at: new Date() })
    .where('org_id', '=', orgId).where('contact_id', '=', contactId).where('kind', '=', 'bank_details').where('status', '=', 'pending').execute();
  const id = Number((await trx.insertInto('portal_requests').values({
    org_id: orgId, contact_id: contactId, kind: 'bank_details',
    payload: JSON.stringify({ bankName: input.bankName.trim().slice(0, 100), accountName: input.accountName.trim().slice(0, 150), accountNo: seal(accountNo), ifsc }),
  }).executeTakeFirstOrThrow()).insertId);
  return { id, accountLast4: accountNo.slice(-4) };
}

export async function listPortalRequests(ex: Executor, orgId: number, contactId?: number) {
  const rows = await ex.selectFrom('portal_requests as r').innerJoin('contacts as c', 'c.id', 'r.contact_id')
    .leftJoin('users as u', 'u.id', 'r.decided_by_user_id')
    .select(['r.id', 'r.contact_id', 'r.kind', 'r.payload', 'r.status', 'r.created_at', 'r.decided_at', 'c.display_name', 'u.name as decided_by'])
    .where('r.org_id', '=', orgId).$if(!!contactId, (q) => q.where('r.contact_id', '=', contactId!))
    .orderBy('r.created_at', 'desc').orderBy('r.id', 'desc').limit(50).execute();
  return rows.map((r) => {
    const p = (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload) as { bankName?: string; accountName?: string; accountNo?: string; ifsc?: string; email?: string };
    const acct = r.kind === 'bank_details' ? unseal(p.accountNo ?? null) ?? '' : '';
    return {
      id: String(r.id), contactId: String(r.contact_id), contact: r.display_name, kind: r.kind, status: r.status,
      bankName: p.bankName ?? '', accountName: p.accountName ?? '', accountNoMasked: acct ? `••••${acct.slice(-4)}` : '', ifsc: p.ifsc ?? '',
      email: p.email ?? null,
      at: new Date(r.created_at).toISOString(), decidedAt: r.decided_at ? new Date(r.decided_at).toISOString() : null, decidedBy: r.decided_by,
    };
  });
}

/** The business approves or turns down a request; approving writes the new bank details, or the new email. */
export async function decidePortalRequest(trx: Trx, orgId: number, userId: number, requestId: number, decision: 'applied' | 'rejected') {
  const r = await trx.selectFrom('portal_requests').selectAll().where('id', '=', requestId).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!r) throw notFound('That request was not found.');
  if (r.status !== 'pending') throw conflict(`That request was already ${r.status}.`);
  const p = (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload) as { bankName?: string; accountName?: string; accountNo?: string; ifsc?: string; email?: string };
  if (decision === 'applied') {
    if (r.kind === 'email') {
      await trx.updateTable('contacts').set({ email: p.email ?? null }).where('id', '=', r.contact_id).where('org_id', '=', orgId).execute();
    } else {
      await trx.updateTable('contacts').set({ bank_name: p.bankName ?? null, bank_account_name: p.accountName ?? null, bank_account_no: p.accountNo ?? null, bank_ifsc: p.ifsc ?? null })
        .where('id', '=', r.contact_id).where('org_id', '=', orgId).execute();
    }
  }
  await trx.updateTable('portal_requests').set({ status: decision, decided_by_user_id: userId, decided_at: new Date() }).where('id', '=', requestId).execute();
  return { contactId: r.contact_id, kind: r.kind, email: p.email ?? null, accountLast4: (unseal(p.accountNo ?? null) ?? '').slice(-4) };
}

/** A vendor accepting or declining a purchase order, while it is still open. */
export async function respondToOrder(trx: Trx, orgId: number, contactId: number, orderId: number, decision: 'accepted' | 'declined', note?: string | null) {
  const o = await trx.selectFrom('purchase_orders').select(['id', 'number', 'status', 'vendor_id', 'vendor_response'])
    .where('id', '=', orderId).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!o || o.vendor_id !== contactId) throw notFound('That order is not yours.');
  if (o.status !== 'open') throw conflict(`That order is ${o.status.replace('_', ' ')}; it can no longer be answered.`);
  if (o.vendor_response) throw conflict(`You already ${o.vendor_response} that order. Ask us if it needs to change.`);
  await trx.updateTable('purchase_orders').set({ vendor_response: decision, vendor_response_note: note?.trim().slice(0, 500) || null, vendor_response_at: new Date() })
    .where('id', '=', o.id).execute();
  return { number: o.number };
}

/** Zoho's "Portal activities" report. */
export async function portalActivityReport(ex: Executor, orgId: number, opts: { from: string; to: string; contactId?: number }) {
  const rows = await ex.selectFrom('portal_activity as a').innerJoin('contacts as c', 'c.id', 'a.contact_id')
    .select(['a.id', 'a.side', 'a.action', 'a.target_type', 'a.target_id', 'a.detail', 'a.created_at', 'c.display_name', 'c.id as contact_id'])
    .where('a.org_id', '=', orgId).where('a.created_at', '>=', new Date(`${opts.from}T00:00:00+05:30`)).where('a.created_at', '<=', new Date(`${opts.to}T23:59:59+05:30`))
    .$if(!!opts.contactId, (q) => q.where('a.contact_id', '=', opts.contactId!))
    .orderBy('a.created_at', 'desc').orderBy('a.id', 'desc').limit(1000).execute();
  return rows.map((r) => ({
    id: String(r.id), contactId: String(r.contact_id), contact: r.display_name, side: r.side, action: r.action,
    targetType: r.target_type, targetId: r.target_id ? String(r.target_id) : null, detail: r.detail, at: new Date(r.created_at).toISOString(),
  }));
}

/** Whether a portal file belongs to this contact and may be shown on their portal. */
export async function portalFile(ex: Executor, orgId: number, contactId: number, fileId: number) {
  return ex.selectFrom('files').select(['id', 'storage_key', 'filename', 'content_type'])
    .where('id', '=', fileId).where('org_id', '=', orgId).where('attached_to_type', '=', 'contact').where('attached_to_id', '=', contactId)
    .where('deleted_at', 'is', null).where('folder', 'in', [PORTAL_SHARED_FOLDER, PORTAL_UPLOAD_FOLDER]).executeTakeFirst();
}

/** The conversation on a contact's documents, newest first: their portal comments and the business's replies. */
export async function contactPortalComments(ex: Executor, orgId: number, contactId: number, side: PortalSide) {
  const out: { id: string; targetType: string; targetId: string; label: string; number: string; author: string; body: string; at: string; fromPortal: boolean }[] = [];
  for (const [type, o] of Object.entries(OWNED)) {
    if (o.side !== side) continue;
    const { rows } = await sql<{ id: number; target_id: number; author_name: string; body: string; created_at: Date; user_id: number | null; number: string }>`
      SELECT cm.id, cm.target_id, cm.author_name, cm.body, cm.created_at, cm.user_id, ${sql.ref(`d.${o.numberCol}`)} AS number
        FROM comments cm JOIN ${sql.table(o.table)} d ON d.id = cm.target_id AND d.org_id = cm.org_id
       WHERE cm.org_id = ${orgId} AND cm.target_type = ${type} AND ${sql.ref(`d.${o.owner}`)} = ${contactId} AND cm.portal_visible = 1
       ORDER BY cm.created_at DESC LIMIT 30`.execute(ex);
    for (const r of rows) {
      out.push({
        id: String(r.id), targetType: type, targetId: String(r.target_id), label: o.label, number: r.number,
        author: r.author_name, body: r.body, at: new Date(r.created_at).toISOString(), fromPortal: r.user_id === null,
      });
    }
  }
  return out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 30);
}

/** The business answering a portal comment; the contact sees it under the document on their portal. */
export async function replyOnPortal(
  trx: Trx, orgId: number, contactId: number, side: PortalSide, user: { userId: number; name: string }, input: { targetType: string; targetId: number; body: string },
) {
  const o = OWNED[input.targetType];
  if (!o || o.side !== side) throw badRequest('That document is not on this portal.');
  const body = input.body.trim();
  if (!body) throw badRequest('Write the reply first.');
  const { rows } = await sql<{ number: string }>`
    SELECT ${sql.ref(o.numberCol)} AS number FROM ${sql.table(o.table)}
     WHERE id = ${input.targetId} AND org_id = ${orgId} AND ${sql.ref(o.owner)} = ${contactId}`.execute(trx);
  if (!rows.length) throw notFound(`That ${o.label} is not this contact's.`);
  await trx.insertInto('comments').values({
    org_id: orgId, target_type: input.targetType, target_id: input.targetId, user_id: user.userId, author_name: user.name.slice(0, 150), body: body.slice(0, 2000),
    portal_visible: 1,
  }).execute();
  return { label: o.label, number: rows[0].number };
}
