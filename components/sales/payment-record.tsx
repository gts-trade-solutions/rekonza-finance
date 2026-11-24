'use client';

// One payment received, beside its list in Zoho Books' split view (recorded
// from Zoho's demo on 2026-11-23): the bar Edit · Send Email · PDF/Print ▾ ·
// Refund · ⋯ (View Journal, Delete), and the payment receipt itself, as it
// prints. Under it, the documents it paid and the refunds taken from what it
// left unused.

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { ChevronDown, Loader2, Mail, MoreHorizontal, Pencil, Printer, Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Combobox } from '@/components/ui/combobox';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { PageHeader } from '@/components/shared/page-header';
import { AsyncPage } from '@/components/shared/async-state';
import { Money } from '@/components/shared/money';
import { MoneyInput } from '@/components/shared/form-bits';
import { DeleteDocumentDialog, useDocumentActions } from '@/components/shared/document-menu';
import { refreshSplitList, useSplitRecordRefresh } from '@/components/shared/record-split';
import { DocumentSheet } from '@/components/print/document-print';
import { ribbonFor } from '@/components/print/zoho-sheet';
import { JournalDialog } from '@/components/sales/sales-doc-record';
import { usePermission } from '@/lib/store/hooks';
import { localDay } from '@/lib/selectors';
import { useApi } from '@/lib/api/use-api';
import { api, payments as paymentsApi, type PaymentDetail } from '@/lib/api/client';
import type { PrintDoc } from '@/lib/print-doc';

const barButton = 'inline-flex h-8 items-center gap-1.5 rounded-[3px] border px-3 text-[13px] transition-colors hover:bg-accent disabled:opacity-50';
const day = (s: string) => new Date(`${s.slice(0, 10)}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
const DOC_HREF: Record<string, string> = { invoice: '/sales/invoices', retainer: '/sales/retainers' };

export function PaymentRecordView() {
  const { id } = useParams<{ id: string }>();
  const state = useApi<PaymentDetail>(() => paymentsApi.get(id), [id]);
  const print = useApi<PrintDoc>(() => api.get<PrintDoc>(`/api/print/payment-received/${id}`), [id]);
  const reload = () => { void state.refetch(); void print.refetch(); refreshSplitList(); };
  useSplitRecordRefresh(reload);
  return <AsyncPage state={state}>{(p) => <Record p={p} printDoc={print.data ?? null} reload={reload} />}</AsyncPage>;
}

function Record({ p, printDoc, reload }: { p: PaymentDetail; printDoc: PrintDoc | null; reload: () => void }) {
  const router = useRouter();
  const canEdit = usePermission('sales', 'edit');
  const canVoid = usePermission('sales', 'void');
  const send = useDocumentActions('payment-received', p.id, reload);
  const [refunding, setRefunding] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [journalOpen, setJournalOpen] = useState(false);
  const live = p.status !== 'void';
  // An advance that carried GST is refunded with a refund voucher, not here (services/payments.ts refundPayment).
  const refundable = canEdit && live && p.unappliedPaise > 0 && !p.advanceGst;

  const emailNow = async () => {
    send.checkMail();
    await send.emailNow();
  };
  const deleteRefund = async (refundId: string) => {
    if (!window.confirm('Delete this refund? Its entry is reversed and the money is unused on the payment again.')) return;
    try {
      await paymentsApi.deleteRefund(p.id, refundId);
      toast.success('Refund deleted');
      reload();
    } catch (e) {
      toast.error('Not deleted', { description: e instanceof Error ? e.message : String(e) });
    }
  };

  const actions = (
    <>
      {canEdit && live && (
        <Link href={`/sales/payments/new?edit=${p.id}`} className={barButton} data-slot="payment-edit"><Pencil className="size-3.5" /> Edit</Link>
      )}
      {send.canEmail && live && (
        <button type="button" className={barButton} onClick={() => void emailNow()} disabled={send.busy} data-slot="payment-send-email">
          {send.busy ? <Loader2 className="size-3.5 animate-spin" /> : <Mail className="size-3.5" />} Send Email
        </button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger className={barButton} data-slot="payment-pdf-print"><Printer className="size-3.5" /> PDF/Print <ChevronDown className="size-3" /></DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onClick={() => router.push(`/print/payment-received/${p.id}`)}>PDF</DropdownMenuItem>
          <DropdownMenuItem onClick={() => router.push(`/print/payment-received/${p.id}?print=1`)}>Print</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {refundable && (
        <button type="button" className={barButton} onClick={() => setRefunding(true)} data-slot="payment-refund"><Undo2 className="size-3.5" /> Refund</button>
      )}
      {(p.journalEntryId || canVoid) && (
        <DropdownMenu>
          <DropdownMenuTrigger aria-label="More actions" className="grid size-8 place-items-center rounded-[3px] border transition-colors hover:bg-accent" data-slot="payment-more">
            <MoreHorizontal className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-44">
            {p.journalEntryId && <DropdownMenuItem onClick={() => setJournalOpen(true)} data-slot="payment-journal">View Journal</DropdownMenuItem>}
            {canVoid && live && (
              <>
                {p.journalEntryId && <DropdownMenuSeparator />}
                <DropdownMenuItem onClick={() => setDeleting(true)} className="text-destructive focus:text-destructive" data-slot="payment-delete">Delete</DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </>
  );

  return (
    <>
      <PageHeader title={p.number} actions={actions} />

      {p.unappliedPaise > 0 && live && (
        <Card className="flex flex-wrap items-center gap-3 px-5 py-3 text-[13px]" data-slot="payment-excess">
          <span><Money value={p.unappliedPaise} className="font-medium" /> of this payment is unused (an excess payment on account).</span>
          <span className="text-muted-foreground">Apply it from the customer&apos;s next invoice, or refund it.</span>
        </Card>
      )}

      <Card className="p-0" data-slot="payment-body">
        <div className="rounded-[4px] bg-[#f6f7f9] px-2 py-6 dark:bg-muted/30 sm:px-8" data-slot="payment-pdf-view">
          {printDoc ? <DocumentSheet doc={printDoc} copyLabel={null} last ribbon={ribbonFor(printDoc.status)} /> : <p className="text-sm text-muted-foreground">Loading the receipt…</p>}
        </div>
      </Card>

      {p.allocations.length > 0 && (
        <Card className="p-0" data-slot="payment-for">
          <p className="border-b px-5 py-3 text-[13px] font-medium">Payment for</p>
          <table className="w-full text-[13px]">
            <thead className="bg-[#f9f9fb] text-[11px] font-semibold uppercase text-[#6c718a]">
              <tr><th className="px-5 py-2 text-left">Document</th><th className="px-5 py-2 text-left">Applied on</th><th className="px-5 py-2 text-right">Payment</th></tr>
            </thead>
            <tbody>
              {p.allocations.map((a) => (
                <tr key={a.id} className="border-t">
                  <td className="px-5 py-2">{DOC_HREF[a.targetType] ? <Link href={`${DOC_HREF[a.targetType]}/${a.targetId}`} className="text-link hover:underline">{a.number}</Link> : a.number}</td>
                  <td className="px-5 py-2 text-muted-foreground">{a.appliedOn ? day(a.appliedOn) : ''}</td>
                  <td className="px-5 py-2 text-right"><Money value={a.amountPaise} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {!!p.refunds?.length && (
        <Card className="p-0" data-slot="payment-refunds">
          <p className="border-b px-5 py-3 text-[13px] font-medium">Refund History</p>
          <table className="w-full text-[13px]">
            <tbody>
              {p.refunds.map((r) => (
                <tr key={r.id} className="border-t first:border-0">
                  <td className="px-5 py-2">{day(r.date)}</td>
                  <td className="px-5 py-2 text-muted-foreground">{r.memo}</td>
                  <td className="px-5 py-2 text-right"><Money value={r.amountPaise} /></td>
                  <td className="w-20 px-5 py-2 text-right">{canVoid && <button type="button" className="text-destructive hover:underline" onClick={() => void deleteRefund(r.id)}>Delete</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {refunding && <RefundDialog p={p} onClose={() => setRefunding(false)} onDone={() => { setRefunding(false); reload(); }} />}
      {journalOpen && p.journalEntryId && <JournalDialog entryId={p.journalEntryId} number={p.number} onClose={() => setJournalOpen(false)} />}
      <DeleteDocumentDialog kind="payment-received" id={p.id} number={p.number} open={deleting} onOpenChange={setDeleting}
        onDeleted={() => { refreshSplitList(); router.push('/sales/payments'); }} />
    </>
  );
}

/** Zoho's "Refund" window on a payment: amount, date, mode, the account it is paid from, reference. */
function RefundDialog({ p, onClose, onDone }: { p: PaymentDetail; onClose: () => void; onDone: () => void }) {
  const masters = useApi<{ bankAccounts: { id: string; name: string; kind: string }[] }>(() => api.get('/api/masters'), []);
  const [amount, setAmount] = useState(p.unappliedPaise);
  const [date, setDate] = useState(localDay(new Date()));
  const [mode, setMode] = useState(p.mode ?? 'neft');
  const [bankId, setBankId] = useState(p.bankAccountId ?? '');
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await paymentsApi.refund(p.id, { date, amountPaise: amount, bankAccountId: bankId || null, mode, reference: reference || null });
      toast.success('Refund recorded', { description: `${(amount / 100).toFixed(2)} paid back to ${p.contactName}.` });
      onDone();
    } catch (e) {
      toast.error('Not refunded', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md" data-slot="payment-refund-dialog">
        <DialogHeader>
          <DialogTitle>Refund</DialogTitle>
          <DialogDescription>From the {(p.unappliedPaise / 100).toFixed(2)} of {p.number} left unused, back to {p.contactName}.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-[13px]">
          <label className="block space-y-1"><span className="text-muted-foreground">Amount*</span><MoneyInput valuePaise={amount} onChangePaise={setAmount} /></label>
          <label className="block space-y-1"><span className="text-muted-foreground">Refunded On*</span><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
          <label className="block space-y-1"><span className="text-muted-foreground">Payment Mode</span>
            <Combobox options={['cash', 'neft', 'upi', 'imps', 'cheque', 'card'].map((m) => ({ value: m, label: m.toUpperCase() }))} value={mode} onChange={setMode} showAvatar={false} /></label>
          <label className="block space-y-1"><span className="text-muted-foreground">From Account*</span>
            <Combobox options={(masters.data?.bankAccounts ?? []).filter((b) => b.kind !== 'card').map((b) => ({ value: b.id, label: b.name, sublabel: b.kind }))} value={bankId} onChange={setBankId} placeholder="Select an account" /></label>
          <label className="block space-y-1"><span className="text-muted-foreground">Reference#</span><Input value={reference} onChange={(e) => setReference(e.target.value)} /></label>
        </div>
        <DialogFooter>
          <Button onClick={() => void save()} disabled={busy || amount <= 0 || !bankId} data-slot="payment-refund-save">{busy && <Loader2 className="size-3.5 animate-spin" />} Save</Button>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
