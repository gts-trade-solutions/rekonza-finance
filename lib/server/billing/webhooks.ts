import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Razorpay's webhooks: the record of what actually happened to the money.
//
// The browser's confirmation is a courtesy that makes credits appear at once.
// This is the source of truth — it arrives even when the tab was closed the
// moment the bank's page said "success", and it is the only way renewals,
// failed retries and refunds ever reach the app.
//
// Delivery is at least once, in no particular order. So:
//
//   every event is stored first, keyed by Razorpay's event id — a redelivery
//   of something processed is acknowledged and ignored;
//
//   every handler is idempotent on its own terms — a payment is marked paid
//   once, an invoice is issued once, a refund is counted once;
//
//   subscription state is only ever moved forward in time — an event older
//   than the last one applied does not undo it.
//
// A handler that throws returns 500, and Razorpay retries it later. An event
// for something this app never created — another product on the same Razorpay
// account — is acknowledged as ignored, so it is not retried forever.
// ─────────────────────────────────────────────────────────────────────────────

import { db, transaction, type Trx } from '../db';
import { logAudit } from '../audit';
import { razorpayKeys } from './config';
import { verifyWebhookSignature, type RzpPayment, type RzpSubscription } from './razorpay';
import { markTopupPaid, recordSubscriptionPayment, syncSubscription } from './service';
import { clawBack, prepareWallet } from './wallet';

interface WebhookBody {
  event?: string;
  created_at?: number;
  payload?: {
    payment?: { entity?: RzpPayment };
    order?: { entity?: { id: string } };
    subscription?: { entity?: RzpSubscription };
    refund?: { entity?: { id: string; amount: number; payment_id: string } };
  };
}

type Outcome = { status: 'processed' | 'ignored'; orgId: number | null; note?: string };

export async function handleWebhook(
  rawBody: string,
  signature: string | null,
  eventId: string | null,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const keys = razorpayKeys();
  if (!keys?.webhookSecret) {
    // Not an error Razorpay can fix by retrying, but it should keep trying
    // until the operator adds the secret — so 503, not 200.
    return { status: 503, body: { error: 'Webhooks are not configured on this server.' } };
  }
  if (!verifyWebhookSignature(rawBody, signature, keys.webhookSecret)) {
    return { status: 400, body: { error: 'Invalid signature.' } };
  }

  let body: WebhookBody;
  try {
    body = JSON.parse(rawBody) as WebhookBody;
  } catch {
    return { status: 400, body: { error: 'Invalid JSON.' } };
  }
  const event = body.event ?? 'unknown';
  const id =
    eventId ||
    `${event}:${body.payload?.payment?.entity?.id ?? body.payload?.subscription?.entity?.id ?? body.payload?.refund?.entity?.id ?? ''}:${body.created_at ?? ''}`;

  // Stored before it is acted on. A redelivery of a finished event stops here.
  const prior = await db
    .selectFrom('billing_webhook_events')
    .select(['id', 'status'])
    .where('provider_event_id', '=', id.slice(0, 80))
    .executeTakeFirst();
  if (prior && (prior.status === 'processed' || prior.status === 'ignored')) {
    return { status: 200, body: { ok: true, duplicate: true } };
  }
  let rowId: number;
  if (prior) {
    rowId = prior.id;
    await db
      .updateTable('billing_webhook_events')
      .set((eb) => ({ attempts: eb('attempts', '+', 1), status: 'received', error: null }))
      .where('id', '=', rowId)
      .execute();
  } else {
    const res = await db
      .insertInto('billing_webhook_events')
      .values({ provider_event_id: id.slice(0, 80), event: event.slice(0, 60), payload: rawBody })
      .executeTakeFirstOrThrow();
    rowId = Number(res.insertId);
  }

  try {
    const eventAt = body.created_at ? new Date(body.created_at * 1000) : new Date();
    const outcome = await transaction((trx) => dispatch(trx, event, body, eventAt));
    await db
      .updateTable('billing_webhook_events')
      .set({ status: outcome.status, org_id: outcome.orgId, error: outcome.note ?? null, processed_at: new Date() })
      .where('id', '=', rowId)
      .execute();
    return { status: 200, body: { ok: true, [outcome.status]: true } };
  } catch (err) {
    console.error('[billing] webhook failed', event, err);
    await db
      .updateTable('billing_webhook_events')
      .set({ status: 'failed', error: String((err as Error)?.message ?? err).slice(0, 500) })
      .where('id', '=', rowId)
      .execute();
    return { status: 500, body: { error: 'Processing failed; it will be retried.' } };
  }
}

async function dispatch(trx: Trx, event: string, body: WebhookBody, eventAt: Date): Promise<Outcome> {
  const payment = body.payload?.payment?.entity;
  const subscription = body.payload?.subscription?.entity;

  switch (event) {
    case 'payment.captured':
    case 'order.paid': {
      if (!payment?.order_id) return { status: 'ignored', orgId: null, note: 'no order' };
      const row = await topupByOrder(trx, payment.order_id);
      // Subscription charges also raise payment.captured; those are handled
      // by subscription.charged, which carries the period they pay for.
      if (!row) return { status: 'ignored', orgId: null, note: 'not a top-up of ours' };
      await markTopupPaid(trx, row.id, { providerPaymentId: payment.id, method: payment.method ?? null, amountPaise: payment.amount }, { userId: null, name: 'Razorpay' });
      return { status: 'processed', orgId: row.org_id };
    }

    case 'payment.authorized': {
      // Auto-capture is on for most accounts, and payment.captured follows. If
      // it is off, the payment is captured by the browser's confirmation, or
      // refunded by Razorpay after five days — never granted without capture.
      return { status: 'ignored', orgId: null, note: 'awaiting capture' };
    }

    case 'payment.failed': {
      if (!payment?.order_id) return { status: 'ignored', orgId: null };
      const row = await topupByOrder(trx, payment.order_id);
      if (!row) return { status: 'ignored', orgId: null };
      await trx
        .updateTable('billing_payments')
        .set({ status: 'failed', failure_reason: (payment.error_description ?? 'The payment was declined.').slice(0, 255) })
        .where('id', '=', row.id)
        .where('status', '=', 'created')
        .execute();
      return { status: 'processed', orgId: row.org_id };
    }

    case 'refund.processed': {
      const refund = body.payload?.refund?.entity;
      if (!refund?.payment_id) return { status: 'ignored', orgId: null };
      const row = await trx
        .selectFrom('billing_payments')
        .selectAll()
        .where('provider_payment_id', '=', refund.payment_id)
        .forUpdate()
        .executeTakeFirst();
      if (!row) return { status: 'ignored', orgId: null, note: 'not a payment of ours' };

      // Prefer Razorpay's running total — it makes a replayed refund a no-op.
      const amount = Number(row.amount_paise);
      const refundedNow = Math.min(amount, payment?.amount_refunded ?? Number(row.refunded_paise) + refund.amount);
      const delta = refundedNow - Number(row.refunded_paise);
      if (delta <= 0) return { status: 'ignored', orgId: row.org_id, note: 'already recorded' };

      await trx
        .updateTable('billing_payments')
        .set({ refunded_paise: refundedNow, status: refundedNow >= amount ? 'refunded' : 'partially_refunded' })
        .where('id', '=', row.id)
        .execute();

      let recovered = 0;
      if (row.kind === 'topup') {
        const mc = Math.floor((Number(row.credits) * 1000 * delta) / amount);
        recovered = await clawBack(trx, row.org_id, row.id, mc, `Refund on payment ${refund.payment_id}`);
      }
      await logAudit({
        trx,
        orgId: row.org_id,
        actorUserId: null,
        actorName: 'Razorpay',
        action: 'update',
        targetType: 'billing_payment',
        targetId: row.id,
        detail: `Refund of ₹${(delta / 100).toFixed(2)} processed on ${refund.payment_id}${recovered ? `; ${recovered / 1000} unused credits withdrawn` : ''}`,
      });
      return { status: 'processed', orgId: row.org_id };
    }

    default: {
      if (!event.startsWith('subscription.') || !subscription?.id) return { status: 'ignored', orgId: null, note: 'unhandled event' };
      const row = await trx
        .selectFrom('billing_subscriptions')
        .select(['id', 'org_id'])
        .where('provider_subscription_id', '=', subscription.id)
        .executeTakeFirst();
      if (!row) return { status: 'ignored', orgId: null, note: 'not a subscription of ours' };

      await syncSubscription(trx, row.id, subscription, eventAt);
      if (event === 'subscription.charged' && payment?.id && payment.status === 'captured') {
        await recordSubscriptionPayment(
          trx,
          row.id,
          { id: payment.id, amountPaise: payment.amount, method: payment.method ?? null },
          {
            start: subscription.current_start ? new Date(subscription.current_start * 1000) : null,
            end: subscription.current_end ? new Date(subscription.current_end * 1000) : null,
          },
        );
      }
      // Grant the new month's credits straight away, rather than on the next question.
      await prepareWallet(trx, row.org_id, new Date(), { isDemo: false });
      return { status: 'processed', orgId: row.org_id };
    }
  }
}

async function topupByOrder(trx: Trx, orderId: string) {
  return trx
    .selectFrom('billing_payments')
    .select(['id', 'org_id'])
    .where('provider_order_id', '=', orderId)
    .where('kind', '=', 'topup')
    .executeTakeFirst();
}
