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

export default function NewCustomerPage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [gstin, setGstin] = useState('');
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
  const [line1, setLine1] = useState('');
  const [city, setCity] = useState('');
  const [pincode, setPincode] = useState('');
  const [terms, setTerms] = useState('net_30');
  const [creditLimit, setCreditLimit] = useState(0);
  const [tdsSection, setTdsSection] = useState('');
  const create = useApiAction(contacts.create);

  const gstinValid = gstin.length === 15 ? isValidGstin(gstin.toUpperCase()) : null;

  const save = async () => {
    if (!name.trim()) {
      toast.error('Customer name is required');
      return;
    }
    if (gstin && gstinValid === false) {
      toast.error('That GSTIN fails the checksum — please re-check it');
      return;
    }

    // The address is stored as one block. Splitting it into line/city/pin was a
    // demo convenience; a GST invoice prints the address as written.
    const address = [line1, [city, pincode].filter(Boolean).join(' ')]
      .filter(Boolean)
      .join(', ');

    const result = await create.run({
      kind: 'customer',
      displayName: name.trim(),
      email: email || null,
      phone: phone || null,
      gstin: gstin ? gstin.toUpperCase() : null,
      // A GSTIN embeds the PAN at positions 3–12, so there is no reason to ask
      // for it twice.
      pan: gstin.length === 15 ? gstin.slice(2, 12).toUpperCase() : null,
      gstTreatment: treatment,
      stateCode,
      billingAddress: address || null,
      paymentTerms: terms,
      creditLimitPaise: creditLimit || 0,
      tdsSection: tdsSection || null,
    });
    if (!result) return;

    toast.success(`${result.displayName} added`);
    router.push('/sales/customers');
  };

  return (
    <>
      <PageHeader
        title="New customer"
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => router.back()}>Cancel</Button>
            <Button size="sm" onClick={save} disabled={create.busy}>
              {create.busy ? 'Saving…' : 'Save customer'}
            </Button>
          </>
        }
      />
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="space-y-6 p-5 lg:col-span-2">
          <FormSection title="Basic details">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Customer name" required className="sm:col-span-2">
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Customer's business name" />
              </Field>
              <Field label="Email">
                <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" />
              </Field>
              <Field label="Phone">
                <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+91 00000 00000" />
              </Field>
            </div>
          </FormSection>

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
                <div className="relative">
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

          <FormSection title="Billing address">
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Address" className="sm:col-span-3">
                <Input value={line1} onChange={(e) => setLine1(e.target.value)} placeholder="Building and street" />
              </Field>
              <Field label="City" className="sm:col-span-2">
                <Input value={city} onChange={(e) => setCity(e.target.value)} placeholder="City" />
              </Field>
              <Field label="PIN code">
                <Input value={pincode} onChange={(e) => setPincode(e.target.value)} placeholder="000000" />
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
            <Field
              label="TDS section they deduct under"
              hint="Large customers withhold tax and pay you net. It is tracked as TDS Receivable."
            >
              <Combobox
                options={TDS_SECTIONS.map((t) => ({
                  value: t.code,
                  label: `${t.code} — ${t.description}`,
                  sublabel: `${t.ratePctWithPan}% with PAN`,
                }))}
                value={tdsSection}
                onChange={setTdsSection}
                placeholder="They do not deduct TDS"
                searchPlaceholder="Search sections"
                showAvatar={false}
                clearable
              />
            </Field>
            {create.error && <p className="text-sm text-destructive">{create.error}</p>}
          </FormSection>
        </Card>
      </div>
    </>
  );
}
