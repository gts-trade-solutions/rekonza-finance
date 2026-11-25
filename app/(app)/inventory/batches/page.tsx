'use client';

// Stock by batch, with what has expired and what is about to. Expired stock is
// written off with an adjustment of the reason "expiry", batch by batch.
//
// Each batch has Edit and Delete (services/stock-changes.ts): Edit corrects
// the number or the dates printed on the pack, and every document naming the
// batch follows; Delete is for a batch no document names any more — one left
// over after its bill was changed — which is why used-up batches can be shown.

import { useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { PageHeader } from '@/components/shared/page-header';
import { DataTable, type Column } from '@/components/shared/data-table';
import { AsyncPage, LoadingRows } from '@/components/shared/async-state';
import { Field } from '@/components/shared/form-bits';
import { DeleteConfirmDialog, RowActions } from '@/components/shared/row-actions';
import { api } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';
import { downloadWorkbook } from '@/lib/xlsx';

interface Batch { batchId: string; itemId: string; itemName: string; batchNo: string; mfgDate: string | null; expiryDate: string | null; qty: number }

const fmt = (iso: string | null) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const daysTo = (iso: string, from: string) => Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

export default function BatchesPage() {
  const canEdit = usePermission('inventory', 'edit');
  // Every batch, used up or not: the filters below choose what is shown.
  const state = useApi<{ asOf: string; batches: Batch[] }>(() => api.get('/api/batches', { all: '1' }), []);
  const [show, setShow] = useState<'all' | 'expired' | '30' | '90' | 'empty'>('all');
  const [editing, setEditing] = useState<Batch | null>(null);
  const [deleting, setDeleting] = useState<Batch | null>(null);
  return (
    <>
      <PageHeader title="Batches & expiry" description="Stock by batch, earliest to expire first. Write off expired stock with an adjustment of the reason “expiry”." />
      <AsyncPage state={state} loading={<LoadingRows rows={8} />}>
        {(d) => {
          const status = (b: Batch) => {
            if (!b.expiryDate) return { key: 'none', label: 'No expiry', tone: 'text-muted-foreground', days: Infinity };
            const n = daysTo(b.expiryDate, d.asOf);
            if (n < 0) return { key: 'expired', label: `Expired ${-n} day${n === -1 ? '' : 's'} ago`, tone: 'border-red-500/40 text-red-700 dark:text-red-300', days: n };
            if (n <= 30) return { key: '30', label: `${n} day${n === 1 ? '' : 's'} left`, tone: 'border-amber-500/40 text-amber-700 dark:text-amber-300', days: n };
            if (n <= 90) return { key: '90', label: `${n} days left`, tone: 'border-yellow-500/40 text-yellow-700 dark:text-yellow-300', days: n };
            return { key: 'ok', label: `${n} days left`, tone: 'text-muted-foreground', days: n };
          };
          const inStock = d.batches.filter((b) => b.qty > 0);
          const empty = d.batches.filter((b) => b.qty <= 0);
          const rows = show === 'empty' ? empty : inStock.filter((b) => {
            const s = status(b);
            return show === 'all' || (show === 'expired' && s.key === 'expired') || (show === '30' && s.days <= 30) || (show === '90' && s.days <= 90);
          });
          const count = (k: (b: Batch) => boolean) => inStock.filter(k).length;
          const cols: Column<Batch>[] = [
            { key: 'item', header: 'Item', sortValue: (r) => r.itemName, cell: (r) => <span className="font-medium">{r.itemName}</span> },
            { key: 'batch', header: 'Batch', sortValue: (r) => r.batchNo, cell: (r) => <span className="font-mono text-xs">{r.batchNo}</span> },
            { key: 'mfg', header: 'Made', sortValue: (r) => r.mfgDate ?? '', cell: (r) => <span className="text-xs">{fmt(r.mfgDate)}</span> },
            { key: 'exp', header: 'Expires', sortValue: (r) => r.expiryDate ?? '9999', cell: (r) => <span className="text-xs">{fmt(r.expiryDate)}</span> },
            { key: 'status', header: '', cell: (r) => { const s = status(r); return <Badge variant="outline" className={`text-[10px] ${s.tone}`}>{s.label}</Badge>; } },
            { key: 'qty', header: 'In stock', align: 'right', sortValue: (r) => r.qty, cell: (r) => <span className="tabular-nums">{r.qty}</span> },
            {
              key: 'actions', header: '', align: 'right',
              cell: (r) => (canEdit ? (
                <RowActions onEdit={() => setEditing(r)} onDelete={() => setDeleting(r)}
                  editTitle="Correct the batch number or its dates" deleteTitle="Delete a batch no document names" />
              ) : null),
            },
          ];
          return (
            <div className="space-y-4">
              <Card className="flex flex-wrap items-center gap-2 p-3">
                {([['all', `All (${inStock.length})`], ['expired', `Expired (${count((b) => status(b).key === 'expired')})`],
                  ['30', `Within 30 days (${count((b) => status(b).days <= 30)})`], ['90', `Within 90 days (${count((b) => status(b).days <= 90)})`],
                  ['empty', `Used up (${empty.length})`]] as const).map(([k, label]) => (
                  <button key={k} type="button" onClick={() => setShow(k)} data-slot={`batch-filter-${k}`}
                    className={`rounded px-2.5 py-1 text-xs ${show === k ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`}>{label}</button>
                ))}
                <Button size="sm" variant="outline" className="ml-auto gap-1.5" onClick={() => downloadWorkbook(`batches-${d.asOf}.xlsx`, [{
                  name: 'Batches', rows: [['Item', 'Batch', 'Made', 'Expires', 'In stock'], ...rows.map((b) => [b.itemName, b.batchNo, b.mfgDate ?? '', b.expiryDate ?? '', b.qty])],
                }])}><Download className="size-3.5" /> Excel</Button>
              </Card>
              <DataTable rows={rows} columns={cols} getRowId={(r) => r.batchId} searchPlaceholder="Search item or batch…"
                emptyMessage={show === 'empty' ? 'No used-up batches.' : 'No batch stock. Turn on batch tracking for an item, then name the batch on each purchase.'} />
            </div>
          );
        }}
      </AsyncPage>

      <EditBatch batch={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void state.refetch(); }} />
      <DeleteConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => { if (!o) setDeleting(null); }}
        title={`Delete batch ${deleting?.batchNo ?? ''} of ${deleting?.itemName ?? ''}?`}
        description="Only a batch no bill, receipt, invoice, credit note or adjustment names can go: one left over after its documents were changed. A batch still named on a document stays with it."
        withReason={false}
        onConfirm={() => api.delete(`/api/batches/${deleting!.batchId}`)}
        doneMessage={`Batch ${deleting?.batchNo ?? ''} deleted`}
        onDone={() => void state.refetch()}
      />
    </>
  );
}

/** Correct a batch: its number and the dates on the pack. */
function EditBatch({ batch, onClose, onSaved }: { batch: Batch | null; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ batchNo: '', mfgDate: '', expiryDate: '' });
  const [shown, setShown] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (batch && batch.batchId !== shown) {
    setShown(batch.batchId);
    setF({ batchNo: batch.batchNo, mfgDate: batch.mfgDate ?? '', expiryDate: batch.expiryDate ?? '' });
    setError(null);
  }
  if (!batch && shown) setShown(null);
  const save = async () => {
    if (!batch) return;
    setBusy(true); setError(null);
    try {
      await api.put(`/api/batches/${batch.batchId}`, { batchNo: f.batchNo.trim(), mfgDate: f.mfgDate || null, expiryDate: f.expiryDate || null });
      toast.success(`Batch ${f.batchNo.trim()} saved`, { description: 'Every document that names it shows it as corrected.' });
      onSaved();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      toast.error('Not saved', { description: message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={!!batch} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-md" data-slot="batch-edit">
        <DialogHeader>
          <DialogTitle>Edit batch {batch?.batchNo} of {batch?.itemName}</DialogTitle>
          <DialogDescription>As printed on the pack. The bills, invoices and adjustments that name this batch show the corrected number and dates.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Batch no." required className="sm:col-span-2">
            <Input value={f.batchNo} onChange={(e) => setF({ ...f, batchNo: e.target.value })} maxLength={40} className="font-mono" data-slot="batch-edit-no" />
          </Field>
          <Field label="Made"><Input type="date" value={f.mfgDate} onChange={(e) => setF({ ...f, mfgDate: e.target.value })} /></Field>
          <Field label="Expires"><Input type="date" value={f.expiryDate} onChange={(e) => setF({ ...f, expiryDate: e.target.value })} data-slot="batch-edit-expiry" /></Field>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void save()} disabled={busy || !f.batchNo.trim()} className="gap-1.5" data-slot="batch-edit-save">
            {busy && <Loader2 className="size-3.5 animate-spin" />} Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
