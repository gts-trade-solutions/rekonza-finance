import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Reading a supplier's bill from a PDF or a photo.
//
// The image goes to the same model provider the assistant uses, asked for the
// bill's fields in a fixed JSON shape. What comes back is a draft for a person
// to check, never a bill: it fills the New Bill form, and the file itself is
// attached once the bill is saved. The supplier is matched by GSTIN, then by
// name; the GSTIN's check digit and the bill's own arithmetic are checked, and
// anything that does not add up is said, not silently fixed.
//
// Charged like a question — what the provider billed, in credits — and
// refused before anything is sent when the wallet cannot cover the minimum.
// No lock is held while the model reads: that can take a while, and every
// other charge to the wallet would wait behind it.
// ─────────────────────────────────────────────────────────────────────────────

import { db, transaction, type Executor, type Trx } from '../db';
import { badRequest, ApiError } from '../http';
import { isValidGstin } from '../../tax/gst';
import { aiMode, creditCostUsd, openAiSettings } from './config';
import { costMicroUsd, millicreditsFor, MIN_CHARGE_MC, priceFor } from './pricing';
import { aiSettingsFor } from './settings';
import { prepareWallet, spendCredits, walletView } from '../billing/wallet';

export interface CapturedLine { description: string; hsnSac: string | null; qty: number; ratePaise: number; gstRatePct: number }
export interface CapturedBill {
  vendorName: string | null;
  vendorGstin: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  dueDate: string | null;
  lines: CapturedLine[];
  taxablePaise: number | null;
  taxPaise: number | null;
  totalPaise: number | null;
}

const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['vendor_name', 'vendor_gstin', 'invoice_number', 'invoice_date', 'due_date', 'lines', 'taxable_total', 'tax_total', 'grand_total'],
  properties: {
    vendor_name: { type: ['string', 'null'], description: 'The supplier who issued the bill' },
    vendor_gstin: { type: ['string', 'null'], description: "The supplier's 15-character GSTIN, not the buyer's" },
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
} as const;

const PROMPT =
  'Read this Indian GST purchase bill (tax invoice) and return its fields. Copy numbers exactly as printed; ' +
  'amounts in rupees as plain numbers. Use null for anything not on the bill rather than guessing. ' +
  'The supplier is the party issuing the bill; ignore the buyer\'s details.';

/** A capture costs at least this, in millicredits, however small the image. */
export const CAPTURE_MIN_MC = 5 * MIN_CHARGE_MC;

const paise = (rupees: number | null | undefined) => (typeof rupees === 'number' && Number.isFinite(rupees) ? Math.round(rupees * 100) : null);
const date = (s: string | null) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null);

/** The model's JSON as a draft bill. Exported for the tests. */
export function toCaptured(raw: Record<string, unknown>): CapturedBill {
  const lines = Array.isArray(raw.lines) ? raw.lines as Record<string, unknown>[] : [];
  const gstin = typeof raw.vendor_gstin === 'string' ? raw.vendor_gstin.replace(/\s/g, '').toUpperCase() : null;
  return {
    vendorName: typeof raw.vendor_name === 'string' ? raw.vendor_name.trim() || null : null,
    vendorGstin: gstin || null,
    invoiceNumber: typeof raw.invoice_number === 'string' ? raw.invoice_number.trim().slice(0, 50) || null : null,
    invoiceDate: date(raw.invoice_date as string | null),
    dueDate: date(raw.due_date as string | null),
    lines: lines.map((l) => ({
      description: String(l.description ?? '').trim().slice(0, 500),
      hsnSac: typeof l.hsn_sac === 'string' && /^\d{4,8}$/.test(l.hsn_sac.trim()) ? l.hsn_sac.trim() : null,
      qty: Number(l.quantity) > 0 ? Number(l.quantity) : 1,
      ratePaise: paise(Number(l.unit_rate)) ?? 0,
      gstRatePct: [0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 7.5, 12, 18, 28, 40].includes(Number(l.gst_rate_pct)) ? Number(l.gst_rate_pct) : 18,
    })).filter((l) => l.description || l.ratePaise),
    taxablePaise: paise(raw.taxable_total as number | null),
    taxPaise: paise(raw.tax_total as number | null),
    totalPaise: paise(raw.grand_total as number | null),
  };
}

/** What a person should look at before saving. */
export function reviewNotes(bill: CapturedBill): string[] {
  const notes: string[] = [];
  if (bill.vendorGstin && !isValidGstin(bill.vendorGstin)) notes.push(`The GSTIN read, ${bill.vendorGstin}, fails its check digit: compare it with the bill.`);
  if (!bill.invoiceNumber) notes.push('No bill number was found.');
  if (!bill.invoiceDate) notes.push('No bill date was found.');
  if (!bill.lines.length) notes.push('No lines were found; add them by hand.');
  const taxable = bill.lines.reduce((t, l) => t + Math.round(l.ratePaise * l.qty), 0);
  if (bill.taxablePaise !== null && Math.abs(taxable - bill.taxablePaise) > 100) {
    notes.push(`The lines add up to ₹${(taxable / 100).toFixed(2)} before tax, but the bill says ₹${(bill.taxablePaise / 100).toFixed(2)}.`);
  }
  const tax = bill.lines.reduce((t, l) => t + Math.round((Math.round(l.ratePaise * l.qty) * l.gstRatePct) / 100), 0);
  if (bill.totalPaise !== null && Math.abs(taxable + tax - bill.totalPaise) > 200) {
    notes.push(`Lines and tax come to ₹${((taxable + tax) / 100).toFixed(2)}; the bill's total is ₹${(bill.totalPaise / 100).toFixed(2)}. Check rates, discounts, cess or round-off.`);
  }
  return notes;
}

/** The supplier in the books: by GSTIN first, then by name. */
export async function matchVendor(ex: Executor, orgId: number, bill: CapturedBill) {
  if (bill.vendorGstin) {
    const byGstin = await ex.selectFrom('contacts').select(['id', 'display_name']).where('org_id', '=', orgId).where('gstin', '=', bill.vendorGstin).where('kind', 'in', ['vendor', 'both']).executeTakeFirst();
    if (byGstin) return { id: String(byGstin.id), name: byGstin.display_name, by: 'gstin' as const };
  }
  if (bill.vendorName) {
    const byName = await ex.selectFrom('contacts').select(['id', 'display_name']).where('org_id', '=', orgId).where('kind', 'in', ['vendor', 'both'])
      .where((eb) => eb.or([eb('display_name', '=', bill.vendorName!), eb('legal_name', '=', bill.vendorName!)])).executeTakeFirst();
    if (byName) return { id: String(byName.id), name: byName.display_name, by: 'name' as const };
  }
  return null;
}

type Reader = (file: { bytes: Buffer; contentType: string; filename: string }) => Promise<{ raw: Record<string, unknown>; inputTokens: number; outputTokens: number; model: string }>;

/** Ask the configured provider to read the bill. */
const readWithOpenAi: Reader = async (file) => {
  const cfg = openAiSettings();
  if (!cfg) throw new ApiError(503, 'Reading bills needs an AI provider: set OPENAI_API_KEY on the server.', 'ai_unconfigured');
  const model = process.env.BILL_CAPTURE_MODEL?.trim() || cfg.model;
  const data = `data:${file.contentType};base64,${file.bytes.toString('base64')}`;
  const part = file.contentType === 'application/pdf'
    ? { type: 'file', file: { filename: file.filename || 'bill.pdf', file_data: data } }
    : { type: 'image_url', image_url: { url: data, detail: 'high' } };
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    signal: AbortSignal.timeout(90_000),
    headers: {
      'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}`,
      ...(cfg.organization ? { 'OpenAI-Organization': cfg.organization } : {}),
      ...(cfg.project ? { 'OpenAI-Project': cfg.project } : {}),
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT }, part] }],
      response_format: { type: 'json_schema', json_schema: { name: 'purchase_bill', strict: true, schema: SCHEMA } },
    }),
  });
  const body = await res.json().catch(() => null) as { choices?: { message?: { content?: string; refusal?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number }; error?: { message?: string } } | null;
  if (!res.ok) throw new ApiError(502, `The AI provider could not read the bill: ${body?.error?.message ?? res.status}`, 'ai_failed');
  const content = body?.choices?.[0]?.message?.content;
  if (!content) throw new ApiError(502, body?.choices?.[0]?.message?.refusal ?? 'The AI provider returned nothing for this bill.', 'ai_failed');
  return { raw: JSON.parse(content), inputTokens: body?.usage?.prompt_tokens ?? 0, outputTokens: body?.usage?.completion_tokens ?? 0, model };
};

/**
 * Read a bill: check the AI is on and there are credits, read it, charge for it,
 * and hand back a draft with the supplier matched and notes for review.
 */
export async function captureBill(
  orgId: number, userId: number, file: { bytes: Buffer; contentType: string; filename: string },
  deps: { ex?: Executor; inTrx?: <T>(fn: (trx: Trx) => Promise<T>) => Promise<T>; reader?: Reader } = {},
) {
  const ex = deps.ex ?? db;
  const inTrx = deps.inTrx ?? transaction;
  const reader = deps.reader ?? readWithOpenAi;
  if (!['application/pdf', 'image/png', 'image/jpeg', 'image/webp'].includes(file.contentType)) {
    throw badRequest('Send the bill as a PDF or a photo (PNG, JPEG or WebP).');
  }
  if (file.bytes.length > 8 * 1024 * 1024) throw badRequest('Keep the file under 8 MB.');
  const settings = await aiSettingsFor(ex, orgId);
  if (!settings.enabled) throw new ApiError(403, 'Turn on the AI assistant in Settings to read bills with it.', 'ai_disabled');
  if (aiMode() === 'unconfigured' && reader === readWithOpenAi) throw new ApiError(503, 'Reading bills needs an AI provider: set OPENAI_API_KEY on the server.', 'ai_unconfigured');

  // The wallet is checked before anything is sent: no credits, no call. A
  // short transaction first, for any credits due today (the demo's daily ones).
  await inTrx((trx) => prepareWallet(trx, orgId, new Date(), { isDemo: settings.isDemo }));
  if ((await walletView(ex, orgId)).availableMc < CAPTURE_MIN_MC) {
    throw new ApiError(402, 'Not enough AI credits to read a bill. Top up in Settings → Billing.', 'out_of_credits');
  }
  const read = await reader(file);
  const cost = costMicroUsd({ inputTokens: read.inputTokens, cachedTokens: 0, outputTokens: read.outputTokens }, priceFor(read.model).price);
  const mc = Math.max(CAPTURE_MIN_MC, millicreditsFor(cost, creditCostUsd()));
  const spent = await inTrx((trx) => spendCredits(trx, orgId, userId, mc, {
    provider: 'bill-capture', model: read.model, note: `Read a bill: ${file.filename}`.slice(0, 200), monthlyCapMc: settings.userMonthlyCapMc,
  }));

  const bill = toCaptured(read.raw);
  return { bill, vendor: await matchVendor(ex, orgId, bill), notes: reviewNotes(bill), chargedMc: spent.chargedMc };
}
