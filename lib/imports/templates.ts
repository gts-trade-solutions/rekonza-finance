// What each import takes: the columns of its template, in order.
//
// Shared by the browser, which offers the template and matches a file's
// headings to these columns, and by the server, which reads the rows by the
// same keys. A heading matches a column by its key or its label, ignoring
// case, spaces and punctuation, so a template typed out by hand still works.

import type { Sheet } from '../xlsx';

export type ImportKind =
  | 'contacts' | 'items' | 'accounts' | 'opening-ledger' | 'opening-bills' | 'journals' | 'invoices' | 'bills';

export interface ColumnSpec {
  key: string;
  label: string;
  required?: boolean;
  example: string;
  hint?: string;
}

export interface Template {
  title: string;
  description: string;
  /** Rows that share this column make one document (a voucher, an invoice). */
  groupBy?: string;
  columns: ColumnSpec[];
}

export const TEMPLATES: Record<ImportKind, Template> = {
  contacts: {
    title: 'Customers and vendors',
    description: 'One row per party. A GSTIN sets the state and makes the party registered.',
    columns: [
      { key: 'type', label: 'Type', required: true, example: 'customer', hint: 'customer, vendor or both' },
      { key: 'name', label: 'Name', required: true, example: 'Sri Murugan Motors' },
      { key: 'legal_name', label: 'Legal name', example: 'Sri Murugan Motors Pvt Ltd' },
      { key: 'gstin', label: 'GSTIN', example: '33AABCS1234F1Z5' },
      { key: 'pan', label: 'PAN', example: 'AABCS1234F' },
      { key: 'state', label: 'State', example: '33', hint: 'two-digit code or name; taken from the GSTIN when blank' },
      { key: 'email', label: 'Email', example: 'accounts@example.com' },
      { key: 'phone', label: 'Phone', example: '9840012345' },
      { key: 'address', label: 'Address', example: '12 Anna Salai' },
      { key: 'city', label: 'City', example: 'Chennai' },
      { key: 'pincode', label: 'PIN code', example: '600002' },
      { key: 'credit_days', label: 'Credit days', example: '30' },
      { key: 'msme_udyam_no', label: 'Udyam number', example: 'UDYAM-TN-02-0012345', hint: 'marks the vendor as MSME' },
    ],
  },
  items: {
    title: 'Items',
    description: 'One row per item. An HSN or SAC code not yet in your list is added with the row’s GST rate.',
    columns: [
      { key: 'name', label: 'Name', required: true, example: 'Brake pad set' },
      { key: 'kind', label: 'Kind', example: 'goods', hint: 'goods or service' },
      { key: 'sku', label: 'SKU', example: 'BP-101' },
      { key: 'hsn_sac', label: 'HSN/SAC', example: '8708' },
      { key: 'unit', label: 'Unit', example: 'NOS', hint: 'GST unit code: NOS, KGS, LTR, MTR, BOX…' },
      { key: 'sale_price', label: 'Sale price', example: '850' },
      { key: 'purchase_price', label: 'Purchase price', example: '600' },
      { key: 'gst_rate', label: 'GST rate', example: '18' },
      { key: 'track_stock', label: 'Track stock', example: 'yes', hint: 'yes or no; goods default to yes' },
      { key: 'opening_qty', label: 'Opening quantity', example: '40' },
      { key: 'opening_rate', label: 'Opening rate', example: '600', hint: 'cost per unit; the purchase price when blank' },
    ],
  },
  accounts: {
    title: 'Ledger accounts',
    description: 'Accounts to add to the chart. Existing codes are left alone.',
    columns: [
      { key: 'code', label: 'Code', required: true, example: '6150' },
      { key: 'name', label: 'Name', required: true, example: 'Warehouse rent' },
      { key: 'type', label: 'Type', required: true, example: 'expense', hint: 'asset, liability, equity, income or expense' },
      { key: 'subtype', label: 'Subtype', example: '', hint: 'bank, cash, fixed_asset, loan… optional' },
      { key: 'description', label: 'Description', example: '' },
    ],
  },
  'opening-ledger': {
    title: 'Opening balances: ledgers',
    description: 'One row per account, as at the day the books start. Customers, vendors, banks and stock have their own.',
    columns: [
      { key: 'account_code', label: 'Account code', required: true, example: '3100' },
      { key: 'debit', label: 'Debit', example: '' },
      { key: 'credit', label: 'Credit', example: '500000' },
    ],
  },
  'opening-bills': {
    title: 'Opening balances: unpaid bills',
    description: 'Bills from before the books start that were still unpaid. Each ages from its own due date.',
    columns: [
      { key: 'type', label: 'Type', required: true, example: 'receivable', hint: 'receivable (they owe us) or payable (we owe them)' },
      { key: 'party', label: 'Party', required: true, example: 'Sri Murugan Motors' },
      { key: 'bill_no', label: 'Bill number', required: true, example: 'INV/25-26/0412' },
      { key: 'bill_date', label: 'Bill date', required: true, example: '2026-02-14' },
      { key: 'due_date', label: 'Due date', required: true, example: '2026-03-16' },
      { key: 'amount', label: 'Amount unpaid', required: true, example: '23600' },
    ],
  },
  journals: {
    title: 'Journal vouchers',
    description: 'One row per line; rows with the same voucher number make one voucher, which must balance.',
    groupBy: 'voucher_no',
    columns: [
      { key: 'voucher_no', label: 'Voucher number', required: true, example: 'JV-1' },
      { key: 'date', label: 'Date', required: true, example: '2026-04-30' },
      { key: 'account_code', label: 'Account code', required: true, example: '6100' },
      { key: 'debit', label: 'Debit', example: '45000' },
      { key: 'credit', label: 'Credit', example: '' },
      { key: 'party', label: 'Party', example: '', hint: 'needed on a receivable or payable line' },
      { key: 'narration', label: 'Narration', example: 'April rent' },
    ],
  },
  invoices: {
    title: 'Sales invoices',
    description: 'One row per line; rows with the same invoice number make one invoice. Each is posted.',
    groupBy: 'invoice_no',
    columns: [
      { key: 'invoice_no', label: 'Invoice number', required: true, example: 'INV/26-27/0001' },
      { key: 'date', label: 'Date', required: true, example: '2026-04-03' },
      { key: 'due_date', label: 'Due date', example: '2026-05-03' },
      { key: 'customer', label: 'Customer', required: true, example: 'Sri Murugan Motors' },
      { key: 'item', label: 'Item', example: 'Brake pad set', hint: 'item name or SKU; or leave blank and give a description' },
      { key: 'description', label: 'Description', example: '' },
      { key: 'hsn_sac', label: 'HSN/SAC', example: '8708' },
      { key: 'qty', label: 'Quantity', required: true, example: '4' },
      { key: 'rate', label: 'Rate', required: true, example: '850' },
      { key: 'discount_pct', label: 'Discount %', example: '' },
      { key: 'gst_rate', label: 'GST rate', example: '18' },
    ],
  },
  bills: {
    title: 'Purchase bills',
    description: 'One row per line; rows with the same supplier and bill number make one bill. Each is posted.',
    groupBy: 'bill_no',
    columns: [
      { key: 'bill_no', label: "Supplier's bill number", required: true, example: 'SM/2026/118' },
      { key: 'date', label: 'Date', required: true, example: '2026-04-05' },
      { key: 'due_date', label: 'Due date', example: '2026-05-05' },
      { key: 'vendor', label: 'Vendor', required: true, example: 'Lakshmi Auto Components' },
      { key: 'item', label: 'Item', example: 'Brake pad set' },
      { key: 'description', label: 'Description', example: '' },
      { key: 'hsn_sac', label: 'HSN/SAC', example: '8708' },
      { key: 'qty', label: 'Quantity', required: true, example: '20' },
      { key: 'rate', label: 'Rate', required: true, example: '600' },
      { key: 'gst_rate', label: 'GST rate', example: '18' },
    ],
  },
};

export const IMPORT_KINDS = Object.keys(TEMPLATES) as ImportKind[];
/** One import, one file: enough for a year's masters, small enough to check in one go. */
export const MAX_IMPORT_ROWS = 5000;

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Which column a file heading means, if any. */
export function columnFor(kind: ImportKind, heading: string): string | null {
  const h = squash(heading);
  if (!h) return null;
  const col = TEMPLATES[kind].columns.find((c) => squash(c.key) === h || squash(c.label) === h);
  return col?.key ?? null;
}

/** The template as CSV: headings, then one example row. */
export function templateCsv(kind: ImportKind): string {
  const cols = TEMPLATES[kind].columns;
  const cell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [cols.map((c) => cell(c.label)).join(','), cols.map((c) => cell(c.example)).join(',')].join('\n');
}

/**
 * The template as a workbook: a sheet with the headings to fill in, and a
 * second saying what each column takes. The example row lives only on the
 * second sheet, so a template filled in below it cannot import the example.
 */
export function templateSheets(kind: ImportKind): Sheet[] {
  const t = TEMPLATES[kind];
  return [
    { name: t.title, rows: [t.columns.map((c) => c.label)], widths: t.columns.map((c) => Math.max(12, c.label.length + 4, c.example.length + 2)) },
    {
      name: 'How to fill',
      rows: [
        ['Column', 'Required', 'What goes in it', 'Example'],
        ...t.columns.map((c) => [c.label, c.required ? 'Yes' : '', c.hint ?? '', c.example]),
        [],
        [t.description],
        ...(t.groupBy ? [[`Rows with the same ${t.columns.find((c) => c.key === t.groupBy)?.label ?? t.groupBy} make one document.`]] : []),
        ['Fill the first sheet from its second row down. Headings may be renamed or reordered; they are matched by name.'],
      ],
      widths: [24, 10, 60, 28],
    },
  ];
}
