import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Buying credits and subscribing to a plan.
//
// Two ways to pay, one pattern each:
//
//   Top-up pack   A Razorpay order for the pack's price plus GST. Checkout
//                 runs in the browser; the browser hands back a signed payment
//                 id; the server verifies the signature, asks Razorpay whether
//                 the money was actually captured, and only then grants the
//                 credits and issues the invoice.
//
//   Plan          A Razorpay subscription on the plan. The first charge is
//                 authorised in Checkout; every renewal after that happens at
//                 Razorpay and arrives here as a webhook. The plan's monthly
//                 credits are granted by the wallet itself, a month at a time,
//                 while Razorpay says the subscription is active.
//
// The browser's report and the webhook race each other for the same payment,
// and either may arrive first, twice, or never. Both paths end in the same
// functions, which lock the payment row and do nothing if it is already paid.
//
// Amounts are never taken from the browser. The server prices every order
// from the catalogue and checks the amount Razorpay captured against it.
// ─────────────────────────────────────────────────────────────────────────────

import { db, transaction, type Trx } from '../db';
import { ApiError, badRequest, conflict, forbidden, notFound } from '../http';
import { logAudit } from '../audit';
import type { SessionUser } from '../auth/session';
import {
  MC_PER_CREDIT, PACKS, PLANS, TOPUP_VALIDITY_DAYS, packByCode, planByCode, planPricePaise, withGst,
  type BillingPeriod,
} from '../../billing/catalog';
import { addMonthsClamped, formatInstant } from '../ai/time';
import { aiSettingsFor } from '../ai/settings';
import { blockingProblems, billingWarnings, gstRatePct, paymentsMode, razorpayKeys, sellerDetails, type PaymentsMode } from './config';
import { issueInvoice } from './invoices';
import {
  RazorpayClient, RazorpayError, verifyPaymentSignature, verifySubscriptionSignature,
  type RzpPayment, type RzpSubscription,
} from './razorpay';
import { grantCredits, prepareWallet, usageStats, walletView } from './wallet';

const rupees = (paise: number) =>
  `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Subscriptions run this many cycles, then complete and can be renewed. */
const TOTAL_CYCLES: Record<BillingPeriod, number> = { monthly: 60, yearly: 10 };

const OPEN_STATUSES = ['created', 'authenticated', 'active', 'pending', 'halted', 'paused'] as const;

function client(): RazorpayClient {
  const keys = razorpayKeys();
  if (!keys) throw new ApiError(503, 'Online payments are not configured on this server.', 'payments_unconfigured');
  return new RazorpayClient(keys.keyId, keys.keySecret);
}

/** A gateway failure, in words the admin can act on. Never a 401 — that means "signed out" to the browser. */
function gatewayError(err: unknown): unknown {
  if (err instanceof RazorpayError) {
    console.error('[billing] razorpay', err.status, err.code, err.message);
    return new ApiError(
      502,
      err.status === 0
        ? 'Razorpay could not be reached. Nothing was charged — try again in a moment.'
        : `Razorpay did not accept the request: ${err.message}`,
      'gateway_error',
    );
  }
  return err;
}

/** Refuse purchases on the demo book, on a server with no gateway, or with its GST details missing. */
async function assertCanBuy(orgId: number): Promise<Exclude<PaymentsMode, 'disabled'>> {
  const org = await db.selectFrom('organizations').select('is_demo').where('id', '=', orgId).executeTakeFirstOrThrow();
  if (org.is_demo) throw forbidden('Nothing can be bought on the demo book. Create your own book to choose a plan.');
  const mode = paymentsMode();
  if (mode === 'disabled') throw new ApiError(503, 'Online payments are not set up on this server yet.', 'payments_unconfigured');
  const problems = blockingProblems();
  if (problems.length) throw new ApiError(503, `Payments are paused until the platform is configured: ${problems.join(' ')}`, 'billing_misconfigured');
  return mode;
}

async function prefill(user: SessionUser): Promise<{ name: string; email: string; contact: string }> {
  const row = await db.selectFrom('users').select('phone').where('id', '=', user.userId).executeTakeFirst();
  return { name: user.name, email: user.email, contact: row?.phone ?? '' };
}

export interface Checkout {
  mode: 'razorpay' | 'standin';
  keyId?: string;
  /** Our payment row, for a top-up. */
  paymentId?: string;
  orderId?: string;
  /** Our subscription row, and Razorpay's id for it. */
  subscriptionRowId?: string;
  subscriptionId?: string;
  amountPaise: number;
  currency: 'INR';
  name: string;
  description: string;
  prefill: { name: string; email: string; contact: string };
  notes: Record<string, string>;
}

// ── Top-up packs ─────────────────────────────────────────────────────────────

export async function startTopup(orgId: number, user: SessionUser, packCode: string): Promise<Checkout> {
  const pack = packByCode(packCode);
  if (!pack) throw badRequest('That credit pack does not exist.');
  const mode = await assertCanBuy(orgId);

  const price = withGst(pack.pricePaise, gstRatePct());
  const description = `${pack.credits.toLocaleString('en-IN')} AI credits`;
  const row = await db
    .insertInto('billing_payments')
    .values({
      org_id: orgId,
      kind: 'topup',
      provider: mode,
      status: 'created',
      pack_code: pack.code,
      description,
      credits: pack.credits,
      taxable_paise: price.taxablePaise,
      gst_paise: price.gstPaise,
      amount_paise: price.totalPaise,
      created_by_user_id: user.userId,
    })
    .executeTakeFirstOrThrow();
  const id = Number(row.insertId);
  const notes = { org_id: String(orgId), payment_row: String(id), kind: 'topup', pack: pack.code };

  let orderId = `standin_order_${id}`;
  if (mode === 'razorpay') {
    try {
      const order = await client().createOrder({ amount: price.totalPaise, currency: 'INR', receipt: `topup_${id}`, notes });
      orderId = order.id;
    } catch (err) {
      await db
        .updateTable('billing_payments')
        .set({ status: 'failed', failure_reason: 'The order could not be created at Razorpay.' })
        .where('id', '=', id)
        .execute();
      throw gatewayError(err);
    }
  }
  await db.updateTable('billing_payments').set({ provider_order_id: orderId }).where('id', '=', id).execute();

  return {
    mode,
    keyId: mode === 'razorpay' ? razorpayKeys()!.keyId : undefined,
    paymentId: String(id),
    orderId,
    amountPaise: price.totalPaise,
    currency: 'INR',
    name: 'REKONZA AI',
    description: `${description} (incl. GST)`,
    prefill: await prefill(user),
    notes,
  };
}

/**
 * The money is in: grant the credits, issue the invoice. Called from the
 * browser's confirmation and from the webhook alike; the row lock and the
 * status check make the second caller a no-op.
 */
export async function markTopupPaid(
  trx: Trx,
  rowId: number,
  payment: { providerPaymentId: string; method: string | null; amountPaise: number },
  actor: { userId: number | null; name: string },
  now = new Date(),
): Promise<{ alreadyPaid: boolean; invoiceNumber: string | null }> {
  const row = await trx.selectFrom('billing_payments').selectAll().where('id', '=', rowId).forUpdate().executeTakeFirst();
  if (!row || row.kind !== 'topup') throw notFound('That payment does not exist.');
  if (row.status === 'paid' || row.status === 'refunded' || row.status === 'partially_refunded') {
    return { alreadyPaid: true, invoiceNumber: null };
  }
  if (payment.amountPaise !== Number(row.amount_paise)) {
    // Never grant against a different amount: this is a tampered order or a
    // bug, and either way it is for a person to look at.
    console.error('[billing] amount mismatch', { row: row.id, expected: row.amount_paise, got: payment.amountPaise });
    throw new ApiError(409, 'The amount paid does not match the order. Nothing was granted; contact support.', 'amount_mismatch');
  }

  await trx
    .updateTable('billing_payments')
    .set({ status: 'paid', provider_payment_id: payment.providerPaymentId, method: payment.method, paid_at: now, failure_reason: null })
    .where('id', '=', row.id)
    .execute();

  const expires = new Date(now.getTime() + TOPUP_VALIDITY_DAYS * 86_400_000);
  await grantCredits(trx, {
    orgId: row.org_id,
    source: 'topup',
    mc: Number(row.credits) * MC_PER_CREDIT,
    expiresAt: expires,
    grantKey: `topup:${row.id}`,
    paymentId: row.id,
    note: `${Number(row.credits).toLocaleString('en-IN')} credits bought · valid until ${formatInstant(expires)}`,
    userId: row.created_by_user_id,
  });

  const invoice = await issueInvoice(trx, {
    orgId: row.org_id,
    paymentId: row.id,
    description: `${row.description} — top-up, valid for ${TOPUP_VALIDITY_DAYS} days`,
    taxablePaise: Number(row.taxable_paise),
    gstPaise: Number(row.gst_paise),
    totalPaise: Number(row.amount_paise),
    date: now,
    reference: payment.providerPaymentId,
  });

  await logAudit({
    trx,
    orgId: row.org_id,
    actorUserId: actor.userId,
    actorName: actor.name,
    action: 'create',
    targetType: 'billing_payment',
    targetId: row.id,
    targetLabel: invoice.number,
    detail: `Bought ${row.credits} AI credits for ${rupees(Number(row.amount_paise))} (payment ${payment.providerPaymentId})`,
  });

  return { alreadyPaid: false, invoiceNumber: invoice.number };
}

export async function confirmTopup(
  orgId: number,
  user: SessionUser,
  input: { paymentId: number; orderId: string; providerPaymentId: string; signature: string },
): Promise<{ status: 'paid'; credits: number; invoiceNumber: string | null }> {
  const keys = razorpayKeys();
  if (!keys) throw badRequest('Online payments are not configured on this server.');

  const row = await db
    .selectFrom('billing_payments')
    .select(['id', 'provider_order_id', 'credits', 'status'])
    .where('id', '=', input.paymentId)
    .where('org_id', '=', orgId)
    .executeTakeFirst();
  if (!row) throw notFound('That payment does not exist.');
  if (row.provider_order_id !== input.orderId) throw badRequest('That payment does not belong to this order.');

  if (!verifyPaymentSignature({ orderId: input.orderId, paymentId: input.providerPaymentId, signature: input.signature }, keys.keySecret)) {
    throw new ApiError(
      400,
      'The payment could not be verified. If money left your account, it will be confirmed or refunded automatically within a few minutes.',
      'bad_signature',
    );
  }

  // The signature proves Razorpay issued this payment id for this order. The
  // payment itself says whether the money actually arrived.
  let payment: RzpPayment;
  try {
    payment = await client().fetchPayment(input.providerPaymentId);
    if (payment.order_id !== input.orderId) throw badRequest('That payment does not belong to this order.');
    if (payment.status === 'authorized') {
      try {
        payment = await client().capturePayment(payment.id, payment.amount);
      } catch (err) {
        // Captured already by the dashboard's auto-capture, most likely.
        payment = await client().fetchPayment(input.providerPaymentId);
        if (payment.status !== 'captured') throw err;
      }
    }
  } catch (err) {
    throw gatewayError(err);
  }
  if (payment.status !== 'captured') {
    throw new ApiError(402, `The payment is ${payment.status} at Razorpay, so no credits were added.`, 'not_captured');
  }

  const out = await transaction((trx) =>
    markTopupPaid(trx, row.id, { providerPaymentId: payment.id, method: payment.method ?? null, amountPaise: payment.amount }, { userId: user.userId, name: user.name }),
  );
  return { status: 'paid', credits: Number(row.credits), invoiceNumber: out.invoiceNumber };
}

// ── Plans ────────────────────────────────────────────────────────────────────

/**
 * The Razorpay plan for one of ours at a price, created the first time it is
 * needed. Keyed by amount as well as plan, so a price change makes a new
 * Razorpay plan and leaves existing subscribers where they are.
 */
async function razorpayPlanFor(planCode: string, period: BillingPeriod, amountPaise: number): Promise<string> {
  const keys = razorpayKeys()!;
  const mode = keys.live ? 'live' : 'test';
  const link = await db
    .selectFrom('billing_plan_links')
    .select('provider_plan_id')
    .where('plan_code', '=', planCode)
    .where('period', '=', period)
    .where('amount_paise', '=', amountPaise)
    .where('mode', '=', mode)
    .executeTakeFirst();
  if (link) return link.provider_plan_id;

  const plan = planByCode(planCode)!;
  const created = await client().createPlan({
    period,
    interval: 1,
    item: {
      name: `REKONZA AI ${plan.name} (${period})`,
      amount: amountPaise,
      currency: 'INR',
      description: `${plan.creditsPerMonth.toLocaleString('en-IN')} AI credits a month, GST included`,
    },
    notes: { plan_code: planCode, period },
  });
  await db
    .insertInto('billing_plan_links')
    .values({ plan_code: planCode, period, amount_paise: amountPaise, mode, provider_plan_id: created.id })
    .onDuplicateKeyUpdate({ provider_plan_id: created.id })
    .execute();
  return created.id;
}

async function planCodeForProviderPlan(trx: Trx, providerPlanId: string): Promise<string | null> {
  const link = await trx
    .selectFrom('billing_plan_links')
    .select('plan_code')
    .where('provider_plan_id', '=', providerPlanId)
    .executeTakeFirst();
  return link?.plan_code ?? null;
}

export async function startSubscription(
  orgId: number,
  user: SessionUser,
  planCode: string,
  period: BillingPeriod,
): Promise<Checkout> {
  const plan = planByCode(planCode);
  if (!plan) throw badRequest('That plan does not exist.');
  const mode = await assertCanBuy(orgId);

  const open = await db
    .selectFrom('billing_subscriptions')
    .select(['id', 'status', 'provider', 'provider_subscription_id'])
    .where('org_id', '=', orgId)
    .where('status', 'in', [...OPEN_STATUSES])
    .execute();
  for (const s of open) {
    if (s.status !== 'created') {
      throw conflict('This organisation already has a plan. Change it or cancel it from the billing page instead.');
    }
    // A checkout that was opened and never finished. Retire it so the new one
    // is the only subscription waiting for a first payment.
    if (s.provider === 'razorpay' && s.provider_subscription_id) {
      await client().cancelSubscription(s.provider_subscription_id, false).catch(() => undefined);
    }
    await db.updateTable('billing_subscriptions').set({ status: 'expired', ended_at: new Date() }).where('id', '=', s.id).execute();
  }

  const price = withGst(planPricePaise(plan, period), gstRatePct());
  const notes = { org_id: String(orgId), plan: plan.code, period };

  let providerPlanId: string | null = null;
  let providerSubId = `standin_sub_${orgId}_${Date.now().toString(36)}`;
  let shortUrl: string | null = null;
  if (mode === 'razorpay') {
    try {
      providerPlanId = await razorpayPlanFor(plan.code, period, price.totalPaise);
      const sub = await client().createSubscription({
        plan_id: providerPlanId,
        total_count: TOTAL_CYCLES[period],
        quantity: 1,
        customer_notify: 1,
        notes,
      });
      providerSubId = sub.id;
      shortUrl = sub.short_url ?? null;
    } catch (err) {
      throw gatewayError(err);
    }
  }

  const row = await db
    .insertInto('billing_subscriptions')
    .values({
      org_id: orgId,
      plan_code: plan.code,
      period,
      status: 'created',
      provider: mode,
      provider_subscription_id: providerSubId,
      provider_plan_id: providerPlanId,
      short_url: shortUrl,
      amount_paise: price.totalPaise,
      created_by_user_id: user.userId,
    })
    .executeTakeFirstOrThrow();

  return {
    mode,
    keyId: mode === 'razorpay' ? razorpayKeys()!.keyId : undefined,
    subscriptionRowId: String(row.insertId),
    subscriptionId: providerSubId,
    amountPaise: price.totalPaise,
    currency: 'INR',
    name: 'REKONZA AI',
    description: `${plan.name} plan, billed ${period} (incl. GST)`,
    prefill: await prefill(user),
    notes,
  };
}

const fromUnix = (s: number | null | undefined): Date | null => (s ? new Date(s * 1000) : null);

/**
 * Bring our copy of a subscription in line with Razorpay's, unless what we
 * have is newer. Webhooks arrive out of order; a "pending" from before a
 * successful retry must not overwrite the "active" that came after it.
 */
export async function syncSubscription(
  trx: Trx,
  rowId: number,
  rzp: RzpSubscription,
  eventAt: Date,
): Promise<void> {
  const row = await trx
    .selectFrom('billing_subscriptions')
    .select(['id', 'plan_code', 'pending_plan_code', 'provider_synced_at'])
    .where('id', '=', rowId)
    .forUpdate()
    .executeTakeFirstOrThrow();
  if (row.provider_synced_at && eventAt < new Date(row.provider_synced_at)) return;

  const planCode = (await planCodeForProviderPlan(trx, rzp.plan_id)) ?? row.plan_code;
  const ended = rzp.status === 'cancelled' || rzp.status === 'completed' || rzp.status === 'expired';
  await trx
    .updateTable('billing_subscriptions')
    .set({
      status: rzp.status,
      plan_code: planCode,
      provider_plan_id: rzp.plan_id,
      pending_plan_code: row.pending_plan_code && row.pending_plan_code !== planCode ? row.pending_plan_code : null,
      current_start: fromUnix(rzp.current_start),
      current_end: fromUnix(rzp.current_end),
      ended_at: ended ? fromUnix(rzp.ended_at) ?? eventAt : null,
      short_url: rzp.short_url ?? undefined,
      provider_synced_at: eventAt,
    })
    .where('id', '=', rowId)
    .execute();
}

/** Record a subscription charge and invoice it. Once per payment id. */
export async function recordSubscriptionPayment(
  trx: Trx,
  subRowId: number,
  payment: { id: string; amountPaise: number; method: string | null },
  period: { start: Date | null; end: Date | null },
  now = new Date(),
): Promise<void> {
  const existing = await trx.selectFrom('billing_payments').select('id').where('provider_payment_id', '=', payment.id).executeTakeFirst();
  if (existing) return;

  const sub = await trx
    .selectFrom('billing_subscriptions')
    .select(['id', 'org_id', 'plan_code', 'period', 'provider', 'created_by_user_id'])
    .where('id', '=', subRowId)
    .executeTakeFirstOrThrow();
  const plan = planByCode(sub.plan_code);
  const rate = gstRatePct();
  // The charge includes GST; work back to the taxable value the same way it
  // was built up, so the invoice adds up to exactly what was taken.
  const taxable = Math.round((payment.amountPaise * 100) / (100 + rate));
  const span = period.start && period.end ? ` · ${formatInstant(period.start)} to ${formatInstant(period.end)}` : '';
  const description = `${plan?.name ?? sub.plan_code} plan, ${sub.period}${span}`;

  const res = await trx
    .insertInto('billing_payments')
    .values({
      org_id: sub.org_id,
      kind: 'subscription',
      provider: sub.provider,
      status: 'paid',
      subscription_id: sub.id,
      description,
      credits: (plan?.creditsPerMonth ?? 0) * (sub.period === 'yearly' ? 12 : 1),
      taxable_paise: taxable,
      gst_paise: payment.amountPaise - taxable,
      amount_paise: payment.amountPaise,
      provider_payment_id: payment.id,
      method: payment.method,
      period_start: period.start,
      period_end: period.end,
      created_by_user_id: sub.created_by_user_id,
      paid_at: now,
    })
    .executeTakeFirstOrThrow();
  const paymentRowId = Number(res.insertId);

  const invoice = await issueInvoice(trx, {
    orgId: sub.org_id,
    paymentId: paymentRowId,
    description: `AI assistant — ${description}`,
    taxablePaise: taxable,
    gstPaise: payment.amountPaise - taxable,
    totalPaise: payment.amountPaise,
    date: now,
    reference: payment.id,
  });

  await logAudit({
    trx,
    orgId: sub.org_id,
    actorUserId: null,
    actorName: sub.provider === 'razorpay' ? 'Razorpay' : 'Test checkout',
    action: 'create',
    targetType: 'billing_payment',
    targetId: paymentRowId,
    targetLabel: invoice.number,
    detail: `Plan charge of ${rupees(payment.amountPaise)} — ${description}`,
  });
}

export async function confirmSubscription(
  orgId: number,
  input: { subscriptionRowId: number; providerSubscriptionId: string; providerPaymentId: string; signature: string },
): Promise<{ status: string }> {
  const keys = razorpayKeys();
  if (!keys) throw badRequest('Online payments are not configured on this server.');
  const row = await db
    .selectFrom('billing_subscriptions')
    .select(['id', 'provider_subscription_id'])
    .where('id', '=', input.subscriptionRowId)
    .where('org_id', '=', orgId)
    .executeTakeFirst();
  if (!row || row.provider_subscription_id !== input.providerSubscriptionId) throw notFound('That subscription does not exist.');

  if (
    !verifySubscriptionSignature(
      { subscriptionId: input.providerSubscriptionId, paymentId: input.providerPaymentId, signature: input.signature },
      keys.keySecret,
    )
  ) {
    throw new ApiError(400, 'The payment could not be verified. If it went through, the plan will start within a few minutes.', 'bad_signature');
  }

  let sub: RzpSubscription;
  let payment: RzpPayment;
  try {
    [sub, payment] = await Promise.all([
      client().fetchSubscription(input.providerSubscriptionId),
      client().fetchPayment(input.providerPaymentId),
    ]);
  } catch (err) {
    throw gatewayError(err);
  }

  const now = new Date();
  await transaction(async (trx) => {
    await syncSubscription(trx, row.id, sub, now);
    if (payment.status === 'captured') {
      await recordSubscriptionPayment(
        trx,
        row.id,
        { id: payment.id, amountPaise: payment.amount, method: payment.method ?? null },
        { start: fromUnix(sub.current_start), end: fromUnix(sub.current_end) },
        now,
      );
    }
    // Grant this month's credits now rather than on the next question.
    await prepareWallet(trx, orgId, now, { isDemo: false });
  });
  return { status: sub.status };
}

async function openSubscription(orgId: number) {
  return db
    .selectFrom('billing_subscriptions')
    .selectAll()
    .where('org_id', '=', orgId)
    .where('status', 'in', [...OPEN_STATUSES])
    .orderBy('id', 'desc')
    .executeTakeFirst();
}

/**
 * Cancel at the end of the paid period — the customer keeps what they paid
 * for. One that never took a payment is cancelled outright.
 */
export async function cancelSubscription(orgId: number, user: SessionUser): Promise<{ endsAt: string | null }> {
  const sub = await openSubscription(orgId);
  if (!sub) throw notFound('There is no plan to cancel.');
  const immediate = sub.status === 'created' || sub.status === 'authenticated';

  if (sub.provider === 'razorpay' && sub.provider_subscription_id) {
    try {
      await client().cancelSubscription(sub.provider_subscription_id, !immediate);
    } catch (err) {
      throw gatewayError(err);
    }
  }
  await db
    .updateTable('billing_subscriptions')
    .set(immediate ? { status: 'cancelled', ended_at: new Date() } : { cancel_at_period_end: 1 })
    .where('id', '=', sub.id)
    .execute();

  await logAudit({
    orgId,
    actorUserId: user.userId,
    actorName: user.name,
    action: 'update',
    targetType: 'billing_subscription',
    targetId: sub.id,
    detail: immediate
      ? `Cancelled the ${sub.plan_code} plan before its first payment`
      : `Cancelled the ${sub.plan_code} plan from the end of the current period${sub.current_end ? ` (${formatInstant(new Date(sub.current_end))})` : ''}`,
  });
  return { endsAt: immediate ? null : sub.current_end ? new Date(sub.current_end).toISOString() : null };
}

/** Switch plan from the next renewal. Same billing period only. */
export async function changePlan(orgId: number, user: SessionUser, planCode: string): Promise<{ effectiveAt: string | null }> {
  const plan = planByCode(planCode);
  if (!plan) throw badRequest('That plan does not exist.');
  const sub = await openSubscription(orgId);
  if (!sub || sub.status !== 'active') throw conflict('Only an active plan can be changed. Choose a plan first.');
  if (sub.cancel_at_period_end) throw conflict('This plan is set to end. Once it has, choose the new plan.');

  if (sub.plan_code === planCode) {
    await db.updateTable('billing_subscriptions').set({ pending_plan_code: null }).where('id', '=', sub.id).execute();
    return { effectiveAt: null };
  }

  if (sub.provider === 'razorpay' && sub.provider_subscription_id) {
    const amount = withGst(planPricePaise(plan, sub.period), gstRatePct()).totalPaise;
    try {
      const providerPlanId = await razorpayPlanFor(plan.code, sub.period, amount);
      await client().changeSubscriptionPlan(sub.provider_subscription_id, providerPlanId);
    } catch (err) {
      throw gatewayError(err);
    }
  }
  await db.updateTable('billing_subscriptions').set({ pending_plan_code: plan.code }).where('id', '=', sub.id).execute();

  await logAudit({
    orgId,
    actorUserId: user.userId,
    actorName: user.name,
    action: 'update',
    targetType: 'billing_subscription',
    targetId: sub.id,
    detail: `Scheduled a change from the ${sub.plan_code} plan to ${plan.code} at the next renewal`,
  });
  return { effectiveAt: sub.current_end ? new Date(sub.current_end).toISOString() : null };
}

// ── The test checkout ────────────────────────────────────────────────────────

/**
 * What Razorpay would do, done locally: pay or decline a top-up, start a plan,
 * or fast-forward a plan to its next renewal. Only when no gateway is
 * configured, and never in production — `paymentsMode` guarantees both.
 */
export async function standinStep(
  orgId: number,
  user: SessionUser,
  input: { step: 'pay' | 'fail' | 'renew'; paymentId?: number; subscriptionRowId?: number },
): Promise<{ ok: true; message: string }> {
  if (paymentsMode() !== 'standin') throw forbidden('The test checkout is only available when no payment gateway is configured.');
  const now = new Date();

  if (input.paymentId) {
    const row = await db
      .selectFrom('billing_payments')
      .select(['id', 'amount_paise', 'status', 'provider'])
      .where('id', '=', input.paymentId)
      .where('org_id', '=', orgId)
      .executeTakeFirst();
    if (!row || row.provider !== 'standin') throw notFound('That payment does not exist.');
    if (input.step === 'fail') {
      await db
        .updateTable('billing_payments')
        .set({ status: 'failed', failure_reason: 'Declined in the test checkout.' })
        .where('id', '=', row.id)
        .where('status', '=', 'created')
        .execute();
      return { ok: true, message: 'The test payment was declined. Nothing was charged.' };
    }
    const out = await transaction((trx) =>
      markTopupPaid(trx, row.id, { providerPaymentId: `standin_pay_${row.id}`, method: 'test', amountPaise: Number(row.amount_paise) }, { userId: user.userId, name: user.name }, now),
    );
    return { ok: true, message: out.alreadyPaid ? 'That payment was already recorded.' : 'Test payment recorded and credits added.' };
  }

  if (input.step === 'renew') {
    const sub = await openSubscription(orgId);
    if (!sub || sub.provider !== 'standin' || sub.status !== 'active') throw conflict('There is no active test plan to renew.');
    await transaction(async (trx) => {
      // The period ending: whatever is left of it expires now, as it would.
      await trx
        .updateTable('ai_credit_buckets')
        .set({ expires_at: now })
        .where('org_id', '=', orgId)
        .where('subscription_id', '=', sub.id)
        .where('expires_at', '>', now)
        .execute();

      if (sub.cancel_at_period_end) {
        await trx
          .updateTable('billing_subscriptions')
          .set({ status: 'cancelled', ended_at: now, current_end: now, provider_synced_at: now })
          .where('id', '=', sub.id)
          .execute();
      } else {
        const end = addMonthsClamped(now, sub.period === 'yearly' ? 12 : 1);
        const planCode = sub.pending_plan_code ?? sub.plan_code;
        const plan = planByCode(planCode)!;
        const amount = withGst(planPricePaise(plan, sub.period), gstRatePct()).totalPaise;
        await trx
          .updateTable('billing_subscriptions')
          .set({ plan_code: planCode, pending_plan_code: null, current_start: now, current_end: end, amount_paise: amount, provider_synced_at: now })
          .where('id', '=', sub.id)
          .execute();
        await recordSubscriptionPayment(trx, sub.id, { id: `standin_pay_s${sub.id}_${now.getTime()}`, amountPaise: amount, method: 'test' }, { start: now, end }, now);
      }
      await prepareWallet(trx, orgId, now, { isDemo: false });
    });
    return { ok: true, message: sub.cancel_at_period_end ? 'The plan has ended.' : 'The plan renewed for another period.' };
  }

  if (!input.subscriptionRowId) throw badRequest('Say which payment or plan.');
  const sub = await db
    .selectFrom('billing_subscriptions')
    .selectAll()
    .where('id', '=', input.subscriptionRowId)
    .where('org_id', '=', orgId)
    .executeTakeFirst();
  if (!sub || sub.provider !== 'standin') throw notFound('That subscription does not exist.');
  if (input.step === 'fail') {
    return { ok: true, message: 'The test payment was declined. The plan has not started, and nothing was charged.' };
  }
  if (sub.status !== 'created') return { ok: true, message: 'That plan has already started.' };

  const end = addMonthsClamped(now, sub.period === 'yearly' ? 12 : 1);
  await transaction(async (trx) => {
    await trx
      .updateTable('billing_subscriptions')
      .set({ status: 'active', current_start: now, current_end: end, provider_synced_at: now })
      .where('id', '=', sub.id)
      .execute();
    await recordSubscriptionPayment(trx, sub.id, { id: `standin_pay_s${sub.id}_${now.getTime()}`, amountPaise: Number(sub.amount_paise), method: 'test' }, { start: now, end }, now);
    await prepareWallet(trx, orgId, now, { isDemo: false });
    await logAudit({
      trx,
      orgId,
      actorUserId: user.userId,
      actorName: user.name,
      action: 'create',
      targetType: 'billing_subscription',
      targetId: sub.id,
      detail: `Started the ${sub.plan_code} plan (${sub.period}) in the test checkout`,
    });
  });
  return { ok: true, message: 'Test plan started and this month’s credits added.' };
}

// ── The billing page ─────────────────────────────────────────────────────────

export async function billingOverview(orgId: number) {
  const settings = await aiSettingsFor(db, orgId);
  // Only database work, and safe to repeat, so a deadlock is retried rather
  // than shown: the page is often opened while the top bar reads the balance.
  await transaction((trx) => prepareWallet(trx, orgId, new Date(), { isDemo: settings.isDemo }), { retryDeadlocks: true });

  const rate = gstRatePct();
  const keys = razorpayKeys();
  const [wallet, usage, sub, payments, consentBy] = await Promise.all([
    walletView(db, orgId),
    usageStats(db, orgId),
    openSubscription(orgId),
    db
      .selectFrom('billing_payments as p')
      .leftJoin('billing_invoices as i', 'i.payment_id', 'p.id')
      .select([
        'p.id', 'p.kind', 'p.status', 'p.description', 'p.credits', 'p.amount_paise', 'p.gst_paise',
        'p.method', 'p.failure_reason', 'p.created_at', 'p.paid_at', 'i.id as invoice_id', 'i.number as invoice_number',
      ])
      .where('p.org_id', '=', orgId)
      .orderBy('p.id', 'desc')
      .limit(25)
      .execute(),
    settings.consentByUserId
      ? db.selectFrom('users').select('name').where('id', '=', settings.consentByUserId).executeTakeFirst()
      : Promise.resolve(undefined),
  ]);

  const staleAfter = Date.now() - 60 * 60_000;
  return {
    mode: paymentsMode(),
    live: keys?.live ?? false,
    keyId: keys?.keyId ?? null,
    isDemo: settings.isDemo,
    blocking: blockingProblems(),
    warnings: billingWarnings(),
    gstRatePct: rate,
    seller: (({ legalName, gstin, stateCode }) => ({ legalName, gstin, stateCode }))(sellerDetails()),
    catalog: {
      plans: PLANS.map((p) => ({
        ...p,
        monthlyWithGstPaise: withGst(p.monthlyPaise, rate).totalPaise,
        yearlyWithGstPaise: withGst(p.yearlyPaise, rate).totalPaise,
      })),
      packs: PACKS.map((p) => ({ ...p, withGstPaise: withGst(p.pricePaise, rate).totalPaise })),
      topupValidityDays: TOPUP_VALIDITY_DAYS,
    },
    settings: {
      enabled: settings.enabled,
      consentAt: settings.consentAt?.toISOString() ?? null,
      consentBy: consentBy?.name ?? null,
      userMonthlyCapMc: settings.userMonthlyCapMc,
    },
    subscription: sub
      ? {
          id: String(sub.id),
          planCode: sub.plan_code,
          planName: planByCode(sub.plan_code)?.name ?? sub.plan_code,
          period: sub.period,
          status: sub.status,
          provider: sub.provider,
          amountPaise: Number(sub.amount_paise),
          currentStart: sub.current_start ? new Date(sub.current_start).toISOString() : null,
          currentEnd: sub.current_end ? new Date(sub.current_end).toISOString() : null,
          cancelAtPeriodEnd: !!sub.cancel_at_period_end,
          pendingPlanCode: sub.pending_plan_code,
          shortUrl: sub.short_url,
        }
      : null,
    wallet,
    usage,
    payments: payments.map((p) => ({
      id: String(p.id),
      kind: p.kind,
      // A checkout that was opened an hour ago and never finished is not "pending".
      status: p.status === 'created' && new Date(p.created_at).getTime() < staleAfter ? 'abandoned' : p.status,
      description: p.description,
      credits: Number(p.credits),
      amountPaise: Number(p.amount_paise),
      gstPaise: Number(p.gst_paise),
      method: p.method,
      failureReason: p.failure_reason,
      createdAt: new Date(p.created_at).toISOString(),
      paidAt: p.paid_at ? new Date(p.paid_at).toISOString() : null,
      invoiceId: p.invoice_id ? String(p.invoice_id) : null,
      invoiceNumber: p.invoice_number ?? null,
    })),
  };
}

export type BillingOverview = Awaited<ReturnType<typeof billingOverview>>;

export async function invoiceFor(orgId: number, id: number) {
  const inv = await db
    .selectFrom('billing_invoices as i')
    .innerJoin('billing_payments as p', 'p.id', 'i.payment_id')
    .select([
      'i.id', 'i.number', 'i.invoice_date', 'i.is_tax_invoice', 'i.seller_json', 'i.buyer_json', 'i.place_of_supply',
      'i.lines_json', 'i.taxable_paise', 'i.cgst_paise', 'i.sgst_paise', 'i.igst_paise', 'i.total_paise',
      'p.provider_payment_id', 'p.method', 'p.paid_at', 'p.status',
    ])
    .where('i.id', '=', id)
    .where('i.org_id', '=', orgId)
    .executeTakeFirst();
  if (!inv) throw notFound('That invoice does not exist.');
  const parse = <T>(v: unknown): T => (typeof v === 'string' ? JSON.parse(v) : v) as T;
  const lines = parse<{ lines: { description: string; sac: string; qty: number; taxablePaise: number }[]; reference: string | null }>(inv.lines_json);
  return {
    id: String(inv.id),
    number: inv.number,
    date: String(inv.invoice_date).slice(0, 10),
    isTaxInvoice: !!inv.is_tax_invoice,
    seller: parse<{ name: string; gstin: string | null; address: string | null; stateCode: string | null; email: string | null }>(inv.seller_json),
    buyer: parse<{ name: string; gstin: string | null; address: string | null; stateCode: string | null; email: string | null }>(inv.buyer_json),
    placeOfSupply: inv.place_of_supply,
    lines: lines.lines,
    reference: lines.reference ?? inv.provider_payment_id,
    taxablePaise: Number(inv.taxable_paise),
    cgstPaise: Number(inv.cgst_paise),
    sgstPaise: Number(inv.sgst_paise),
    igstPaise: Number(inv.igst_paise),
    totalPaise: Number(inv.total_paise),
    paymentMethod: inv.method,
    paidAt: inv.paid_at ? new Date(inv.paid_at).toISOString() : null,
    refunded: inv.status === 'refunded' || inv.status === 'partially_refunded',
  };
}
