import { z } from 'zod';
import { route, body } from '@/lib/server/http';
import {
  billingOverview, cancelSubscription, changePlan, confirmSubscription, confirmTopup, standinStep,
  startSubscription, startTopup,
} from '@/lib/server/billing/service';

// ─────────────────────────────────────────────────────────────────────────────
// Billing: the plan, the credits, and buying more.
//
// Admins only. Buying is a commitment of the organisation's money, and the
// usage figures show who asked how much — both are an owner's business.
// ─────────────────────────────────────────────────────────────────────────────

export const GET = route(async ({ orgId }) => billingOverview(orgId), {
  permission: { module: 'billing', action: 'view' },
});

const Id = z.union([z.string(), z.number()]).transform((v, ctx) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) {
    ctx.addIssue({ code: 'custom', message: 'Invalid id.' });
    return z.NEVER;
  }
  return n;
});
const Plan = z.enum(['starter', 'growth', 'business']);
const ProviderId = z.string().trim().min(1).max(60);

const Action = z.discriminatedUnion('action', [
  z.object({ action: z.literal('topup'), pack: z.string().trim().min(1).max(20) }),
  z.object({
    action: z.literal('confirm_topup'),
    paymentId: Id,
    orderId: ProviderId,
    razorpayPaymentId: ProviderId,
    signature: z.string().trim().min(1).max(200),
  }),
  z.object({ action: z.literal('subscribe'), plan: Plan, period: z.enum(['monthly', 'yearly']) }),
  z.object({
    action: z.literal('confirm_subscription'),
    subscriptionRowId: Id,
    razorpaySubscriptionId: ProviderId,
    razorpayPaymentId: ProviderId,
    signature: z.string().trim().min(1).max(200),
  }),
  z.object({ action: z.literal('cancel_subscription') }),
  z.object({ action: z.literal('change_plan'), plan: Plan }),
  z.object({
    action: z.literal('standin'),
    step: z.enum(['pay', 'fail', 'renew']),
    paymentId: Id.optional(),
    subscriptionRowId: Id.optional(),
  }),
]);

export const POST = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, Action);
    switch (input.action) {
      case 'topup':
        return startTopup(orgId, user, input.pack);
      case 'confirm_topup':
        return confirmTopup(orgId, user, {
          paymentId: input.paymentId,
          orderId: input.orderId,
          providerPaymentId: input.razorpayPaymentId,
          signature: input.signature,
        });
      case 'subscribe':
        return startSubscription(orgId, user, input.plan, input.period);
      case 'confirm_subscription':
        return confirmSubscription(orgId, {
          subscriptionRowId: input.subscriptionRowId,
          providerSubscriptionId: input.razorpaySubscriptionId,
          providerPaymentId: input.razorpayPaymentId,
          signature: input.signature,
        });
      case 'cancel_subscription':
        return cancelSubscription(orgId, user);
      case 'change_plan':
        return changePlan(orgId, user, input.plan);
      case 'standin':
        return standinStep(orgId, user, {
          step: input.step,
          paymentId: input.paymentId,
          subscriptionRowId: input.subscriptionRowId,
        });
    }
  },
  { permission: { module: 'billing', action: 'edit' } },
);
