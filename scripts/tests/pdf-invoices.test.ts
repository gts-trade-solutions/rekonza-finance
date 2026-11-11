// Invoices from PDF: the sample PDFs, whose invoice each is, the reading charged
// (or not, for a sample), and the checked list brought in — new parties, sales
// invoices and supplier bills, all or nothing, and never twice.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/pdf-invoices.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts } from '../../lib/server/ledger/chart-of-accounts';
import { setBooksStartDate } from '../../lib/server/services/opening-balances';
import { isValidGstin } from '../../lib/tax/gst';
import { financialYear, sampleFromPdf, sampleInvoicePdf, type PdfImportDoc } from '../../lib/imports/pdf-invoices';
import { captureInvoice, captureSampleOffline, invoiceNotes, toCapturedInvoice, whoseInvoice } from '../../lib/server/ai/invoice-capture';
import { importPdfInvoices } from '../../lib/server/imports/pdf-invoices';
import type { ImportContext } from '../../lib/server/imports/run';

const OURS = '33AABCR5678D1ZF';
const SUPPLIER = '33AAECL4721K1ZL';
const CUSTOMER = '29AAKFS2210M1ZZ';
/** The sample sale's customer: Kaveri Motors, as in the sample Tally data. */
const SAMPLE_CUSTOMER = '29AAGFK4410P1ZZ';
const US = { name: 'Race Auto Spares Pvt Ltd', gstin: OURS };

test('the sample PDFs: a real PDF, carrying what it says, placed the right way round', () => {
  for (const g of [OURS, SUPPLIER, CUSTOMER, SAMPLE_CUSTOMER]) assert.ok(isValidGstin(g), g);
  const bill = sampleInvoicePdf('purchase', US, '2026-11-11');
  const text = new TextDecoder('latin1').decode(bill.bytes);
  assert.ok(text.startsWith('%PDF-1.4'));
  assert.ok(text.endsWith('%%EOF\n'));
  // Every object sits where the cross-reference table says it does.
  const xref = Number(text.match(/startxref\n(\d+)/)![1]);
  assert.ok(text.slice(xref).startsWith('xref'));
  const offsets = [...text.slice(xref).matchAll(/(\d{10}) 00000 n/g)].map((m) => Number(m[1]));
  offsets.forEach((o, i) => assert.ok(text.slice(o).startsWith(`${i + 1} 0 obj`), `object ${i + 1}`));
  assert.match(text, /\(LAC\/26-27\/0418\) Tj/);
  assert.match(bill.filename, /^sample-supplier-bill-LAC-26-27-0418\.pdf$/);

  const raw = sampleFromPdf(bill.bytes)!;
  const inv = toCapturedInvoice(raw);
  assert.equal(inv.seller.gstin, SUPPLIER);
  assert.equal(inv.buyer.name, 'Race Auto Spares Pvt Ltd');
  assert.equal(inv.date, '2026-11-08');
  assert.equal(inv.lines.length, 3);
  assert.deepEqual(whoseInvoice(inv, { gstins: [OURS], names: [] }), { direction: 'purchase', by: 'gstin' });
  assert.deepEqual(invoiceNotes(inv, 'purchase', 'gstin'), [], 'a sample adds up');

  const sale = toCapturedInvoice(sampleFromPdf(sampleInvoicePdf('sale', US, '2026-11-11').bytes)!);
  assert.deepEqual(whoseInvoice(sale, { gstins: [OURS], names: [] }), { direction: 'sale', by: 'gstin' });
  assert.equal(sale.buyer.gstin, SAMPLE_CUSTOMER);
  assert.equal(sale.number, 'OLD/26-27/0107');

  // Not a sample: an ordinary PDF, or not a PDF at all.
  assert.equal(sampleFromPdf(new TextEncoder().encode('%PDF-1.7\n1 0 obj << >> endobj')), null);
  assert.equal(sampleFromPdf(new TextEncoder().encode('%REKONZA-SAMPLE e30=')), null);
});

test('whose invoice: our GSTIN either side, then our name, else a supplier\'s bill with a note', () => {
  const inv = (seller: [string | null, string | null], buyer: [string | null, string | null]) => toCapturedInvoice({
    seller_name: seller[0], seller_gstin: seller[1], seller_state: null, buyer_name: buyer[0], buyer_gstin: buyer[1], buyer_state: null,
    invoice_number: 'X/1', invoice_date: '2026-05-02', due_date: null,
    lines: [{ description: 'Oil filter', hsn_sac: '8421', quantity: 10, unit_rate: 100, gst_rate_pct: 18 }],
    taxable_total: 1000, tax_total: 180, grand_total: 1180,
  });
  const ours = { gstins: [OURS], names: ['Race Auto Spares Pvt Ltd', 'Race Auto Spares Private Limited'] };
  assert.deepEqual(whoseInvoice(inv(['M/s. RACE AUTO SPARES PRIVATE LIMITED', null], ['Kaveri Motors', null]), ours), { direction: 'sale', by: 'name' });
  assert.deepEqual(whoseInvoice(inv(['Kaveri Motors', null], ['Race Auto Spares (Pvt) Ltd', null]), ours), { direction: 'purchase', by: 'name' });
  const neither = inv(['Kaveri Motors', null], ['Someone Else', null]);
  assert.deepEqual(whoseInvoice(neither, ours), { direction: 'purchase', by: 'guess' });
  const notes = invoiceNotes(neither, 'purchase', 'guess');
  assert.ok(notes.some((n) => /Neither GSTIN/.test(n)));
  assert.ok(notes.some((n) => /No GSTIN or state/.test(n)));
  assert.equal(financialYear('2026-03-31'), 'FY 2025-26');
  assert.equal(financialYear('2026-04-01'), 'FY 2026-27');
});

async function withBook(fn: (trx: Trx, ctx: ImportContext, userId: number) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Race Auto Spares Pvt Ltd', is_demo: 1 } as never).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1, gstin: OURS }).executeTakeFirstOrThrow()).insertId);
      const userId = Number((await trx.insertInto('users').values({ org_id: orgId, name: 'Clerk', email: `pdf-${orgId}@example.test`, role: 'accountant' }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      await setBooksStartDate(trx, orgId, '2026-04-01');
      await fn(trx, { orgId, userId, branchId, onDuplicate: 'skip' }, userId);
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

test('a reading: the AI for a real invoice (charged), a sample from itself (free); the other company found in the books', async () => {
  await withBook(async (trx, ctx, userId) => {
    const supplier = Number((await trx.insertInto('contacts').values({ org_id: ctx.orgId, kind: 'vendor', display_name: 'Lakshmi Auto', gstin: SUPPLIER, state_code: '33', gst_treatment: 'registered' } as never).executeTakeFirstOrThrow()).insertId);
    let calls = 0;
    const reader = async () => {
      calls++;
      return {
        raw: {
          seller_name: 'Lakshmi Auto Components', seller_gstin: SUPPLIER.toLowerCase(), seller_state: 'Tamil Nadu',
          buyer_name: 'Race Auto Spares', buyer_gstin: OURS, buyer_state: '33',
          invoice_number: 'LAC/9', invoice_date: '2026-10-20', due_date: '2026-11-19',
          lines: [{ description: 'Clutch plate', hsn_sac: '87089300', quantity: 2, unit_rate: 1850, gst_rate_pct: 18 }],
          taxable_total: 3700, tax_total: 666, grand_total: 4366,
        },
        inputTokens: 2500, outputTokens: 300, model: 'gpt-5-mini',
      };
    };
    const deps = { ex: trx, inTrx: <T,>(fn: (t: Trx) => Promise<T>) => fn(trx), reader };
    const file = { bytes: Buffer.from('%PDF-1.4 a real bill'), contentType: 'application/pdf', filename: 'lakshmi.pdf' };

    const r = await captureInvoice(ctx.orgId, userId, file, deps);
    assert.equal(r.direction, 'purchase');
    assert.equal(r.by, 'gstin');
    assert.deepEqual(r.matched, { id: String(supplier), name: 'Lakshmi Auto', kind: 'vendor' });
    assert.equal(r.party.gstin, SUPPLIER);
    assert.equal(r.seller.name, 'Lakshmi Auto Components');
    assert.ok(r.chargedMc >= 500, 'charged at least the minimum');
    assert.deepEqual(r.notes, []);
    const usage = await trx.selectFrom('ai_usage').select(['provider'] as never).where('org_id', '=', ctx.orgId).execute() as unknown as { provider: string }[];
    assert.deepEqual(usage.map((u) => u.provider), ['invoice-capture']);

    const sample = sampleInvoicePdf('sale', US, '2026-11-11');
    const s = await captureInvoice(ctx.orgId, userId, { bytes: Buffer.from(sample.bytes), contentType: 'application/pdf', filename: sample.filename }, deps);
    assert.equal(calls, 1, 'a sample is not sent to the AI');
    assert.deepEqual([s.direction, s.by, s.sample, s.chargedMc], ['sale', 'gstin', true, 0]);
    assert.equal(s.party.name, 'Kaveri Motors');
    assert.equal(s.matched, null);

    // The online demo: the samples alone, by their own word.
    assert.equal(captureSampleOffline({ bytes: Buffer.from(sample.bytes), contentType: 'application/pdf', filename: 'x.pdf' }).direction, 'sale');
    assert.throws(() => captureSampleOffline(file), /reads only the sample PDFs/);
  });
});

test('bringing them in: new parties, a known one widened to both, sales invoices and bills; again adds nothing', async () => {
  await withBook(async (trx, ctx) => {
    const known = Number((await trx.insertInto('contacts').values({ org_id: ctx.orgId, kind: 'customer', display_name: 'Kaveri Motors', state_code: '33', gst_treatment: 'unregistered' } as never).executeTakeFirstOrThrow()).insertId);
    const line = (description: string, qty: number, rate: number) => ({ description, hsnSac: '8708', qty, ratePaise: rate * 100, gstRatePct: 18 });
    const docs: PdfImportDoc[] = [
      { file: 'our-1.pdf', direction: 'sale', partyName: 'Sri Murugan Motors', partyGstin: CUSTOMER, partyState: null, number: 'OLD/26-27/0107', date: '2026-10-05', dueDate: '2026-11-04', lines: [line('Shock absorber', 6, 3200)] },
      { file: 'our-2.pdf', direction: 'sale', partyName: 'Sri Murugan Motors', partyGstin: CUSTOMER, partyState: null, number: 'OLD/26-27/0108', date: '2025-12-15', dueDate: null, lines: [line('Brake pad', 2, 650), line('Labour', 1, 400)] },
      { file: 'lakshmi.pdf', direction: 'purchase', partyName: 'Lakshmi Auto Components', partyGstin: SUPPLIER, partyState: null, number: 'LAC/0418', date: '2026-11-08', dueDate: null, lines: [line('Clutch plate', 12, 1850)] },
      { file: 'kaveri.pdf', direction: 'purchase', partyName: 'kaveri motors', partyGstin: null, partyState: null, number: 'KM-77', date: '2026-09-01', dueDate: null, lines: [line('Old stock bought back', 5, 300)] },
      { file: 'local.pdf', direction: 'purchase', partyName: 'Anand Tyres', partyGstin: null, partyState: 'Tamil Nadu', number: 'AT/5', date: '2026-08-12', dueDate: null, lines: [line('Tyre 165/80 R14', 4, 3100)] },
    ];

    const out = await importPdfInvoices(trx, ctx, docs);
    const part = (label: string) => out.find((o) => o.label === label)!;
    assert.deepEqual(out.map((o) => [o.label, o.created, o.errors]), [
      ['Customers and suppliers', 3, []], ['Sales invoices', 2, []], ['Supplier bills', 3, []],
    ]);
    assert.ok(part('Customers and suppliers').notes.some((n) => /Now both a customer and a supplier: Kaveri Motors/.test(n)));
    const kinds = Object.fromEntries((await trx.selectFrom('contacts').select(['display_name', 'kind']).where('org_id', '=', ctx.orgId).execute()).map((c) => [c.display_name, c.kind]));
    assert.deepEqual(kinds, { 'Kaveri Motors': 'both', 'Sri Murugan Motors': 'customer', 'Lakshmi Auto Components': 'vendor', 'Anand Tyres': 'vendor' });

    const invoices = await trx.selectFrom('invoices').select(['number', 'total']).where('org_id', '=', ctx.orgId).orderBy('number').execute();
    assert.deepEqual(invoices.map((i) => [i.number, Number(i.total)]), [['OLD/26-27/0107', 22656], ['OLD/26-27/0108', 2006]]);
    const bills = await trx.selectFrom('bills').select(['vendor_invoice_no', 'vendor_id']).where('org_id', '=', ctx.orgId).orderBy('vendor_invoice_no').execute();
    assert.deepEqual(bills.map((b) => b.vendor_invoice_no), ['AT/5', 'KM-77', 'LAC/0418']);
    assert.equal(bills.find((b) => b.vendor_invoice_no === 'KM-77')!.vendor_id, known, 'the known company, found by name');

    // The same PDFs again: all already in, left out by name, and nothing fails.
    const again = await importPdfInvoices(trx, ctx, docs);
    assert.deepEqual(again.map((o) => [o.label, o.created, o.skipped, o.errors.length]), [['Sales invoices', 0, 2, 0], ['Supplier bills', 0, 3, 0]], 'nothing twice');
    assert.match(again[0].notes.join(' '), /Already in the books, so left out: our-1\.pdf \(OLD\/26-27\/0107\), our-2\.pdf/);

    // One PDF chosen twice in the same upload goes in once.
    const dup = { ...docs[2], number: 'LAC/0419', file: 'lakshmi-2.pdf' };
    const once = await importPdfInvoices(trx, ctx, [dup, { ...dup, file: 'lakshmi-2 (copy).pdf' }]);
    assert.deepEqual(once.map((o) => [o.label, o.created, o.skipped]), [['Supplier bills', 1, 1]]);
    assert.match(once[0].notes.join(' '), /Chosen twice, so taken once: lakshmi-2 \(copy\)\.pdf \(LAC\/0419\)/);

    // An invoice that cannot go in says which file it came from.
    const bad = await importPdfInvoices(trx, ctx, [{ ...docs[0], file: 'long.pdf', number: 'A-VERY-LONG-NUMBER/2026-27/1' }]);
    const err = bad.find((o) => o.label === 'Sales invoices')!.errors[0];
    assert.equal(err.row, 0);
    assert.match(err.message, /^long\.pdf: /);
  });
});

test.after(async () => {
  await db.destroy();
});
