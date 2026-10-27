'use client';

// The self-invoice for a reverse-charge purchase from a supplier who is not
// registered (CGST Act s.31(3)(f); Rule 47A, within 30 days of the supply).
// The buyer issues it to itself, from its own series, showing the tax it owes
// on the supply; it is printed and kept with the supplier's bill.

import Link from 'next/link';
import { use } from 'react';
import { ArrowLeft, Printer } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { AsyncPage, LoadingRows } from '@/components/shared/async-state';
import { useSession } from '@/components/layout/session-provider';
import { bills as billApi, type BillDetail } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { formatINR } from '@/lib/money';
import { rupeesInWords } from '@/lib/billing/words';
import { stateName, stateTaxLabel } from '@/lib/tax/gst';
import { cn } from '@/lib/utils';
import { printPage } from '@/lib/output-guard';

const day = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

export default function SelfInvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const state = useApi<BillDetail>(() => billApi.get(id), [id]);
  const session = useSession();
  return (
    <AsyncPage state={state} loading={<LoadingRows rows={8} />}>
      {(bill) => {
        if (!bill.selfInvoiceNo) {
          return <p className="text-sm text-muted-foreground">This bill needs no self-invoice: it is not under reverse charge from an unregistered supplier.</p>;
        }
        const tax = bill.tax.cgstPaise + bill.tax.sgstPaise + bill.tax.igstPaise + bill.tax.cessPaise;
        const split = bill.tax.igstPaise === 0;
        return (
          <div className="space-y-4">
            <div className="flex items-center gap-2 no-print">
              <Link href={`/purchases/bills/${bill.id}`} className={cn(buttonVariants({ size: 'sm', variant: 'ghost' }), 'gap-1.5')}><ArrowLeft className="size-3.5" /> Back to the bill</Link>
              <Button size="sm" className="ml-auto gap-1.5" onClick={() => printPage()}><Printer className="size-3.5" /> Print</Button>
            </div>
            <div className="mx-auto max-w-3xl rounded-lg border bg-white p-8 text-[13px] text-slate-900 print:max-w-none print:rounded-none print:border-0 print:p-0">
              <div className="flex items-start justify-between border-b pb-3">
                <div>
                  <p className="text-base font-semibold">{session.org?.name}</p>
                  <p className="text-xs text-slate-500">GSTIN {bill.branch.gstin ?? '—'}</p>
                </div>
                <div className="text-right">
                  <p className="font-semibold">Self-invoice (reverse charge)</p>
                  <p className="text-xs text-slate-500">Section 31(3)(f), CGST Act</p>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-x-8 gap-y-1 border-b py-3 text-xs">
                <span><span className="text-slate-500">Number</span> <span className="font-medium">{bill.selfInvoiceNo}</span></span>
                <span><span className="text-slate-500">Date</span> {day(bill.date)}</span>
                <span><span className="text-slate-500">Supplier</span> {bill.vendor.name} (not registered)</span>
                <span><span className="text-slate-500">Supplier’s bill</span> {bill.vendorInvoiceNo || '—'}</span>
                <span className="col-span-2"><span className="text-slate-500">Supplier’s address</span> {bill.vendor.address ?? '—'}</span>
                <span><span className="text-slate-500">Place of supply</span> {stateName(bill.placeOfSupply)} ({bill.placeOfSupply})</span>
                <span><span className="text-slate-500">Tax payable on reverse charge</span> Yes</span>
              </div>
              <table className="mt-3 w-full text-xs">
                <thead>
                  <tr className="border-b text-left text-slate-500">
                    <th className="py-1.5 font-medium">Description</th><th className="py-1.5 font-medium">HSN/SAC</th>
                    <th className="py-1.5 text-right font-medium">Taxable value</th><th className="py-1.5 text-right font-medium">Rate</th>
                    {split ? <><th className="py-1.5 text-right font-medium">CGST</th><th className="py-1.5 text-right font-medium">{stateTaxLabel(bill.placeOfSupply)}</th></>
                      : <th className="py-1.5 text-right font-medium">IGST</th>}
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {bill.lines.map((l) => (
                    <tr key={l.id}>
                      <td className="py-1.5">{l.description ?? l.accountName}</td>
                      <td className="py-1.5">{l.hsnSac ?? '—'}</td>
                      <td className="py-1.5 text-right tabular-nums">{formatINR(l.taxablePaise)}</td>
                      <td className="py-1.5 text-right">{l.gstRatePct}%</td>
                      {split ? <><td className="py-1.5 text-right tabular-nums">{formatINR(l.cgstPaise)}</td><td className="py-1.5 text-right tabular-nums">{formatINR(l.sgstPaise)}</td></>
                        : <td className="py-1.5 text-right tabular-nums">{formatINR(l.igstPaise)}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="mt-3 ml-auto w-64 space-y-1 text-xs">
                <div className="flex justify-between"><span>Taxable value</span><span className="tabular-nums">{formatINR(bill.subtotalPaise)}</span></div>
                <div className="flex justify-between font-medium"><span>Tax payable by us</span><span className="tabular-nums">{formatINR(tax)}</span></div>
              </div>
              <p className="mt-2 text-xs text-slate-600">Tax in words: {rupeesInWords(tax)}</p>
              <p className="mt-6 text-[11px] text-slate-500">
                Issued by the recipient for a supply received from a person not registered, on which the recipient pays the tax
                under reverse charge. The tax is paid in cash and reported in GSTR-3B table 3.1(d).
              </p>
              <div className="mt-10 text-right text-xs">
                <p>For {session.org?.name}</p>
                <p className="mt-8 text-slate-500">Authorised signatory</p>
              </div>
            </div>
          </div>
        );
      }}
    </AsyncPage>
  );
}
