'use client';

// Purchase orders — commitments to buy.
//
// Nothing here is a payable. A supplier is owed when they have supplied
// something and sent a bill, not when we said we would like some. Converting an
// order to a bill is the moment the debt becomes real and the ledger hears
// about it.

import { useState } from 'react';
import { ArrowRight, ClipboardList, PackageCheck, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Combobox } from '@/components/ui/combobox';
import { ContactPicker, QuickItemDialog } from '@/components/forms/quick-create';
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
import { orderFlow, purchaseDocuments, type PurchaseDocListResponse, type PurchaseDocRow } from '@/lib/api/client';
import { LinePickDialog } from '@/components/shared/line-pick-dialog';
import { useApi, useApiAction } from '@/lib/api/use-api';
import { useAppStore } from '@/lib/store';
import { usePermission } from '@/lib/store/hooks';
import { itemOptions } from '@/lib/options';
import { VoucherTypePicker } from '@/components/forms/voucher-type-picker';

const today = () => new Date().toISOString().slice(0, 10);
const short = (d: string | null) => (d ? new Date(d).toLocaleDateString('en-IN') : '—');

function inDays(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

export default function PurchaseOrdersPage() {
  const router = useRouter();
  const canCreate = usePermission('purchases', 'create');
  const branchId = useAppStore((s) => s.activeBranchId);
  const items = useAppStore((s) => s.items);

  const state = useApi<PurchaseDocListResponse>(() => purchaseDocuments.list('purchase-order'), []);

  const [open, setOpen] = useState(false);
  const [vendorId, setVendorId] = useState('');
  const [itemId, setItemId] = useState('');
  // Non-null while the inline "New item" dialog is open.
  const [newItemName, setNewItemName] = useState<string | null>(null);
  const [qty, setQty] = useState(1);
  const [rate, setRate] = useState(0);
  const [expected, setExpected] = useState('');

  // An order goes on line by line: goods in on a receipt note, or billed
  // straight off the order for services and goods not put through the store.
  const [step, setStep] = useState<{ row: PurchaseDocRow; to: 'receive' | 'bill' } | null>(null);
  const [vendorInvoiceNo, setVendorInvoiceNo] = useState('');
  const [vendorChallanNo, setVendorChallanNo] = useState('');
  const [stepDate, setStepDate] = useState(today());
  const [dueDate, setDueDate] = useState(inDays(30));
  const openStep = (row: PurchaseDocRow, to: 'receive' | 'bill') => {
    setVendorInvoiceNo(''); setVendorChallanNo(''); setStepDate(today()); setDueDate(inDays(30)); setStep({ row, to });
  };

  const create = useApiAction(purchaseDocuments.create);
  const [voucherTypeId, setVoucherTypeId] = useState('');

  const save = async () => {
    if (!vendorId || !itemId) {
      toast.error('Pick a vendor and an item.');
      return;
    }
    const result = await create.run({
      kind: 'purchase-order',
      branchId,
      vendorId,
      date: today(),
      expectedDate: expected || inDays(14),
      voucherTypeId: voucherTypeId || null,
      lines: [{ itemId, qty, ratePaise: rate }],
    });
    if (!result) return;
    toast.success(`${result.number} raised`, {
      description: 'Nothing posts yet — an order is a commitment, not a payable.',
    });
    setOpen(false);
    setVendorId('');
    setItemId('');
    setQty(1);
    setRate(0);
    state.refetch();
  };

  const columns: Column<PurchaseDocRow>[] = [
    { key: 'number', header: 'PO #', sortValue: (r) => r.number, cell: (r) => <span className="font-medium">{r.number}</span> },
    { key: 'vendor', header: 'Vendor', sortValue: (r) => r.vendorName, cell: (r) => r.vendorName },
    { key: 'date', header: 'Issued', sortValue: (r) => r.date, cell: (r) => short(r.date) },
    { key: 'expected', header: 'Expected', sortValue: (r) => r.expected ?? '', cell: (r) => short(r.expected) },
    { key: 'status', header: 'Status', sortValue: (r) => r.status, cell: (r) => <StatusBadge status={r.status} /> },
    {
      key: 'billed', header: 'Billed', align: 'right',
      sortValue: (r) => r.appliedPaise,
      cell: (r) => <Money value={r.appliedPaise} showZero={false} />,
    },
    { key: 'total', header: 'Order value', align: 'right', sortValue: (r) => r.totalPaise, cell: (r) => <Money value={r.totalPaise} className="font-medium" /> },
    {
      key: 'actions', header: '', align: 'right',
      cell: (r) =>
        r.status === 'billed' ? (
          <span className="text-xs text-muted-foreground">Billed</span>
        ) : r.status === 'cancelled' ? (
          <span className="text-xs text-muted-foreground">Cancelled</span>
        ) : canCreate && r.status !== 'draft' && r.status !== 'closed' ? (
          <div className="flex justify-end gap-1.5">
            <Button size="xs" variant="outline" className="gap-1" onClick={() => openStep(r, 'receive')}>
              <PackageCheck className="size-3" /> Receive
            </Button>
            <Button size="xs" className="gap-1" onClick={() => openStep(r, 'bill')}>
              Record bill <ArrowRight className="size-3" />
            </Button>
          </div>
        ) : null,
    },
  ];

  return (
    <>
      <PageHeader
        title="Purchase orders"
        description="Commitments to buy. Nothing hits the ledger until the goods arrive and the bill is recorded."
        actions={
          canCreate && (
            <Dialog open={open} onOpenChange={setOpen}>
              <DialogTrigger asChild>
                <Button size="sm" className="gap-1.5"><Plus className="size-4" /> New purchase order</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>New purchase order</DialogTitle>
                  <DialogDescription>
                    Rates default to what you normally pay for the item, not what you sell it for.
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-4">
                  <VoucherTypePicker docType="PO" ordinary="Ordinary PO series" value={voucherTypeId} onChange={setVoucherTypeId} />
                  <Field label="Vendor" required>
                    <ContactPicker
                      kind="vendor"
                      value={vendorId}
                      onChange={setVendorId}
                      canCreate={canCreate}
                    />
                  </Field>
                  <Field label="Item" required>
                    <Combobox
                      options={itemOptions({ items } as never, 'purchase')}
                      value={itemId}
                      onChange={(v) => {
                        setItemId(v);
                        setRate(items.find((i) => i.id === v)?.purchasePricePaise ?? 0);
                      }}
                      placeholder="Select an item"
                      searchPlaceholder="Search items by name, SKU or HSN"
                      showAvatar={false}
                      createLabel={canCreate ? 'New item' : undefined}
                      onCreate={canCreate ? (q) => setNewItemName(q) : undefined}
                    />
                  </Field>
                  <div className="grid grid-cols-2 gap-4">
                    <Field label="Quantity">
                      <Input
                        type="number"
                        min="1"
                        value={qty}
                        onChange={(e) => setQty(Math.max(1, Number(e.target.value) || 1))}
                      />
                    </Field>
                    <Field label="Rate">
                      <MoneyInput valuePaise={rate} onChangePaise={setRate} />
                    </Field>
                  </div>
                  <Field label="Expected delivery">
                    <Input type="date" value={expected || inDays(14)} onChange={(e) => setExpected(e.target.value)} />
                  </Field>
                  {create.error && <p className="text-sm text-destructive">{create.error}</p>}
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
                  <Button onClick={save} disabled={create.busy}>
                    {create.busy ? 'Saving…' : 'Raise order'}
                  </Button>
                </DialogFooter>

                {/* The item is saved to the catalogue and then priced onto this order,
                    so its purchase price and HSN arrive exactly as a picked item's would. */}
                <QuickItemDialog
                  open={newItemName !== null}
                  onOpenChange={(o) => !o && setNewItemName(null)}
                  initialName={newItemName ?? ''}
                  priceMode="purchase"
                  onCreated={(item) => { setItemId(item.id); setRate(item.purchasePricePaise); }}
                />
              </DialogContent>
            </Dialog>
          )
        }
      />
      <AsyncPage state={state}>
        {(d) => (
          <>
            {d.summary.openPaise > 0 && (
              <p className="text-xs text-muted-foreground">
                <Money value={d.summary.openPaise} className="font-medium" /> on order and not yet billed —
                committed spend that is deliberately absent from the balance sheet.
              </p>
            )}
            {d.documents.length === 0 ? (
              <EmptyState
                icon={ClipboardList}
                title="No purchase orders"
                description="Raise a PO to formalise what you've ordered."
              />
            ) : (
              <DataTable
                rows={d.documents}
                columns={columns}
                getRowId={(r) => r.id}
                initialSort={{ key: 'date', dir: 'desc' }}
                dateFilter={{ getDate: (r) => r.date }}
                searchPlaceholder="Search order or vendor…"
              />
            )}
          </>
        )}
      </AsyncPage>

      <LinePickDialog
        open={!!step}
        onClose={() => setStep(null)}
        doc="purchase_order"
        docId={step?.row.id ?? null}
        use={step?.to === 'receive' ? 'move' : 'invoice'}
        editRate={step?.to === 'bill'}
        title={step?.to === 'receive' ? `Receive goods on ${step?.row.number}` : `Record bill for ${step?.row.number}`}
        description={step?.to === 'receive'
          ? "The goods come into stock now, at the order price. Bill them from Goods receipts when the supplier's invoice arrives."
          : "Goods already on a receipt note are billed from the note. A price above the order's holds the bill from payment until it is accepted."}
        submitLabel={step?.to === 'receive' ? 'Receive goods' : 'Record bill'}
        canSubmit={step?.to === 'receive' || !!vendorInvoiceNo.trim()}
        header={
          step?.to === 'receive' ? (
            <>
              <Field label="Received on"><Input type="date" value={stepDate} onChange={(e) => setStepDate(e.target.value)} /></Field>
              <Field label="Supplier's challan no."><Input value={vendorChallanNo} onChange={(e) => setVendorChallanNo(e.target.value)} /></Field>
            </>
          ) : (
            <>
              <Field label="Supplier's invoice number" required>
                <Input value={vendorInvoiceNo} onChange={(e) => setVendorInvoiceNo(e.target.value)} className="font-mono" />
              </Field>
              <Field label="Bill date"><Input type="date" value={stepDate} onChange={(e) => setStepDate(e.target.value)} /></Field>
              <Field label="Due date"><Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></Field>
            </>
          )
        }
        onSubmit={async (lines) => {
          if (!step) return;
          if (step.to === 'receive') {
            const done = await orderFlow.receive(step.row.id, { date: stepDate, vendorChallanNo: vendorChallanNo || null, lines });
            toast.success(`Goods received on ${done.number}`, { description: 'In stock now; bill it when the invoice arrives.' });
            void state.refetch();
            return;
          }
          const done = await orderFlow.billPurchaseOrder(step.row.id, { vendorInvoiceNo: vendorInvoiceNo.trim(), date: stepDate, dueDate, lines });
          if (done.heldForApproval) {
            toast.info(`Bill ${done.internalNo} saved for approval`, { description: 'A rule holds it until someone approves it; it posts then.' });
          } else if (done.match.status === 'exception') {
            toast.warning(`Bill ${done.internalNo} recorded, held from payment`, { description: done.match.note ?? undefined });
          } else {
            toast.success(`Bill ${done.internalNo} recorded`, { description: 'The payable is now on the books.' });
          }
          router.push(`/purchases/bills/${done.billId}`);
        }}
      />
    </>
  );
}
