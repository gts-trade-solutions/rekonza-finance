'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Razorpay Checkout, in the browser.
//
// The script is loaded only when someone actually goes to pay, never on every
// page: a payment provider's code running on screens that show a ledger is
// exposure for no benefit.
//
// Checkout hands back a payment id and a signature. Neither is trusted here —
// both go straight to the server, which checks the signature and asks Razorpay
// whether the money arrived before anything is granted.
// ─────────────────────────────────────────────────────────────────────────────

import type { Checkout } from '../api/billing';

interface RazorpayInstance {
  open(): void;
  on(event: 'payment.failed', cb: (resp: { error?: { description?: string } }) => void): void;
}

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => RazorpayInstance;
  }
}

const SCRIPT = 'https://checkout.razorpay.com/v1/checkout.js';
let loading: Promise<void> | null = null;

export function loadRazorpay(): Promise<void> {
  if (window.Razorpay) return Promise.resolve();
  if (loading) return loading;
  loading = new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = SCRIPT;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      loading = null;
      reject(new Error('Razorpay Checkout could not be loaded. Check your connection, or pause an ad blocker for this page.'));
    };
    document.body.appendChild(s);
  });
  return loading;
}

export interface CheckoutSuccess {
  razorpay_payment_id: string;
  razorpay_order_id?: string;
  razorpay_subscription_id?: string;
  razorpay_signature: string;
}

/** Closed without paying. Not an error worth shouting about. */
export class CheckoutDismissed extends Error {
  constructor() {
    super('Checkout was closed before paying.');
    this.name = 'CheckoutDismissed';
  }
}

/**
 * Open Checkout and resolve with the signed result. A declined card does not
 * reject: Checkout stays open so another method can be tried, and `onFailure`
 * is told so the page can say what happened. Closing the window rejects.
 */
export async function openRazorpayCheckout(c: Checkout, onFailure?: (message: string) => void): Promise<CheckoutSuccess> {
  await loadRazorpay();
  return new Promise<CheckoutSuccess>((resolve, reject) => {
    const rzp = new window.Razorpay!({
      key: c.keyId,
      name: c.name,
      description: c.description,
      currency: c.currency,
      ...(c.orderId ? { order_id: c.orderId, amount: c.amountPaise } : {}),
      ...(c.subscriptionId ? { subscription_id: c.subscriptionId } : {}),
      prefill: c.prefill,
      notes: c.notes,
      theme: { color: '#1d4ed8' },
      handler: (resp: CheckoutSuccess) => resolve(resp),
      modal: { ondismiss: () => reject(new CheckoutDismissed()), confirm_close: true },
    });
    rzp.on('payment.failed', (resp) => onFailure?.(resp?.error?.description || 'The payment did not go through. Try another method.'));
    rzp.open();
  });
}
