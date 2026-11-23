'use client';

// The pieces of Settings → PDF Templates: a template drawn small with the
// business's own heading and Zoho's sample lines, and Zoho's "Choose a
// Template" gallery of all twelve, grouped Standard, Spreadsheet, Premium and
// Universal, each with "Use This".

import { useState } from 'react';
import { Check, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { stateTaxLabel } from '@/lib/tax/gst';
import type { PdfTemplateSettings } from '@/lib/api/client';
import {
  DEFAULT_FORMAT_TITLE, TEMPLATE_GALLERY, TEMPLATE_GROUPS,
  type InvoiceFormat, type PrintTemplate, type TemplateDoc, type TemplateGroup, type TemplateKey,
} from '@/lib/print-template';
import { addressLines, taxRows, zohoWords, ZohoSheet, type SheetModel } from '@/components/print/zoho-sheet';
import { foreignWords } from '@/lib/invoice-format';

/** What each kind is called on paper, and its number. */
const SAMPLE_TITLE: Record<TemplateDoc, [string, string, string]> = {
  invoice: ['Tax Invoice', 'Invoice#', 'INV-000017'],
  estimate: ['Quote', 'Quote#', 'QT-000017'],
  'sales-order': ['Sales Order', 'Sales Order#', 'SO-000017'],
  challan: ['Delivery Challan', 'Delivery Challan#', 'DC-000017'],
  'credit-note': ['Credit Note', 'Credit Note#', 'CN-000017'],
  'purchase-order': ['Purchase Order', 'Purchase Order#', 'PO-000017'],
  retainer: ['Service Invoice', 'Service Invoice#', 'SI-000017'],
  'payment-received': ['Payment Receipt', 'Payment#', 'PR-000017'],
  bill: ['Bill', 'Bill#', 'BL-000017'],
  'vendor-credit': ['Vendor Credit', 'Vendor Credit#', 'VC-000017'],
  'payment-made': ['Payment Made', 'Payment#', 'PM-000017'],
};

const SAMPLE_LINES = [
  { name: 'Brochure Design', description: 'Brochure Design Single Sided Color', hsn: '998391', rate: 300_00, qty: 1, unit: 'Nos' },
  { name: 'Web Design Packages(Template) - Basic', description: 'Custom Themes for your business. Inclusive of 10 hours of marketing and annual training', hsn: '998314', rate: 250_00, qty: 1, unit: 'Nos' },
  { name: 'Print Ad - Basic - Color', description: 'Print Ad 1/8 size Color', hsn: '998361', rate: 80_00, qty: 1, unit: 'Nos' },
];

/** A goods invoice's sample: HSN codes, quantities and units. */
const GOODS_LINES = [
  { name: 'TMT Steel Bar 12mm', description: 'Fe 500D, 12 m length', hsn: '72142090', rate: 620_00, qty: 25, unit: 'NOS' },
  { name: 'Portland Cement 53 Grade', description: '50 kg bag', hsn: '25232930', rate: 395_00, qty: 40, unit: 'BAG' },
  { name: 'Binding Wire', description: '18 gauge, annealed', hsn: '72172000', rate: 78_00, qty: 15, unit: 'KGS' },
];

/** An export's sample: priced in dollars, under a letter of undertaking. */
const EXPORT_LINES = [
  { name: 'Brake Pad Set - Front', description: 'For passenger cars, OE grade', hsn: '87083000', rate: 18_50, qty: 200, unit: 'SET' },
  { name: 'Clutch Plate Assembly', description: '228 mm, 24 splines', hsn: '87089300', rate: 42_00, qty: 60, unit: 'NOS' },
];

/** Zoho's sample document, with the business's own name, logo, address and GSTIN at the top. */
export function sampleModel(b: PdfTemplateSettings['business'], doc: TemplateDoc, format?: InvoiceFormat, formatTitleText?: string): SheetModel {
  const [baseTitle, numberLabel, number] = SAMPLE_TITLE[doc];
  const invoiceFormat = doc === 'invoice' ? format ?? null : null;
  const title = invoiceFormat ? formatTitleText ?? DEFAULT_FORMAT_TITLE[invoiceFormat] : baseTitle;
  const exporting = invoiceFormat === 'export';
  const state = b.stateCode ?? '33';
  const source = invoiceFormat === 'goods' ? GOODS_LINES : exporting ? EXPORT_LINES : SAMPLE_LINES;
  const lines = source.map((l) => {
    const taxable = l.rate * l.qty;
    // An export under LUT carries no IGST; anything else here is 18% split CGST and SGST.
    const half = exporting ? 0 : Math.round(taxable * 0.09);
    return {
      name: l.name, description: l.description, hsn: l.hsn, qty: l.qty, unit: l.unit, ratePaise: l.rate, discountPct: 0,
      taxablePaise: taxable, gstRatePct: exporting ? 0 : 18, cgstPaise: half, sgstPaise: half, igstPaise: 0, cessPaise: 0, amountPaise: taxable + 2 * half,
    };
  });
  const sub = lines.reduce((s, l) => s + l.taxablePaise, 0);
  const total = lines.reduce((s, l) => s + l.amountPaise, 0);
  const stateTax = stateTaxLabel(state);
  const payments = doc === 'payment-received' || doc === 'payment-made';
  if (exporting) {
    return {
      title, numberLabel, number, copyLabel: null, stamp: null,
      endorsement: 'Supply meant for export under letter of undertaking without payment of integrated tax',
      headings: [],
      hsnLabel: 'HSN', currency: 'USD',
      seller: {
        name: b.name, logoUrl: b.logoUrl,
        lines: addressLines(b.address, b.city, b.pincode, b.stateCode),
        gstin: b.gstin, extra: [b.phone, b.email].filter(Boolean).length ? [[b.phone, b.email].filter(Boolean).join(' · ')] : [],
      },
      billTo: { label: 'Bill To', name: 'Atlas Auto Parts LLC', lines: ['4120 Commerce Blvd', 'Houston TX 77002', 'United States'], gstin: null },
      shipTo: null,
      facts: [
        { label: 'Invoice Date', value: '15 Nov 2026' },
        { label: 'Terms', value: 'Net 45' },
        { label: 'Due Date', value: '30 Dec 2026' },
        { label: 'Country Of Destination', value: 'United States' },
        { label: 'Place Of Supply', value: 'Foreign Country (96)' },
        { label: 'Port Code', value: 'INMAA1' },
        { label: 'Shipping Bill#', value: '7765432' },
        { label: 'Shipping Bill Date', value: '16 Nov 2026' },
        { label: 'Export Type', value: 'Without payment of IGST (LUT)' },
        { label: 'Currency', value: 'USD' },
      ],
      balance: { label: 'Balance Due', paise: total },
      date: '15 Nov 2026',
      taxColumns: 'none',
      stateTax,
      lines,
      subTotalPaise: sub,
      totals: [{ label: 'IGST (Nil, under LUT)', paise: 0 }],
      totalLabel: 'Total',
      totalPaise: total,
      after: [],
      balanceRow: { label: 'Balance Due', paise: total },
      words: foreignWords(total, 'USD'),
      notes: 'Thanks for your business.',
      terms: 'Payment by wire transfer within 45 days of the bill of lading.',
      payment: null, extra: null, irn: null, qr: null, signatory: b.signatoryName, footer: null,
    };
  }
  return {
    title, numberLabel, number, copyLabel: null, stamp: null, endorsement: null, headings: [],
    ...(invoiceFormat ? { hsnLabel: invoiceFormat === 'goods' ? 'HSN' : 'SAC', unitless: invoiceFormat === 'services' } : {}),
    seller: {
      name: b.name, logoUrl: b.logoUrl,
      lines: addressLines(b.address, b.city, b.pincode, b.stateCode),
      gstin: b.gstin, extra: [b.phone, b.email].filter(Boolean).length ? [[b.phone, b.email].filter(Boolean).join(' · ')] : [],
    },
    billTo: { label: doc === 'bill' || doc === 'vendor-credit' || doc === 'purchase-order' || doc === 'payment-made' ? 'Vendor Address' : 'Bill To', name: 'Rob & Joe Traders', lines: ['34, Riche Street', 'Chennai 600001', `Tamil Nadu (33)`], gstin: '33ABCDE0123A1Z5' },
    shipTo: null,
    facts: payments
      ? [{ label: 'Payment Date', value: '15 Nov 2026' }, { label: 'Payment Mode', value: 'Bank Transfer' }]
      : [
          { label: `${invoiceFormat ? 'Invoice' : baseTitle.replace(/^Tax /, '')} Date`, value: '15 Nov 2026' },
          { label: 'Terms', value: 'Due on Receipt' },
          { label: 'Due Date', value: '15 Nov 2026' },
          { label: 'P.O.#', value: '321014' },
          { label: 'Place Of Supply', value: 'Tamil Nadu (33)' },
        ],
    balance: doc === 'invoice' || doc === 'retainer' || doc === 'bill' ? { label: 'Balance Due', paise: total } : null,
    date: '15 Nov 2026',
    taxColumns: payments ? 'none' : 'split',
    stateTax,
    lines: payments ? [] : lines,
    subTotalPaise: payments ? null : sub,
    totals: payments ? [] : taxRows(lines, true, false, stateTax),
    totalLabel: payments ? 'Amount Received' : 'Total',
    totalPaise: total,
    after: [],
    balanceRow: doc === 'invoice' || doc === 'retainer' || doc === 'bill' ? { label: 'Balance Due', paise: total } : null,
    words: zohoWords(total),
    notes: 'Thanks for your business.',
    terms: 'Your company\'s Terms and Conditions will be displayed here. You can add it in the Invoice Preferences page under Settings.',
    payment: null, extra: null, irn: null, qr: null, signatory: b.signatoryName, footer: null,
  };
}

/** A template drawn at A4 width and shrunk to fit a card. */
export function TemplatePreview({ model, template, layout, width = 240 }: {
  model: SheetModel; template: PrintTemplate; layout: TemplateKey; width?: number;
}) {
  const scale = width / 794;
  return (
    <div className="relative overflow-hidden bg-white" style={{ width, height: Math.round(1123 * scale) }} aria-hidden data-slot="template-preview">
      <div style={{ width: 794, transform: `scale(${scale})`, transformOrigin: 'top left' }} className="pointer-events-none">
        <ZohoSheet model={model} template={template} layout={layout} className="!max-w-none !shadow-none !ring-0" style={{ minHeight: 1123 }} />
      </div>
    </div>
  );
}

/** Zoho's "Choose a Template": all twelve, by group, each with "Use This". */
export function TemplateGallery({ open, onOpenChange, model, template, current, onUse }: {
  open: boolean; onOpenChange: (v: boolean) => void; model: SheetModel; template: PrintTemplate;
  /** Already in the list: marked, not offered again. */
  current: TemplateKey[];
  onUse: (key: TemplateKey) => void;
}) {
  const [group, setGroup] = useState<TemplateGroup | 'All'>('All');
  const groups = group === 'All' ? TEMPLATE_GROUPS : [group];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="flex h-[92vh] w-[96vw] max-w-[96vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-[96vw]" data-slot="template-gallery">
        <div className="flex items-center justify-between px-8 pb-2 pt-5">
          <DialogTitle className="text-[18px] font-normal">Choose a Template</DialogTitle>
          <button type="button" onClick={() => onOpenChange(false)} aria-label="Close" className="text-muted-foreground hover:text-foreground"><X className="size-5" /></button>
        </div>
        <div className="flex gap-7 border-b px-8 text-[14px]" role="tablist">
          {(['All', ...TEMPLATE_GROUPS] as const).map((g) => {
            const n = g === 'All' ? TEMPLATE_GALLERY.length : TEMPLATE_GALLERY.filter((t) => t.group === g).length;
            return (
              <button key={g} type="button" role="tab" aria-selected={group === g} onClick={() => setGroup(g)}
                className={cn('-mb-px border-b-2 py-3', group === g ? 'border-primary font-semibold text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}>
                {g} ({n})
              </button>
            );
          })}
        </div>
        <div className="flex-1 overflow-y-auto px-8 pb-10 thin-scroll">
          {groups.map((g) => (
            <section key={g} className="border-b py-6 last:border-0">
              <h3 className="mb-4 text-[15px] font-normal uppercase tracking-wide">{g}</h3>
              <div className="flex flex-wrap gap-6">
                {TEMPLATE_GALLERY.filter((t) => t.group === g).map((t) => {
                  const added = current.includes(t.key);
                  return (
                    <div key={t.key} className="w-[264px]" data-slot={`gallery-${t.key}`}>
                      <div className="group relative border bg-white p-3 transition-shadow hover:shadow-md">
                        <TemplatePreview model={model} template={template} layout={t.key} width={238} />
                        {t.description && (
                          <p className="absolute inset-x-3 top-3 hidden bg-white/95 p-2 text-[12px] leading-snug text-muted-foreground group-hover:block">{t.description}</p>
                        )}
                        <div className="absolute inset-0 hidden items-center justify-center bg-black/5 group-hover:flex">
                          {added
                            ? <span className="flex items-center gap-1 rounded-[3px] bg-white px-3 py-1.5 text-[13px] shadow"><Check className="size-3.5 text-emerald-600" /> In your list</span>
                            : <Button size="sm" onClick={() => onUse(t.key)} data-slot={`use-${t.key}`}>Use This</Button>}
                        </div>
                      </div>
                      <p className="mt-2 text-[14px]">{t.name}</p>
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
