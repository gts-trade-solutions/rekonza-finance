import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Razorpay, over its REST API.
//
// Six calls and three signatures, done with fetch rather than the SDK so the
// whole surface is visible in one file. Amounts are always integer paise,
// which is what Razorpay speaks too — no conversion anywhere.
//
// The signatures are the security. The browser reports a successful payment
// with an id and an HMAC over it; only Razorpay and this server hold the
// secret, so a forged "payment succeeded" from a modified browser fails here.
// Webhooks are signed the same way over their raw body.
// ─────────────────────────────────────────────────────────────────────────────

import { createHmac, timingSafeEqual } from 'node:crypto';

const BASE = 'https://api.razorpay.com/v1';

export class RazorpayError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'RazorpayError';
    this.status = status;
    this.code = code;
  }
}

export interface RzpOrder {
  id: string;
  amount: number;
  currency: string;
  status: string;
  receipt: string | null;
}

export interface RzpPayment {
  id: string;
  amount: number;
  currency: string;
  status: 'created' | 'authorized' | 'captured' | 'refunded' | 'failed';
  order_id: string | null;
  invoice_id?: string | null;
  method?: string | null;
  captured?: boolean;
  amount_refunded?: number;
  error_description?: string | null;
  created_at?: number;
}

export interface RzpSubscription {
  id: string;
  plan_id: string;
  status: 'created' | 'authenticated' | 'active' | 'pending' | 'halted' | 'cancelled' | 'completed' | 'expired' | 'paused';
  current_start: number | null;
  current_end: number | null;
  ended_at: number | null;
  charge_at?: number | null;
  short_url?: string | null;
  paid_count?: number;
}

export interface RzpPlan {
  id: string;
}

export class RazorpayClient {
  private readonly auth: string;
  private readonly fetchImpl: typeof fetch;

  constructor(keyId: string, keySecret: string, fetchImpl: typeof fetch = fetch) {
    this.auth = `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`;
    this.fetchImpl = fetchImpl;
  }

  private async call<T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${BASE}${path}`, {
        method,
        headers: { Authorization: this.auth, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      throw new RazorpayError(0, 'network', `Could not reach Razorpay: ${(err as Error).message}`);
    }
    const text = await res.text();
    let json: { error?: { code?: string; description?: string } } | null = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      throw new RazorpayError(res.status, json?.error?.code ?? 'error', json?.error?.description ?? `Razorpay returned ${res.status}.`);
    }
    return json as T;
  }

  createOrder(input: { amount: number; currency: 'INR'; receipt: string; notes: Record<string, string> }): Promise<RzpOrder> {
    return this.call('POST', '/orders', input);
  }

  fetchPayment(id: string): Promise<RzpPayment> {
    return this.call('GET', `/payments/${encodeURIComponent(id)}`);
  }

  capturePayment(id: string, amount: number): Promise<RzpPayment> {
    return this.call('POST', `/payments/${encodeURIComponent(id)}/capture`, { amount, currency: 'INR' });
  }

  createPlan(input: {
    period: 'monthly' | 'yearly';
    interval: 1;
    item: { name: string; amount: number; currency: 'INR'; description: string };
    notes: Record<string, string>;
  }): Promise<RzpPlan> {
    return this.call('POST', '/plans', input);
  }

  createSubscription(input: {
    plan_id: string;
    total_count: number;
    quantity: 1;
    customer_notify: 0 | 1;
    notes: Record<string, string>;
  }): Promise<RzpSubscription> {
    return this.call('POST', '/subscriptions', input);
  }

  fetchSubscription(id: string): Promise<RzpSubscription> {
    return this.call('GET', `/subscriptions/${encodeURIComponent(id)}`);
  }

  cancelSubscription(id: string, atCycleEnd: boolean): Promise<RzpSubscription> {
    return this.call('POST', `/subscriptions/${encodeURIComponent(id)}/cancel`, { cancel_at_cycle_end: atCycleEnd ? 1 : 0 });
  }

  /** Switch plan at the next renewal. Changing mid-cycle would need proration we do not offer. */
  changeSubscriptionPlan(id: string, planId: string): Promise<RzpSubscription> {
    return this.call('PATCH', `/subscriptions/${encodeURIComponent(id)}`, {
      plan_id: planId,
      schedule_change_at: 'cycle_end',
      customer_notify: 1,
    });
  }
}

// ── Signatures ───────────────────────────────────────────────────────────────

export const hmacHex = (secret: string, payload: string): string =>
  createHmac('sha256', secret).update(payload, 'utf8').digest('hex');

/** Constant-time: a byte-by-byte early exit would leak how much of a forgery was right. */
export function sameSignature(expected: string, given: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(given ?? ''), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Checkout for an order: HMAC of "order_id|payment_id". */
export function verifyPaymentSignature(
  p: { orderId: string; paymentId: string; signature: string },
  keySecret: string,
): boolean {
  return sameSignature(hmacHex(keySecret, `${p.orderId}|${p.paymentId}`), p.signature);
}

/** Checkout for a subscription: HMAC of "payment_id|subscription_id" — the other way round. */
export function verifySubscriptionSignature(
  p: { subscriptionId: string; paymentId: string; signature: string },
  keySecret: string,
): boolean {
  return sameSignature(hmacHex(keySecret, `${p.paymentId}|${p.subscriptionId}`), p.signature);
}

/** A webhook: HMAC of the raw body, exactly as received, with the webhook secret. */
export function verifyWebhookSignature(rawBody: string, signature: string | null, webhookSecret: string): boolean {
  return !!signature && sameSignature(hmacHex(webhookSecret, rawBody), signature);
}
