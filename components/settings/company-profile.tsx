'use client';

// Settings → Organisation: the company's registration (item 9 of the client's
// list) and its divisions.
//
// Registration: the GSTIN it is registered under, the kind of company (eight
// kinds), what it does, its CIN and the dates it was incorporated and
// registered for GST, filled from the GSTIN and the CIN where they can be.
//
// Divisions: one company, one GSTIN, kept in separate layers (Spares, Service,
// Exports …) each with its own sales, expenses and profit. A division is a
// cost centre of the kind "Division": documents carry it, and the cost centre
// profit and loss gives each its own.

import { useState } from 'react';
import Link from 'next/link';
import { Layers, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { MultiCombobox } from '@/components/ui/multi-combobox';
import { Field } from '@/components/shared/form-bits';
import { CinLookupButton, GstinLookupButton, GstinNumberOnlyNote, type GstinDetails } from '@/components/gst/gstn-portal';
import { BUSINESS_NATURES, COMPANY_TYPES, companyTypeFrom } from '@/lib/company-profile';
import { api } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';
import { RowActions, reasonQuery, useConfirmDelete } from '@/components/shared/row-actions';

export interface Registration {
  legalName: string; pan: string; address: string;
  constitution: string; businessNature: string[]; cin: string; incorporatedOn: string; gstRegisteredOn: string;
}

export function CompanyRegistration({ value, onChange, canEdit, gstin, registrationType, savedCin = '' }: {
  value: Registration;
  /** The CIN on file: not looked up again by itself. */
  savedCin?: string;
  onChange: (v: Registration) => void;
  canEdit: boolean;
  /** The primary branch's GSTIN; edited with the branch. */
  gstin: string | null;
  registrationType: string;
}) {
  const set = (patch: Partial<Registration>) => onChange({ ...value, ...patch });
  const [lookup, setLookup] = useState<GstinDetails | null>(null);
  return (
    <Card className="space-y-4 p-5" data-slot="company-registration">
      <div>
        <h3 className="text-sm font-semibold">Company registration</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">The GST registration, the kind of company and when it was formed. Saved with the details above.</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="GSTIN" hint={gstin ? `${registrationType} scheme · edited under Branches below` : 'Add it to the primary branch below'}>
          <div className="flex gap-2">
            <Input value={gstin ?? ''} readOnly className="bg-muted/40 font-mono" placeholder="Not registered" />
            {gstin && canEdit && (
              <GstinLookupButton gstin={gstin} auto={false} onFound={(d) => { setLookup(d); set({
                legalName: d.legalName ?? value.legalName,
                pan: d.pan ?? value.pan,
                constitution: companyTypeFrom(d.constitution) ?? value.constitution,
                gstRegisteredOn: d.registeredOn ?? value.gstRegisteredOn,
                address: d.address?.line ? [d.address.line, d.address.city, d.address.pincode].filter(Boolean).join(', ') : value.address,
              }); }} />
            )}
          </div>
          <GstinNumberOnlyNote details={lookup} gstin={gstin ?? ''} />
        </Field>
        <Field label="GST registered on" hint="The date on the GST registration certificate">
          <Input type="date" value={value.gstRegisteredOn} onChange={(e) => set({ gstRegisteredOn: e.target.value })} disabled={!canEdit} />
        </Field>
        <Field label="Type of company">
          <select value={value.constitution} onChange={(e) => set({ constitution: e.target.value })} disabled={!canEdit}
            className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm" aria-label="Type of company" data-slot="company-type">
            <option value="">Choose the type</option>
            {COMPANY_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            {value.constitution && !(COMPANY_TYPES as readonly string[]).includes(value.constitution) && <option value={value.constitution}>{value.constitution}</option>}
          </select>
        </Field>
        <Field label="Nature of business" hint="Everything it does">
          {canEdit ? (
            <MultiCombobox options={BUSINESS_NATURES.map((n) => ({ value: n, label: n }))} value={value.businessNature}
              onChange={(v) => set({ businessNature: v })} placeholder="Choose what it does" searchPlaceholder="Search" />
          ) : (
            <Input value={value.businessNature.join(', ')} readOnly className="bg-muted/40" />
          )}
        </Field>
        <Field label="CIN (companies and LLPs)" hint="Fills the date of incorporation">
          <div className="flex gap-2">
            <Input value={value.cin} onChange={(e) => set({ cin: e.target.value.toUpperCase() })} className="font-mono" maxLength={21}
              placeholder="U74999TN2015PTC123456" disabled={!canEdit} />
            {canEdit && <CinLookupButton cin={value.cin} auto={value.cin.trim().toUpperCase() !== savedCin.trim().toUpperCase()} onFound={(d) => set({
              incorporatedOn: d.incorporatedOn ?? value.incorporatedOn,
              constitution: value.constitution || companyTypeFrom(d.kind) || '',
            })} />}
          </div>
        </Field>
        <Field label="Date of incorporation" hint="On the certificate of incorporation">
          <Input type="date" value={value.incorporatedOn} onChange={(e) => set({ incorporatedOn: e.target.value })} disabled={!canEdit} />
        </Field>
      </div>
    </Card>
  );
}

interface Centre { id: string; code: string; name: string; category: string | null; isActive: boolean }

export function DivisionsCard({ canEdit: settingsEdit }: { canEdit: boolean }) {
  // A division is a cost centre: adding one needs the accountant's right to edit them.
  const mayAddCentres = usePermission('accountant', 'edit');
  const mayDeleteCentres = usePermission('accountant', 'void');
  const canEdit = settingsEdit && mayAddCentres;
  const canDelete = settingsEdit && mayDeleteCentres;
  // The division being renamed, in place.
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const del = useConfirmDelete();
  const state = useApi(() => api.get<{ centres: Centre[] }>('/api/cost-centres'), []);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const divisions = (state.data?.centres ?? []).filter((c) => (c.category ?? '').toLowerCase() === 'division');

  const add = async () => {
    const n = name.trim();
    if (!n) return;
    // A code from the name, numbered on until no cost centre has it.
    const base = n.toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 10) || 'DIV';
    const taken = new Set((state.data?.centres ?? []).map((c) => c.code.toUpperCase()));
    let code = base;
    for (let i = 2; taken.has(code); i++) code = `${base.slice(0, 10 - String(i).length)}${i}`;
    setBusy(true);
    try {
      await api.post('/api/cost-centres', { code, name: n, category: 'Division' });
      toast.success(`${n} added`, { description: 'Pick it on invoices, bills and expenses; its profit shows under Cost centres.' });
      setName('');
      void state.refetch();
    } catch (e) {
      toast.error('Not added', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const saveName = async (d: Centre) => {
    if (!renaming?.name.trim()) return;
    setBusy(true);
    try {
      await api.post('/api/cost-centres', { id: d.id, code: d.code, name: renaming.name.trim(), category: d.category, isActive: d.isActive });
      toast.success(`${renaming.name.trim()} saved`);
      setRenaming(null);
      void state.refetch();
    } catch (e) {
      toast.error('Not saved', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  const remove = (d: Centre) => del.ask({
    title: `Delete the division ${d.name}?`,
    description: 'Only a division nothing has been booked to can be deleted. One with entries is marked as inactive instead: it leaves the pickers, and its figures stay in the profit by division.',
    run: (reason) => api.delete(`/api/cost-centres?id=${d.id}${reasonQuery(reason, false)}`),
    done: `${d.name} deleted`, onDone: () => void state.refetch(),
    instead: d.isActive ? { label: 'Mark as inactive instead', run: () => api.post('/api/cost-centres', { id: d.id, code: d.code, name: d.name, category: d.category, isActive: false }) } : undefined,
  });

  return (
    <Card className="space-y-3 p-5" data-slot="divisions">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <Layers className="mt-0.5 size-4 text-primary" />
          <div>
            <h3 className="text-sm font-semibold">Divisions</h3>
            <p className="mt-0.5 max-w-xl text-xs text-muted-foreground">
              Separate layers of one company, such as Spares, Service and Exports, under the same GSTIN. Each
              invoice, bill and expense names its division, and each division has its own sales, expenses and profit.
            </p>
          </div>
        </div>
        <Button variant="outline" size="sm" asChild><Link href="/accountant/cost-centres">Profit by division</Link></Button>
      </div>
      {divisions.length === 0 ? <p className="text-xs text-muted-foreground">No divisions yet.</p> : (
        <ul className="divide-y rounded-md border text-sm">
          {divisions.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-2 px-3 py-1.5" data-slot="division">
              {renaming?.id === d.id ? (
                <>
                  <Input value={renaming.name} onChange={(e) => setRenaming({ ...renaming, name: e.target.value })} className="h-8 max-w-xs" autoFocus
                    onKeyDown={(e) => { if (e.key === 'Enter') void saveName(d); if (e.key === 'Escape') setRenaming(null); }} aria-label="Division name" />
                  <Button size="xs" onClick={() => void saveName(d)} disabled={busy || !renaming.name.trim()}>Save</Button>
                  <Button size="xs" variant="ghost" onClick={() => setRenaming(null)}>Cancel</Button>
                </>
              ) : (
                <>
                  <span className={d.isActive ? 'font-medium' : 'text-muted-foreground line-through'}>{d.name}</span>
                  <span className="font-mono text-[10px] text-muted-foreground">{d.code}</span>
                  {!d.isActive && <Badge variant="outline" className="text-[10px]">Inactive</Badge>}
                  <RowActions className="ml-auto" onEdit={canEdit && (() => setRenaming({ id: d.id, name: d.name }))} onDelete={canDelete && (() => remove(d))} />
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {canEdit && (
        <div className="flex max-w-md gap-2">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="New division, e.g. Service"
            onKeyDown={(e) => { if (e.key === 'Enter') void add(); }} aria-label="New division name" />
          <Button size="sm" className="h-9 gap-1.5" onClick={() => void add()} disabled={busy || !name.trim()}><Plus className="size-3.5" /> Add</Button>
        </div>
      )}
      {del.dialog}
    </Card>
  );
}
