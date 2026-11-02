'use client';

// The people at a customer or vendor: who orders, who pays, who should get the
// invoice. One primary; those marked receive documents.

import { useEffect, useState } from 'react';
import { Mail, Pencil, Phone, Plus, Star, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { contactPersons, type ContactPerson } from '@/lib/api/client';
import { useApi, useApiAction } from '@/lib/api/use-api';

const BLANK: ContactPerson = { id: null, salutation: null, name: '', email: null, phone: null, designation: null, department: null, isPrimary: false, receivesDocuments: true };

export function ContactPersons({ contactId, canEdit }: { contactId: string; canEdit: boolean }) {
  const state = useApi(() => contactPersons.list(contactId), [contactId]);
  const save = useApiAction(contactPersons.save);
  const [editing, setEditing] = useState(false);
  const [rows, setRows] = useState<ContactPerson[]>([]);
  useEffect(() => { setRows(state.data?.persons ?? []); }, [state.data]);
  const set = (i: number, patch: Partial<ContactPerson>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : patch.isPrimary ? { ...r, isPrimary: false } : r)));

  const submit = async () => {
    const clean = rows.filter((r) => r.name.trim());
    if (!(await save.run(contactId, clean))) { toast.error(save.error ?? 'Not saved'); return; }
    toast.success('Contact persons saved');
    setEditing(false);
    state.refetch();
  };

  return (
    <div className="space-y-3" data-slot="contact-persons">
      <div className="flex justify-end gap-2">
        {canEdit && !editing && <Button size="sm" variant="outline" onClick={() => { setEditing(true); if (!rows.length) setRows([{ ...BLANK, isPrimary: true }]); }} className="gap-1.5"><Pencil className="size-3.5" /> Edit people</Button>}
        {editing && <Button size="sm" variant="ghost" onClick={() => setRows([...rows, { ...BLANK }])} className="gap-1.5"><Plus className="size-3.5" /> Person</Button>}
      </div>
      {!editing ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {(state.data?.persons ?? []).map((p) => (
            <Card key={p.id} className="space-y-1 p-4 text-sm">
              <p className="flex items-center gap-1.5 font-medium">{p.salutation ? `${p.salutation} ` : ''}{p.name} {p.isPrimary && <Star className="size-3.5 fill-current text-amber-500" aria-label="Primary" />}</p>
              <p className="text-xs text-muted-foreground">{[p.designation, p.department].filter(Boolean).join(' · ')}</p>
              {p.email && <p className="flex items-center gap-1.5 text-xs"><Mail className="size-3" /> {p.email}</p>}
              {p.phone && <p className="flex items-center gap-1.5 text-xs"><Phone className="size-3" /> {p.phone}</p>}
              {!p.receivesDocuments && <p className="text-[11px] text-muted-foreground">Does not receive documents</p>}
            </Card>
          ))}
          {state.data && !state.data.persons.length && <p className="text-sm text-muted-foreground">No people added. The contact&rsquo;s own email and phone are used.</p>}
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map((r, i) => (
            <Card key={i} className="grid gap-2 p-3 sm:grid-cols-6">
              <Input placeholder="Mr/Ms" value={r.salutation ?? ''} onChange={(e) => set(i, { salutation: e.target.value || null })} />
              <Input placeholder="Name" className="sm:col-span-2" value={r.name} onChange={(e) => set(i, { name: e.target.value })} />
              <Input placeholder="Designation" className="sm:col-span-3" value={r.designation ?? ''} onChange={(e) => set(i, { designation: e.target.value || null })} />
              <Input placeholder="Email" className="sm:col-span-3" value={r.email ?? ''} onChange={(e) => set(i, { email: e.target.value || null })} />
              <Input placeholder="Phone" className="sm:col-span-2" value={r.phone ?? ''} onChange={(e) => set(i, { phone: e.target.value || null })} />
              <Button size="icon-sm" variant="ghost" aria-label="Remove person" onClick={() => setRows(rows.filter((_, j) => j !== i))}><Trash2 className="size-4" /></Button>
              <label className="flex items-center gap-2 text-xs sm:col-span-3"><Switch checked={r.isPrimary} onCheckedChange={(v) => set(i, { isPrimary: v })} /> Primary contact</label>
              <label className="flex items-center gap-2 text-xs sm:col-span-3"><Switch checked={r.receivesDocuments} onCheckedChange={(v) => set(i, { receivesDocuments: v })} /> Receives invoices and statements</label>
            </Card>
          ))}
          {save.error && <p className="text-sm text-destructive">{save.error}</p>}
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => { setEditing(false); setRows(state.data?.persons ?? []); }}>Cancel</Button>
            <Button size="sm" onClick={submit} disabled={save.busy}>{save.busy ? 'Saving…' : 'Save'}</Button>
          </div>
        </div>
      )}
    </div>
  );
}
