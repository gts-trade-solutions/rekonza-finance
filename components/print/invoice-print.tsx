'use client';

// ─────────────────────────────────────────────────────────────────────────────
// An invoice as the law wants it on paper.
//
// Rule 46 of the CGST Rules lists what a tax invoice must carry, and an
// e-invoice adds three more: the IRN, the acknowledgement, and the signed QR
// code the IRP returned. Every figure here is read back from the stored
// document, never recomputed, so a reprint next year is the same invoice.
//
// Copies follow Rule 48: goods go in triplicate (recipient, transporter,
// supplier), services in duplicate.
// ─────────────────────────────────────────────────────────────────────────────

import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import { AlertTriangle, ArrowLeft, Printer } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { Button } from '@/components/ui/button';
import type { InvoiceDetail } from '@/lib/api/client';
import { upiPayUri } from '@/lib/billing/upi';
import { formatINR } from '@/lib/money';
import { stateName, stateTaxLabel } from '@/lib/tax/gst';
import { cn } from '@/lib/utils';
import { isPrintLanguage, PRINT_LANGUAGES, type PrintLanguage } from '@/lib/print-languages';
import { printPage } from '@/lib/output-guard';
import { useDocumentTitle } from '@/lib/use-document-title';
import { DEFAULT_TEMPLATE, layoutFor } from '@/lib/print-template';
import { addressLines, SheetLang, taxRows, termsLabel, zohoWords, ZohoSheet, type Ribbon, type SheetLine, type SheetModel } from '@/components/print/zoho-sheet';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-09-12" as "12 Sep 2026". */
const day = (iso: string) => {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return `${String(d).padStart(2, '0')} ${MONTHS[m - 1]} ${y}`;
};

/** An instant, in Indian time — which is what every GST portal timestamp means. */
const istTime = (value: string) => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
      .formatToParts(new Date(value))
      .map((p) => [p.type, p.value]),
  );
  return `${parts.day} ${MONTHS[Number(parts.month) - 1]} ${parts.year}, ${parts.hour}:${parts.minute}`;
};

const place = (code: string) => `${stateName(code)} (${code})`;

interface Copy {
  key: string;
  label: string;
}

function copiesFor(kind: string): Copy[] {
  // A document with any goods on it travels, so it gets the transporter's copy.
  return kind === 'service'
    ? [
        { key: 'original', label: 'Original for recipient' },
        { key: 'duplicate', label: 'Duplicate for supplier' },
      ]
    : [
        { key: 'original', label: 'Original for recipient' },
        { key: 'duplicate', label: 'Duplicate for transporter' },
        { key: 'triplicate', label: 'Triplicate for supplier' },
      ];
}

/**
 * What the document is called, and the words the law requires on its face.
 *
 * A composition dealer, or a supply that is wholly exempt, issues a bill of
 * supply rather than a tax invoice (Rule 49). Exports and SEZ supplies carry
 * the endorsement from the proviso to Rule 46, which is what customs and the
 * refund officer look for.
 */
function documentTitle(inv: InvoiceDetail): { title: string; endorsement: string | null } {
  // Rule 53(1A): a debit note says so, and names the invoice it corrects.
  if (inv.debitNote) {
    const a = inv.debitNote.against;
    return {
      title: 'Debit Note',
      endorsement: [a ? `Against invoice ${a.number} dated ${day(a.date)}` : null, inv.debitNote.reason].filter(Boolean).join(' · ') || null,
    };
  }
  if (inv.seller.registration === 'unregistered') return { title: 'Invoice', endorsement: null };
  if (inv.seller.registration === 'composition') {
    return {
      title: 'Bill of Supply',
      endorsement: 'Composition taxable person, not eligible to collect tax on supplies',
    };
  }
  switch (inv.supplyType) {
    case 'nil_or_exempt':
      return { title: 'Bill of Supply', endorsement: null };
    case 'export_with_tax':
      return { title: 'Tax Invoice', endorsement: 'Supply meant for export on payment of integrated tax' };
    case 'export_lut':
      return {
        title: 'Tax Invoice',
        endorsement: inv.exportInfo?.lutArn
          ? `Supply meant for export under letter of undertaking (ARN ${inv.exportInfo.lutArn}) without payment of integrated tax`
          : 'Supply meant for export under bond or letter of undertaking without payment of integrated tax',
      };
    case 'sez':
      return {
        title: 'Tax Invoice',
        endorsement:
          inv.tax.igstPaise > 0
            ? 'Supply to SEZ unit or SEZ developer for authorised operations on payment of integrated tax'
            : 'Supply to SEZ unit or SEZ developer for authorised operations under bond or letter of undertaking without payment of integrated tax',
      };
    default:
      return { title: 'Tax Invoice', endorsement: null };
  }
}

/** What the person printing should know first. Shown on screen, never on paper. */
function screenWarnings(inv: InvoiceDetail): { id: string; node: ReactNode }[] {
  const out: { id: string; node: ReactNode }[] = [];
  const e = inv.einvoice;
  if (inv.status === 'draft') {
    out.push({
      id: 'draft',
      node: 'This invoice is still a draft. It is not a tax invoice until it is issued, so print it for checking only.',
    });
  }
  if (inv.status === 'void') {
    out.push({ id: 'void', node: 'This invoice was voided. It prints marked as cancelled, for your records.' });
  }
  if (e.status === 'pending' || e.status === 'failed') {
    out.push({
      id: 'no-irn',
      node: (
        <>
          It has no IRN yet. If your business has to e-invoice, register it before sending it: without an IRN it
          is not a valid tax invoice for your customer.{' '}
          <Link href="/gst/einvoices" className="font-medium underline underline-offset-2">
            Open the e-invoice register
          </Link>
        </>
      ),
    });
  }
  if (e.status === 'cancelled') {
    out.push({
      id: 'irn-cancelled',
      node: `Its IRN was cancelled${e.cancelledAt ? ` on ${istTime(e.cancelledAt)}` : ''}, so the printed copy carries no QR code.`,
    });
  }
  if (e.status === 'submitted' && !e.signedQr) {
    out.push({
      id: 'no-qr',
      node: 'No signed QR code is stored for this IRN, so none can be printed. The QR is required on an e-invoice.',
    });
  }
  if (e.status === 'submitted' && e.environment === 'stand-in') {
    out.push({
      id: 'stand-in',
      node: 'The IRN below came from the built-in stand-in, not the government portal. It is for trying the app out and is not valid on a real invoice.',
    });
  }
  if (e.status === 'submitted' && e.environment === 'sandbox') {
    out.push({ id: 'sandbox', node: 'The IRN below is a NIC sandbox test registration. Nothing was filed.' });
  }
  return out;
}

/**
 * The invoice with its toolbar: which copy, a second language, print. Shared
 * (a link sent to the customer), it is the recipient's copy alone, without the
 * way back into the app or the notes meant for the people who raised it.
 */
export function PrintView({ inv, shared = false }: { inv: InvoiceDetail; shared?: boolean }) {
  const copies = copiesFor(inv.supplyKind);
  const [copy, setCopy] = useState('original');
  const [lang, setLang] = useState<PrintLanguage | ''>(isPrintLanguage(inv.seller.printLanguage) ? inv.seller.printLanguage : '');
  const shown = copy === 'all' ? copies : copies.filter((c) => c.key === copy);
  // Saved as PDF, the file is named after the invoice, as Zoho's is.
  useDocumentTitle(inv.number);
  // PDF/Print on the invoice opens this page with ?print=1: print once the logo has loaded.
  useEffect(() => {
    if (shared || new URLSearchParams(window.location.search).get('print') !== '1') return;
    const timer = window.setTimeout(() => printPage(), 700);
    return () => window.clearTimeout(timer);
  }, [shared]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 no-print">
        {shared ? <span className="text-sm font-medium">{inv.number}</span> : (
          <Button variant="outline" size="sm" asChild>
            <Link href={`/sales/invoices/${inv.id}`}>
              <ArrowLeft className="size-3.5" /> {inv.number}
            </Link>
          </Button>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {!shared && <div className="flex flex-wrap rounded-[3px] border p-0.5 text-xs" role="group" aria-label="Which copy to print" data-slot="copy-picker">
            {[...copies, { key: 'all', label: 'All copies' }].map((c) => (
              <button
                key={c.key}
                type="button"
                onClick={() => setCopy(c.key)}
                aria-pressed={copy === c.key}
                className={cn(
                  'rounded-[2px] px-2.5 py-1 transition-colors',
                  copy === c.key ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {c.label}
              </button>
            ))}
          </div>}
          <select value={lang} onChange={(e) => setLang(e.target.value as PrintLanguage | '')} aria-label="Second language"
            className="h-8 rounded-[3px] border bg-background px-2 text-xs">
            <option value="">English only</option>
            {Object.entries(PRINT_LANGUAGES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          {shared && inv.payLink && (
            <Button size="sm" asChild data-slot="pay-online">
              <a href={inv.payLink.url} target="_blank" rel="noopener noreferrer">Pay {formatINR(inv.payLink.amountPaise)} online</a>
            </Button>
          )}
          <Button size="sm" onClick={() => printPage()} data-slot="print-invoice">
            <Printer className="size-3.5" /> Print or save as PDF
          </Button>
        </div>
      </div>

      {!shared && screenWarnings(inv).map((w) => (
        <div
          key={w.id}
          className="flex items-start gap-2 rounded-[3px] border border-warning/40 bg-warning/10 px-3 py-2 text-sm no-print"
          data-slot={`print-warning-${w.id}`}
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
          <span>{w.node}</span>
        </div>
      ))}

      <SheetLang.Provider value={lang || null}>
        {shown.map((c, i) => (
          <InvoiceSheet key={c.key} inv={inv} copyLabel={c.label} last={i === shown.length - 1} />
        ))}
      </SheetLang.Provider>
    </div>
  );
}

/** One invoice's recipient copy, for printing several at once (/print/bulk). */
export function InvoiceSheetPrint({ inv, last }: { inv: InvoiceDetail; last: boolean }) {
  return <InvoiceSheet inv={inv} copyLabel="Original for recipient" last={last} />;
}

/** The invoice, read into the shape every Zoho template prints. */
export function invoiceModel(inv: InvoiceDetail, copyLabel: string | null): SheetModel {
  const { title, endorsement } = documentTitle(inv);
  const e = inv.einvoice;
  // Which tax columns the table needs. A bill of supply charges no tax at all;
  // otherwise the supply type decides between the CGST + SGST pair and IGST.
  const taxed = inv.seller.registration === 'regular' && inv.supplyType !== 'nil_or_exempt';
  const split = taxed && inv.supplyType === 'intra';
  const integrated = taxed && !split && (inv.tax.igstPaise > 0 || inv.supplyType === 'inter' || inv.supplyType === 'export_with_tax');
  const stateTax = stateTaxLabel(inv.placeOfSupply);
  const t = inv.seller.template ?? DEFAULT_TEMPLATE;
  const lines: SheetLine[] = inv.lines.map((l) => {
    const item = l.itemName?.trim() || null;
    const text = l.description?.trim() || null;
    return {
      name: item ?? text ?? '—',
      description: item && text && text !== item ? text : null,
      hsn: l.hsnSac, qty: l.qty, unit: l.uqc, ratePaise: l.ratePaise, discountPct: l.discountPct,
      taxablePaise: l.taxablePaise, gstRatePct: l.gstRatePct, cgstPaise: l.cgstPaise, sgstPaise: l.sgstPaise,
      igstPaise: l.igstPaise, cessPaise: l.cessPaise, amountPaise: l.totalPaise,
    };
  });
  const subTotal = inv.lines.reduce((s2, l) => s2 + l.taxablePaise, 0);
  const noun = inv.debitNote ? 'Debit Note' : 'Invoice';
  return {
    title,
    numberLabel: `${noun}#`,
    number: inv.number,
    copyLabel,
    stamp: inv.status === 'void' ? 'Cancelled' : inv.status === 'draft' ? 'Draft' : null,
    endorsement,
    headings: [
      ...(inv.voucherType?.heading ? [inv.voucherType.heading] : []),
      ...(inv.exportInfo?.shippingBillNo
        ? [`Shipping bill ${inv.exportInfo.shippingBillNo}${inv.exportInfo.shippingBillDate ? ` dated ${day(inv.exportInfo.shippingBillDate)}` : ''}${inv.exportInfo.portCode ? `, port ${inv.exportInfo.portCode}` : ''}`]
        : []),
    ],
    seller: {
      name: inv.seller.name,
      logoUrl: inv.seller.logoUrl,
      lines: addressLines(inv.seller.address, inv.seller.city, inv.seller.pincode, inv.seller.stateCode),
      gstin: inv.seller.registration === 'unregistered' ? null : inv.seller.gstin,
      extra: [
        ...(inv.seller.tradeName ? [`Trading as ${inv.seller.tradeName}`] : []),
        ...(inv.seller.pan ? [`PAN ${inv.seller.pan}`] : []),
        ...(inv.seller.phone || inv.seller.email ? [[inv.seller.phone, inv.seller.email].filter(Boolean).join(' · ')] : []),
      ],
    },
    billTo: {
      label: 'Bill To', name: inv.buyer.name,
      lines: addressLines(inv.buyer.address, inv.buyer.city, inv.buyer.pincode, inv.buyer.stateCode),
      gstin: inv.buyer.gstin,
    },
    shipTo: inv.shipTo ? { label: 'Ship To', name: inv.buyer.name, lines: addressLines(inv.shipTo.address, inv.shipTo.city, inv.shipTo.pincode) } : null,
    facts: [
      { label: `${noun} Date`, value: day(inv.date) },
      ...(inv.paymentTerms ? [{ label: 'Terms', value: termsLabel(inv.paymentTerms) }] : []),
      { label: 'Due Date', value: day(inv.dueDate) },
      ...(inv.orderNumber ? [{ label: 'P.O.#', value: inv.orderNumber }] : []),
      { label: 'Place Of Supply', value: place(inv.placeOfSupply) },
      ...(inv.ewayBill ? [{ label: 'E-Way Bill#', value: inv.ewayBill.number }] : []),
      ...(inv.printFields ?? []).map((f) => ({ label: f.label, value: f.value })),
      { label: 'Reverse Charge', value: 'No' },
    ],
    balance: { label: 'Balance Due', paise: inv.balancePaise },
    date: day(inv.date),
    taxColumns: split ? 'split' : integrated ? 'integrated' : 'none',
    stateTax,
    lines,
    subTotalPaise: subTotal,
    totals: [
      ...(inv.shippingChargePaise ? [{ label: 'Shipping Charge', paise: inv.shippingChargePaise }] : []),
      ...taxRows(inv.lines, split, integrated, stateTax),
      ...(inv.supplyType === 'export_lut' ? [{ label: 'IGST (Nil, under LUT)', paise: 0 }] : []),
      ...(inv.tcsPaise ? [{ label: 'TCS', paise: inv.tcsPaise }] : []),
      ...(inv.adjustmentPaise ? [{ label: inv.adjustmentLabel ?? 'Adjustment', paise: inv.adjustmentPaise }] : []),
      ...(inv.roundOffPaise ? [{ label: 'Round Off', paise: inv.roundOffPaise }] : []),
    ],
    totalLabel: 'Total',
    totalPaise: inv.totalPaise,
    after: inv.amountPaidPaise > 0 ? [{ label: 'Payment Made', paise: -inv.amountPaidPaise }] : [],
    balanceRow: { label: 'Balance Due', paise: inv.balancePaise },
    words: zohoWords(inv.totalPaise),
    notes: inv.notes,
    terms: inv.terms || inv.voucherType?.terms || null,
    payment: <PaymentDetails inv={inv} />,
    extra: inv.foreign ? (
      <div>
        <p className="text-[#6c6c6c]">Invoice currency</p>
        <p className="font-medium">{new Intl.NumberFormat('en-IN', { style: 'currency', currency: inv.foreign.currency }).format(inv.foreign.totalPaise / 100)} at ₹{inv.foreign.rate} per {inv.foreign.currency}</p>
      </div>
    ) : null,
    irn: e.status === 'submitted' && e.irn ? <IrnBlock inv={inv} /> : null,
    qr: e.status === 'submitted' ? e.signedQr ?? null : null,
    signatory: inv.seller.signatoryName,
    footer: t.footer,
  };
}

/** The IRN, the acknowledgement, and whether it is a real registration. */
function IrnBlock({ inv }: { inv: InvoiceDetail }) {
  const e = inv.einvoice;
  return (
    <div className="space-y-[2px]" data-slot="invoice-irn">
      <p className="min-w-0"><span className="text-[#6c6c6c]">IRN </span><span className="break-all font-mono text-[10px]">{e.irn}</span></p>
      {e.ackNo && <p><span className="text-[#6c6c6c]">Ack No </span><span className="font-mono">{e.ackNo}</span></p>}
      {e.ackDate && <p><span className="text-[#6c6c6c]">Ack Date </span>{istTime(e.ackDate)}</p>}
      {e.environment !== 'production' && (
        <p className="text-[9.5px] font-semibold uppercase">
          {e.environment === 'sandbox' ? 'NIC sandbox test registration — nothing was filed' : 'Issued by the built-in stand-in — not registered with the government portal'}
        </p>
      )}
    </div>
  );
}

/** The invoice in the template chosen for it (or for invoices), as Zoho shows it on the record. */
export function InvoiceDocument({ inv, ribbon, copyLabel = null, last = true }: {
  inv: InvoiceDetail; ribbon?: Ribbon | null; copyLabel?: string | null; last?: boolean;
}) {
  const t = inv.seller.template ?? DEFAULT_TEMPLATE;
  return <ZohoSheet model={invoiceModel(inv, copyLabel)} template={t} layout={layoutFor(t, 'invoice', inv.printTemplate)} ribbon={ribbon} last={last} />;
}

function InvoiceSheet({ inv, copyLabel, last }: { inv: InvoiceDetail; copyLabel: string; last: boolean }) {
  return <InvoiceDocument inv={inv} copyLabel={copyLabel} last={last} />;
}

/**
 * Where and how to pay: the bank account chosen in settings, and a UPI code
 * for the balance due. The code is left off when there is nothing to pay, on
 * a cancelled invoice, and on an export, which is not paid by UPI.
 */
function PaymentDetails({ inv }: { inv: InvoiceDetail }) {
  // A voucher type may print without the bank details or the UPI code.
  const bank = inv.voucherType?.showBank === false ? null : inv.seller.bank;
  const upi = inv.voucherType?.showUpi === false ? null : inv.seller.upi;
  const payable = inv.balancePaise > 0 && inv.status !== 'void'
    && inv.supplyType !== 'export_lut' && inv.supplyType !== 'export_with_tax';
  const upiUri = upi && payable
    ? upiPayUri({
        vpa: upi.id, payeeName: upi.payeeName, amountPaise: inv.balancePaise,
        note: `Invoice ${inv.number}`, reference: inv.number,
      })
    : null;
  if (!bank && !upiUri) return null;

  return (
    <div className="flex items-start gap-4" data-slot="invoice-payment">
      {bank && (
        <div className="min-w-0">
          <p className="text-[#6c6c6c]">Bank Details</p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3">
            <dt className="text-slate-500">Account name</dt>
            <dd>{bank.accountHolder}</dd>
            <dt className="text-slate-500">Account no.</dt>
            <dd className="font-mono">{bank.accountNumber}</dd>
            {bank.ifsc && (
              <>
                <dt className="text-slate-500">IFSC</dt>
                <dd className="font-mono">{bank.ifsc}</dd>
              </>
            )}
            {(bank.bankName || bank.branchName) && (
              <>
                <dt className="text-slate-500">Bank</dt>
                <dd>{[bank.bankName, bank.branchName].filter(Boolean).join(', ')}</dd>
              </>
            )}
          </dl>
        </div>
      )}
      {upiUri && upi && (
        <div className="shrink-0 text-center" data-slot="invoice-upi">
          <QRCodeSVG value={upiUri} size={96} level="M" marginSize={0} title="Pay by UPI" className="size-[24mm]" />
          <p className="mt-1 text-[9px] uppercase tracking-[0.08em] text-slate-500">Scan to pay {formatINR(inv.balancePaise)}</p>
          <p className="font-mono text-[9px] text-slate-600">{upi.id}</p>
        </div>
      )}
    </div>
  );
}

