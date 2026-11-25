'use client';

// Stock adjustments.
//
// Everything else that moves stock has a document behind it — a bill brought
// it in, an invoice sent it out. An adjustment is what is left: breakage,
// theft, a stocktake correction, samples given away. Those have no document,
// so they are recorded here.
//
// Writing stock off is a real loss and posts like one: the value leaves the
// inventory asset and lands in write-offs. Most stock screens skip that, and
// skipping it leaves the balance sheet carrying inventory that is not there.

import { FoldNav } from '@/components/layout/nav-state';
import { useCallback, useEffect, useState } from 'react';
import { ClipboardList, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Combobox } from '@/components/ui/combobox';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import { PageHeader } from '@/components/shared/page-header';
import { DataTable, type Column } from '@/components/shared/data-table';
import { Money } from '@/components/shared/money';
import { EmptyState } from '@/components/shared/empty-state';
import { AsyncPage } from '@/components/shared/async-state';
import { Field } from '@/components/shared/form-bits';
import { DeleteConfirmDialog, RowActions, withReasonQuery } from '@/components/shared/row-actions';
import {
  api, inventory, type StockAdjustmentRow, type StockResponse, type WarehouseRow,
} from '@/lib/api/client';
import { toastWarnings } from '@/lib/api/warnings';
import { useApi, useApiAction } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';
import { useAppStore } from '@/lib/store';

const REASONS = [
  { value: 'stocktake', label: 'Stocktake correction' },
  { value: 'damage', label: 'Damaged' },
  { value: 'theft', label: 'Theft or loss' },
  { value: 'expiry', label: 'Expired' },
  { value: 'issued', label: 'Issued for use (consumed in the business)' },
  { value: 'sample', label: 'Given away as a sample' },
  { value: 'opening', label: 'Opening stock' },
  { value: 'other', label: 'Other' },
];

const today = () => new Date().toISOString().slice(0, 10);

const BLANK = { itemId: '', warehouseId: '', date: today(), qtyDelta: -1, reason: 'stocktake', notes: '', batchNo: '', expiryDate: '', serials: '' };

export default function StockAdjustmentsPage() {
  const canEdit = usePermission('inventory', 'edit');

  const state = useApi<{ adjustments: StockAdjustmentRow[] }>(() => inventory.adjustments(), []);
  const stock = useApi<StockResponse>(() => inventory.stock(), []);
  const warehouses = useApi<{ warehouses: WarehouseRow[] }>(() => inventory.warehouses(), []);

  const [open, setOpen] = useState(false);
  const [f, setF] = useState(BLANK);
  // Zoho's Edit: the same window, filled with the adjustment as entered (PUT /api/inventory/adjustments/[id]).
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<StockAdjustmentRow | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const adjust = useApiAction(inventory.adjust);

  const startEdit = useCallback(async (id: string) => {
    try {
      const a = await api.get<{
        itemId: string; warehouseId: string | null; date: string; qtyDelta: number; reason: string; notes: string | null;
        batch: { batchNo: string; expiryDate: string | null } | null; serials: string[];
      }>(`/api/inventory/adjustments/${id}`);
      setF({
        itemId: a.itemId, warehouseId: a.warehouseId ?? '', date: a.date, qtyDelta: a.qtyDelta, reason: a.reason, notes: a.notes ?? '',
        batchNo: a.batch?.batchNo ?? '', expiryDate: a.batch?.expiryDate ?? '', serials: a.serials.join('\n'),
      });
      setEditError(null);
      setEditingId(id);
      setOpen(true);
    } catch (e) {
      toast.error('That adjustment could not be opened', { description: e instanceof Error ? e.message : String(e) });
    }
  }, []);
  // ?edit=<id> (a ledger or stock screen pointing here): open that adjustment's Edit window.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('edit');
    if (id && canEdit) void startEdit(id);
  }, [canEdit, startEdit]);
  const closeDialog = (o: boolean) => {
    setOpen(o);
    if (!o) { setEditingId(null); setF(BLANK); setEditError(null); }
  };

  const picked = stock.data?.items.find((i) => i.itemId === f.itemId);
  // Batch- and serial-tracked items say which batch, and which pieces.
  const master = useAppStore((s) => s.items).find((i) => i.id === f.itemId);
  const serialList = f.serials.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);

  const save = async () => {
    if (!f.itemId || f.qtyDelta === 0) {
      toast.error('Pick an item and a quantity that is not zero.');
      return;
    }
    if (master?.trackBatches && !f.batchNo.trim()) {
      toast.error('Say which batch.');
      return;
    }
    const payload = {
      itemId: f.itemId,
      warehouseId: f.warehouseId || null,
      date: f.date,
      qtyDelta: f.qtyDelta,
      reason: f.reason,
      notes: f.notes || null,
      batch: master?.trackBatches ? { batchNo: f.batchNo.trim(), expiryDate: f.expiryDate || null } : null,
      serials: master?.trackSerials && serialList.length ? serialList : null,
    };
    if (editingId) {
      setSavingEdit(true);
      setEditError(null);
      try {
        const r = await api.put<{ warnings?: string[] }>(`/api/inventory/adjustments/${editingId}`, payload);
        toastWarnings(r);
        toast.success('Adjustment changed', { description: 'The stock figures now count it as edited.' });
        closeDialog(false);
        state.refetch();
        stock.refetch();
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        setEditError(message);
        toast.error('Not saved', { description: message });
      } finally {
        setSavingEdit(false);
      }
      return;
    }
    const done = await adjust.run(payload);
    if (!done) {
      toast.error(adjust.error ?? 'The adjustment was not recorded');
      return;
    }
    toast.success('Stock adjusted', {
      description: done.journalEntryId
        ? `Value of ${(done.valuePaise / 100).toLocaleString('en-IN')} posted to the ledger.`
        : 'Quantity only — this item carries no cost, so nothing moved in the ledger.',
    });
    setOpen(false);
    setF(BLANK);
    state.refetch();
    stock.refetch();
  };

  const columns: Column<StockAdjustmentRow>[] = [
    {
      key: 'date', header: 'Date', sortValue: (r) => r.date,
      cell: (r) => <span className="tabular text-xs">{new Date(r.date).toLocaleDateString('en-IN')}</span>,
    },
    {
      key: 'item', header: 'Item', sortValue: (r) => r.itemName,
      cell: (r) => (
        <div>
          <p className="font-medium">{r.itemName}</p>
          <p className="text-xs text-muted-foreground">{r.sku ?? '—'}</p>
        </div>
      ),
    },
    {
      key: 'warehouse', header: 'Warehouse', sortValue: (r) => r.warehouseName ?? '',
      cell: (r) => <span className="text-sm text-muted-foreground">{r.warehouseName ?? '—'}</span>,
    },
    {
      key: 'reason', header: 'Reason', sortValue: (r) => r.reason,
      cell: (r) => (
        <Badge variant="secondary" className="text-[10px] capitalize">{r.reason.replaceAll('_', ' ')}</Badge>
      ),
    },
    {
      key: 'note', header: 'Note', sortValue: (r) => r.notes ?? '',
      cell: (r) => <span className="text-xs text-muted-foreground">{r.notes ?? '—'}</span>,
    },
    {
      key: 'qty', header: 'Quantity', align: 'right', sortValue: (r) => r.qtyDelta,
      cell: (r) => (
        <span className={'tabular font-medium ' + (r.qtyDelta < 0 ? 'text-destructive' : '')}>
          {r.qtyDelta > 0 ? '+' : ''}{r.qtyDelta} <span className="text-xs font-normal">{r.uqc.toLowerCase()}</span>
        </span>
      ),
    },
    {
      key: 'value', header: 'Value', align: 'right', sortValue: (r) => r.valuePaise,
      cell: (r) => <Money value={r.valuePaise} colored />,
    },
    {
      key: 'actions', header: '', align: 'right',
      cell: (r) => (canEdit ? (
        <RowActions onEdit={() => void startEdit(r.id)} onDelete={() => setDeleting(r)}
          editTitle="Edit this adjustment" deleteTitle="Delete this adjustment" />
      ) : null),
    },
  ];

  return (
    <>
      <PageHeader
        title="Inventory Adjustments"
        description="Breakage, theft, stocktake corrections — the movements no document explains."
        actions={
          canEdit && (
            <Dialog open={open} onOpenChange={closeDialog}>
              <DialogTrigger asChild>
                <Button size="sm" className="gap-1.5" onClick={() => { setEditingId(null); setF(BLANK); }}><Plus className="size-4" /> Adjust stock</Button>
              </DialogTrigger>
              <DialogContent data-slot={editingId ? 'adjustment-edit' : 'adjustment-new'}>
                <DialogHeader>
                  <DialogTitle>{editingId ? 'Edit adjustment' : 'Adjust stock'}</DialogTitle>
                  <FoldNav />
                  <DialogDescription>
                    {editingId
                      ? 'Saved over the adjustment as it was: the stock figures count it as edited, from its date. Refused if goods it brought in have been used since.'
                      : 'A negative quantity writes stock off and posts the loss. A positive one corrects it upward.'}
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-4">
                  <Field label="Item" required>
                    <Combobox
                      options={(stock.data?.items ?? []).map((i) => ({
                        value: i.itemId,
                        label: i.name,
                        sublabel: i.sku ?? undefined,
                        meta: `${i.qty} ${i.uqc.toLowerCase()}`,
                      }))}
                      value={f.itemId}
                      onChange={(v) => setF({ ...f, itemId: v })}
                      placeholder="Select an item"
                      searchPlaceholder="Search items"
                      showAvatar={false}
                    />
                  </Field>
                  {(warehouses.data?.warehouses.length ?? 0) > 0 && (
                    <Field label="Warehouse">
                      <Combobox
                        options={(warehouses.data?.warehouses ?? []).map((w) => ({
                          value: w.id,
                          label: w.name,
                          sublabel: w.code ?? undefined,
                        }))}
                        value={f.warehouseId}
                        onChange={(v) => setF({ ...f, warehouseId: v })}
                        placeholder="Not specified"
                        searchPlaceholder="Search warehouses"
                        showAvatar={false}
                        clearable
                      />
                    </Field>
                  )}
                  <div className="grid grid-cols-2 gap-4">
                    <Field label="Quantity change" required hint="Negative writes stock off">
                      <Input
                        type="number"
                        value={f.qtyDelta}
                        onChange={(e) => setF({ ...f, qtyDelta: Number(e.target.value) || 0 })}
                      />
                    </Field>
                    <Field label="Date" required>
                      <Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
                    </Field>
                  </div>
                  <Field label="Reason" required>
                    <Combobox
                      options={REASONS}
                      value={f.reason}
                      onChange={(v) => setF({ ...f, reason: v })}
                      showAvatar={false}
                    />
                  </Field>
                  <Field label="Note" hint="What happened, for whoever reads this at year end">
                    <Input
                      value={f.notes}
                      onChange={(e) => setF({ ...f, notes: e.target.value })}
                      placeholder="Why the quantity changed"
                    />
                  </Field>
                  {master?.trackBatches && (
                    <div className="grid grid-cols-2 gap-4">
                      <Field label="Batch no." required>
                        <Input value={f.batchNo} onChange={(e) => setF({ ...f, batchNo: e.target.value })} className="font-mono" />
                      </Field>
                      <Field label="Expires" hint="For a batch new to the books">
                        <Input type="date" value={f.expiryDate} onChange={(e) => setF({ ...f, expiryDate: e.target.value })} />
                      </Field>
                    </div>
                  )}
                  {master?.trackSerials && (
                    <Field label="Serial numbers" hint={`${serialList.length} of ${Math.abs(f.qtyDelta)} numbered, one per piece ${f.qtyDelta > 0 ? 'found' : 'written off'}.`}>
                      <textarea value={f.serials} onChange={(e) => setF({ ...f, serials: e.target.value })} rows={3}
                        placeholder="One per line, or separated by commas"
                        className="w-full rounded-md border border-input bg-background px-2 py-1.5 font-mono text-xs outline-none focus:border-ring" />
                    </Field>
                  )}

                  {picked && !editingId && (
                    <div className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
                      {picked.name}: {picked.qty} on hand → {picked.qty + f.qtyDelta} after this.
                      {picked.unitCostPaise > 0 && (
                        <>
                          {' '}Value{' '}
                          <Money
                            value={Math.abs(f.qtyDelta) * picked.unitCostPaise}
                            className="font-medium text-foreground"
                          />{' '}
                          {f.qtyDelta < 0 ? 'written off' : 'added back'}.
                        </>
                      )}
                    </div>
                  )}
                  {(editingId ? editError : adjust.error) && <p className="text-sm text-destructive">{editingId ? editError : adjust.error}</p>}
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => closeDialog(false)}>Cancel</Button>
                  <Button onClick={save} disabled={adjust.busy || savingEdit} data-slot="adjustment-save">
                    {adjust.busy || savingEdit ? 'Saving…' : editingId ? 'Save changes' : 'Record adjustment'}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          )
        }
      />

      <Card className="flex items-start gap-3 p-4">
        <ClipboardList className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <p className="text-xs leading-relaxed text-muted-foreground">
          Adjustments exist because physical stock and recorded stock drift apart — breakage, theft, counting
          errors, samples given away. Each one posts its value out of the inventory asset and into write-offs, so
          the stock figure on your balance sheet keeps matching what is actually on the shelf. Receipts and issues
          are not here: those come from bills and invoices, which are documents in their own right.
        </p>
      </Card>

      <AsyncPage state={state}>
        {(d) =>
          d.adjustments.length === 0 ? (
            <EmptyState
              icon={ClipboardList}
              title="No adjustments"
              description="Nothing has been written off or corrected. Receipts and issues live on the bills and invoices themselves."
            />
          ) : (
            <DataTable
              rows={d.adjustments}
              columns={columns}
              getRowId={(r) => r.id}
              initialSort={{ key: 'date', dir: 'desc' }}
              searchPlaceholder="Search item or note…"
              dateFilter={{ getDate: (r) => r.date }}
            />
          )
        }
      </AsyncPage>

      <DeleteConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => { if (!o) setDeleting(null); }}
        title={deleting ? `Delete the adjustment of ${deleting.qtyDelta > 0 ? '+' : ''}${deleting.qtyDelta} ${deleting.itemName}?` : 'Delete the adjustment?'}
        description="Its quantity comes off the stock figures, from its date, as if it had never been entered. Refused if goods it brought in have been sold or used since, or a numbered piece on it has moved. The audit trail keeps a copy of it."
        onConfirm={async (reason) => {
          const r = await api.delete<{ warnings?: string[] }>(withReasonQuery(`/api/inventory/adjustments/${deleting!.id}`, reason));
          toastWarnings(r);
        }}
        doneMessage="Adjustment deleted"
        onDone={() => { state.refetch(); stock.refetch(); }}
      />
    </>
  );
}
