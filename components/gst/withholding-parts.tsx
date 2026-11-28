'use client';

// What the GSTR-7 and GSTR-8 screens share: the card shown while the role is
// off, the tax payable and paid with its payment (tables 5 and 8), interest
// and late fee (table 6), and the tie-out to the payable account. Both returns
// are paid from the electronic cash ledger only — withheld tax belongs to the
// supplier, so no input credit can settle it — which is why the payment here is
// a plain challan with no set-off.

import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { CheckCircle2, Landmark, Loader2, ShieldOff, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Field, MoneyInput } from '@/components/shared/form-bits';
import { Money } from '@/components/shared/money';
import { RowActions, useConfirmDelete } from '@/components/shared/row-actions';
import {
  ApiError, withholding, type WithholdingHeadsRow, type WithholdingInterest, type WithholdingPaymentRow,
} from '@/lib/api/client';
import { useAppStore } from '@/lib/store';
import { cn } from '@/lib/utils';

export const th = 'px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground';
export const td = 'px-3 py-2 text-right tabular-nums';
export const headsSum = (h: WithholdingHeadsRow) => h.igstPaise + h.cgstPaise + h.sgstPaise;
export const shortDate = (iso: string | null | undefined) =>
  iso ? new Date(`${iso.slice(0, 10)}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
export const localMonth = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};
export const localDay = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const err = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : String(e));

/** A titled table card, as the GSTR-3B screen lays the form out. */
export function TableCard({ title, hint, slot, children, actions }: { title: string; hint?: ReactNode; slot?: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <Card className="overflow-hidden p-0" data-slot={slot}>
      <div className="flex flex-wrap items-start gap-2 border-b bg-muted/30 px-4 py-2.5">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">{title}</h3>
          {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
        </div>
        {actions}
      </div>
      <div className="overflow-x-auto thin-scroll">{children}</div>
    </Card>
  );
}

/** The role is off: say what it is and where it is turned on, never a blank page. */
export function RoleOffCard({ title, what, who, slot }: { title: string; what: string; who: string; slot: string }) {
  return (
    <Card className="flex flex-wrap items-start gap-4 p-6" data-slot={slot}>
      <ShieldOff className="mt-0.5 size-6 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1 space-y-2">
        <p className="text-base font-semibold">{title}</p>
        <p className="max-w-3xl text-sm text-muted-foreground">{what}</p>
        <p className="max-w-3xl text-sm text-muted-foreground">{who}</p>
        <Button asChild size="sm" className="mt-1" data-slot={`${slot}-turn-on`}>
          <Link href="/settings?tab=statutory">Turn it on in Settings → Statutory</Link>
        </Button>
      </div>
    </Card>
  );
}

/** Tables 5 and 8: tax payable and paid, with the payment from the cash ledger. */
export function PaymentCard({ returnType, month, label, payable, paid, balance, payment, interest, filed, slot, onDone }: {
  returnType: 'GSTR7' | 'GSTR8'; month: string; label: string;
  payable: WithholdingHeadsRow; paid: WithholdingHeadsRow; balance: WithholdingHeadsRow; payment: WithholdingPaymentRow | null;
  interest: WithholdingInterest; filed: boolean; slot: string; onDone: () => void;
}) {
  const [open, setOpen] = useState<'new' | 'edit' | null>(null);
  const del = useConfirmDelete();
  const what = returnType === 'GSTR7' ? 'TDS' : 'TCS';
  const rows: [string, keyof WithholdingHeadsRow][] = [['Integrated tax', 'igstPaise'], ['Central tax', 'cgstPaise'], ['State/UT tax', 'sgstPaise']];
  return (
    <TableCard slot={slot} title={`5. ${what} payable and paid · 8. Debit entries in the electronic cash ledger`}
      hint={`Withheld tax is paid from the cash ledger only: no input credit can settle it (section 49). Due with the return, by ${shortDate(interest.dueDate)}.`}
      actions={!payment && !filed && headsSum(payable) > 0 ? (
        <Button size="sm" className="gap-1.5" onClick={() => setOpen('new')} data-slot={`${slot}-pay`}><Landmark className="size-3.5" /> Record payment</Button>
      ) : null}>
      <table className="w-full min-w-[640px] text-sm">
        <thead>
          <tr className="border-b">
            <th className={cn(th, 'text-left')}>Description</th>
            <th className={cn(th, 'text-right')}>{what} payable</th>
            <th className={cn(th, 'text-right')}>Paid in cash</th>
            <th className={cn(th, 'text-right')}>Still to pay</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([l, k]) => (
            <tr key={k} className="border-b last:border-0">
              <td className="px-3 py-2">{l}</td>
              <td className={td}><Money value={payable[k]} /></td>
              <td className={td}><Money value={paid[k]} /></td>
              <td className={cn(td, balance[k] > 0 && 'font-semibold text-amber-700')}><Money value={balance[k]} /></td>
            </tr>
          ))}
          <tr className="border-t-2 bg-muted/40 font-semibold">
            <td className="px-3 py-2">Total</td>
            <td className={td}><Money value={headsSum(payable)} /></td>
            <td className={td} data-slot={`${slot}-paid`}><Money value={headsSum(paid)} /></td>
            <td className={td} data-slot={`${slot}-balance`}><Money value={headsSum(balance)} /></td>
          </tr>
        </tbody>
      </table>
      <div className="border-t px-4 py-3 text-sm">
        {payment ? (
          <div className="flex flex-wrap items-center gap-3" data-slot={`${slot}-payment`}>
            <CheckCircle2 className="size-4 text-emerald-600" />
            <span>
              Paid <b><Money value={payment.totalPaise} /></b> on {shortDate(payment.paidOn)}
              {payment.cpin && <> · CPIN <span className="font-mono">{payment.cpin}</span></>}
              {payment.bankName && <span className="text-muted-foreground"> · from {payment.bankName}</span>}
              {(payment.interestPaise + payment.lateFeePaise) > 0 && <span className="text-muted-foreground"> · incl. interest and late fee <Money value={payment.interestPaise + payment.lateFeePaise} /></span>}
            </span>
            {!filed && (
              <RowActions className="ml-auto" onEdit={() => setOpen('edit')} onDelete={() => del.ask({ reasonRequired: true,
                title: `Delete the ${label} payment?`,
                description: 'Its entry is reversed, so the tax shows as owed again. Nothing changes on the GST portal.',
                run: (reason) => withholding.deletePayment(payment.id, reason), done: 'Payment deleted', onDone,
              })} />
            )}
          </div>
        ) : headsSum(payable) > 0 ? (
          <p className="text-muted-foreground">Not paid yet. Pay it on gst.gov.in (Services → Payments → Create challan) or through your bank, then record it here with the CPIN.</p>
        ) : (
          <p className="text-muted-foreground">Nothing withheld this month, so nothing to pay.</p>
        )}
      </div>
      {open && (
        <PaymentDialog returnType={returnType} month={month} label={label} interest={interest}
          payment={open === 'edit' ? payment : null} suggested={open === 'edit' && payment ? payment : balance}
          onClose={() => setOpen(null)} onDone={() => { setOpen(null); onDone(); }} slot={slot} />
      )}
      {del.dialog}
    </TableCard>
  );
}

function PaymentDialog({ returnType, month, label, interest, payment, suggested, onClose, onDone, slot }: {
  returnType: 'GSTR7' | 'GSTR8'; month: string; label: string; interest: WithholdingInterest;
  payment: WithholdingPaymentRow | null; suggested: WithholdingHeadsRow; onClose: () => void; onDone: () => void; slot: string;
}) {
  const banks = useAppStore((s) => s.bankAccounts).filter((b) => !b.isArchived && b.kind !== 'card');
  const [f, setF] = useState({
    paidOn: payment?.paidOn ?? localDay(), cpin: payment?.cpin ?? '', bankAccountId: payment?.bankAccountId ?? banks[0]?.id ?? '',
    igstPaise: Math.max(0, suggested.igstPaise), cgstPaise: Math.max(0, suggested.cgstPaise), sgstPaise: Math.max(0, suggested.sgstPaise),
    interestPaise: payment?.interestPaise ?? headsSum(interest.interest),
    lateFeePaise: payment?.lateFeePaise ?? interest.lateFee.cgstPaise + interest.lateFee.sgstPaise,
    notes: payment?.notes ?? '',
  });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const b = { returnType, period: month, ...f, cpin: f.cpin.trim() || null, notes: f.notes.trim() || null };
      if (payment) await withholding.updatePayment(payment.id, b);
      else await withholding.pay(b);
      toast.success(payment ? 'Payment saved' : `${label} payment recorded`, { description: 'Posted: Dr the payable, Cr the bank.' });
      onDone();
    } catch (e) {
      setProblem(err(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg" data-slot={`${slot}-pay-dialog`}>
        <DialogHeader>
          <DialogTitle>{payment ? 'Edit the payment' : `Record the ${label} payment`}</DialogTitle>
          <DialogDescription>The tax withheld in the month, paid from the electronic cash ledger. Interest and late fee go to Interest and Penalties.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Paid on" required><Input type="date" value={f.paidOn} onChange={(e) => setF({ ...f, paidOn: e.target.value })} data-slot={`${slot}-pay-date`} /></Field>
          <Field label="CPIN or CIN" hint="As printed on the challan"><Input value={f.cpin} onChange={(e) => setF({ ...f, cpin: e.target.value.toUpperCase() })} className="font-mono" maxLength={20} data-slot={`${slot}-pay-cpin`} /></Field>
          <Field label="Paid from" required className="sm:col-span-2">
            <Select value={f.bankAccountId} onValueChange={(v) => setF({ ...f, bankAccountId: String(v) })}>
              <SelectTrigger data-slot={`${slot}-pay-bank`}><SelectValue placeholder="Bank account" /></SelectTrigger>
              <SelectContent>{banks.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <Field label="IGST"><MoneyInput valuePaise={f.igstPaise} onChangePaise={(v) => setF({ ...f, igstPaise: v })} /></Field>
          <Field label="CGST"><MoneyInput valuePaise={f.cgstPaise} onChangePaise={(v) => setF({ ...f, cgstPaise: v })} /></Field>
          <Field label="SGST / UTGST"><MoneyInput valuePaise={f.sgstPaise} onChangePaise={(v) => setF({ ...f, sgstPaise: v })} /></Field>
          <Field label="Interest"><MoneyInput valuePaise={f.interestPaise} onChangePaise={(v) => setF({ ...f, interestPaise: v })} /></Field>
          <Field label="Late fee"><MoneyInput valuePaise={f.lateFeePaise} onChangePaise={(v) => setF({ ...f, lateFeePaise: v })} /></Field>
          <Field label="Notes"><Input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} maxLength={300} /></Field>
        </div>
        {problem && <p className="rounded-md border border-destructive/30 bg-destructive/5 p-2.5 text-xs text-destructive" data-slot={`${slot}-pay-error`}>{problem}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={() => void save()} disabled={busy || !f.paidOn || !f.bankAccountId} data-slot={`${slot}-pay-save`}>
            {busy && <Loader2 className="size-3.5 animate-spin" />} {payment ? 'Save' : 'Record payment'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Table 6: interest and late fee, as they stand. */
export function InterestCard({ interest, slot }: { interest: WithholdingInterest; slot: string }) {
  return (
    <TableCard slot={slot} title="6. Interest and late fee" hint={interest.basis}>
      <table className="w-full min-w-[560px] text-sm">
        <thead>
          <tr className="border-b">
            <th className={cn(th, 'text-left')}>Description</th>
            <th className={cn(th, 'text-right')}>Integrated tax</th>
            <th className={cn(th, 'text-right')}>Central tax</th>
            <th className={cn(th, 'text-right')}>State/UT tax</th>
          </tr>
        </thead>
        <tbody>
          <tr className="border-b">
            <td className="px-3 py-2">Interest (section 50, 18% a year)</td>
            <td className={td}><Money value={interest.interest.igstPaise} /></td>
            <td className={td}><Money value={interest.interest.cgstPaise} /></td>
            <td className={td}><Money value={interest.interest.sgstPaise} /></td>
          </tr>
          <tr>
            <td className="px-3 py-2">Late fee (section 47)</td>
            <td className={td}><span className="text-muted-foreground/50">—</span></td>
            <td className={td}><Money value={interest.lateFee.cgstPaise} /></td>
            <td className={td}><Money value={interest.lateFee.sgstPaise} /></td>
          </tr>
        </tbody>
      </table>
    </TableCard>
  );
}

/** The return set against the payable account in the ledger, to the paisa. */
export function TieOutCard({ slot, account, ledgerPaise, returnPaise, differencePaise, otherPaise, paymentsPaise, closingPaise, month }: {
  slot: string; account: string; ledgerPaise: number; returnPaise: number; differencePaise: number; otherPaise: number;
  paymentsPaise: number; closingPaise: number; month: string;
}) {
  const ok = differencePaise === 0;
  return (
    <Card className={cn('p-4', ok ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-amber-500/40 bg-amber-500/5')} data-slot={slot} data-difference={differencePaise}>
      <div className="flex flex-wrap items-center gap-2">
        {ok ? <CheckCircle2 className="size-4 text-emerald-600" /> : <TriangleAlert className="size-4 text-amber-600" />}
        <p className="text-sm font-semibold">Ties to the ledger: {account}</p>
        <span className="text-xs text-muted-foreground">{ok ? 'The return and the books agree to the paisa.' : 'The return and the books differ.'}</span>
      </div>
      <div className="mt-3 grid gap-3 text-sm sm:grid-cols-3 lg:grid-cols-6">
        <div><p className="micro-label">In the books this month</p><Money value={ledgerPaise} className="font-semibold" /></div>
        <div><p className="micro-label">In the return</p><Money value={returnPaise} className="font-semibold" /></div>
        <div><p className="micro-label">Difference</p><Money value={differencePaise} className={cn('font-semibold', !ok && 'text-amber-700')} /></div>
        <div><p className="micro-label">Other entries on it</p><Money value={otherPaise} /></div>
        <div><p className="micro-label">Paid over this month</p><Money value={paymentsPaise} /></div>
        <div><p className="micro-label">Balance at {month} end</p><Money value={closingPaise} /></div>
      </div>
    </Card>
  );
}
