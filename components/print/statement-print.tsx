'use client';

// A statement of account on paper: the sheet a customer is sent with "please
// confirm the balance", or a vendor's account set out to check against theirs.
// The figures are the screen's (lib/server/reports/party-statement.ts), not
// recomputed, so the PDF and the Statement tab cannot disagree.

import Link from 'next/link';
import { ArrowLeft, Printer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { PartyStatement } from '@/lib/api/client';
import { statementWords } from '@/components/shared/party-statement';
import { stateName } from '@/lib/tax/gst';
import { printPage } from '@/lib/output-guard';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const day = (iso: string) => {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return `${String(d).padStart(2, '0')} ${MONTHS[m - 1]} ${y}`;
};
const amt = (paise: number) =>
  paise ? (paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
/** A balance the other way round reads as a credit, not a minus sign. */
const bal = (paise: number) =>
  `${(Math.abs(paise) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${paise < 0 ? ' Cr' : ''}`;

export function StatementPrint({ s, backHref }: { s: PartyStatement; backHref: string }) {
  const w = statementWords(s.side);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 no-print">
        <Button variant="outline" size="sm" asChild>
          <Link href={backHref}><ArrowLeft className="size-3.5" /> {s.party.name}</Link>
        </Button>
        <Button size="sm" onClick={() => printPage()} data-slot="print-statement">
          <Printer className="size-3.5" /> Print or save as PDF
        </Button>
      </div>

      <article
        className="print-sheet mx-auto max-w-4xl rounded-[3px] border bg-white p-7 text-[12px] leading-snug text-slate-900 shadow-sm dark:bg-white print:max-w-none print:rounded-none print:border-0 print:p-0 print:text-[10.5px] print:shadow-none"
        data-slot="statement-sheet"
      >
        <header className="flex items-start justify-between gap-6 border-b border-slate-300 pb-4">
          <div>
            <p className="text-base font-semibold">{s.org.legalName || s.org.name}</p>
            {s.org.address && <p className="mt-1 whitespace-pre-line text-slate-600">{s.org.address}</p>}
            <p className="mt-1 text-slate-600">
              {[s.org.gstin && `GSTIN ${s.org.gstin}`, s.org.phone, s.org.email].filter(Boolean).join(' · ')}
            </p>
          </div>
          <div className="text-right">
            <h1 className="text-lg font-semibold uppercase tracking-wide">{w.title}</h1>
            <p className="mt-1 text-slate-600">{day(s.from)} to {day(s.to)}</p>
          </div>
        </header>

        <section className="mt-4 grid grid-cols-2 gap-6">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">{s.side === 'customer' ? 'To' : 'Vendor'}</p>
            <p className="mt-1 font-semibold">{s.party.legalName || s.party.name}</p>
            {s.party.address && <p className="whitespace-pre-line text-slate-600">{s.party.address}</p>}
            {s.party.gstin && <p className="text-slate-600">GSTIN {s.party.gstin}</p>}
            {s.party.stateCode && <p className="text-slate-600">{stateName(s.party.stateCode)} ({s.party.stateCode})</p>}
          </div>
          <table className="self-start justify-self-end text-right">
            <tbody>
              <tr><td className="pr-4 text-slate-600">Opening balance</td><td className="tabular-nums">₹{bal(s.openingPaise)}</td></tr>
              <tr><td className="pr-4 text-slate-600">{w.charges}</td><td className="tabular-nums">₹{bal(s.chargesPaise)}</td></tr>
              <tr><td className="pr-4 text-slate-600">{w.payments}</td><td className="tabular-nums">₹{bal(s.paymentsPaise)}</td></tr>
              <tr className="font-semibold"><td className="border-t border-slate-300 pr-4 pt-1">{w.due}</td><td className="border-t border-slate-300 pt-1 tabular-nums">₹{bal(s.closingPaise)}</td></tr>
            </tbody>
          </table>
        </section>

        <table className="mt-5 w-full border-collapse">
          <thead>
            <tr className="border-y border-slate-300 bg-slate-50 text-[10px] uppercase tracking-wide text-slate-600">
              <th className="px-2 py-1.5 text-left font-semibold">Date</th>
              <th className="px-2 py-1.5 text-left font-semibold">Transaction</th>
              <th className="px-2 py-1.5 text-left font-semibold">Details</th>
              <th className="px-2 py-1.5 text-right font-semibold">{w.charges} (₹)</th>
              <th className="px-2 py-1.5 text-right font-semibold">{w.payments} (₹)</th>
              <th className="px-2 py-1.5 text-right font-semibold">Balance (₹)</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-slate-200">
              <td className="px-2 py-1.5 tabular-nums">{day(s.from)}</td>
              <td className="px-2 py-1.5 font-medium" colSpan={4}>Opening balance</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{bal(s.openingPaise)}</td>
            </tr>
            {s.lines.map((l, i) => (
              <tr key={i} className="border-b border-slate-200 break-inside-avoid">
                <td className="px-2 py-1.5 tabular-nums">{day(l.date)}</td>
                <td className="px-2 py-1.5">{l.kind} <span className="font-medium">{l.number}</span></td>
                <td className="px-2 py-1.5 text-slate-600">{l.detail}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{amt(l.chargePaise)}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{amt(l.paymentPaise)}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{bal(l.balancePaise)}</td>
              </tr>
            ))}
            <tr className="border-b-2 border-slate-400 font-semibold">
              <td className="px-2 py-1.5 tabular-nums">{day(s.to)}</td>
              <td className="px-2 py-1.5" colSpan={2}>{w.due}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{amt(s.chargesPaise)}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{amt(s.paymentsPaise)}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{bal(s.closingPaise)}</td>
            </tr>
          </tbody>
        </table>

        {s.side === 'customer' && (
          <p className="mt-5 text-slate-600">
            Please check this statement against your books. If your balance differs, let us know within 15 days with the
            documents that make up the difference; otherwise we will take the balance as confirmed.
          </p>
        )}
        <p className="mt-6 text-right text-slate-600">For {s.org.legalName || s.org.name}</p>
      </article>
    </div>
  );
}
