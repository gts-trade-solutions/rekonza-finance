import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Payment links on invoices, through the business's own Razorpay account
// (migration 088).
//
// A link asks for what is still owed on the invoice. When the customer pays,
// Razorpay calls this company's webhook; the signature on it is checked with
// the company's own webhook secret before anything is believed, and the
// receipt is then recorded as any receipt is — into the settlement account the
// company named, against the invoice. A webhook that arrives twice records once.
// ─────────────────────────────────────────────────────────────────────────────

import { createHmac, timingSafeEqual } from 'node:crypto';
import { db, transaction, type Executor, type Trx } from '../db';
import { toPaiseFromSql, toSqlFromPaise } from '../money-sql';
import { ApiError, badRequest, conflict, notFound } from '../http';
import { encryptionAvailable, openJson, sealJson } from '../integrations/crypto';
import { receivePayment, type PaymentMode } from './payments';

interface Secrets { keySecret: string; webhookSecret: string }
const aad = (orgId: number) => `payment_gateways:${orgId}`;

export async function saveGateway(trx: Trx, orgId: number, input: { keyId: string; keySecret: string; webhookSecret: string; depositBankAccountId: number }) {
  if (!encryptionAvailable()) throw conflict('INTEGRATION_KEY is not set on the server, so the Razorpay secret cannot be stored safely. Set it first.');
  if (!/^rzp_(test|live)_[A-Za-z0-9]+$/.test(input.keyId.trim())) throw badRequest('A Razorpay key id starts rzp_live_ or rzp_test_.');
  if (input.keySecret.trim().length < 10 || input.webhookSecret.trim().length < 6) throw badRequest('Give the key secret and the webhook secret from the Razorpay dashboard.');
  const bank = await trx.selectFrom('bank_accounts').select('id').where('id', '=', input.depositBankAccountId).where('org_id', '=', orgId).executeTakeFirst();
  if (!bank) throw notFound('That settlement account does not exist.');
  const sealed = sealJson({ keySecret: input.keySecret.trim(), webhookSecret: input.webhookSecret.trim() } satisfies Secrets, aad(orgId));
  const row = { key_id: input.keyId.trim(), key_version: sealed.keyVersion, iv: sealed.iv, auth_tag: sealed.authTag, ciphertext: sealed.ciphertext, deposit_bank_account_id: bank.id, is_active: 1 };
  await trx.insertInto('payment_gateways').values({ org_id: orgId, provider: 'razorpay', ...row }).onDuplicateKeyUpdate(row).execute();
}

export async function gatewayStatus(ex: Executor, orgId: number) {
  const g = await ex.selectFrom('payment_gateways as g').innerJoin('bank_accounts as b', 'b.id', 'g.deposit_bank_account_id')
    .select(['g.key_id', 'g.is_active', 'b.name as deposit_to']).where('g.org_id', '=', orgId).where('g.provider', '=', 'razorpay').executeTakeFirst();
  return { connected: !!g?.is_active, keyId: g?.key_id ?? null, depositTo: g?.deposit_to ?? null, test: !!g?.key_id.startsWith('rzp_test_'), canStore: encryptionAvailable() };
}

async function gateway(ex: Executor, orgId: number) {
  const g = await ex.selectFrom('payment_gateways').selectAll().where('org_id', '=', orgId).where('provider', '=', 'razorpay').where('is_active', '=', 1).executeTakeFirst();
  if (!g) throw new ApiError(409, 'Online payments are not connected. Add your Razorpay keys in Settings → Integrations.', 'gateway_not_connected');
  const secrets = openJson<Secrets>({ keyVersion: g.key_version, iv: Buffer.from(g.iv), authTag: Buffer.from(g.auth_tag), ciphertext: Buffer.from(g.ciphertext) }, aad(orgId));
  return { ...g, ...secrets };
}

export interface LinkRequest {
  amount: number; currency: 'INR'; accept_partial: boolean; description: string; reference_id: string;
  customer: { name: string; email?: string; contact?: string };
  notify: { sms: boolean; email: boolean }; reminder_enable: boolean; notes: Record<string, string>;
}
type LinkApi = (keyId: string, keySecret: string, body: LinkRequest) => Promise<{ id: string; short_url: string }>;

const razorpayLinks: LinkApi = async (keyId, keySecret, body) => {
  const res = await fetch('https://api.razorpay.com/v1/payment_links', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}` },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { id?: string; short_url?: string; error?: { description?: string } };
  if (!res.ok || !data.id || !data.short_url) throw new ApiError(502, `Razorpay refused the link: ${data.error?.description ?? res.statusText}`, 'gateway_error');
  return { id: data.id, short_url: data.short_url };
};
let linkApi: LinkApi = razorpayLinks;
/** Tests put a stand-in here, so no request leaves the machine. */
export function setPaymentLinkApi(fn: LinkApi | null) { linkApi = fn ?? razorpayLinks; }

/** A link for what is still owed; the live one is reused while it asks for the same amount. */
export async function createPaymentLink(trx: Trx, orgId: number, userId: number | null, invoiceId: number) {
  const inv = await trx.selectFrom('invoices as i').innerJoin('contacts as c', 'c.id', 'i.customer_id')
    .select(['i.id', 'i.number', 'i.status', 'i.total', 'i.amount_paid', 'i.currency', 'c.display_name', 'c.email', 'c.phone'])
    .where('i.id', '=', invoiceId).where('i.org_id', '=', orgId).executeTakeFirst();
  if (!inv) throw notFound('That invoice does not exist.');
  if (inv.status === 'draft' || inv.status === 'void') throw badRequest('Only an issued invoice can be paid online.');
  if ((inv.currency ?? 'INR') !== 'INR') throw badRequest('Payment links are in rupees; this invoice is in another currency.');
  const due = toPaiseFromSql(inv.total) - toPaiseFromSql(inv.amount_paid);
  if (due <= 0) throw badRequest('Nothing is owed on this invoice.');
  const existing = await trx.selectFrom('invoice_payment_links').select(['short_url', 'amount']).where('invoice_id', '=', inv.id).where('status', '=', 'created').orderBy('id', 'desc').executeTakeFirst();
  if (existing && toPaiseFromSql(existing.amount) === due) return { url: existing.short_url, amountPaise: due, reused: true };

  const g = await gateway(trx, orgId);
  const link = await linkApi(g.key_id, g.keySecret, {
    amount: due, currency: 'INR', accept_partial: false, description: `Invoice ${inv.number}`, reference_id: `${inv.number}-${Date.now().toString(36)}`.slice(0, 40),
    customer: { name: inv.display_name, ...(inv.email ? { email: inv.email } : {}), ...(inv.phone ? { contact: inv.phone } : {}) },
    notify: { sms: false, email: false }, reminder_enable: false, notes: { org_id: String(orgId), invoice_id: String(inv.id) },
  });
  if (existing) await trx.updateTable('invoice_payment_links').set({ status: 'cancelled' }).where('invoice_id', '=', inv.id).where('status', '=', 'created').execute();
  await trx.insertInto('invoice_payment_links').values({
    org_id: orgId, invoice_id: inv.id, provider_link_id: link.id, short_url: link.short_url, amount: toSqlFromPaise(due), created_by_user_id: userId,
  }).execute();
  return { url: link.short_url, amountPaise: due, reused: false };
}

/** The live link on an invoice, for the shared page's Pay button. */
export async function livePaymentLink(ex: Executor, orgId: number, invoiceId: number) {
  const l = await ex.selectFrom('invoice_payment_links').select(['short_url', 'amount']).where('org_id', '=', orgId).where('invoice_id', '=', invoiceId)
    .where('status', '=', 'created').orderBy('id', 'desc').executeTakeFirst();
  return l ? { url: l.short_url, amountPaise: toPaiseFromSql(l.amount) } : null;
}

const MODE: Record<string, PaymentMode> = { upi: 'upi', card: 'card', netbanking: 'netbanking', emi: 'card' };

/**
 * Razorpay's webhook for one company. Only `payment_link.paid` records
 * anything; the signature is checked first, against this company's secret.
 */
export async function handleLinkWebhook(orgId: number, rawBody: string, signature: string | null, opts: { trx?: Trx } = {}) {
  const g = await gateway(opts.trx ?? db, orgId);
  const expected = createHmac('sha256', g.webhookSecret).update(rawBody).digest('hex');
  const ok = !!signature && signature.length === expected.length && timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  if (!ok) throw new ApiError(401, 'The webhook signature does not match.', 'bad_signature');
  const event = JSON.parse(rawBody) as {
    event: string;
    payload?: { payment_link?: { entity?: { id: string } }; payment?: { entity?: { id: string; amount: number; method?: string } } };
  };
  if (event.event !== 'payment_link.paid') return { recorded: false, reason: 'ignored' };
  const linkId = event.payload?.payment_link?.entity?.id;
  const pay = event.payload?.payment?.entity;
  if (!linkId || !pay) throw badRequest('The event has no payment link or payment in it.');

  const run = <T>(fn: (trx: Trx) => Promise<T>) => (opts.trx ? fn(opts.trx) : transaction(fn));
  return run(async (trx) => {
    const link = await trx.selectFrom('invoice_payment_links').selectAll().where('provider_link_id', '=', linkId).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
    if (!link) throw notFound('That payment link is not one of this company’s.');
    if (link.status === 'paid') return { recorded: false, reason: 'already recorded' };
    const inv = await trx.selectFrom('invoices').select(['id', 'branch_id', 'customer_id', 'total', 'amount_paid', 'status']).where('id', '=', link.invoice_id).executeTakeFirstOrThrow();
    const due = inv.status === 'void' ? 0 : toPaiseFromSql(inv.total) - toPaiseFromSql(inv.amount_paid);
    // Paid by other means meanwhile: whatever is left over waits as an advance.
    const applied = Math.min(due, pay.amount);
    const receipt = await receivePayment(trx, orgId, null, {
      branchId: inv.branch_id, contactId: inv.customer_id, date: new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10),
      mode: MODE[pay.method ?? ''] ?? 'other', amountPaise: pay.amount, bankAccountId: g.deposit_bank_account_id,
      reference: pay.id, notes: `Paid online through Razorpay link ${linkId}`,
      allocations: applied > 0 ? [{ targetType: 'invoice', targetId: inv.id, amountPaise: applied }] : [],
    });
    await trx.updateTable('invoice_payment_links').set({ status: 'paid', provider_payment_id: pay.id, payment_id: receipt.id, paid_at: new Date() }).where('id', '=', link.id).execute();
    return { recorded: true, paymentId: receipt.id, number: receipt.number };
  });
}
