import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Bringing in invoices read from PDFs (lib/imports/pdf-invoices.ts).
//
// The checked list becomes the same rows a spreadsheet import takes, so every
// rule those imports keep — numbers, dates, HSN codes, locked periods — is
// kept here too, and one transaction holds all of it:
//
//   1. the other companies not yet in the contacts, as customers, suppliers,
//      or both when the list has them on both sides;
//   2. our own invoices, as sales invoices under their own numbers;
//   3. other companies' invoices to us, as bills under their numbers.
//
// A company already in the contacts is found by GSTIN, then by name, and used
// under its own name. One set up only as a customer that now sends us a bill
// (or the other way round) becomes both, and the outcome says so.
//
// The same PDF chosen twice, or one already brought in, is left out and named:
// a pile of PDFs is easily read twice, and an invoice must never go in twice.
// ─────────────────────────────────────────────────────────────────────────────

import type { Trx } from '../db';
import { runImport, type ImportContext, type ImportOutcome, type Row } from './run';
import type { PdfImportDoc } from '../../imports/pdf-invoices';

const plain = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
const rupees = (paise: number) => (paise / 100).toFixed(2);

interface Known { id: number; name: string; kind: string; gstin: string | null; legal: string | null }

/** The rows each import takes, which file each row came from, and what was left out. */
export async function pdfImportRows(trx: Trx, orgId: number, docs: PdfImportDoc[]) {
  const contacts = (await trx.selectFrom('contacts').select(['id', 'display_name', 'legal_name', 'gstin', 'kind']).where('org_id', '=', orgId).execute())
    .map((c): Known => ({ id: c.id, name: c.display_name, kind: c.kind, gstin: c.gstin, legal: c.legal_name }));
  const byGstin = new Map(contacts.filter((c) => c.gstin).map((c) => [c.gstin!.toUpperCase(), c]));
  const byName = new Map<string, Known>();
  for (const c of contacts) {
    byName.set(plain(c.name), c);
    if (c.legal) byName.set(plain(c.legal), c);
  }
  const knownFor = (d: PdfImportDoc) => (d.partyGstin && byGstin.get(d.partyGstin.toUpperCase())) || byName.get(plain(d.partyName)) || null;
  const partyKey = (d: PdfImportDoc) => d.partyGstin?.toUpperCase() || plain(d.partyName);

  // Our own invoice numbers already used: a sale under one of them is already in.
  const saleNumbers = [...new Set(docs.filter((d) => d.direction === 'sale').map((d) => d.number))];
  const usedSales = new Set(saleNumbers.length
    ? (await trx.selectFrom('invoices').select('number').where('org_id', '=', orgId).where('number', 'in', saleNumbers).execute()).map((r) => r.number.toLowerCase())
    : []);

  // The companies each side needs: found, or to be added.
  const fresh = new Map<string, { name: string; gstin: string | null; state: string | null; sale: boolean; purchase: boolean }>();
  const widen = new Map<number, { name: string; kind: string; sale: boolean; purchase: boolean }>();
  const nameFor = (d: PdfImportDoc, known: Known | null): string => {
    if (known) {
      const w = widen.get(known.id) ?? { name: known.name, kind: known.kind, sale: false, purchase: false };
      w[d.direction] = true;
      widen.set(known.id, w);
      return known.name;
    }
    const key = partyKey(d);
    const f = fresh.get(key) ?? { name: d.partyName.trim(), gstin: d.partyGstin?.toUpperCase() || null, state: d.partyState?.trim() || null, sale: false, purchase: false };
    f[d.direction] = true;
    fresh.set(key, f);
    return f.name;
  };

  const invoices: Row[] = [];
  const bills: Row[] = [];
  const invoiceFiles: string[] = [];
  const billFiles: string[] = [];
  const already = { sale: [] as string[], purchase: [] as string[] };
  const twice = { sale: [] as string[], purchase: [] as string[] };
  const seen = new Set<string>();
  for (const d of docs) {
    const label = `${d.file} (${d.number})`;
    const known = knownFor(d);
    // A sale's number is ours, so unique on its own; a bill's is unique only for its supplier.
    const key = d.direction === 'sale' ? `sale|${d.number.toLowerCase()}` : `purchase|${known ? `#${known.id}` : partyKey(d)}|${d.number.toLowerCase()}`;
    if (seen.has(key)) {
      twice[d.direction].push(label);
      continue;
    }
    seen.add(key);
    if (d.direction === 'sale' && usedSales.has(d.number.toLowerCase())) {
      already.sale.push(label);
      continue;
    }
    if (d.direction === 'purchase' && known) {
      const bill = await trx.selectFrom('bills').select('id').where('org_id', '=', orgId).where('vendor_id', '=', known.id).where('vendor_invoice_no', '=', d.number).executeTakeFirst();
      if (bill) {
        already.purchase.push(label);
        continue;
      }
    }
    const name = nameFor(d, known);
    for (const l of d.lines) {
      const line = {
        date: d.date, due_date: d.dueDate ?? '', description: l.description || 'As per invoice', hsn_sac: l.hsnSac ?? '',
        qty: String(l.qty), rate: rupees(l.ratePaise), gst_rate: String(l.gstRatePct),
      };
      if (d.direction === 'sale') {
        invoices.push({ invoice_no: d.number, customer: name, ...line });
        invoiceFiles.push(d.file);
      } else {
        bills.push({ bill_no: d.number, vendor: name, ...line });
        billFiles.push(d.file);
      }
    }
  }

  const contactRows: Row[] = [...fresh.values()].map((f) => ({
    type: f.sale && f.purchase ? 'both' : f.sale ? 'customer' : 'vendor',
    name: f.name, gstin: f.gstin ?? '', state: f.gstin ? '' : f.state ?? '',
  }));
  // Known companies now needed on a side they are not set up for.
  const widened = [...widen.entries()]
    .filter(([, w]) => w.kind !== 'both' && ((w.sale && w.kind !== 'customer') || (w.purchase && w.kind !== 'vendor')))
    .map(([id, w]) => ({ id, name: w.name }));

  return { contactRows, invoices, bills, invoiceFiles, billFiles, widened, already, twice };
}

/** Errors under the file they came from, not a spreadsheet row nobody can see. */
const byFile = (errors: ImportOutcome['errors'], files: string[]) =>
  errors.map((e) => ({ row: 0, message: `${files[e.row - 2] ?? 'An invoice'}: ${e.message}` }));

/** Bring the checked invoices in: parties, then sales invoices, then bills, in the caller's transaction. */
export async function importPdfInvoices(trx: Trx, ctx: ImportContext, docs: PdfImportDoc[]): Promise<ImportOutcome[]> {
  const rows = await pdfImportRows(trx, ctx.orgId, docs);
  const out: ImportOutcome[] = [];

  if (rows.contactRows.length || rows.widened.length) {
    const o = rows.contactRows.length
      ? await runImport(trx, ctx, 'contacts', rows.contactRows)
      : { kind: 'contacts' as const, rows: 0, created: 0, skipped: 0, errors: [], notes: [] };
    if (rows.widened.length) {
      await trx.updateTable('contacts').set({ kind: 'both' }).where('org_id', '=', ctx.orgId).where('id', 'in', rows.widened.map((w) => w.id)).execute();
      o.notes.push(`Now both a customer and a supplier: ${rows.widened.map((w) => w.name).join(', ')}.`);
      o.rows = Math.max(o.rows, rows.widened.length);
    }
    const names = rows.contactRows.map((r) => String(r.name));
    out.push({ ...o, label: 'Customers and suppliers', errors: o.errors.map((e) => ({ row: 0, message: `${names[e.row - 2] ?? 'A company'}: ${e.message}` })) });
  }

  const part = async (direction: 'sale' | 'purchase') => {
    const kind = direction === 'sale' ? 'invoices' as const : 'bills' as const;
    const lines = direction === 'sale' ? rows.invoices : rows.bills;
    const files = direction === 'sale' ? rows.invoiceFiles : rows.billFiles;
    const left = rows.already[direction].length + rows.twice[direction].length;
    if (!lines.length && !left) return;
    const o = lines.length ? await runImport(trx, ctx, kind, lines) : { kind, rows: 0, created: 0, skipped: 0, errors: [], notes: [] };
    if (rows.already[direction].length) o.notes.push(`Already in the books, so left out: ${rows.already[direction].join(', ')}.`);
    if (rows.twice[direction].length) o.notes.push(`Chosen twice, so taken once: ${rows.twice[direction].join(', ')}.`);
    out.push({
      ...o, label: direction === 'sale' ? 'Sales invoices' : 'Supplier bills',
      // Counted by invoice here, not by line: what the person chose.
      rows: o.created + o.skipped + left + o.errors.length, skipped: o.skipped + left,
      errors: byFile(o.errors, files),
    });
  };
  await part('sale');
  await part('purchase');
  return out;
}
