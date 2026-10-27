'use client';

// Vendor credits — a supplier's credit note to us.
//
// It works the opposite way from ours: what we owe goes down, the cost that was
// booked comes back out, and the input credit claimed on that cost has to be
// given back too. That last part is the one people forget. If the supplier
// reverses the supply, they reverse it in their GSTR-1 as well, and the credit
// disappears from our GSTR-2B — holding on to it produces a mismatch the
// department asks about, with interest.

import { useState } from 'react';
import { FileMinus, Plus, Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
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
  bills as billsApi, purchaseDocuments,
  type PurchaseDocListResponse, type PurchaseDocRow,
} from '@/lib/api/client';
import { useApi, useApiAction } from '@/lib/api/use-api';
import { useAppStore } from '@/lib/store';
import { usePermission } from '@/lib/store/hooks';
import { formatINR } from '@/lib/money';

const REASONS = [
  'Short supply — goods not received',
  'Goods returned — damaged',
  'Rate correction agreed after delivery',
  'Over-billed on the original invoice',
  'Order cancelled after billing',
];

const RATE_OPTIONS = [0, 5, 12, 18, 28].map((r) => ({ value: String(r), label: `${r}%` }));
const today = () => new Date().toISOString().slice(0, 10);
const short = (d: string) => new Date(d).toLocaleDateString('en-IN');

export default function VendorCreditsPage() {
  const canCreate = usePermission('purchases', 'create');
  const branchId = useAppStore((s) => s.activeBranchId);
  const bankAccounts = useAppStore((s) => s.bankAccounts);

  const state = useApi<PurchaseDocListResponse>(() => purchaseDocuments.list('vendor-credit'), []);

  const [open, setOpen] = useState(false);
  const [vendorId, setVendorId] = useState('');
  const [billId, setBillId] = useState('');
  const [reason, setReason] = useState(REASONS[0]);
  const [amount, setAmount] = useState(0);
  const [gstRate, setGstRate] = useState(18);
  const [itcClaimed, setItcClaimed] = useState(true);

  // Only this vendor's open bills — a credit can only reduce something owed.
  const vendorBills = useApi(
    async () => (vendorId ? billsApi.list({ vendorId, open: true, limit: 100 }) : { bills: [] as never[] }),
    [vendorId],
  );

  const create = useApiAction(purchaseDocuments.create);
  const refund = useApiAction(purchaseDocuments.refundVendorCredit);

  const save = async () => {
    if (!vendorId || amount <= 0) {
      toast.error('Pick a vendor and enter an amount.');
      return;
    }
    const result = await create.run({
      kind: 'vendor-credit',
      branchId,
      vendorId,
      date: today(),
      reason,
      againstBillId: billId || null,
      amountPaise: amount,
      gstRatePct: gstRate,
      itcClaimed,
    });
    if (!result) return;
    toast.success(`${result.number} recorded`, {
      description: itcClaimed
        ? 'Payable reduced, cost reversed, and the input credit given back.'
        : 'Payable reduced and the cost reversed.',
    });
    setOpen(false);
    setVendorId('');
    setBillId('');
    setAmount(0);
    state.refetch();
  };

  const doRefund = async (r: PurchaseDocRow) => {
    const bank = bankAccounts.find((b) => b.kind === 'bank');
    if (!bank) {
      toast.error('No bank account is set up to receive the refund.');
      return;
    }
    const done = await refund.run(r.id, bank.id, today(), undefined, `Refund on ${r.number}`);
    if (!done) {
      toast.error(refund.error ?? 'Could not record that refund');
      return;
    }
    toast.success(`${formatINR(done.refundedPaise)} received`, {
      description: 'Cash back in the bank rather than set off against a future bill.',
    });
    state.refetch();
  };

  const columns: Column<PurchaseDocRow>[] = [
    { key: 'number', header: 'Credit #', sortValue: (r) => r.number, cell: (r) => <span className="font-medium">{r.number}</span> },
    { key: 'vendor', header: 'Vendor', sortValue: (r) => r.vendorName, cell: (r) => r.vendorName },
    { key: 'date', header: 'Date', sortValue: (r) => r.date, cell: (r) => short(r.date) },
    {
      key: 'reason', header: 'Reason', sortValue: (r) => r.reason ?? '',
      cell: (r) => <span className="text-xs text-muted-foreground">{r.reason}</span>,
    },
    {
      key: 'against', header: 'Against bill', sortValue: (r) => r.linkedId ?? '',
      cell: (r) => <span className="text-xs">{r.linkedId ? `Bill #${r.linkedId}` : 'Standalone'}</span>,
    },
    { key: 'status', header: 'Status', sortValue: (r) => r.status, cell: (r) => <StatusBadge status={r.status} /> },
    {
      key: 'unapplied', header: 'On account', align: 'right',
      sortValue: (r) => r.totalPaise - r.appliedPaise,
      cell: (r) => <Money value={r.totalPaise - r.appliedPaise} showZero={false} />,
    },
    { key: 'total', header: 'Amount', align: 'right', sortValue: (r) => r.totalPaise, cell: (r) => <Money value={r.totalPaise} className="font-medium" /> },
    {
      key: 'actions', header: '', align: 'right',
      cell: (r) => {
        const unapplied = r.totalPaise - r.appliedPaise;
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
            <Undo2 className="size-3" /> Refund received
          </Button>
        );
      },
    },
  ];

  return (
    <>
      <PageHeader
        title="Vendor credits"
        description="Money a supplier owes you back — returns, shortfalls, or over-billing."
        actions={
          canCreate && (
            <Dialog open={open} onOpenChange={setOpen}>
              <DialogTrigger asChild>
                <Button size="sm" className="gap-1.5"><Plus className="size-4" /> New vendor credit</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>New vendor credit</DialogTitle>
                  <DialogDescription>
                    Leave the bill blank to keep the credit on the supplier&apos;s account for next time.
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-4">
                  <Field label="Vendor" required>
                    <ContactPicker
                      kind="vendor"
                      value={vendorId}
                      onChange={(v) => { setVendorId(v); setBillId(''); }}
                      canCreate={canCreate}
                    />
                  </Field>
                  <Field
                    label="Against bill"
                    hint={vendorId ? 'Only bills with a balance can be credited' : 'Pick a vendor first'}
                  >
                    <Combobox
                      options={(vendorBills.data?.bills ?? []).map((b) => ({
                        value: b.id,
                        label: b.internalNo,
                        sublabel: b.vendorInvoiceNo,
                        meta: formatINR(b.balancePaise),
                      }))}
                      value={billId}
                      onChange={setBillId}
                      placeholder="Standalone"
                      searchPlaceholder="Search bills"
                      showAvatar={false}
                      clearable
                    />
                  </Field>
                  <Field label="Reason" required>
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
                    <Field label="GST rate" hint="Match the original bill">
                      <Combobox
                        options={RATE_OPTIONS}
                        value={String(gstRate)}
                        onChange={(v) => setGstRate(Number(v))}
                        showAvatar={false}
                      />
                    </Field>
                  </div>
                  <div className="flex items-start justify-between gap-3 rounded-md border p-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">Input credit was claimed on this cost</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        Turn this off for a blocked or reverse-charge purchase, where the tax was never put in
                        the credit pot to begin with.
                      </p>
                    </div>
                    <Switch checked={itcClaimed} onCheckedChange={setItcClaimed} />
                  </div>
                  <div className="flex items-center justify-between rounded-md border bg-muted/30 px-3 py-2 text-sm">
                    <span className="text-muted-foreground">Credit incl. GST</span>
                    <Money
                      value={amount + Math.round((amount * gstRate) / 100)}
                      className="font-semibold"
                    />
                  </div>
                  {create.error && <p className="text-sm text-destructive">{create.error}</p>}
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
                  <Button onClick={save} disabled={create.busy}>
                    {create.busy ? 'Saving…' : 'Record credit'}
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
              title="No vendor credits"
              description="Record one when a supplier short-ships, over-bills, or takes goods back."
            />
          ) : (
            <DataTable
              rows={d.documents}
              columns={columns}
              getRowId={(r) => r.id}
              initialSort={{ key: 'date', dir: 'desc' }}
              dateFilter={{ getDate: (r) => r.date }}
              searchPlaceholder="Search credit or vendor…"
            />
          )
        }
      </AsyncPage>
    </>
  );
}
