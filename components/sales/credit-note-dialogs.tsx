'use client';

// A credit note's Refund, Apply to Invoices and Void, each asked in its own
// window, as Zoho Books asks them from the credit note.

import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Field, MoneyInput } from '@/components/shared/form-bits';
import { Money } from '@/components/shared/money';
import { useAppStore } from '@/lib/store';
import { localDay } from '@/lib/selectors';
import { useApi } from '@/lib/api/use-api';
import { invoices as invoicesApi, salesDocuments } from '@/lib/api/client';
import { formatINR } from '@/lib/money';

export interface CreditNoteRef { id: string; number: string; customerId: string; customerName: string; totalPaise: number; appliedPaise: number }

const today = () => localDay(new Date());
const left = (cn: CreditNoteRef) => cn.totalPaise - cn.appliedPaise;
const short = (d: string) => new Date(d).toLocaleDateString('en-IN');

/** Refund: how much, when, and from which account. A part refund leaves the rest on the credit note. */
export function RefundDialog({ cn, onClose, onDone }: { cn: CreditNoteRef; onClose: () => void; onDone: () => void }) {
  const banks = useAppStore((s) => s.bankAccounts);
  const [amount, setAmount] = useState(left(cn));
  const [date, setDate] = useState(today());
  const [bankId, setBankId] = useState(banks.find((b) => b.kind === 'bank')?.id ?? banks[0]?.id ?? '');
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      const r = await salesDocuments.refundCreditNote(cn.id, bankId, date, amount, reference || `Refund against ${cn.number}`);
      toast.success(`${formatINR(r.refundedPaise)} refunded`, { description: 'Cash has left the bank: the one case where a credit note moves money.' });
      onDone();
    } catch (e) {
      toast.error('Not refunded', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent data-slot="cn-refund-dialog">
        <DialogHeader>
          <DialogTitle>Refund {cn.number}</DialogTitle>
          <DialogDescription>{formatINR(left(cn))} is left on this credit note. A part refund leaves the rest to apply or refund later.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Amount" required><MoneyInput valuePaise={amount} onChangePaise={setAmount} /></Field>
          <Field label="Refunded on" required><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          <Field label="Paid through" required>
            <select value={bankId} onChange={(e) => setBankId(e.target.value)} className="h-9 w-full rounded-md border bg-background px-2 text-sm">
              {banks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </Field>
          <Field label="Reference#"><Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder={`Refund against ${cn.number}`} /></Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void go()} disabled={busy || amount <= 0 || amount > left(cn) || !bankId}>Refund</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Zoho's "Apply to Invoices": the customer's open invoices, an amount against each. */
export function ApplyDialog({ cn, onClose, onDone }: { cn: CreditNoteRef; onClose: () => void; onDone: () => void }) {
  const open = useApi(() => invoicesApi.list({ customerId: cn.customerId, open: true, limit: 200 }), [cn.customerId]);
  const [amounts, setAmounts] = useState<Record<string, number>>({});
  const [date, setDate] = useState(today());
  const [busy, setBusy] = useState(false);
  const total = Object.values(amounts).reduce((t, v) => t + v, 0);
  const go = async () => {
    setBusy(true);
    try {
      const r = await salesDocuments.applyCreditNote(cn.id, date, Object.entries(amounts).filter(([, v]) => v > 0).map(([invoiceId, amountPaise]) => ({ invoiceId, amountPaise })));
      toast.success(`${formatINR(r.appliedPaise)} applied from ${cn.number}`);
      onDone();
    } catch (e) {
      toast.error('Not applied', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  const rows = (open.data?.invoices ?? []).filter((i) => i.balancePaise > 0);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl sm:max-w-2xl" data-slot="cn-apply-dialog">
        <DialogHeader>
          <DialogTitle>Apply credits from {cn.number}</DialogTitle>
          <DialogDescription>Credits available: {formatINR(left(cn))}. Set them against {cn.customerName}&apos;s open invoices.</DialogDescription>
        </DialogHeader>
        <div className="max-h-[50vh] overflow-y-auto rounded border thin-scroll">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-muted text-[11px] uppercase text-muted-foreground">
              <tr><th className="px-3 py-2 text-left">Date</th><th className="px-3 py-2 text-left">Invoice#</th><th className="px-3 py-2 text-right">Invoice Amount</th><th className="px-3 py-2 text-right">Invoice Balance</th><th className="w-40 px-3 py-2 text-right">Amount to Credit</th></tr>
            </thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={5} className="px-3 py-4 text-center text-muted-foreground">{open.loading ? 'Loading…' : 'No open invoices for this customer.'}</td></tr>}
              {rows.map((i) => (
                <tr key={i.id} className="border-t">
                  <td className="px-3 py-2">{short(i.date)}</td>
                  <td className="px-3 py-2 font-medium">{i.number}</td>
                  <td className="px-3 py-2 text-right"><Money value={i.totalPaise} /></td>
                  <td className="px-3 py-2 text-right"><Money value={i.balancePaise} /></td>
                  <td className="px-3 py-1.5"><MoneyInput valuePaise={amounts[i.id] ?? 0} onChangePaise={(v) => setAmounts((a) => ({ ...a, [i.id]: Math.min(v, i.balancePaise) }))} className="h-8" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap items-end justify-between gap-3 text-sm">
          <Field label="Applied on"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-40" /></Field>
          <p>Amount to Credit: <b>{formatINR(total)}</b> · Remaining credits: <b className={total > left(cn) ? 'text-destructive' : ''}>{formatINR(left(cn) - total)}</b></p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void go()} disabled={busy || total <= 0 || total > left(cn)}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Void: the entry reversed, every invoice it was applied to owed again. */
export function VoidCreditNoteDialog({ cn, onClose, onDone }: { cn: CreditNoteRef; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      await salesDocuments.voidCreditNote(cn.id, reason.trim());
      toast.success(`${cn.number} voided`, { description: 'Its entry is reversed; any invoice it was set against is owed again.' });
      onDone();
    } catch (e) {
      toast.error('Not voided', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent data-slot="cn-void-dialog">
        <DialogHeader>
          <DialogTitle>Void {cn.number}?</DialogTitle>
          <DialogDescription>The credit note stays in the books, its entry reversed. Any invoice it was applied to is owed again. A refunded credit note cannot be voided.</DialogDescription>
        </DialogHeader>
        <Field label="Reason" required><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Raised in error" /></Field>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button variant="destructive" onClick={() => void go()} disabled={busy || reason.trim().length < 4}>Void</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
