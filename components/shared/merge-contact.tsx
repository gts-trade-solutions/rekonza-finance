'use client';

// "Merge into…" on a customer or vendor, as in Zoho Books: pick the contact to
// keep, see what will move to it (and whether GST allows it), then merge.
// Everything of this contact moves; this one is archived, pointing at the other.

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { GitMerge, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import { ContactPicker } from '@/components/forms/quick-create';
import { api } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { useAppStore } from '@/lib/store';

interface Preview { from: { id: string; name: string }; into: { id: string; name: string }; blocked: string | null; counts: Record<string, number> }

/** What each moved table holds, singular and plural, in the app's own words. */
const NAMES: Record<string, [string, string]> = {
  invoices: ['invoice', 'invoices'], estimates: ['quote', 'quotes'], sales_orders: ['sales order', 'sales orders'],
  delivery_challans: ['delivery challan', 'delivery challans'], credit_notes: ['credit note', 'credit notes'],
  retainer_invoices: ['retainer', 'retainers'], recurring_invoices: ['recurring invoice', 'recurring invoices'],
  payments: ['payment', 'payments'], journal_lines: ['ledger line', 'ledger lines'], bills: ['bill', 'bills'],
  purchase_orders: ['purchase order', 'purchase orders'], vendor_credits: ['vendor credit', 'vendor credits'],
  expenses: ['expense', 'expenses'], contact_persons: ['contact person', 'contact people'], contact_addresses: ['address', 'addresses'],
  portal_access: ['portal link', 'portal links'], projects: ['project', 'projects'], documents: ['document', 'documents'],
  files: ['file', 'files'], comments: ['comment', 'comments'],
};
const words = (table: string, n: number) => {
  const [one, many] = NAMES[table] ?? [table.replace(/_/g, ' '), table.replace(/_/g, ' ')];
  return `${n} ${n === 1 ? one : many}`;
};

export function MergeContactButton({ contactId, name, side }: { contactId: string; name: string; side: 'customer' | 'vendor' }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [into, setInto] = useState('');
  const [busy, setBusy] = useState(false);
  const preview = useApi<Preview | null>(
    () => (open && into && into !== contactId ? api.get<Preview>(`/api/contacts/${contactId}/merge`, { into }) : Promise.resolve(null)),
    [open, into, contactId],
  );
  const p = preview.data;
  const total = p ? Object.values(p.counts).reduce((t, n) => t + n, 0) : 0;

  const merge = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ from: string; into: string; intoId: string; moved: Record<string, number> }>(`/api/contacts/${contactId}/merge`, { intoId: into });
      useAppStore.setState((s) => ({ contacts: s.contacts.filter((c) => c.id !== contactId) }));
      toast.success(`${r.from} merged into ${r.into}`, { description: `${Object.values(r.moved).reduce((t, n) => t + n, 0)} records moved. ${r.from} is archived.` });
      setOpen(false);
      router.push(side === 'customer' ? `/sales/customers/${r.intoId}` : `/purchases/vendors/${r.intoId}`);
    } catch (e) {
      toast.error('Not merged', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setInto(''); }}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5" data-slot="merge-contact"><GitMerge className="size-3.5" /> Merge</Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Merge {name} into another {side}</DialogTitle>
          <DialogDescription>
            Every invoice, bill, payment, order, credit and ledger line of {name} moves to the {side} you choose. {name} is then archived. This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <ContactPicker kind={side} value={into} onChange={setInto} placeholder={`The ${side} to keep`} canCreate={false} />
        {into === contactId && <p className="text-sm text-destructive">Choose a different {side}.</p>}
        {preview.loading && into && <p className="text-sm text-muted-foreground">Checking…</p>}
        {preview.error && <p className="text-sm text-destructive">{preview.error}</p>}
        {p && (
          <div className="space-y-2 text-sm" data-slot="merge-preview">
            {p.blocked ? (
              <p className="rounded-[3px] border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive" data-slot="merge-blocked">{p.blocked}</p>
            ) : total === 0 ? (
              <p className="text-muted-foreground">{p.from.name} has nothing recorded yet; it will simply be archived.</p>
            ) : (
              <>
                <p>{total} record{total === 1 ? '' : 's'} will move to <span className="font-medium">{p.into.name}</span>:</p>
                <ul className="grid grid-cols-2 gap-x-4 text-xs text-muted-foreground">
                  {Object.entries(p.counts).sort((a, b) => b[1] - a[1]).map(([t, n]) => <li key={t}>{words(t, n)}</li>)}
                </ul>
              </>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          <Button variant="destructive" disabled={!p || !!p.blocked || busy} onClick={() => void merge()} data-slot="merge-confirm">
            {busy && <Loader2 className="size-3.5 animate-spin" />} Merge into {p?.into.name ?? '…'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
