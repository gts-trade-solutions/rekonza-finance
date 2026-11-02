'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Every document besides the invoice, on paper (lib/print-doc.ts): a quote, a
// sales order, a delivery challan, a credit note, a retainer invoice, a
// payment receipt, a purchase order, a vendor credit, a payment advice or a
// bill. It wears the business's invoice template (Settings → Invoice print) —
// layout, accent colour, logo, signature and footer — so every document the
// business sends looks like the same business, as in Zoho Books.
// ─────────────────────────────────────────────────────────────────────────────

import Link from 'next/link';
import { createContext, useContext, useState, type ReactNode } from 'react';
import { ArrowLeft, Printer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { rupeesInWords } from '@/lib/billing/words';
import { formatINR } from '@/lib/money';
import { stateName, stateTaxLabel } from '@/lib/tax/gst';
import { cn } from '@/lib/utils';
import { isPrintLanguage, PRINT_LANGUAGES, translate, type PrintLanguage } from '@/lib/print-languages';
import { printPage } from '@/lib/output-guard';
import type { PrintDoc, PrintKind, PrintParty } from '@/lib/print-doc';

/** Where each kind is listed: the way back from its printed copy. */
export const LIST_PATH: Record<PrintKind, string> = {
  estimate: '/sales/estimates', 'sales-order': '/sales/sales-orders', challan: '/sales/challans', 'credit-note': '/sales/credit-notes',
  retainer: '/sales/retainers', 'payment-received': '/sales/payments', 'purchase-order': '/purchases/purchase-orders',
  'vendor-credit': '/purchases/vendor-credits', 'payment-made': '/purchases/payments', bill: '/purchases/bills',
};

const tint = (hex: string, alpha: number) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const day = (iso: string) => {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return `${String(d).padStart(2, '0')} ${MONTHS[m - 1]} ${y}`;
};
const amt = (paise: number) => (paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const place = (code: string) => `${stateName(code)} (${code})`;

const Lang = createContext<PrintLanguage | null>(null);
function L({ t, inline = false }: { t: string; inline?: boolean }) {
  const local = translate(t, useContext(Lang));
  if (!local) return <>{t}</>;
  return inline
    ? <>{t} <span className="font-normal normal-case tracking-normal">· {local}</span></>
    : <>{t}<span className="block font-normal normal-case tracking-normal text-slate-500">{local}</span></>;
}

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
      <Lang.Provider value={lang || null}>
        {shown.map((c, i) => <DocumentSheet key={c} doc={doc} copyLabel={doc.copies.length > 1 ? c : null} last={i === shown.length - 1} />)}
      </Lang.Provider>
    </div>
  );
}

function PartyBlock({ p, extra }: { p: PrintParty; extra?: ReactNode }) {
  const cityLine = p.address && p.pincode && p.address.includes(p.pincode) ? '' : [p.city, p.pincode].filter(Boolean).join(' – ');
  return (
    <div className="min-w-0 space-y-0.5">
      <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-500"><L t={p.label} inline /></p>
      {p.name && <p className="font-semibold">{p.name}</p>}
      {p.address && <p className="whitespace-pre-line">{p.address}</p>}
      {cityLine && <p>{cityLine}</p>}
      {p.stateCode && <p><L t="State" inline />: {place(p.stateCode)}</p>}
      {p.gstin !== undefined && <p>GSTIN: <span className="font-mono">{p.gstin ?? 'Unregistered'}</span></p>}
      {extra}
    </div>
  );
}

/** One copy of the document. Exported for printing several at once. */
export function DocumentSheet({ doc, copyLabel, last }: { doc: PrintDoc; copyLabel: string | null; last: boolean }) {
  const t = doc.seller.template;
  const modern = t.layout === 'modern';
  const compact = t.layout === 'compact';
  const split = doc.taxColumns === 'split';
  const integrated = doc.taxColumns === 'integrated';
  const hasLines = doc.lines.length > 0;
  const qty = doc.lines.some((l) => l.qty != null);
  const discount = doc.lines.some((l) => l.discountPct > 0);
  const cess = doc.lines.some((l) => l.cessPaise > 0);
  const taxed = split || integrated;
  const sgst = stateTaxLabel(doc.placeOfSupply);
  const label = (l: string) => (l === 'SGST' ? sgst : l);

  return (
    <article
      className={cn(
        'print-sheet mx-auto max-w-4xl rounded-[3px] border bg-white leading-snug text-slate-900 shadow-sm dark:bg-white',
        compact ? 'p-5 text-[11px]' : 'p-7 text-[12px]',
        modern && 'border-t-[6px]',
        'print:max-w-none print:rounded-none print:border-0 print:p-0 print:text-[10.5px] print:shadow-none',
        !last && 'break-after-page',
      )}
      data-slot="printed-document"
      data-kind={doc.kind}
      data-layout={t.layout}
      style={modern ? { borderTopColor: t.accent } : undefined}
    >
      <header className="flex items-start justify-between gap-6 border-b border-slate-300 pb-4">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h1 className={cn('font-bold uppercase tracking-wide', compact ? 'text-base' : 'text-lg')} style={t.layout !== 'classic' ? { color: t.accent } : undefined}>
              <L t={doc.title} inline />
            </h1>
            {copyLabel && <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-slate-600">{copyLabel}</span>}
            {doc.tag && <span className="rounded-[2px] border border-slate-900 px-1.5 text-[10px] font-bold uppercase tracking-wide">{doc.tag}</span>}
          </div>
          {doc.endorsement && <p className="text-[11px] font-semibold uppercase">{doc.endorsement}</p>}
          {t.showLogo && doc.seller.logoUrl && (
            // eslint-disable-next-line @next/next/no-img-element -- printed as-is; next/image adds nothing on paper
            <img src={doc.seller.logoUrl} alt={`${doc.seller.name} logo`} className="max-h-14 max-w-[45mm] object-contain object-left" />
          )}
          <PartyBlock
            p={doc.seller}
            extra={<>
              {doc.seller.tradeName && <p>Trading as {doc.seller.tradeName}</p>}
              {doc.seller.pan && <p>PAN: <span className="font-mono">{doc.seller.pan}</span></p>}
              {(doc.seller.phone || doc.seller.email) && <p>{[doc.seller.phone, doc.seller.email].filter(Boolean).join(' · ')}</p>}
            </>}
          />
        </div>
      </header>

      <section className="grid gap-5 border-b border-slate-300 py-4 sm:grid-cols-3">
        <dl className="grid grid-cols-[auto_1fr] content-start gap-x-3 gap-y-0.5" data-slot="document-facts">
          {doc.facts.map((f) => (
            <div key={f.label} className="contents">
              <dt className="text-slate-500"><L t={f.label} /></dt>
              <dd className={f.label.endsWith('no.') ? 'whitespace-nowrap font-mono font-semibold' : undefined}>{f.value}</dd>
            </div>
          ))}
          {doc.placeOfSupply && (
            <>
              <dt className="text-slate-500"><L t="Place of supply" /></dt>
              <dd>{place(doc.placeOfSupply)}</dd>
            </>
          )}
        </dl>
        <PartyBlock p={doc.party} />
        {doc.shipTo ? <PartyBlock p={doc.shipTo} /> : <div className="hidden sm:block" />}
      </section>

      {hasLines && (
        <div className="overflow-x-auto py-3">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-y border-slate-300 bg-slate-50 text-[10px] uppercase tracking-[0.05em] text-slate-600"
                style={modern ? { backgroundColor: tint(t.accent, 0.08), color: t.accent } : undefined}>
                <th className="px-1.5 py-1.5 text-left font-semibold">#</th>
                <th className="px-1.5 py-1.5 text-left font-semibold"><L t="Description" /></th>
                {qty && <th className="px-1.5 py-1.5 text-left font-semibold">HSN/SAC</th>}
                {qty && <th className="px-1.5 py-1.5 text-right font-semibold"><L t="Qty" /></th>}
                {qty && <th className="px-1.5 py-1.5 text-right font-semibold"><L t="Rate" /> (₹)</th>}
                {discount && <th className="px-1.5 py-1.5 text-right font-semibold"><L t="Disc." /></th>}
                {taxed && <th className="px-1.5 py-1.5 text-right font-semibold"><L t="Taxable" /> (₹)</th>}
                {split && <th className="px-1.5 py-1.5 text-right font-semibold">CGST (₹)</th>}
                {split && <th className="px-1.5 py-1.5 text-right font-semibold">{sgst} (₹)</th>}
                {integrated && <th className="px-1.5 py-1.5 text-right font-semibold">IGST (₹)</th>}
                {cess && <th className="px-1.5 py-1.5 text-right font-semibold"><L t="Cess" /> (₹)</th>}
                <th className="px-1.5 py-1.5 text-right font-semibold"><L t="Amount" /> (₹)</th>
              </tr>
            </thead>
            <tbody>
              {doc.lines.map((l, i) => (
                <tr key={i} className="border-b border-slate-200 align-top">
                  <td className="px-1.5 py-1.5">{i + 1}</td>
                  <td className="px-1.5 py-1.5">{l.description ?? '—'}</td>
                  {qty && <td className="px-1.5 py-1.5 font-mono">{l.hsnSac ?? '—'}</td>}
                  {qty && <td className="whitespace-nowrap px-1.5 py-1.5 text-right tabular-nums">{l.qty ?? ''} {l.uqc ?? ''}</td>}
                  {qty && <td className="px-1.5 py-1.5 text-right tabular-nums">{l.ratePaise == null ? '' : amt(l.ratePaise)}</td>}
                  {discount && <td className="px-1.5 py-1.5 text-right tabular-nums">{l.discountPct ? `${l.discountPct}%` : '—'}</td>}
                  {taxed && <td className="px-1.5 py-1.5 text-right tabular-nums">{amt(l.taxablePaise)}</td>}
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
      )}

      {doc.allocations && (
        <div className="py-3" data-slot="document-allocations">
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-500">{doc.allocations.label}</p>
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-y border-slate-300 bg-slate-50 text-[10px] uppercase tracking-[0.05em] text-slate-600">
                <th className="px-1.5 py-1.5 text-left font-semibold">Number</th>
                <th className="px-1.5 py-1.5 text-left font-semibold">Date</th>
                <th className="px-1.5 py-1.5 text-right font-semibold">Amount (₹)</th>
              </tr>
            </thead>
            <tbody>
              {doc.allocations.rows.map((r, i) => (
                <tr key={i} className="border-b border-slate-200">
                  <td className="px-1.5 py-1.5 font-mono">{r.number}</td>
                  <td className="px-1.5 py-1.5">{r.date ? day(r.date) : '—'}</td>
                  <td className="px-1.5 py-1.5 text-right tabular-nums">{amt(r.paise)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <section className={cn('grid gap-5 sm:grid-cols-[1fr_minmax(0,17rem)]', !hasLines && !doc.allocations && 'pt-4')}>
        <div className="space-y-3">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-500"><L t="Amount in words" inline /></p>
            <p className="font-medium">{rupeesInWords(doc.totalPaise)}</p>
          </div>
          {doc.notes && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-500"><L t="Notes" inline /></p>
              <p className="whitespace-pre-line">{doc.notes}</p>
            </div>
          )}
          {doc.terms && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-500"><L t="Terms" inline /></p>
              <p className="whitespace-pre-line text-slate-700">{doc.terms}</p>
            </div>
          )}
        </div>
        <dl className="space-y-1" data-slot="document-totals">
          {doc.totals.map((r) => (
            <div key={r.label} className="flex justify-between gap-4">
              <dt className="text-slate-600"><L t={label(r.label)} inline /></dt>
              <dd className="tabular-nums">{formatINR(r.paise)}</dd>
            </div>
          ))}
          <div className="flex justify-between gap-4 border-t border-slate-400 pt-1.5 text-[13px] font-bold">
            <dt><L t={doc.totalLabel} inline /></dt>
            <dd className="tabular-nums">{formatINR(doc.totalPaise)}</dd>
          </div>
          {doc.after.map((r) => (
            <div key={r.label} className="flex justify-between gap-4">
              <dt className="text-slate-600"><L t={r.label} inline /></dt>
              <dd className="tabular-nums">{formatINR(r.paise)}</dd>
            </div>
          ))}
        </dl>
      </section>

      {t.showSignature && (
        <footer className={cn('flex justify-end', compact ? 'mt-5' : 'mt-8')}>
          <div className="w-60 text-center">
            <p>For {doc.seller.name}</p>
            <div className={compact ? 'h-8' : 'h-12'} />
            {doc.seller.signatoryName && <p className="font-medium">{doc.seller.signatoryName}</p>}
            <p className="border-t border-slate-400 pt-1 text-slate-600"><L t="Authorised signatory" /></p>
          </div>
        </footer>
      )}
      {t.footer && <p className="mt-6 border-t border-slate-200 pt-2 text-center text-[10px] text-slate-500">{t.footer}</p>}
    </article>
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
