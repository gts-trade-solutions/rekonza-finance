'use client';

// Retainer invoices — advances collected before the work is done.
//
// The accounting point here is worth being explicit about. When a customer pays
// up front you have their money but you have not earned it: you owe them the
// work. So the receipt increases the bank *and* a liability called Unearned
// Revenue. Only when you deliver and raise the real invoice does any of it
// become income. Booking it as income on the day it arrives would overstate
// both the profit and the GST due on it.

import { useState } from 'react';
import { HandCoins, Info, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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

const today = () => new Date().toISOString().slice(0, 10);
const short = (d: string) => new Date(d).toLocaleDateString('en-IN');

export default function RetainersPage() {
  const canCreate = usePermission('sales', 'create');
  const branchId = useAppStore((s) => s.activeBranchId);

  const state = useApi<SalesDocListResponse>(() => salesDocuments.list('retainer'), []);

  const [open, setOpen] = useState(false);
  const [customerId, setCustomerId] = useState('');
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState(0);

  const [applying, setApplying] = useState<SalesDocRow | null>(null);
  const [invoiceId, setInvoiceId] = useState('');

  const create = useApiAction(salesDocuments.create);
  const apply = useApiAction(salesDocuments.applyRetainer);

  // Only the invoices of the customer whose advance is being spent.
  const theirInvoices = useApi(
    async () =>
      applying
        ? invoicesApi.list({ customerId: applying.customerId, open: true, limit: 100 })
        : { invoices: [] as never[] },
    [applying?.customerId],
  );

  const save = async () => {
    if (!customerId || !description.trim() || amount <= 0) {
      toast.error('Pick a customer, say what it covers, and enter an amount.');
      return;
    }
    const result = await create.run({
      kind: 'retainer',
      branchId,
      customerId,
      date: today(),
      description: description.trim(),
      amountPaise: amount,
      status: 'sent',
    });
    if (!result) return;
    toast.success(`Retainer ${result.number} raised`, {
      description: 'Held as unearned revenue — a liability, not income, until the work is done.',
    });
    setOpen(false);
    setCustomerId('');
    setDescription('');
    setAmount(0);
    state.refetch();
  };

  const doApply = async () => {
    if (!applying || !invoiceId) return;
    const done = await apply.run(applying.id, invoiceId);
    if (!done) {
      toast.error(apply.error ?? 'Could not apply that retainer');
      return;
    }
    toast.success(`${formatINR(done.appliedPaise)} applied`, {
      description: 'That much has now been earned and moves out of unearned revenue.',
    });
    setApplying(null);
    setInvoiceId('');
    state.refetch();
  };

  const columns: Column<SalesDocRow>[] = [
    { key: 'number', header: 'Retainer #', sortValue: (r) => r.number, cell: (r) => <span className="font-medium">{r.number}</span> },
    { key: 'customer', header: 'Customer', sortValue: (r) => r.customerName, cell: (r) => r.customerName },
    {
      key: 'desc', header: 'Description', sortValue: (r) => r.detail ?? '',
      cell: (r) => <span className="text-sm text-muted-foreground">{r.detail}</span>,
    },
    { key: 'date', header: 'Date', sortValue: (r) => r.date, cell: (r) => short(r.date) },
    { key: 'status', header: 'Status', sortValue: (r) => r.status, cell: (r) => <StatusBadge status={r.status} /> },
    {
      key: 'paid', header: 'Received', align: 'right',
      sortValue: (r) => r.paidPaise ?? 0,
      cell: (r) => <Money value={r.paidPaise ?? 0} showZero={false} />,
    },
    {
      key: 'applied', header: 'Earned', align: 'right',
      sortValue: (r) => r.appliedPaise ?? 0,
      cell: (r) => <Money value={r.appliedPaise ?? 0} showZero={false} />,
    },
    { key: 'amount', header: 'Amount', align: 'right', sortValue: (r) => r.totalPaise, cell: (r) => <Money value={r.totalPaise} className="font-medium" /> },
    {
      key: 'actions', header: '', align: 'right',
      cell: (r) => {
        const spendable = (r.paidPaise ?? 0) - (r.appliedPaise ?? 0);
        if (!canCreate || r.status === 'void') return null;
        if ((r.paidPaise ?? 0) <= 0) {
          return <span className="text-xs text-muted-foreground">Awaiting payment</span>;
        }
        if (spendable <= 0) return <span className="text-xs text-muted-foreground">Fully earned</span>;
        return (
          <Button
            variant="outline"
            size="xs"
            onClick={() => { setApplying(r); setInvoiceId(''); }}
          >
            Apply to invoice
          </Button>
        );
      },
    },
  ];

  return (
    <>
      <PageHeader
        title="Retainer invoices"
        description="Advances collected before work is done."
        actions={
          canCreate && (
            <Dialog open={open} onOpenChange={setOpen}>
              <DialogTrigger asChild>
                <Button size="sm" className="gap-1.5"><Plus className="size-4" /> New retainer</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>New retainer</DialogTitle>
                  <DialogDescription>
                    Bill an advance. It is held as a liability until the work behind it is delivered.
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-4">
                  <Field label="Customer" required>
                    <ContactPicker
                      kind="customer"
                      value={customerId}
                      onChange={setCustomerId}
                      canCreate={canCreate}
                    />
                  </Field>
                  <Field label="What it covers" required hint="Appears on the retainer and in the ledger memo">
                    <Input
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      placeholder="What this retainer is for"
                    />
                  </Field>
                  <Field label="Amount" required>
                    <MoneyInput valuePaise={amount} onChangePaise={setAmount} />
                  </Field>
                  {create.error && <p className="text-sm text-destructive">{create.error}</p>}
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
                  <Button onClick={save} disabled={create.busy}>
                    {create.busy ? 'Saving…' : 'Raise retainer'}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          )
        }
      />

      <Card className="flex items-start gap-3 border-primary/30 bg-primary/5 p-4">
        <Info className="mt-0.5 size-4 shrink-0 text-primary" />
        <div className="text-sm">
          <p className="font-medium">Why advances are not income</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            When a customer pays up front you have their money but haven&apos;t earned it yet — you owe them the work.
            So the receipt increases your bank <em>and</em> a liability called{' '}
            <span className="font-medium text-foreground">Unearned Revenue</span>. Only when you deliver and raise
            the real invoice does it become income. Booking it as income immediately would overstate your profit and
            your GST.
          </p>
        </div>
      </Card>

      <AsyncPage state={state}>
        {(d) =>
          d.documents.length === 0 ? (
            <EmptyState
              icon={HandCoins}
              title="No retainers"
              description="Collect an advance and it will be held as a liability until you invoice against it."
            />
          ) : (
            <DataTable
              rows={d.documents}
              columns={columns}
              getRowId={(r) => r.id}
              initialSort={{ key: 'date', dir: 'desc' }}
              dateFilter={{ getDate: (r) => r.date }}
              searchPlaceholder="Search retainer or customer…"
            />
          )
        }
      </AsyncPage>

      <Dialog open={!!applying} onOpenChange={(v) => !v && setApplying(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Apply {applying?.number}</DialogTitle>
            <DialogDescription>
              Setting the advance against a real invoice is the moment it is earned — it moves out of unearned
              revenue and settles the invoice by that much.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="flex items-center justify-between rounded-md border bg-muted/30 px-3 py-2 text-sm">
              <span className="text-muted-foreground">Available to apply</span>
              <Money
                value={(applying?.paidPaise ?? 0) - (applying?.appliedPaise ?? 0)}
                className="font-semibold"
              />
            </div>
            <Field label="Invoice" required hint="Only this customer's unpaid invoices">
              <Combobox
                options={(theirInvoices.data?.invoices ?? []).map((i) => ({
                  value: i.id,
                  label: i.number,
                  sublabel: short(i.date),
                  meta: formatINR(i.balancePaise),
                }))}
                value={invoiceId}
                onChange={setInvoiceId}
                placeholder="Select an invoice"
                searchPlaceholder="Search invoices"
                showAvatar={false}
              />
            </Field>
            {apply.error && <p className="text-sm text-destructive">{apply.error}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setApplying(null)}>Cancel</Button>
            <Button onClick={doApply} disabled={apply.busy || !invoiceId}>
              {apply.busy ? 'Applying…' : 'Apply'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
