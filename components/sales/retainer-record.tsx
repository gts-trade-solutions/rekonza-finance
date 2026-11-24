'use client';

// One retainer invoice, beside its list in Zoho Books' split view (recorded
// from Zoho's demo on 2026-11-23): the bar Edit · Send Email · PDF/Print ▾ ·
// Apply to Invoices · ⋯ (Clone, Refund, Delete, View Journal), and the retainer as it
// prints. Before it is paid the bar offers Record Payment where Zoho's Apply
// to Invoices stands: the receipt settles the retainer, and only money that
// has arrived can then be applied to an invoice (services/sales-documents.ts
// applyRetainer).

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { ArrowRightLeft, ChevronDown, Loader2, Mail, MoreHorizontal, Pencil, Printer, Wallet } from 'lucide-react';
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
import { useDocumentActions } from '@/components/shared/document-menu';
import { refreshSplitList, useSplitRecordRefresh } from '@/components/shared/record-split';
import { DocumentSheet } from '@/components/print/document-print';
import { ribbonFor } from '@/components/print/zoho-sheet';
import { JournalDialog } from '@/components/sales/sales-doc-record';
import { usePermission } from '@/lib/store/hooks';
import { localDay } from '@/lib/selectors';
import { useApi } from '@/lib/api/use-api';
import { api, invoices as invoicesApi, retainers, salesDocuments, type RetainerDetail } from '@/lib/api/client';
import type { PrintDoc } from '@/lib/print-doc';

const barButton = 'inline-flex h-8 items-center gap-1.5 rounded-[3px] border px-3 text-[13px] transition-colors hover:bg-accent disabled:opacity-50';

export function RetainerRecordView() {
  const { id } = useParams<{ id: string }>();
  const state = useApi<RetainerDetail>(() => retainers.get(id), [id]);
  const print = useApi<PrintDoc>(() => api.get<PrintDoc>(`/api/print/retainer/${id}`), [id]);
  const reload = () => { void state.refetch(); void print.refetch(); refreshSplitList(); };
  useSplitRecordRefresh(reload);
  return <AsyncPage state={state}>{(r) => <Record r={r} printDoc={print.data ?? null} reload={reload} />}</AsyncPage>;
}

function Record({ r, printDoc, reload }: { r: RetainerDetail; printDoc: PrintDoc | null; reload: () => void }) {
  const router = useRouter();
  const canCreate = usePermission('sales', 'create');
  const canEdit = usePermission('sales', 'edit');
  const canVoid = usePermission('sales', 'void');
  const send = useDocumentActions('retainer', r.id, reload);
  const [dialog, setDialog] = useState<null | 'apply' | 'pay' | 'delete' | 'journal' | 'refund'>(null);
  const live = r.status !== 'void';
  // Paid, and neither applied to an invoice nor refunded: what can still be applied, or paid back.
  const spendable = r.unappliedPaise ?? r.paidPaise - r.appliedPaise;

  const actions = (
    <>
      {canEdit && r.changeable && <Link href={`/sales/retainers/${r.id}/edit`} className={barButton} data-slot="retainer-edit"><Pencil className="size-3.5" /> Edit</Link>}
      {send.canEmail && live && (
        <button type="button" className={barButton} disabled={send.busy} onClick={() => { send.checkMail(); void send.emailNow(); }} data-slot="retainer-send-email">
          {send.busy ? <Loader2 className="size-3.5 animate-spin" /> : <Mail className="size-3.5" />} Send Email
        </button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger className={barButton} data-slot="retainer-pdf-print"><Printer className="size-3.5" /> PDF/Print <ChevronDown className="size-3" /></DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onClick={() => router.push(`/print/retainer/${r.id}`)}>PDF</DropdownMenuItem>
          <DropdownMenuItem onClick={() => router.push(`/print/retainer/${r.id}?print=1`)}>Print</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {canCreate && live && spendable > 0 && (
        <button type="button" className={barButton} onClick={() => setDialog('apply')} data-slot="retainer-apply"><ArrowRightLeft className="size-3.5" /> Apply to Invoices</button>
      )}
      {canCreate && live && r.balancePaise > 0 && (
        <button type="button" className={barButton} onClick={() => setDialog('pay')} data-slot="retainer-record-payment"><Wallet className="size-3.5" /> Record Payment</button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger aria-label="More actions" className="grid size-8 place-items-center rounded-[3px] border transition-colors hover:bg-accent" data-slot="retainer-more">
          <MoreHorizontal className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-44">
          {canCreate && <DropdownMenuItem onClick={() => router.push(`/sales/retainers/new?clone=${r.id}`)} data-slot="retainer-clone">Clone</DropdownMenuItem>}
          {canCreate && live && spendable > 0 && <DropdownMenuItem onClick={() => setDialog('refund')} data-slot="retainer-refund">Refund</DropdownMenuItem>}
          {r.journalEntryId && <DropdownMenuItem onClick={() => setDialog('journal')} data-slot="retainer-journal">View Journal</DropdownMenuItem>}
          {canVoid && r.changeable && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setDialog('delete')} className="text-destructive focus:text-destructive" data-slot="retainer-delete">Delete</DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );

  return (
    <>
      <PageHeader title={r.number} actions={actions} />
      <Card className="flex flex-wrap items-center gap-x-6 gap-y-1 px-5 py-3 text-[13px]" data-slot="retainer-summary">
        <span>Amount <Money value={r.totalPaise} className="font-medium" /></span>
        <span>Received <Money value={r.paidPaise} className="font-medium" /></span>
        <span>Applied to invoices <Money value={r.appliedPaise} className="font-medium" /></span>
        {r.refundedPaise > 0 && <span>Refunded <Money value={r.refundedPaise} className="font-medium" /></span>}
        {r.projectName && <span>Project <span className="font-medium">{r.projectName}</span></span>}
        {r.reference && <span>Reference# <span className="font-medium">{r.reference}</span></span>}
      </Card>
      <Card className="p-0" data-slot="retainer-body">
        <div className="rounded-[4px] bg-[#f6f7f9] px-2 py-6 dark:bg-muted/30 sm:px-8" data-slot="retainer-pdf-view">
          {printDoc ? <DocumentSheet doc={printDoc} copyLabel={null} last ribbon={ribbonFor(printDoc.status)} /> : <p className="text-sm text-muted-foreground">Loading…</p>}
        </div>
      </Card>

      {r.refunds.length > 0 && <RefundHistory r={r} reload={reload} />}

      {dialog === 'refund' && <RefundDialog r={r} available={spendable} onClose={() => setDialog(null)} onDone={() => { setDialog(null); reload(); }} />}
      {dialog === 'apply' && <ApplyDialog r={r} onClose={() => setDialog(null)} onDone={() => { setDialog(null); reload(); }} />}
      {dialog === 'pay' && <PayDialog r={r} onClose={() => setDialog(null)} onDone={() => { setDialog(null); reload(); }} />}
      {dialog === 'journal' && r.journalEntryId && <JournalDialog entryId={r.journalEntryId} number={r.number} onClose={() => setDialog(null)} />}
      {dialog === 'delete' && <DeleteDialog r={r} onClose={() => setDialog(null)} onDone={() => { refreshSplitList(); router.push('/sales/retainers'); }} />}
    </>
  );
}

/** Zoho's "Apply Retainers to Invoice": the customer's open invoices, and how much of the retainer to set against one. */
function ApplyDialog({ r, onClose, onDone }: { r: RetainerDetail; onClose: () => void; onDone: () => void }) {
  const open = useApi(() => invoicesApi.list({ customerId: r.customerId, open: true, limit: 100 }), [r.customerId]);
  const invs = (open.data?.invoices ?? []).filter((i) => i.status !== 'draft' && i.status !== 'void');
  const [invoiceId, setInvoiceId] = useState('');
  const picked = invs.find((i) => i.id === invoiceId);
  const left = r.paidPaise - r.appliedPaise;
  const [amount, setAmount] = useState(0);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      const done = await salesDocuments.applyRetainer(r.id, invoiceId, amount || undefined);
      toast.success(`${(done.appliedPaise / 100).toFixed(2)} applied`, { description: 'That much is now earned and moves out of unearned revenue.' });
      onDone();
    } catch (e) {
      toast.error('Not applied', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md" data-slot="retainer-apply-dialog">
        <DialogHeader>
          <DialogTitle>Apply Retainers to Invoice</DialogTitle>
          <DialogDescription>
            {invs.length ? `${(left / 100).toFixed(2)} of ${r.number} is received and not yet applied.` : 'There are no invoices in the open status for this customer. Hence, credits cannot be applied.'}
          </DialogDescription>
        </DialogHeader>
        {invs.length > 0 && (
          <div className="space-y-3 text-[13px]">
            <label className="block space-y-1"><span className="text-muted-foreground">Invoice</span>
              <Combobox options={invs.map((i) => ({ value: i.id, label: i.number, sublabel: `Due ${(i.balancePaise / 100).toFixed(2)}` }))} value={invoiceId}
                onChange={(v) => { setInvoiceId(v); const inv = invs.find((i) => i.id === v); setAmount(Math.min(left, inv?.balancePaise ?? 0)); }} placeholder="Select an invoice" showAvatar={false} /></label>
            {picked && <label className="block space-y-1"><span className="text-muted-foreground">Amount to apply</span><MoneyInput valuePaise={amount} onChangePaise={setAmount} /></label>}
          </div>
        )}
        <DialogFooter>
          {invs.length > 0 ? <Button onClick={() => void go()} disabled={busy || !invoiceId || amount <= 0}>{busy && <Loader2 className="size-3.5 animate-spin" />} Apply</Button> : <Button onClick={onClose}>OK</Button>}
          {invs.length > 0 && <Button variant="outline" onClick={onClose}>Cancel</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The retainer's payment: a receipt settling it (a "Retainer Payment" in the payments list). */
function PayDialog({ r, onClose, onDone }: { r: RetainerDetail; onClose: () => void; onDone: () => void }) {
  const masters = useApi<{ bankAccounts: { id: string; name: string; kind: string }[] }>(() => api.get('/api/masters'), []);
  const [amount, setAmount] = useState(r.balancePaise);
  const [date, setDate] = useState(localDay(new Date()));
  const [mode, setMode] = useState('neft');
  const [bankId, setBankId] = useState('');
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const banks = (masters.data?.bankAccounts ?? []).filter((b) => b.kind !== 'card');
  const go = async () => {
    setBusy(true);
    try {
      await api.post('/api/payments', {
        kind: 'received', branchId: r.branchId, contactId: r.customerId, date, mode, bankAccountId: bankId || banks[0]?.id,
        amountPaise: amount, tdsPaise: 0, bankChargesPaise: 0, reference: reference || undefined,
        allocations: [{ targetType: 'retainer', targetId: r.id, amountPaise: amount }],
      });
      toast.success('Payment recorded', { description: `${(amount / 100).toFixed(2)} received against ${r.number}.` });
      onDone();
    } catch (e) {
      toast.error('Not recorded', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md" data-slot="retainer-pay-dialog">
        <DialogHeader><DialogTitle>Record Payment for {r.number}</DialogTitle><DialogDescription>{r.customerName}</DialogDescription></DialogHeader>
        <div className="space-y-3 text-[13px]">
          <label className="block space-y-1"><span className="text-muted-foreground">Amount Received*</span><MoneyInput valuePaise={amount} onChangePaise={setAmount} /></label>
          <label className="block space-y-1"><span className="text-muted-foreground">Payment Date*</span><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
          <label className="block space-y-1"><span className="text-muted-foreground">Payment Mode</span>
            <Combobox options={['cash', 'neft', 'upi', 'imps', 'cheque', 'card'].map((m) => ({ value: m, label: m.toUpperCase() }))} value={mode} onChange={setMode} showAvatar={false} /></label>
          <label className="block space-y-1"><span className="text-muted-foreground">Deposit To*</span>
            <Combobox options={banks.map((b) => ({ value: b.id, label: b.name, sublabel: b.kind }))} value={bankId || banks[0]?.id || ''} onChange={setBankId} placeholder="Select an account" /></label>
          <label className="block space-y-1"><span className="text-muted-foreground">Reference#</span><Input value={reference} onChange={(e) => setReference(e.target.value)} /></label>
        </div>
        <DialogFooter>
          <Button onClick={() => void go()} disabled={busy || amount <= 0 || !(bankId || banks[0])} data-slot="retainer-pay-save">{busy && <Loader2 className="size-3.5 animate-spin" />} Save</Button>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteDialog({ r, onClose, onDone }: { r: RetainerDetail; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      await retainers.remove(r.id, reason || undefined);
      toast.success(`${r.number} deleted`);
      onDone();
    } catch (e) {
      toast.error('Not deleted', { description: e instanceof Error ? e.message : String(e) });
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md" data-slot="retainer-delete-dialog">
        <DialogHeader>
          <DialogTitle>Delete {r.number}?</DialogTitle>
          <DialogDescription>Its entry is reversed in the ledger and the number is kept as deleted.</DialogDescription>
        </DialogHeader>
        <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (optional): raised in error" />
        <DialogFooter>
          <Button variant="destructive" onClick={() => void go()} disabled={busy}>{busy && <Loader2 className="size-3.5 animate-spin" />} Delete</Button>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Zoho's ⋯ → Refund: what was paid and not applied, paid back from a bank or cash account. */
function RefundDialog({ r, available, onClose, onDone }: { r: RetainerDetail; available: number; onClose: () => void; onDone: () => void }) {
  const masters = useApi<{ bankAccounts: { id: string; name: string; kind: string }[] }>(() => api.get('/api/masters'), []);
  const [amount, setAmount] = useState(available);
  const [date, setDate] = useState(localDay(new Date()));
  const [mode, setMode] = useState('neft');
  const [bankId, setBankId] = useState('');
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const banks = (masters.data?.bankAccounts ?? []).filter((b) => b.kind !== 'card');
  const go = async () => {
    setBusy(true);
    try {
      await api.post(`/api/retainers/${r.id}`, { action: 'refund', date, amountPaise: amount, bankAccountId: bankId || banks[0]?.id, mode, reference: reference || undefined });
      toast.success('Refund recorded', { description: `${(amount / 100).toFixed(2)} paid back to ${r.customerName}.` });
      onDone();
    } catch (e) {
      toast.error('Not refunded', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md" data-slot="retainer-refund-dialog">
        <DialogHeader>
          <DialogTitle>Refund {r.number}</DialogTitle>
          <DialogDescription>{r.customerName} · {(available / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })} paid and not applied to an invoice</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-[13px]">
          <label className="block space-y-1"><span className="text-muted-foreground">Amount*</span><MoneyInput valuePaise={amount} onChangePaise={setAmount} /></label>
          <label className="block space-y-1"><span className="text-muted-foreground">Refunded On*</span><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
          <label className="block space-y-1"><span className="text-muted-foreground">Payment Mode</span>
            <Combobox options={['cash', 'neft', 'upi', 'imps', 'cheque', 'card'].map((m) => ({ value: m, label: m.toUpperCase() }))} value={mode} onChange={setMode} showAvatar={false} /></label>
          <label className="block space-y-1"><span className="text-muted-foreground">From Account*</span>
            <Combobox options={banks.map((b) => ({ value: b.id, label: b.name, sublabel: b.kind }))} value={bankId || banks[0]?.id || ''} onChange={setBankId} placeholder="Select an account" /></label>
          <label className="block space-y-1"><span className="text-muted-foreground">Reference#</span><Input value={reference} onChange={(e) => setReference(e.target.value)} /></label>
        </div>
        <DialogFooter>
          <Button onClick={() => void go()} disabled={busy || amount <= 0 || amount > available || !(bankId || banks[0])} data-slot="retainer-refund-save">{busy && <Loader2 className="size-3.5 animate-spin" />} Save</Button>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Refund History, as Zoho lists it under the record; a refund can be deleted (reversed). */
function RefundHistory({ r, reload }: { r: RetainerDetail; reload: () => void }) {
  const canVoid = usePermission('sales', 'void');
  const remove = async (entryId: string) => {
    if (!window.confirm('Delete this refund? Its entry is reversed and the money is back on the retainer to apply.')) return;
    try {
      await api.post(`/api/retainers/${r.id}`, { action: 'delete_refund', entryId });
      toast.success('Refund deleted');
      reload();
    } catch (e) {
      toast.error('Not deleted', { description: e instanceof Error ? e.message : String(e) });
    }
  };
  return (
    <Card className="p-0" data-slot="retainer-refunds">
      <p className="border-b px-5 py-3 text-[13px] font-medium">Refund History</p>
      <div className="divide-y text-[13px]">
        {r.refunds.map((x) => (
          <div key={x.entryId} className="flex items-center gap-4 px-5 py-2.5">
            <span className="w-28 text-muted-foreground">{new Date(`${x.date}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{x.memo}</span>
            <Money value={x.amountPaise} className="font-medium" />
            {canVoid && <button type="button" className="text-destructive hover:underline" onClick={() => void remove(x.entryId)} data-slot="retainer-refund-delete">Delete</button>}
          </div>
        ))}
      </div>
    </Card>
  );
}
