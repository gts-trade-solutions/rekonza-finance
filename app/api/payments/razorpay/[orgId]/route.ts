import { route, ApiError } from '@/lib/server/http';
import { handleLinkWebhook } from '@/lib/server/services/payment-links';

// Razorpay calls this when a customer pays an invoice's payment link. Each
// company has its own address (…/api/payments/razorpay/<company id>), set as
// the webhook URL in its Razorpay dashboard with the event payment_link.paid;
// the signature is checked with that company's webhook secret.
export const POST = route(
  async ({ req, params }) => {
    const orgId = Number(params.orgId);
    if (!Number.isInteger(orgId) || orgId <= 0) throw new ApiError(404, 'Not found.', 'not_found');
    const raw = await req.text();
    return handleLinkWebhook(orgId, raw, req.headers.get('x-razorpay-signature'));
  },
  { public: true },
);
