'use client';

// Zoho Books' "Print Delivery Note" and "Print Packing Slip" on an invoice:
// the same goods without their prices. A delivery note goes with the goods
// and comes back signed by whoever received them; a packing slip goes inside
// the parcel and lists what was packed, for the person opening it to check.
// Neither is a tax invoice, so neither shows rates, tax or totals.

import { useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { Printer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { stateName } from '@/lib/tax/gst';
import { useDocumentTitle } from '@/lib/use-document-title';
import type { InvoiceDetail } from '@/lib/api/client';

export type PackingKind = 'delivery-note' | 'packing-slip';
export const PACKING_TITLE: Record<PackingKind, string> = { 'delivery-note': 'Delivery Note', 'packing-slip': 'Packing Slip' };

const day = (s: string) => new Date(`${s.slice(0, 10)}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
const lines = (...parts: (string | null | undefined)[]) => parts.filter(Boolean).join(', ');

export function PackingPrint({ inv, kind }: { inv: InvoiceDetail; kind: PackingKind }) {
  const title = PACKING_TITLE[kind];
  useDocumentTitle(`${title} ${inv.number}`);
  const auto = useSearchParams().get('print') === '1';
  useEffect(() => {
    if (!auto) return;
    const t = setTimeout(() => window.print(), 400);
    return () => clearTimeout(t);
  }, [auto]);
  const qty = inv.lines.reduce((t, l) => t + l.qty, 0);
  const ship = inv.shipTo
    ? lines(inv.shipTo.address, inv.shipTo.city, inv.shipTo.pincode)
    : lines(inv.buyer.address, inv.buyer.city, inv.buyer.pincode, stateName(inv.buyer.stateCode));

  return (
    <div className="mx-auto max-w-[820px] space-y-4" data-slot="packing-print" data-kind={kind}>
      <div className="no-print flex items-center justify-between">
        <p className="text-[13px] text-muted-foreground">{title} for {inv.number}: the goods without their prices.</p>
        <Button size="sm" onClick={() => window.print()}><Printer className="size-3.5" /> Print</Button>
      </div>
      <article className="space-y-6 border bg-white p-10 text-[12px] text-[#21263c] print:border-0 print:p-0">
        <header className="flex items-start justify-between gap-6">
          <div className="space-y-0.5">
            {inv.seller.logoUrl && <img src={inv.seller.logoUrl} alt="" className="mb-2 max-h-14 max-w-48 object-contain" />}
            <p className="text-[14px] font-semibold">{inv.seller.tradeName || inv.seller.name}</p>
            <p>{lines(inv.seller.address, inv.seller.city, inv.seller.pincode, stateName(inv.seller.stateCode))}</p>
            {inv.seller.gstin && <p>GSTIN {inv.seller.gstin}</p>}
          </div>
          <div className="text-right">
            <h1 className="text-[22px] font-semibold uppercase tracking-wide">{title}</h1>
            <table className="ml-auto mt-2 text-[12px]">
              <tbody>
                <tr><td className="pr-3 text-muted-foreground">{kind === 'delivery-note' ? 'Delivery Note#' : 'Packing Slip#'}</td><td className="font-medium">{inv.number}</td></tr>
                <tr><td className="pr-3 text-muted-foreground">Invoice#</td><td>{inv.number}</td></tr>
                <tr><td className="pr-3 text-muted-foreground">Date</td><td>{day(inv.date)}</td></tr>
                {inv.orderNumber && <tr><td className="pr-3 text-muted-foreground">Order Number</td><td>{inv.orderNumber}</td></tr>}
                {inv.ewayBill && <tr><td className="pr-3 text-muted-foreground">e-Way Bill#</td><td>{inv.ewayBill.number}</td></tr>}
              </tbody>
            </table>
          </div>
        </header>

        <section className="grid grid-cols-2 gap-6">
          <div>
            <p className="mb-1 text-[11px] font-semibold uppercase text-muted-foreground">Bill To</p>
            <p className="font-medium">{inv.buyer.name}</p>
            <p>{lines(inv.buyer.address, inv.buyer.city, inv.buyer.pincode, stateName(inv.buyer.stateCode))}</p>
            {inv.buyer.gstin && <p>GSTIN {inv.buyer.gstin}</p>}
          </div>
          <div>
            <p className="mb-1 text-[11px] font-semibold uppercase text-muted-foreground">Ship To</p>
            <p className="font-medium">{inv.buyer.name}</p>
            <p>{ship}</p>
          </div>
        </section>

        <table className="w-full border-collapse text-[12px]" data-slot="packing-lines">
          <thead>
            <tr className="bg-[#21263c] text-left text-white">
              <th className="w-10 px-2 py-1.5">#</th>
              <th className="px-2 py-1.5">Item &amp; Description</th>
              <th className="w-28 px-2 py-1.5">HSN/SAC</th>
              <th className="w-28 px-2 py-1.5 text-right">Qty</th>
              {kind === 'packing-slip' && <th className="w-20 px-2 py-1.5 text-center">Packed</th>}
            </tr>
          </thead>
          <tbody>
            {inv.lines.map((l, i) => (
              <tr key={l.id} className="border-b">
                <td className="px-2 py-1.5 align-top">{i + 1}</td>
                <td className="px-2 py-1.5 align-top">
                  <p className="font-medium">{l.itemName || l.description}</p>
                  {l.itemName && l.description && l.description !== l.itemName && <p className="text-muted-foreground">{l.description}</p>}
                </td>
                <td className="px-2 py-1.5 align-top">{l.hsnSac}</td>
                <td className="px-2 py-1.5 text-right align-top">{l.qty} {l.uqc ?? ''}</td>
                {kind === 'packing-slip' && <td className="px-2 py-1.5 text-center align-top">☐</td>}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr><td /><td className="px-2 py-1.5 text-right font-medium" colSpan={2}>Total Quantity</td><td className="px-2 py-1.5 text-right font-medium">{qty}</td>{kind === 'packing-slip' && <td />}</tr>
          </tfoot>
        </table>

        {inv.notes && <p className="whitespace-pre-line"><span className="text-muted-foreground">Notes: </span>{inv.notes}</p>}

        <footer className="grid grid-cols-2 gap-10 pt-10 text-[12px]">
          {kind === 'delivery-note' ? (
            <>
              <div className="border-t pt-1.5">Received the above goods in good condition<br /><span className="text-muted-foreground">Receiver&apos;s signature, name and date</span></div>
              <div className="border-t pt-1.5 text-right">For {inv.seller.tradeName || inv.seller.name}<br /><span className="text-muted-foreground">Authorised signatory</span></div>
            </>
          ) : (
            <>
              <div className="border-t pt-1.5">Packed by<br /><span className="text-muted-foreground">Name and date</span></div>
              <div className="border-t pt-1.5 text-right">Checked by<br /><span className="text-muted-foreground">Name and date</span></div>
            </>
          )}
        </footer>
      </article>
    </div>
  );
}
