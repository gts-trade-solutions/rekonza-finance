'use client';

// Stock transfers between godowns: dispatched, in transit, received. Moving
// goods changes where they are, not what they cost.

import { useState } from 'react';
import { ArrowRight, Loader2, Plus, Trash2, Truck } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PageHeader } from '@/components/shared/page-header';
import { DataTable, type Column } from '@/components/shared/data-table';
import { AsyncPage, LoadingRows } from '@/components/shared/async-state';
import { Field } from '@/components/shared/form-bits';
import { api } from '@/lib/api/client';
import { toastWarnings } from '@/lib/api/warnings';
import { useApi } from '@/lib/api/use-api';
import { useAppStore } from '@/lib/store';
import { usePermission } from '@/lib/store/hooks';
import { today } from '@/lib/selectors';

interface Transfer {
  id: string; number: string; from: string; to: string; dispatchDate: string; receivedDate: string | null;
  status: 'in_transit' | 'received' | 'cancelled'; vehicleNo: string | null; ewayBillNo: string | null; notes: string | null; items: string; qty: number;
}
interface Data { transfers: Transfer[]; warehouses: { id: string; name: string }[] }

const fmt = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
const TONE: Record<Transfer['status'], string> = {
  in_transit: 'border-amber-500/40 text-amber-700 dark:text-amber-300',
  received: 'border-emerald-500/40 text-emerald-700 dark:text-emerald-300',
  cancelled: 'text-muted-foreground',
};

export default function TransfersPage() {
  const state = useApi<Data>(() => api.get('/api/stock-transfers'), []);
  const canEdit = usePermission('inventory', 'edit');
  const [creating, setCreating] = useState(false);

  const act = async (payload: Record<string, unknown>, done: string) => {
    try {
      await api.post('/api/stock-transfers', payload);
      toast.success(done);
      void state.refetch();
    } catch (e) {
      toast.error('Not done', { description: e instanceof Error ? e.message : String(e) });
    }
  };

  const cols: Column<Transfer>[] = [
    { key: 'number', header: 'Transfer', sortValue: (r) => r.number, cell: (r) => <span className="font-medium">{r.number}</span> },
    { key: 'route', header: 'From → to', sortValue: (r) => r.from, cell: (r) => <span className="inline-flex items-center gap-1 text-sm">{r.from} <ArrowRight className="size-3" /> {r.to}</span> },
    { key: 'items', header: 'Items', cell: (r) => <span className="text-xs text-muted-foreground">{r.items}</span> },
    { key: 'dispatched', header: 'Sent', sortValue: (r) => r.dispatchDate, cell: (r) => <span className="text-xs">{fmt(r.dispatchDate)}</span> },
    {
      key: 'status', header: 'Status', sortValue: (r) => r.status,
      cell: (r) => <Badge variant="outline" className={`text-[10px] ${TONE[r.status]}`}>{r.status === 'in_transit' ? 'In transit' : r.status === 'received' ? `Received ${fmt(r.receivedDate!)}` : 'Cancelled'}</Badge>,
    },
    {
      key: 'actions', header: '', align: 'right', cell: (r) => canEdit && r.status === 'in_transit' ? (
        <div className="flex justify-end gap-1">
          <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); void act({ action: 'receive', id: r.id, date: today() }, `${r.number} received`); }}>Received today</Button>
          <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); if (window.confirm(`Cancel ${r.number}? The goods stay where they were.`)) void act({ action: 'cancel', id: r.id }, `${r.number} cancelled`); }}>Cancel</Button>
        </div>
      ) : null,
    },
  ];

  return (
    <>
      <PageHeader title="Stock transfers" description="Goods moved between godowns: out on the day they leave, in on the day they arrive, in transit between."
        actions={canEdit && <Button size="sm" className="gap-1.5" onClick={() => setCreating(true)}><Truck className="size-4" /> New transfer</Button>} />
      <AsyncPage state={state} loading={<LoadingRows rows={6} />}>
        {(d) => (
          <>
            {d.transfers.some((t) => t.status === 'in_transit') && (
              <Card className="flex items-center gap-3 border-amber-500/40 bg-amber-500/5 p-4 text-sm">
                <Truck className="size-4 shrink-0 text-amber-600" />
                {d.transfers.filter((t) => t.status === 'in_transit').length} transfer(s) in transit: counted in the business&apos;s stock, at neither godown.
              </Card>
            )}
            <DataTable rows={d.transfers} columns={cols} getRowId={(r) => r.id} searchPlaceholder="Search transfers…" emptyMessage="No transfers yet." />
            <NewTransfer open={creating} warehouses={d.warehouses} onClose={() => setCreating(false)} onDone={() => { setCreating(false); void state.refetch(); }} />
          </>
        )}
      </AsyncPage>
    </>
  );
}

function NewTransfer({ open, warehouses, onClose, onDone }: { open: boolean; warehouses: Data['warehouses']; onClose: () => void; onDone: () => void }) {
  const items = useAppStore((s) => s.items).filter((i) => i.kind === 'goods' && i.trackInventory);
  const [f, setF] = useState({ from: '', to: '', date: today(), vehicleNo: '', ewayBillNo: '' });
  const [lines, setLines] = useState<{ itemId: string; qty: string }[]>([{ itemId: '', qty: '' }]);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const r = await api.post('/api/stock-transfers', {
        action: 'create', fromWarehouseId: f.from, toWarehouseId: f.to, date: f.date, vehicleNo: f.vehicleNo || null, ewayBillNo: f.ewayBillNo || null,
        lines: lines.filter((l) => l.itemId && Number(l.qty) > 0).map((l) => ({ itemId: l.itemId, qty: Number(l.qty) })),
      });
      toastWarnings(r);
      toast.success('Transfer dispatched');
      setLines([{ itemId: '', qty: '' }]);
      onDone();
    } catch (e) {
      toast.error('Not saved', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  const pick = (label: string, value: string, set: (v: string) => void) => (
    <Field label={label}>
      <div><Select value={value} onValueChange={(v) => set(String(v))}>
        <SelectTrigger><SelectValue placeholder="Godown" /></SelectTrigger>
        <SelectContent>{warehouses.map((w) => <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>)}</SelectContent>
      </Select></div>
    </Field>
  );
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Transfer stock</DialogTitle>
          <DialogDescription>Between godowns of one GST registration. To a different GSTIN it is a supply: raise a tax invoice.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-3">
          {pick('From', f.from, (v) => setF({ ...f, from: v }))}
          {pick('To', f.to, (v) => setF({ ...f, to: v }))}
          <Field label="Sent on"><Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
          <Field label="Vehicle"><Input value={f.vehicleNo} onChange={(e) => setF({ ...f, vehicleNo: e.target.value.toUpperCase() })} /></Field>
          <Field label="E-way bill"><Input value={f.ewayBillNo} onChange={(e) => setF({ ...f, ewayBillNo: e.target.value })} /></Field>
        </div>
        <div className="space-y-2">
          {lines.map((l, i) => (
            <div key={i} className="flex gap-2">
              <div className="flex-1"><Select value={l.itemId} onValueChange={(v) => setLines(lines.map((x, j) => (j === i ? { ...x, itemId: String(v) } : x)))}>
                <SelectTrigger><SelectValue placeholder="Item" /></SelectTrigger>
                <SelectContent>{items.map((it) => <SelectItem key={it.id} value={it.id}>{it.name}</SelectItem>)}</SelectContent>
              </Select></div>
              <Input type="number" min={0} step="any" placeholder="Qty" value={l.qty} className="w-28"
                onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} />
              <Button size="icon" variant="ghost" aria-label="Remove line" onClick={() => setLines(lines.length > 1 ? lines.filter((_, j) => j !== i) : lines)}><Trash2 className="size-4" /></Button>
            </div>
          ))}
          <Button size="sm" variant="ghost" className="gap-1.5" onClick={() => setLines([...lines, { itemId: '', qty: '' }])}><Plus className="size-3.5" /> Add item</Button>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={busy || !f.from || !f.to || f.from === f.to || !lines.some((l) => l.itemId && Number(l.qty) > 0)} className="gap-1.5" onClick={() => void save()}>
            {busy && <Loader2 className="size-3.5 animate-spin" />} Dispatch
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
