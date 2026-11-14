'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Check, X } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/shared/page-header';
import { Field, FormSection, MoneyInput } from '@/components/shared/form-bits';
import { contacts } from '@/lib/api/client';
import { useApiAction } from '@/lib/api/use-api';
import { isValidGstin } from '@/lib/tax/gst';
import { Combobox } from '@/components/ui/combobox';
import { stateOptions } from '@/lib/options';
import { TDS_SECTIONS } from '@/lib/tax/tds';
import { useAppStore } from '@/lib/store';
import { CinLookupButton, GstinLookupButton, GstinNumberOnlyNote, gstinTreatment, type GstinDetails } from '@/components/gst/gstn-portal';
import { MultiCombobox } from '@/components/ui/multi-combobox';
import { SupplyKindPicker } from '@/components/forms/supply-kind-picker';
import { countryCurrency, countryOptions, currencyOptions } from '@/lib/countries';
import type { SupplyKind } from '@/lib/types';
import { KindOfBusinessSelect } from '@/components/shared/kind-of-business';
import { companyTypeFrom } from '@/lib/company-profile';

export default function NewCustomerPage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [gstin, setGstin] = useState('');
  // The last GSTIN lookup's answer: says under the box when only the number could be read.
  const [lookup, setLookup] = useState<GstinDetails | null>(null);
  const [treatment, setTreatment] = useState('registered');
  // Defaults to the state this business is registered in, not a fixed one.
  // Most customers are local, and a wrong default here is not cosmetic: state
  // decides CGST+SGST versus IGST, so a Karnataka seller left on Tamil Nadu
  // would charge integrated tax on its own doorstep sales.
  const homeState = useAppStore(
    (st) => st.branches.find((b) => b.id === st.activeBranchId)?.stateCode ?? '',
  );
  const [stateCode, setStateCode] = useState(homeState);

  // The branch list arrives from /api/masters a moment after the form mounts,
  // so the default is applied once it does — but never over a choice the user
  // has already made.
  const [stateTouched, setStateTouched] = useState(false);
  useEffect(() => {
    if (!stateTouched && homeState && !stateCode) setStateCode(homeState);
  }, [homeState, stateCode, stateTouched]);
  const [legalName, setLegalName] = useState('');
  const [line1, setLine1] = useState('');
  const [city, setCity] = useState('');
  const [pincode, setPincode] = useState('');
  const [terms, setTerms] = useState('net_30');
  const [creditLimit, setCreditLimit] = useState(0);
  const [tdsSections, setTdsSections] = useState<string[]>([]);
  // The registration, filled from the GSTIN and the CIN, or typed.
  const [pan, setPan] = useState('');
  const [constitution, setConstitution] = useState('');
  const [gstStatus, setGstStatus] = useState('');
  const [gstRegisteredOn, setGstRegisteredOn] = useState('');
  const [cin, setCin] = useState('');
  const [incorporatedOn, setIncorporatedOn] = useState('');
  // An international customer: outside India, no GSTIN, place of supply 96
  // (Foreign Country), invoiced in its own currency; its sales are exports.
  const [international, setInternational] = useState(false);
  const [country, setCountry] = useState('');
  const [currency, setCurrency] = useState('INR');
  // What they buy: their estimates, orders and invoices offer only those items.
  const [supplies, setSupplies] = useState<SupplyKind>('both');
  const create = useApiAction(contacts.create);

  const gstinValid = gstin.length === 15 ? isValidGstin(gstin.toUpperCase()) : null;

  const save = async () => {
    if (!name.trim()) {
      toast.error('Customer name is required');
      return;
    }
    if (!international && gstin && gstinValid === false) {
      toast.error('That GSTIN fails the checksum — please re-check it');
      return;
    }
    if (international && !country) {
      toast.error('Pick the country the customer is in');
      return;
    }

    // The address is stored as one block. Splitting it into line/city/pin was a
    // demo convenience; a GST invoice prints the address as written.
    const address = [line1, [city, pincode].filter(Boolean).join(' ')]
      .filter(Boolean)
      .join(', ');

    const domestic = !international;
    const result = await create.run({
      kind: 'customer',
      displayName: name.trim(),
      legalName: legalName || null,
      email: email || null,
      phone: phone || null,
      gstin: domestic && gstin ? gstin.toUpperCase() : null,
      // A GSTIN embeds the PAN at positions 3–12; it is filled from it, and can be typed without one.
      pan: domestic ? pan || (gstin.length === 15 ? gstin.slice(2, 12).toUpperCase() : null) : null,
      constitution: constitution || null,
      gstStatus: domestic ? gstStatus || null : null,
      gstRegisteredOn: domestic ? gstRegisteredOn || null : null,
      cin: domestic ? cin || null : null,
      incorporatedOn: domestic ? incorporatedOn || null : null,
      gstTreatment: domestic ? treatment : 'overseas',
      stateCode: domestic ? stateCode : '96',
      country: domestic ? null : country,
      currency: domestic ? 'INR' : currency,
      supplies,
      billingAddress: address || null,
      paymentTerms: terms,
      creditLimitPaise: creditLimit || 0,
      tdsSections: domestic ? tdsSections : [],
    });
    if (!result) return;

    toast.success(`${result.displayName} added`);
    router.push('/sales/customers');
  };

  return (
    <>
      <PageHeader title="New customer" />
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="space-y-6 p-5 lg:col-span-2">
          <FormSection title="Basic details">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Customer type" className="sm:col-span-2" hint={international ? 'Outside India: no GSTIN, and every sale is an export.' : 'In India, registered for GST or not.'}>
                <div className="inline-flex rounded-md border p-0.5" role="radiogroup" aria-label="Customer type" data-slot="customer-type">
                  {[{ v: false, label: 'Domestic' }, { v: true, label: 'International' }].map((o) => (
                    <button key={o.label} type="button" role="radio" aria-checked={international === o.v}
                      onClick={() => setInternational(o.v)}
                      className={`rounded px-4 py-1.5 text-sm font-medium transition-colors ${international === o.v ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}>
                      {o.label}
                    </button>
                  ))}
                </div>
              </Field>
              <Field label="Customer name" required className="sm:col-span-2">
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Customer's business name" />
              </Field>
              <Field label="Email">
                <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" />
              </Field>
              <Field label="Phone">
                <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder={international ? '+1 000 000 0000' : '+91 00000 00000'} />
              </Field>
              <Field label="They buy" className="sm:col-span-2" hint="Their estimates, orders and invoices offer only these items.">
                <div data-slot="customer-supplies"><SupplyKindPicker value={supplies} onChange={setSupplies} /></div>
              </Field>
            </div>
          </FormSection>

          {international ? (
            <FormSection title="Country and currency" description="Sales to them are exports: zero-rated under your LUT, or with IGST that is refunded.">
              <div className="grid gap-4 sm:grid-cols-2" data-slot="international-details">
                <Field label="Country" required>
                  <Combobox options={countryOptions()} value={country}
                    onChange={(v) => { setCountry(v); setCurrency(countryCurrency(v)); }}
                    placeholder="Select the country" searchPlaceholder="Search countries" showAvatar={false} />
                </Field>
                <Field label="Currency" hint="What they are invoiced in; the rupee value is kept at the day's rate">
                  <Combobox options={currencyOptions()} value={currency} onChange={setCurrency} searchPlaceholder="Search currencies" showAvatar={false} />
                </Field>
                <p className="text-xs text-muted-foreground sm:col-span-2">
                  Place of supply: 96, Foreign Country. GST treatment: overseas (export).
                </p>
              </div>
            </FormSection>
          ) : (<>
          <FormSection title="Tax details" description="These drive how GST is calculated on every invoice.">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="GST treatment" required>
                <Combobox
                  options={[
                    { value: 'registered', label: 'Registered business (regular)' },
                    { value: 'registered_composition', label: 'Registered — composition' },
                    { value: 'unregistered', label: 'Unregistered / B2C' },
                    { value: 'overseas', label: 'Overseas — export' },
                    { value: 'sez', label: 'SEZ unit' },
                  ]}
                  value={treatment}
                  onChange={setTreatment}
                  showAvatar={false}
                  searchPlaceholder="Search treatments"
                />
              </Field>
              <Field
                label="GSTIN"
                hint={
                  gstinValid === true ? undefined :
                  gstinValid === false ? undefined :
                  'Checksum is verified as you type'
                }
                error={gstinValid === false ? 'Invalid GSTIN — checksum does not match' : undefined}
              >
                <div className="flex gap-2">
                <div className="relative flex-1">
                  <Input
                    value={gstin}
                    onChange={(e) => setGstin(e.target.value.toUpperCase())}
                    placeholder="22AAAAA0000A1Z5"
                    maxLength={15}
                    className="pr-9 font-mono"
                  />
                  {gstinValid !== null && (
                    <span className="absolute right-2.5 top-1/2 -translate-y-1/2">
                      {gstinValid ? (
                        <Check className="size-4 text-emerald-600" />
                      ) : (
                        <X className="size-4 text-destructive" />
                      )}
                    </span>
                  )}
                </div>
                <GstinLookupButton gstin={gstin} onFound={(d) => {
                  // Zoho's prefill: the registered name and address, the state and the kind of registration.
                  setLookup(d);
                  if (!name.trim()) setName(d.tradeName || d.legalName || '');
                  if (d.legalName) setLegalName(d.legalName);
                  setPan(d.pan);
                  if (d.constitution) setConstitution(companyTypeFrom(d.constitution) ?? d.constitution);
                  if (d.status) setGstStatus(d.status);
                  if (d.registeredOn) setGstRegisteredOn(d.registeredOn);
                  if (d.fromPortal || treatment === 'unregistered' || treatment === 'consumer') setTreatment(gstinTreatment(d));
                  if (d.address) {
                    setStateCode(d.address.stateCode); setStateTouched(true);
                    if (d.address.line) setLine1(d.address.line);
                    if (d.address.city) setCity(d.address.city);
                    if (d.address.pincode) setPincode(d.address.pincode);
                  }
                }} />
                </div>
                <GstinNumberOnlyNote details={lookup} gstin={gstin} />
                {legalName && <p className="mt-1 text-xs text-muted-foreground">Registered as {legalName}</p>}
              </Field>
              <Field label="State" required hint="Decides intra-state vs inter-state tax" className="sm:col-span-2">
                <Combobox
                  options={stateOptions()}
                  value={stateCode}
                  onChange={(v) => { setStateCode(v); setStateTouched(true); }}
                  placeholder="Select state"
                  searchPlaceholder="Search all 37 states"
                  showAvatar={false}
                />
              </Field>
            </div>
          </FormSection>

          <FormSection title="Registration" description="Filled from the GSTIN and the CIN as you type them; check or type them yourself.">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="PAN">
                <Input value={pan} onChange={(e) => setPan(e.target.value.toUpperCase())} maxLength={10} className="font-mono" placeholder="AAAAA0000A" />
              </Field>
              <Field label="Kind of business">
                <KindOfBusinessSelect value={constitution} onChange={setConstitution} />
              </Field>
              <Field label="GST registered on" hint={gstStatus ? `Registration is ${gstStatus}` : undefined}>
                <Input type="date" value={gstRegisteredOn} onChange={(e) => setGstRegisteredOn(e.target.value)} />
              </Field>
              <Field label="CIN (companies and LLPs)">
                <div className="flex gap-2">
                  <Input value={cin} onChange={(e) => setCin(e.target.value.toUpperCase())} maxLength={21} className="font-mono" placeholder="U74999TN2015PTC123456" />
                  <CinLookupButton cin={cin} onFound={(d) => {
                    if (d.incorporatedOn) setIncorporatedOn(d.incorporatedOn);
                    if (!constitution && d.kind) setConstitution(companyTypeFrom(d.kind) ?? d.kind);
                  }} />
                </div>
              </Field>
              <Field label="Incorporated on">
                <Input type="date" value={incorporatedOn} onChange={(e) => setIncorporatedOn(e.target.value)} />
              </Field>
            </div>
          </FormSection>
          </>)}

          <FormSection title="Billing address">
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Address" className="sm:col-span-3">
                <Input value={line1} onChange={(e) => setLine1(e.target.value)} placeholder="Building and street" />
              </Field>
              <Field label="City" className="sm:col-span-2">
                <Input value={city} onChange={(e) => setCity(e.target.value)} placeholder="City" />
              </Field>
              <Field label={international ? 'Postal / ZIP code' : 'PIN code'}>
                <Input value={pincode} onChange={(e) => setPincode(e.target.value)} placeholder={international ? '' : '000000'} />
              </Field>
            </div>
          </FormSection>
        </Card>

        <Card className="space-y-6 p-5">
          <FormSection title="Terms & credit">
            <Field label="Payment terms" hint="Used to calculate invoice due dates">
              <Combobox
                options={[
                  { value: 'due_on_receipt', label: 'Due on receipt' },
                  { value: 'net_15', label: 'Net 15 days' },
                  { value: 'net_30', label: 'Net 30 days' },
                  { value: 'net_45', label: 'Net 45 days' },
                  { value: 'net_60', label: 'Net 60 days' },
                ]}
                value={terms}
                onChange={setTerms}
                showAvatar={false}
              />
            </Field>
            <Field label="Credit limit" hint="Warns when outstanding exceeds this">
              <MoneyInput valuePaise={creditLimit} onChangePaise={setCreditLimit} />
            </Field>
            {!international && <Field
              label="TDS sections they deduct under"
              hint="Large customers withhold tax and pay you net. It is tracked as TDS Receivable. Choose every section they use."
            >
              <MultiCombobox
                options={TDS_SECTIONS.map((t) => ({
                  value: t.code,
                  label: `${t.code} — ${t.description}`,
                  sublabel: `${t.ratePctWithPan}% with PAN`,
                }))}
                value={tdsSections}
                onChange={setTdsSections}
                placeholder="They do not deduct TDS"
                searchPlaceholder="Search sections"
              />
            </Field>}
            {create.error && <p className="text-sm text-destructive">{create.error}</p>}
          </FormSection>
        </Card>
      </div>

      {/* Save at the foot of the form, where the eye ends up, as on every document form. */}
      <div className="footer-bar sticky bottom-0 z-20 mt-6 flex flex-wrap items-center gap-2 rounded-lg border bg-surface px-5 py-3.5" data-slot="customer-save-bar">
        <Button onClick={save} disabled={create.busy}>{create.busy ? 'Saving…' : 'Save customer'}</Button>
        <Button variant="outline" onClick={() => router.back()}>Cancel</Button>
      </div>
    </>
  );
}
