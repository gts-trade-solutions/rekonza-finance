'use client';

// The browser's side of billing. The response types are the server's own,
// imported as types only — nothing from the server module reaches the bundle.

import { api } from './client';
import type { BillingOverview } from '../server/billing/service';
import type { BillingPeriod, PackCode, PlanCode } from '../billing/catalog';

export type { BillingOverview };

export interface Checkout {
  mode: 'razorpay' | 'standin';
  keyId?: string;
  paymentId?: string;
  orderId?: string;
  subscriptionRowId?: string;
  subscriptionId?: string;
  amountPaise: number;
  currency: 'INR';
  name: string;
  description: string;
  prefill: { name: string; email: string; contact: string };
  notes: Record<string, string>;
}

export interface BillingInvoice {
  id: string;
  number: string;
  date: string;
  isTaxInvoice: boolean;
  seller: { name: string; gstin: string | null; address: string | null; stateCode: string | null; email: string | null };
  buyer: { name: string; gstin: string | null; address: string | null; stateCode: string | null; email: string | null };
  placeOfSupply: string | null;
  lines: { description: string; sac: string; qty: number; taxablePaise: number }[];
  reference: string | null;
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  totalPaise: number;
  paymentMethod: string | null;
  paidAt: string | null;
  refunded: boolean;
}

const post = <T>(body: unknown) => api.post<T>('/api/billing', body);

export const billing = {
  overview: () => api.get<BillingOverview>('/api/billing'),
  topup: (pack: PackCode) => post<Checkout>({ action: 'topup', pack }),
  confirmTopup: (i: { paymentId: string; orderId: string; razorpayPaymentId: string; signature: string }) =>
    post<{ status: 'paid'; credits: number; invoiceNumber: string | null }>({ action: 'confirm_topup', ...i }),
  subscribe: (plan: PlanCode, period: BillingPeriod) => post<Checkout>({ action: 'subscribe', plan, period }),
  confirmSubscription: (i: { subscriptionRowId: string; razorpaySubscriptionId: string; razorpayPaymentId: string; signature: string }) =>
    post<{ status: string }>({ action: 'confirm_subscription', ...i }),
  cancel: () => post<{ endsAt: string | null }>({ action: 'cancel_subscription' }),
  changePlan: (plan: PlanCode) => post<{ effectiveAt: string | null }>({ action: 'change_plan', plan }),
  standin: (i: { step: 'pay' | 'fail' | 'renew'; paymentId?: string; subscriptionRowId?: string }) =>
    post<{ ok: true; message: string }>({ action: 'standin', ...i }),
  invoice: (id: string) => api.get<BillingInvoice>(`/api/billing/invoices/${id}`),
};
