'use client';

// Credit notes.
//
// A credit note reverses part of a sale: revenue comes back out, the output GST
// that went with it comes back out, and the customer owes that much less. GST
// law requires a reason on every one, because the reason is reported in GSTR-1.
//
// It is not a refund. Most credit notes are set against the customer's next
// invoice and no money ever moves. Refunding one in cash is a separate, later
// decision — and that is the only version that touches the bank.

import { FoldNav } from '@/components/layout/nav-state';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { localDay } from '@/lib/selectors';
import { FileMinus, Plus, Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Combobox } from '@/components/ui/combobox';
import { ContactPicker } from '@/components/forms/quick-create';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import { PageHeader } from '@/components/shared/page-header';
import { ModuleMenu } from '@/components/shared/module-menu';
import { DataTable, type Column } from '@/components/shared/data-table';
import { BulkPrintButton, documentMenuColumn } from '@/components/shared/document-menu';
import { Money } from '@/components/shared/money';
import { StatusBadge } from '@/components/shared/status-badge';
import { EmptyState } from '@/components/shared/empty-state';
import { AsyncPage } from '@/components/shared/async-state';
import { Field, MoneyInput } from '@/components/shared/form-bits';
import {
  invoices as invoicesApi, salesDocuments,
  type SalesDocListResponse, type SalesDocRow,
} from '@/lib/api/client';
import { useApi, useApiAction } from '@/lib/api/use-api';
import { useAppStore } from '@/lib/store';
import { usePermission } from '@/lib/store/hooks';
import { formatINR } from '@/lib/money';
import { VoucherTypePicker } from '@/components/forms/voucher-type-picker';

/** GST requires a reason on every credit note; it is reported in GSTR-1. */
const REASONS = [
  'Goods returned — damaged in transit',
  'Goods returned — wrong item supplied',
  'Post-sale discount agreed',
  'Deficiency in service',
  'Correction of taxable value',
  'Order cancelled',
];

const RATE_OPTIONS = [0, 5, 12, 18, 28].map((r) => ({ value: String(r), label: `${r}%` }));
const today = () => localDay(new Date());
const short = (d: string) => new Date(d).toLocaleDateString('en-IN');

export default function CreditNotesPage() {
  const canCreate = usePermission('sales', 'create');
  const branchId = useAppStore((s) => s.activeBranchId);

  const state = useApi<SalesDocListResponse>(() => salesDocuments.list('credit-note'), []);

  const [open, setOpen] = useState(false);
  const [customerId, setCustomerId] = useState('');
  const [invoiceId, setInvoiceId] = useState('');
  const [reason, setReason] = useState(REASONS[0]);
  const [amount, setAmount] = useState(0);
  const [gstRate, setGstRate] = useState(18);

  // The customer's open invoices, fetched once a customer is chosen. A credit
  // note can only be set against something that is actually still owed.
  const openInvoices = useApi(
    async () => (customerId ? invoicesApi.list({ customerId, open: true, limit: 100 }) : { invoices: [] as never[] }),
    [customerId],
  );

  const create = useApiAction(salesDocuments.create);
  const [voucherTypeId, setVoucherTypeId] = useState('');
  // Zoho's Edit: the same dialog, filled in, saved back over the credit note.
  const [editing, setEditing] = useState<{ id: string; number: string; date: string } | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const startEdit = async (r: { id: string }) => {
    try {
      const d = await salesDocuments.getOne('credit-note', r.id);
      const line = d.lines[0];
      setEditing({ id: d.id, number: d.number, date: d.date ?? today() });
      setCustomerId(d.customerId);
      setInvoiceId(d.againstInvoiceId ?? '');
      setReason(d.reason ?? REASONS[0]);
      setAmount(line ? Math.round(line.ratePaise * line.qty) : 0);
      setGstRate(line?.gstRatePct ?? 18);
      setOpen(true);
    } catch (e) {
      toast.error('That credit note could not be loaded', { description: e instanceof Error ? e.message : String(e) });
    }
  };

  // ?invoice=<id>: an invoice's ⋯ → "Create Credit Note" (Zoho's) starts the note
  // against it; ?new=1: the invoice list's New ▾ → New Credit Note.
  const params = useSearchParams();
  const startFor = params.get('invoice');
  const startNew = params.get('new') === '1';
  useEffect(() => {
    if (startNew) setOpen(true);
    if (!startFor) return;
    let live = true;
    invoicesApi.get(startFor).then((inv) => {
      if (!live) return;
      setCustomerId(inv.customer.id);
      setInvoiceId(inv.id);
      setGstRate(inv.lines[0]?.gstRatePct ?? 18);
      setOpen(true);
    }).catch((e) => toast.error('That invoice could not be read', { description: e instanceof Error ? e.message : String(e) }));
    return () => { live = false; };
  }, [startFor, startNew]);

  const save = async () => {
    if (!customerId || amount <= 0) {
      toast.error('Pick a customer and enter an amount.');
      return;
    }
    const payload = {
      kind: 'credit-note' as const,
      branchId,
      customerId,
      date: editing?.date ?? today(),
      reason,
      againstInvoiceId: invoiceId || null,
      voucherTypeId: voucherTypeId || null,
      lines: [{ itemId: null, description: reason, qty: 1, ratePaise: amount, gstRatePct: gstRate }],
    };
    if (editing) {
      setSavingEdit(true);
      try {
        const done = await salesDocuments.update('credit-note', editing.id, payload);
        toast.success(`Credit note ${done.number} updated`, { description: 'Its entry was reversed and posted again; the audit trail keeps the old version.' });
        setOpen(false);
        setEditing(null);
        setCustomerId('');
        setInvoiceId('');
        setAmount(0);
        state.refetch();
      } catch (e) {
        toast.error('Not saved', { description: e instanceof Error ? e.message : String(e) });
      } finally { setSavingEdit(false); }
      return;
    }
    const result = await create.run(payload);
    if (!result) return;

    toast.success(`Credit note ${result.number} created`, {
      description: 'Revenue and the GST on it are reversed; the customer owes that much less.',
    });
    setOpen(false);
    setCustomerId('');
    setInvoiceId('');
    setAmount(0);
    state.refetch();
  };

  // Refund, Apply to Invoices and Void, each asked in its own dialog (Zoho's credit note actions).
  const [refunding, setRefunding] = useState<SalesDocRow | null>(null);
  const [applying, setApplying] = useState<SalesDocRow | null>(null);
  const [voiding, setVoiding] = useState<SalesDocRow | null>(null);
  const columns: Column<SalesDocRow>[] = [
    { key: 'number', header: 'Credit note #', sortValue: (r) => r.number, cell: (r) => <span className="font-medium">{r.number}</span> },
    { key: 'customer', header: 'Customer', sortValue: (r) => r.customerName, cell: (r) => r.customerName },
    { key: 'date', header: 'Date', sortValue: (r) => r.date, cell: (r) => short(r.date) },
    {
      key: 'reason', header: 'Reason', sortValue: (r) => r.detail ?? '',
      cell: (r) => <span className="text-xs text-muted-foreground">{r.detail}</span>,
    },
    {
      key: 'against', header: 'Against', sortValue: (r) => r.linkedId ?? '',
      cell: (r) => <span className="text-xs">{r.linkedNumber ?? (r.linkedId ? `Invoice #${r.linkedId}` : 'Standalone')}</span>,
    },
    { key: 'status', header: 'Status', sortValue: (r) => r.status, cell: (r) => <StatusBadge status={r.status} /> },
    {
      key: 'unapplied', header: 'On account', align: 'right',
      sortValue: (r) => r.totalPaise - (r.appliedPaise ?? 0),
      cell: (r) => <Money value={r.totalPaise - (r.appliedPaise ?? 0)} showZero={false} />,
    },
    { key: 'total', header: 'Amount', align: 'right', sortValue: (r) => r.totalPaise, cell: (r) => <Money value={r.totalPaise} className="font-medium" /> },
    {
      key: 'actions', header: '', align: 'right',
      cell: (r) => {
        const unapplied = r.totalPaise - (r.appliedPaise ?? 0);
        if (r.status === 'void') return <span className="text-xs text-muted-foreground">Void</span>;
        if (!canCreate) return null;
        return (
          <div className="flex justify-end gap-1">
            {unapplied > 0 && (
              <Button variant="outline" size="xs" onClick={() => setApplying(r)} data-slot="cn-apply">Apply to Invoices</Button>
            )}
            {unapplied > 0 && (
              <Button variant="outline" size="xs" className="gap-1" onClick={() => setRefunding(r)} data-slot="cn-refund">
                <Undo2 className="size-3" /> Refund
              </Button>
            )}
            {r.status !== 'refunded' && (
              <Button variant="ghost" size="xs" className="text-destructive hover:text-destructive" onClick={() => setVoiding(r)} data-slot="cn-void">Void</Button>
            )}
          </div>
        );
      },
    },
  ];

  return (
    <>
      <PageHeader
        title="Credit Notes"
        description="Reversing part of a sale. Revenue and the GST charged on it both come back out, and the customer owes that much less."
        actions={<>{
          canCreate && (
            <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v && editing) { setEditing(null); setCustomerId(''); setInvoiceId(''); setAmount(0); } }}>
              <DialogTrigger asChild>
                <Button size="sm" className="gap-1.5"><Plus className="size-4" /> New credit note</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>{editing ? `Edit credit note ${editing.number}` : 'New credit note'}</DialogTitle>
                  <FoldNav />
                  <DialogDescription>
                    Leave the invoice blank to leave the credit on the customer&apos;s account for next time.
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-4">
                  <VoucherTypePicker docType="CN" ordinary="Ordinary CN series" value={voucherTypeId} onChange={setVoucherTypeId} />
                  <Field label="Customer" required>
                    <ContactPicker
                      kind="customer"
                      value={customerId}
                      onChange={(v) => { setCustomerId(v); setInvoiceId(''); }}
                      canCreate={canCreate}
                    />
                  </Field>
                  <Field
                    label="Against invoice"
                    hint={
                      customerId
                        ? 'Only invoices with a balance can be credited'
                        : 'Pick a customer first'
                    }
                  >
                    <Combobox
                      options={(openInvoices.data?.invoices ?? []).map((i) => ({
                        value: i.id,
                        label: i.number,
                        sublabel: short(i.date),
                        meta: formatINR(i.balancePaise),
                      }))}
                      value={invoiceId}
                      onChange={setInvoiceId}
                      placeholder="Leave on account"
                      searchPlaceholder="Search invoices"
                      showAvatar={false}
                      clearable
                    />
                  </Field>
                  <Field label="Reason" required hint="Reported in GSTR-1 — it is not optional">
                    <Combobox
                      // A reason typed in the customer's own words, when editing, is shown as saved, not as blank.
                      options={[...new Set([...REASONS, reason].filter(Boolean))].map((r) => ({ value: r, label: r }))}
                      value={reason}
                      onChange={setReason}
                      showAvatar={false}
                    />
                  </Field>
                  <div className="grid grid-cols-2 gap-4">
                    <Field label="Taxable amount" required>
                      <MoneyInput valuePaise={amount} onChangePaise={setAmount} />
                    </Field>
                    <Field label="GST rate" hint="Match the rate on the original invoice">
                      <Combobox
                        options={RATE_OPTIONS}
                        value={String(gstRate)}
                        onChange={(v) => setGstRate(Number(v))}
                        showAvatar={false}
                      />
                    </Field>
                  </div>
                  <div className="flex items-center justify-between rounded-md border bg-muted/30 px-3 py-2 text-sm">
                    <span className="text-muted-foreground">
                      Credit incl. GST
                    </span>
                    <Money value={amount + Math.round((amount * gstRate) / 100)} className="font-semibold" />
                  </div>
                  {create.error && <p className="text-sm text-destructive">{create.error}</p>}
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
                  <Button onClick={save} disabled={create.busy || savingEdit} data-slot="save-credit-note">
                    {create.busy || savingEdit ? 'Saving…' : editing ? 'Save' : 'Create credit note'}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          )
        }<ModuleMenu slug="credit-notes" onRefresh={() => void state.refetch()} /></>
        }
      />
      <AsyncPage state={state}>
        {(d) =>
          d.documents.length === 0 ? (
            <EmptyState
              icon={FileMinus}
              title="No credit notes"
              description="Raise one when goods come back or a price is corrected after the invoice went out."
            />
          ) : (
            <DataTable
              rows={d.documents}
              columns={[...columns, documentMenuColumn('credit-note', state.refetch, (r) => void startEdit(r))]}
              getRowId={(r) => r.id}
              selectable
              bulkActions={(selected) => <BulkPrintButton kind="credit-note" ids={selected.map((r) => r.id)} />}
              initialSort={{ key: 'date', dir: 'desc' }}
              dateFilter={{ getDate: (r) => r.date }}
              searchPlaceholder="Search credit note or customer…"
            />
          )
        }
      </AsyncPage>
      {refunding && <RefundDialog cn={refunding} onClose={() => setRefunding(null)} onDone={() => { setRefunding(null); state.refetch(); }} />}
      {applying && <ApplyDialog cn={applying} onClose={() => setApplying(null)} onDone={() => { setApplying(null); state.refetch(); }} />}
      {voiding && <VoidDialog cn={voiding} onClose={() => setVoiding(null)} onDone={() => { setVoiding(null); state.refetch(); }} />}
    </>
  );
}

const left = (cn: SalesDocRow) => cn.totalPaise - (cn.appliedPaise ?? 0);

/** Refund: how much, when, and from which account. A part refund leaves the rest on the credit note. */
function RefundDialog({ cn, onClose, onDone }: { cn: SalesDocRow; onClose: () => void; onDone: () => void }) {
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
function ApplyDialog({ cn, onClose, onDone }: { cn: SalesDocRow; onClose: () => void; onDone: () => void }) {
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
function VoidDialog({ cn, onClose, onDone }: { cn: SalesDocRow; onClose: () => void; onDone: () => void }) {
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

