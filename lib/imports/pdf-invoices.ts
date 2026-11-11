// ─────────────────────────────────────────────────────────────────────────────
// Invoices from PDF: what a reading looks like, and the sample PDFs.
//
// A PDF invoice is read by the AI on the server (lib/server/ai/invoice-capture)
// into an InvoiceReading: whose invoice it is (ours, a sale; or another
// company's to us, a purchase), the other company, the number, date and year,
// and the lines. A person checks the list, then it goes in through the usual
// import (source 'pdf-invoices'): new parties first, then sales invoices and
// supplier bills, all or nothing.
//
// The sample PDFs are written here, in the browser, with nothing but text. Each
// carries what it says as a marked comment, so a server with no AI provider —
// this repository on a laptop, or the online demo — can still show the whole
// way through with them, and never pretends to read anything else.
// Shared by the browser and the server; no server code.
// ─────────────────────────────────────────────────────────────────────────────

export type Direction = 'sale' | 'purchase';

export interface ReadLine { description: string; hsnSac: string | null; qty: number; ratePaise: number; gstRatePct: number }
export interface ReadParty { name: string | null; gstin: string | null; state: string | null }

export interface InvoiceReading {
  file: string;
  /** Ours to a customer (sale), or another company's to us (purchase). */
  direction: Direction;
  /** How that was told: one of our GSTINs on it, our name on it, the sample's own word, or a guess. */
  by: 'gstin' | 'name' | 'sample' | 'guess';
  /** The other company: the customer on a sale, the supplier on a purchase. */
  party: ReadParty;
  /** Both sides as printed, so the screen can swap them when a person changes the direction. */
  seller: ReadParty;
  buyer: ReadParty;
  /** That company in these books, when found by GSTIN or name. */
  matched: { id: string; name: string; kind: string } | null;
  number: string | null;
  date: string | null;
  dueDate: string | null;
  lines: ReadLine[];
  taxablePaise: number | null;
  taxPaise: number | null;
  totalPaise: number | null;
  notes: string[];
  /** Credits the reading cost, in millicredits (0 for a sample). */
  chargedMc: number;
  sample: boolean;
}

/** One checked invoice, as the import takes it. */
export interface PdfImportDoc {
  file: string;
  direction: Direction;
  partyName: string;
  partyGstin: string | null;
  partyState: string | null;
  number: string;
  date: string;
  dueDate: string | null;
  lines: ReadLine[];
}

/** "FY 2026-27" for a date: April to March. */
export function financialYear(date: string | null | undefined): string | null {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const [y, m] = date.split('-').map(Number);
  const start = m < 4 ? y - 1 : y;
  return `FY ${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/** A line's value before tax, and its tax, in paise. */
export const lineTaxable = (l: ReadLine) => Math.round(l.ratePaise * l.qty);
export const lineTax = (l: ReadLine) => Math.round((lineTaxable(l) * l.gstRatePct) / 100);

// ── The sample PDFs ─────────────────────────────────────────────────────────

const MARKER = '%REKONZA-SAMPLE ';

const toB64 = (s: string) => {
  let bin = '';
  for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b);
  return btoa(bin);
};
const fromB64 = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));

/** The invoice a sample PDF made here carries, in the shape the AI answers in; null for any other file. */
export function sampleFromPdf(bytes: Uint8Array): Record<string, unknown> | null {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 4096));
  if (!head.startsWith('%PDF')) return null;
  const m = head.match(/%REKONZA-SAMPLE ([A-Za-z0-9+/=]+)/);
  if (!m) return null;
  try {
    const v = JSON.parse(fromB64(m[1]));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

interface PdfText { x: number; y: number; text: string; size?: number; bold?: boolean; right?: boolean }

/** Helvetica's widths, near enough to right-align figures and headings: digits are 0.556 em, stops and commas 0.278. */
function widthOf(t: string, size: number, bold = false): number {
  let em = 0;
  for (const c of t) {
    // Bold widens letters; Helvetica's digits are the same width either way.
    em += (bold && /[A-Za-z]/.test(c) ? 1.08 : 1) * (/[0-9$#_]/.test(c) ? 0.556 : /[.,:;!' |/\\-]/.test(c) ? 0.278 : c === '%' ? 0.889 : /[A-Z&]/.test(c) ? 0.68 : /[mw]/.test(c) ? 0.85 : /[ijlft]/.test(c) ? 0.3 : 0.54);
  }
  return em * size;
}
const esc = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`).replace(/[^\x20-\x7e]/g, '?');

/** A one-page A4 PDF of plain text and rules. Everything in it is ASCII, so its length is its size in bytes. */
export function simplePdf(texts: PdfText[], rules: [number, number, number, number][], marker = ''): Uint8Array {
  const content = [
    '0.6 w',
    ...rules.map(([x1, y1, x2, y2]) => `${x1} ${y1} m ${x2} ${y2} l S`),
    'BT',
    ...texts.map((t) => {
      const size = t.size ?? 9;
      const x = t.right ? t.x - widthOf(t.text, size, t.bold) : t.x;
      return `/${t.bold ? 'F2' : 'F1'} ${size} Tf 1 0 0 1 ${x.toFixed(1)} ${t.y} Tm (${esc(t.text)}) Tj`;
    }),
    'ET',
  ].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let out = `%PDF-1.4\n${marker ? `${marker}\n` : ''}`;
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

interface Company { name: string; gstin: string | null; address: string; state: string }

const SUPPLIER: Company = { name: 'Lakshmi Auto Components', gstin: '33AAECL4721K1ZL', address: '14 SIDCO Industrial Estate, Ambattur, Chennai 600098', state: 'Tamil Nadu' };
// The same two parties as the sample Tally data's: tried together, each PDF finds its contact by GSTIN.
const CUSTOMER: Company = { name: 'Kaveri Motors', gstin: '29AAGFK4410P1ZZ', address: '88 Mysore Road, Bengaluru 560026', state: 'Karnataka' };

const STATE_BY_CODE: Record<string, string> = { '29': 'Karnataka', '33': 'Tamil Nadu', '27': 'Maharashtra', '32': 'Kerala', '36': 'Telangana', '37': 'Andhra Pradesh', '07': 'Delhi', '24': 'Gujarat' };

const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const dmy = (iso: string) => iso.split('-').reverse().join('-');
const money = (paise: number) => (paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * A sample tax invoice as a PDF: a supplier's bill to us ('purchase'), or our
 * own invoice to a customer ('sale'). `ours` is this company, so its name and
 * GSTIN appear where a real invoice would have them.
 */
export function sampleInvoicePdf(kind: Direction, ours: { name: string; gstin: string | null }, today: string): { bytes: Uint8Array; filename: string } {
  const us: Company = {
    name: ours.name || 'Your company', gstin: ours.gstin || null, address: '',
    state: (ours.gstin && STATE_BY_CODE[ours.gstin.slice(0, 2)]) || 'Tamil Nadu',
  };
  const seller = kind === 'purchase' ? SUPPLIER : us;
  const buyer = kind === 'purchase' ? us : CUSTOMER;
  const date = addDays(today, -3);
  const start = Number(date.slice(5, 7)) < 4 ? Number(date.slice(0, 4)) - 1 : Number(date.slice(0, 4));
  const fy = `${String(start).slice(2)}-${String((start + 1) % 100).padStart(2, '0')}`;
  const number = kind === 'purchase' ? `LAC/${fy}/0418` : `OLD/${fy}/0107`;
  const lines = kind === 'purchase'
    ? [
      { description: 'Brake pad set, front (Swift)', hsn_sac: '87083000', quantity: 40, unit_rate: 620, gst_rate_pct: 18 },
      { description: 'Clutch plate assembly', hsn_sac: '87089300', quantity: 12, unit_rate: 1850, gst_rate_pct: 18 },
      { description: 'Rubber engine mount', hsn_sac: '40169390', quantity: 25, unit_rate: 240, gst_rate_pct: 18 },
    ]
    : [
      { description: 'Shock absorber, rear pair', hsn_sac: '87088000', quantity: 6, unit_rate: 3200, gst_rate_pct: 18 },
      { description: 'Wheel alignment service', hsn_sac: '998714', quantity: 1, unit_rate: 1500, gst_rate_pct: 18 },
    ];
  const taxable = lines.reduce((t, l) => t + Math.round(l.unit_rate * 100) * l.quantity, 0);
  const tax = lines.reduce((t, l) => t + Math.round((Math.round(l.unit_rate * 100) * l.quantity * l.gst_rate_pct) / 100), 0);
  const interState = !!seller.gstin && !!buyer.gstin && seller.gstin.slice(0, 2) !== buyer.gstin.slice(0, 2);

  const raw = {
    seller_name: seller.name, seller_gstin: seller.gstin, seller_state: seller.state,
    buyer_name: buyer.name, buyer_gstin: buyer.gstin, buyer_state: buyer.state,
    invoice_number: number, invoice_date: date, due_date: addDays(date, 30),
    lines, taxable_total: taxable / 100, tax_total: tax / 100, grand_total: (taxable + tax) / 100,
    _sample: { direction: kind },
  };

  const t: PdfText[] = [];
  const r: [number, number, number, number][] = [];
  t.push({ x: 40, y: 796, text: 'TAX INVOICE', size: 16, bold: true });
  t.push({ x: 555, y: 796, text: 'Original for recipient', size: 8, right: true });
  r.push([40, 786, 555, 786]);
  const block = (x: number, y: number, head: string, c: Company) => {
    t.push({ x, y, text: head, size: 8 });
    t.push({ x, y: y - 14, text: c.name, size: 11, bold: true });
    let at = y - 27;
    if (c.address) {
      t.push({ x, y: at, text: c.address, size: 8 });
      at -= 13;
    }
    t.push({ x, y: at, text: c.gstin ? `GSTIN: ${c.gstin}` : 'GSTIN: not registered', size: 8 });
    t.push({ x, y: at - 12, text: `State: ${c.state}${c.gstin ? `, code ${c.gstin.slice(0, 2)}` : ''}`, size: 8 });
  };
  block(40, 770, 'Sold by', seller);
  t.push({ x: 380, y: 770, text: 'Invoice no.', size: 8 });
  t.push({ x: 380, y: 756, text: number, size: 11, bold: true });
  t.push({ x: 380, y: 740, text: `Invoice date: ${dmy(date)}`, size: 8 });
  t.push({ x: 380, y: 728, text: `Due date: ${dmy(addDays(date, 30))}`, size: 8 });
  t.push({ x: 380, y: 716, text: `Place of supply: ${buyer.state}`, size: 8 });
  r.push([40, 702, 555, 702]);
  block(40, 688, 'Bill to', buyer);

  // The lines.
  // Description and HSN from the left; the figures right-aligned on these edges.
  const cols = { no: 40, desc: 60, hsn: 262, qty: 345, rate: 412, gst: 458, amount: 552 };
  let y = 600;
  r.push([40, y + 14, 555, y + 14]);
  t.push({ x: cols.no, y, text: '#', size: 8, bold: true });
  t.push({ x: cols.desc, y, text: 'Description', size: 8, bold: true });
  t.push({ x: cols.hsn, y, text: 'HSN/SAC', size: 8, bold: true });
  t.push({ x: cols.qty, y, text: 'Qty', size: 8, bold: true, right: true });
  t.push({ x: cols.rate, y, text: 'Rate', size: 8, bold: true, right: true });
  t.push({ x: cols.gst, y, text: 'GST %', size: 8, bold: true, right: true });
  t.push({ x: cols.amount, y, text: 'Amount', size: 8, bold: true, right: true });
  r.push([40, y - 6, 555, y - 6]);
  lines.forEach((l, i) => {
    y -= 20;
    const amount = Math.round(l.unit_rate * 100) * l.quantity;
    t.push({ x: cols.no, y, text: String(i + 1), size: 9 });
    t.push({ x: cols.desc, y, text: l.description, size: 9 });
    t.push({ x: cols.hsn, y, text: l.hsn_sac, size: 9 });
    t.push({ x: cols.qty, y, text: String(l.quantity), size: 9, right: true });
    t.push({ x: cols.rate, y, text: money(l.unit_rate * 100), size: 9, right: true });
    t.push({ x: cols.gst, y, text: String(l.gst_rate_pct), size: 9, right: true });
    t.push({ x: cols.amount, y, text: money(amount), size: 9, right: true });
  });
  y -= 14;
  r.push([40, y, 555, y]);

  // The totals.
  const total = (label: string, paise: number, bold = false) => {
    y -= 16;
    t.push({ x: 458, y, text: label, size: 9, bold, right: true });
    t.push({ x: cols.amount, y, text: `Rs. ${money(paise)}`, size: 9, bold, right: true });
  };
  total('Taxable value', taxable);
  if (interState) total('IGST', tax);
  else {
    total('CGST', Math.floor(tax / 2));
    total('SGST', tax - Math.floor(tax / 2));
  }
  total('Total', taxable + tax, true);

  t.push({ x: 40, y: 90, text: 'This is a sample invoice made by Rekonza, to try reading invoices from PDF. It is not a real document.', size: 7 });
  t.push({ x: 555, y: 60, text: `For ${seller.name}`, size: 8, right: true });
  t.push({ x: 555, y: 40, text: 'Authorised signatory', size: 7, right: true });

  return {
    bytes: simplePdf(t, r, `${MARKER}${toB64(JSON.stringify(raw))}`),
    filename: `sample-${kind === 'purchase' ? 'supplier-bill' : 'our-invoice'}-${number.replace(/\//g, '-')}.pdf`,
  };
}
