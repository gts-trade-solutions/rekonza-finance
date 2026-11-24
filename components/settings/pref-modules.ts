// Zoho Books' module Preferences, by the address segment of their page
// (/settings/preferences/<module>) and the sales document kind each belongs to.

import type { DocPrefType } from '@/lib/api/client';

export interface PrefModule { type: DocPrefType; title: string; noun: string; edit: string }

export const PREF_MODULES: Record<string, PrefModule> = {
  quotes: { type: 'estimate', title: 'Quotes', noun: 'quote', edit: 'Allow editing of sent and accepted quotes' },
  'sales-orders': { type: 'sales_order', title: 'Sales Orders', noun: 'sales order', edit: 'Allow editing of confirmed sales orders' },
  invoices: { type: 'invoice', title: 'Invoices', noun: 'invoice', edit: 'Allow editing of sent invoices' },
  'delivery-challans': { type: 'challan', title: 'Delivery Challans', noun: 'delivery challan', edit: 'Allow editing of open delivery challans' },
  'credit-notes': { type: 'credit_note', title: 'Credit Notes', noun: 'credit note', edit: 'Allow editing of open credit notes' },
};

/** A sales document kind's Preferences page and its preference type. */
export const PREFS_FOR_KIND = {
  estimate: { href: '/settings/preferences/quotes', type: 'estimate', label: 'Quote Preferences' },
  'sales-order': { href: '/settings/preferences/sales-orders', type: 'sales_order', label: 'Sales Order Preferences' },
  challan: { href: '/settings/preferences/delivery-challans', type: 'challan', label: 'Delivery Challan Preferences' },
  'credit-note': { href: '/settings/preferences/credit-notes', type: 'credit_note', label: 'Credit Note Preferences' },
} as const;
