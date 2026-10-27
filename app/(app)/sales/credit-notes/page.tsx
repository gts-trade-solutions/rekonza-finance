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

import { useState } from 'react';
import { FileMinus, Plus, Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { ContactPicker } from '@/components/forms/quick-create';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import { PageHeader } from '@/components/shared/page-header';
import { DataTable, type Column } from '@/components/shared/data-table';
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
const today = () => new Date().toISOString().slice(0, 10);
const short = (d: string) => new Date(d).toLocaleDateString('en-IN');

export default function CreditNotesPage() {
  const canCreate = usePermission('sales', 'create');
  const branchId = useAppStore((s) => s.activeBranchId);
  const bankAccounts = useAppStore((s) => s.bankAccounts);

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
  const refund = useApiAction(salesDocuments.refundCreditNote);

  const save = async () => {
    if (!customerId || amount <= 0) {
      toast.error('Pick a customer and enter an amount.');
      return;
    }
    const result = await create.run({
      kind: 'credit-note',
      branchId,
      customerId,
      date: today(),
      reason,
      againstInvoiceId: invoiceId || null,
      voucherTypeId: voucherTypeId || null,
      lines: [{ itemId: null, description: reason, qty: 1, ratePaise: amount, gstRatePct: gstRate }],
    });
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

  const doRefund = async (r: SalesDocRow) => {
    const bank = bankAccounts.find((b) => b.kind === 'bank');
    if (!bank) {
      toast.error('No bank account is set up to refund from.');
      return;
    }
    const done = await refund.run(r.id, bank.id, today(), undefined, `Refund against ${r.number}`);
    if (!done) {
      toast.error(refund.error ?? 'Could not refund that credit note');
      return;
    }
    toast.success(`${formatINR(done.refundedPaise)} refunded`, {
      description: 'Cash has left the bank — this is the one case where a credit note moves money.',
    });
    state.refetch();
  };

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
      cell: (r) => <span className="text-xs">{r.linkedId ? `Invoice #${r.linkedId}` : 'Standalone'}</span>,
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
        if (r.status === 'refunded') return <span className="text-xs text-muted-foreground">Refunded</span>;
        if (unapplied <= 0 || !canCreate) return null;
        return (
          <Button
            variant="outline"
            size="xs"
            className="gap-1"
            disabled={refund.busy}
            onClick={() => void doRefund(r)}
          >
            <Undo2 className="size-3" /> Refund
          </Button>
        );
      },
    },
  ];

  return (
    <>
      <PageHeader
        title="Credit notes"
        description="Reversing part of a sale. Revenue and the GST charged on it both come back out, and the customer owes that much less."
        actions={
          canCreate && (
            <Dialog open={open} onOpenChange={setOpen}>
              <DialogTrigger asChild>
                <Button size="sm" className="gap-1.5"><Plus className="size-4" /> New credit note</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>New credit note</DialogTitle>
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
                      options={REASONS.map((r) => ({ value: r, label: r }))}
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
                  <Button onClick={save} disabled={create.busy}>
                    {create.busy ? 'Saving…' : 'Create credit note'}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          )
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
              columns={columns}
              getRowId={(r) => r.id}
              initialSort={{ key: 'date', dir: 'desc' }}
              dateFilter={{ getDate: (r) => r.date }}
              searchPlaceholder="Search credit note or customer…"
            />
          )
        }
      </AsyncPage>
    </>
  );
}
