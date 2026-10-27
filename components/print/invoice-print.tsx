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
import { createContext, useContext, useState, type ReactNode } from 'react';
import { AlertTriangle, ArrowLeft, Printer } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { Button } from '@/components/ui/button';
import type { InvoiceDetail } from '@/lib/api/client';
import { rupeesInWords } from '@/lib/billing/words';
import { upiPayUri } from '@/lib/billing/upi';
import { formatINR } from '@/lib/money';
import { stateName, stateTaxLabel } from '@/lib/tax/gst';
import { cn } from '@/lib/utils';
import { isPrintLanguage, PRINT_LANGUAGES, translate, type PrintLanguage } from '@/lib/print-languages';
import { printPage } from '@/lib/output-guard';

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

/** Amounts in a table column: the ₹ is in the header, not on every cell. */
const amt = (paise: number) =>
  (paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const place = (code: string) => `${stateName(code)} (${code})`;

/** The second language the sheet prints its labels in, if any. */
const Lang = createContext<PrintLanguage | null>(null);

/** A label, and under it the same in the second language. */
function L({ t, inline = false }: { t: string; inline?: boolean }) {
  const local = translate(t, useContext(Lang));
  if (!local) return <>{t}</>;
  return inline
    ? <>{t} <span className="font-normal normal-case tracking-normal">· {local}</span></>
    : <>{t}<span className="block font-normal normal-case tracking-normal text-slate-500">{local}</span></>;
}

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
        endorsement: 'Supply meant for export under bond or letter of undertaking without payment of integrated tax',
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

      <Lang.Provider value={lang || null}>
        {shown.map((c, i) => (
          <InvoiceSheet key={c.key} inv={inv} copyLabel={c.label} last={i === shown.length - 1} />
        ))}
      </Lang.Provider>
    </div>
  );
}

function PartyBlock({
  label,
  name,
  address,
  city,
  pincode,
  stateCode,
  gstin,
  extra,
}: {
  label: string;
  name?: string;
  address: string | null;
  city: string | null;
  pincode: string | null;
  stateCode?: string;
  gstin?: string | null;
  extra?: ReactNode;
}) {
  // Plenty of addresses already end in the city and PIN; printing them again
  // underneath reads as a mistake.
  const cityLine = address && pincode && address.includes(pincode) ? '' : [city, pincode].filter(Boolean).join(' – ');
  return (
    <div className="min-w-0 space-y-0.5">
      <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-500"><L t={label} inline /></p>
      {name && <p className="font-semibold">{name}</p>}
      {address && <p className="whitespace-pre-line">{address}</p>}
      {cityLine && <p>{cityLine}</p>}
      {stateCode && <p><L t="State" inline />: {place(stateCode)}</p>}
      {gstin !== undefined && (
        <p>
          GSTIN: <span className="font-mono">{gstin ?? 'Unregistered'}</span>
        </p>
      )}
      {extra}
    </div>
  );
}

function InvoiceSheet({ inv, copyLabel, last }: { inv: InvoiceDetail; copyLabel: string; last: boolean }) {
  const { title, endorsement } = documentTitle(inv);
  const e = inv.einvoice;
  const qr = e.status === 'submitted' ? e.signedQr ?? null : null;

  // Which tax columns the table needs. A bill of supply charges no tax at all;
  // otherwise the supply type decides between the CGST + SGST pair and IGST.
  const taxed = inv.seller.registration === 'regular' && inv.supplyType !== 'nil_or_exempt';
  const split = taxed && inv.supplyType === 'intra';
  const integrated =
    taxed && !split && (inv.tax.igstPaise > 0 || inv.supplyType === 'inter' || inv.supplyType === 'export_with_tax');
  const cess = inv.lines.some((l) => l.cessPaise > 0);
  const discount = inv.lines.some((l) => l.discountPct > 0);
  const taxable = inv.lines.reduce((t, l) => t + l.taxablePaise, 0);
  const tag = inv.status === 'void' ? 'Cancelled' : inv.status === 'draft' ? 'Draft' : null;

  const totals: [string, number][] = [
    ['Taxable value', taxable],
    ...(split
      ? ([
          ['CGST', inv.tax.cgstPaise],
          [stateTaxLabel(inv.placeOfSupply), inv.tax.sgstPaise],
        ] as [string, number][])
      : []),
    ...(integrated ? ([['IGST', inv.tax.igstPaise]] as [string, number][]) : []),
    ...(inv.tax.cessPaise ? ([['Cess', inv.tax.cessPaise]] as [string, number][]) : []),
    ...(inv.shippingChargePaise ? ([['Shipping', inv.shippingChargePaise]] as [string, number][]) : []),
    ...(inv.tcsPaise ? ([['TCS', inv.tcsPaise]] as [string, number][]) : []),
    ...(inv.adjustmentPaise ? ([[inv.adjustmentLabel ?? 'Adjustment', inv.adjustmentPaise]] as [string, number][]) : []),
    ...(inv.roundOffPaise ? ([['Round off', inv.roundOffPaise]] as [string, number][]) : []),
  ];

  return (
    <article
      className={cn(
        'print-sheet mx-auto max-w-4xl rounded-[3px] border bg-white p-7 text-[12px] leading-snug text-slate-900 shadow-sm dark:bg-white',
        // Paper supplies its own edge: no frame, no shadow, no inset.
        'print:max-w-none print:rounded-none print:border-0 print:p-0 print:text-[10.5px] print:shadow-none',
        !last && 'break-after-page',
      )}
      data-slot="tax-invoice"
    >
      {/* ── Title, supplier, and the IRP's stamp ───────────────────────── */}
      <header className="flex items-start justify-between gap-6 border-b border-slate-300 pb-4">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h1 className="text-lg font-bold uppercase tracking-wide"><L t={title} inline /></h1>
            <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-slate-600"><L t={copyLabel} inline /></span>
            {tag && (
              <span className="rounded-[2px] border border-slate-900 px-1.5 text-[10px] font-bold uppercase tracking-wide">
                {tag}
              </span>
            )}
          </div>
          {inv.voucherType?.heading && <p className="text-sm font-semibold">{inv.voucherType.heading}</p>}
          {endorsement && <p className="text-[11px] font-semibold uppercase">{endorsement}</p>}
          {inv.seller.logoUrl && (
            // eslint-disable-next-line @next/next/no-img-element -- printed as-is; next/image adds nothing on paper
            <img
              src={inv.seller.logoUrl}
              alt={`${inv.seller.name} logo`}
              className="max-h-14 max-w-[45mm] object-contain object-left"
              data-slot="invoice-logo"
            />
          )}
          <PartyBlock
            label="Supplier"
            name={inv.seller.name}
            address={inv.seller.address}
            city={inv.seller.city}
            pincode={inv.seller.pincode}
            stateCode={inv.seller.stateCode}
            gstin={inv.seller.registration === 'unregistered' ? undefined : inv.seller.gstin}
            extra={
              <>
                {inv.seller.tradeName && <p>Trading as {inv.seller.tradeName}</p>}
                {inv.seller.pan && <p>PAN: <span className="font-mono">{inv.seller.pan}</span></p>}
                {(inv.seller.phone || inv.seller.email) && (
                  <p>{[inv.seller.phone, inv.seller.email].filter(Boolean).join(' · ')}</p>
                )}
              </>
            }
          />
        </div>
        {qr && (
          <div className="shrink-0 text-center" data-slot="invoice-qr">
            <QRCodeSVG
              value={qr}
              size={152}
              level="M"
              marginSize={0}
              title="Signed QR code issued by the Invoice Registration Portal"
              className="size-[38mm] max-w-full"
            />
            <p className="mt-1 text-[9px] uppercase tracking-[0.08em] text-slate-500">e-Invoice QR</p>
          </div>
        )}
      </header>

      {e.status === 'submitted' && e.irn && (
        <section className="grid gap-x-6 gap-y-1 border-b border-slate-300 py-2.5 sm:grid-cols-2" data-slot="invoice-irn">
          <p className="min-w-0 sm:col-span-2">
            <span className="text-slate-500">IRN </span>
            <span className="break-all font-mono text-[10.5px]">{e.irn}</span>
          </p>
          {e.ackNo && (
            <p>
              <span className="text-slate-500">Ack no. </span>
              <span className="font-mono">{e.ackNo}</span>
            </p>
          )}
          {e.ackDate && (
            <p>
              <span className="text-slate-500">Ack date </span>
              {istTime(e.ackDate)}
            </p>
          )}
          {e.environment !== 'production' && (
            <p className="text-[10px] font-semibold uppercase text-slate-700 sm:col-span-2">
              {e.environment === 'sandbox'
                ? 'NIC sandbox test registration — nothing was filed'
                : 'Issued by the built-in stand-in — not registered with the government portal'}
            </p>
          )}
        </section>
      )}

      {/* ── The document, and who it is for ────────────────────────────── */}
      <section className="grid gap-5 border-b border-slate-300 py-4 sm:grid-cols-3">
        <dl className="grid grid-cols-[auto_1fr] content-start gap-x-3 gap-y-0.5">
          <dt className="text-slate-500"><L t="Invoice no." /></dt>
          <dd className="whitespace-nowrap font-mono font-semibold">{inv.number}</dd>
          <dt className="text-slate-500"><L t="Invoice date" /></dt>
          <dd>{day(inv.date)}</dd>
          <dt className="text-slate-500"><L t="Due date" /></dt>
          <dd>{day(inv.dueDate)}</dd>
          <dt className="text-slate-500"><L t="Place of supply" /></dt>
          <dd>{place(inv.placeOfSupply)}</dd>
          <dt className="text-slate-500"><L t="Reverse charge" /></dt>
          <dd><L t="No" /></dd>
          {inv.orderNumber && (
            <>
              <dt className="text-slate-500"><L t="Order no." /></dt>
              <dd>{inv.orderNumber}</dd>
            </>
          )}
          {inv.ewayBill && (
            <>
              <dt className="text-slate-500"><L t="E-way bill" /></dt>
              <dd className="font-mono">{inv.ewayBill.number}</dd>
            </>
          )}
        </dl>
        <PartyBlock
          label="Billed to"
          name={inv.buyer.name}
          address={inv.buyer.address}
          city={inv.buyer.city}
          pincode={inv.buyer.pincode}
          stateCode={inv.buyer.stateCode}
          gstin={inv.buyer.gstin}
        />
        {inv.shipTo ? (
          <PartyBlock
            label="Shipped to"
            address={inv.shipTo.address}
            city={inv.shipTo.city}
            pincode={inv.shipTo.pincode}
          />
        ) : (
          <div className="hidden sm:block" />
        )}
      </section>

      {/* ── Lines ──────────────────────────────────────────────────────── */}
      <div className="overflow-x-auto py-3">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-y border-slate-300 bg-slate-50 text-[10px] uppercase tracking-[0.05em] text-slate-600">
              <th className="px-1.5 py-1.5 text-left font-semibold">#</th>
              <th className="px-1.5 py-1.5 text-left font-semibold"><L t="Description" /></th>
              <th className="px-1.5 py-1.5 text-left font-semibold">HSN/SAC</th>
              <th className="px-1.5 py-1.5 text-right font-semibold"><L t="Qty" /></th>
              <th className="px-1.5 py-1.5 text-right font-semibold"><L t="Rate" /> (₹)</th>
              {discount && <th className="px-1.5 py-1.5 text-right font-semibold"><L t="Disc." /></th>}
              <th className="px-1.5 py-1.5 text-right font-semibold"><L t="Taxable" /> (₹)</th>
              {split && <th className="px-1.5 py-1.5 text-right font-semibold">CGST (₹)</th>}
              {split && <th className="px-1.5 py-1.5 text-right font-semibold">{stateTaxLabel(inv.placeOfSupply)} (₹)</th>}
              {integrated && <th className="px-1.5 py-1.5 text-right font-semibold">IGST (₹)</th>}
              {cess && <th className="px-1.5 py-1.5 text-right font-semibold"><L t="Cess" /> (₹)</th>}
              <th className="px-1.5 py-1.5 text-right font-semibold"><L t="Amount" /> (₹)</th>
            </tr>
          </thead>
          <tbody>
            {inv.lines.map((l, i) => (
              <tr key={l.id} className="border-b border-slate-200 align-top">
                <td className="px-1.5 py-1.5">{i + 1}</td>
                <td className="px-1.5 py-1.5">{l.description ?? '—'}</td>
                <td className="px-1.5 py-1.5 font-mono">{l.hsnSac ?? '—'}</td>
                <td className="whitespace-nowrap px-1.5 py-1.5 text-right tabular-nums">
                  {l.qty} {l.uqc ?? ''}
                </td>
                <td className="px-1.5 py-1.5 text-right tabular-nums">{amt(l.ratePaise)}</td>
                {discount && <td className="px-1.5 py-1.5 text-right tabular-nums">{l.discountPct ? `${l.discountPct}%` : '—'}</td>}
                <td className="px-1.5 py-1.5 text-right tabular-nums">{amt(l.taxablePaise)}</td>
                {split && <TaxCell amount={l.cgstPaise} rate={l.gstRatePct / 2} />}
                {split && <TaxCell amount={l.sgstPaise} rate={l.gstRatePct / 2} />}
                {integrated && <TaxCell amount={l.igstPaise} rate={l.gstRatePct} />}
                {cess && <td className="px-1.5 py-1.5 text-right tabular-nums">{amt(l.cessPaise)}</td>}
                <td className="px-1.5 py-1.5 text-right font-medium tabular-nums">{amt(l.totalPaise)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ── Totals ─────────────────────────────────────────────────────── */}
      <section className="grid gap-5 sm:grid-cols-[1fr_minmax(0,17rem)]">
        <div className="space-y-3">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-500"><L t="Amount in words" inline /></p>
            <p className="font-medium">{rupeesInWords(inv.totalPaise)}</p>
          </div>
          {inv.foreign && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-500">Invoice currency</p>
              <p className="font-medium">{new Intl.NumberFormat('en-IN', { style: 'currency', currency: inv.foreign.currency }).format(inv.foreign.totalPaise / 100)} at ₹{inv.foreign.rate} per {inv.foreign.currency}</p>
            </div>
          )}
          <PaymentDetails inv={inv} />
          {inv.notes && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-500"><L t="Notes" inline /></p>
              <p className="whitespace-pre-line">{inv.notes}</p>
            </div>
          )}
          {(inv.terms || inv.voucherType?.terms) && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-500"><L t="Terms" inline /></p>
              <p className="whitespace-pre-line text-slate-700">{inv.terms || inv.voucherType?.terms}</p>
            </div>
          )}
        </div>
        <dl className="space-y-1">
          {totals.map(([label, value]) => (
            <div key={label} className="flex justify-between gap-4">
              <dt className="text-slate-600"><L t={label} inline /></dt>
              <dd className="tabular-nums">{formatINR(value)}</dd>
            </div>
          ))}
          <div className="flex justify-between gap-4 border-t border-slate-400 pt-1.5 text-[13px] font-bold">
            <dt><L t="Invoice total" inline /></dt>
            <dd className="tabular-nums">{formatINR(inv.totalPaise)}</dd>
          </div>
        </dl>
      </section>

      {/* ── Signature ──────────────────────────────────────────────────── */}
      <footer className="mt-8 flex justify-end">
        <div className="w-60 text-center">
          <p>For {inv.seller.name}</p>
          <div className="h-12" />
          {inv.seller.signatoryName && <p className="font-medium">{inv.seller.signatoryName}</p>}
          <p className="border-t border-slate-400 pt-1 text-slate-600"><L t="Authorised signatory" /></p>
        </div>
      </footer>
    </article>
  );
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
          <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-500">Bank details</p>
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

function TaxCell({ amount, rate }: { amount: number; rate: number }) {
  return (
    <td className="px-1.5 py-1.5 text-right tabular-nums">
      {amt(amount)}
      <span className="block text-[9.5px] text-slate-500">@ {rate}%</span>
    </td>
  );
}
