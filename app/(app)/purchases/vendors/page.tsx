'use client';

// The vendor list.
//
// Two flags here change how money is handled rather than how a row looks. MSME
// status starts the 45-day clock under section 43B(h) — pay later than that and
// the expense is disallowed for income tax. A composition vendor charges no GST
// you can reclaim, so nothing they bill carries input credit.

import { useState } from 'react';
import { Building2, Plus, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import { PageHeader } from '@/components/shared/page-header';
import { DataTable, type Column } from '@/components/shared/data-table';
import { Money } from '@/components/shared/money';
import { EmptyState } from '@/components/shared/empty-state';
import { AsyncPage } from '@/components/shared/async-state';
import { Field } from '@/components/shared/form-bits';
import { Combobox } from '@/components/ui/combobox';
import { contacts, type ContactRow } from '@/lib/api/client';
import { ContactEditDialog } from '@/components/forms/contact-edit-dialog';
import { useApi, useApiAction } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';
import { useAppStore } from '@/lib/store';
import { stateName } from '@/lib/tax/gst';
import { TDS_SECTIONS } from '@/lib/tax/tds';
import { stateOptions } from '@/lib/options';

const columns: Column<ContactRow>[] = [
  {
    key: 'name',
    header: 'Vendor',
    sortValue: (r) => r.displayName,
    cell: (r) => (
      <div className="flex items-center gap-2">
        <div>
          <p className="font-medium">{r.displayName}</p>
          <p className="text-xs text-muted-foreground">{r.pan ? `PAN ${r.pan}` : 'No PAN — TDS at 20%'}</p>
        </div>
        {r.isMsme && (
          <Badge variant="outline" className="border-amber-500/40 text-[10px] text-amber-700 dark:text-amber-300">
            MSME
          </Badge>
        )}
      </div>
    ),
  },
  {
    key: 'gstin',
    header: 'GSTIN',
    sortValue: (r) => r.gstin ?? '',
    cell: (r) =>
      r.gstin ? (
        <span className="font-mono text-xs">{r.gstin}</span>
      ) : (
        <Badge variant="secondary" className="text-[10px] capitalize">{r.gstTreatment.replace(/_/g, ' ')}</Badge>
      ),
  },
  { key: 'state', header: 'State', sortValue: (r) => stateName(r.stateCode), cell: (r) => stateName(r.stateCode) },
  {
    key: 'itc',
    header: 'ITC',
    sortValue: (r) => r.gstTreatment,
    cell: (r) =>
      r.gstTreatment === 'registered_composition' || r.gstTreatment === 'unregistered' ? (
        <Badge variant="outline" className="gap-1 border-red-500/40 text-[10px] text-red-600 dark:text-red-400">
          <ShieldAlert className="size-2.5" /> No credit
        </Badge>
      ) : (
        <span className="text-xs text-emerald-600 dark:text-emerald-400">Claimable</span>
      ),
  },
  {
    key: 'tds',
    header: 'TDS section',
    sortValue: (r) => r.tdsSection ?? '',
    cell: (r) =>
      r.tdsSection ? (
        <Badge variant="secondary" className="text-[10px]">{r.tdsSection}</Badge>
      ) : (
        <span className="text-xs text-muted-foreground">—</span>
      ),
  },
  {
    key: 'outstanding',
    header: 'Payable',
    align: 'right',
    sortValue: (r) => r.payablePaise,
    cell: (r) => (
      <Money value={r.payablePaise} className={r.payablePaise > 0 ? 'font-medium' : 'text-muted-foreground'} />
    ),
  },
];

/**
 * A blank vendor. The state is filled in from the organisation's own
 * registration when the dialog opens rather than being fixed here — it decides
 * CGST+SGST versus IGST on the bill, and a hard-coded one would have every
 * business outside that state reclaiming the wrong half of its input credit.
 */
const BLANK = {
  name: '', gstin: '', pan: '', stateCode: '', treatment: 'registered',
  tdsSection: '', isMsme: false, udyam: '', terms: 'net_30',
  msmeCategory: '', msmeActivity: '', agreementDays: '',
};

export default function VendorsPage() {
  const canCreate = usePermission('purchases', 'create');
  const state = useApi<{ contacts: ContactRow[] }>(() => contacts.list({ kind: 'vendor' }), []);
  const [open, setOpen] = useState(false);
  const [f, setF] = useState(BLANK);
  const [editing, setEditing] = useState<ContactRow | null>(null);
  const canEdit = usePermission('purchases', 'edit');

  // The organisation's own registration, used as the default state for a new
  // vendor. Selected as a primitive: an object out of a Zustand selector builds
  // a fresh snapshot each render and loops useSyncExternalStore.
  const homeState = useAppStore(
    (st) => st.branches.find((b) => b.id === st.activeBranchId)?.stateCode ?? '',
  );
  const create = useApiAction(contacts.create);

  const save = async () => {
    if (!f.name.trim()) { toast.error('Vendor name is required'); return; }
    const result = await create.run({
      kind: 'vendor',
      displayName: f.name.trim(),
      gstin: f.gstin || null,
      pan: f.pan || null,
      gstTreatment: f.treatment,
      stateCode: f.stateCode,
      paymentTerms: f.terms,
      isMsme: f.isMsme,
      msmeUdyamNo: f.isMsme ? f.udyam || null : null,
      msmeCategory: f.isMsme && f.msmeCategory ? f.msmeCategory : null,
      msmeActivity: f.isMsme && f.msmeActivity ? f.msmeActivity : null,
      msmeAgreementDays: f.isMsme && f.agreementDays ? Number(f.agreementDays) : null,
      tdsSection: f.tdsSection || null,
    });
    if (!result) return;
    toast.success(`${result.displayName} added`);
    setOpen(false);
    setF(BLANK);
    state.refetch();
  };

  return (
    <>
      <PageHeader
        title="Vendors"
        description="MSME status sets the date each supplier must be paid by; composition vendors can't pass on input credit. Click a vendor to edit."
        actions={
          canCreate && (
            <Dialog
              open={open}
              onOpenChange={(v) => {
                // Opening a fresh dialog starts from the home state; closing
                // clears the form so a half-filled vendor is not still there
                // the next time it opens.
                setF(v ? { ...BLANK, stateCode: homeState } : BLANK);
                setOpen(v);
              }}
            >
              <DialogTrigger asChild>
                <Button size="sm" className="gap-1.5"><Plus className="size-4" /> New vendor</Button>
              </DialogTrigger>
              <DialogContent className="max-w-lg">
                <DialogHeader><DialogTitle>New vendor</DialogTitle></DialogHeader>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Vendor name" required error={create.fieldErrors.displayName} className="sm:col-span-2">
                    <Input
                      value={f.name}
                      onChange={(e) => setF({ ...f, name: e.target.value })}
                      placeholder="Vendor's business name"
                    />
                  </Field>
                  <Field label="GSTIN" error={create.fieldErrors.gstin}>
                    <Input
                      value={f.gstin}
                      onChange={(e) => setF({ ...f, gstin: e.target.value.toUpperCase() })}
                      className="font-mono"
                      maxLength={15}
                    />
                  </Field>
                  <Field label="PAN" hint="Without PAN, TDS is deducted at 20%" error={create.fieldErrors.pan}>
                    <Input
                      value={f.pan}
                      onChange={(e) => setF({ ...f, pan: e.target.value.toUpperCase() })}
                      className="font-mono"
                      maxLength={10}
                    />
                  </Field>
                  <Field label="GST treatment">
                    <Combobox
                      options={[
                        { value: 'registered', label: 'Registered (regular)' },
                        { value: 'registered_composition', label: 'Composition scheme' },
                        { value: 'unregistered', label: 'Unregistered' },
                        { value: 'overseas', label: 'Overseas / import' },
                      ]}
                      value={f.treatment}
                      onChange={(v) => setF({ ...f, treatment: v })}
                      showAvatar={false}
                      searchPlaceholder="Search treatments"
                    />
                  </Field>
                  <Field label="State" error={create.fieldErrors.stateCode}>
                    <Combobox
                      options={stateOptions()}
                      value={f.stateCode}
                      onChange={(v) => setF({ ...f, stateCode: v })}
                      placeholder="Select state"
                      searchPlaceholder="Search all 37 states"
                      showAvatar={false}
                    />
                  </Field>
                  <Field
                    label="Default TDS section"
                    hint="Applied automatically once thresholds are crossed"
                    className="sm:col-span-2"
                  >
                    <Combobox
                      options={TDS_SECTIONS.map((t) => ({
                        value: t.code,
                        label: `${t.code} — ${t.description}`,
                        sublabel: `${t.ratePctWithPan}% with PAN`,
                      }))}
                      value={f.tdsSection}
                      onChange={(v) => setF({ ...f, tdsSection: v })}
                      placeholder="No TDS"
                      searchPlaceholder="Search sections"
                      showAvatar={false}
                      clearable
                    />
                  </Field>
                  <div className="flex items-start justify-between gap-3 rounded-md border p-3 sm:col-span-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">Registered MSME</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        Micro and small suppliers must be paid within the period agreed in writing (at most 45 days), or 15 days
                        without one; past that, the expense is disallowed for income tax until paid.
                      </p>
                    </div>
                    <Switch checked={f.isMsme} onCheckedChange={(v) => setF({ ...f, isMsme: v })} />
                  </div>
                  {f.isMsme && (
                    <>
                      <Field label="Udyam registration no." className="sm:col-span-2">
                        <Input
                          value={f.udyam}
                          onChange={(e) => setF({ ...f, udyam: e.target.value })}
                          placeholder="UDYAM-XX-00-0000000"
                        />
                      </Field>
                      <Field label="Category">
                        <Combobox
                          options={[{ value: 'micro', label: 'Micro' }, { value: 'small', label: 'Small' }, { value: 'medium', label: 'Medium (not covered)' }]}
                          value={f.msmeCategory} onChange={(v) => setF({ ...f, msmeCategory: v })} showAvatar={false} placeholder="As on the certificate"
                        />
                      </Field>
                      <Field label="Activity">
                        <Combobox
                          options={[{ value: 'manufacturing', label: 'Manufacturing' }, { value: 'services', label: 'Services' }, { value: 'trading', label: 'Trading (not covered)' }]}
                          value={f.msmeActivity} onChange={(v) => setF({ ...f, msmeActivity: v })} showAvatar={false}
                        />
                      </Field>
                      <Field label="Credit period agreed in writing" hint="Days, up to 45. Empty means no written agreement: 15 days." className="sm:col-span-2">
                        <Input type="number" min={1} max={45} value={f.agreementDays} onChange={(e) => setF({ ...f, agreementDays: e.target.value })} />
                      </Field>
                    </>
                  )}
                  {create.error && <p className="text-sm text-destructive sm:col-span-2">{create.error}</p>}
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
                  <Button onClick={save} disabled={create.busy}>
                    {create.busy ? 'Saving…' : 'Save vendor'}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          )
        }
      />
      <AsyncPage state={state}>
        {(d) =>
          d.contacts.length === 0 ? (
            <EmptyState icon={Building2} title="No vendors" description="Add suppliers to start recording bills." />
          ) : (
            <DataTable
              rows={d.contacts}
              columns={columns}
              getRowId={(r) => r.id}
              searchPlaceholder="Search vendor, GSTIN or PAN…"
              onRowClick={canEdit ? (r) => setEditing(r) : undefined}
            />
          )
        }
      </AsyncPage>
      <ContactEditDialog contact={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void state.refetch(); }} />
    </>
  );
}
