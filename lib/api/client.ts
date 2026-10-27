'use client';

// ─────────────────────────────────────────────────────────────────────────────
// The browser's side of the API.
//
// One place that knows how a request is shaped and how a failure is reported,
// so no component ends up parsing an error body of its own. The session travels
// in an httpOnly cookie, which is why every call sets credentials: 'include'
// and no token is ever held in JavaScript — script that cannot read the cookie
// cannot steal the session.
// ─────────────────────────────────────────────────────────────────────────────

import { enqueue, OFFLINE_PATHS } from '../offline/outbox';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** Field-level messages from server-side validation, keyed by field name. */
  readonly details?: Record<string, string>;

  constructor(status: number, message: string, code = 'error', details?: Record<string, string>) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** Kept on this device for sending later: not saved yet, and not a failure either. */
  get isQueued(): boolean {
    return this.code === 'queued';
  }

  /** True when the caller should send the user back to sign in. */
  get isAuthFailure(): boolean {
    return this.status === 401;
  }
}

interface Options extends Omit<RequestInit, 'body'> {
  body?: unknown;
  /** Query parameters; undefined and null values are dropped. */
  params?: Record<string, string | number | boolean | null | undefined>;
}

async function request<T>(path: string, options: Options = {}): Promise<T> {
  const { body, params, headers, ...rest } = options;

  const url = new URL(path, window.location.origin);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
  }

  // An everyday entry made with no connection is kept on this device and sent
  // when the connection is back (lib/offline/outbox.ts). The caller is told it
  // was kept, by an error it can recognise, since there is no record yet.
  const queueable = options.method === 'POST' && !!OFFLINE_PATHS[path] && body !== undefined && !(typeof FormData !== 'undefined' && body instanceof FormData);
  const keep = async () => {
    await enqueue(path, body);
    return new ApiError(0, 'Saved on this device. It will be sent when you are back online.', 'queued');
  };
  if (queueable && typeof navigator !== 'undefined' && navigator.onLine === false) throw await keep();

  let res: Response;
  try {
    // A form (a file upload) sets its own content type, with the boundary.
    const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
    res = await fetch(url.toString(), {
      ...rest,
      credentials: 'include',
      headers: isForm ? { ...headers } : { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
    });
  } catch {
    if (queueable) throw await keep();
    // A network failure is not a server error, and saying "something went
    // wrong" would send someone hunting through logs for a dropped wifi signal.
    throw new ApiError(0, 'Could not reach the server. Check your connection and try again.', 'offline');
  }

  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  if (!res.ok) {
    const b = (parsed ?? {}) as { error?: string; code?: string; details?: Record<string, string> };
    throw new ApiError(
      res.status,
      b.error || `Request failed (${res.status}).`,
      b.code || 'error',
      b.details,
    );
  }

  return parsed as T;
}

export const api = {
  get: <T>(path: string, params?: Options['params']) => request<T>(path, { method: 'GET', params }),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body }),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PUT', body }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

// ── Typed endpoints ──────────────────────────────────────────────────────────

export interface SessionResponse {
  user: {
    id: string;
    name: string;
    email: string;
    role: 'admin' | 'accountant' | 'sales' | 'staff' | 'viewer';
    branchId: string | null;
    activeBranchId?: string | null;
    /** The book requires two-step sign-in of this user, not yet set up. */
    mfaSetupRequired?: boolean;
    /** A custom role's grants, which replace the built-in role's. */
    permissions?: Record<string, ('view' | 'create' | 'edit' | 'approve' | 'void')[]> | null;
    customRoleName?: string | null;
  };
  org: {
    id: string;
    name: string;
    pan: string | null;
    gstRegistrationType: string;
    aatoAbove5Cr: boolean;
    fiscalYearStartMonth: number;
    baseCurrency: string;
    address: string | null;
    email: string | null;
    phone: string | null;
    onboarded: boolean;
    isDemo: boolean;
  } | null;
  branches: {
    id: string;
    name: string;
    gstin: string | null;
    stateCode: string;
    address: string | null;
    /** Both required on every e-invoice and e-way bill, as their own fields. */
    city: string | null;
    pincode: string | null;
    isPrimary: boolean;
  }[];
}

export interface InvoiceListItem {
  id: string;
  number: string;
  date: string;
  dueDate: string;
  status: string;
  supplyType: string;
  supplyKind: string;
  customerId: string;
  customerName: string;
  branchId: string;
  subtotalPaise: number;
  totalPaise: number;
  amountPaidPaise: number;
  balancePaise: number;
  currency?: string;
  /** Owed in the invoice's own currency, when it is not INR. */
  fcBalancePaise?: number | null;
  einvoice: { status: string; irn: string | null };
}

export interface InvoiceJournalLine {
  lineNo: number;
  accountCode: string;
  accountName: string;
  debitPaise: number;
  creditPaise: number;
  description: string | null;
}

export interface InvoiceDetail {
  id: string;
  /** Priced in another currency: its own figures, and the rate it was booked at. */
  foreign?: { currency: string; rate: number; totalPaise: number; paidPaise: number } | null;
  /** When, why and by whom it was cancelled; null unless void. Older voids have no reason. */
  voided: { at: string | null; reason: string | null; by: string | null } | null;
  /** Maker and checker: whether a rule holds this document for approval. */
  approval: {
    status: 'none' | 'pending' | 'approved' | 'rejected';
    needed: boolean;
    approverRole: 'admin' | 'accountant' | 'sales' | 'staff' | 'viewer' | null;
    rejectionReason: string | null;
    submittedById: string | null;
  };
  number: string;
  date: string;
  dueDate: string;
  status: string;
  supplyType: string;
  supplyKind: string;
  placeOfSupply: string;
  customer: { id: string; name: string; gstin: string | null; address: string | null; phone?: string | null; email?: string | null };
  branch: { id: string; name: string; gstin: string | null };
  /** The supplier as a tax invoice names it: the organisation, at this branch's registration. */
  seller: {
    name: string;
    tradeName: string | null;
    gstin: string | null;
    pan: string | null;
    address: string | null;
    city: string | null;
    pincode: string | null;
    stateCode: string;
    email: string | null;
    phone: string | null;
    registration: 'regular' | 'composition' | 'unregistered';
    logoUrl: string | null;
    signatoryName: string | null;
    printLanguage: string | null;
    bank: {
      bankName: string | null; accountHolder: string; accountNumber: string;
      ifsc: string | null; branchName: string | null;
    } | null;
    upi: { id: string; payeeName: string } | null;
  };
  buyer: {
    name: string;
    gstin: string | null;
    address: string | null;
    city: string | null;
    pincode: string | null;
    stateCode: string;
    treatment: string;
  };
  /** Only when goods go somewhere other than the billing address. */
  shipTo: { address: string; city: string | null; pincode: string | null } | null;
  ewayBill: { number: string; validUntil: string | null } | null;
  orderNumber: string | null;
  subject: string | null;
  paymentTerms: string | null;
  notes: string | null;
  terms: string | null;
  /** Of a voucher type: its print heading, terms, and whether the UPI code and bank details print. */
  voucherType?: { name: string; heading: string | null; terms: string | null; showUpi: boolean; showBank: boolean } | null;
  subtotalPaise: number;
  tax: { cgstPaise: number; sgstPaise: number; igstPaise: number; cessPaise: number };
  tcsPaise: number;
  shippingChargePaise: number;
  adjustmentPaise: number;
  adjustmentLabel: string | null;
  roundOffPaise: number;
  totalPaise: number;
  amountPaidPaise: number;
  balancePaise: number;
  lines: {
    id: string;
    itemId: string | null;
    description: string | null;
    hsnSac: string | null;
    qty: number;
    uqc: string | null;
    ratePaise: number;
    discountPct: number;
    gstRatePct: number;
    taxablePaise: number;
    cgstPaise: number;
    sgstPaise: number;
    igstPaise: number;
    cessPaise: number;
    totalPaise: number;
  }[];
  einvoice: {
    status: string;
    irn: string | null;
    ackNo?: string | null;
    ackDate?: string | null;
    /** The IRP's signed QR, present only while the IRN stands. */
    signedQr?: string | null;
    /** Where the IRN came from: only `production` is a real registration. */
    environment?: 'stand-in' | 'sandbox' | 'production';
    cancelledAt?: string | null;
    /** While the IRN can still be cancelled, when that ends (ISO). */
    cancelUntil?: string | null;
    /** Why the last attempt failed, while it stands failed. */
    errorMessage?: string | null;
    cancelReason?: string | null;
    retry?: QueuedRetry | null;
  };
  payments: { id: string; number: string; date: string; mode: string; amountPaise: number }[];
  journalEntryId: string | null;
  journalLines: InvoiceJournalLine[];
}

export interface InvoiceListResponse {
  invoices: InvoiceListItem[];
  /** Per-status counts over the same period, ignoring the status filter. */
  statusCounts: Record<string, number>;
  summary: { count: number; totalPaise: number; duePaise: number };
}

export const auth = {
  /** A password alone signs in, or earns a challenge to answer with a two-step code. */
  login: (email: string, password: string) =>
    api.post<{ user: SessionResponse['user'] } | { mfaRequired: true; challenge: string }>('/api/auth/login', { email, password }),
  verifyMfa: (challenge: string, code: string) =>
    api.post<{ user: SessionResponse['user']; usedRecoveryCode: boolean; recoveryLeft: number }>('/api/auth/mfa/verify', { challenge, code }),
  logout: async () => {
    const r = await api.post<{ ok: true }>('/api/auth/logout');
    // Forget the pages and figures kept for reading offline (public/sw.js).
    try { navigator.serviceWorker?.controller?.postMessage('clear'); } catch { /* no worker */ }
    return r;
  },
  me: () => api.get<SessionResponse>('/api/auth/me'),
  register: (input: {
    businessName: string;
    stateCode: string;
    gstin?: string;
    pan?: string;
    name: string;
    email: string;
    phone?: string;
    password: string;
  }) =>
    api.post<{ user: SessionResponse['user']; org: { id: string; name: string } }>(
      '/api/auth/register',
      input,
    ),
  /** One click into the seeded demo book, as one of its four roles. */
  demo: (role: 'admin' | 'accountant' | 'sales' | 'viewer' = 'admin') =>
    api.post<{ user: SessionResponse['user']; org: { id: string; name: string } }>(
      '/api/auth/demo',
      { role },
    ),
};

export const invoices = {
  list: (params?: {
    from?: string; to?: string; status?: string; customerId?: string;
    open?: boolean; search?: string; limit?: number; offset?: number;
  }) => api.get<InvoiceListResponse>('/api/invoices', params),
  get: (id: string) => api.get<InvoiceDetail>(`/api/invoices/${id}`),
  create: (input: unknown) =>
    api.post<{ id: string; number: string; totalPaise: number; journalEntryId: string | null }>(
      '/api/invoices',
      input,
    ),
  send: (id: string) => api.post<{ id: string; status: string }>(`/api/invoices/${id}`, { action: 'send' }),
  void: (id: string, reason?: string) =>
    api.post<{ id: string; status: string }>(`/api/invoices/${id}`, { action: 'void', reason }),
  /** Write off what is left as a bad debt. */
  writeOff: (id: string, reason: string, amountPaise?: number) =>
    api.post<{ id: string; journalEntryId: string }>(`/api/invoices/${id}`, { action: 'write-off', reason, amountPaise }),
};

export interface BillListItem {
  currency?: string;
  /** Owed in the bill's own currency, when it is not INR. */
  fcBalancePaise?: number | null;
  id: string;
  internalNo: string;
  vendorInvoiceNo: string;
  date: string;
  dueDate: string;
  status: string;
  isRcm: boolean;
  vendorId: string;
  vendorName: string;
  isMsme: boolean;
  subtotalPaise: number;
  totalPaise: number;
  amountPaidPaise: number;
  balancePaise: number;
  tdsPaise: number;
  tdsSection: string | null;
}

export interface BillListResponse {
  bills: BillListItem[];
  summary: { count: number; totalPaise: number; duePaise: number };
}

export interface BillDetail {
  id: string;
  /** When, why and by whom it was cancelled; null unless void. Older voids have no reason. */
  voided: { at: string | null; reason: string | null; by: string | null } | null;
  /** Maker and checker: whether a rule holds this document for approval. */
  approval: {
    status: 'none' | 'pending' | 'approved' | 'rejected';
    needed: boolean;
    approverRole: 'admin' | 'accountant' | 'sales' | 'staff' | 'viewer' | null;
    rejectionReason: string | null;
    submittedById: string | null;
  };
  internalNo: string;
  vendorInvoiceNo: string;
  date: string;
  dueDate: string;
  status: string;
  /** How the bill compares with the order and receipt note it came from. */
  match: {
    status: 'not_required' | 'matched' | 'exception' | 'accepted';
    note: string | null;
    acceptedAt: string | null;
    poId: string | null;
    grnId: string | null;
  };
  isRcm: boolean;
  /** The buyer's own invoice for reverse charge from an unregistered supplier. */
  selfInvoiceNo: string | null;
  placeOfSupply: string;
  supplyType: string;
  vendor: { id: string; name: string; gstin: string | null; address: string | null; isMsme: boolean };
  branch: { id: string; name: string; gstin: string | null };
  notes: string | null;
  subtotalPaise: number;
  tax: { cgstPaise: number; sgstPaise: number; igstPaise: number; cessPaise: number };
  tdsPaise: number;
  tdsSection: string | null;
  roundOffPaise: number;
  totalPaise: number;
  amountPaidPaise: number;
  balancePaise: number;
  lines: {
    id: string; accountName: string | null; description: string | null; hsnSac: string | null;
    qty: number; uqc: string | null; ratePaise: number; discountPct: number; gstRatePct: number;
    taxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number;
    totalPaise: number; itcEligibility: string;
  }[];
  payments: { id: string; number: string; date: string; mode: string; amountPaise: number }[];
  journalEntryId: string | null;
  journalLines: InvoiceJournalLine[];
}

export interface ExpenseListItem {
  id: string;
  number: string;
  date: string;
  accountId: string;
  accountName: string;
  accountCode: string;
  paidThrough: string;
  vendorName: string | null;
  reference: string | null;
  notes: string | null;
  status: string;
  itcEligibility: string;
  isBillable: boolean;
  amountPaise: number;
  taxPaise: number;
  totalPaise: number;
}

export const bills = {
  list: (params?: {
    from?: string; to?: string; status?: string; vendorId?: string;
    open?: boolean; search?: string; limit?: number; offset?: number;
  }) => api.get<BillListResponse>('/api/bills', params),
  get: (id: string) => api.get<BillDetail>(`/api/bills/${id}`),
  create: (input: unknown) =>
    api.post<{ id: string; internalNo: string; totalPaise: number; journalEntryId: string | null }>(
      '/api/bills',
      input,
    ),
  void: (id: string, reason?: string) =>
    api.post<{ id: string; status: string }>(`/api/bills/${id}`, { action: 'void', reason }),
};

export const expenses = {
  list: (params?: { from?: string; to?: string; accountId?: string; limit?: number }) =>
    api.get<{ expenses: ExpenseListItem[]; summary: { count: number; totalPaise: number } }>(
      '/api/expenses',
      params,
    ),
  create: (input: unknown) =>
    api.post<{ id: string; number: string; totalPaise: number; journalEntryId: string }>(
      '/api/expenses',
      input,
    ),
};

export interface PaymentListItem {
  id: string;
  number: string;
  kind: 'received' | 'made';
  date: string;
  mode: string;
  status: string;
  contactId: string;
  contactName: string;
  bankName: string;
  reference: string | null;
  amountPaise: number;
  tdsPaise: number;
  bankChargesPaise: number;
  unappliedPaise: number;
  allocationCount: number;
}

export interface PaymentListResponse {
  payments: PaymentListItem[];
  summary: { count: number; totalPaise: number; unappliedPaise: number };
}

export const payments = {
  list: (params?: {
    kind?: 'received' | 'made'; from?: string; to?: string;
    contactId?: string; limit?: number; offset?: number;
  }) => api.get<PaymentListResponse>('/api/payments', params),
  create: (input: unknown) =>
    api.post<{ id: string; number: string; unappliedPaise: number; journalEntryId: string }>(
      '/api/payments',
      input,
    ),
  get: (id: string) => api.get<PaymentDetail>(`/api/payments/${id}`),
  /** Set money on account against documents raised since. */
  apply: (paymentId: string, date: string, allocations: { targetType: 'invoice' | 'bill' | 'retainer' | 'opening'; targetId: string; amountPaise: number }[]) =>
    api.patch<{ unappliedPaise: number }>('/api/payments', { action: 'apply', paymentId, date, allocations }),
  unapply: (allocationId: string) =>
    api.patch<{ unappliedPaise: number }>('/api/payments', { action: 'unapply', allocationId }),
  /** Reverse a payment entered by mistake; what it settled is owed again. */
  void: (paymentId: string, reason: string) =>
    api.patch<{ ok: true }>('/api/payments', { action: 'void', paymentId, reason }),
};

export interface PaymentDetail {
  id: string;
  number: string;
  kind: 'received' | 'made';
  date: string;
  status: 'cleared' | 'void';
  contactId: string;
  contactName: string;
  amountPaise: number;
  tdsPaise: number;
  unappliedPaise: number;
  advanceGst: { ratePct: number; advancePaise: number; taxPaise: number } | null;
  allocations: {
    id: string; targetType: string; targetId: string; number: string; amountPaise: number; appliedOn: string | null;
  }[];
}

// ── Masters ──────────────────────────────────────────────────────────────────

export interface ContactRow {
  id: string;
  kind: 'customer' | 'vendor' | 'both';
  displayName: string;
  /** As read: an edit sends it back and is refused if the contact changed since. */
  updatedAt?: string;
  legalName: string | null;
  gstin: string | null;
  pan: string | null;
  gstTreatment: string;
  stateCode: string;
  email: string | null;
  phone: string | null;
  paymentTerms: string | null;
  creditLimitPaise: number;
  /** Off: payments settle the oldest open documents first, with no bills named. */
  billWise?: boolean;
  isMsme: boolean;
  msmeUdyamNo: string | null;
  msmeCategory: 'micro' | 'small' | 'medium' | null;
  msmeActivity: 'manufacturing' | 'services' | 'trading' | null;
  /** Credit period agreed in writing (≤ 45); null when there is none, which means 15 days. */
  msmeAgreementDays: number | null;
  bankAccountName: string | null;
  bankAccountNo: string | null;
  bankIfsc: string | null;
  bankName: string | null;
  /** The currency they are invoiced or billed in; INR for most. */
  currency?: string;
  /** The price list a customer is charged from. */
  priceListId?: string | null;
  tdsApplicable: boolean;
  tdsSection: string | null;
  billingAddress: string | null;
  shippingAddress: string | null;
  notes: string | null;
  isArchived: boolean;
  receivablePaise: number;
  payablePaise: number;
  invoiceCount: number;
  billCount: number;
}

export interface ItemRow {
  id: string;
  kind: 'goods' | 'service';
  name: string;
  sku: string | null;
  hsnSac: string | null;
  uqc: string;
  salePricePaise: number;
  purchasePricePaise: number;
  gstRatePct: number;
  taxPref: string;
  description: string | null;
  trackInventory: boolean;
  reorderLevel: number | null;
  openingStockQty: number | null;
  openingStockRatePaise: number | null;
  isArchived: boolean;
  trackBatches?: boolean;
  mrpPaise: number | null;
  standardCostPaise: number | null;
  altUqc: string | null;
  altFactor: number | null;
  minLevel: number | null;
  trackSerials: boolean;
  stockGroupId: string | null;
  valuationMethod: 'average' | 'fifo' | null;
  updatedAt: string;
  qtySold: number;
  soldValuePaise: number;
  marginPaise: number;
}

export interface HsnCodeRow {
  id: string;
  code: string;
  kind: 'hsn' | 'sac';
  description: string;
  gstRatePct: number;
  cessRatePct: number;
  /** Rates by the date they took effect, oldest first. Empty when never changed. */
  rates: { effectiveFrom: string; gstRatePct: number; cessRatePct: number; note: string | null }[];
  uqc: string | null;
  isActive: boolean;
  itemCount: number;
  lineCount: number;
}

export interface ContactStatementDoc {
  id: string;
  number: string;
  vendorInvoiceNo?: string;
  date: string;
  dueDate: string;
  status: string;
  subtotalPaise: number;
  totalPaise: number;
  amountPaidPaise: number;
  balancePaise: number;
}

export interface ContactStatementPayment {
  id: string;
  number: string;
  kind: 'received' | 'made';
  date: string;
  mode: string;
  status: string;
  reference: string | null;
  bankName: string;
  amountPaise: number;
  tdsPaise: number;
  unappliedPaise: number;
}

export interface ContactDetail {
  contact: Omit<ContactRow, 'receivablePaise' | 'payablePaise' | 'invoiceCount' | 'billCount'>;
  invoices: ContactStatementDoc[];
  bills: ContactStatementDoc[];
  payments: ContactStatementPayment[];
  summary: {
    invoicedPaise: number;
    billedPaise: number;
    receivablePaise: number;
    payablePaise: number;
    receivedPaise: number;
    paidPaise: number;
  };
}

export const contacts = {
  get: (id: string) => api.get<ContactDetail>(`/api/contacts/${id}`),
  list: (params?: { kind?: 'customer' | 'vendor' | 'both' | 'all'; search?: string; archived?: boolean; limit?: number }) =>
    api.get<{ contacts: ContactRow[] }>('/api/contacts', params),
  create: (input: unknown) => api.post<{ id: string; displayName: string }>('/api/contacts', input),
  update: (input: unknown) => api.patch<{ id: string }>('/api/contacts', input),
  archive: (id: string) => api.patch<{ id: string }>('/api/contacts', { id, isArchived: true }),
};

export const items = {
  list: (params?: { kind?: 'goods' | 'service' | 'all'; search?: string; archived?: boolean; limit?: number }) =>
    api.get<{ items: ItemRow[] }>('/api/items', params),
  create: (input: unknown) => api.post<{ id: string; name: string }>('/api/items', input),
  update: (input: unknown) => api.patch<{ id: string }>('/api/items', input),
  archive: (id: string) => api.patch<{ id: string }>('/api/items', { id, isArchived: true }),
};

// ── TDS returns ──────────────────────────────────────────────────────────────

export interface TdsDeducteeRow {
  docId: string; docNumber: string; date: string; partyId: string; partyName: string; pan: string | null;
  section: string; sectionLabel: string; amountPaise: number; taxPaise: number; ratePct: number; month: string;
  /** A: lower or nil under a certificate. C: higher rate for want of a working PAN. */
  lowerCertificateNo?: string | null; remark?: 'A' | 'C' | null;
}

export interface TdsCertificateRow {
  contactId: string; contactName: string; pan: string | null; taxPaise: number; coveredPaise: number;
  status: 'done' | 'partial' | 'due' | 'overdue';
  certificates: { id: string; certificateNo: string; issuedOn: string; taxPaise: number; fileId: string | null }[];
}

export interface TdsCertificatesResponse {
  fy: number; quarter: 1 | 2 | 3 | 4; form: string; dueDate: string;
  issued: TdsCertificateRow[]; received: TdsCertificateRow[];
}

export interface TdsLowerCertificate {
  id: string; contactId: string; contactName: string; pan: string | null; sectionCode: string; certificateNo: string;
  ratePct: number; validFrom: string; validTo: string; limitPaise: number | null; usedPaise: number;
  cancelled: boolean; notes: string | null;
}

export interface TdsDeducteePan {
  id: string; name: string; pan: string | null; panStatus: 'unverified' | 'operative' | 'inoperative';
  checkedOn: string | null; section: string | null;
}

export const tdsCertificates = {
  quarter: (fy: number, quarter: number) =>
    api.get<TdsCertificatesResponse>('/api/tds-certificates', { view: 'certificates', fy, quarter }),
  lower: () => api.get<{ certificates: TdsLowerCertificate[] }>('/api/tds-certificates', { view: 'lower' }),
  pans: () => api.get<{ deductees: TdsDeducteePan[] }>('/api/tds-certificates', { view: 'pans' }),
  addLower: (input: {
    contactId: string; sectionCode: string; certificateNo: string; ratePct: number;
    validFrom: string; validTo: string; limitPaise: number | null; notes?: string | null;
  }) => api.post<{ id: string }>('/api/tds-certificates', { action: 'lower-add', ...input }),
  cancelLower: (id: string) => api.post<{ ok: true }>('/api/tds-certificates', { action: 'lower-cancel', id }),
  record: (input: {
    direction: 'issued' | 'received'; contactId: string; fy: number; quarter: number;
    certificateNo: string; issuedOn: string; taxPaise: number; notes?: string | null;
  }) => api.post<{ id: string }>('/api/tds-certificates', { action: 'certificate', ...input }),
  setPan: (contactId: string, status: 'operative' | 'inoperative' | 'unverified', checkedOn: string) =>
    api.post<{ ok: true }>('/api/tds-certificates', { action: 'pan-status', contactId, status, checkedOn }),
};

export interface TdsMonthDeposit {
  month: string; deductedPaise: number; depositedPaise: number; dueDate: string; daysLate: number;
  status: 'paid' | 'short' | 'unpaid' | 'nothing_due';
  challans: { id: string; date: string; bsrCode: string; serial: string; taxPaise: number }[];
}

export interface TdsQuarterResponse {
  fy: number;
  quarter: 1 | 2 | 3 | 4;
  from: string;
  to: string;
  tan: string | null;
  deductor: {
    type: string | null;
    responsible: { name: string | null; designation: string | null; pan: string | null; mobile: string | null; email: string | null };
  };
  returnDueDate: string;
  forms: { form: string; kind: 'resident' | 'non_resident' | 'tcs'; rows: TdsDeducteeRow[]; totalTaxPaise: number }[];
  deposits: { tds: TdsMonthDeposit[]; tcs: TdsMonthDeposit[] };
  issues: { level: 'error' | 'warning'; message: string }[];
  challans: {
    id: string; kind: 'tds' | 'tcs'; forMonth: string; date: string; bsrCode: string; serial: string;
    taxPaise: number; interestPaise: number; feePaise: number; totalPaise: number; bankName: string | null; notes: string | null;
  }[];
}

export const tdsReturns = {
  get: (fy: number, quarter: number) => api.get<TdsQuarterResponse>('/api/tds-returns', { fy, quarter }),
  recordChallan: (input: unknown) => api.post<{ id: string; journalEntryId: string }>('/api/tds-returns', input),
};

// ── Tax rates ────────────────────────────────────────────────────────────────
//
// TDS and TCS by the date each rate took effect. `shipped` means the book still
// uses the rates that came with the software and has not changed any.

export interface TdsRateRow {
  id: string | null;
  code: string;
  actRef: string | null;
  nature: string;
  effectiveFrom: string;
  rateIndividualPct: number;
  rateOtherPct: number;
  rateNoPanPct: number;
  thresholdSinglePaise: number | null;
  thresholdAnnualPaise: number | null;
  onExcessOnly: boolean;
  sourceUrl: string | null;
  verified: boolean;
  verifiedAt: string | null;
}

export interface TcsRateRow {
  id: string | null;
  code: string;
  actRef: string | null;
  nature: string;
  effectiveFrom: string;
  ratePct: number;
  rateNoPanPct: number;
  thresholdPaise: number | null;
  sourceUrl: string | null;
  verified: boolean;
  verifiedAt: string | null;
}

export interface TaxRatesResponse {
  tds: TdsRateRow[];
  tcs: TcsRateRow[];
  shipped: boolean;
  tdsOn?: TdsRateRow[];
  tcsOn?: TcsRateRow[];
}

export const taxRates = {
  get: (date?: string) => api.get<TaxRatesResponse>('/api/tax-rates', date ? { date } : undefined),
  save: (input: unknown) => api.put<{ ok: true }>('/api/tax-rates', input),
  verify: (input: { kind: 'tds' | 'tcs'; code: string; effectiveFrom: string }) =>
    api.post<{ ok: true }>('/api/tax-rates', input),
  remove: (input: { kind: 'tds' | 'tcs'; code: string; effectiveFrom: string }) =>
    api.delete<{ ok: true }>(
      `/api/tax-rates?kind=${input.kind}&code=${encodeURIComponent(input.code)}&effectiveFrom=${input.effectiveFrom}`,
    ),
};

export const hsnCodes = {
  list: (params?: { kind?: 'hsn' | 'sac' | 'all'; prefix?: string; search?: string; activeOnly?: boolean }) =>
    api.get<{ hsnCodes: HsnCodeRow[] }>('/api/hsn-codes', params),
  create: (input: unknown) => api.post<{ id: string; code: string; kind: string }>('/api/hsn-codes', input),
  update: (input: unknown) => api.patch<{ id: string }>('/api/hsn-codes', input),
  remove: (id: string) => api.delete<{ id: string }>(`/api/hsn-codes?id=${encodeURIComponent(id)}`),
  addRate: (input: { hsnCodeId: string; effectiveFrom: string; gstRatePct: number; cessRatePct: number; note?: string | null }) =>
    api.post<{ hsnCodeId: string }>('/api/hsn-codes/rates', input),
  removeRate: (hsnCodeId: string, effectiveFrom: string) =>
    api.delete<{ hsnCodeId: string }>(
      `/api/hsn-codes/rates?hsnCodeId=${encodeURIComponent(hsnCodeId)}&effectiveFrom=${effectiveFrom}`,
    ),
};

// ── Sales documents ──────────────────────────────────────────────────────────
//
// The five documents around an invoice. Estimates, orders and challans post
// nothing; credit notes and retainers post real entries.

export type SalesDocKind = 'estimate' | 'sales-order' | 'challan' | 'credit-note' | 'retainer';

export interface SalesDocRow {
  id: string;
  number: string;
  date: string;
  status: string;
  customerId: string;
  customerName: string;
  subtotalPaise: number;
  totalPaise: number;
  /** Invoiced-so-far on an order, applied-so-far on a credit note or retainer. */
  appliedPaise: number | null;
  /** Cash the customer has settled. Only retainers carry one. */
  paidPaise: number | null;
  /** The second string this kind carries: a reason, a purpose, a description. */
  detail: string | null;
  linkedId: string | null;
  expiry: string | null;
}

export interface SalesDocListResponse {
  kind: SalesDocKind;
  documents: SalesDocRow[];
  statusCounts: Record<string, number>;
  summary: { count: number; totalPaise: number; openPaise: number };
}

export const salesDocuments = {
  list: (kind: SalesDocKind, params?: { from?: string; to?: string; status?: string; customerId?: string; search?: string; limit?: number }) =>
    api.get<SalesDocListResponse>('/api/sales-documents', { kind, ...params }),
  create: (input: unknown) =>
    api.post<{ id: string; number: string; totalPaise: number; journalEntryId: string | null }>(
      '/api/sales-documents',
      input,
    ),
  convert: (kind: 'estimate' | 'sales-order', id: string, date: string, dueDate: string) =>
    api.patch<{ invoiceId: string; number: string; totalPaise: number }>('/api/sales-documents', {
      action: 'convert', kind, id, date, dueDate,
    }),
  /** Quotation → Sales Order. */
  toOrder: (id: string, date: string) =>
    api.patch<{ salesOrderId: string; number: string; totalPaise: number }>('/api/sales-documents', { action: 'to-order', id, date }),
  setStatus: (kind: SalesDocKind, id: string, status: string) =>
    api.patch<{ id: string; status: string }>('/api/sales-documents', {
      action: 'set-status', kind, id, status,
    }),
  applyRetainer: (id: string, invoiceId: string, amountPaise?: number) =>
    api.patch<{ appliedPaise: number; journalEntryId: string }>('/api/sales-documents', {
      action: 'apply-retainer', id, invoiceId, amountPaise,
    }),
  refundCreditNote: (id: string, bankAccountId: string, date: string, amountPaise?: number, reference?: string) =>
    api.patch<{ refundedPaise: number; journalEntryId: string }>('/api/sales-documents', {
      action: 'refund-credit-note', id, bankAccountId, date, amountPaise, reference,
    }),
  voidCreditNote: (id: string, reason?: string) =>
    api.patch<{ id: string; status: string }>('/api/sales-documents', {
      action: 'void-credit-note', id, reason,
    }),
};

// ── Purchase documents ───────────────────────────────────────────────────────

export type PurchaseDocKind = 'purchase-order' | 'vendor-credit';

export interface PurchaseDocRow {
  id: string;
  number: string;
  date: string;
  status: string;
  vendorId: string;
  vendorName: string;
  isMsme: boolean;
  subtotalPaise: number;
  totalPaise: number;
  /** Billed-so-far on an order, applied-so-far on a credit. */
  appliedPaise: number;
  expected: string | null;
  reason: string | null;
  linkedId: string | null;
}

export interface PurchaseDocListResponse {
  kind: PurchaseDocKind;
  documents: PurchaseDocRow[];
  statusCounts: Record<string, number>;
  summary: { count: number; totalPaise: number; openPaise: number };
}

export const purchaseDocuments = {
  list: (kind: PurchaseDocKind, params?: { from?: string; to?: string; status?: string; vendorId?: string; search?: string; limit?: number }) =>
    api.get<PurchaseDocListResponse>('/api/purchase-documents', { kind, ...params }),
  create: (input: unknown) =>
    api.post<{ id: string; number: string; totalPaise: number; journalEntryId: string | null }>(
      '/api/purchase-documents',
      input,
    ),
  convert: (id: string, vendorInvoiceNo: string, date: string, dueDate: string) =>
    api.patch<{ billId: string; internalNo: string; totalPaise: number }>('/api/purchase-documents', {
      action: 'convert', id, vendorInvoiceNo, date, dueDate,
    }),
  setStatus: (id: string, status: 'open' | 'closed' | 'cancelled') =>
    api.patch<{ id: string; status: string }>('/api/purchase-documents', {
      action: 'set-status', id, status,
    }),
  refundVendorCredit: (id: string, bankAccountId: string, date: string, amountPaise?: number, reference?: string) =>
    api.patch<{ refundedPaise: number; journalEntryId: string }>('/api/purchase-documents', {
      action: 'refund-vendor-credit', id, bankAccountId, date, amountPaise, reference,
    }),
  voidVendorCredit: (id: string, reason?: string) =>
    api.patch<{ id: string; status: string }>('/api/purchase-documents', {
      action: 'void-vendor-credit', id, reason,
    }),
};

// ── Chart of accounts ────────────────────────────────────────────────────────

export interface AccountRow {
  id: string;
  code: string;
  name: string;
  type: 'asset' | 'liability' | 'equity' | 'income' | 'expense';
  subtype: string | null;
  parentId: string | null;
  description: string | null;
  isSystem: boolean;
  isActive: boolean;
  debitPaise: number;
  creditPaise: number;
  /** Signed in the account's own direction: positive means a normal balance. */
  balancePaise: number;
  lineCount: number;
}

// ── Fixed assets ─────────────────────────────────────────────────────────────

export interface AssetClassRow {
  id: string; name: string; accountId: string; accountName: string; method: 'slm' | 'wdv';
  usefulLifeYears: number; residualPct: number; itBlock: string; itRatePct: number; isIntangible: boolean;
}

export interface AssetRegisterRow {
  id: string; tagNo: string; name: string; classId: string; className: string; branchId: string;
  status: 'cwip' | 'in_use' | 'disposed'; acquiredOn: string; putToUseOn: string | null; disposedOn: string | null;
  location: string | null; custodian: string | null; serialNo: string | null;
  costPaise: number; accumulatedPaise: number; netPaise: number; itcClaimedPaise: number;
  insuranceExpiry: string | null; amcExpiry: string | null; lastVerifiedOn: string | null; flags: string[];
}

export interface AssetDetail {
  asset: {
    id: string; tagNo: string; name: string; description: string | null; serialNo: string | null; location: string | null;
    custodian: string | null; hsnSac: string | null; status: 'cwip' | 'in_use' | 'disposed'; branchId: string;
    acquiredOn: string; putToUseOn: string | null; disposedOn: string | null; disposalKind: 'sold' | 'scrapped' | null;
    disposalValuePaise: number | null; insurancePolicyNo: string | null; insuranceExpiry: string | null;
    amcVendor: string | null; amcExpiry: string | null; notes: string | null; itcClaimedPaise: number;
    className: string; method: 'slm' | 'wdv'; usefulLifeYears: number; residualValuePaise: number | null; residualPct: number;
    openingAccumulatedPaise: number; vendorName: string | null; billNo: string | null; invoiceNo: string | null;
  };
  costs: { id: string; date: string; amountPaise: number; kind: string; description: string | null }[];
  depreciation: { id: string; from: string; to: string; days: number; amountPaise: number; disposal: boolean }[];
  verifications: { id: string; date: string; found: boolean; condition: string | null; location: string | null; notes: string | null; by: string | null }[];
}

export interface DepreciationRunRow {
  id: string; branchId: string | null; branchName: string | null; from: string; to: string;
  totalPaise: number; reversed: boolean; entryId: string | null;
}

export interface ItBlockRow {
  block: string; ratePct: number; openingPaise: number; additionsFullPaise: number; additionsHalfPaise: number;
  salesPaise: number; depreciationPaise: number; closingPaise: number; shortTermGainPaise: number;
}

export const fixedAssets = {
  register: (asOf?: string) =>
    api.get<{ asOf: string; assets: AssetRegisterRow[]; classes: AssetClassRow[] }>('/api/fixed-assets', { view: 'register', asOf }),
  get: (id: string) => api.get<AssetDetail>('/api/fixed-assets', { view: 'asset', id }),
  runs: () => api.get<{ runs: DepreciationRunRow[]; next: { branchId: string; branchName: string; from: string | null }[] }>(
    '/api/fixed-assets', { view: 'runs' }),
  preview: (branchId: string, to: string) => api.get<{
    branchId: number; from: string; to: string; totalPaise: number;
    lines: { assetId: string; tag: string; name: string; from: string; days: number; amountPaise: number }[];
  }>('/api/fixed-assets', { view: 'preview', branchId, to }),
  it: (fy: number) => api.get<{ fy: number; blocks: ItBlockRow[] }>('/api/fixed-assets', { view: 'it', fy }),
  saleAdvice: (id: string, date: string) =>
    api.get<{ itcClaimedPaise: number; minimumTaxPaise: number }>('/api/fixed-assets', { view: 'sale-advice', id, date }),
  act: <T = { ok: true }>(input: Record<string, unknown>) => api.post<T>('/api/fixed-assets', input),
};

export const accounts = {
  list: (params?: { type?: string; search?: string; inactive?: boolean; asOf?: string }) =>
    api.get<{ accounts: AccountRow[] }>('/api/accounts', params),
  create: (input: unknown) => api.post<{ id: string; code: string; name: string }>('/api/accounts', input),
  update: (input: unknown) => api.patch<{ id: string }>('/api/accounts', input),
  remove: (id: string) => api.delete<{ id: string }>(`/api/accounts?id=${encodeURIComponent(id)}`),
};

// ── Audit trail ──────────────────────────────────────────────────────────────

export interface AuditEventRow {
  id: string;
  at: string;
  actorUserId: string | null;
  actorName: string;
  action: string;
  targetType: string;
  targetId: string | null;
  targetLabel: string;
  detail: string;
  ip: string | null;
  /** For an edit: each field that changed, with its old and new value. */
  changes: Record<string, { from: unknown; to: unknown }> | null;
}

export interface AuditResponse {
  events: AuditEventRow[];
  targetTypes: { value: string; count: number }[];
  total: number;
  /** The database refuses edits and deletes of the trail and the journal. */
  databaseProtected: boolean;
}

export const audit = {
  list: (params?: {
    targetType?: string; action?: string; actorUserId?: string;
    from?: string; to?: string; search?: string; limit?: number; offset?: number;
  }) => api.get<AuditResponse>('/api/audit', params),
};

// ── Period locks ─────────────────────────────────────────────────────────────

export interface TransactionLockRow {
  module: 'sales' | 'purchases' | 'banking' | 'accountant';
  id: string | null;
  lockedUpto: string | null;
  reason: string | null;
  lockedBy: string | null;
  updatedAt: string | null;
  protectedEntries: number;
}

export const transactionLocks = {
  list: () => api.get<{ locks: TransactionLockRow[] }>('/api/transaction-locks'),
  set: (module: string, lockedUpto: string | null, reason?: string | null) =>
    api.put<{ module: string; lockedUpto: string | null }>('/api/transaction-locks', {
      module, lockedUpto, reason,
    }),
};

// ── Budgets ──────────────────────────────────────────────────────────────────

export interface BudgetRow {
  id: string;
  accountId: string;
  code: string;
  name: string;
  type: string;
  budgetPaise: number;
  actualPaise: number;
  variancePaise: number;
  pct: number;
  notes: string | null;
}

export interface BudgetResponse {
  fy: string;
  from: string;
  to: string;
  asOf: string;
  /** How far through the financial year the comparison runs. */
  elapsedPct: number;
  rows: BudgetRow[];
  totals: { budgetPaise: number; actualPaise: number };
}

export const budgets = {
  list: (params?: { fy?: string; asOf?: string }) => api.get<BudgetResponse>('/api/budgets', params),
  set: (fy: string, entries: { accountId: string; amountPaise: number; notes?: string | null }[]) =>
    api.put<{ fy: string; updated: number }>('/api/budgets', { fy, entries }),
};

// ── Period close ─────────────────────────────────────────────────────────────

export interface PeriodCheck {
  id: string;
  label: string;
  detail: string;
  count: number;
  href: string;
  blocking: boolean;
}

export interface PeriodCloseResponse {
  from: string;
  to: string;
  checks: PeriodCheck[];
  passed: number;
  blockers: number;
}

export const periodClose = {
  status: (from: string, to: string) =>
    api.get<PeriodCloseResponse>('/api/period-close', { from, to }),
};

// ── Recurring journals ───────────────────────────────────────────────────────

export interface RecurringJournalRow {
  id: string;
  name: string;
  frequency: 'monthly' | 'quarterly' | 'yearly';
  nextRun: string;
  endDate: string | null;
  debitAccountId: string;
  debitCode: string;
  debitName: string;
  creditAccountId: string;
  creditCode: string;
  creditName: string;
  amountPaise: number;
  memo: string | null;
  isActive: boolean;
  /** Run by the scheduler on its dates. */
  autoRun: boolean;
  /** What stopped the scheduler last time, if anything. */
  lastError: string | null;
  lastPostedAt: string | null;
  isDue: boolean;
}

export const recurringJournals = {
  list: () => api.get<{ profiles: RecurringJournalRow[] }>('/api/recurring-journals'),
  create: (input: unknown) => api.post<{ id: string; name: string }>('/api/recurring-journals', input),
  run: (id: string, date?: string) =>
    api.patch<{ id: string; entryId: string; entryNo: number; postedOn: string }>(
      '/api/recurring-journals',
      { action: 'run', id, date },
    ),
  toggle: (id: string, isActive: boolean) =>
    api.patch<{ id: string; isActive: boolean }>('/api/recurring-journals', {
      action: 'toggle', id, isActive,
    }),
  /** Let the scheduler run it on its dates, or keep it to Run now. */
  auto: (id: string, autoRun: boolean) => api.patch<{ id: string }>('/api/recurring-journals', { action: 'auto', id, autoRun }),
  remove: (id: string) => api.delete<{ id: string }>(`/api/recurring-journals?id=${encodeURIComponent(id)}`),
};

// ── MSME tracker ─────────────────────────────────────────────────────────────

export interface MsmeBillRow {
  billId: string;
  internalNo: string;
  vendorInvoiceNo: string;
  vendorId: string;
  vendorName: string;
  udyamNo: string | null;
  date: string;
  /** The last day to pay without losing the deduction. */
  deadline: string;
  /** 15 without a written agreement; the agreed period otherwise, at most 45. */
  limitDays: number;
  writtenAgreement: boolean;
  categoryKnown: boolean;
  age: number;
  daysLeft: number;
  balancePaise: number;
  totalPaise: number;
  risk: 'breached' | 'critical' | 'safe';
}

export interface MsmeTrackerResponse {
  asOf: string;
  items: MsmeBillRow[];
  summary: {
    breached: number;
    critical: number;
    safe: number;
    atRiskPaise: number;
    totalOwedPaise: number;
    noAgreement: number;
    categoryUnknown: number;
  };
}

export interface MsmeDisallowanceResponse {
  fy: string; yearEnd: string; asOf: string; provisional: boolean;
  rows: {
    billId: string; internalNo: string; vendorName: string; date: string; deadline: string;
    owedAtYearEndPaise: number; paidInTimePaise: number; disallowedPaise: number; stillOwedPaise: number;
  }[];
  totalDisallowedPaise: number;
  allowedThisYear: { billId: string; internalNo: string; vendorName: string; paidPaise: number }[];
  totalAllowedThisYearPaise: number;
}

export interface Msme1Response {
  halfEnd: string; period: string; dueBy: string; totalPaise: number;
  rows: {
    vendorId: string; vendorName: string; pan: string | null; udyamNo: string | null; amountDuePaise: number;
    bills: { internalNo: string; date: string; dueFrom: string; amountPaise: number }[];
  }[];
}

export const msmeTracker = {
  list: () => api.get<MsmeTrackerResponse>('/api/msme-tracker'),
  disallowance: (fy?: number) => api.get<MsmeDisallowanceResponse>('/api/msme-tracker', { view: 'disallowance', fy }),
  msme1: (halfEnd?: string) => api.get<Msme1Response>('/api/msme-tracker', { view: 'msme1', halfEnd }),
};

// ── GST ──────────────────────────────────────────────────────────────────────

export interface Gstr1Row {
  id: string;
  number: string;
  date: string;
  customerName: string;
  gstin: string | null;
  placeOfSupply: string;
  supplyType: string;
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  cessPaise: number;
  totalPaise: number;
  reason?: string;
  againstNumber?: string | null;
  irnStatus?: string;
}

export interface Gstr1Response {
  view: 'gstr1';
  period: { month: string; from: string; to: string };
  gstin: string | null;
  b2b: Gstr1Row[];
  b2cl: Gstr1Row[];
  b2cs: Gstr1Row[];
  exports: Gstr1Row[];
  creditNotes: Gstr1Row[];
  hsn: { code: string; description: string | null; uqc: string; qty: number; taxablePaise: number; taxPaise: number }[];
  totals: { taxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number; cessPaise: number };
  documentSummary: { from: string; to: string; total: number; cancelled: number };
  issues: { level: 'error' | 'warning'; message: string }[];
  invoiceCount: number;
}

export interface Gstr3bResponse {
  view: 'gstr3b';
  period: { month: string; from: string; to: string };
  gstin: string | null;
  /** Net of credit notes issued in the month. */
  outward: { taxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number; cessPaise: number };
  /** GST on advances for services, already inside outward: paid on arrival, taken back when applied. */
  advances: { receivedTaxPaise: number; adjustedTaxPaise: number };
  inwardRcm: { taxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number; cessPaise: number };
  itc: {
    cgstPaise: number; sgstPaise: number; igstPaise: number; cessPaise: number;
    blockedPaise: number; reversedPaise: number;
    reversedRule42Paise?: number; reversedRule37Paise?: number; reclaimedPaise?: number;
  };
  setOff: {
    head: 'IGST' | 'CGST' | 'SGST' | 'CESS';
    liabilityPaise: number;
    /** Owed under reverse charge: always cash, never credit. */
    rcmPaise: number;
    creditUsedPaise: number;
    cashPaise: number;
  }[];
  totalCashPaise: number;
}

/** A retry the app queued after the portal did not answer: when, and which try of how many. */
export interface QueuedRetry {
  at: string;
  attempt: number;
  of: number;
}

export interface EinvoiceRow {
  id: string;
  invoiceId: string;
  number: string;
  date: string;
  customerName: string;
  gstin: string | null;
  totalPaise: number;
  status: string;
  irn: string | null;
  ackNo: string | null;
  ackDate: string | null;
  /** While the IRN can still be cancelled, when that ends (ISO); otherwise null. */
  cancelUntil: string | null;
  /** A retry queued after the portal did not answer. */
  retry: QueuedRetry | null;
  errorMessage: string | null;
  attempts: number;
  daysLeft: number;
}

/** How far a registration is from registering invoices with the real portal. */
export interface PortalReadinessStep {
  key: 'server' | 'details' | 'credentials' | 'login' | 'first_irn';
  done: boolean;
  todo: string[];
}

export interface BranchPortalReadiness {
  branchId: string;
  name: string;
  gstin: string | null;
  provider: string;
  providerLabel: string;
  environment: 'stand-in' | 'sandbox' | 'production';
  steps: PortalReadinessStep[];
  realIrns: number;
  lastVerifiedAt: string | null;
  lastError: string | null;
}

export interface PortalReadiness {
  connected: boolean;
  filing: boolean;
  branches: BranchPortalReadiness[];
}

export interface EwayBillRow {
  id: string | null;
  /**
   * Goods move on two kinds of document, and only one of them is a sale. A
   * challan covers job work, branch transfers and goods out on approval — no
   * invoice, no revenue, and still a lorry that has to be declared.
   */
  docKind: 'invoice' | 'challan';
  docId: string;
  /** Null on a challan row. Use `docKind` and `docId` to address the document. */
  invoiceId: string | null;
  number: string;
  date: string;
  customerName: string;
  placeOfSupply: string;
  totalPaise: number;
  ewayBillNo: string | null;
  status: string;
  vehicleNo: string | null;
  transporterName: string | null;
  distanceKm: number | null;
  /** ISO. Validity runs to midnight of the last day. */
  validUntil: string | null;
  /** ISO, once generated. */
  generatedAt: string | null;
  transportMode: 'road' | 'rail' | 'air' | 'ship';
  extendedCount: number;
  /** Why the last attempt failed, while it stands failed. */
  errorMessage: string | null;
  /** While the bill can still be cancelled, when that ends (ISO). */
  cancelUntil: string | null;
  /** Whether validity can be extended right now, and if not, why. */
  extension: { allowed: boolean; reason: string } | null;
  /** Whether the vehicle can be changed now: generated and not expired. */
  changeable: boolean;
  /** A retry queued after the portal did not answer. */
  retry: QueuedRetry | null;
  /**
   * Whether a bill is actually required, after the state's own threshold and
   * the no-threshold cases. A row can be listed and not required.
   */
  required: boolean;
  requirementReason: string;
  /** Reasons one cannot be generated even though it is needed. */
  blockers: string[];
}

export interface EwayBillCheckResponse {
  label: string;
  assessment: {
    required: boolean;
    reason: string;
    thresholdPaise: number | null;
    blockers: string[];
    warnings: string[];
  };
  missing: string[];
  existingNo: string | null;
  provider: string;
  live: boolean;
}

export interface EinvoicePreviewResponse {
  invoiceId: string;
  number: string;
  payload: unknown;
  preflight: {
    ok: boolean;
    errors: { field: string; message: string; severity: string }[];
    warnings: { field: string; message: string; severity: string }[];
  };
  provider: string;
  live: boolean;
  connected: boolean;
}

export interface ItcMatchRow {
  id: string | null;
  vendorGstin: string;
  vendorName: string | null;
  recipientGstin: string | null;
  docType: 'invoice' | 'credit_note' | 'debit_note';
  invoiceNo: string;
  invoiceDate: string;
  portalTaxPaise: number;
  booksTaxPaise: number;
  differencePaise: number;
  matchStatus: 'matched' | 'mismatch' | 'missing_in_books' | 'missing_in_portal';
  billId: string | null;
  billNo: string | null;
  itcAvailable: boolean;
  isReverseCharge: boolean;
  /** Null: no action in IMS, which the portal deems accepted. */
  imsAction: 'accepted' | 'rejected' | 'pending' | null;
  imsNote: string | null;
}

export const gstr2b = {
  /** The parsed contents of the GSTR-2B JSON file downloaded from the portal. */
  import: (file: unknown) =>
    api.post<{ inserted: number; updated: number; skipped: string[]; returnPeriod: string; gstin: string }>(
      '/api/gst/gstr2b', { action: 'import', file },
    ),
  ims: (ids: string[], imsAction: 'accepted' | 'rejected' | 'pending' | null, note?: string) =>
    api.post<{ updated: number }>('/api/gst/gstr2b', { action: 'ims', ids, imsAction, note }),
};

export interface TdsResponse {
  view: 'tds';
  from: string;
  to: string;
  deducted: {
    section: string; vendorName: string; vendorId: string; pan: string | null;
    billCount: number; taxablePaise: number; tdsPaise: number; ratePct: number;
  }[];
  deductedTotalPaise: number;
  withheldByCustomersPaise: number;
  withheldRows: {
    paymentId: string; number: string; date: string;
    customerName: string; tdsPaise: number; amountPaise: number;
  }[];
}

export interface TaxHeadsRow {
  taxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number; cessPaise: number;
}

export interface IffResponse {
  view: 'iff';
  period: { month: string; from: string; to: string };
  gstin: string | null;
  b2b: Gstr1Row[];
  cdnr: Gstr1Row[];
  totals: { b2b: TaxHeadsRow; cdnr: TaxHeadsRow };
  issues: { level: 'error' | 'warning'; message: string }[];
}

export interface HsnSummaryRow {
  code: string; uqc: string; qty: number; ratePct: number;
  taxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number; cessPaise: number;
}

export interface Gstr9Response {
  view: 'gstr9';
  fy: string;
  from: string;
  to: string;
  gstin: string | null;
  table4: {
    b2c: TaxHeadsRow; b2b: TaxHeadsRow; exportsWithTax: TaxHeadsRow; sezWithTax: TaxHeadsRow; advances: TaxHeadsRow;
    rcmInward: TaxHeadsRow; creditNotes: TaxHeadsRow; total: TaxHeadsRow;
  };
  table5: { exportsLut: number; sezLut: number; exemptOrNil: number; creditNotes: number; total: number };
  table6: {
    inputs: TaxHeadsRow; capitalGoods: TaxHeadsRow; inputServices: TaxHeadsRow;
    rcmUnregistered: TaxHeadsRow; rcmRegistered: TaxHeadsRow; total: TaxHeadsRow;
  };
  table7: { vendorCreditsPaise: number };
  table8: { asPer2b: TaxHeadsRow; asPerBooks: TaxHeadsRow; difference: TaxHeadsRow };
  table9: { head: 'IGST' | 'CGST' | 'SGST' | 'CESS'; payablePaise: number; paidThroughItcPaise: number; paidInCashPaise: number }[];
  table17: HsnSummaryRow[];
  table18: HsnSummaryRow[];
  notes: string[];
}

export interface Gstr9cLine { ref: string; label: string; paise: number; source: 'books' | 'return' | 'preparer' | 'total' }
export interface Gstr9cReason { source: string; label: string; paise: number }

export interface Gstr9cResponse {
  view: 'gstr9c';
  fy: string; from: string; to: string; gstin: string | null;
  table5: Gstr9cLine[];
  table6: Gstr9cReason[];
  table7: Gstr9cLine[];
  table9: {
    byRate: { ratePct: number; taxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number; cessPaise: number }[];
    heads: { head: 'IGST' | 'CGST' | 'SGST' | 'CESS'; booksPaise: number; returnPaise: number; unreconciledPaise: number }[];
    outsideDocuments: Gstr9cReason[];
  };
  table12: Gstr9cLine[];
  table14: { accountId: string; code: string; name: string; itcPaise: number }[];
  unreconciled: { turnoverPaise: number; taxableTurnoverPaise: number; taxPaise: number; itcPaise: number };
  notes: string[];
}

export const gst = {
  gstr1: (period: string, branchId?: string) =>
    api.get<Gstr1Response>('/api/gst', { view: 'gstr1', period, branchId }),
  gstr3b: (period: string, branchId?: string) =>
    api.get<Gstr3bResponse>('/api/gst', { view: 'gstr3b', period, branchId }),
  iff: (period: string, branchId?: string) => api.get<IffResponse>('/api/gst', { view: 'iff', period, branchId }),
  /** The file the portal's Prepare offline → Upload takes, built from the invoice lines. */
  gstr1File: (period: string, scope: 'gstr1' | 'iff' = 'gstr1', branchId?: string) =>
    api.get<Record<string, unknown>>('/api/gst', { view: 'gstr1-file', period, scope, branchId }),
  /** `fy` is the year the financial year starts in: 2026 for 2026-27. */
  gstr9: (fy: number, branchId?: string) => api.get<Gstr9Response>('/api/gst', { view: 'gstr9', fy, branchId }),
  /** The reconciliation statement: the books beside GSTR-9. */
  gstr9c: (fy: number, branchId?: string) => api.get<Gstr9cResponse>('/api/gst', { view: 'gstr9c', fy, branchId }),
  einvoices: (status?: string) =>
    api.get<{ einvoices: EinvoiceRow[]; statusCounts: Record<string, number>; portal: PortalReadiness }>('/api/gst', {
      view: 'einvoices', status,
    }),
  ewayBills: () => api.get<{ ewayBills: EwayBillRow[] }>('/api/gst', { view: 'eway-bills' }),
  itc: (period: string) =>
    api.get<{ period: string; rows: ItcMatchRow[]; summary: Record<string, number> & { atRiskPaise: number } }>(
      '/api/gst',
      { view: 'itc', period },
    ),
  tds: (from?: string, to?: string) => api.get<TdsResponse>('/api/gst', { view: 'tds', from, to }),
  /** Build and check an invoice without submitting it — costs no attempt. */
  einvoicePreview: (invoiceId: string) =>
    api.get<EinvoicePreviewResponse>('/api/gst', { view: 'einvoice-preview', invoiceId }),
  ewayCheck: (doc: { docKind: 'invoice' | 'challan'; docId: string }) =>
    api.get<EwayBillCheckResponse>('/api/gst', {
      view: 'eway-check',
      invoiceId: doc.docKind === 'invoice' ? doc.docId : undefined,
      challanId: doc.docKind === 'challan' ? doc.docId : undefined,
    }),
  submitEinvoice: (invoiceId: string) =>
    api.post<{
      irn: string;
      ackNo: string;
      status: string;
      provider: string;
      /** False when nothing was actually filed with any portal. */
      live: boolean;
      warnings: string[];
      /** Set when the portal issued an e-way bill from the same call. */
      ewayBillNo: string | null;
    }>('/api/gst', { action: 'submit-einvoice', invoiceId }),
  /** Cancel an IRN within 24 hours of issue. The invoice is voided with it. */
  cancelEinvoice: (invoiceId: string, reason: '1' | '2' | '3' | '4', remark: string) =>
    api.post<{ irn: string; cancelledAt: string; provider: string; live: boolean; recovered: boolean }>(
      '/api/gst',
      { action: 'cancel-einvoice', invoiceId, reason, remark },
    ),
  generateEwayBill: (input: {
    /** Exactly one of these. A challan moves goods just as an invoice does. */
    invoiceId?: string;
    challanId?: string;
    vehicleNo?: string | null;
    transporterId?: string | null;
    transporterName?: string | null;
    transportDocNo?: string | null;
    transportDocDate?: string | null;
    distanceKm?: number | null;
    transportMode?: 'road' | 'rail' | 'air' | 'ship';
    isOverDimensional?: boolean;
  }) =>
    api.post<{
      ewayBillNo: string;
      status: string;
      /** yyyy-mm-dd HH:mm:ss. Runs to midnight of the last day. */
      validUntil: string;
      provider: string;
      live: boolean;
      assessment: { required: boolean; reason: string };
    }>('/api/gst', { action: 'generate-eway-bill', ...input }),
  /** A new vehicle for a bill still valid: Part B again. The expiry does not move. */
  changeEwayVehicle: (input: {
    ewayBillId: string;
    vehicleNo?: string | null;
    transportMode?: 'road' | 'rail' | 'air' | 'ship';
    transportDocNo?: string | null;
    transportDocDate?: string | null;
    fromPlace: string;
    reason: '1' | '2' | '3' | '4';
    remark?: string;
  }) =>
    api.post<{
      ewayBillNo: string;
      vehicleNo: string | null;
      validUntil: string | null;
      extendedCount: number;
      provider: string;
      live: boolean;
    }>('/api/gst', { action: 'update-eway-vehicle', ...input }),
  /** More time, only in the 8 hours either side of expiry. */
  extendEwayBill: (input: {
    ewayBillId: string;
    remainingDistanceKm: number;
    fromPlace: string;
    fromPincode: string;
    reason: '1' | '2' | '4' | '5' | '99';
    remark?: string;
    consignment: 'in_movement' | 'in_transit';
    vehicleNo?: string | null;
  }) =>
    api.post<{
      ewayBillNo: string;
      vehicleNo: string | null;
      validUntil: string;
      extendedCount: number;
      provider: string;
      live: boolean;
    }>('/api/gst', { action: 'extend-eway-bill', ...input }),
  /** Within 24 hours of generation. The document itself is not touched. */
  cancelEwayBill: (ewayBillId: string, reason: '1' | '2' | '3' | '4', remark: string) =>
    api.post<{ ewayBillNo: string; cancelledAt: string; provider: string; live: boolean; recovered: boolean }>(
      '/api/gst',
      { action: 'cancel-eway-bill', ewayBillId, reason, remark },
    ),
};

// ── Recurring invoices ───────────────────────────────────────────────────────

export interface RecurringInvoiceRow {
  id: string;
  name: string;
  customerId: string;
  customerName: string;
  frequency: 'weekly' | 'monthly' | 'quarterly' | 'yearly';
  startDate: string;
  endDate: string | null;
  nextRun: string;
  paymentTerms: string | null;
  autoSend: boolean;
  isActive: boolean;
  /** Run by the scheduler on its dates. */
  autoRun: boolean;
  /** What stopped the scheduler last time, if anything. */
  lastError: string | null;
  lastGeneratedAt: string | null;
  lineCount: number;
  taxablePaise: number;
  totalPaise: number;
  isDue: boolean;
}

export const recurringInvoices = {
  list: () => api.get<{ profiles: RecurringInvoiceRow[] }>('/api/recurring-invoices'),
  create: (input: unknown) => api.post<{ id: string; name: string }>('/api/recurring-invoices', input),
  run: (id: string, date?: string) =>
    api.patch<{ id: string; invoiceId: string; number: string; totalPaise: number; autoSent: boolean }>(
      '/api/recurring-invoices',
      { action: 'run', id, date },
    ),
  toggle: (id: string, isActive: boolean) =>
    api.patch<{ id: string; isActive: boolean }>('/api/recurring-invoices', {
      action: 'toggle', id, isActive,
    }),
  /** Let the scheduler run it on its dates, or keep it to Run now. */
  auto: (id: string, autoRun: boolean) => api.patch<{ id: string }>('/api/recurring-invoices', { action: 'auto', id, autoRun }),
  remove: (id: string) => api.delete<{ id: string }>(`/api/recurring-invoices?id=${encodeURIComponent(id)}`),
};

// ── Inventory ────────────────────────────────────────────────────────────────

export interface StockRow {
  itemId: string;
  name: string;
  sku: string | null;
  uqc: string;
  openingQty: number;
  boughtQty: number;
  soldQty: number;
  /** Taken back on credit notes. */
  returnedQty: number;
  adjustedQty: number;
  qty: number;
  reorderLevel: number;
  minLevel: number;
  altUqc: string | null;
  altFactor: number | null;
  unitCostPaise: number;
  valuePaise: number;
  standardCostPaise: number | null;
  varianceValuePaise: number | null;
  stockGroupId: string | null;
  valuation: 'average' | 'fifo';
}

export interface StockResponse {
  view: 'stock';
  asOf: string;
  items: StockRow[];
  summary: {
    totalValuePaise: number;
    lowStock: number;
    belowMinimum: number;
    outOfStock: number;
    negative: number;
    tracked: number;
  };
}

export interface StockAdjustmentRow {
  id: string;
  date: string;
  itemId: string;
  itemName: string;
  sku: string | null;
  uqc: string;
  qtyDelta: number;
  reason: string;
  notes: string | null;
  warehouseName: string | null;
  userName: string | null;
  valuePaise: number;
  journalEntryId: string | null;
}

export interface WarehouseRow {
  id: string;
  name: string;
  code: string | null;
  address: string | null;
  branchId: string | null;
  branchName: string | null;
  isPrimary: boolean;
  isActive: boolean;
}

export const inventory = {
  stock: () => api.get<StockResponse>('/api/inventory', { view: 'stock' }),
  adjustments: (itemId?: string) =>
    api.get<{ adjustments: StockAdjustmentRow[] }>('/api/inventory', { view: 'adjustments', itemId }),
  warehouses: () => api.get<{ warehouses: WarehouseRow[] }>('/api/inventory', { view: 'warehouses' }),
  adjust: (input: unknown) =>
    api.post<{ id: string; valuePaise: number; journalEntryId: string | null }>('/api/inventory', input),
  createWarehouse: (input: unknown) => api.put<{ id: string; name: string }>('/api/inventory', input),
};

// ── Reports ──────────────────────────────────────────────────────────────────

export interface AccountBalanceRow {
  accountId: string;
  code: string;
  name: string;
  type: 'asset' | 'liability' | 'equity' | 'income' | 'expense';
  subtype: string | null;
  debitPaise: number;
  creditPaise: number;
  /** Signed in the account's own direction: positive means a normal balance. */
  balancePaise: number;
}

export interface TrialBalanceReport {
  report: 'trial-balance';
  asOf: string;
  rows: (AccountBalanceRow & { debitSide: number; creditSide: number })[];
  totalDebit: number;
  totalCredit: number;
  balanced: boolean;
}

export interface ProfitAndLossReport {
  report: 'profit-and-loss';
  incomeRows: AccountBalanceRow[];
  expenseRows: AccountBalanceRow[];
  totalIncome: number;
  totalExpense: number;
  openingStockPaise: number;
  closingStockPaise: number;
  costOfGoodsSoldPaise: number;
  grossProfit: number;
  netProfit: number;
  from: string;
  to: string;
}

export interface BalanceSheetReport {
  report: 'balance-sheet';
  assetRows: AccountBalanceRow[];
  liabilityRows: AccountBalanceRow[];
  equityRows: AccountBalanceRow[];
  totalAssets: number;
  totalLiabilities: number;
  totalEquity: number;
  closingStockPaise: number;
  priorYearsEarnings: number;
  currentPeriodEarnings: number;
  fyStart: string;
  balanced: boolean;
  asOf: string;
}

export interface GeneralLedgerReport {
  report: 'general-ledger';
  account: { id: string; code: string; name: string; type: string };
  from: string;
  to: string;
  openingPaise: number;
  closingPaise: number;
  lines: {
    entryId: string; entryNo: number; date: string; memo: string | null;
    description: string | null; sourceType: string; sourceId: string | null; debitPaise: number;
    creditPaise: number; runningPaise: number; contactName: string | null;
  }[];
}

export interface AgeingReport {
  report: 'ar-ageing' | 'ap-ageing';
  asOf: string;
  side: 'receivable' | 'payable';
  rows: { contactId: string; name: string; buckets: Record<string, number>; totalPaise: number }[];
  totals: Record<string, number>;
  grandTotalPaise: number;
}

export const AGEING_BUCKETS = ['Current', '1–15', '16–30', '31–45', '46–60', '60+'] as const;

// ── Analysis reports ─────────────────────────────────────────────────────────
//
// The statements above say what the books hold. These say what that means —
// who owes what, which items sell, how fast money arrives. Every one is an
// aggregate over the same journal and documents, so none can contradict a
// statement.

interface Period { from: string; to: string }

export interface PartyBalanceRow {
  contactId: string;
  name: string;
  gstin: string | null;
  isMsme: boolean;
  invoicedPaise: number;
  receivedPaise: number;
  outstandingPaise: number;
  documentCount: number;
}

export interface SalesByRow {
  key: string;
  name: string;
  /** GSTIN for a party, SKU for an item, email for a salesperson. */
  detail: string | null;
  taxablePaise: number;
  taxPaise: number;
  totalPaise: number;
  qty: number;
  count: number;
}

export interface PartyBalancesReport extends Period {
  report: 'customer-balances' | 'vendor-balances';
  rows: PartyBalanceRow[];
}

export interface SalesByReport extends Period {
  report: 'sales-by-customer' | 'sales-by-item' | 'sales-by-salesperson' | 'purchases-by-vendor';
  rows: SalesByRow[];
}

export interface ExpensesByCategoryReport extends Period {
  report: 'expenses-by-category';
  rows: { accountId: string; code: string; name: string; amountPaise: number; count: number }[];
}

export interface AccountTypeSummaryReport {
  report: 'account-type-summary';
  asOf: string;
  rows: {
    type: string; accounts: number; totalAccounts: number;
    debitPaise: number; creditPaise: number; netPaise: number;
  }[];
}

export interface CashFlowReport extends Period {
  report: 'cash-flow';
  openingPaise: number;
  closingPaise: number;
  operatingPaise: number;
  investingPaise: number;
  financingPaise: number;
  rows: { label: string; group: string; amountPaise: number }[];
}

export interface BusinessRatiosReport extends Period {
  report: 'business-ratios';
  ratios: {
    key: string; label: string; value: number;
    unit: 'pct' | 'ratio' | 'days'; explain: string; good: boolean | null;
  }[];
}

export interface MovementOfEquityReport extends Period {
  report: 'movement-of-equity';
  opening: number;
  closing: number;
  rows: { label: string; amountPaise: number }[];
}

export interface RefundHistoryReport extends Period {
  report: 'refund-history';
  rows: {
    id: string; direction: 'out' | 'in'; date: string; number: string;
    party: string; reason: string; againstNumber: string | null;
    amountPaise: number; bankName: string | null;
  }[];
}

export interface TimeToGetPaidReport extends Period {
  report: 'time-to-get-paid';
  rows: {
    invoiceId: string; number: string; customer: string; date: string;
    dueDate: string; settledOn: string; days: number; vsTerms: number; totalPaise: number;
  }[];
  averageDays: number;
  onTimePct: number;
}

export interface ScheduleIIILine {
  key: string;
  group?: string;
  label: string;
  currentPaise: number;
  previousPaise: number;
  accounts: { accountId: string; code: string; name: string; currentPaise: number; previousPaise: number }[];
}

export interface ScheduleIIIAgeing {
  buckets: string[];
  rows: { category: string; amounts: number[]; totalPaise: number }[];
  totalPaise: number;
}

export interface ScheduleIIIBalanceSheetReport {
  report: 'schedule-iii-balance-sheet';
  asOf: string;
  previousAsOf: string;
  equityAndLiabilities: ScheduleIIILine[];
  assets: ScheduleIIILine[];
  totals: { equityAndLiabilities: [number, number]; assets: [number, number] };
  msmePayablesPaise: number;
  receivablesAgeing: ScheduleIIIAgeing;
  payablesAgeing: ScheduleIIIAgeing;
  balanced: boolean;
}

export interface ScheduleIIIProfitAndLossReport {
  report: 'schedule-iii-profit-and-loss';
  from: string;
  to: string;
  previous: { from: string; to: string };
  income: ScheduleIIILine[];
  expenses: ScheduleIIILine[];
  totalIncome: [number, number];
  totalExpenses: [number, number];
  profitBeforeTax: [number, number];
  profitForThePeriod: [number, number];
}

export const reports = {
  scheduleIIIBalanceSheet: (to: string, branchId?: string) =>
    api.get<ScheduleIIIBalanceSheetReport>('/api/reports', { report: 'schedule-iii-balance-sheet', to, branchId }),
  scheduleIIIProfitAndLoss: (from: string, to: string, branchId?: string) =>
    api.get<ScheduleIIIProfitAndLossReport>('/api/reports', { report: 'schedule-iii-profit-and-loss', from, to, branchId }),
  trialBalance: (to: string, branchId?: string) =>
    api.get<TrialBalanceReport>('/api/reports', { report: 'trial-balance', to, branchId }),
  profitAndLoss: (from: string, to: string, branchId?: string) =>
    api.get<ProfitAndLossReport>('/api/reports', { report: 'profit-and-loss', from, to, branchId }),
  balanceSheet: (to: string, branchId?: string) =>
    api.get<BalanceSheetReport>('/api/reports', { report: 'balance-sheet', to, branchId }),
  generalLedger: (accountId: string, from: string, to: string) =>
    api.get<GeneralLedgerReport>('/api/reports', { report: 'general-ledger', accountId, from, to }),
  ageing: (side: 'ar' | 'ap', to: string) =>
    api.get<AgeingReport>('/api/reports', { report: side === 'ar' ? 'ar-ageing' : 'ap-ageing', to }),

  partyBalances: (side: 'customer' | 'vendor', from: string, to: string) =>
    api.get<PartyBalancesReport>('/api/reports', {
      report: side === 'customer' ? 'customer-balances' : 'vendor-balances', from, to,
    }),
  salesBy: (by: 'customer' | 'item' | 'salesperson', from: string, to: string) =>
    api.get<SalesByReport>('/api/reports', { report: `sales-by-${by}`, from, to }),
  purchasesByVendor: (from: string, to: string) =>
    api.get<SalesByReport>('/api/reports', { report: 'purchases-by-vendor', from, to }),
  expensesByCategory: (from: string, to: string) =>
    api.get<ExpensesByCategoryReport>('/api/reports', { report: 'expenses-by-category', from, to }),
  accountTypeSummary: (from: string, to: string) =>
    api.get<AccountTypeSummaryReport>('/api/reports', { report: 'account-type-summary', from, to }),
  cashFlow: (from: string, to: string) =>
    api.get<CashFlowReport>('/api/reports', { report: 'cash-flow', from, to }),
  businessRatios: (from: string, to: string) =>
    api.get<BusinessRatiosReport>('/api/reports', { report: 'business-ratios', from, to }),
  movementOfEquity: (from: string, to: string) =>
    api.get<MovementOfEquityReport>('/api/reports', { report: 'movement-of-equity', from, to }),
  timeToGetPaid: (from: string, to: string) =>
    api.get<TimeToGetPaidReport>('/api/reports', { report: 'time-to-get-paid', from, to }),
  refundHistory: (from: string, to: string) =>
    api.get<RefundHistoryReport>('/api/reports', { report: 'refund-history', from, to }),
};

export interface JournalLineRow {
  lineNo: number;
  accountId: string;
  accountCode: string;
  accountName: string;
  description: string | null;
  contactName: string | null;
  debitPaise: number;
  creditPaise: number;
}

export interface JournalEntryRow {
  id: string;
  entryNo: number;
  date: string;
  memo: string | null;
  sourceType: string;
  sourceId: string | null;
  reversalOf: string | null;
  totalDebitPaise: number;
  totalCreditPaise: number;
  postedAt: string;
  lines: JournalLineRow[];
}

export interface JournalResponse {
  entries: JournalEntryRow[];
  summary: { count: number; totalDebitPaise: number };
}

export const journal = {
  list: (params?: {
    entryId?: string; from?: string; to?: string; sourceType?: string;
    accountId?: string; search?: string; limit?: number; offset?: number;
  }) => api.get<JournalResponse>('/api/journal', params),
  create: (input: unknown) =>
    api.post<
      | { held: false; id: string; entryNo: number; totalDebitPaise: number }
      | { held: true; heldId: string; kind: HeldJournalKind; approverRole: ApproverRole | null }
    >('/api/journal', input),
  reverse: (entryId: string, memo?: string) =>
    api.patch<{ id: string; entryNo: number }>('/api/journal', { entryId, memo }),
};

export type HeldJournalKind = 'optional' | 'post_dated' | 'approval';

export interface HeldJournalRow {
  id: string;
  kind: HeldJournalKind;
  date: string;
  memo: string;
  reverseOn: string | null;
  totalPaise: number;
  createdBy: string | null;
  createdById: string | null;
  createdAt: string;
  /** What stopped the scheduler posting it, if anything. */
  lastError: string | null;
  lines: { accountId: string; accountCode: string; accountName: string; debitPaise: number; creditPaise: number; description: string | null }[];
}

/** Journals held out of the books: optional, post-dated, or waiting for approval. */
export const heldJournals = {
  list: () => api.get<{ held: HeldJournalRow[] }>('/api/held-journals'),
  post: (id: string) => api.post<{ id: string; status: 'posted' | 'approval'; entryNo?: number; approverRole?: ApproverRole }>('/api/held-journals', { action: 'post', id }),
  discard: (id: string, reason?: string) => api.post<{ id: string; status: 'discarded' }>('/api/held-journals', { action: 'discard', id, reason }),
};

export const masters = {
  load: (params?: { date?: string; branchId?: string }) =>
    api.get<Record<string, never[]> & { nextInvoiceNumber: string | null }>('/api/masters', params),
};

// ── Navigation and search ────────────────────────────────────────────────────

export interface NavCounts {
  einvoicePending: number;
  unmatched: number;
  msmeRisk: number;
  complianceDue: number;
}

export const navCounts = {
  load: () => api.get<NavCounts>('/api/nav-counts'),
};

export interface SearchResponse {
  invoices: {
    id: string; number: string; party: string; date: string;
    totalPaise: number; status: string;
  }[];
  bills: {
    id: string; number: string; vendorNumber: string | null; party: string;
    date: string; totalPaise: number; status: string;
  }[];
  payments: {
    id: string; number: string; kind: 'received' | 'made'; party: string;
    date: string; totalPaise: number; reference: string | null;
  }[];
  expenses: {
    id: string; number: string; party: string; date: string;
    totalPaise: number; notes: string | null;
  }[];
}

export const search = {
  run: (q: string) => api.get<SearchResponse>('/api/search', { q }),
};

// ── Attachments ──────────────────────────────────────────────────────────────

export type AttachableType =
  | 'invoice' | 'credit_note' | 'estimate' | 'sales_order' | 'challan' | 'bill' | 'expense'
  | 'vendor_credit' | 'purchase_order' | 'payment' | 'journal' | 'contact' | 'organization' | 'tds_certificate'
  | 'goods_receipt' | 'payment_batch' | 'fixed_asset' | 'employee' | 'payroll_run' | 'reimbursement_claim' | 'tax_declaration';

export interface Attachment {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  uploadedBy: string | null;
  uploadedAt: string;
}

export const files = {
  list: (targetType: AttachableType, targetId: string) =>
    api.get<{ attachments: Attachment[] }>('/api/files', { targetType, targetId }),
  upload: (targetType: AttachableType, targetId: string, file: File) => {
    const form = new FormData();
    form.set('targetType', targetType);
    form.set('targetId', targetId);
    form.set('file', file);
    return api.post<{ attachment: Attachment }>('/api/files', form);
  },
  remove: (id: string) => api.delete<{ ok: true }>(`/api/files/${id}`),
  /** Where the browser opens or downloads the file. */
  url: (id: string, download = false) => `/api/files/${id}${download ? '?download=1' : ''}`,
};

// ── Invoice print settings ───────────────────────────────────────────────────

export interface InvoicePrintSettings {
  logoFileId: string | null;
  bankAccountId: string | null;
  upiId: string | null;
  upiPayeeName: string | null;
  showUpiQr: boolean;
  defaultTerms: string | null;
  defaultNotes: string | null;
  signatoryName: string | null;
  printLanguage: string | null;
  orgId: string;
  orgName: string;
  bankAccounts: {
    id: string; name: string; bankName: string | null; last4: string | null;
    accountNumber: string | null; accountHolder: string | null; ifsc: string | null; branchName: string | null;
  }[];
}

export interface InvoicePrintInput {
  bankAccountId: string | null;
  bank: { accountNumber: string; accountHolder: string | null; ifsc: string; branchName: string | null } | null;
  upiId: string | null;
  upiPayeeName: string | null;
  showUpiQr: boolean;
  defaultTerms: string | null;
  defaultNotes: string | null;
  signatoryName: string | null;
  printLanguage?: string | null;
}

export const invoicePrint = {
  get: () => api.get<InvoicePrintSettings>('/api/settings/invoice-print'),
  save: (input: InvoicePrintInput) => api.put<{ ok: true }>('/api/settings/invoice-print', input),
};

// ── Opening balances ─────────────────────────────────────────────────────────

export interface OpeningDocumentRow {
  id: string;
  contactId: string;
  contactName: string;
  kind: 'receivable' | 'payable';
  refNo: string;
  docDate: string;
  dueDate: string;
  amountPaise: number;
  amountPaidPaise: number;
  balancePaise: number;
  status: string;
}

export interface OpeningSummaryResponse {
  startDate: string;
  startDateSet: boolean;
  accounts: {
    accountId: string; code: string; name: string; type: string; netPaise: number; lockedReason: string | null;
  }[];
  receivablesPaise: number;
  payablesPaise: number;
  stockPaise: number;
  equityBalancePaise: number;
  differencePaise: number;
  documents: OpeningDocumentRow[];
}

export const openingBalances = {
  summary: () => api.get<OpeningSummaryResponse>('/api/opening-balances'),
  documents: (params: { contactId?: string; kind?: 'receivable' | 'payable'; open?: boolean }) =>
    api.get<{ documents: OpeningDocumentRow[] }>('/api/opening-balances', { view: 'documents', ...params, open: params.open ? '1' : undefined }),
  setStartDate: (date: string) => api.post<{ ok: true }>('/api/opening-balances', { action: 'start-date', date }),
  setAccounts: (lines: { accountId: string; netPaise: number }[]) =>
    api.post<{ changed: number; entryId: string | null }>('/api/opening-balances', { action: 'accounts', lines }),
  addDocument: (input: {
    contactId: string; kind: 'receivable' | 'payable'; refNo: string; docDate: string; dueDate: string;
    amountPaise: number; notes?: string | null;
  }) => api.post<{ id: string }>('/api/opening-balances', { action: 'document', ...input }),
  voidDocument: (id: string, reason?: string) =>
    api.post<{ ok: true }>('/api/opening-balances', { action: 'void-document', id, reason }),
};

// ── Order flow ───────────────────────────────────────────────────────────────

export type OrderDoc = 'sales_order' | 'challan' | 'purchase_order' | 'goods_receipt';

export interface OrderLine {
  id: string;
  lineNo: number;
  description: string | null;
  uqc: string | null;
  qty: number;
  ratePaise: number;
  /** Left to invoice (sales) or bill (purchases). */
  toInvoice: number;
  /** Left to deliver (sales order) or receive (purchase order). */
  toMove: number | null;
}

export interface LinePick { lineId: string; qty: number; ratePaise?: number }

export interface GoodsReceiptRow {
  id: string;
  number: string;
  date: string;
  status: 'open' | 'partially_billed' | 'billed' | 'cancelled';
  totalPaise: number;
  vendorChallanNo: string | null;
  vendorId: string;
  vendorName: string;
  poId: string | null;
  poNumber: string | null;
}

type MatchResult = { status: 'matched' | 'exception'; note: string | null };
/** A bill or invoice an approval rule caught is saved as a draft, submitted for approval. */
type Held = { heldForApproval: boolean };

export const orderFlow = {
  lines: (doc: OrderDoc, id: string) => api.get<{ lines: OrderLine[] }>('/api/order-lines', { doc, id }),
  invoiceSalesOrder: (id: string, input: { date: string; dueDate: string; lines?: LinePick[] }) =>
    api.patch<{ invoiceId: string; number: string; heldForApproval: boolean }>('/api/sales-documents', { action: 'convert', kind: 'sales-order', id, ...input }),
  invoiceChallan: (id: string, input: { date: string; dueDate: string; lines?: LinePick[] }) =>
    api.patch<{ invoiceId: string; number: string; heldForApproval: boolean }>('/api/sales-documents', { action: 'convert', kind: 'challan', id, ...input }),
  deliver: (id: string, input: { date: string; challanType?: 'supply_on_approval' | 'liquid_gas' | 'other'; lines?: LinePick[] }) =>
    api.patch<{ challanId: string; number: string }>('/api/sales-documents', { action: 'deliver', id, ...input }),
  receive: (poId: string, input: { date: string; vendorChallanNo?: string | null; lines?: LinePick[] }) =>
    api.patch<{ receiptId: string; number: string }>('/api/purchase-documents', { action: 'receive', id: poId, ...input }),
  billPurchaseOrder: (poId: string, input: { vendorInvoiceNo: string; date: string; dueDate: string; lines?: LinePick[] }) =>
    api.patch<{ billId: string; internalNo: string; match: MatchResult } & Held>('/api/purchase-documents', { action: 'convert', id: poId, ...input }),
  receipts: (params?: { status?: string; vendorId?: string }) =>
    api.get<{ receipts: GoodsReceiptRow[] }>('/api/goods-receipts', params),
  billReceipt: (grnId: string, input: { vendorInvoiceNo: string; date: string; dueDate: string; lines?: LinePick[] }) =>
    api.patch<{ billId: string; internalNo: string; match: MatchResult } & Held>('/api/goods-receipts', { action: 'bill', id: grnId, ...input }),
  cancelReceipt: (grnId: string, reason?: string) =>
    api.patch<{ ok: true }>('/api/goods-receipts', { action: 'cancel', id: grnId, reason }),
  acceptBill: (billId: string, reason: string) =>
    api.post<{ id: string }>(`/api/bills/${billId}`, { action: 'accept-match', reason }),
};

// ── Approvals ────────────────────────────────────────────────────────────────

export type ApprovalDoc = 'invoice' | 'bill' | 'journal' | 'payment_batch';
export type ApproverRole = 'admin' | 'accountant' | 'sales' | 'staff';

export interface ApprovalRule {
  id: string;
  documentType: ApprovalDoc;
  thresholdPaise: number;
  approverRole: ApproverRole;
  isActive: boolean;
}

export interface PendingApproval {
  documentType: ApprovalDoc;
  id: string;
  number: string;
  partyName: string;
  date: string;
  totalPaise: number;
  submittedBy: string | null;
  submittedAt: string | null;
  approverRole: ApproverRole | null;
  canApprove: boolean;
}

export const approvals = {
  overview: () => api.get<{ rules: ApprovalRule[]; pending: PendingApproval[]; canEditRules: boolean }>('/api/approvals'),
  history: (doc: ApprovalDoc, id: string) =>
    api.get<{ history: { action: string; note: string | null; by: string | null; at: string }[] }>('/api/approvals', { doc, id }),
  saveRule: (rule: Omit<ApprovalRule, 'id'> & { id?: string | null }) => api.post<{ id: string }>('/api/approvals', { action: 'save-rule', ...rule }),
  deleteRule: (id: string) => api.post<{ id: string }>('/api/approvals', { action: 'delete-rule', id }),
  submit: (doc: ApprovalDoc, id: string) => api.post<{ ok: true }>('/api/approvals', { action: 'submit', doc, id }),
  approve: (doc: ApprovalDoc, id: string, note?: string) => api.post<{ ok: true }>('/api/approvals', { action: 'approve', doc, id, note }),
  reject: (doc: ApprovalDoc, id: string, reason: string) => api.post<{ ok: true }>('/api/approvals', { action: 'reject', doc, id, reason }),
};

// ── Imports ──────────────────────────────────────────────────────────────────

export interface ImportOutcome {
  kind: string;
  rows: number;
  created: number;
  skipped: number;
  errors: { row: number; message: string }[];
  notes: string[];
}

export interface ImportResponse { committed: boolean; outcomes: ImportOutcome[] }

export const imports = {
  rows: (kind: string, rows: Record<string, unknown>[], opts: { dryRun: boolean; onDuplicate?: 'skip' | 'error' }) =>
    api.post<ImportResponse>('/api/imports', { source: 'rows', kind, rows, ...opts }),
  tallyXml: (xml: string, dryRun: boolean) => api.post<ImportResponse>('/api/imports', { source: 'tally-xml', xml, dryRun }),
  tallyCompany: (companyId: string, dryRun: boolean) =>
    api.post<ImportResponse>('/api/imports', { source: 'tally-company', companyId, dryRun }),
  /** A connected company's vouchers, posted as journal entries. */
  tallyVouchers: (companyId: string, from: string | null, to: string | null, dryRun: boolean) =>
    api.post<ImportResponse>('/api/imports', { source: 'tally-vouchers', companyId, from, to, dryRun }),
};
