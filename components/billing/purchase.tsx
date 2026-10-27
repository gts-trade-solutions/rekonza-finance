'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Paying: Razorpay Checkout when a gateway is configured, a clearly labelled
// test checkout when it is not.
//
// After Checkout says the payment succeeded, the result goes to the server to
// be verified — the signature checked, and the payment looked up at Razorpay —
// before anything is granted. If that confirmation cannot be reached, the
// webhook completes the purchase a moment later; the page says so rather than
// suggesting the money was lost.
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from 'react';
import { FlaskConical, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { billing, type Checkout } from '@/lib/api/billing';
import type { BillingPeriod, PackCode, PlanCode } from '@/lib/billing/catalog';
import { CheckoutDismissed, openRazorpayCheckout } from '@/lib/billing/checkout';
import { formatINR } from '@/lib/money';

type Kind = 'topup' | 'subscription';

export function usePurchase(onChanged: () => void) {
  const [busy, setBusy] = useState<string | null>(null);
  const [testCheckout, setTestCheckout] = useState<{ checkout: Checkout; kind: Kind } | null>(null);

  const run = async (key: string, kind: Kind, start: () => Promise<Checkout>) => {
    setBusy(key);
    try {
      const checkout = await start();
      if (checkout.mode === 'standin') {
        setTestCheckout({ checkout, kind });
        return;
      }

      const result = await openRazorpayCheckout(checkout, (message) => toast.error(message));
      try {
        if (kind === 'topup') {
          await billing.confirmTopup({
            paymentId: checkout.paymentId!,
            orderId: checkout.orderId!,
            razorpayPaymentId: result.razorpay_payment_id,
            signature: result.razorpay_signature,
          });
          toast.success('Payment received — your credits are ready.');
        } else {
          await billing.confirmSubscription({
            subscriptionRowId: checkout.subscriptionRowId!,
            razorpaySubscriptionId: checkout.subscriptionId!,
            razorpayPaymentId: result.razorpay_payment_id,
            signature: result.razorpay_signature,
          });
          toast.success('Your plan has started. This month’s credits are ready.');
        }
      } catch (err) {
        toast.warning(
          `Payment made, but it could not be confirmed here (${(err as Error).message}). It will be confirmed automatically within a few minutes.`,
        );
      }
      onChanged();
    } catch (err) {
      if (err instanceof CheckoutDismissed) toast.info('Checkout closed. Nothing was charged.');
      else toast.error((err as Error).message);
      onChanged();
    } finally {
      setBusy(null);
    }
  };

  return {
    busy,
    buyPack: (pack: PackCode) => run(`pack:${pack}`, 'topup', () => billing.topup(pack)),
    subscribe: (plan: PlanCode, period: BillingPeriod) => run(`plan:${plan}`, 'subscription', () => billing.subscribe(plan, period)),
    testCheckout,
    closeTestCheckout: () => setTestCheckout(null),
  };
}

/** What Razorpay's window would do, for a server with no gateway configured. */
export function TestCheckoutDialog({
  pending,
  onClose,
  onDone,
}: {
  pending: { checkout: Checkout; kind: Kind } | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState<'pay' | 'fail' | null>(null);

  const act = async (step: 'pay' | 'fail') => {
    if (!pending) return;
    setBusy(step);
    try {
      const res = await billing.standin({
        step,
        paymentId: pending.checkout.paymentId,
        subscriptionRowId: pending.checkout.subscriptionRowId,
      });
      if (step === 'pay') toast.success(res.message);
      else toast.info(res.message);
      onClose();
      onDone();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open={!!pending} onOpenChange={(o) => !o && onClose()}>
      <DialogContent data-slot="test-checkout">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FlaskConical className="size-4 text-warning" /> Test checkout
          </DialogTitle>
          <DialogDescription>
            No payment gateway is configured on this server, so this stands in for Razorpay. Nothing is charged. With
            Razorpay keys set, customers see Razorpay&apos;s own checkout here.
          </DialogDescription>
        </DialogHeader>
        {pending && (
          <div className="rounded-md border p-3 text-sm">
            <p className="font-medium">{pending.checkout.description}</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">{formatINR(pending.checkout.amountPaise)}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Billed to {pending.checkout.prefill.name} · {pending.checkout.prefill.email}
            </p>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => void act('fail')} disabled={!!busy} data-slot="test-decline">
            {busy === 'fail' && <Loader2 className="size-4 animate-spin" />} Decline
          </Button>
          <Button onClick={() => void act('pay')} disabled={!!busy} data-slot="test-pay">
            {busy === 'pay' && <Loader2 className="size-4 animate-spin" />}
            Pay {pending ? formatINR(pending.checkout.amountPaise) : ''} (test)
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
