'use client';

// GSTR-3B, the parts beyond the form itself (status review 7, item 11):
//
//  · the payment and set-off of table 6.1 posted to the books (record, Edit,
//    Delete), so the GST ledgers come back to nil for the period;
//  · the return against the values the portal fills in from GSTR-1 and
//    GSTR-2B, row by row, with the reason for any difference;
//  · the return against the general ledger — output tax, reverse charge and
//    input credit — with each difference explained or shown as unexplained.

import Link from 'next/link';
import { useState } from 'react';
import { CheckCircle2, Landmark, Loader2, Scale } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Money } from '@/components/shared/money';
import { EditButton, DeleteButton, useConfirmDelete } from '@/components/shared/row-actions';
import { gstReturns, ApiError, type Gstr3bChecksView, type Gstr3bPaymentView, type Gstr3bSettlementView } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { useAppStore } from '@/lib/store';
import { usePermission } from '@/lib/store/hooks';
import { cn } from '@/lib/utils';

const th = 'px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground';
const td = 'px-3 py-2 text-right tabular-nums';
const HEADS = ['IGST', 'CGST', 'SGST', 'CESS'] as const;
const localDay = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const longDay = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
const taxOf = (h: { igstPaise: number; cgstPaise: number; sgstPaise: number; cessPaise: number }) => h.igstPaise + h.cgstPaise + h.sgstPaise + h.cessPaise;

function SetoffTable({ setoff, cash, interest, lateFee }: { setoff: Gstr3bSettlementView['setoff']; cash: Gstr3bSettlementView['cash']; interest: number; lateFee: number }) {
  return (
    <table className="w-full min-w-[640px] text-sm" data-slot="gstr3b-setoff">
      <thead>
        <tr className="border-b bg-muted/40">
          <th className={`${th} text-left`}>Liability</th>
          {HEADS.map((c) => <th key={c} className={`${th} text-right`}>{c} credit used</th>)}
          <th className={`${th} text-right`}>Cash</th>
        </tr>
      </thead>
      <tbody>
        {HEADS.map((l) => (
          <tr key={l} className="border-b last:border-0">
            <td className="px-3 py-1.5">{l}</td>
            {HEADS.map((c) => <td key={c} className={td}><Money value={setoff[c][l]} showZero={false} /></td>)}
            <td className={`${td} font-medium`}><Money value={cash[l]} /></td>
          </tr>
        ))}
        {interest + lateFee > 0 && (
          <tr className="border-t"><td className="px-3 py-1.5" colSpan={5}>Interest and late fee</td><td className={`${td} font-medium`}><Money value={interest + lateFee} /></td></tr>
        )}
      </tbody>
    </table>
  );
}

function PaymentDialog({ ret, recorded, settlement, onClose, onDone }: {
  ret: string; recorded: Gstr3bPaymentView | null; settlement: Gstr3bSettlementView; onClose: () => void; onDone: () => void;
}) {
  const banks = useAppStore((s) => s.bankAccounts).filter((b) => !b.isArchived && b.kind !== 'card');
  const [paidOn, setPaidOn] = useState(recorded?.paidOn ?? localDay());
  const [cpin, setCpin] = useState(recorded?.cpin ?? '');
  const [bankAccountId, setBank] = useState(recorded?.bankAccountId ?? banks[0]?.id ?? '');
  const [notes, setNotes] = useState(recorded?.notes ?? '');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const b = { period: ret, paidOn, cpin: cpin.trim() || null, bankAccountId: settlement.cashTotalPaise > 0 ? bankAccountId || null : bankAccountId || null, notes: notes.trim() || null };
      if (recorded) await gstReturns.updatePayment(recorded.id, b);
      else await gstReturns.recordPayment(b);
      toast.success(recorded ? 'Payment entry posted again' : 'GSTR-3B payment recorded', { description: 'Posted: Dr output tax and reverse charge, Cr input credit used and the bank.' });
      onDone();
    } catch (e) {
      setProblem(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-w-2xl" data-slot="gstr3b-pay-dialog">
        <DialogHeader>
          <DialogTitle>{recorded ? 'Edit the GSTR-3B payment' : 'Record the GSTR-3B payment and set-off'}: {settlement.label}</DialogTitle>
          <DialogDescription>
            The credit set off and the cash paid, as table 6.1 works them out (s.49(5), Rule 88A). Recording it clears the GST ledgers for the period.
          </DialogDescription>
        </DialogHeader>
        <div className="overflow-x-auto rounded-md border"><SetoffTable setoff={settlement.setoff} cash={settlement.cash} interest={settlement.interestPaise} lateFee={settlement.lateFeePaise} /></div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5"><Label htmlFor="g3p-date">Paid and set off on</Label><Input id="g3p-date" type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} data-slot="gstr3b-pay-date" /></div>
          <div className="space-y-1.5"><Label htmlFor="g3p-cpin">CPIN or CIN</Label><Input id="g3p-cpin" value={cpin} onChange={(e) => setCpin(e.target.value.toUpperCase())} maxLength={20} className="font-mono" placeholder="As on the PMT-06 challan" data-slot="gstr3b-pay-cpin" /></div>
          {settlement.cashTotalPaise > 0 && (
            <div className="space-y-1.5 sm:col-span-2">
              <Label>Cash paid from (<Money value={settlement.cashTotalPaise} />)</Label>
              <Select value={bankAccountId} onValueChange={(v) => setBank(String(v))}>
                <SelectTrigger data-slot="gstr3b-pay-bank"><SelectValue placeholder="Bank account" /></SelectTrigger>
                <SelectContent>{banks.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-1.5 sm:col-span-2"><Label htmlFor="g3p-notes">Notes</Label><Input id="g3p-notes" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={300} /></div>
        </div>
        {problem && <p className="rounded-md border border-destructive/30 bg-destructive/5 p-2.5 text-xs text-destructive" data-slot="gstr3b-pay-error">{problem}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={() => void save()} disabled={busy || !paidOn || (settlement.cashTotalPaise > 0 && !bankAccountId)} data-slot="gstr3b-pay-save">
            {busy && <Loader2 className="size-3.5 animate-spin" />} {recorded ? 'Save' : 'Record payment'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 6.1 in the books: the set-off and the cash, recorded or still to record. */
export function Gstr3bPaymentCard({ ret }: { ret: string }) {
  const state = useApi(() => gstReturns.gstr3bPayment(ret), [ret]);
  const canEdit = usePermission('gst', 'edit');
  const [open, setOpen] = useState(false);
  const del = useConfirmDelete();
  const d = state.data;
  if (!d) return null;
  const r = d.recorded;
  return (
    <Card className="space-y-3 p-4 print:hidden" data-slot="gstr3b-payment">
      <div className="flex flex-wrap items-center gap-2">
        <Landmark className="size-4 text-primary" />
        <p className="text-sm font-semibold">Payment and set-off in the books (6.1)</p>
        <span className="flex-1" />
        {!r && canEdit && !d.settlement.nothingToPay && <Button size="sm" onClick={() => setOpen(true)} data-slot="gstr3b-pay">Record payment</Button>}
        {r && canEdit && (
          <span className="flex gap-1.5">
            <EditButton onClick={() => setOpen(true)} slot="gstr3b-pay-edit" title="Change the date, challan or bank, or post it again as the return now stands" />
            <DeleteButton slot="gstr3b-pay-delete" onClick={() => del.ask({
              title: `Delete the GSTR-3B payment for ${d.settlement.label}?`,
              description: 'Its entry is reversed: the output tax and the credit set off show as open again. Nothing on the GST portal changes.',
              run: (reason) => gstReturns.deletePayment(r.id, reason), done: 'Payment deleted', onDone: () => void state.refetch(),
            })} />
          </span>
        )}
      </div>
      {r ? (
        <div className="space-y-2 text-xs" data-slot="gstr3b-payment-recorded">
          <p>
            Recorded on <b>{longDay(r.paidOn)}</b>{r.cpin ? <> · CPIN <span className="font-mono">{r.cpin}</span></> : null}{r.bankName ? <> · from {r.bankName}</> : null}:
            {' '}credit set off <Money value={r.creditUsedPaise} />, cash <Money value={r.cashTotalPaise} />.
            {r.journalEntryId && <> <Link href={`/accountant/journals/${r.journalEntryId}`} className="text-primary hover:underline">The entry</Link></>}
          </p>
          {r.stale && <p className="rounded border border-amber-500/30 bg-amber-50 px-2 py-1 text-amber-800" data-slot="gstr3b-payment-stale">The return has changed since this was recorded. Edit and save it to post it again as the return now stands.</p>}
        </div>
      ) : d.settlement.nothingToPay ? (
        <p className="text-xs text-muted-foreground">Nothing to pay or set off for this period.</p>
      ) : (
        <p className="text-xs text-muted-foreground">
          To pay: credit set off <Money value={d.settlement.creditUsedPaise} /> and cash <Money value={d.settlement.cashTotalPaise} />. Once paid on the portal, record it here so the GST ledgers come back to nil.
        </p>
      )}
      <div className="overflow-x-auto rounded-md border"><SetoffTable setoff={r?.setoff ?? d.settlement.setoff} cash={r?.cash ?? d.settlement.cash} interest={r?.interestPaise ?? d.settlement.interestPaise} lateFee={r?.lateFeePaise ?? d.settlement.lateFeePaise} /></div>
      {open && <PaymentDialog ret={ret} recorded={r} settlement={d.settlement} onClose={() => setOpen(false)} onDone={() => { setOpen(false); void state.refetch(); }} />}
      {del.dialog}
    </Card>
  );
}

/** Against GSTR-1 and GSTR-2B, and against the ledger. */
export function Gstr3bChecksPanel({ ret }: { ret: string }) {
  const state = useApi<Gstr3bChecksView>(() => gstReturns.gstr3bChecks(ret), [ret]);
  const d = state.data;
  if (!d) return state.loading ? <Card className="p-4 text-xs text-muted-foreground">Comparing with GSTR-1, GSTR-2B and the ledger…</Card> : null;
  return (
    <>
      <Card className="overflow-hidden p-0" data-slot="gstr3b-compare">
        <div className="border-b bg-muted/40 px-4 py-2.5">
          <h3 className="text-sm font-semibold">Values from GSTR-1 and GSTR-2B</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            The portal fills 3.1 and 3.1.1 from this period&apos;s GSTR-1 (amendments included) and 4(A) from GSTR-2B. Each row of this return against those values.
            {!d.twoB.imported && <> No GSTR-2B is held for the period: <Link href="/gst/itc-reconciliation" className="text-primary hover:underline">import it</Link>.</>}
          </p>
        </div>
        <div className="overflow-x-auto thin-scroll">
          <table className="w-full min-w-[900px] text-sm">
            <thead><tr className="border-b">
              <th className={`${th} text-left`}>Row</th><th className={`${th} text-left`}>Source</th>
              <th className={`${th} text-right`}>Value from source</th><th className={`${th} text-right`}>Tax from source</th>
              <th className={`${th} text-right`}>Value in return</th><th className={`${th} text-right`}>Tax in return</th>
              <th className={`${th} text-right`}>Difference (tax)</th>
            </tr></thead>
            <tbody>
              {d.compare.map((c) => {
                const diff = taxOf(c.difference);
                return (
                  <tr key={c.key} className="border-b align-top last:border-0" data-slot={`gstr3b-compare-${c.key}`}>
                    <td className="px-3 py-2">{c.label}{c.reasons.length > 0 && <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[11px] text-muted-foreground">{c.reasons.map((x) => <li key={x}>{x}</li>)}</ul>}</td>
                    <td className="px-3 py-2 text-xs">{c.source}</td>
                    <td className={td}><Money value={c.fromSource.taxablePaise} /></td>
                    <td className={td}><Money value={taxOf(c.fromSource)} /></td>
                    <td className={td}><Money value={c.inReturn.taxablePaise} /></td>
                    <td className={td}><Money value={taxOf(c.inReturn)} /></td>
                    <td className={cn(td, diff || c.difference.taxablePaise ? 'text-amber-700' : 'text-emerald-700')}>
                      {diff || c.difference.taxablePaise ? <Money value={diff} /> : <CheckCircle2 className="ml-auto size-4" />}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="overflow-hidden p-0" data-slot="gstr3b-tieout" data-tied={d.tied}>
        <div className="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-4 py-2.5">
          <Scale className="size-4 text-primary" />
          <h3 className="text-sm font-semibold">Tie-out with the general ledger</h3>
          <span className={cn('text-xs font-medium', d.tied ? 'text-emerald-700' : 'text-amber-700')}>{d.tied ? 'Every difference is explained' : 'An unexplained difference remains'}</span>
          <p className="basis-full text-xs text-muted-foreground">Postings to the GST ledgers dated in the period (the tax payment itself left out), against the return&apos;s own figures.</p>
        </div>
        <div className="overflow-x-auto thin-scroll">
          <table className="w-full min-w-[900px] text-sm">
            <thead><tr className="border-b">
              <th className={`${th} text-left`}>Return</th><th className={`${th} text-left`}>Ledger accounts</th>
              <th className={`${th} text-right`}>Ledger</th><th className={`${th} text-right`}>Return</th><th className={`${th} text-right`}>Difference</th><th className={`${th} text-right`}>Unexplained</th>
            </tr></thead>
            <tbody>
              {d.tieOut.map((l) => (
                <tr key={l.key} className="border-b align-top last:border-0" data-slot={`gstr3b-tieout-${l.key}`}>
                  <td className="px-3 py-2">{l.label}
                    {l.explained.length > 0 && <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[11px] text-muted-foreground">{l.explained.map((e) => <li key={e.reason}>{e.reason}: <Money value={e.paise} /></li>)}</ul>}
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{l.accounts}</td>
                  <td className={td}><Money value={l.ledgerPaise} /></td>
                  <td className={td}><Money value={l.returnPaise} /></td>
                  <td className={td}><Money value={l.differencePaise} /></td>
                  <td className={cn(td, l.unexplainedPaise ? 'font-semibold text-destructive' : 'text-emerald-700')}><Money value={l.unexplainedPaise} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
