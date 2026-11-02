'use client';

// A new item group: one product in variants (services/item-groups.ts). Each
// combination of the attributes' values becomes an item, named and coded from
// the group, starting from the same HSN, unit, rate and prices.

import { useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, MoneyInput } from '@/components/shared/form-bits';
import { api } from '@/lib/api/client';

export function ItemGroupDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [attrs, setAttrs] = useState([{ name: 'Size', values: 'S, M, L' }]);
  const [hsn, setHsn] = useState('');
  const [uqc, setUqc] = useState('NOS');
  const [gst, setGst] = useState(18);
  const [sale, setSale] = useState(0);
  const [cost, setCost] = useState(0);
  const [busy, setBusy] = useState(false);
  const parsed = attrs.map((a) => ({ name: a.name.trim(), values: a.values.split(',').map((v) => v.trim()).filter(Boolean) })).filter((a) => a.name && a.values.length);
  const count = useMemo(() => (parsed.length ? parsed.reduce((t, a) => t * a.values.length, 1) : 0), [parsed]);

  const save = async () => {
    if (!name.trim() || !parsed.length) { toast.error('Name the group and give at least one attribute with values.'); return; }
    setBusy(true);
    try {
      const r = await api.post<{ id: string; variants: number }>('/api/item-groups', {
        name: name.trim(), attributes: parsed, hsnSac: hsn || null, uqc, gstRatePct: gst, salePricePaise: sale, purchasePricePaise: cost,
      });
      toast.success(`${r.variants} variants made`, { description: 'Each is an item of its own: set its own price or stock as needed.' });
      onCreated();
      onOpenChange(false);
      setName('');
    } catch (e) {
      toast.error('Not made', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New item group</DialogTitle>
          <DialogDescription>One product in variants. Every combination of the values becomes an item with its own stock and SKU.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Product" required className="sm:col-span-2"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Riding jacket" /></Field>
          <div className="space-y-2 sm:col-span-2">
            {attrs.map((a, i) => (
              <div key={i} className="grid grid-cols-[120px_1fr_auto] gap-2">
                <Input value={a.name} onChange={(e) => setAttrs(attrs.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} placeholder="Attribute" aria-label="Attribute" />
                <Input value={a.values} onChange={(e) => setAttrs(attrs.map((x, j) => (j === i ? { ...x, values: e.target.value } : x)))} placeholder="Values, separated by commas" aria-label="Values" />
                <Button size="icon-sm" variant="ghost" aria-label="Remove attribute" onClick={() => setAttrs(attrs.filter((_, j) => j !== i))}><Trash2 className="size-4" /></Button>
              </div>
            ))}
            {attrs.length < 3 && <Button size="sm" variant="ghost" onClick={() => setAttrs([...attrs, { name: 'Colour', values: '' }])} className="gap-1"><Plus className="size-3.5" /> Attribute</Button>}
            <p className="text-xs text-muted-foreground">{count ? `${count} variant${count === 1 ? '' : 's'} will be made.` : 'Add values to see the variants.'}{count > 100 ? ' A group holds at most 100.' : ''}</p>
          </div>
          <Field label="HSN code"><Input value={hsn} onChange={(e) => setHsn(e.target.value.replace(/\D/g, '').slice(0, 8))} /></Field>
          <Field label="Unit"><Input value={uqc} onChange={(e) => setUqc(e.target.value.toUpperCase().slice(0, 8))} /></Field>
          <Field label="Selling price"><MoneyInput valuePaise={sale} onChangePaise={setSale} /></Field>
          <Field label="Cost price"><MoneyInput valuePaise={cost} onChangePaise={setCost} /></Field>
          <Field label="GST rate">
            <select value={gst} onChange={(e) => setGst(Number(e.target.value))} className="h-9 rounded-md border bg-background px-2 text-sm">
              {[0, 5, 12, 18, 28].map((r) => <option key={r} value={r}>{r}%</option>)}
            </select>
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={save} disabled={busy || !count || count > 100}>{busy ? 'Making…' : `Make ${count || ''} variants`}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
