'use client';

// Zoho Books' Edit and Delete on a goods receipt (purchase receive), while
// nothing on it is billed: the note's stock and "goods received, bill pending"
// entry is reversed and posted again under the same number, or reversed and
// the note kept in deleted documents (services/purchase-changes.ts).

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
import { GodownPicker } from '@/components/forms/godown-picker';
import { ApiError, goodsReceipts, type GoodsReceiptForEdit } from '@/lib/api/client';
import { useAppStore } from '@/lib/store';
import { itemOptions } from '@/lib/options';
import { formatINR } from '@/lib/money';
import { FoldNav } from '@/components/layout/nav-state';

interface EditLine {
  key: string; poLineId: string | null; itemId: string; description: string | null; hsnSac: string | null; uqc: string | null;
  qty: number; ratePaise: number; gstRatePct: number; batchNo: string; mfgDate: string | null; expiryDate: string; serials: string;
}

const toEditLine = (l: GoodsReceiptForEdit['lines'][number], i: number): EditLine => ({
  key: `g${i}`, poLineId: l.poLineId, itemId: l.itemId ?? '', description: l.description, hsnSac: l.hsnSac, uqc: l.uqc,
  qty: l.qty, ratePaise: l.ratePaise, gstRatePct: l.gstRatePct, batchNo: l.batch?.batchNo ?? '', mfgDate: l.batch?.mfgDate ?? null,
  expiryDate: l.batch?.expiryDate ?? '', serials: l.serials.join('\n'),
});
const serialsOf = (t: string) => t.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);

export function EditGoodsReceiptDialog({ receiptId, onClose, onSaved }: { receiptId: string | null; onClose: () => void; onSaved: () => void }) {
  const items = useAppStore((s) => s.items);
  const [note, setNote] = useState<GoodsReceiptForEdit | null>(null);
  const [vendorId, setVendorId] = useState('');
  const [date, setDate] = useState('');
  const [challanNo, setChallanNo] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<EditLine[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!receiptId) { setNote(null); return; }
    let live = true;
    setError(null);
    goodsReceipts.get(receiptId).then((g) => {
      if (!live) return;
      setNote(g); setVendorId(g.vendorId); setDate(g.date); setChallanNo(g.vendorChallanNo ?? ''); setWarehouseId(g.warehouseId ?? '');
      setNotes(g.notes ?? ''); setLines(g.lines.map(toEditLine));
    }).catch((e) => { if (live) { toast.error(e instanceof ApiError ? e.message : 'That receipt could not be opened.'); onClose(); } });
    return () => { live = false; };
  }, [receiptId, onClose]);

  const fromOrder = !!note?.sourcePoId;
  const set = (key: string, patch: Partial<EditLine>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const total = lines.reduce((t, l) => t + Math.round(l.qty * l.ratePaise * (1 + l.gstRatePct / 100)), 0);

  const save = async () => {
    if (!note) return;
    if (!vendorId || !lines.length || lines.some((l) => !l.itemId || l.qty <= 0)) {
      setError('Every line needs an item and a quantity above zero.');
      return;
    }
    const tracked = (id: string) => items.find((i) => i.id === id);
    if (lines.some((l) => tracked(l.itemId)?.trackBatches && !l.batchNo.trim())) {
      setError('Give the batch number for each batch-tracked item.');
      return;
    }
    setBusy(true); setError(null);
    try {
      const done = await goodsReceipts.update(note.id, {
        branchId: note.branchId, vendorId, date, vendorChallanNo: challanNo || null, warehouseId: warehouseId || null, notes: notes || null,
        lines: lines.map((l) => ({
          poLineId: l.poLineId, itemId: l.itemId, description: l.description, hsnSac: l.hsnSac, uqc: l.uqc, qty: l.qty,
          ratePaise: l.ratePaise, gstRatePct: l.gstRatePct,
          batch: tracked(l.itemId)?.trackBatches ? { batchNo: l.batchNo.trim(), mfgDate: l.mfgDate, expiryDate: l.expiryDate || null } : null,
          serials: tracked(l.itemId)?.trackSerials && serialsOf(l.serials).length ? serialsOf(l.serials) : null,
        })),
      });
      toast.success(`${done.number} saved`, { description: 'The receipt as it was is reversed and posted again.' });
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally { setBusy(false); }
  };

  return (
    <Dialog open={!!receiptId} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="sm:max-w-3xl" data-slot="grn-edit-dialog">
        <DialogHeader>
          <DialogTitle>Edit {note?.number ?? 'goods receipt'}</DialogTitle>
          <FoldNav />
          <DialogDescription>
            {fromOrder
              ? 'Received against a purchase order: each line keeps its order line, and cannot be for more than the order still has to come.'
              : 'The goods it brought in and their accrual are reversed and entered again as you save them here.'}
          </DialogDescription>
        </DialogHeader>
        {!note ? (
          <div className="flex justify-center py-8"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
        ) : (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Vendor" required hint={fromOrder ? 'Stays with the order’s vendor' : undefined}>
                {fromOrder
                  ? <Input value={useAppStore.getState().contacts.find((c) => c.id === vendorId)?.displayName ?? ''} readOnly className="bg-muted/40" />
                  : <ContactPicker kind="vendor" value={vendorId} onChange={setVendorId} />}
              </Field>
              <Field label="Received on" required>
                <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} data-slot="grn-edit-date" />
              </Field>
              <Field label="Supplier's challan no.">
                <Input value={challanNo} onChange={(e) => setChallanNo(e.target.value)} data-slot="grn-edit-challan" />
              </Field>
              <GodownPicker branchId={note.branchId} value={warehouseId} onChange={setWarehouseId} />
            </div>
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-[11px] uppercase text-muted-foreground">
                  <tr><th className="px-2 py-1.5 text-left">Item</th><th className="w-24 px-2 py-1.5 text-right">Qty</th><th className="w-36 px-2 py-1.5 text-right">Rate</th><th className="w-8" /></tr>
                </thead>
                <tbody>
                  {lines.map((l) => {
                    const it = items.find((i) => i.id === l.itemId);
                    return (
                      <tr key={l.key} className="border-t align-top" data-slot="grn-edit-line">
                        <td className="px-2 py-1.5">
                          {l.poLineId ? (
                            <span className="block py-1.5">{it?.name ?? l.description ?? 'Item'} <span className="text-[11px] text-muted-foreground">· order line</span></span>
                          ) : (
                            <Combobox options={itemOptions({ items } as never, 'purchase')} value={l.itemId} showAvatar={false} placeholder="Select an item"
                              onChange={(v) => { const x = items.find((i) => i.id === v); set(l.key, { itemId: v, ratePaise: x?.purchasePricePaise ?? l.ratePaise, gstRatePct: x?.gstRatePct ?? l.gstRatePct, description: x?.name ?? null, hsnSac: x?.hsnSac ?? null, uqc: x?.uqc ?? null }); }} />
                          )}
                          {it?.trackBatches && (
                            <div className="mt-1.5 flex gap-2">
                              <Input value={l.batchNo} onChange={(e) => set(l.key, { batchNo: e.target.value })} placeholder="Batch no." className="h-8 font-mono text-xs" />
                              <Input type="date" value={l.expiryDate} onChange={(e) => set(l.key, { expiryDate: e.target.value })} className="h-8 text-xs" title="Expiry" />
                            </div>
                          )}
                          {it?.trackSerials && (
                            <textarea value={l.serials} onChange={(e) => set(l.key, { serials: e.target.value })} rows={2} placeholder="Serial numbers, one per line"
                              className="mt-1.5 w-full rounded-md border border-input bg-background px-2 py-1 font-mono text-xs outline-none focus:border-ring" />
                          )}
                        </td>
                        <td className="px-2 py-1.5">
                          <Input type="number" min="0" step="any" value={l.qty} onChange={(e) => set(l.key, { qty: Number(e.target.value) || 0 })} className="h-9 text-right" data-slot="grn-edit-qty" />
                        </td>
                        <td className="px-2 py-1.5"><MoneyInput valuePaise={l.ratePaise} onChangePaise={(v) => set(l.key, { ratePaise: v })} /></td>
                        <td className="px-1 py-1.5">
                          {lines.length > 1 && (
                            <button type="button" aria-label="Remove line" className="mt-2 text-muted-foreground hover:text-destructive" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>
                              <Trash2 className="size-4" />
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {!fromOrder && (
              <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setLines((ls) => [...ls, {
                key: `n${Date.now()}`, poLineId: null, itemId: '', description: null, hsnSac: null, uqc: null, qty: 1, ratePaise: 0, gstRatePct: 18,
                batchNo: '', mfgDate: null, expiryDate: '', serials: '',
              }])}>
                <Plus className="size-3.5" /> Add line
              </Button>
            )}
            <Field label="Notes"><Input value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
            <div className="flex items-center justify-between rounded-md border bg-muted/30 px-3 py-2 text-sm">
              <span className="text-muted-foreground">Value incl. GST</span>
              <span className="font-semibold tabular">{formatINR(total)}</span>
            </div>
            {error && <p className="text-sm text-destructive" data-slot="grn-edit-error">{error}</p>}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void save()} disabled={busy || !note} data-slot="grn-edit-save" className="gap-1.5">
            {busy && <Loader2 className="size-3.5 animate-spin" />} Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Zoho's Delete on a goods receipt, asked once with an optional reason kept with the record. */
export function DeleteGoodsReceiptDialog({ receipt, onClose, onDeleted }: {
  receipt: { id: string; number: string; status: string } | null; onClose: () => void; onDeleted: () => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setReason(''); setError(null); }, [receipt?.id]);
  return (
    <Dialog open={!!receipt} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent data-slot="grn-delete-dialog">
        <DialogHeader>
          <DialogTitle>Delete {receipt?.number}?</DialogTitle>
          <DialogDescription>
            {receipt?.status === 'cancelled'
              ? 'It was cancelled, so its stock and accrual are already reversed. It is removed; the audit trail keeps a copy of it as it was.'
              : 'The goods leave stock, the accrual is reversed in the ledger, and the purchase order gets its quantity back. The audit trail keeps a copy of it as it was.'}
          </DialogDescription>
        </DialogHeader>
        <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (optional): entered in error" data-slot="grn-delete-reason" />
        {error && <p className="text-sm text-destructive" data-slot="grn-delete-error">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button variant="destructive" disabled={busy} data-slot="grn-delete-confirm" className="gap-1.5" onClick={async () => {
            if (!receipt) return;
            setBusy(true); setError(null);
            try {
              await goodsReceipts.remove(receipt.id, reason.trim() || undefined);
              toast.success(`${receipt.number} deleted`);
              onDeleted();
              onClose();
            } catch (e) {
              setError(e instanceof ApiError ? e.message : String(e));
            } finally { setBusy(false); }
          }}>
            {busy && <Loader2 className="size-3.5 animate-spin" />} Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
