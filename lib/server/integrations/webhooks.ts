import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Webhooks: telling other software when something happens in the books.
//
// Events come from the audit trail, which already records every create, void
// and approval: invoice.created, payment.voided, bill.approved. They are thin —
// the kind, the id, a label — and the receiver fetches what it needs through
// the API, so a delivery never carries more than the key it would use could see.
//
// A delivery is written with the audit row, in the same transaction, and sent
// by the job worker: POST, JSON, signed with HMAC-SHA256 over "timestamp.body"
// in X-Rekonza-Signature (t=…,v1=…). A 2xx is delivered; anything else is
// tried again after 1, 5 and 30 minutes, 2 hours and 12 hours, then given up.
//
// Only https addresses on the public internet are allowed, checked when saved
// and again, after DNS, when sent: a webhook cannot be aimed at the server's
// own network.
// ─────────────────────────────────────────────────────────────────────────────

import { createHmac, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { db, type Executor, type Trx } from '../db';
import { badRequest, notFound } from '../http';
import { seal, unseal } from '../crypto/fields';

/** The kinds of record whose events can be sent, as the audit trail names them. */
export const EVENT_TYPES = [
  'invoice', 'bill', 'payment', 'credit_note', 'vendor_credit', 'contact', 'item', 'expense', 'journal_entry',
  'purchase_order', 'sales_order', 'estimate', 'goods_receipt', 'payment_batch', 'einvoice', 'eway_bill',
] as const;
const VERB: Record<string, string> = { create: 'created', update: 'updated', void: 'voided', approve: 'approved', send: 'sent', match: 'matched', import: 'imported' };
const RETRY_MINUTES = [1, 5, 30, 120, 720];

/** The event an audit row stands for, or null for those not sent (sign-ins, settings, exports). */
export function eventFor(action: string, targetType: string | null | undefined): string | null {
  if (!targetType || !(EVENT_TYPES as readonly string[]).includes(targetType) || !VERB[action]) return null;
  return `${targetType}.${VERB[action]}`;
}

// ── Where not to send ────────────────────────────────────────────────────────

export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80')) return true;
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mapped ? isPrivateAddress(mapped[1]) : false;
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

function checkUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw badRequest('That is not a web address.'); }
  if (url.protocol !== 'https:') throw badRequest('A webhook address must start with https://.');
  if (url.username || url.password) throw badRequest('Put no password in the address; check the signature instead.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || (isIP(host) && isPrivateAddress(host))) {
    throw badRequest('A webhook must point at an address on the public internet.');
  }
  return url;
}

// ── Managing them ────────────────────────────────────────────────────────────

const cache = new Map<number, { at: number; hooks: { id: number; events: string[] }[] }>();
const forget = (orgId: number) => cache.delete(orgId);

export async function saveWebhook(
  trx: Trx, orgId: number, userId: number | null,
  input: { id?: number | null; url: string; events: string[]; description?: string | null; isActive?: boolean },
) {
  const url = checkUrl(input.url).toString();
  const events = input.events.includes('*') ? ['*'] : input.events.filter((e) => /^[a-z_]+\.[a-z]+$/.test(e));
  if (!events.length) throw badRequest('Choose at least one event, or all of them.');
  forget(orgId);
  if (input.id) {
    const r = await trx.updateTable('webhooks').set({
      url, events: JSON.stringify(events), description: input.description ?? null, is_active: input.isActive === false ? 0 : 1,
    }).where('id', '=', input.id).where('org_id', '=', orgId).executeTakeFirst();
    if (!Number(r.numUpdatedRows)) throw notFound('That webhook was not found.');
    return { id: input.id, secret: null };
  }
  const secret = `whsec_${randomBytes(24).toString('base64url')}`;
  const id = Number((await trx.insertInto('webhooks').values({
    org_id: orgId, url, events: JSON.stringify(events), secret: seal(secret)!, description: input.description ?? null, created_by_user_id: userId,
  }).executeTakeFirstOrThrow()).insertId);
  return { id, secret };
}

export async function deleteWebhook(trx: Trx, orgId: number, id: number) {
  forget(orgId);
  await trx.deleteFrom('webhooks').where('id', '=', id).where('org_id', '=', orgId).execute();
}

export async function revealSecret(ex: Executor, orgId: number, id: number) {
  const w = await ex.selectFrom('webhooks').select('secret').where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
  if (!w) throw notFound('That webhook was not found.');
  return unseal(w.secret);
}

export async function listWebhooks(ex: Executor, orgId: number) {
  const hooks = await ex.selectFrom('webhooks').select(['id', 'url', 'events', 'description', 'is_active', 'created_at']).where('org_id', '=', orgId).orderBy('id').execute();
  const deliveries = hooks.length
    ? await ex.selectFrom('webhook_deliveries').select(['id', 'webhook_id', 'event', 'status', 'attempts', 'response_code', 'last_error', 'created_at', 'delivered_at'])
      .where('org_id', '=', orgId).orderBy('id', 'desc').limit(50).execute()
    : [];
  return hooks.map((h) => ({
    id: String(h.id), url: h.url, events: (typeof h.events === 'string' ? JSON.parse(h.events) : h.events) as string[],
    description: h.description, isActive: !!h.is_active,
    deliveries: deliveries.filter((d) => d.webhook_id === h.id).slice(0, 10).map((d) => ({
      id: String(d.id), event: d.event, status: d.status, attempts: d.attempts, responseCode: d.response_code, lastError: d.last_error,
      at: new Date(d.delivered_at ?? d.created_at).toISOString(),
    })),
  }));
}

// ── Queuing (called with each audit row) ─────────────────────────────────────

async function hooksFor(ex: Executor, orgId: number) {
  const hit = cache.get(orgId);
  if (hit && Date.now() - hit.at < 30_000) return hit.hooks;
  const rows = await ex.selectFrom('webhooks').select(['id', 'events']).where('org_id', '=', orgId).where('is_active', '=', 1).execute();
  const hooks = rows.map((r) => ({ id: r.id, events: (typeof r.events === 'string' ? JSON.parse(r.events) : r.events) as string[] }));
  cache.set(orgId, { at: Date.now(), hooks });
  return hooks;
}

export async function queueEvent(
  ex: Executor, orgId: number, event: string,
  data: { type: string; id: string | null; label: string | null; detail: string | null; actor: string | null },
  onlyHookId?: number,
) {
  const hooks = (await hooksFor(ex, orgId)).filter((h) => (onlyHookId ? h.id === onlyHookId : h.events.includes('*') || h.events.includes(event)));
  for (const h of hooks) {
    await ex.insertInto('webhook_deliveries').values({
      webhook_id: h.id, org_id: orgId, event,
      payload: JSON.stringify({ event, occurredAt: new Date().toISOString(), data }),
    }).execute();
  }
  return hooks.length;
}

// ── Sending ──────────────────────────────────────────────────────────────────

export const sign = (secret: string, timestamp: number, body: string) =>
  `t=${timestamp},v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;

async function send(url: string, secret: string, deliveryId: number, event: string, body: string) {
  const parsed = checkUrl(url);
  const { address } = await lookup(parsed.hostname);
  if (isPrivateAddress(address)) throw new Error(`${parsed.hostname} resolves to a private address; not sent.`);
  const t = Math.floor(Date.now() / 1000);
  const res = await fetch(url, {
    method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10_000), body,
    headers: {
      'Content-Type': 'application/json', 'User-Agent': 'Rekonza-Webhooks/1',
      'X-Rekonza-Event': event, 'X-Rekonza-Delivery': String(deliveryId), 'X-Rekonza-Signature': sign(secret, t, body),
    },
  });
  return res.status;
}

/** Send what is due. Run by the job worker; returns how many were tried. */
export async function deliverDueWebhooks(limit = 20, sender: typeof send = send, ex: Executor = db): Promise<number> {
  const due = await ex.selectFrom('webhook_deliveries as d').innerJoin('webhooks as w', 'w.id', 'd.webhook_id')
    .select(['d.id', 'd.event', 'd.payload', 'd.attempts', 'w.url', 'w.secret', 'w.is_active'])
    .where('d.status', '=', 'pending').where('d.next_attempt_at', '<=', new Date()).orderBy('d.id').limit(limit).execute();
  for (const d of due) {
    const body = typeof d.payload === 'string' ? d.payload : JSON.stringify(d.payload);
    const attempts = d.attempts + 1;
    let code: number | null = null;
    let error: string | null = null;
    try {
      if (!d.is_active) throw new Error('The webhook is switched off.');
      code = await sender(d.url, unseal(d.secret)!, d.id, d.event, body);
      if (code < 200 || code >= 300) error = `The receiver answered ${code}.`;
    } catch (err) {
      error = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    }
    if (!error) {
      await ex.updateTable('webhook_deliveries').set({ status: 'delivered', attempts, response_code: code, last_error: null, delivered_at: new Date() }).where('id', '=', d.id).execute();
      continue;
    }
    const wait = RETRY_MINUTES[attempts - 1];
    await ex.updateTable('webhook_deliveries').set({
      status: wait === undefined ? 'failed' : 'pending', attempts, response_code: code, last_error: error,
      next_attempt_at: new Date(Date.now() + (wait ?? 0) * 60_000),
    }).where('id', '=', d.id).execute();
  }
  return due.length;
}
