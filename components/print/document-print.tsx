'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Every document besides the invoice, on paper (lib/print-doc.ts): a quote, a
// sales order, a delivery challan, a credit note, a retainer invoice, a
// payment receipt, a purchase order, a vendor credit, a payment advice or a
// bill. It prints in the Zoho template chosen for its kind in Settings → PDF
// Templates (components/print/zoho-sheet.tsx), with the business's logo,
// colour, signature and footer, as in Zoho Books.
// ─────────────────────────────────────────────────────────────────────────────

import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { ArrowLeft, Printer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { stateTaxLabel } from '@/lib/tax/gst';
import { cn } from '@/lib/utils';
import { isPrintLanguage, PRINT_LANGUAGES, type PrintLanguage } from '@/lib/print-languages';
import { printPage } from '@/lib/output-guard';
import { useDocumentTitle } from '@/lib/use-document-title';
import type { PrintDoc, PrintKind, PrintParty } from '@/lib/print-doc';
import { layoutFor } from '@/lib/print-template';
import { addressLines, placeName, SheetLang, taxRows, zohoWords, ZohoSheet, type Ribbon, type SheetModel, type SheetParty } from '@/components/print/zoho-sheet';

/** Where each kind is listed: the way back from its printed copy. */
export const LIST_PATH: Record<PrintKind, string> = {
  estimate: '/sales/estimates', 'sales-order': '/sales/sales-orders', challan: '/sales/challans', 'credit-note': '/sales/credit-notes',
  retainer: '/sales/retainers', 'payment-received': '/sales/payments', 'purchase-order': '/purchases/purchase-orders',
  'vendor-credit': '/purchases/vendor-credits', 'payment-made': '/purchases/payments', bill: '/purchases/bills',
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const day = (iso: string) => {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return `${String(d).padStart(2, '0')} ${MONTHS[m - 1]} ${y}`;
};
const amt = (paise: number) => (paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });


/**
 * The document with its toolbar: which copy (a challan prints in triplicate),
 * a second language, print. Shared (a link, the portal), it is the
 * recipient's copy alone, without the way back into the app.
 */
export function DocumentPrintView({ doc, shared = false, back, actions }: {
  doc: PrintDoc;
  shared?: boolean;
  /** Where the back button goes; the kind's list by default. */
  back?: string;
  /** More buttons beside Print: Email, Clone. */
  actions?: ReactNode;
}) {
  const [copy, setCopy] = useState(doc.copies[0]);
  const [lang, setLang] = useState<PrintLanguage | ''>(isPrintLanguage(doc.seller.printLanguage) ? doc.seller.printLanguage : '');
  const shown = copy === 'all' ? doc.copies : [copy];
  useDocumentTitle(doc.number);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 no-print">
        {shared ? <span className="text-sm font-medium">{doc.title} {doc.number}</span> : (
          <Button variant="outline" size="sm" asChild>
            <Link href={back ?? LIST_PATH[doc.kind]}><ArrowLeft className="size-3.5" /> {doc.number}</Link>
          </Button>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {!shared && doc.copies.length > 1 && (
            <div className="flex flex-wrap rounded-[3px] border p-0.5 text-xs" role="group" aria-label="Which copy to print" data-slot="copy-picker">
              {[...doc.copies, 'all'].map((c) => (
                <button key={c} type="button" onClick={() => setCopy(c)} aria-pressed={copy === c}
                  className={cn('rounded-[2px] px-2.5 py-1 transition-colors', copy === c ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground')}>
                  {c === 'all' ? 'All copies' : c}
                </button>
              ))}
            </div>
          )}
          <select value={lang} onChange={(e) => setLang(e.target.value as PrintLanguage | '')} aria-label="Second language"
            className="h-8 rounded-[3px] border bg-background px-2 text-xs">
            <option value="">English only</option>
            {Object.entries(PRINT_LANGUAGES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          {actions}
          <Button size="sm" onClick={() => printPage(`${doc.title} ${doc.number}`)} data-slot="print-document">
            <Printer className="size-3.5" /> Print or save as PDF
          </Button>
        </div>
      </div>
      {!shared && doc.tag === 'Draft' && (
        <p className="rounded-[3px] border border-warning/40 bg-warning/10 px-3 py-2 text-sm no-print" data-slot="print-warning-draft">
          This is still a draft. It prints marked as one.
        </p>
      )}
      <SheetLang.Provider value={lang || null}>
        {shown.map((c, i) => <DocumentSheet key={c} doc={doc} copyLabel={doc.copies.length > 1 ? c : null} last={i === shown.length - 1} />)}
      </SheetLang.Provider>
    </div>
  );
}

/** Zoho's word for each document's number. */
const NUMBER_LABEL: Record<PrintKind, string> = {
  estimate: 'Quote#', 'sales-order': 'Sales Order#', challan: 'Delivery Challan#', 'credit-note': 'Credit Note#',
  retainer: 'Service Invoice#', 'payment-received': 'Payment#', 'purchase-order': 'Purchase Order#',
  'vendor-credit': 'Vendor Credit#', 'payment-made': 'Payment#', bill: 'Bill#',
};

const TAXES = /^(CGST|SGST|UTGST|IGST|Cess)$/;

/** "Quote date" → "Quote Date", as Zoho capitalises its labels. */
const titled = (s: string) => s.replace(/(^|\s)([a-z])/g, (_, a: string, b: string) => a + b.toUpperCase());

/** The figures after the total, in Zoho's words: what was taken off, and what is left. */
function afterRows(doc: PrintDoc) {
  const after: { label: string; paise: number }[] = [];
  let balanceRow: { label: string; paise: number } | null = null;
  for (const r of doc.after) {
    if (/^balance due$/i.test(r.label)) balanceRow = { label: 'Balance Due', paise: r.paise };
    else if (/^credit remaining$/i.test(r.label)) balanceRow = { label: 'Credits Remaining', paise: r.paise };
    else if (/^paid$/i.test(r.label)) after.push({ label: 'Payment Made', paise: -r.paise });
    else if (/^applied$|applied$/i.test(r.label)) after.push({ label: 'Credits Applied', paise: -r.paise });
    else after.push({ label: titled(r.label), paise: r.paise });
  }
  return { after, balanceRow };
}

/** The document, read into the shape every Zoho template prints. */
export function documentModel(doc: PrintDoc, copyLabel: string | null): SheetModel {
  const stateTax = stateTaxLabel(doc.placeOfSupply ?? '');
  // The number has its own place on every template; the rest are the details beside the parties.
  const facts = doc.facts.filter((f) => !(/\bno\.$/i.test(f.label) && f.value === doc.number)).map((f) => ({ label: titled(f.label), value: f.value }));
  const first = doc.totals[0];
  const hasSub = !!first && /^taxable value$/i.test(first.label);
  const rest = hasSub ? doc.totals.slice(1) : doc.totals;
  const { after, balanceRow } = afterRows(doc);
  const party = (p: PrintParty | null): SheetParty | null => p && {
    label: titled(p.label.replace(/^Billed to$/i, 'Bill To')),
    name: p.name,
    lines: addressLines(p.address, p.city, p.pincode, p.stateCode),
    gstin: p.gstin ?? null,
  };
  return {
    title: doc.title,
    numberLabel: NUMBER_LABEL[doc.kind],
    number: doc.number,
    copyLabel,
    stamp: doc.tag,
    endorsement: doc.endorsement,
    headings: [],
    seller: {
      name: doc.seller.name,
      logoUrl: doc.seller.logoUrl,
      lines: addressLines(doc.seller.address, doc.seller.city, doc.seller.pincode, doc.seller.stateCode),
      gstin: doc.seller.gstin ?? null,
      extra: [
        ...(doc.seller.tradeName ? [`Trading as ${doc.seller.tradeName}`] : []),
        ...(doc.seller.pan ? [`PAN ${doc.seller.pan}`] : []),
        ...(doc.seller.phone || doc.seller.email ? [[doc.seller.phone, doc.seller.email].filter(Boolean).join(' · ')] : []),
      ],
    },
    billTo: party(doc.party),
    shipTo: party(doc.shipTo),
    facts: [...facts, ...(doc.placeOfSupply ? [{ label: 'Place Of Supply', value: placeName(doc.placeOfSupply) }] : [])],
    balance: balanceRow && balanceRow.label === 'Balance Due' ? balanceRow : null,
    date: day(doc.date),
    taxColumns: doc.taxColumns,
    stateTax,
    lines: doc.lines.map((l) => ({
      name: l.description ?? '—', description: null, hsn: l.hsnSac, qty: l.qty, unit: l.uqc, ratePaise: l.ratePaise,
      discountPct: l.discountPct, taxablePaise: l.taxablePaise, gstRatePct: l.gstRatePct, cgstPaise: l.cgstPaise,
      sgstPaise: l.sgstPaise, igstPaise: l.igstPaise, cessPaise: l.cessPaise, amountPaise: l.totalPaise,
    })),
    subTotalPaise: hasSub ? first.paise : doc.lines.length ? doc.lines.reduce((s, l) => s + l.taxablePaise, 0) : null,
    // Each tax by its rate, from the lines, as on the invoice; what the lines cannot tell (round off) as given.
    totals: [
      ...(doc.lines.length && doc.taxColumns !== 'none'
        ? taxRows(doc.lines, doc.taxColumns === 'split', doc.taxColumns === 'integrated', stateTax)
        : rest.filter((r) => TAXES.test(r.label)).map((r) => ({ label: r.label === 'SGST' ? stateTax : r.label, paise: r.paise }))),
      ...rest.filter((r) => !TAXES.test(r.label)).map((r) => ({ label: r.label === 'Round off' ? 'Round Off' : titled(r.label), paise: r.paise })),
    ],
    totalLabel: titled(doc.totalLabel),
    totalPaise: doc.totalPaise,
    after,
    balanceRow,
    words: zohoWords(doc.totalPaise),
    notes: doc.notes,
    terms: doc.terms,
    payment: null,
    extra: doc.allocations ? <Allocations doc={doc} /> : null,
    irn: null,
    qr: null,
    signatory: doc.seller.signatoryName,
    footer: doc.seller.template.footer,
  };
}

/** A payment's invoices or bills, a credit's applications. */
function Allocations({ doc }: { doc: PrintDoc }) {
  if (!doc.allocations) return null;
  return (
    <div data-slot="document-allocations">
      <p className="mb-1 text-[#6c6c6c]">{doc.allocations.label}</p>
      <table className="w-full border-collapse">
        <thead>
          <tr className="bg-[#f2f3f4]">
            <th className="px-2 py-[5px] text-left font-semibold">Number</th>
            <th className="px-2 py-[5px] text-left font-semibold">Date</th>
            <th className="px-2 py-[5px] text-right font-semibold">Amount</th>
          </tr>
        </thead>
        <tbody>
          {doc.allocations.rows.map((r, i) => (
            <tr key={i} className="border-b border-[#e3e3e3]">
              <td className="px-2 py-[5px]">{r.number}</td>
              <td className="px-2 py-[5px]">{r.date ? day(r.date) : '—'}</td>
              <td className="px-2 py-[5px] text-right tabular-nums">{amt(r.paise)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** One copy of the document. Exported for printing several at once. */
export function DocumentSheet({ doc, copyLabel, last, ribbon }: { doc: PrintDoc; copyLabel: string | null; last: boolean; ribbon?: Ribbon | null }) {
  const t = doc.seller.template;
  return (
    <div data-slot="printed-document" data-kind={doc.kind} className={cn(!last && 'break-after-page')}>
      <ZohoSheet model={documentModel(doc, copyLabel)} template={t} layout={layoutFor(t, doc.kind)} ribbon={ribbon} last />
    </div>
  );
}
