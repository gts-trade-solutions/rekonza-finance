// Quotes, sales orders, delivery challans and credit notes as Zoho Books names
// and shows them (recorded from Zoho's demo on 2026-11-23): one table of the
// four, so the list, the record and the form read their words from one place.

import type { EditableSalesKind, CommentTarget } from '@/lib/api/client';

export type SalesDocKindZ = EditableSalesKind;

interface KindInfo {
  /** The list's heading and the record's module ("Quotes"). */
  plural: string;
  /** One of them in a title ("Quote"). */
  noun: string;
  /** In a sentence ("quote"). */
  lower: string;
  base: string;
  /** Zoho's number label on the form ("Quote#"). */
  numberLabel: string;
  dateLabel: string;
  /** The views' noun in "All Estimates" (Zoho calls a quote an estimate in its views). */
  viewNoun: string;
  comments: CommentTarget;
  /** Zoho's attachment line on the form. */
  attachLabel: string;
  /** Kept in the audit trail under (services' logAudit). */
  audit: string;
}

export const SALES_DOC: Record<SalesDocKindZ, KindInfo> = {
  estimate: {
    plural: 'Quotes', noun: 'Quote', lower: 'quote', base: '/sales/estimates', numberLabel: 'Quote#', dateLabel: 'Quote Date',
    viewNoun: 'Estimates', comments: 'estimate', attachLabel: 'Attach File(s) to Quote', audit: 'estimate',
  },
  'sales-order': {
    plural: 'Sales Orders', noun: 'Sales Order', lower: 'sales order', base: '/sales/sales-orders', numberLabel: 'Sales Order#', dateLabel: 'Sales Order Date',
    viewNoun: 'Sales Orders', comments: 'sales_order', attachLabel: 'Attach File(s) to Sales Order', audit: 'sales-order',
  },
  challan: {
    plural: 'Delivery Challans', noun: 'Delivery Challan', lower: 'delivery challan', base: '/sales/challans', numberLabel: 'Delivery Challan#', dateLabel: 'Delivery Challan Date',
    viewNoun: 'Delivery Challans', comments: 'challan', attachLabel: 'Attach File(s) to Delivery Challan', audit: 'challan',
  },
  'credit-note': {
    plural: 'Credit Notes', noun: 'Credit Note', lower: 'credit note', base: '/sales/credit-notes', numberLabel: 'Credit Note#', dateLabel: 'Credit Note Date',
    viewNoun: 'Credit Notes', comments: 'credit_note', attachLabel: 'Attach File(s) to Credit Note', audit: 'credit-note',
  },
};

/** The attachment target each one is filed under (components/shared/attachments). */
export const ATTACH_TARGET: Record<SalesDocKindZ, string> = {
  estimate: 'estimate', 'sales-order': 'sales_order', challan: 'challan', 'credit-note': 'credit_note',
};

/** Zoho's challan types, as its form lists them. */
export const CHALLAN_TYPES = [
  { value: 'supply_on_approval', label: 'Supply on Approval' },
  { value: 'job_work', label: 'Job Work' },
  { value: 'liquid_gas', label: 'Supply of Liquid Gas' },
  { value: 'other', label: 'Others' },
];
export const challanTypeLabel = (v: string | null | undefined) => CHALLAN_TYPES.find((t) => t.value === v)?.label ?? 'Others';

/** Zoho's credit note reasons (its Reason dropdown, word for word). */
export const CREDIT_REASONS = [
  'Sales Return', 'Post Sale Discount', 'Deficiency in service', 'Correction in invoice', 'Change in POS',
  'Finalization of Provisional assessment', 'Others',
];

const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * The status as Zoho words it, as a key StatusBadge colours: a quote past its
 * expiry date reads EXPIRED, one turned into an invoice INVOICED; an open sales
 * order is CONFIRMED; a credit note used up is CLOSED; a cancelled one is VOID.
 */
export function zohoStatus(kind: SalesDocKindZ, doc: { status: string; expiry?: string | null; expiryDate?: string | null; detail?: string | null; convertedTo?: { type: string } | null }): string {
  const s = doc.status;
  switch (kind) {
    case 'estimate': {
      const expiry = doc.expiryDate ?? doc.expiry ?? null;
      if ((s === 'draft' || s === 'sent') && expiry && expiry < todayIso()) return 'expired';
      if (s === 'converted') return doc.convertedTo?.type === 'sales_order' ? 'accepted' : 'invoiced';
      return s;
    }
    case 'sales-order':
      return s === 'open' ? 'confirmed' : s === 'cancelled' ? 'void' : s;
    case 'challan':
      return s === 'cancelled' ? 'void' : s;
    case 'credit-note':
      return s === 'applied' || s === 'refunded' ? 'closed' : s;
  }
}

/** A list's views (Zoho's "All Estimates ▾"): the value, its label, and the statuses it keeps. */
export const VIEWS: Record<SalesDocKindZ, { value: string; label: string; keep: (z: string) => boolean }[]> = {
  estimate: [
    { value: 'all', label: 'All', keep: () => true },
    { value: 'draft', label: 'Draft', keep: (z) => z === 'draft' },
    { value: 'sent', label: 'Sent', keep: (z) => z === 'sent' },
    { value: 'accepted', label: 'Accepted', keep: (z) => z === 'accepted' },
    { value: 'invoiced', label: 'Invoiced', keep: (z) => z === 'invoiced' },
    { value: 'declined', label: 'Declined', keep: (z) => z === 'declined' },
    { value: 'expired', label: 'Expired', keep: (z) => z === 'expired' },
  ],
  'sales-order': [
    { value: 'all', label: 'All', keep: () => true },
    { value: 'confirmed', label: 'Confirmed', keep: (z) => z === 'confirmed' },
    { value: 'partially_invoiced', label: 'Partially Invoiced', keep: (z) => z === 'partially_invoiced' },
    { value: 'invoiced', label: 'Invoiced', keep: (z) => z === 'invoiced' },
    { value: 'closed', label: 'Closed', keep: (z) => z === 'closed' },
    { value: 'void', label: 'Void', keep: (z) => z === 'void' },
  ],
  challan: [
    { value: 'all', label: 'All', keep: () => true },
    { value: 'open', label: 'Open', keep: (z) => z === 'open' },
    { value: 'partially_invoiced', label: 'Partially Invoiced', keep: (z) => z === 'partially_invoiced' },
    { value: 'invoiced', label: 'Invoiced', keep: (z) => z === 'invoiced' },
    { value: 'returned', label: 'Returned', keep: (z) => z === 'returned' },
    { value: 'void', label: 'Void', keep: (z) => z === 'void' },
  ],
  'credit-note': [
    { value: 'all', label: 'All', keep: () => true },
    { value: 'open', label: 'Open', keep: (z) => z === 'open' },
    { value: 'closed', label: 'Closed', keep: (z) => z === 'closed' },
    { value: 'void', label: 'Void', keep: (z) => z === 'void' },
  ],
};

/** "24 May 2026", as Zoho prints a date. */
export const zohoDay = (d: string | null | undefined) =>
  d ? new Date(`${d.slice(0, 10)}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '-';
