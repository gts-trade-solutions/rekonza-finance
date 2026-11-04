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
import { CinLookupButton, GstinLookupButton } from '@/components/gst/gstn-portal';
import { BUSINESS_NATURES, COMPANY_TYPES, companyTypeFrom } from '@/lib/company-profile';
import { api } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';

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
              <GstinLookupButton gstin={gstin} auto={false} onFound={(d) => set({
                legalName: d.legalName ?? value.legalName,
                pan: d.pan ?? value.pan,
                constitution: companyTypeFrom(d.constitution) ?? value.constitution,
                gstRegisteredOn: d.registeredOn ?? value.gstRegisteredOn,
                address: d.address?.line ? [d.address.line, d.address.city, d.address.pincode].filter(Boolean).join(', ') : value.address,
              })} />
            )}
          </div>
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
  const canEdit = settingsEdit && mayAddCentres;
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
      <div className="flex flex-wrap gap-1.5">
        {divisions.length === 0 && <p className="text-xs text-muted-foreground">No divisions yet.</p>}
        {divisions.map((d) => (
          <Badge key={d.id} variant={d.isActive ? 'secondary' : 'outline'} className="gap-1 text-xs" data-slot="division">
            {d.name}<span className="font-mono text-[10px] text-muted-foreground">{d.code}</span>
          </Badge>
        ))}
      </div>
      {canEdit && (
        <div className="flex max-w-md gap-2">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="New division, e.g. Service"
            onKeyDown={(e) => { if (e.key === 'Enter') void add(); }} aria-label="New division name" />
          <Button size="sm" className="h-9 gap-1.5" onClick={() => void add()} disabled={busy || !name.trim()}><Plus className="size-3.5" /> Add</Button>
        </div>
      )}
    </Card>
  );
}
