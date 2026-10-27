import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// How payments are taken on this server.
//
//   razorpay   RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are set. rzp_test_ keys
//              take test payments; rzp_live_ keys take real money.
//   standin    No keys, outside production. A built-in test checkout stands in
//              for Razorpay, so buying credits and subscribing can be built and
//              tested end to end without an account.
//   disabled   No keys in production. Nothing can be bought, and the billing
//              page says why rather than offering buttons that fail.
//
// Also the platform's own GST registration. Every purchase gets a tax invoice
// issued by the platform to the organisation, and a live payment is refused
// until the details that invoice needs are configured — a customer's
// accountant cannot claim input credit on an invoice with no GSTIN on it.
// ─────────────────────────────────────────────────────────────────────────────

import { DEFAULT_GST_RATE_PCT } from '../../billing/catalog';

export type PaymentsMode = 'razorpay' | 'standin' | 'disabled';

export interface RazorpayKeys {
  keyId: string;
  keySecret: string;
  webhookSecret: string | null;
  /** Live keys move real money; test keys do not. */
  live: boolean;
}

export function razorpayKeys(): RazorpayKeys | null {
  const keyId = process.env.RAZORPAY_KEY_ID?.trim();
  const keySecret = process.env.RAZORPAY_KEY_SECRET?.trim();
  if (!keyId || !keySecret) return null;
  return {
    keyId,
    keySecret,
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET?.trim() || null,
    live: keyId.startsWith('rzp_live_'),
  };
}

export function paymentsMode(): PaymentsMode {
  if (razorpayKeys()) return 'razorpay';
  return process.env.APP_ENV === 'production' ? 'disabled' : 'standin';
}

/** GST charged on credits and plans, in percent. */
export function gstRatePct(): number {
  const raw = process.env.BILLING_GST_RATE?.trim();
  const n = Number(raw);
  return raw && Number.isFinite(n) && n >= 0 && n <= 28 ? n : DEFAULT_GST_RATE_PCT;
}

export interface SellerDetails {
  legalName: string;
  gstin: string | null;
  address: string | null;
  stateCode: string | null;
  email: string | null;
  /** The services accounting code printed on the invoice. Confirm it with a CA. */
  sac: string;
  /** Up to four letters: keeps RKZ/26-27/00001 inside GST's 16-character limit. */
  invoicePrefix: string;
}

export function sellerDetails(): SellerDetails {
  const gstin = process.env.PLATFORM_GSTIN?.trim().toUpperCase() || null;
  return {
    legalName: process.env.PLATFORM_LEGAL_NAME?.trim() || 'REKONZA AI',
    gstin,
    address: process.env.PLATFORM_ADDRESS?.trim() || null,
    stateCode: process.env.PLATFORM_STATE_CODE?.trim() || (gstin ? gstin.slice(0, 2) : null),
    email: process.env.PLATFORM_EMAIL?.trim() || null,
    sac: process.env.PLATFORM_SAC?.trim() || '998315',
    invoicePrefix: (process.env.PLATFORM_INVOICE_PREFIX?.trim() || 'RKZ').replace(/[^A-Za-z]/g, '').slice(0, 4).toUpperCase() || 'RKZ',
  };
}

/** What stops live payments being taken at all. */
export function blockingProblems(): string[] {
  const keys = razorpayKeys();
  if (!keys) return paymentsMode() === 'disabled' ? ['No payment gateway is configured on this server.'] : [];
  const out: string[] = [];
  if (keys.live) {
    const seller = sellerDetails();
    if (gstRatePct() > 0 && !seller.gstin) out.push('The platform GSTIN (PLATFORM_GSTIN) is not set, so no tax invoice could be issued.');
    if (!seller.stateCode) out.push('The platform state code (PLATFORM_STATE_CODE) is not set.');
  }
  return out;
}

/** What works but should be fixed. */
export function billingWarnings(): string[] {
  const keys = razorpayKeys();
  const out: string[] = [];
  if (keys && !keys.webhookSecret) {
    out.push('RAZORPAY_WEBHOOK_SECRET is not set, so renewals, late confirmations and refunds will not be recorded automatically.');
  }
  if (keys && !keys.live) out.push('Razorpay is in test mode: payments are simulated and no money moves.');
  return out;
}
