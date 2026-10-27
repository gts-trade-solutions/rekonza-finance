'use client';

// Price lists: dealer, wholesale or contract prices. A list is a percentage on
// or off every item's price, or a rate for each item it names. Customers are
// put on a list from their own record.

import { useState } from 'react';
import { Loader2, Plus, Tags, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PageHeader } from '@/components/shared/page-header';
import { DataTable, type Column } from '@/components/shared/data-table';
import { AsyncPage, LoadingRows } from '@/components/shared/async-state';
import { Field, MoneyInput } from '@/components/shared/form-bits';
import { Money } from '@/components/shared/money';
import { api } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { useAppStore } from '@/lib/store';
import { usePermission } from '@/lib/store/hooks';

interface PriceList {
  id: string; name: string; basis: 'percent' | 'per_item'; percent: number; isActive: boolean; customers: number;
  items: { itemId: string; ratePaise: number }[];
  discounts: { itemId: string | null; minQty: number; discountPct: number }[];
}

export default function PriceListsPage() {
  const state = useApi<{ lists: PriceList[] }>(() => api.get('/api/price-lists'), []);
  const canEdit = usePermission('sales', 'edit');
  const [editing, setEditing] = useState<PriceList | 'new' | null>(null);

  const cols: Column<PriceList>[] = [
    { key: 'name', header: 'Price list', sortValue: (r) => r.name, cell: (r) => <span className="font-medium">{r.name}</span> },
    {
      key: 'basis', header: 'Prices', cell: (r) => (r.basis === 'percent'
        ? <span className="text-sm">{r.percent === 0 ? 'Item prices' : `${Math.abs(r.percent)}% ${r.percent < 0 ? 'off' : 'above'} item prices`}</span>
        : <span className="text-sm">{r.items.length} item rate(s); others at their own price</span>),
    },
    {
      key: 'discounts', header: 'Discount rules', cell: (r) => (r.discounts.length
        ? <span className="text-sm">{r.discounts.length} rule{r.discounts.length === 1 ? '' : 's'}, up to {Math.max(...r.discounts.map((d) => d.discountPct))}% off</span>
        : <span className="text-xs text-muted-foreground">None</span>),
    },
    { key: 'customers', header: 'Customers', align: 'right', sortValue: (r) => r.customers, cell: (r) => <span className="tabular-nums">{r.customers}</span> },
    { key: 'status', header: 'Status', cell: (r) => (r.isActive ? <Badge variant="outline" className="text-[10px]">Active</Badge> : <span className="text-xs text-muted-foreground">Inactive</span>) },
  ];

  return (
    <>
      <PageHeader title="Price lists" description="Dealer, wholesale or contract prices. Put a customer on a list from their record; their invoices are priced from it."
        actions={canEdit && <Button size="sm" className="gap-1.5" onClick={() => setEditing('new')}><Plus className="size-4" /> New price list</Button>} />
      <AsyncPage state={state} loading={<LoadingRows rows={5} />}>
        {(d) => (
          <DataTable rows={d.lists} columns={cols} getRowId={(r) => r.id} onRowClick={canEdit ? (r) => setEditing(r) : undefined}
            searchable={false} emptyMessage="No price lists yet." />
        )}
      </AsyncPage>
      <Editor list={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void state.refetch(); }} />
    </>
  );
}

function Editor({ list, onClose, onSaved }: { list: PriceList | 'new' | null; onClose: () => void; onSaved: () => void }) {
  const items = useAppStore((s) => s.items);
  const existing = list && list !== 'new' ? list : null;
  const [f, setF] = useState({ name: '', basis: 'percent' as 'percent' | 'per_item', percent: '-10', isActive: true });
  const [rows, setRows] = useState<{ itemId: string; ratePaise: number }[]>([]);
  const [rules, setRules] = useState<{ itemId: string; minQty: string; discountPct: string }[]>([]);
  const [shown, setShown] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const key = list === 'new' ? 'new' : existing?.id ?? null;
  if (key !== shown) {
    setShown(key);
    setF(existing ? { name: existing.name, basis: existing.basis, percent: String(existing.percent), isActive: existing.isActive } : { name: '', basis: 'percent', percent: '-10', isActive: true });
    setRows(existing?.items ?? []);
    setRules((existing?.discounts ?? []).map((d) => ({ itemId: d.itemId ?? '', minQty: String(d.minQty), discountPct: String(d.discountPct) })));
  }
  const save = async () => {
    setBusy(true);
    try {
      await api.post('/api/price-lists', {
        id: existing?.id, name: f.name, basis: f.basis, percent: Number(f.percent) || 0, isActive: f.isActive,
        items: f.basis === 'per_item' ? rows.filter((r) => r.itemId) : [],
        discounts: rules.filter((r) => Number(r.discountPct) > 0)
          .map((r) => ({ itemId: r.itemId || null, minQty: Number(r.minQty) || 0, discountPct: Number(r.discountPct) })),
      });
      toast.success(`${f.name} saved`);
      onSaved();
    } catch (e) {
      toast.error('Not saved', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  const itemPrice = (id: string) => items.find((i) => i.id === id)?.salePricePaise ?? 0;
  return (
    <Dialog open={!!list} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{existing ? existing.name : 'New price list'}</DialogTitle>
          <DialogDescription>Prices before GST. A per-item list leaves items it does not name at their own price.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Dealers" /></Field>
          <Field label="Prices are">
            <div className="flex w-fit rounded-md border p-0.5 text-xs">
              {(['percent', 'per_item'] as const).map((b) => (
                <button key={b} type="button" onClick={() => setF({ ...f, basis: b })}
                  className={`rounded px-2.5 py-1 ${f.basis === b ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`}>
                  {b === 'percent' ? 'A percentage' : 'Set per item'}
                </button>
              ))}
            </div>
          </Field>
          {f.basis === 'percent' && (
            <Field label="On item prices" hint="-10 is 10% off, 5 is 5% above">
              <div className="flex items-center gap-2"><Input type="number" step="0.5" value={f.percent} onChange={(e) => setF({ ...f, percent: e.target.value })} className="w-28" /><span className="text-sm">%</span></div>
            </Field>
          )}
          <Field label="Active"><Switch checked={f.isActive} onCheckedChange={(v) => setF({ ...f, isActive: v })} /></Field>
        </div>
        {f.basis === 'per_item' && (
          <div className="space-y-2">
            {rows.map((r, i) => (
              <div key={i} className="flex items-center gap-2">
                <div className="flex-1"><Select value={r.itemId} onValueChange={(v) => setRows(rows.map((x, j) => (j === i ? { itemId: String(v), ratePaise: x.ratePaise || itemPrice(String(v)) } : x)))}>
                  <SelectTrigger><SelectValue placeholder="Item" /></SelectTrigger>
                  <SelectContent>{items.map((it) => <SelectItem key={it.id} value={it.id}>{it.name}</SelectItem>)}</SelectContent>
                </Select></div>
                <MoneyInput valuePaise={r.ratePaise} onChangePaise={(v) => setRows(rows.map((x, j) => (j === i ? { ...x, ratePaise: v } : x)))} className="w-32" />
                {r.itemId && <span className="w-28 text-right text-xs text-muted-foreground">list <Money value={itemPrice(r.itemId)} /></span>}
                <Button size="icon" variant="ghost" aria-label="Remove" onClick={() => setRows(rows.filter((_, j) => j !== i))}><Trash2 className="size-4" /></Button>
              </div>
            ))}
            <Button size="sm" variant="ghost" className="gap-1.5" onClick={() => setRows([...rows, { itemId: '', ratePaise: 0 }])}><Tags className="size-3.5" /> Add an item rate</Button>
          </div>
        )}
        <div className="space-y-2 border-t pt-3">
          <p className="text-sm font-medium">Discount rules</p>
          <p className="text-xs text-muted-foreground">From a quantity up, a percentage off the line. The best rule a line qualifies for is used, and anyone can still change it on the invoice.</p>
          {rules.map((r, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <select value={r.itemId} onChange={(e) => setRules(rules.map((x, j) => (j === i ? { ...x, itemId: e.target.value } : x)))}
                className="h-9 min-w-48 flex-1 rounded-md border border-input bg-background px-2 text-sm" aria-label="Item">
                <option value="">Every item</option>
                {items.map((it) => <option key={it.id} value={it.id}>{it.name}</option>)}
              </select>
              <span className="text-xs text-muted-foreground">from</span>
              <Input type="number" min={0} step="any" value={r.minQty} onChange={(e) => setRules(rules.map((x, j) => (j === i ? { ...x, minQty: e.target.value } : x)))} className="w-24" aria-label="Minimum quantity" />
              <span className="text-xs text-muted-foreground">units,</span>
              <Input type="number" min={0} max={100} step="0.5" value={r.discountPct} onChange={(e) => setRules(rules.map((x, j) => (j === i ? { ...x, discountPct: e.target.value } : x)))} className="w-20" aria-label="Discount" />
              <span className="text-xs text-muted-foreground">% off</span>
              <Button size="icon" variant="ghost" aria-label="Remove rule" onClick={() => setRules(rules.filter((_, j) => j !== i))}><Trash2 className="size-4" /></Button>
            </div>
          ))}
          <Button size="sm" variant="ghost" className="gap-1.5" onClick={() => setRules([...rules, { itemId: '', minQty: '10', discountPct: '5' }])}><Plus className="size-3.5" /> Add a discount rule</Button>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={busy || !f.name.trim()} className="gap-1.5" onClick={() => void save()}>{busy && <Loader2 className="size-3.5 animate-spin" />} Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
