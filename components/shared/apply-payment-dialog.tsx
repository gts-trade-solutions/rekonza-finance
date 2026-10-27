'use client';

// Money on account, set against the invoices (or bills) raised since.
//
// Shows what the payment has already been applied to, with a way to undo a
// mistaken application, and the party's open documents to apply the rest to.
// Nothing here posts the money again: applying it says which document it was
// for. Only GST on an advance for services moves, and the server does that.

import { useMemo, useState } from 'react';
import { Loader2, Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Money } from '@/components/shared/money';
import { MoneyInput } from '@/components/shared/form-bits';
import {
  bills as billApi, invoices as invoiceApi, openingBalances, payments as paymentApi, type PaymentDetail,
} from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';
import { today } from '@/lib/selectors';

interface OpenDoc {
  key: string; targetType: 'invoice' | 'bill' | 'opening'; id: string; number: string;
  date: string; dueDate: string; balancePaise: number;
}

const d = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

export function ApplyPaymentDialog({
  paymentId, canEdit, onClose, onChanged,
}: {
  paymentId: string | null;
  canEdit: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  return (
    <Dialog open={!!paymentId} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        {paymentId && <Body paymentId={paymentId} canEdit={canEdit} onChanged={onChanged} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

function Body({ paymentId, canEdit, onChanged, onClose }: {
  paymentId: string; canEdit: boolean; onChanged: () => void; onClose: () => void;
}) {
  const detail = useApi<PaymentDetail>(() => paymentApi.get(paymentId), [paymentId]);
  const p = detail.data;
  const isReceipt = p?.kind === 'received';
  const canVoid = usePermission(isReceipt ? 'sales' : 'purchases', 'void');

  const open = useApi<OpenDoc[]>(async () => {
    if (!p) return [];
    // Bills from before the books started are paid off the same way.
    const openings = (await openingBalances.documents({
      contactId: p.contactId, kind: p.kind === 'received' ? 'receivable' : 'payable', open: true,
    })).documents.map((o): OpenDoc => ({
      key: `opening:${o.id}`, targetType: 'opening', id: o.id, number: `Opening ${o.refNo}`,
      date: o.docDate, dueDate: o.dueDate, balancePaise: o.balancePaise,
    }));
    if (p.kind === 'received') {
      const r = await invoiceApi.list({ customerId: p.contactId, open: true, limit: 200 });
      return [...openings, ...r.invoices.map((i): OpenDoc => ({
        key: `invoice:${i.id}`, targetType: 'invoice', id: i.id, number: i.number, date: i.date, dueDate: i.dueDate, balancePaise: i.balancePaise,
      }))];
    }
    const r = await billApi.list({ vendorId: p.contactId, open: true, limit: 200 });
    return [...openings, ...r.bills.map((b): OpenDoc => ({
      key: `bill:${b.id}`, targetType: 'bill', id: b.id, number: b.vendorInvoiceNo || b.internalNo, date: b.date, dueDate: b.dueDate, balancePaise: b.balancePaise,
    }))];
  }, [p?.id, p?.kind, p?.contactId]);
  const docs = useMemo(() => [...(open.data ?? [])].sort((a, b) => a.dueDate.localeCompare(b.dueDate)), [open.data]);

  const [date, setDate] = useState(today());
  const [picked, setPicked] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const applying = Object.values(picked).reduce((t, v) => t + v, 0);
  const left = (p?.unappliedPaise ?? 0) - applying;

  const toggle = (doc: OpenDoc) => setPicked((sel) => {
    const next = { ...sel };
    if (next[doc.key] != null) delete next[doc.key];
    else next[doc.key] = Math.min(doc.balancePaise, Math.max(0, (p?.unappliedPaise ?? 0) - applying));
    return next;
  });

  const refresh = async () => {
    setPicked({});
    await Promise.all([detail.refetch(), open.refetch()]);
    onChanged();
  };

  const apply = async () => {
    if (!p) return;
    const allocations = Object.entries(picked).filter(([, v]) => v > 0).map(([key, amountPaise]) => {
      const [targetType, targetId] = key.split(':') as ['invoice' | 'bill' | 'opening', string];
      return { targetType, targetId, amountPaise };
    });
    if (!allocations.length) return;
    setBusy(true);
    try {
      const r = await paymentApi.apply(p.id, date, allocations);
      toast.success(`Applied. ${r.unappliedPaise > 0 ? `${(r.unappliedPaise / 100).toFixed(2)} still on account.` : 'Nothing left on account.'}`);
      await refresh();
      if (r.unappliedPaise <= 0) onClose();
    } catch (e) {
      toast.error('Could not apply it', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const undo = async (allocationId: string, number: string) => {
    if (!window.confirm(`Undo the amount applied to ${number}? It goes back to being owed, and the money back on account.`)) return;
    try {
      await paymentApi.unapply(allocationId);
      toast.success(`Undone. ${number} is open again.`);
      await refresh();
    } catch (e) {
      toast.error('Could not undo it', { description: e instanceof Error ? e.message : String(e) });
    }
  };

  const voidIt = async () => {
    if (!p) return;
    const reason = window.prompt(
      `Void ${p.number}? Its entry is reversed and every ${isReceipt ? 'invoice' : 'bill'} it settled is owed again. ` +
        'The number stays, marked void. Give a reason.',
    );
    if (reason === null) return;
    try {
      await paymentApi.void(p.id, reason);
      toast.success(`${p.number} voided`);
      await refresh();
    } catch (e) {
      toast.error('Could not void it', { description: e instanceof Error ? e.message : String(e) });
    }
  };

  if (!p) {
    return <p className="py-6 text-sm text-muted-foreground">{detail.error ?? 'Loading…'}</p>;
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{p.number} · {p.contactName}</DialogTitle>
        <DialogDescription>
          {isReceipt ? 'Received' : 'Paid'} <Money value={p.amountPaise} /> on {d(p.date)}.{' '}
          {p.unappliedPaise > 0
            ? <><Money value={p.unappliedPaise} className="font-medium text-foreground" /> is on account.</>
            : 'All of it has been applied.'}
          {p.advanceGst && (
            <> It was an advance for services at {p.advanceGst.ratePct}% GST; the GST on each part applied is taken back on the day it is applied.</>
          )}
        </DialogDescription>
      </DialogHeader>

      {p.allocations.length > 0 && (
        <div>
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Applied to</p>
          <ul className="divide-y rounded-md border">
            {p.allocations.map((a) => (
              <li key={a.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate font-medium">{a.number}</span>
                <span className="text-xs text-muted-foreground">{a.appliedOn ? d(a.appliedOn) : ''}</span>
                <Money value={a.amountPaise} />
                {canEdit && p.status !== 'void' && (
                  <Button size="icon" variant="ghost" className="size-7" aria-label={`Undo ${a.number}`} onClick={() => void undo(a.id, a.number)}>
                    <Undo2 className="size-3.5" />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {canEdit && p.status !== 'void' && p.unappliedPaise > 0 && (
        <div className="space-y-3">
          <div className="flex items-end justify-between gap-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Open {isReceipt ? 'invoices' : 'bills'}
            </p>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              Applied on
              <Input type="date" value={date} min={p.date} onChange={(e) => setDate(e.target.value)} className="h-8 w-40" />
            </label>
          </div>
          {docs.length === 0 ? (
            <p className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
              {open.loading ? 'Loading…' : `Nothing open for ${p.contactName}. Raise the ${isReceipt ? 'invoice' : 'bill'} first.`}
            </p>
          ) : (
            <div className="max-h-72 overflow-y-auto rounded-md border thin-scroll">
              <table className="w-full text-sm">
                <tbody>
                  {docs.map((doc) => {
                    const on = picked[doc.key] != null;
                    return (
                      <tr key={doc.key} className="border-b last:border-0">
                        <td className="w-9 px-3 py-2"><Checkbox checked={on} onCheckedChange={() => toggle(doc)} /></td>
                        <td className="px-2 py-2">
                          <span className="font-medium">{doc.number}</span>
                          <span className="block text-xs text-muted-foreground">Due {d(doc.dueDate)}</span>
                        </td>
                        <td className="px-2 py-2 text-right"><Money value={doc.balancePaise} /></td>
                        <td className="w-36 px-3 py-2">
                          {on && (
                            <MoneyInput
                              valuePaise={picked[doc.key]}
                              onChangePaise={(v) => setPicked((sel) => ({ ...sel, [doc.key]: Math.min(v, doc.balancePaise) }))}
                              className="h-8"
                            />
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className={`text-right text-sm ${left < 0 ? 'text-destructive' : 'text-muted-foreground'}`}>
            Applying <Money value={applying} /> · left on account <Money value={left} />
          </p>
        </div>
      )}

      {p.status === 'void' && (
        <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          This {isReceipt ? 'receipt' : 'payment'} is void. Its entry was reversed; it is kept so the number is never reused.
        </p>
      )}

      <DialogFooter>
        {canVoid && p.status !== 'void' && (
          <Button variant="ghost" className="mr-auto text-destructive hover:text-destructive" onClick={() => void voidIt()}>
            Void
          </Button>
        )}
        <Button variant="outline" onClick={onClose}>Close</Button>
        {canEdit && p.status !== 'void' && p.unappliedPaise > 0 && (
          <Button onClick={() => void apply()} disabled={busy || applying <= 0 || left < 0} className="gap-1.5">
            {busy && <Loader2 className="size-4 animate-spin" />} Apply
          </Button>
        )}
      </DialogFooter>
    </>
  );
}
