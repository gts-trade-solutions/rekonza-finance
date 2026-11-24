// What each import takes: the columns of its template, in order.
//
// Shared by the browser, which offers the template and matches a file's
// headings to these columns, and by the server, which reads the rows by the
// same keys. A heading matches a column by its key or its label, ignoring
// case, spaces and punctuation, so a template typed out by hand still works.

import type { Sheet } from '../xlsx';

export type ImportKind =
  | 'contacts' | 'items' | 'accounts' | 'opening-ledger' | 'opening-bills' | 'journals' | 'invoices' | 'bills'
  | 'estimates' | 'sales-orders' | 'credit-notes' | 'purchase-orders' | 'expenses' | 'payments-received' | 'payments-made'
  | 'retainer-payments' | 'applied-excess-payments';

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
      { key: 'state', label: 'State', example: '33', hint: 'two-digit code, letters (TN) or name; from the GSTIN when blank, else your own state' },
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
      { key: 'description', label: 'Description', example: 'Front disc brake pads', hint: 'what a sale says' },
      { key: 'purchase_description', label: 'Purchase description', example: 'Brake pads, OEM pack', hint: 'what a bill or order says' },
      { key: 'preferred_vendor', label: 'Preferred vendor', example: 'Brake Works', hint: 'a vendor already in your books' },
      { key: 'upc', label: 'UPC', example: '012345678905' },
      { key: 'ean', label: 'EAN', example: '8901234567890' },
      { key: 'isbn', label: 'ISBN', example: '' },
      { key: 'mpn', label: 'MPN', example: 'BP-101-OEM' },
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
      { key: 'export_igst', label: 'Export IGST', example: '', hint: 'an export only: nil (under LUT) or paid; blank is nil, as most exports are' },
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
      { key: 'export_igst', label: 'Export IGST', example: '', hint: 'an export only: nil (under LUT) or paid; blank is nil, as most exports are' },
    ],
  },
  estimates: {
    title: 'Quotes',
    description: 'One row per line; rows with the same quote number make one quote. Imported as sent.',
    groupBy: 'number',
    columns: [
      { key: 'number', label: 'Quote number', required: true, example: 'EST/26-27/0001' },
      { key: 'date', label: 'Date', required: true, example: '2026-04-03' },
      { key: 'expiry_date', label: 'Valid until', example: '2026-05-03' },
      { key: 'customer', label: 'Customer', required: true, example: 'Sri Murugan Motors' },
      { key: 'item', label: 'Item', example: 'Brake pad set', hint: 'item name or SKU; or leave blank and give a description' },
      { key: 'description', label: 'Description', example: '' },
      { key: 'hsn_sac', label: 'HSN/SAC', example: '8708' },
      { key: 'qty', label: 'Quantity', required: true, example: '4' },
      { key: 'rate', label: 'Rate', required: true, example: '850' },
      { key: 'discount_pct', label: 'Discount %', example: '' },
      { key: 'gst_rate', label: 'GST rate', example: '18' },
      { key: 'export_igst', label: 'Export IGST', example: '', hint: 'an export only: nil (under LUT) or paid; blank is nil, as most exports are' },
    ],
  },
  'sales-orders': {
    title: 'Sales orders',
    description: 'One row per line; rows with the same order number make one sales order.',
    groupBy: 'number',
    columns: [
      { key: 'number', label: 'Order number', required: true, example: 'SO/26-27/0001' },
      { key: 'date', label: 'Date', required: true, example: '2026-04-03' },
      { key: 'expected_ship_date', label: 'Expected shipment', example: '2026-04-10' },
      { key: 'customer', label: 'Customer', required: true, example: 'Sri Murugan Motors' },
      { key: 'item', label: 'Item', example: 'Brake pad set', hint: 'item name or SKU; or leave blank and give a description' },
      { key: 'description', label: 'Description', example: '' },
      { key: 'hsn_sac', label: 'HSN/SAC', example: '8708' },
      { key: 'qty', label: 'Quantity', required: true, example: '4' },
      { key: 'rate', label: 'Rate', required: true, example: '850' },
      { key: 'discount_pct', label: 'Discount %', example: '' },
      { key: 'gst_rate', label: 'GST rate', example: '18' },
      { key: 'export_igst', label: 'Export IGST', example: '', hint: 'an export only: nil (under LUT) or paid; blank is nil, as most exports are' },
    ],
  },
  'credit-notes': {
    title: 'Credit notes',
    description: 'One row per line; rows with the same credit note number make one. Each needs its reason, as GST requires, and is posted.',
    groupBy: 'number',
    columns: [
      { key: 'number', label: 'Credit note number', required: true, example: 'CN/26-27/0001' },
      { key: 'date', label: 'Date', required: true, example: '2026-04-20' },
      { key: 'customer', label: 'Customer', required: true, example: 'Sri Murugan Motors' },
      { key: 'reason', label: 'Reason', required: true, example: 'Goods returned' },
      { key: 'against_invoice', label: 'Against invoice', example: 'INV/26-27/0001', hint: 'the invoice it reduces, if any' },
      { key: 'item', label: 'Item', example: 'Brake pad set', hint: 'item name or SKU; or leave blank and give a description' },
      { key: 'description', label: 'Description', example: '' },
      { key: 'hsn_sac', label: 'HSN/SAC', example: '8708' },
      { key: 'qty', label: 'Quantity', required: true, example: '1' },
      { key: 'rate', label: 'Rate', required: true, example: '850' },
      { key: 'discount_pct', label: 'Discount %', example: '' },
      { key: 'gst_rate', label: 'GST rate', example: '18' },
      { key: 'export_igst', label: 'Export IGST', example: '', hint: 'an export only: nil (under LUT) or paid; blank is nil, as most exports are' },
    ],
  },
  'purchase-orders': {
    title: 'Purchase orders',
    description: 'One row per line; rows with the same order number make one purchase order, imported open.',
    groupBy: 'number',
    columns: [
      { key: 'number', label: 'Order number', required: true, example: 'PO/26-27/0001' },
      { key: 'date', label: 'Date', required: true, example: '2026-04-02' },
      { key: 'expected_date', label: 'Expected', example: '2026-04-12' },
      { key: 'vendor', label: 'Vendor', required: true, example: 'Lakshmi Auto Components' },
      { key: 'item', label: 'Item', example: 'Brake pad set', hint: 'item name or SKU; or leave blank and give a description' },
      { key: 'description', label: 'Description', example: '' },
      { key: 'hsn_sac', label: 'HSN/SAC', example: '8708' },
      { key: 'qty', label: 'Quantity', required: true, example: '20' },
      { key: 'rate', label: 'Rate', required: true, example: '600' },
      { key: 'discount_pct', label: 'Discount %', example: '' },
      { key: 'gst_rate', label: 'GST rate', example: '18' },
      { key: 'export_igst', label: 'Export IGST', example: '', hint: 'an export only: nil (under LUT) or paid; blank is nil, as most exports are' },
    ],
  },
  expenses: {
    title: 'Expenses',
    description: 'One row per expense, each posted: the expense account, what it was paid from, and the GST on it.',
    columns: [
      { key: 'date', label: 'Date', required: true, example: '2026-04-07' },
      { key: 'account_code', label: 'Expense account code', required: true, example: '6500', hint: 'or the account name' },
      { key: 'paid_through', label: 'Paid through', required: true, example: 'Cash in hand', hint: 'the bank or cash account’s name' },
      { key: 'total', label: 'Amount paid, with GST', required: true, example: '1416', hint: 'what left the account; the GST is worked out of it' },
      { key: 'gst_rate', label: 'GST rate', example: '18' },
      { key: 'vendor', label: 'Vendor', example: 'Indian Oil Petrol Bunk' },
      { key: 'itc', label: 'Input credit', example: 'eligible', hint: 'eligible, ineligible or capital_goods' },
      { key: 'reference', label: 'Reference', example: 'Bill 4471' },
      { key: 'notes', label: 'Notes', example: 'Diesel for the van' },
      { key: 'customer', label: 'Billable to customer', example: '', hint: 'to charge it on to a customer' },
    ],
  },
  'payments-received': {
    title: 'Payments received',
    description: 'One row per receipt, each posted. Name the invoice to settle it; otherwise the money is kept on account.',
    columns: [
      { key: 'date', label: 'Date', required: true, example: '2026-04-15' },
      { key: 'customer', label: 'Customer', required: true, example: 'Sri Murugan Motors' },
      { key: 'amount', label: 'Amount received', required: true, example: '3400', hint: 'before any TDS they withheld' },
      { key: 'mode', label: 'Mode', example: 'neft', hint: 'cash, cheque, upi, neft, imps or card' },
      { key: 'account', label: 'Deposited to', required: true, example: 'HDFC Bank – Current', hint: 'the bank or cash account’s name' },
      { key: 'reference', label: 'Reference', example: 'UTR 4471' },
      { key: 'tds', label: 'TDS withheld', example: '' },
      { key: 'bank_charges', label: 'Bank charges', example: '' },
      { key: 'invoice', label: 'Invoice settled', example: 'INV/26-27/0001' },
      { key: 'notes', label: 'Notes', example: '' },
    ],
  },
  // Zoho's Payments Received ⋯ → Import → Import Retainer Payments.
  'retainer-payments': {
    title: 'Retainer payments',
    description: 'One row per payment against a retainer (service) invoice, each posted and applied to the retainer it names.',
    columns: [
      { key: 'date', label: 'Date', required: true, example: '2026-04-15' },
      { key: 'customer', label: 'Customer', required: true, example: 'Sri Murugan Motors' },
      { key: 'retainer', label: 'Retainer invoice number', required: true, example: 'RET-00001' },
      { key: 'amount', label: 'Amount received', required: true, example: '25000' },
      { key: 'mode', label: 'Mode', example: 'neft', hint: 'cash, cheque, upi, neft, imps or card' },
      { key: 'account', label: 'Deposited to', required: true, example: 'HDFC Bank – Current', hint: 'the bank or cash account’s name' },
      { key: 'reference', label: 'Reference', example: 'UTR 4472' },
      { key: 'notes', label: 'Notes', example: '' },
    ],
  },
  // Zoho's Payments Received ⋯ → Import → Import Applied Excess Payments.
  'applied-excess-payments': {
    title: 'Applied excess payments',
    description: 'One row per application: money a customer paid in excess (an advance, or a payment’s unused amount) set against one of their invoices. Nothing new is received.',
    columns: [
      { key: 'date', label: 'Date applied', required: true, example: '2026-04-20' },
      { key: 'customer', label: 'Customer', required: true, example: 'Sri Murugan Motors' },
      { key: 'payment', label: 'Payment number', required: true, example: 'PR/26-27/0007' },
      { key: 'invoice', label: 'Invoice number', required: true, example: 'INV/26-27/0012' },
      { key: 'amount', label: 'Amount applied', required: true, example: '5000' },
    ],
  },
  'payments-made': {
    title: 'Payments made',
    description: 'One row per payment, each posted. Name the supplier’s bill to settle it; otherwise it is kept as an advance.',
    columns: [
      { key: 'date', label: 'Date', required: true, example: '2026-04-16' },
      { key: 'vendor', label: 'Vendor', required: true, example: 'Lakshmi Auto Components' },
      { key: 'amount', label: 'Amount paid', required: true, example: '11800', hint: 'before any TDS you withheld' },
      { key: 'mode', label: 'Mode', example: 'neft', hint: 'cash, cheque, upi, neft, imps or card' },
      { key: 'account', label: 'Paid from', required: true, example: 'HDFC Bank – Current', hint: 'the bank or cash account’s name' },
      { key: 'reference', label: 'Reference', example: 'UTR 9921' },
      { key: 'tds', label: 'TDS withheld', example: '' },
      { key: 'bank_charges', label: 'Bank charges', example: '' },
      { key: 'bill', label: 'Supplier’s bill settled', example: 'SM/2026/118' },
      { key: 'notes', label: 'Notes', example: '' },
    ],
  },
};

/**
 * Other names a file may give a column: Zoho Books' own export headings first
 * (so a Zoho export imports as it is), then the usual spreadsheet words.
 * Matched like the labels, ignoring case, spaces and punctuation.
 */
const DOC_LINE: Record<string, string[]> = {
  item: ['Item Name', 'Product', 'Product Name', 'Item Code'],
  description: ['Item Desc', 'Item Description', 'Line Description'],
  hsn_sac: ['HSN', 'SAC', 'HSN Code', 'HSN/SAC Code', 'HSN SAC'],
  qty: ['Qty', 'Item Quantity', 'Quantity Ordered'],
  rate: ['Item Price', 'Price', 'Unit Price', 'Item Rate', 'Selling Price'],
  discount_pct: ['Discount', 'Discount(%)', 'Item Discount', 'Discount Percent', 'Discount Percentage'],
  gst_rate: ['Item Tax %', 'Item Tax', 'Tax %', 'Tax Percentage', 'Tax Rate', 'GST %', 'GST', 'Item Tax Percentage', 'Intra State Tax Rate'],
};

export const ALIASES: Partial<Record<ImportKind, Record<string, string[]>>> = {
  contacts: {
    type: ['Contact Type', 'Customer or Vendor', 'Party Type'],
    name: ['Display Name', 'Contact Name', 'Customer Name', 'Vendor Name', 'Party Name', 'Party'],
    legal_name: ['Company Name', 'Business Legal Name', 'Registered Name'],
    gstin: ['GST Identification Number (GSTIN)', 'GST Identification Number', 'GSTIN/UIN', 'GST Number', 'GST No', 'GSTIN Number'],
    pan: ['PAN Number', 'PAN No'],
    state: ['Place of Contact', 'Place of Supply', 'Billing State', 'State Code', 'Source of Supply'],
    email: ['EmailID', 'Email ID', 'Email Address', 'E-mail'],
    phone: ['Phone', 'MobilePhone', 'Mobile Phone', 'Mobile', 'Work Phone', 'Contact Number', 'Phone Number'],
    address: ['Billing Address', 'Billing Street', 'Street', 'Address Line 1'],
    city: ['Billing City'],
    pincode: ['Billing Code', 'Billing Zip', 'Billing Pincode', 'Zip', 'Zip Code', 'Pincode', 'Postal Code', 'PIN'],
    credit_days: ['Payment Terms', 'Payment Terms Label', 'Credit Period', 'Credit Terms'],
    msme_udyam_no: ['MSME Registration Number', 'Udyam Registration Number', 'Udyam No'],
  },
  items: {
    name: ['Item Name', 'Product Name', 'Product', 'Item'],
    kind: ['Product Type', 'Goods or Service', 'Goods/Services'],
    sku: ['Item Code', 'Product Code', 'Code'],
    hsn_sac: ['HSN', 'SAC', 'HSN Code', 'HSN/SAC Code'],
    unit: ['Usage unit', 'Usage Unit', 'Units', 'UOM', 'UQC'],
    sale_price: ['Rate', 'Selling Price', 'Sales Rate', 'Sales Price', 'Price', 'MRP'],
    purchase_price: ['Purchase Rate', 'Cost Price', 'Cost', 'Purchase Cost'],
    gst_rate: ['Intra State Tax Rate', 'Tax Percentage', 'GST %', 'GST', 'Tax Rate', 'Tax %', 'Inter State Tax Rate'],
    track_stock: ['Track Inventory', 'Inventory Tracking', 'Stock Item'],
    opening_qty: ['Opening Stock', 'Opening Quantity', 'Stock On Hand', 'Opening Stock Quantity'],
    opening_rate: ['Opening Stock Rate', 'Opening Stock Value per Unit', 'Opening Rate per Unit'],
    description: ['Sales Description', 'Item Description'],
    preferred_vendor: ['Vendor', 'Vendor Name', 'Preferred Supplier'],
  },
  accounts: {
    code: ['Account Code', 'Ledger Code'],
    name: ['Account Name', 'Ledger Name', 'Ledger'],
    type: ['Account Type', 'Type'],
    description: ['Account Description'],
  },
  journals: {
    voucher_no: ['Journal Number', 'Journal#', 'Voucher No', 'Entry Number'],
    date: ['Journal Date', 'Voucher Date'],
    account_code: ['Account', 'Account Code', 'Ledger', 'Ledger Code'],
    party: ['Contact Name', 'Customer Name', 'Vendor Name'],
    narration: ['Notes', 'Description', 'Reference Number', 'Memo'],
  },
  invoices: { invoice_no: ['Invoice Number', 'Invoice#', 'Invoice No', 'Bill No'], date: ['Invoice Date'], due_date: ['Due Date'], customer: ['Customer Name', 'Party Name', 'Display Name'], ...DOC_LINE },
  bills: { bill_no: ['Bill Number', 'Bill#', 'Bill No', 'Vendor Invoice Number', 'Supplier Invoice No'], date: ['Bill Date'], due_date: ['Due Date'], vendor: ['Vendor Name', 'Supplier', 'Supplier Name', 'Party Name'], ...DOC_LINE },
  estimates: { number: ['Estimate Number', 'Quote Number', 'Quote#', 'Estimate#'], date: ['Estimate Date', 'Quote Date'], expiry_date: ['Expiry Date', 'Valid Till'], customer: ['Customer Name'], ...DOC_LINE },
  'sales-orders': { number: ['SalesOrder Number', 'Sales Order Number', 'Sales Order#', 'SO Number'], date: ['Order Date', 'Sales Order Date', 'SalesOrder Date'], expected_ship_date: ['Expected Shipment Date', 'Shipment Date'], customer: ['Customer Name'], ...DOC_LINE },
  'credit-notes': { number: ['Credit Note Number', 'CreditNote Number', 'Credit Note#'], date: ['Credit Note Date', 'CreditNote Date'], customer: ['Customer Name'], reason: ['Reason for Credit Note', 'Credit Note Reason'], against_invoice: ['Associated Invoice Number', 'Invoice Number', 'Invoice#', 'Reference Invoice'], ...DOC_LINE },
  'purchase-orders': { number: ['Purchase Order Number', 'PurchaseOrder Number', 'PO Number', 'Purchase Order#'], date: ['Purchase Order Date', 'PO Date'], expected_date: ['Expected Delivery Date', 'Delivery Date'], vendor: ['Vendor Name', 'Supplier'], ...DOC_LINE },
  expenses: {
    date: ['Expense Date'], account_code: ['Expense Account', 'Account', 'Expense Account Code'], paid_through: ['Paid Through', 'Paid Through Account'],
    total: ['Expense Amount', 'Total', 'Amount', 'Total Amount'], gst_rate: ['Tax Percentage', 'Tax %', 'GST %'], vendor: ['Vendor Name', 'Merchant'],
    reference: ['Reference#', 'Reference Number', 'Ref No'], notes: ['Description', 'Expense Description'], customer: ['Customer Name'],
  },
  'payments-received': {
    date: ['Payment Date', 'Date'], customer: ['Customer Name'], amount: ['Amount', 'Payment Amount', 'Amount Received'], mode: ['Payment Mode', 'Mode of Payment'],
    account: ['Deposit To', 'Deposited To', 'Deposit Account'], reference: ['Reference Number', 'Reference#', 'Payment Reference'],
    tds: ['TDS', 'Tax Deducted', 'Withholding Tax Amount'], bank_charges: ['Bank Charges (if any)', 'Bank Charge'], invoice: ['Invoice Number', 'Invoice#'], notes: ['Description', 'Notes'],
  },
  'payments-made': {
    date: ['Payment Date', 'Date'], vendor: ['Vendor Name', 'Supplier'], amount: ['Amount', 'Payment Amount', 'Amount Paid'], mode: ['Payment Mode', 'Mode of Payment'],
    account: ['Paid Through', 'Paid From Account'], reference: ['Reference Number', 'Reference#'], tds: ['TDS', 'Tax Deducted'],
    bank_charges: ['Bank Charges (if any)', 'Bank Charge'], bill: ['Bill Number', 'Bill#'], notes: ['Description', 'Notes'],
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
  if (col) return col.key;
  // Zoho's export headings and other common names (ALIASES), for columns the template has.
  const names = ALIASES[kind] ?? {};
  const keys = new Set(TEMPLATES[kind].columns.map((c) => c.key));
  return Object.entries(names).find(([key, list]) => keys.has(key) && list.some((a) => squash(a) === h))?.[0] ?? null;
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
