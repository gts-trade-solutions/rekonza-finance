'use client';

// Form GSTR-7A: the certificate of tax deducted at source (s.51(3), Rule 66(3)).
//
// The portal generates it for each deductee once GSTR-7 is filed and the tax
// paid, and the deductor makes it available to the supplier: it is what lets
// the supplier take the TDS into their electronic cash ledger. This is the same
// certificate laid out from the books — deductor and deductee, the contract,
// what was paid and the tax by head, the month deducted and when it was paid
// over — with the number the portal gave it, entered once it is issued.

import Link from 'next/link';
import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { ArrowLeft, Loader2, Printer } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AsyncPage } from '@/components/shared/async-state';
import { EditButton } from '@/components/shared/row-actions';
import { Field } from '@/components/shared/form-bits';
import { withholding, ApiError, type Gstr7aResponse } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';
import { stateName } from '@/lib/tax/gst';
import { printPage } from '@/lib/output-guard';
import { useDocumentTitle } from '@/lib/use-document-title';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const day = (iso: string | null) => {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return `${String(d).padStart(2, '0')} ${MONTHS[m - 1]} ${y}`;
};
const amt = (paise: number) => (paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function Gstr7aPage() {
  return <Suspense fallback={null}><Certificate /></Suspense>;
}

function Certificate() {
  const params = useSearchParams();
  const period = params.get('period') ?? '';
  const gstin = params.get('gstin') ?? '';
  const state = useApi<Gstr7aResponse>(() => withholding.gstr7a(period, gstin), [period, gstin]);
  const canEdit = usePermission('gst', 'edit');
  const [editing, setEditing] = useState(false);
  useDocumentTitle(state.data ? `GSTR-7A - ${state.data.deductee.legalName} - ${state.data.monthLabel}` : null);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 no-print">
        <Button variant="outline" size="sm" asChild>
          <Link href="/gst/gstr7"><ArrowLeft className="size-3.5" /> GSTR-7</Link>
        </Button>
        <div className="flex gap-2">
          {canEdit && state.data && <EditButton label="Certificate number" title="The number the portal issued" onClick={() => setEditing(true)} slot="gstr7a-edit-number" />}
          <Button size="sm" onClick={() => printPage('GSTR-7A')} data-slot="gstr7a-print"><Printer className="size-3.5" /> Print or save as PDF</Button>
        </div>
      </div>
      <AsyncPage state={state}>
        {(c) => (
          <article className="print-sheet mx-auto max-w-4xl rounded-[3px] border bg-white p-7 text-[12px] leading-snug text-slate-900 shadow-sm dark:bg-white print:max-w-none print:rounded-none print:border-0 print:p-0 print:text-[10.5px] print:shadow-none" data-slot="gstr7a-sheet">
            <header className="border-b border-slate-300 pb-4 text-center">
              <p className="text-[10px] uppercase tracking-wide text-slate-500">Form GSTR-7A · [See rule 66(3)]</p>
              <h1 className="mt-1 text-lg font-semibold uppercase tracking-wide">Tax Deduction at Source Certificate</h1>
              <p className="mt-1 text-slate-600">Under section 51 of the Central Goods and Services Tax Act, 2017</p>
            </header>
            <table className="mt-4 w-full border-collapse text-left">
              <tbody>
                {[
                  ['1. TDS certificate no.', c.certificateNo ?? 'Not issued yet: the portal gives it once GSTR-7 is filed', 'gstr7a-number'],
                  ['2. GSTIN of deductor', c.deductor.gstin ?? '—', 'gstr7a-deductor-gstin'],
                  ['3. Name of deductor', `${c.deductor.legalName}${c.deductor.tradeName ? ` (${c.deductor.tradeName})` : ''}`, ''],
                  ['4. GSTIN of deductee', c.deductee.gstin, 'gstr7a-deductee-gstin'],
                  ['5. (a) Legal name of the deductee', c.deductee.legalName, ''],
                  ['5. (b) Trade name, if any', c.deductee.tradeName ?? '—', ''],
                  ['6. Tax period in which tax deducted and accounted for in GSTR-7', c.monthLabel, ''],
                  ['   Paid to the government', c.paid ? `${day(c.paid.on)}${c.paid.cpin ? ` · CPIN ${c.paid.cpin}` : ''}` : 'Not paid yet', ''],
                  ['   GSTR-7 filed', c.filed ? `${day(c.filed.on)}${c.filed.reference ? ` · ARN ${c.filed.reference}` : ''}` : 'Not filed yet', ''],
                ].map(([k, v, slot]) => (
                  <tr key={k} className="border-b border-slate-200">
                    <td className="w-[45%] py-1.5 pr-4 text-slate-600">{k}</td>
                    <td className="py-1.5 font-medium" data-slot={slot || undefined}>{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {c.deductee.address && <p className="mt-2 text-slate-600">Deductee&apos;s address: {c.deductee.address} · {stateName(c.deductee.stateCode)} ({c.deductee.stateCode})</p>}

            <p className="mt-5 font-semibold">7. Details of supplies</p>
            <table className="mt-2 w-full border-collapse">
              <thead>
                <tr className="border-y border-slate-300 bg-slate-50 text-[10px] uppercase tracking-wide text-slate-600">
                  <th className="px-2 py-1.5 text-left">Date paid / credited</th>
                  <th className="px-2 py-1.5 text-left">Contract / invoice</th>
                  <th className="px-2 py-1.5 text-right">Value of contract</th>
                  <th className="px-2 py-1.5 text-right">Amount paid to deductee on which tax is deducted</th>
                  <th className="px-2 py-1.5 text-right">Integrated tax</th>
                  <th className="px-2 py-1.5 text-right">Central tax</th>
                  <th className="px-2 py-1.5 text-right">State/UT tax</th>
                </tr>
              </thead>
              <tbody>
                {c.lines.map((l) => (
                  <tr key={l.id} className="border-b border-slate-200">
                    <td className="px-2 py-1.5">{day(l.date)}</td>
                    <td className="px-2 py-1.5">{l.contractRef ?? '—'}{l.vendorInvoiceNo && <span className="block text-slate-500">Invoice {l.vendorInvoiceNo}{l.billDate ? ` of ${day(l.billDate)}` : ''}</span>}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{amt(l.contractValuePaise)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{amt(l.taxablePaise)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{amt(l.igstPaise)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{amt(l.cgstPaise)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{amt(l.sgstPaise)}</td>
                  </tr>
                ))}
                <tr className="border-b-2 border-slate-400 font-semibold" data-slot="gstr7a-total" data-tax={c.totals.taxPaise}>
                  <td className="px-2 py-1.5" colSpan={3}>Total</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{amt(c.totals.taxablePaise)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{amt(c.totals.igstPaise)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{amt(c.totals.cgstPaise)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{amt(c.totals.sgstPaise)}</td>
                </tr>
              </tbody>
            </table>
            <p className="mt-4 text-slate-600">Tax deducted in all: ₹{amt(c.totals.taxPaise)}. The deductee accepts it on the portal (Services → Ledgers → TDS/TCS credit received) to take it into their electronic cash ledger.</p>
            <footer className="mt-10 flex justify-end">
              <div className="text-center">
                <div className="h-10 w-56 border-b border-slate-400" />
                <p className="mt-1 text-slate-600">Signature of the deductor or authorised signatory</p>
              </div>
            </footer>
          </article>
        )}
      </AsyncPage>
      {editing && state.data && (
        <NumberDialog period={period} gstin={gstin} current={state.data.certificateNo} onClose={() => setEditing(false)} onDone={() => { setEditing(false); state.refetch(); }} />
      )}
    </div>
  );
}

function NumberDialog({ period, gstin, current, onClose, onDone }: { period: string; gstin: string; current: string | null; onClose: () => void; onDone: () => void }) {
  const [no, setNo] = useState(current ?? '');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await withholding.setCertificate(period, gstin, no.trim() || null);
      toast.success(no.trim() ? 'Certificate number saved' : 'Certificate number cleared');
      onDone();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Not saved');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>GSTR-7A certificate number</DialogTitle>
          <DialogDescription>As the portal shows it on the certificate it generated. Clear it to remove.</DialogDescription>
        </DialogHeader>
        <Field label="Certificate no."><Input value={no} onChange={(e) => setNo(e.target.value.toUpperCase())} className="font-mono" maxLength={30} data-slot="gstr7a-number-input" /></Field>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={() => void save()} disabled={busy} data-slot="gstr7a-number-save">{busy && <Loader2 className="size-3.5 animate-spin" />} Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
