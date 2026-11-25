'use client';

// Edit and Delete beside each contact person on a customer's or vendor's
// Overview, as Zoho has them (PATCH and DELETE /api/contacts/[id]/persons/[personId]).
// Visible buttons with their words (2026-11-25). Made primary, a person is the
// only primary. Removed, they no longer get the documents emailed to the
// contact or sign in to its portal by their own address.

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/shared/form-bits';
import { DeleteConfirmDialog, RowActions } from '@/components/shared/row-actions';
import { api, type ContactPerson } from '@/lib/api/client';

const SALUTATIONS = ['', 'Mr.', 'Mrs.', 'Ms.', 'Miss', 'Dr.'];

/** First and last name from what was saved: the parts if kept, else the whole name split at its first space. */
function parts(p: ContactPerson) {
  if (p.firstName || p.lastName) return { first: p.firstName ?? '', last: p.lastName ?? '' };
  const [first, ...rest] = p.name.split(' ');
  return { first: first ?? '', last: rest.join(' ') };
}

/** The person as the Edit window opens with them. */
function formOf(person: ContactPerson) {
  const n = parts(person);
  return {
    salutation: person.salutation ?? '', firstName: n.first, lastName: n.last, email: person.email ?? '', phone: person.phone ?? '',
    mobile: person.mobile ?? '', designation: person.designation ?? '', department: person.department ?? '',
    isPrimary: person.isPrimary, receivesDocuments: person.receivesDocuments,
  };
}

function EditPersonDialog({ contactId, person, open, onOpenChange, onSaved }: {
  contactId: string; person: ContactPerson; open: boolean; onOpenChange: (o: boolean) => void; onSaved: () => void;
}) {
  const [f, setF] = useState(() => formOf(person));
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) setF(formOf(person)); }, [open, person]);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  const save = async () => {
    if (!f.firstName.trim() && !f.lastName.trim()) { toast.error('Give the person a name.'); return; }
    setBusy(true);
    try {
      await api.patch(`/api/contacts/${contactId}/persons/${person.id}`, {
        ...f, salutation: f.salutation || null, email: f.email.trim() || null, phone: f.phone || null, mobile: f.mobile || null,
        designation: f.designation || null, department: f.department || null,
      });
      toast.success(`${[f.firstName, f.lastName].filter(Boolean).join(' ')} saved`);
      onOpenChange(false);
      onSaved();
    } catch (e) {
      toast.error('Not saved', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" data-slot="person-edit-dialog">
        <DialogHeader>
          <DialogTitle>Edit contact person</DialogTitle>
          <DialogDescription>Documents emailed to this contact go to the people marked to receive them.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-[110px_1fr_1fr]">
          <Field label="Salutation">
            <select value={f.salutation} onChange={(e) => setF({ ...f, salutation: e.target.value })} aria-label="Salutation"
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
              {SALUTATIONS.map((s) => <option key={s} value={s}>{s || '—'}</option>)}
            </select>
          </Field>
          <Field label="First name" required><Input value={f.firstName} onChange={set('firstName')} maxLength={100} data-slot="person-edit-first" /></Field>
          <Field label="Last name"><Input value={f.lastName} onChange={set('lastName')} maxLength={100} data-slot="person-edit-last" /></Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Email" className="sm:col-span-2"><Input type="email" value={f.email} onChange={set('email')} maxLength={190} data-slot="person-edit-email" /></Field>
          <Field label="Work phone"><Input value={f.phone} onChange={set('phone')} maxLength={30} /></Field>
          <Field label="Mobile"><Input value={f.mobile} onChange={set('mobile')} maxLength={30} /></Field>
          <Field label="Designation"><Input value={f.designation} onChange={set('designation')} maxLength={100} /></Field>
          <Field label="Department"><Input value={f.department} onChange={set('department')} maxLength={100} /></Field>
          <label className="flex items-center justify-between gap-3 rounded-md border p-3 text-sm">
            <span>Primary contact<span className="block text-xs text-muted-foreground">Only one person is primary.</span></span>
            <Switch checked={f.isPrimary} onCheckedChange={(v) => setF({ ...f, isPrimary: v })} data-slot="person-edit-primary" />
          </label>
          <label className="flex items-center justify-between gap-3 rounded-md border p-3 text-sm">
            <span>Receives documents<span className="block text-xs text-muted-foreground">Invoices, statements, reminders.</span></span>
            <Switch checked={f.receivesDocuments} onCheckedChange={(v) => setF({ ...f, receivesDocuments: v })} />
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button onClick={() => void save()} disabled={busy} data-slot="person-edit-save">{busy ? 'Saving…' : 'Save'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Edit and Delete for one person of the Contact Persons section. */
export function ContactPersonActions({ contactId, person, onChanged }: { contactId: string; person: ContactPerson; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  if (!person.id) return null;
  const label = [person.salutation, person.name].filter(Boolean).join(' ');
  return (
    <>
      <RowActions className="justify-start" onEdit={() => setEditing(true)} onDelete={() => setDeleting(true)}
        editTitle={`Edit ${label}`} deleteTitle={`Delete ${label}`} />
      <EditPersonDialog contactId={contactId} person={person} open={editing} onOpenChange={setEditing} onSaved={onChanged} />
      <DeleteConfirmDialog
        open={deleting} onOpenChange={setDeleting} withReason={false}
        title={`Delete ${label}?`}
        description="They are taken off this contact: documents are no longer emailed to them, and their own address no longer opens the portal. Documents already sent are not changed."
        onConfirm={() => api.delete(`/api/contacts/${contactId}/persons/${person.id}`)}
        doneMessage={`${label} deleted`} onDone={onChanged}
      />
    </>
  );
}
