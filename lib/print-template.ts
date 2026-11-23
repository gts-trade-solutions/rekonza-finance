// How printed documents look, as the business chose in Settings → PDF
// Templates: Zoho Books' gallery of twelve templates, one chosen for each
// kind of document, an optional theme colour, whether the logo and the
// signature print, and a line at the foot of the page. The content is still
// Rule 46's; the template is only the look.

/** The templates, by Zoho's names, in the order its gallery shows them. */
export const TEMPLATE_KEYS = [
  'standard', 'standard_japanese', 'standard_japanese_sans_sealboxes', 'standard_euro',
  'spreadsheet',
  'minimalist', 'grand', 'continental',
  'lite', 'simple', 'compact', 'basic',
] as const;
export type TemplateKey = (typeof TEMPLATE_KEYS)[number];
/** Kept for the screens and tests that still name it. */
export type PrintLayout = TemplateKey;

export type TemplateGroup = 'Standard' | 'Spreadsheet' | 'Premium' | 'Universal';

export interface TemplateInfo {
  key: TemplateKey;
  name: string;
  group: TemplateGroup;
  /** Zoho's line under the card, where it has one. */
  description: string | null;
  /** The colour it prints in until the business picks its own. */
  accent: string;
}

export const TEMPLATE_GALLERY: TemplateInfo[] = [
  { key: 'standard', name: 'Standard', group: 'Standard', description: null, accent: '#3c3d3a' },
  { key: 'standard_japanese', name: 'Standard Japanese', group: 'Standard', description: null, accent: '#3c3d3a' },
  { key: 'standard_japanese_sans_sealboxes', name: 'standard japanese sans sealboxes', group: 'Standard', description: null, accent: '#3c3d3a' },
  { key: 'standard_euro', name: 'standard euro', group: 'Standard', description: null, accent: '#3c3d3a' },
  { key: 'spreadsheet', name: 'Spreadsheet', group: 'Spreadsheet', description: null, accent: '#000000' },
  { key: 'minimalist', name: 'Minimalist', group: 'Premium', description: 'Logo and Company address is displayed on the footer. Ideal when invoicing for less items', accent: '#d0383e' },
  { key: 'grand', name: 'Grand', group: 'Premium', description: null, accent: '#3c3d3a' },
  { key: 'continental', name: 'Continental', group: 'Premium', description: 'Made to fit snail mail template design confirming to European formatting standards.', accent: '#3c3d3a' },
  { key: 'lite', name: 'Lite', group: 'Universal', description: null, accent: '#3c3d3a' },
  { key: 'simple', name: 'Simple', group: 'Universal', description: null, accent: '#3c3d3a' },
  { key: 'compact', name: 'Compact', group: 'Universal', description: 'Ideal for displaying more items in a single invoice. Item and description will be listed in separate columns.', accent: '#3c3d3a' },
  { key: 'basic', name: 'Basic', group: 'Universal', description: null, accent: '#e2474b' },
];

export const TEMPLATE_GROUPS: TemplateGroup[] = ['Standard', 'Spreadsheet', 'Premium', 'Universal'];

export const templateInfo = (key: TemplateKey): TemplateInfo => TEMPLATE_GALLERY.find((t) => t.key === key) ?? TEMPLATE_GALLERY[0];

export const isTemplateKey = (v: unknown): v is TemplateKey => typeof v === 'string' && (TEMPLATE_KEYS as readonly string[]).includes(v);

/** The documents that print, as Settings → PDF Templates lists them. */
export const TEMPLATE_DOCS = [
  'estimate', 'sales-order', 'challan', 'invoice', 'credit-note', 'purchase-order', 'retainer',
  'payment-received', 'bill', 'vendor-credit', 'payment-made',
] as const;
export type TemplateDoc = (typeof TEMPLATE_DOCS)[number];

/** Zoho's names for them (Rekonza calls retainer invoices Service Invoices). */
export const TEMPLATE_DOC_LABEL: Record<TemplateDoc, string> = {
  estimate: 'Quotes', 'sales-order': 'Sales Orders', challan: 'Delivery Challans', invoice: 'Invoices',
  'credit-note': 'Credit Notes', 'purchase-order': 'Purchase Orders', retainer: 'Service Invoices',
  'payment-received': 'Payment Receipts', bill: 'Bills', 'vendor-credit': 'Vendor Credits', 'payment-made': 'Vendor Payments',
};

/** "Invoice Templates", "Quote Templates" … */
export const TEMPLATE_DOC_SINGULAR: Record<TemplateDoc, string> = {
  estimate: 'Quote', 'sales-order': 'Sales Order', challan: 'Delivery Challan', invoice: 'Invoice',
  'credit-note': 'Credit Note', 'purchase-order': 'Purchase Order', retainer: 'Service Invoice',
  'payment-received': 'Payment Receipt', bill: 'Bill', 'vendor-credit': 'Vendor Credit', 'payment-made': 'Vendor Payment',
};

export const isTemplateDoc = (v: unknown): v is TemplateDoc => typeof v === 'string' && (TEMPLATE_DOCS as readonly string[]).includes(v);

/**
 * The three invoices a business prints, each its own format as Zoho Books India
 * sets them apart: goods (HSN, quantity and unit, triplicate), services (SAC,
 * duplicate) and exports (the export endorsement, the invoice currency, port
 * and shipping bill). Each has its own template and its own title.
 */
export const INVOICE_FORMATS = ['goods', 'services', 'export'] as const;
export type InvoiceFormat = (typeof INVOICE_FORMATS)[number];

export const INVOICE_FORMAT_LABEL: Record<InvoiceFormat, string> = {
  goods: 'Goods Invoice', services: 'Service Invoice', export: 'Export Invoice',
};

/** What each format is called on paper until the business renames it. */
export const DEFAULT_FORMAT_TITLE: Record<InvoiceFormat, string> = {
  goods: 'Tax Invoice', services: 'Tax Invoice', export: 'Export Invoice',
};

export const isInvoiceFormat = (v: unknown): v is InvoiceFormat => typeof v === 'string' && (INVOICE_FORMATS as readonly string[]).includes(v);

/** Which format an invoice prints in: an export by its supply type, else services or goods by what it sells. */
export function invoiceFormatOf(supplyType: string, supplyKind: string): InvoiceFormat {
  if (supplyType === 'export_lut' || supplyType === 'export_with_tax') return 'export';
  return supplyKind === 'service' ? 'services' : 'goods';
}

export interface PrintTemplate {
  /** The default for any document without one of its own. */
  layout: TemplateKey;
  /** The theme colour; null prints each template in its own. */
  accent: string | null;
  showLogo: boolean;
  showSignature: boolean;
  footer: string | null;
  /** The default template of each kind of document, where it differs. */
  byDoc: Partial<Record<TemplateDoc, TemplateKey>>;
  /** The templates added to each kind's list from the gallery (its default always shows). */
  added: Partial<Record<TemplateDoc, TemplateKey[]>>;
  /** Each invoice format's own template, where it differs from the one for invoices. */
  byFormat: Partial<Record<InvoiceFormat, TemplateKey>>;
  /** Each invoice format's title, where the business renamed it (Zoho's "Document Title"). */
  titles: Partial<Record<InvoiceFormat, string>>;
}

export const DEFAULT_TEMPLATE: PrintTemplate = {
  layout: 'standard', accent: null, showLogo: true, showSignature: true, footer: null, byDoc: {}, added: {}, byFormat: {}, titles: {},
};

/** The layouts before the gallery: the old classic sheet reads best as Standard. */
const LEGACY: Record<string, TemplateKey> = { classic: 'standard', modern: 'minimalist', compact: 'compact' };

const keyOf = (v: unknown): TemplateKey | null => (isTemplateKey(v) ? v : typeof v === 'string' && LEGACY[v] ? LEGACY[v] : null);

/** A stored template, or the default, with anything missing or wrong filled from the default. */
export function readTemplate(v: unknown): PrintTemplate {
  let raw: Record<string, unknown> = {};
  try { raw = (typeof v === 'string' ? JSON.parse(v) : v ?? {}) as Record<string, unknown>; } catch { /* the default */ }
  if (!raw || typeof raw !== 'object') raw = {};
  const byDoc: Partial<Record<TemplateDoc, TemplateKey>> = {};
  const added: Partial<Record<TemplateDoc, TemplateKey[]>> = {};
  const rawBy = (raw.byDoc && typeof raw.byDoc === 'object' ? raw.byDoc : {}) as Record<string, unknown>;
  const rawAdded = (raw.added && typeof raw.added === 'object' ? raw.added : {}) as Record<string, unknown>;
  for (const doc of TEMPLATE_DOCS) {
    const k = keyOf(rawBy[doc]);
    if (k) byDoc[doc] = k;
    const list = Array.isArray(rawAdded[doc]) ? (rawAdded[doc] as unknown[]).map(keyOf).filter((x): x is TemplateKey => !!x) : [];
    if (list.length) added[doc] = [...new Set(list)];
  }
  // The old default colour was the classic sheet's ink, not a choice anyone made.
  const accent = typeof raw.accent === 'string' && /^#[0-9a-fA-F]{6}$/.test(raw.accent) && raw.accent.toLowerCase() !== '#0f172a' ? raw.accent : null;
  const byFormat: Partial<Record<InvoiceFormat, TemplateKey>> = {};
  const titles: Partial<Record<InvoiceFormat, string>> = {};
  const rawFormat = (raw.byFormat && typeof raw.byFormat === 'object' ? raw.byFormat : {}) as Record<string, unknown>;
  const rawTitles = (raw.titles && typeof raw.titles === 'object' ? raw.titles : {}) as Record<string, unknown>;
  for (const f of INVOICE_FORMATS) {
    const k = keyOf(rawFormat[f]);
    if (k) byFormat[f] = k;
    const title = typeof rawTitles[f] === 'string' ? (rawTitles[f] as string).trim().slice(0, 60) : '';
    if (title && title.toLowerCase() !== DEFAULT_FORMAT_TITLE[f].toLowerCase()) titles[f] = title;
  }
  return {
    layout: keyOf(raw.layout) ?? DEFAULT_TEMPLATE.layout,
    accent,
    showLogo: raw.showLogo !== false,
    showSignature: raw.showSignature !== false,
    footer: typeof raw.footer === 'string' && raw.footer.trim() ? raw.footer.trim().slice(0, 300) : null,
    byDoc,
    added,
    byFormat,
    titles,
  };
}

/** The template a document prints in: its own choice, else its kind's default, else the business's. */
export function layoutFor(t: PrintTemplate, doc: TemplateDoc, own?: string | null): TemplateKey {
  return keyOf(own) ?? t.byDoc[doc] ?? t.layout;
}

/** The template an invoice prints in: its own choice, else its format's, else the one for invoices. */
export function layoutForInvoice(t: PrintTemplate, format: InvoiceFormat, own?: string | null): TemplateKey {
  return keyOf(own) ?? t.byFormat[format] ?? layoutFor(t, 'invoice');
}

/** What an invoice format is called on paper. */
export const formatTitle = (t: PrintTemplate, format: InvoiceFormat) => t.titles[format] ?? DEFAULT_FORMAT_TITLE[format];

/** The templates a kind lists in settings: its default first, then those added. */
export function templatesOf(t: PrintTemplate, doc: TemplateDoc): TemplateKey[] {
  return [...new Set([layoutFor(t, doc), ...(t.added[doc] ?? [])])];
}

/** The colour a template prints in. */
export const accentOf = (t: PrintTemplate, key: TemplateKey) => t.accent ?? templateInfo(key).accent;
