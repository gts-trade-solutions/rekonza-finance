import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Reading an invoice from a PDF or a photo, whichever way it runs.
//
// A bill (bill-capture.ts) is always a supplier's to us. An invoice brought in
// from a pile of PDFs may be either: our own, issued to a customer (from the
// old system, say), or another company's to us. So the model is asked for both
// parties, and the invoice is placed by our own GSTINs — one of ours as the
// seller makes it a sale, as the buyer a purchase — then by our name, and if
// neither is on it, taken as a supplier's bill with a note saying so. The
// other company is matched in the contacts by GSTIN, then by name.
//
// What comes back is for a person to check (lib/imports/pdf-invoices.ts), and
// is charged like a bill. A sample PDF made by the import screen carries its
// own contents and is read without the AI, at no charge.
// ─────────────────────────────────────────────────────────────────────────────

import { db, type Executor } from '../db';
import { ApiError } from '../http';
import { isValidGstin } from '../../tax/gst';
import { sampleFromPdf, type Direction, type InvoiceReading, type ReadParty } from '../../imports/pdf-invoices';
import { capturedLines, chargedRead, isoDate, paise, sumNotes, type CaptureDeps, type CaptureFile, type CaptureSpec } from './bill-capture';

const party = (who: string) => ({
  [`${who}_name`]: { type: ['string', 'null'] },
  [`${who}_gstin`]: { type: ['string', 'null'], description: `The ${who}'s 15-character GSTIN, as printed` },
  [`${who}_state`]: { type: ['string', 'null'], description: `The ${who}'s state, by name or two-digit GST code` },
});

const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: [
    'seller_name', 'seller_gstin', 'seller_state', 'buyer_name', 'buyer_gstin', 'buyer_state',
    'invoice_number', 'invoice_date', 'due_date', 'lines', 'taxable_total', 'tax_total', 'grand_total',
  ],
  properties: {
    ...party('seller'),
    ...party('buyer'),
    invoice_number: { type: ['string', 'null'] },
    invoice_date: { type: ['string', 'null'], description: 'yyyy-mm-dd' },
    due_date: { type: ['string', 'null'], description: 'yyyy-mm-dd, only if printed' },
    lines: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['description', 'hsn_sac', 'quantity', 'unit_rate', 'gst_rate_pct'],
        properties: {
          description: { type: 'string' },
          hsn_sac: { type: ['string', 'null'] },
          quantity: { type: 'number' },
          unit_rate: { type: 'number', description: 'Rupees per unit before GST and after any line discount' },
          gst_rate_pct: { type: 'number', description: 'Total GST rate: CGST + SGST, or IGST. 0 if none.' },
        },
      },
    },
    taxable_total: { type: ['number', 'null'], description: 'Rupees before GST' },
    tax_total: { type: ['number', 'null'], description: 'All GST and cess, rupees' },
    grand_total: { type: ['number', 'null'], description: 'Rupees, as printed' },
  },
};

const PROMPT =
  'Read this Indian GST tax invoice and return its fields. The seller is the party issuing the invoice; the buyer is the ' +
  'party it is billed to. Copy names, GSTINs and numbers exactly as printed; amounts in rupees as plain numbers; dates as ' +
  'yyyy-mm-dd. Use null for anything not on the invoice rather than guessing.';

export const INVOICE_SPEC: CaptureSpec = { name: 'tax_invoice', schema: SCHEMA, prompt: PROMPT, what: 'invoice' };

export interface CapturedInvoice {
  seller: ReadParty;
  buyer: ReadParty;
  number: string | null;
  date: string | null;
  dueDate: string | null;
  lines: ReturnType<typeof capturedLines>;
  taxablePaise: number | null;
  taxPaise: number | null;
  totalPaise: number | null;
}

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) || null : null);
const gstinOf = (v: unknown) => (typeof v === 'string' ? v.replace(/\s/g, '').toUpperCase() || null : null);

/** The model's JSON (or a sample's), tidied. Exported for the tests. */
export function toCapturedInvoice(raw: Record<string, unknown>): CapturedInvoice {
  const p = (who: string): ReadParty => ({ name: text(raw[`${who}_name`], 200), gstin: gstinOf(raw[`${who}_gstin`]), state: text(raw[`${who}_state`], 60) });
  return {
    seller: p('seller'),
    buyer: p('buyer'),
    number: text(raw.invoice_number, 50),
    date: isoDate(raw.invoice_date),
    dueDate: isoDate(raw.due_date),
    lines: capturedLines(raw.lines),
    taxablePaise: paise(raw.taxable_total as number | null),
    taxPaise: paise(raw.tax_total as number | null),
    totalPaise: paise(raw.grand_total as number | null),
  };
}

/** A company name with "M/s", "Pvt Ltd" and the punctuation taken away, to compare. */
const plain = (s: string) => s.toLowerCase().replace(/^m\/s\.?\s*/, '').replace(/[^a-z0-9]/g, '').replace(/(privatelimited|pvtltd|limited|ltd|llp)$/, '');

/** Whose invoice: one of our GSTINs as the seller is a sale, as the buyer a purchase; then our name; else taken as a purchase. */
export function whoseInvoice(inv: CapturedInvoice, ours: { gstins: string[]; names: string[] }): { direction: Direction; by: 'gstin' | 'name' | 'guess' } {
  const gstins = new Set(ours.gstins.map((g) => g.toUpperCase()));
  if (inv.seller.gstin && gstins.has(inv.seller.gstin)) return { direction: 'sale', by: 'gstin' };
  if (inv.buyer.gstin && gstins.has(inv.buyer.gstin)) return { direction: 'purchase', by: 'gstin' };
  const names = new Set(ours.names.filter(Boolean).map(plain));
  if (inv.seller.name && names.has(plain(inv.seller.name))) return { direction: 'sale', by: 'name' };
  if (inv.buyer.name && names.has(plain(inv.buyer.name))) return { direction: 'purchase', by: 'name' };
  return { direction: 'purchase', by: 'guess' };
}

/** What to look at before bringing it in. */
export function invoiceNotes(inv: CapturedInvoice, direction: Direction, by: InvoiceReading['by']): string[] {
  const notes: string[] = [];
  const other = direction === 'sale' ? inv.buyer : inv.seller;
  if (by === 'guess') notes.push('Neither GSTIN on it is one of yours, so it is taken as a supplier\'s bill. Switch it to a sale if your company issued it.');
  if (!other.name) notes.push(`The ${direction === 'sale' ? 'customer' : 'supplier'}'s name was not found.`);
  if (other.gstin && !isValidGstin(other.gstin)) notes.push(`The GSTIN read, ${other.gstin}, fails its check digit: compare it with the invoice.`);
  if (!other.gstin && !other.state) notes.push('No GSTIN or state for the other company: give the state, for the tax to be worked out.');
  if (!inv.number) notes.push('No invoice number was found.');
  else if (direction === 'sale' && inv.number.length > 16) notes.push(`${inv.number} is longer than the 16 characters GST allows for an invoice number.`);
  if (!inv.date) notes.push('No invoice date was found.');
  if (!inv.lines.length) notes.push('No lines were found.');
  notes.push(...sumNotes(inv.lines, inv.taxablePaise, inv.totalPaise, 'invoice'));
  return notes;
}

/** This company's GSTINs and names, to tell its own invoices from others'. */
export async function ourIdentity(ex: Executor, orgId: number) {
  const branches = await ex.selectFrom('branches').select('gstin').where('org_id', '=', orgId).execute();
  const org = await ex.selectFrom('organizations').select(['name', 'legal_name']).where('id', '=', orgId).executeTakeFirst();
  return {
    gstins: branches.map((b) => b.gstin).filter((g): g is string => !!g),
    names: [org?.name ?? '', org?.legal_name ?? ''],
  };
}

/** The other company in the contacts: by GSTIN, then by name. */
export async function matchParty(ex: Executor, orgId: number, p: ReadParty) {
  if (p.gstin) {
    const c = await ex.selectFrom('contacts').select(['id', 'display_name', 'kind']).where('org_id', '=', orgId).where('gstin', '=', p.gstin).executeTakeFirst();
    if (c) return { id: String(c.id), name: c.display_name, kind: c.kind };
  }
  if (p.name) {
    const c = await ex.selectFrom('contacts').select(['id', 'display_name', 'kind']).where('org_id', '=', orgId)
      .where((eb) => eb.or([eb('display_name', '=', p.name!), eb('legal_name', '=', p.name!)])).executeTakeFirst();
    if (c) return { id: String(c.id), name: c.display_name, kind: c.kind };
  }
  return null;
}

function reading(file: string, inv: CapturedInvoice, direction: Direction, by: InvoiceReading['by'], matched: InvoiceReading['matched'], chargedMc: number, sample: boolean): InvoiceReading {
  const other = direction === 'sale' ? inv.buyer : inv.seller;
  return {
    file, direction, by, party: other, seller: inv.seller, buyer: inv.buyer, matched,
    number: inv.number, date: inv.date, dueDate: inv.dueDate,
    lines: inv.lines, taxablePaise: inv.taxablePaise, taxPaise: inv.taxPaise, totalPaise: inv.totalPaise,
    notes: invoiceNotes(inv, direction, by), chargedMc, sample,
  };
}

/**
 * Read one invoice: the AI for any PDF or photo (charged), a sample PDF from its
 * own contents (free). Then whose it is, and the other company in the books.
 */
export async function captureInvoice(orgId: number, userId: number, file: CaptureFile, deps: CaptureDeps = {}): Promise<InvoiceReading> {
  const ex = deps.ex ?? db;
  const sample = file.contentType === 'application/pdf' ? sampleFromPdf(new Uint8Array(file.bytes)) : null;
  const read = sample ? { raw: sample, chargedMc: 0 } : await chargedRead(orgId, userId, file, INVOICE_SPEC, 'invoice-capture', deps);
  const inv = toCapturedInvoice(read.raw);
  const { direction, by } = whoseInvoice(inv, await ourIdentity(ex, orgId));
  const other = direction === 'sale' ? inv.buyer : inv.seller;
  return reading(file.filename, inv, direction, by, await matchParty(ex, orgId, other), read.chargedMc, !!sample);
}

/**
 * The online demo has no database and no AI: it reads the sample PDFs alone,
 * placed by their own word, and says so for anything else.
 */
export function captureSampleOffline(file: CaptureFile): InvoiceReading {
  const sample = file.contentType === 'application/pdf' ? sampleFromPdf(new Uint8Array(file.bytes)) : null;
  if (!sample) {
    throw new ApiError(403, 'The online demo reads only the sample PDFs. On your own site, the AI reads any invoice PDF or photo.', 'demo_read_only');
  }
  const direction: Direction = (sample._sample as { direction?: string } | undefined)?.direction === 'sale' ? 'sale' : 'purchase';
  return reading(file.filename, toCapturedInvoice(sample), direction, 'sample', null, 0, true);
}

