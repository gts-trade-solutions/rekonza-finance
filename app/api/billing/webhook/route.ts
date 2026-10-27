import { NextResponse } from 'next/server';
import { route } from '@/lib/server/http';
import { handleWebhook } from '@/lib/server/billing/webhooks';

// Razorpay's webhooks. Public — there is no session — and authenticated
// instead by the signature over the raw body, which is why the body is read
// as text and never parsed before it has been checked.

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route(
  async ({ req }) => {
    const raw = await req.text();
    const out = await handleWebhook(
      raw,
      req.headers.get('x-razorpay-signature'),
      req.headers.get('x-razorpay-event-id'),
    );
    return NextResponse.json(out.body, { status: out.status });
  },
  { public: true },
);
