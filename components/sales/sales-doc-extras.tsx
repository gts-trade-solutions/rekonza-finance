'use client';

// The windows behind Zoho Books' sales record ⋯ actions that need a choice
// first: a quote's Create Project, a sales order's Convert to Purchase Order
// and Cancel Items (recorded from Zoho's demo, 2026-11-23).

import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Combobox } from '@/components/ui/combobox';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Field, MoneyInput } from '@/components/shared/form-bits';
import { useAppStore } from '@/lib/store';
import { localDay } from '@/lib/selectors';
import { salesDocuments, type EditableSalesDoc } from '@/lib/api/client';

const today = () => localDay(new Date());

/** Zoho's quote → Create Project: a project for the customer, the quote put on it. */
export function CreateProjectDialog({ doc, onClose, onDone }: { doc: EditableSalesDoc; onClose: () => void; onDone: (projectId: string) => void }) {
  const [name, setName] = useState(`${doc.customerName ?? ''} – ${doc.number}`);
  const [method, setMethod] = useState<'fixed' | 'project_hours'>('fixed');
  const [rate, setRate] = useState(0);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      const r = await salesDocuments.createProject(doc.id, { name, billingMethod: method, ratePaise: method === 'project_hours' ? rate : undefined });
      toast.success(`Project "${r.name}" created`, { description: `${doc.number} is now on it.` });
      onDone(r.projectId);
    } catch (e) {
      toast.error('No project', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md" data-slot="create-project-dialog">
        <DialogHeader>
          <DialogTitle>Create Project</DialogTitle>
          <DialogDescription>A project for {doc.customerName}, from {doc.number}. Time and expenses logged on it can be billed later.</DialogDescription>
        </DialogHeader>
        <Field label="Project Name" required><Input value={name} onChange={(e) => setName(e.target.value)} data-slot="project-name" /></Field>
        <Field label="Billing Method">
          <Combobox
            options={[{ value: 'fixed', label: 'Fixed Cost for Project' }, { value: 'project_hours', label: 'Based on Project Hours' }]}
            value={method} onChange={(v) => setMethod(v as 'fixed' | 'project_hours')} showAvatar={false}
          />
        </Field>
        {method === 'fixed'
          ? <p className="text-[12px] text-muted-foreground">The fixed cost is the quote’s value before tax; change it on the project if needed.</p>
          : <Field label="Rate Per Hour" required><MoneyInput valuePaise={rate} onChangePaise={setRate} /></Field>}
        <DialogFooter>
          <Button onClick={() => void go()} disabled={busy || !name.trim() || (method === 'project_hours' && rate <= 0)} data-slot="project-save">Save</Button>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Zoho's sales order → Convert to Purchase Order: the goods bought in for it, from the vendor chosen. */
export function ToPurchaseOrderDialog({ doc, onClose, onDone }: { doc: EditableSalesDoc; onClose: () => void; onDone: (poId: string) => void }) {
  const contacts = useAppStore((s) => s.contacts);
  const vendors = useMemo(() => contacts.filter((c) => c.kind === 'vendor' || c.kind === 'both').map((c) => ({ value: c.id, label: c.displayName })), [contacts]);
  const [vendorId, setVendorId] = useState('');
  const [date, setDate] = useState(today());
  const [expected, setExpected] = useState('');
  const [busy, setBusy] = useState(false);
  const itemLines = doc.lines.filter((l) => l.itemId);
  const go = async () => {
    setBusy(true);
    try {
      const r = await salesDocuments.toPurchaseOrder(doc.id, { vendorId, date, expectedDate: expected || null });
      toast.success(`Purchase order ${r.number} raised`, { description: r.skipped ? `${r.skipped} line(s) without an item were left off.` : `For ${doc.number}, at your purchase prices.` });
      onDone(r.purchaseOrderId);
    } catch (e) {
      toast.error('No purchase order', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md" data-slot="to-po-dialog">
        <DialogHeader>
          <DialogTitle>Convert to Purchase Order</DialogTitle>
          <DialogDescription>
            The {itemLines.length} item{itemLines.length === 1 ? '' : 's'} on {doc.number} still to supply, ordered from the vendor at what you pay for each.
          </DialogDescription>
        </DialogHeader>
        <Field label="Vendor Name" required>
          <Combobox options={vendors} value={vendorId} onChange={setVendorId} placeholder="Select a vendor" searchPlaceholder="Search vendors" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Purchase Order Date" required><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          <Field label="Expected Delivery Date"><Input type="date" value={expected} onChange={(e) => setExpected(e.target.value)} /></Field>
        </div>
        <DialogFooter>
          <Button onClick={() => void go()} disabled={busy || !vendorId || !itemLines.length} data-slot="to-po-save">Convert</Button>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Zoho's sales order → Cancel Items: quantity that will never be invoiced or delivered. */
export function CancelItemsDialog({ doc, onClose, onDone }: { doc: EditableSalesDoc; onClose: () => void; onDone: () => void }) {
  const open = doc.lines
    .map((l) => ({ ...l, left: Math.max(0, Math.min(l.qty - (l.qtyInvoiced ?? 0) - (l.qtyCancelled ?? 0), l.qty - (l.qtyDelivered ?? 0) - (l.qtyCancelled ?? 0))) }))
    .filter((l) => l.left > 0 && l.lineId);
  const [qty, setQty] = useState<Record<string, number>>(() => Object.fromEntries(open.map((l) => [l.lineId!, l.left])));
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      const lines = open.filter((l) => (qty[l.lineId!] ?? 0) > 0).map((l) => ({ lineId: l.lineId!, qty: qty[l.lineId!] }));
      const r = await salesDocuments.cancelItems(doc.id, lines);
      toast.success(`${r.cancelled} cancelled on ${doc.number}`, { description: r.status === 'cancelled' ? 'Nothing was invoiced, so the order is void.' : r.status === 'invoiced' ? 'Nothing is left to invoice.' : 'The rest is still to invoice.' });
      onDone();
    } catch (e) {
      toast.error('Not cancelled', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-lg" data-slot="cancel-items-dialog">
        <DialogHeader>
          <DialogTitle>Cancel Items</DialogTitle>
          <DialogDescription>The quantity cancelled is never invoiced or delivered. Goods already delivered on a challan are invoiced from the challan instead.</DialogDescription>
        </DialogHeader>
        {open.length ? (
          <table className="w-full text-[13px]">
            <thead className="text-[11px] uppercase text-muted-foreground"><tr><th className="py-1 text-left">Item</th><th className="py-1 text-right">Left</th><th className="w-28 py-1 text-right">Cancel</th></tr></thead>
            <tbody>
              {open.map((l) => (
                <tr key={l.lineId} className="border-t">
                  <td className="py-1.5">{l.itemName ?? l.description}</td>
                  <td className="py-1.5 text-right tabular">{l.left} {l.uqc}</td>
                  <td className="py-1.5"><Input type="number" min="0" max={l.left} step="any" value={qty[l.lineId!] ?? 0}
                    onChange={(e) => setQty((m) => ({ ...m, [l.lineId!]: Math.min(l.left, Math.max(0, Number(e.target.value) || 0)) }))} className="h-8 text-right" data-slot="cancel-qty" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="text-[13px] text-muted-foreground">Nothing is left to cancel: everything is invoiced, delivered or already cancelled.</p>}
        <DialogFooter>
          <Button variant="destructive" onClick={() => void go()} disabled={busy || !open.some((l) => (qty[l.lineId!] ?? 0) > 0)} data-slot="cancel-items-save">Cancel Items</Button>
          <Button variant="outline" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
