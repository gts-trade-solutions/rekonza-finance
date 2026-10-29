'use client';

// Editing a customer or vendor: everything the books keep about a party.
//
// Each field here changes how money is handled somewhere: the state decides
// CGST+SGST against IGST, the PAN the TDS rate, the MSME category and written
// term the date a supplier must be paid by, the bank details where a payment
// file sends money. Every change is logged with its old and new value.

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Combobox } from '@/components/ui/combobox';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Field, MoneyInput } from '@/components/shared/form-bits';
import { api, contacts, type ContactRow } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { useAppStore } from '@/lib/store';
import { stateOptions } from '@/lib/options';
import { TDS_SECTIONS } from '@/lib/tax/tds';

type Editable = Omit<ContactRow, 'receivablePaise' | 'payablePaise' | 'invoiceCount' | 'billCount'>;

const TREATMENTS = [
  { value: 'registered', label: 'Registered (regular)' },
  { value: 'registered_composition', label: 'Composition scheme' },
  { value: 'unregistered', label: 'Unregistered business' },
  { value: 'consumer', label: 'Consumer' },
  { value: 'overseas', label: 'Overseas' },
  { value: 'sez', label: 'SEZ unit' },
  { value: 'sez_developer', label: 'SEZ developer' },
  { value: 'deemed_export', label: 'Deemed export' },
  { value: 'uin', label: 'UN body / embassy (UIN)' },
];

const TERMS = [
  { value: 'due_on_receipt', label: 'Due on receipt' }, { value: 'net_15', label: 'Net 15 days' },
  { value: 'net_30', label: 'Net 30 days' }, { value: 'net_45', label: 'Net 45 days' }, { value: 'net_60', label: 'Net 60 days' },
];

const s = (v: string | null | undefined) => v ?? '';

export function ContactEditDialog({ contact, onClose, onSaved }: {
  contact: Editable | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [f, setF] = useState<Editable | null>(contact);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(() => { setF(contact); setErrors({}); }, [contact]);
  const priceLists = useApi<{ lists: { id: string; name: string; isActive: boolean }[] }>(() => api.get('/api/price-lists'), []);
  // The book's people, for the account owner (exceptions about this customer go to them).
  const users = useAppStore((st) => st.users);

  if (!f) return <Dialog open={false} />;
  const isVendor = f.kind !== 'customer';
  const set = <K extends keyof Editable>(k: K, v: Editable[K]) => setF({ ...f, [k]: v });

  const save = async () => {
    setBusy(true);
    setErrors({});
    try {
      const n = (v: string | null) => (v && v.trim() ? v.trim() : null);
      await contacts.update({
        id: f.id,
        // Refused if someone else saved this contact after it was opened here.
        expectedUpdatedAt: f.updatedAt, displayName: f.displayName.trim(), legalName: n(f.legalName), gstin: n(f.gstin) ?? '', pan: n(f.pan) ?? '',
        gstTreatment: f.gstTreatment, stateCode: f.stateCode, email: n(f.email) ?? '', phone: n(f.phone),
        paymentTerms: f.paymentTerms, creditLimitPaise: f.creditLimitPaise, billWise: f.billWise !== false,
        ownerUserId: f.kind !== 'vendor' ? f.ownerUserId ?? null : undefined,
        isMsme: isVendor ? f.isMsme : false,
        msmeUdyamNo: isVendor && f.isMsme ? n(f.msmeUdyamNo) : null,
        msmeCategory: isVendor && f.isMsme ? f.msmeCategory : null,
        msmeActivity: isVendor && f.isMsme ? f.msmeActivity : null,
        msmeAgreementDays: isVendor && f.isMsme ? f.msmeAgreementDays : null,
        tdsSection: isVendor ? n(f.tdsSection) : undefined,
        billingAddress: n(f.billingAddress), shippingAddress: n(f.shippingAddress),
        bankAccountName: n(f.bankAccountName), bankAccountNo: n(f.bankAccountNo) ?? '', bankIfsc: n(f.bankIfsc) ?? '',
        bankName: n(f.bankName), notes: n(f.notes), currency: (f.currency || 'INR').toUpperCase(),
        ...(f.kind === 'vendor' ? {} : { priceListId: f.priceListId || null }),
      });
      toast.success(`${f.displayName} saved`);
      onSaved();
    } catch (e) {
      const details = (e as { details?: Record<string, string> }).details;
      if (details && typeof details === 'object') setErrors(details);
      toast.error('Not saved', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={!!contact} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit {f.displayName}</DialogTitle>
          <DialogDescription>Changes apply to documents raised from now on; posted ones keep what they were raised with.</DialogDescription>
        </DialogHeader>
        <div className="max-h-[65vh] space-y-5 overflow-y-auto pr-1 thin-scroll">
          <section className="grid gap-3 sm:grid-cols-2">
            <Field label="Display name" required error={errors.displayName}><Input value={f.displayName} onChange={(e) => set('displayName', e.target.value)} /></Field>
            <Field label="Legal name"><Input value={s(f.legalName)} onChange={(e) => set('legalName', e.target.value)} /></Field>
            <Field label="GST treatment">
              <Combobox options={TREATMENTS} value={f.gstTreatment} onChange={(v) => set('gstTreatment', v)} showAvatar={false} />
            </Field>
            <Field label="State" error={errors.stateCode}>
              <Combobox options={stateOptions()} value={f.stateCode} onChange={(v) => set('stateCode', v)} showAvatar={false} />
            </Field>
            <Field label="GSTIN" error={errors.gstin}><Input value={s(f.gstin)} onChange={(e) => set('gstin', e.target.value.toUpperCase())} className="font-mono" maxLength={15} /></Field>
            <Field label="PAN" error={errors.pan}><Input value={s(f.pan)} onChange={(e) => set('pan', e.target.value.toUpperCase())} className="font-mono" maxLength={10} /></Field>
            <Field label="Email" error={errors.email}><Input value={s(f.email)} onChange={(e) => set('email', e.target.value)} /></Field>
            <Field label="Phone"><Input value={s(f.phone)} onChange={(e) => set('phone', e.target.value)} /></Field>
            <Field label="Payment terms">
              <Select value={f.paymentTerms ?? ''} onValueChange={(v) => set('paymentTerms', v)}>
                <SelectTrigger><SelectValue placeholder="Payment terms" /></SelectTrigger>
                <SelectContent>{TERMS.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            {f.kind !== 'vendor' && (
              <Field label="Credit limit" hint="Invoices beyond it are flagged">
                <MoneyInput valuePaise={f.creditLimitPaise} onChangePaise={(p) => set('creditLimitPaise', p)} />
              </Field>
            )}
            {f.kind !== 'vendor' && (
              <Field label="Account owner" hint="Their overdue invoices and credit risks are raised to this person">
                <select className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={f.ownerUserId ?? ''}
                  onChange={(e) => set('ownerUserId', e.target.value || null)} aria-label="Account owner">
                  <option value="">Whoever handles receivables</option>
                  {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
              </Field>
            )}
            <label className="flex items-start gap-2 text-sm sm:col-span-2">
              <input type="checkbox" className="mt-1" checked={f.billWise !== false} onChange={(e) => set('billWise', e.target.checked)} />
              <span>Bill-wise<span className="block text-xs text-muted-foreground">Payments are matched to the invoices or bills they pay. Off, a payment settles the oldest first and the account is followed as a running balance.</span></span>
            </label>
            {isVendor && (
              <Field label="Default TDS section">
                <Combobox
                  options={TDS_SECTIONS.map((t) => ({ value: t.code, label: `${t.code} — ${t.description}` }))}
                  value={s(f.tdsSection)} onChange={(v) => set('tdsSection', v)} showAvatar={false} clearable placeholder="No TDS"
                />
              </Field>
            )}
          </section>

          {isVendor && (
            <section className="space-y-3 rounded-md border p-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-medium">Registered MSME</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Micro and small suppliers must be paid within the period agreed in writing — at most 45 days — or within
                    15 days without one. Medium enterprises and traders are not covered.
                  </p>
                </div>
                <Switch checked={f.isMsme} onCheckedChange={(v) => set('isMsme', v)} />
              </div>
              {f.isMsme && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Udyam registration no."><Input value={s(f.msmeUdyamNo)} onChange={(e) => set('msmeUdyamNo', e.target.value)} placeholder="UDYAM-XX-00-0000000" /></Field>
                  <Field label="Category" hint="As on the Udyam certificate">
                    <Select value={f.msmeCategory ?? ''} onValueChange={(v) => set('msmeCategory', (v || null) as Editable['msmeCategory'])}>
                      <SelectTrigger><SelectValue placeholder="Not known — treated as covered" /></SelectTrigger>
                      <SelectContent><SelectItem value="micro">Micro</SelectItem><SelectItem value="small">Small</SelectItem><SelectItem value="medium">Medium (not covered)</SelectItem></SelectContent>
                    </Select>
                  </Field>
                  <Field label="Activity">
                    <Select value={f.msmeActivity ?? ''} onValueChange={(v) => set('msmeActivity', (v || null) as Editable['msmeActivity'])}>
                      <SelectTrigger><SelectValue placeholder="Activity" /></SelectTrigger>
                      <SelectContent><SelectItem value="manufacturing">Manufacturing</SelectItem><SelectItem value="services">Services</SelectItem><SelectItem value="trading">Trading (not covered)</SelectItem></SelectContent>
                    </Select>
                  </Field>
                  <Field label="Credit period agreed in writing" hint="Days, at most 45. Leave empty if there is no written agreement — the limit is then 15 days." error={errors.msmeAgreementDays}>
                    <Input type="number" min={1} max={45} value={f.msmeAgreementDays ?? ''}
                      onChange={(e) => set('msmeAgreementDays', e.target.value ? Math.min(45, Math.max(1, Number(e.target.value))) : null)} />
                  </Field>
                </div>
              )}
            </section>
          )}

          <section className="grid gap-3 sm:grid-cols-2">
            <Field label="Billing address" className="sm:col-span-2"><Input value={s(f.billingAddress)} onChange={(e) => set('billingAddress', e.target.value)} /></Field>
            <Field label="Shipping address" className="sm:col-span-2"><Input value={s(f.shippingAddress)} onChange={(e) => set('shippingAddress', e.target.value)} /></Field>
          </section>

          <section className="space-y-2">
            <p className="text-sm font-medium">Bank account</p>
            <p className="text-xs text-muted-foreground">Where payments to them go, for NEFT, RTGS and the bank&apos;s bulk-payment file.</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Account holder"><Input value={s(f.bankAccountName)} onChange={(e) => set('bankAccountName', e.target.value)} /></Field>
              <Field label="Account number" error={errors.bankAccountNo}><Input value={s(f.bankAccountNo)} onChange={(e) => set('bankAccountNo', e.target.value.replace(/\s/g, ''))} className="font-mono" /></Field>
              <Field label="IFSC" error={errors.bankIfsc}><Input value={s(f.bankIfsc)} onChange={(e) => set('bankIfsc', e.target.value.toUpperCase())} className="font-mono" maxLength={11} /></Field>
              <Field label="Bank"><Input value={s(f.bankName)} onChange={(e) => set('bankName', e.target.value)} /></Field>
            </div>
          </section>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Currency" hint="Invoices and bills for an overseas party can be in their currency">
              <Input value={f.currency ?? 'INR'} onChange={(e) => set('currency', e.target.value.toUpperCase().slice(0, 3))} className="font-mono" maxLength={3} />
            </Field>
            {f.kind !== 'vendor' && (
              <Field label="Price list" hint="What they are charged when it is not the item's own price">
                <div><Select value={f.priceListId ?? 'none'} onValueChange={(v) => set('priceListId', v === 'none' ? null : String(v))}>
                  <SelectTrigger><SelectValue placeholder="Item prices" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Item prices</SelectItem>
                    {(priceLists.data?.lists ?? []).filter((l) => l.isActive).map((l) => <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>)}
                  </SelectContent>
                </Select></div>
              </Field>
            )}
          </div>

          <Field label="Notes"><Input value={s(f.notes)} onChange={(e) => set('notes', e.target.value)} /></Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void save()} disabled={busy || !f.displayName.trim()}>{busy && <Loader2 className="size-4 animate-spin" />} Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
