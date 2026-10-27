'use client';

// ─────────────────────────────────────────────────────────────────────────────
// The platform's tax invoice for a payment, ready to print or save as PDF.
//
// Everything on it was fixed when it was issued: the parties, the place of
// supply, the split between CGST and SGST or IGST. It is read back, never
// recomputed, so reprinting it next year produces the same document.
// ─────────────────────────────────────────────────────────────────────────────

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, Printer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AsyncPage } from '@/components/shared/async-state';
import { billing, type BillingInvoice } from '@/lib/api/billing';
import { useApi } from '@/lib/api/use-api';
import { rupeesInWords } from '@/lib/billing/words';
import { formatINR } from '@/lib/money';
import { stateName } from '@/lib/tax/gst';
import { printPage } from '@/lib/output-guard';

const day = (d: string) => {
  const [y, m, dd] = d.split('-').map(Number);
  return `${String(dd).padStart(2, '0')} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]} ${y}`;
};

const ratePct = (tax: number, taxable: number) => (taxable ? Math.round((tax / taxable) * 1000) / 10 : 0);

export default function InvoicePage() {
  const { id } = useParams<{ id: string }>();
  const state = useApi<BillingInvoice>(() => billing.invoice(id), [id]);
  return <AsyncPage state={state}>{(inv) => <InvoiceDocument inv={inv} />}</AsyncPage>;
}

function Party({ title, p }: { title: string; p: BillingInvoice['seller'] }) {
  return (
    <div className="text-sm">
      <p className="micro-label mb-1">{title}</p>
      <p className="font-semibold">{p.name}</p>
      {p.address && <p className="text-muted-foreground">{p.address}</p>}
      {p.stateCode && (
        <p className="text-muted-foreground">
          {stateName(p.stateCode)} ({p.stateCode})
        </p>
      )}
      <p className="mt-1">
        GSTIN: <span className="font-mono">{p.gstin ?? 'Unregistered'}</span>
      </p>
      {p.email && <p className="text-muted-foreground">{p.email}</p>}
    </div>
  );
}

function InvoiceDocument({ inv }: { inv: BillingInvoice }) {
  const intra = inv.cgstPaise + inv.sgstPaise > 0;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 no-print">
        <Button variant="outline" size="sm" asChild>
          <Link href="/settings/billing">
            <ArrowLeft className="size-3.5" /> Billing
          </Link>
        </Button>
        <Button size="sm" onClick={() => printPage()}>
          <Printer className="size-3.5" /> Print or save as PDF
        </Button>
      </div>

      <div className="print-sheet mx-auto max-w-3xl rounded-[3px] border bg-white p-8 text-slate-900 shadow-sm dark:bg-white" data-slot="billing-invoice">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 pb-5">
          <div>
            <p className="text-xl font-semibold tracking-tight">{inv.isTaxInvoice ? 'Tax Invoice' : 'Receipt'}</p>
            <p className="text-xs text-slate-500">Original for recipient</p>
          </div>
          <div className="text-right text-sm">
            <p>
              Invoice no. <span className="font-mono font-semibold">{inv.number}</span>
            </p>
            <p>Date {day(inv.date)}</p>
            {inv.placeOfSupply && (
              <p>
                Place of supply {stateName(inv.placeOfSupply)} ({inv.placeOfSupply})
              </p>
            )}
          </div>
        </div>

        <div className="grid gap-6 py-5 sm:grid-cols-2">
          <Party title="From" p={inv.seller} />
          <Party title="Billed to" p={inv.buyer} />
        </div>

        <table className="w-full text-sm">
          <thead>
            <tr className="border-y border-slate-200 text-left text-xs text-slate-500">
              <th className="py-2 pr-2 font-medium">#</th>
              <th className="py-2 pr-2 font-medium">Description</th>
              <th className="py-2 pr-2 font-medium">SAC</th>
              <th className="py-2 pr-2 text-right font-medium">Qty</th>
              <th className="py-2 text-right font-medium">Taxable value</th>
            </tr>
          </thead>
          <tbody>
            {inv.lines.map((l, i) => (
              <tr key={i} className="border-b border-slate-100 align-top">
                <td className="py-2.5 pr-2">{i + 1}</td>
                <td className="py-2.5 pr-2">{l.description}</td>
                <td className="py-2.5 pr-2 font-mono text-xs">{l.sac}</td>
                <td className="py-2.5 pr-2 text-right tabular-nums">{l.qty}</td>
                <td className="py-2.5 text-right tabular-nums">{formatINR(l.taxablePaise)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="ml-auto mt-4 w-full max-w-xs space-y-1.5 text-sm">
          <Row label="Taxable value" value={formatINR(inv.taxablePaise)} />
          {intra ? (
            <>
              <Row label={`CGST @ ${ratePct(inv.cgstPaise, inv.taxablePaise)}%`} value={formatINR(inv.cgstPaise)} />
              <Row label={`SGST @ ${ratePct(inv.sgstPaise, inv.taxablePaise)}%`} value={formatINR(inv.sgstPaise)} />
            </>
          ) : inv.igstPaise > 0 ? (
            <Row label={`IGST @ ${ratePct(inv.igstPaise, inv.taxablePaise)}%`} value={formatINR(inv.igstPaise)} />
          ) : null}
          <div className="border-t border-slate-200 pt-1.5">
            <Row label="Total" value={formatINR(inv.totalPaise)} strong />
          </div>
        </div>

        <p className="mt-4 text-xs text-slate-600">{rupeesInWords(inv.totalPaise)}</p>

        <div className="mt-6 space-y-1 border-t border-slate-200 pt-4 text-xs text-slate-500">
          <p>
            {inv.refunded ? 'Refunded — a credit note will follow. ' : 'Paid in full'}
            {inv.reference ? ` · Payment reference ${inv.reference}` : ''}
            {inv.paymentMethod ? ` · ${inv.paymentMethod}` : ''}
          </p>
          {!inv.isTaxInvoice && (
            <p>The supplier&apos;s GSTIN was not configured when this was issued, so this is a receipt and not a tax invoice.</p>
          )}
          <p>This is a computer-generated document and does not need a signature.</p>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex justify-between gap-4 ${strong ? 'font-semibold' : ''}`}>
      <span className={strong ? '' : 'text-slate-600'}>{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}
