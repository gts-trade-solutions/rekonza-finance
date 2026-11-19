// The modules that import from a file, as Zoho Books offers it on each list's
// ⋯ menu ("Import Customers", "Import Invoices" …), and the import behind each
// (lib/imports/templates.ts). Customers and vendors share the contacts import,
// with the type filled in; the screens and the tests share this list.

import type { ImportKind } from './templates';

export interface ImportModule {
  /** In the address: /import/customers. */
  slug: string;
  /** "Customers", "Invoices": the page's title is "Customers - Select File". */
  title: string;
  /** The singular, for "Import Customer"… where Zoho uses it. */
  noun: string;
  kind: ImportKind;
  /** Columns every row gets, which the file need not have. */
  fixed?: Record<string, string>;
  /** The list to go back to. */
  back: string;
  /** The Settings → Export module of the same records. */
  exportModule: string | null;
  /** Who may run it, by the rights it needs. */
  module: 'sales' | 'purchases' | 'inventory' | 'accountant';
  /** Whether "already in the books" can be skipped (masters), or every row is new (documents). */
  duplicates: boolean;
}

export const IMPORT_MODULES: ImportModule[] = [
  { slug: 'customers', title: 'Customers', noun: 'customer', kind: 'contacts', fixed: { type: 'customer' }, back: '/sales/customers', exportModule: 'contacts', module: 'sales', duplicates: true },
  { slug: 'vendors', title: 'Vendors', noun: 'vendor', kind: 'contacts', fixed: { type: 'vendor' }, back: '/purchases/vendors', exportModule: 'contacts', module: 'purchases', duplicates: true },
  { slug: 'items', title: 'Items', noun: 'item', kind: 'items', back: '/sales/items', exportModule: 'items', module: 'inventory', duplicates: true },
  { slug: 'quotes', title: 'Quotes', noun: 'quote', kind: 'estimates', back: '/sales/estimates', exportModule: 'estimates', module: 'sales', duplicates: false },
  { slug: 'sales-orders', title: 'Sales Orders', noun: 'sales order', kind: 'sales-orders', back: '/sales/sales-orders', exportModule: 'sales-orders', module: 'sales', duplicates: false },
  { slug: 'invoices', title: 'Invoices', noun: 'invoice', kind: 'invoices', back: '/sales/invoices', exportModule: 'invoices', module: 'sales', duplicates: false },
  { slug: 'payments-received', title: 'Customer Payments', noun: 'payment', kind: 'payments-received', back: '/sales/payments', exportModule: 'payments-received', module: 'sales', duplicates: false },
  { slug: 'credit-notes', title: 'Credit Notes', noun: 'credit note', kind: 'credit-notes', back: '/sales/credit-notes', exportModule: 'credit-notes', module: 'sales', duplicates: false },
  { slug: 'expenses', title: 'Expenses', noun: 'expense', kind: 'expenses', back: '/purchases/expenses', exportModule: 'expenses', module: 'purchases', duplicates: false },
  { slug: 'purchase-orders', title: 'Purchase Orders', noun: 'purchase order', kind: 'purchase-orders', back: '/purchases/purchase-orders', exportModule: 'purchase-orders', module: 'purchases', duplicates: false },
  { slug: 'bills', title: 'Bills', noun: 'bill', kind: 'bills', back: '/purchases/bills', exportModule: 'bills', module: 'purchases', duplicates: false },
  { slug: 'payments-made', title: 'Vendor Payments', noun: 'payment', kind: 'payments-made', back: '/purchases/payments', exportModule: 'payments-made', module: 'purchases', duplicates: false },
  { slug: 'journals', title: 'Manual Journals', noun: 'journal', kind: 'journals', back: '/accountant/journals', exportModule: 'journals', module: 'accountant', duplicates: false },
  { slug: 'accounts', title: 'Chart of Accounts', noun: 'account', kind: 'accounts', back: '/accountant/chart-of-accounts', exportModule: 'accounts', module: 'accountant', duplicates: true },
  { slug: 'opening-balances', title: 'Opening Balances', noun: 'opening balance', kind: 'opening-ledger', back: '/accountant/opening-balances', exportModule: null, module: 'accountant', duplicates: false },
  { slug: 'opening-bills', title: 'Unpaid Opening Invoices and Bills', noun: 'unpaid document', kind: 'opening-bills', back: '/accountant/opening-balances', exportModule: null, module: 'accountant', duplicates: false },
];

export const importModule = (slug: string) => IMPORT_MODULES.find((m) => m.slug === slug) ?? null;

/** The import page of the module whose list this is, for the ⋯ menu. */
export const importHref = (slug: string) => `/import/${slug}`;

/** Zoho's character encodings, as its import offers them. */
export const ENCODINGS: { value: string; label: string }[] = [
  { value: 'utf-8', label: 'UTF-8 (Unicode)' },
  { value: 'utf-16le', label: 'UTF-16 (Unicode)' },
  { value: 'iso-8859-1', label: 'ISO-8859-1' },
  { value: 'iso-8859-2', label: 'ISO-8859-2' },
  { value: 'iso-8859-9', label: 'ISO-8859-9 (Turkish)' },
  { value: 'gb2312', label: 'GB2312 (Simplified Chinese)' },
  { value: 'big5', label: 'Big5 (Traditional Chinese)' },
  { value: 'shift_jis', label: 'Shift_JIS (Japanese)' },
];
