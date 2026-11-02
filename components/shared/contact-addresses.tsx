'use client';

// A customer's or vendor's other addresses — delivery sites, godowns, branch
// offices — each with its state and, when registered on its own, its GSTIN.
// The invoice form offers them as the ship-to (services/contact-addresses.ts).

import { useState } from 'react';
import { MapPin, Pencil, Plus, Star, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Combobox } from '@/components/ui/combobox';
import { api } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { GST_STATES } from '@/lib/tax/gst';

export interface ContactAddress {
  id: string; label: string; name: string | null; address: string; city: string | null; pincode: string | null;
  stateCode: string; gstin: string | null; phone: string | null; isDefault: boolean;
}

const states = Object.entries(GST_STATES).map(([code, name]) => ({ value: code, label: name, sublabel: code }));
const blank = { id: null as string | null, label: '', name: '', address: '', city: '', pincode: '', stateCode: '', gstin: '', phone: '', isDefault: false };

export function ContactAddresses({ contactId, canEdit }: { contactId: string; canEdit: boolean }) {
  const state = useApi(() => api.get<{ addresses: ContactAddress[] }>(`/api/contacts/${contactId}/addresses`), [contactId]);
  const [form, setForm] = useState<typeof blank | null>(null);
  const [busy, setBusy] = useState(false);
  const list = state.data?.addresses ?? [];

  const post = async (payload: Record<string, unknown>, done: string) => {
    setBusy(true);
    try {
      await api.post(`/api/contacts/${contactId}/addresses`, payload);
      toast.success(done);
      setForm(null);
      state.refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const set = (k: keyof typeof blank) => (e: React.ChangeEvent<HTMLInputElement>) => form && setForm({ ...form, [k]: e.target.value });

  return (
    <Card className="space-y-3 p-5" data-slot="contact-addresses">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-3">
          <MapPin className="mt-0.5 size-5 text-muted-foreground" />
          <div className="text-sm">
            <p className="font-medium">Other addresses</p>
            <p className="text-muted-foreground">Delivery sites and branches, picked as the ship-to on an invoice. The state of the one goods go to is the place of supply.</p>
          </div>
        </div>
        {canEdit && !form && <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setForm({ ...blank, isDefault: !list.length })}><Plus className="size-3.5" /> Add address</Button>}
      </div>

      {list.map((a) => (
        <div key={a.id} className="flex items-start justify-between gap-3 rounded-md border p-3 text-sm">
          <div className="min-w-0">
            <p className="flex items-center gap-2 font-medium">{a.label}{a.isDefault && <Badge variant="outline" className="gap-1 text-[10px]"><Star className="size-2.5" /> Default ship-to</Badge>}</p>
            <p className="whitespace-pre-line text-muted-foreground">{[a.name, a.address, [a.city, a.pincode].filter(Boolean).join(' '), GST_STATES[a.stateCode]].filter(Boolean).join('\n')}</p>
            {(a.gstin || a.phone) && <p className="text-xs text-muted-foreground">{[a.gstin && `GSTIN ${a.gstin}`, a.phone].filter(Boolean).join(' · ')}</p>}
          </div>
          {canEdit && (
            <span className="flex shrink-0 gap-1">
              <Button size="icon-sm" variant="ghost" aria-label={`Change ${a.label}`} onClick={() => setForm({ ...blank, ...a, name: a.name ?? '', city: a.city ?? '', pincode: a.pincode ?? '', gstin: a.gstin ?? '', phone: a.phone ?? '' })}><Pencil className="size-3.5" /></Button>
              <Button size="icon-sm" variant="ghost" aria-label={`Remove ${a.label}`} disabled={busy}
                onClick={() => { if (window.confirm(`Remove the address ${a.label}? Invoices already raised keep theirs.`)) void post({ action: 'delete', id: a.id }, 'Address removed'); }}><Trash2 className="size-3.5" /></Button>
            </span>
          )}
        </div>
      ))}
      {!list.length && !form && <p className="text-xs text-muted-foreground">None yet: invoices go to the contact&apos;s own address unless another is typed in.</p>}

      {form && (
        <div className="grid gap-2 rounded-md border p-3 sm:grid-cols-2" data-slot="address-form">
          <Input aria-label="Address name" placeholder="Name it, e.g. Hosur godown" value={form.label} onChange={set('label')} maxLength={80} />
          <Input aria-label="Name at the address" placeholder="Name at the address" value={form.name} onChange={set('name')} maxLength={150} />
          <Input aria-label="Address" placeholder="Address" value={form.address} onChange={set('address')} maxLength={500} className="sm:col-span-2" />
          <Input aria-label="City" placeholder="City" value={form.city} onChange={set('city')} maxLength={60} />
          <Input aria-label="PIN code" placeholder="PIN code" value={form.pincode} onChange={(e) => setForm({ ...form, pincode: e.target.value.replace(/\D/g, '').slice(0, 6) })} />
          <Combobox options={states} value={form.stateCode} onChange={(v) => setForm({ ...form, stateCode: v })} placeholder="State" showAvatar={false} />
          <Input aria-label="GSTIN at this address" placeholder="GSTIN, if registered here" value={form.gstin} onChange={(e) => setForm({ ...form, gstin: e.target.value.toUpperCase() })} maxLength={15} />
          <Input aria-label="Phone" placeholder="Phone" value={form.phone} onChange={set('phone')} maxLength={30} />
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={form.isDefault} onCheckedChange={(v) => setForm({ ...form, isDefault: !!v })} /> Default ship-to
          </label>
          <div className="flex gap-2 sm:col-span-2">
            <Button size="sm" disabled={busy || !form.label.trim() || !form.address.trim() || !form.stateCode}
              onClick={() => post({ action: 'save', ...form, id: form.id }, form.id ? 'Address changed' : 'Address added')}>{busy ? 'Saving…' : 'Save address'}</Button>
            <Button size="sm" variant="ghost" onClick={() => setForm(null)}>Cancel</Button>
          </div>
        </div>
      )}
    </Card>
  );
}
