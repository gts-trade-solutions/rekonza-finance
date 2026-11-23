// The client's two Zoho points (2026-11-23): separate invoice formats for goods,
// services and exports, each with the logo, exactly like Zoho; and HSN codes as
// Zoho takes them (a digits setting, any valid code), not an approved list.
//
//   npx tsx --test scripts/tests/invoice-formats.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {
  DEFAULT_TEMPLATE, formatTitle, invoiceFormatOf, layoutFor, layoutForInvoice, readTemplate, type PrintTemplate,
} from '../../lib/print-template';
import { foreignWords, hsnHeading } from '../../lib/invoice-format';
import { checkHsnCode, hsnHeadingLabel, legalMinimumDigits } from '../../lib/tax/hsn';
import { invoiceModel } from '../../components/print/invoice-print';
import { currencySymbol } from '../../components/print/zoho-sheet';
import type { InvoiceDetail } from '../../lib/api/client';

// tsx compiles the components' JSX to React.createElement.
(globalThis as { React?: typeof React }).React = React;

test('an invoice prints as goods, services or export by what it is', () => {
  assert.equal(invoiceFormatOf('intra', 'goods'), 'goods');
  assert.equal(invoiceFormatOf('inter', 'both'), 'goods');
  assert.equal(invoiceFormatOf('intra', 'service'), 'services');
  assert.equal(invoiceFormatOf('export_lut', 'goods'), 'export');
  assert.equal(invoiceFormatOf('export_with_tax', 'service'), 'export');
  assert.equal(invoiceFormatOf('sez', 'goods'), 'goods');
});

test('each format keeps its own template and title, and falls back to the one for invoices', () => {
  const t = readTemplate({ layout: 'standard', byDoc: { invoice: 'spreadsheet' }, byFormat: { export: 'grand', services: 'nope' }, titles: { export: 'Commercial Invoice', goods: 'Tax Invoice', services: '' } });
  assert.deepEqual(t.byFormat, { export: 'grand' }, 'an unknown template is dropped');
  assert.deepEqual(t.titles, { export: 'Commercial Invoice' }, 'a title equal to the default is not stored');
  assert.equal(layoutForInvoice(t, 'export'), 'grand');
  assert.equal(layoutForInvoice(t, 'goods'), 'spreadsheet', 'goods follow the template set for invoices');
  assert.equal(layoutForInvoice(t, 'goods', 'minimalist'), 'minimalist', 'the invoice\'s own choice wins');
  assert.equal(layoutFor(t, 'invoice'), 'spreadsheet');
  assert.equal(formatTitle(t, 'export'), 'Commercial Invoice');
  assert.equal(formatTitle(t, 'goods'), 'Tax Invoice');
  assert.equal(formatTitle(DEFAULT_TEMPLATE, 'export'), 'Export Invoice');
  // Templates saved before formats existed read as before.
  const old = readTemplate({ layout: 'compact', byDoc: {}, added: {} });
  assert.deepEqual(old.byFormat, {});
  assert.equal(layoutForInvoice(old, 'services'), 'compact');
});

test('the code column says HSN, SAC or both, from the codes on the lines', () => {
  assert.equal(hsnHeading(['8708', '7214'], 'goods'), 'HSN');
  assert.equal(hsnHeading(['998314', '998391'], 'services'), 'SAC');
  assert.equal(hsnHeading(['8708', '998714'], 'goods'), 'HSN/SAC');
  assert.equal(hsnHeading([null], 'services'), 'SAC');
});

test('an export in dollars is worded and signed in dollars', () => {
  assert.match(foreignWords(1234550, 'USD'), /^US Dollar Twelve Thousand Three Hundred .+ and Fifty Cents Only$/);
  assert.match(foreignWords(100000, 'EUR'), /^Euro .* Only$/);
  assert.equal(currencySymbol('USD'), '$');
  assert.equal(currencySymbol('INR'), '₹');
  assert.equal(currencySymbol(null), '₹');
});

// ── The invoice model, as each format prints it ───────────────────────────────

function invoice(over: Partial<InvoiceDetail> = {}, seller: Partial<InvoiceDetail['seller']> = {}): InvoiceDetail {
  const line = (code: string, qty: number, ratePaise: number, gst = 18) => {
    const taxable = qty * ratePaise;
    const half = Math.round((taxable * gst) / 200);
    return {
      id: code, itemId: null, description: `Item ${code}`, itemName: `Item ${code}`, hsnSac: code, qty, uqc: 'NOS', ratePaise,
      discountPct: 0, gstRatePct: gst, taxablePaise: taxable, cgstPaise: half, sgstPaise: half, igstPaise: 0, cessPaise: 0, totalPaise: taxable + 2 * half,
    };
  };
  const lines = [line('72142090', 10, 62000), line('25232930', 4, 39500)];
  const total = lines.reduce((t, l) => t + l.totalPaise, 0);
  return {
    id: '1', number: 'INV/26-27/0001', date: '2026-11-20', dueDate: '2026-12-20', status: 'sent',
    supplyType: 'intra', supplyKind: 'goods', placeOfSupply: '33',
    voided: null,
    approval: { status: 'none', needed: false, approverRole: null, rejectionReason: null, submittedById: null },
    customer: { id: '9', name: 'Kaveri Motors', gstin: '33AAGFK4410P1ZZ', address: null },
    branch: { id: '1', name: 'Head office', gstin: '33AAACR1234A1Z5' },
    seller: {
      name: 'Race company', tradeName: null, gstin: '33AAACR1234A1Z5', pan: 'AAACR1234A', address: '12 Mount Road', city: 'Chennai', pincode: '600002',
      stateCode: '33', email: null, phone: null, registration: 'regular', logoUrl: '/api/files/7', signatoryName: null, printLanguage: null,
      template: DEFAULT_TEMPLATE, bank: null, upi: null, ...seller,
    },
    buyer: { name: 'Kaveri Motors', gstin: '33AAGFK4410P1ZZ', address: null, city: null, pincode: null, stateCode: '33', treatment: 'registered' },
    shipTo: null, ewayBill: null, orderNumber: null, subject: null, paymentTerms: null, notes: null, terms: null,
    subtotalPaise: lines.reduce((t, l) => t + l.taxablePaise, 0),
    tax: { cgstPaise: lines.reduce((t, l) => t + l.cgstPaise, 0), sgstPaise: lines.reduce((t, l) => t + l.sgstPaise, 0), igstPaise: 0, cessPaise: 0 },
    tcsPaise: 0, shippingChargePaise: 0, adjustmentPaise: 0, adjustmentLabel: null, roundOffPaise: 0,
    totalPaise: total, amountPaidPaise: 0, balancePaise: total, lines,
    einvoice: { status: 'not_applicable', irn: null },
    ...over,
  } as InvoiceDetail;
}

test('a goods invoice: Tax Invoice, the HSN column, units, the logo', () => {
  const m = invoiceModel(invoice(), 'Original for recipient');
  assert.equal(m.title, 'Tax Invoice');
  assert.equal(m.hsnLabel, 'HSN');
  assert.equal(m.unitless, false);
  assert.equal(m.currency, null);
  assert.equal(m.seller.logoUrl, '/api/files/7');
  assert.ok(m.facts.some((f) => f.label === 'Place Of Supply'));
  assert.ok(m.facts.some((f) => f.label === 'Reverse Charge'));
});

test('a services invoice: the SAC column, no units, its own title when renamed', () => {
  const svc = invoice({
    supplyKind: 'service',
    lines: invoice().lines.map((l, i) => ({ ...l, hsnSac: i ? '998391' : '998314' })),
  }, { template: { ...DEFAULT_TEMPLATE, titles: { services: 'Service Invoice' } } as PrintTemplate });
  const m = invoiceModel(svc, null);
  assert.equal(m.title, 'Service Invoice');
  assert.equal(m.hsnLabel, 'SAC');
  assert.equal(m.unitless, true);
});

test('an export under LUT in dollars: Export Invoice, the endorsement, dollars, port and shipping bill', () => {
  const base = invoice();
  const lines = base.lines.map((l) => ({ ...l, cgstPaise: 0, sgstPaise: 0, gstRatePct: 0, totalPaise: l.taxablePaise }));
  const inr = lines.reduce((t, l) => t + l.totalPaise, 0); // ₹77,800.00 at ₹83.50 a dollar
  const exp = invoice({
    supplyType: 'export_lut', placeOfSupply: '96', lines,
    tax: { cgstPaise: 0, sgstPaise: 0, igstPaise: 0, cessPaise: 0 }, totalPaise: inr, balancePaise: inr,
    foreign: { currency: 'USD', rate: 83.5, totalPaise: Math.round(inr / 83.5), paidPaise: 0 },
    exportInfo: { lutArn: 'AD330526000123X', shippingBillNo: '7765432', shippingBillDate: '2026-11-21', portCode: 'INMAA1', countryCode: 'US' },
  });
  const m = invoiceModel(exp, null);
  assert.equal(m.title, 'Export Invoice');
  assert.match(m.endorsement ?? '', /export under letter of undertaking \(ARN AD330526000123X\) without payment of integrated tax/i);
  assert.equal(m.currency, 'USD');
  assert.equal(m.totalPaise, Math.round(inr / 83.5));
  assert.equal(m.lines[0].ratePaise, Math.round(62000 / 83.5), 'the rate prints in dollars');
  assert.match(m.words ?? '', /^US Dollar /);
  const facts = Object.fromEntries(m.facts.map((f) => [f.label, f.value]));
  assert.equal(facts['Country Of Destination'], 'United States');
  assert.equal(facts['Port Code'], 'INMAA1');
  assert.equal(facts['Shipping Bill#'], '7765432');
  assert.equal(facts['Currency'], 'USD');
  assert.equal(facts['Place Of Supply'], 'Foreign Country (96)');
  assert.deepEqual(m.billTo?.lines, ['United States'], 'the address ends in the country, not the GST code');
  assert.ok(!('Reverse Charge' in facts));
  assert.ok(m.totals.some((t) => /IGST \(Nil, under LUT\)/.test(t.label)));
  assert.equal(m.headings.length, 0, 'the shipping bill sits among the details, not under the title');
});

test('a bill of supply and a debit note keep the names the law gives them', () => {
  const comp = invoiceModel(invoice({}, { registration: 'composition' }), null);
  assert.equal(comp.title, 'Bill of Supply');
  const exempt = invoiceModel(invoice({ supplyType: 'nil_or_exempt' }), null);
  assert.equal(exempt.title, 'Bill of Supply');
  const dn = invoiceModel(invoice({ debitNote: { reason: 'Price revised', against: null } }), null);
  assert.equal(dn.title, 'Debit Note');
});

// ── HSN as Zoho takes it ─────────────────────────────────────────────────────

test('any properly formed HSN of at least the digits set is accepted, with its chapter', () => {
  const ok = checkHsnCode('7214', { digits: 4, kind: 'goods' });
  assert.ok(ok.ok);
  assert.equal(ok.heading, 'Iron and steel');
  assert.ok(checkHsnCode('72142090', { digits: 6, kind: 'goods' }).ok, 'eight digits are always allowed');
  assert.ok(checkHsnCode('0401', { digits: 4 }).ok, 'a leading zero is a chapter, not a typo');
  assert.equal(hsnHeadingLabel('87083000'), 'Chapter 87 · Vehicles other than railway; parts and accessories');
});

test('too few digits, a bad length, a chapter that does not exist, or letters are refused', () => {
  assert.match(checkHsnCode('7214', { digits: 6 }).problem ?? '', /at least 6/);
  assert.match(checkHsnCode('72142', { digits: 4 }).problem ?? '', /4, 6 or 8 digits/);
  assert.match(checkHsnCode('7714', { digits: 4 }).problem ?? '', /no chapter 77/);
  assert.match(checkHsnCode('AB12', { digits: 4 }).problem ?? '', /digits only/);
});

test('a SAC is a service code: six digits from 99, on services only', () => {
  const s = checkHsnCode('998311', { digits: 8, kind: 'service' });
  assert.ok(s.ok, 'a six-digit SAC satisfies any digits setting');
  assert.equal(s.kind, 'sac');
  assert.equal(s.heading, 'Other professional, technical and business services');
  assert.ok(checkHsnCode('9983', { digits: 4, kind: 'service' }).ok, 'a SAC heading at four digits');
  assert.match(checkHsnCode('9983', { digits: 6 }).problem ?? '', /6/);
  assert.match(checkHsnCode('99831', { digits: 4 }).problem ?? '', /six digits/);
  assert.match(checkHsnCode('995011', { digits: 4 }).problem ?? '', /not a SAC heading/);
  assert.match(checkHsnCode('998311', { digits: 4, kind: 'goods' }).problem ?? '', /goods take an HSN/i);
  assert.match(checkHsnCode('8708', { digits: 4, kind: 'service' }).problem ?? '', /Services take a SAC/);
});

test('the law\'s minimum: 4 digits up to ₹5 crore, 6 above', () => {
  assert.equal(legalMinimumDigits(false), 4);
  assert.equal(legalMinimumDigits(true), 6);
});
