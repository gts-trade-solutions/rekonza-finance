'use client';

// Zoho Books' Edit on a purchase order, while nothing on it is received or
// billed: the order as saved, every line of it, saved back over it under the
// same number (PUT /api/purchase-orders/[id], services/purchase-changes.ts).
// An order posts nothing, so nothing in the ledger moves.

import { useEffect, useState } from 'react';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Combobox } from '@/components/ui/combobox';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { ContactPicker } from '@/components/forms/quick-create';
import { Field, MoneyInput } from '@/components/shared/form-bits';
import { ApiError, purchaseOrders, type PurchaseOrderForEdit } from '@/lib/api/client';
import { useAppStore } from '@/lib/store';
import { itemOptions } from '@/lib/options';
import { formatINR } from '@/lib/money';
import { FoldNav } from '@/components/layout/nav-state';

interface EditLine {
  key: string; itemId: string; description: string; hsnSac: string | null; uqc: string | null;
  qty: number; ratePaise: number; discountPct: number; gstRatePct: number;
}

const GST = [0, 0.25, 3, 5, 12, 18, 28, 40].map((r) => ({ value: String(r), label: `${r}%` }));

export function EditPurchaseOrderDialog({ orderId, onClose, onSaved }: { orderId: string | null; onClose: () => void; onSaved: () => void }) {
  const items = useAppStore((s) => s.items);
  const [po, setPo] = useState<PurchaseOrderForEdit | null>(null);
  const [vendorId, setVendorId] = useState('');
  const [date, setDate] = useState('');
  const [expected, setExpected] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<EditLine[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!orderId) { setPo(null); return; }
    let live = true;
    setError(null);
    purchaseOrders.get(orderId).then((o) => {
      if (!live) return;
      setPo(o); setVendorId(o.vendorId); setDate(o.date); setExpected(o.expectedDate ?? ''); setNotes(o.notes ?? '');
      setLines(o.lines.map((l, i) => ({
        key: `l${i}`, itemId: l.itemId ?? '', description: l.description ?? '', hsnSac: l.hsnSac, uqc: l.uqc,
        qty: l.qty, ratePaise: l.ratePaise, discountPct: l.discountPct, gstRatePct: l.gstRatePct,
      })));
    }).catch((e) => { if (live) { toast.error(e instanceof ApiError ? e.message : 'That order could not be opened.'); onClose(); } });
    return () => { live = false; };
  }, [orderId, onClose]);

  const set = (key: string, patch: Partial<EditLine>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const total = lines.reduce((t, l) => t + Math.round(l.qty * l.ratePaise * (1 - l.discountPct / 100) * (1 + l.gstRatePct / 100)), 0);

  const save = async () => {
    if (!po) return;
    if (!vendorId) { setError('Pick the vendor.'); return; }
    if (!lines.length || lines.some((l) => (!l.itemId && !l.description.trim()) || l.qty <= 0)) {
      setError('Every line needs an item (or a description) and a quantity above zero.');
      return;
    }
    setBusy(true); setError(null);
    try {
      const done = await purchaseOrders.update(po.id, {
        branchId: po.branchId, vendorId, date, expectedDate: expected || null, notes: notes || null,
        lines: lines.map((l) => ({
          itemId: l.itemId || null, description: l.description || null, hsnSac: l.hsnSac, uqc: l.uqc, qty: l.qty,
          ratePaise: l.ratePaise, discountPct: l.discountPct, gstRatePct: l.gstRatePct,
        })),
      });
      toast.success(`${done.number} saved`, { description: 'An order posts nothing, so the ledger does not change.' });
      onSaved();
      onClose();
    } catch (e) {
      const message = e instanceof ApiError ? e.message : String(e);
      setError(message);
      toast.error('Not saved', { description: message });
    } finally { setBusy(false); }
  };

  return (
    <Dialog open={!!orderId} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="sm:max-w-3xl" data-slot="po-edit-dialog">
        <DialogHeader>
          <DialogTitle>Edit {po?.number ?? 'purchase order'}</DialogTitle>
          <FoldNav />
          <DialogDescription>
            {po?.vendorResponse
              ? `The vendor ${po.vendorResponse} this order on the portal. Saved changes clear that answer: the changed order waits for a new one.`
              : 'Saved over the order under the same number. Nothing has been received or billed on it, so nothing else changes.'}
          </DialogDescription>
        </DialogHeader>
        {!po ? (
          <div className="flex justify-center py-8"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
        ) : (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Vendor" required className="sm:col-span-3"><ContactPicker kind="vendor" value={vendorId} onChange={setVendorId} /></Field>
              <Field label="Order date" required><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} data-slot="po-edit-date" /></Field>
              <Field label="Expected delivery"><Input type="date" value={expected} onChange={(e) => setExpected(e.target.value)} data-slot="po-edit-expected" /></Field>
            </div>
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-[11px] uppercase text-muted-foreground">
                  <tr>
                    <th className="px-2 py-1.5 text-left">Item</th><th className="w-24 px-2 py-1.5 text-right">Qty</th>
                    <th className="w-36 px-2 py-1.5 text-right">Rate</th><th className="w-24 px-2 py-1.5 text-right">GST</th><th className="w-8" />
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l) => (
                    <tr key={l.key} className="border-t align-top" data-slot="po-edit-line">
                      <td className="px-2 py-1.5">
                        {l.itemId || !l.description ? (
                          <Combobox options={itemOptions({ items } as never, 'purchase')} value={l.itemId} showAvatar={false} placeholder="Select an item"
                            onChange={(v) => {
                              const x = items.find((i) => i.id === v);
                              set(l.key, { itemId: v, ratePaise: x?.purchasePricePaise ?? l.ratePaise, gstRatePct: x?.gstRatePct ?? l.gstRatePct, description: x?.name ?? '', hsnSac: x?.hsnSac ?? null, uqc: x?.uqc ?? null });
                            }} />
                        ) : (
                          <Input value={l.description} onChange={(e) => set(l.key, { description: e.target.value })} placeholder="Description" />
                        )}
                      </td>
                      <td className="px-2 py-1.5">
                        <Input type="number" min="0" step="any" value={l.qty} onChange={(e) => set(l.key, { qty: Number(e.target.value) || 0 })} className="h-9 text-right" data-slot="po-edit-qty" />
                      </td>
                      <td className="px-2 py-1.5"><MoneyInput valuePaise={l.ratePaise} onChangePaise={(v) => set(l.key, { ratePaise: v })} /></td>
                      <td className="px-2 py-1.5">
                        <Combobox options={GST} value={String(l.gstRatePct)} onChange={(v) => set(l.key, { gstRatePct: Number(v) })} showAvatar={false} />
                      </td>
                      <td className="px-1 py-1.5">
                        {lines.length > 1 && (
                          <button type="button" aria-label="Remove line" className="mt-2 text-muted-foreground hover:text-destructive" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>
                            <Trash2 className="size-4" />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setLines((ls) => [...ls, {
              key: `n${Date.now()}`, itemId: '', description: '', hsnSac: null, uqc: null, qty: 1, ratePaise: 0, discountPct: 0, gstRatePct: 18,
            }])}>
              <Plus className="size-3.5" /> Add line
            </Button>
            <Field label="Notes"><Input value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
            <div className="flex items-center justify-between rounded-md border bg-muted/30 px-3 py-2 text-sm">
              <span className="text-muted-foreground">Order value incl. GST (before rounding)</span>
              <span className="font-semibold tabular">{formatINR(total)}</span>
            </div>
            {error && <p className="text-sm text-destructive" data-slot="po-edit-error">{error}</p>}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void save()} disabled={busy || !po} data-slot="po-edit-save" className="gap-1.5">
            {busy && <Loader2 className="size-3.5 animate-spin" />} Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
