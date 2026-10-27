'use client';

// Production: bills of materials, and making finished goods from them. Each
// run uses up its components and adds the finished item at their cost that
// day plus the overhead absorbed.

import { useState } from 'react';
import { Factory, Loader2, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PageHeader } from '@/components/shared/page-header';
import { DataTable, type Column } from '@/components/shared/data-table';
import { AsyncPage, LoadingRows } from '@/components/shared/async-state';
import { Field, MoneyInput } from '@/components/shared/form-bits';
import { Money } from '@/components/shared/money';
import { api } from '@/lib/api/client';
import { toastWarnings } from '@/lib/api/warnings';
import { useApi } from '@/lib/api/use-api';
import { useAppStore } from '@/lib/store';
import { usePermission } from '@/lib/store/hooks';
import { today } from '@/lib/selectors';
import { GodownPicker } from '@/components/forms/godown-picker';

interface Bom { id: string; itemId: string; itemName: string; name: string; outputQty: number; isActive: boolean; notes: string | null; lines: { itemId: string; name: string; uqc: string; qty: number }[] }
interface Production {
  id: string; number: string; date: string; itemName: string; uqc: string; qty: number; componentsCostPaise: number; overheadPaise: number;
  costPaise: number; unitCostPaise: number; status: 'done' | 'void'; branch: string; notes: string | null;
}
interface Data { boms: Bom[]; productions: Production[] }

const fmt = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

export default function ProductionPage() {
  const state = useApi<Data>(() => api.get('/api/manufacturing'), []);
  const canEdit = usePermission('inventory', 'edit');
  const [bomOpen, setBomOpen] = useState<Bom | 'new' | null>(null);
  const [producing, setProducing] = useState(false);

  const post = async (payload: Record<string, unknown>, done: string) => {
    try {
      const r = await api.post('/api/manufacturing', payload);
      toastWarnings(r);
      toast.success(done);
      await state.refetch();
      return true;
    } catch (e) {
      toast.error('Not saved', { description: e instanceof Error ? e.message : String(e) });
      return false;
    }
  };

  const prodCols: Column<Production>[] = [
    { key: 'number', header: 'Run', sortValue: (r) => r.number, cell: (r) => <span className="font-medium">{r.number}</span> },
    { key: 'date', header: 'Date', sortValue: (r) => r.date, cell: (r) => <span className="text-xs">{fmt(r.date)}</span> },
    { key: 'item', header: 'Made', sortValue: (r) => r.itemName, cell: (r) => <span>{r.qty} {r.uqc} {r.itemName}</span> },
    { key: 'cost', header: 'Cost', align: 'right', sortValue: (r) => r.costPaise, cell: (r) => <div><Money value={r.costPaise} /><p className="text-[11px] text-muted-foreground"><Money value={r.unitCostPaise} /> each</p></div> },
    {
      key: 'status', header: '', align: 'right', cell: (r) => (r.status === 'void'
        ? <Badge variant="outline" className="text-[10px] text-muted-foreground">Void</Badge>
        : canEdit ? <Button size="sm" variant="ghost" onClick={() => { if (window.confirm(`Void ${r.number}? Its components go back into stock.`)) void post({ action: 'void', id: r.id }, `${r.number} voided`); }}>Void</Button> : null),
    },
  ];

  return (
    <>
      <PageHeader title="Production" description="Bills of materials, and finished goods made from them at the cost of their components plus overhead."
        actions={canEdit && (
          <div className="flex gap-2">
            <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setBomOpen('new')}><Plus className="size-4" /> Bill of materials</Button>
            <Button size="sm" className="gap-1.5" onClick={() => setProducing(true)}><Factory className="size-4" /> Record production</Button>
          </div>
        )} />
      <AsyncPage state={state} loading={<LoadingRows rows={6} />}>
        {(d) => (
          <Tabs defaultValue="runs">
            <TabsList>
              <TabsTrigger value="runs">Production runs</TabsTrigger>
              <TabsTrigger value="boms">Bills of materials ({d.boms.length})</TabsTrigger>
            </TabsList>
            <TabsContent value="runs" className="mt-4">
              <DataTable rows={d.productions} columns={prodCols} getRowId={(r) => r.id} searchPlaceholder="Search runs…" emptyMessage="Nothing made yet." />
            </TabsContent>
            <TabsContent value="boms" className="mt-4 grid gap-3 lg:grid-cols-2">
              {d.boms.length === 0 && <Card className="p-6 text-sm text-muted-foreground">No bills of materials yet.</Card>}
              {d.boms.map((b) => (
                <Card key={b.id} className={`space-y-2 p-4 ${canEdit ? 'cursor-pointer hover:bg-accent/30' : ''}`} onClick={() => canEdit && setBomOpen(b)}>
                  <div className="flex items-center gap-2">
                    <p className="font-medium">{b.itemName}</p>
                    <Badge variant="outline" className="text-[10px]">{b.name}</Badge>
                    {!b.isActive && <span className="text-xs text-muted-foreground">not in use</span>}
                  </div>
                  <p className="text-xs text-muted-foreground">For {b.outputQty}:</p>
                  <ul className="text-sm">{b.lines.map((l) => <li key={l.itemId}>{l.qty} {l.uqc} {l.name}</li>)}</ul>
                </Card>
              ))}
            </TabsContent>
            <BomDialog bom={bomOpen} onClose={() => setBomOpen(null)} onSave={async (payload) => { if (await post(payload, 'Bill of materials saved')) setBomOpen(null); }} />
            <ProduceDialog open={producing} boms={d.boms.filter((b) => b.isActive)} onClose={() => setProducing(false)}
              onSave={async (payload) => { if (await post(payload, 'Production recorded')) setProducing(false); }} />
          </Tabs>
        )}
      </AsyncPage>
    </>
  );
}

function BomDialog({ bom, onClose, onSave }: { bom: Bom | 'new' | null; onClose: () => void; onSave: (p: Record<string, unknown>) => Promise<void> }) {
  const items = useAppStore((s) => s.items).filter((i) => i.kind === 'goods' && i.trackInventory);
  const existing = bom && bom !== 'new' ? bom : null;
  const [f, setF] = useState({ itemId: '', name: 'Standard', outputQty: '1', isActive: true });
  const [lines, setLines] = useState<{ itemId: string; qty: string }[]>([]);
  const [shown, setShown] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const key = bom === 'new' ? 'new' : existing?.id ?? null;
  if (key !== shown) {
    setShown(key);
    setF(existing ? { itemId: existing.itemId, name: existing.name, outputQty: String(existing.outputQty), isActive: existing.isActive } : { itemId: '', name: 'Standard', outputQty: '1', isActive: true });
    setLines(existing ? existing.lines.map((l) => ({ itemId: l.itemId, qty: String(l.qty) })) : [{ itemId: '', qty: '' }]);
  }
  const pickItem = (value: string, set: (v: string) => void) => (
    <Select value={value} onValueChange={(v) => set(String(v))}>
      <SelectTrigger><SelectValue placeholder="Item" /></SelectTrigger>
      <SelectContent>{items.map((it) => <SelectItem key={it.id} value={it.id}>{it.name}</SelectItem>)}</SelectContent>
    </Select>
  );
  return (
    <Dialog open={!!bom} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader><DialogTitle>{existing ? `${existing.itemName}: ${existing.name}` : 'New bill of materials'}</DialogTitle></DialogHeader>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Makes" className="sm:col-span-2"><div>{pickItem(f.itemId, (v) => setF({ ...f, itemId: v }))}</div></Field>
          <Field label="Quantity made"><Input type="number" min={0} step="any" value={f.outputQty} onChange={(e) => setF({ ...f, outputQty: e.target.value })} /></Field>
          <Field label="Name" hint="To tell versions apart"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        </div>
        <p className="text-sm font-medium">Components for that quantity</p>
        <div className="space-y-2">
          {lines.map((l, i) => (
            <div key={i} className="flex gap-2">
              <div className="flex-1">{pickItem(l.itemId, (v) => setLines(lines.map((x, j) => (j === i ? { ...x, itemId: v } : x))))}</div>
              <Input type="number" min={0} step="any" placeholder="Qty" value={l.qty} className="w-28" onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} />
              <Button size="icon" variant="ghost" aria-label="Remove" onClick={() => setLines(lines.filter((_, j) => j !== i))}><Trash2 className="size-4" /></Button>
            </div>
          ))}
          <Button size="sm" variant="ghost" className="gap-1.5" onClick={() => setLines([...lines, { itemId: '', qty: '' }])}><Plus className="size-3.5" /> Add component</Button>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={busy || !f.itemId || !(Number(f.outputQty) > 0)} className="gap-1.5" onClick={async () => {
            setBusy(true);
            await onSave({ action: 'bom', id: existing?.id, itemId: f.itemId, name: f.name, outputQty: Number(f.outputQty), isActive: f.isActive,
              lines: lines.filter((l) => l.itemId && Number(l.qty) > 0).map((l) => ({ itemId: l.itemId, qty: Number(l.qty) })) });
            setBusy(false);
          }}>{busy && <Loader2 className="size-3.5 animate-spin" />} Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ProduceDialog({ open, boms, onClose, onSave }: { open: boolean; boms: Bom[]; onClose: () => void; onSave: (p: Record<string, unknown>) => Promise<void> }) {
  const branchId = useAppStore((s) => s.activeBranchId || s.branches[0]?.id || '');
  const [f, setF] = useState({ bomId: '', qty: '', date: today(), overhead: 0, warehouseId: '' });
  const [busy, setBusy] = useState(false);
  const bom = boms.find((b) => b.id === f.bomId);
  const factor = bom && Number(f.qty) > 0 ? Number(f.qty) / bom.outputQty : 0;
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record production</DialogTitle>
          <DialogDescription>The components are taken out of stock and the finished item added, at their cost today plus the overhead.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Bill of materials" className="sm:col-span-2">
            <div><Select value={f.bomId} onValueChange={(v) => setF({ ...f, bomId: String(v) })}>
              <SelectTrigger><SelectValue placeholder="What is being made" /></SelectTrigger>
              <SelectContent>{boms.map((b) => <SelectItem key={b.id} value={b.id}>{b.itemName} · {b.name}</SelectItem>)}</SelectContent>
            </Select></div>
          </Field>
          <Field label="Quantity made"><Input type="number" min={0} step="any" value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} /></Field>
          <Field label="Date"><Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
          <GodownPicker branchId={branchId} value={f.warehouseId} onChange={(v) => setF({ ...f, warehouseId: v })} />
          <Field label="Overhead absorbed" hint="Labour and factory cost, if valued into the goods" className="sm:col-span-2"><MoneyInput valuePaise={f.overhead} onChangePaise={(v) => setF({ ...f, overhead: v })} /></Field>
        </div>
        {bom && factor > 0 && (
          <ul className="rounded-md border p-3 text-sm">
            <li className="mb-1 text-xs text-muted-foreground">Uses</li>
            {bom.lines.map((l) => <li key={l.itemId}>{Math.round(l.qty * factor * 1000) / 1000} {l.uqc} {l.name}</li>)}
          </ul>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={busy || !f.bomId || !(Number(f.qty) > 0)} className="gap-1.5" onClick={async () => {
            setBusy(true);
            await onSave({ action: 'produce', bomId: f.bomId, qty: Number(f.qty), date: f.date, branchId, overheadPaise: f.overhead, warehouseId: f.warehouseId || null });
            setBusy(false);
          }}>{busy && <Loader2 className="size-3.5 animate-spin" />} Record</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
