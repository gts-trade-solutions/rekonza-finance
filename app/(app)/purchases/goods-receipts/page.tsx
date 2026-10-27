'use client';

// Goods receipt notes — goods in the store, bill to follow.
//
// The note brings the goods into stock the day they arrive and accrues their
// cost, so the profit is right before the supplier's invoice comes. The bill
// is then raised from the note: its quantity cannot exceed what was received,
// and a price above the order's holds it from payment until it is accepted.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, Ban, PackageCheck, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Combobox } from '@/components/ui/combobox';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { ContactPicker } from '@/components/forms/quick-create';
import { PageHeader } from '@/components/shared/page-header';
import { DataTable, type Column } from '@/components/shared/data-table';
import { Money } from '@/components/shared/money';
import { StatusBadge } from '@/components/shared/status-badge';
import { EmptyState } from '@/components/shared/empty-state';
import { AsyncPage } from '@/components/shared/async-state';
import { Field, MoneyInput } from '@/components/shared/form-bits';
import { LinePickDialog } from '@/components/shared/line-pick-dialog';
import { api, orderFlow, type GoodsReceiptRow } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { useAppStore } from '@/lib/store';
import { usePermission } from '@/lib/store/hooks';
import { itemOptions } from '@/lib/options';
import { GodownPicker } from '@/components/forms/godown-picker';

const today = () => new Date().toISOString().slice(0, 10);
const inDays = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const short = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString('en-IN');

export default function GoodsReceiptsPage() {
  const router = useRouter();
  const canCreate = usePermission('purchases', 'create');
  const canEdit = usePermission('purchases', 'edit');
  const items = useAppStore((s) => s.items);
  const state = useApi(() => orderFlow.receipts(), []);

  const [billing, setBilling] = useState<GoodsReceiptRow | null>(null);
  const [vendorInvoiceNo, setVendorInvoiceNo] = useState('');
  const [billDate, setBillDate] = useState(today());
  const [dueDate, setDueDate] = useState(inDays(30));

  const [creating, setCreating] = useState(false);
  const [vendorId, setVendorId] = useState('');
  const [itemId, setItemId] = useState('');
  const [qty, setQty] = useState(1);
  const [rate, setRate] = useState(0);
  const [challanNo, setChallanNo] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const grnBranch = useAppStore((s) => s.activeBranchId || s.branches[0]?.id || '');
  // A batch-tracked item is received into a batch, as it would be billed into one.
  const [batchNo, setBatchNo] = useState('');
  const [expiry, setExpiry] = useState('');
  const tracksBatches = !!items.find((i) => i.id === itemId)?.trackBatches;
  // A serial-tracked item names each piece as it arrives.
  const [serials, setSerials] = useState('');
  const tracksSerials = !!items.find((i) => i.id === itemId)?.trackSerials;
  const serialList = serials.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);
  const [busy, setBusy] = useState(false);

  const receive = async () => {
    if (!vendorId || !itemId || qty <= 0) {
      toast.error('Pick the vendor and the item, and the quantity received.');
      return;
    }
    if (tracksBatches && !batchNo.trim()) {
      toast.error('Give the batch number printed on the pack.');
      return;
    }
    setBusy(true);
    try {
      const done = await api.post<{ number: string }>('/api/goods-receipts', {
        vendorId, date: today(), vendorChallanNo: challanNo || null, warehouseId: warehouseId || null, lines: [{
          itemId, qty, ratePaise: rate, batch: tracksBatches ? { batchNo: batchNo.trim(), expiryDate: expiry || null } : null,
          serials: tracksSerials && serialList.length ? serialList : null,
        }],
      });
      toast.success(`Goods received on ${done.number}`);
      setCreating(false); setVendorId(''); setItemId(''); setQty(1); setRate(0); setChallanNo(''); setBatchNo(''); setExpiry(''); setSerials('');
      void state.refetch();
    } catch (e) {
      toast.error('Could not record it', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (r: GoodsReceiptRow) => {
    const reason = window.prompt(`Cancel ${r.number}? The goods leave stock and the accrual is reversed. Give a reason.`);
    if (reason === null) return;
    try {
      await orderFlow.cancelReceipt(r.id, reason || undefined);
      toast.success(`${r.number} cancelled`);
      void state.refetch();
    } catch (e) {
      toast.error('Could not cancel it', { description: e instanceof Error ? e.message : String(e) });
    }
  };

  const columns: Column<GoodsReceiptRow>[] = [
    { key: 'number', header: 'Receipt #', sortValue: (r) => r.number, cell: (r) => <span className="font-medium">{r.number}</span> },
    { key: 'vendor', header: 'Vendor', sortValue: (r) => r.vendorName, cell: (r) => r.vendorName },
    { key: 'date', header: 'Received', sortValue: (r) => r.date, cell: (r) => short(r.date) },
    { key: 'po', header: 'Order', sortValue: (r) => r.poNumber ?? '', cell: (r) => <span className="text-xs">{r.poNumber ?? '—'}</span> },
    { key: 'challan', header: "Supplier's challan", sortValue: (r) => r.vendorChallanNo ?? '', cell: (r) => <span className="text-xs text-muted-foreground">{r.vendorChallanNo ?? '—'}</span> },
    { key: 'status', header: 'Status', sortValue: (r) => r.status, cell: (r) => <StatusBadge status={r.status as never} /> },
    { key: 'total', header: 'Value', align: 'right', sortValue: (r) => r.totalPaise, cell: (r) => <Money value={r.totalPaise} /> },
    {
      key: 'actions', header: '', align: 'right',
      cell: (r) => (
        <div className="flex justify-end gap-1.5">
          {canEdit && r.status === 'open' && (
            <Button size="xs" variant="ghost" className="gap-1" onClick={() => void cancel(r)}>
              <Ban className="size-3" /> Cancel
            </Button>
          )}
          {canCreate && (r.status === 'open' || r.status === 'partially_billed') && (
            <Button size="xs" className="gap-1" onClick={() => {
              setVendorInvoiceNo(''); setBillDate(today()); setDueDate(inDays(30)); setBilling(r);
            }}>
              Record bill <ArrowRight className="size-3" />
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Goods receipts"
        description="Goods received and in stock, waiting for — or matched to — the supplier's bill."
        actions={canCreate && (
          <Button size="sm" className="gap-1.5" onClick={() => setCreating(true)}>
            <Plus className="size-4" /> Receive goods
          </Button>
        )}
      />
      <AsyncPage state={state}>
        {(d) =>
          d.receipts.length === 0 ? (
            <EmptyState
              icon={PackageCheck}
              title="No goods received yet"
              description="Receive goods against a purchase order, or record a delivery that came without one."
            />
          ) : (
            <DataTable
              rows={d.receipts}
              columns={columns}
              getRowId={(r) => r.id}
              initialSort={{ key: 'date', dir: 'desc' }}
              dateFilter={{ getDate: (r) => r.date }}
              searchPlaceholder="Search receipt, vendor or order…"
            />
          )
        }
      </AsyncPage>

      <LinePickDialog
        open={!!billing}
        onClose={() => setBilling(null)}
        doc="goods_receipt"
        docId={billing?.id ?? null}
        use="invoice"
        editRate
        title={`Record bill for ${billing?.number ?? ''}`}
        description="Enter the supplier's invoice. It cannot be for more than was received; a price above the order's holds it from payment."
        submitLabel="Record bill"
        canSubmit={!!vendorInvoiceNo.trim()}
        header={
          <>
            <Field label="Supplier's invoice number" required>
              <Input value={vendorInvoiceNo} onChange={(e) => setVendorInvoiceNo(e.target.value)} className="font-mono" />
            </Field>
            <Field label="Bill date"><Input type="date" value={billDate} onChange={(e) => setBillDate(e.target.value)} /></Field>
            <Field label="Due date"><Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></Field>
          </>
        }
        onSubmit={async (lines) => {
          if (!billing) return;
          const done = await orderFlow.billReceipt(billing.id, { vendorInvoiceNo: vendorInvoiceNo.trim(), date: billDate, dueDate, lines });
          if (done.heldForApproval) {
            toast.info(`Bill ${done.internalNo} saved for approval`, { description: 'A rule holds it until someone approves it; it posts then.' });
          } else if (done.match.status === 'exception') {
            toast.warning(`Bill ${done.internalNo} recorded, held from payment`, { description: done.match.note ?? undefined });
          } else {
            toast.success(`Bill ${done.internalNo} recorded`, { description: 'It agrees with the order and the receipt.' });
          }
          router.push(`/purchases/bills/${done.billId}`);
        }}
      />

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Receive goods</DialogTitle>
            <DialogDescription>
              For a delivery with no purchase order. Goods ordered on one are received from Purchase orders, so the
              order keeps count.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <Field label="Vendor" required>
              <ContactPicker kind="vendor" value={vendorId} onChange={setVendorId} />
            </Field>
            <Field label="Item" required>
              <Combobox
                options={itemOptions({ items } as never, 'purchase')}
                value={itemId}
                onChange={(v) => { setItemId(v); setRate(items.find((i) => i.id === v)?.purchasePricePaise ?? 0); }}
                placeholder="Select an item"
                showAvatar={false}
              />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Quantity received">
                <Input type="number" min="0" step="any" value={qty} onChange={(e) => setQty(Number(e.target.value) || 0)} />
              </Field>
              <Field label="Rate" hint="Until the bill gives the real price.">
                <MoneyInput valuePaise={rate} onChangePaise={setRate} />
              </Field>
            </div>
            {tracksBatches && (
              <div className="grid grid-cols-2 gap-4">
                <Field label="Batch no." required><Input value={batchNo} onChange={(e) => setBatchNo(e.target.value)} className="font-mono" /></Field>
                <Field label="Expires"><Input type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} /></Field>
              </div>
            )}
            {tracksSerials && (
              <Field label="Serial numbers" hint={`${serialList.length} of ${qty} numbered. One per line, or separated by commas.`}>
                <textarea value={serials} onChange={(e) => setSerials(e.target.value)} rows={3}
                  className="w-full rounded-md border border-input bg-background px-2 py-1.5 font-mono text-xs outline-none focus:border-ring" />
              </Field>
            )}
            <GodownPicker branchId={grnBranch} value={warehouseId} onChange={setWarehouseId} />
            <Field label="Supplier's challan no.">
              <Input value={challanNo} onChange={(e) => setChallanNo(e.target.value)} />
            </Field>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreating(false)}>Cancel</Button>
            <Button onClick={() => void receive()} disabled={busy}>{busy ? 'Saving…' : 'Receive goods'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
