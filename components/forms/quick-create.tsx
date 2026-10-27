'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Creating a customer, a vendor or an item without leaving the document.
//
// Until now the "+ New …" footer on a picker navigated to the full master form,
// which threw away whatever had already been typed into the invoice. In
// practice that means people either abandon the document, or invent a line with
// a free-typed description and no item behind it — and a line with no item is a
// line with no HSN, which is the single most common reason a GSTR-1 bounces at
// the portal.
//
// So the record is created here, in a dialog, against the same API and the same
// validation the full form uses. Two consequences worth stating:
//
//   * These are the minimum fields the DOCUMENT needs, not everything the
//     master holds. A customer created here has a name, a GST treatment and a
//     state, because those three decide the tax on the invoice. Addresses,
//     credit limits and portal access are edited later on the master screen.
//     The dialog says so rather than pretending it captured everything.
//
//   * The new record goes straight into the store as well as the database, so
//     every other picker on the page can see it immediately. Re-fetching all
//     the masters would work too, but it would also rebuild the option lists
//     under a form the user is in the middle of filling in.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, BadgeCheck, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Combobox } from '@/components/ui/combobox';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Field, MoneyInput } from '@/components/shared/form-bits';
import { contacts as contactsApi, items as itemsApi } from '@/lib/api/client';
import { useApiAction } from '@/lib/api/use-api';
import { useAppStore } from '@/lib/store';
import { stateOptions } from '@/lib/options';
import { GST_RATES, isValidGstin, stateName } from '@/lib/tax/gst';
import { TDS_SECTIONS } from '@/lib/tax/tds';
import type { Contact, GstTreatment, Item, TaxPref } from '@/lib/types';
import { cn } from '@/lib/utils';

const TREATMENTS = [
  { value: 'registered', label: 'Registered business (regular)' },
  { value: 'registered_composition', label: 'Registered — composition' },
  { value: 'unregistered', label: 'Unregistered / B2C' },
  { value: 'overseas', label: 'Overseas — export' },
  { value: 'sez', label: 'SEZ unit' },
];

/** Treatments where a GSTIN is expected; the others have none to give. */
const NEEDS_GSTIN = new Set(['registered', 'registered_composition', 'sez']);

const UQC_OPTIONS = [
  ['NOS', 'Numbers'], ['PCS', 'Pieces'], ['KGS', 'Kilograms'], ['LTR', 'Litres'],
  ['MTR', 'Metres'], ['BOX', 'Box'], ['SET', 'Set'], ['PAC', 'Pack'],
  ['BAG', 'Bag'], ['TON', 'Tonnes'], ['SQM', 'Square metres'], ['HRS', 'Hours'],
  ['DAY', 'Days'], ['OTH', 'Others'],
].map(([value, label]) => ({ value, label, sublabel: value }));

/** Which of an item's two prices the calling document actually cares about. */
export type PriceMode = 'sale' | 'purchase';

// ═════════════════════════════════════════════════════════════════════════════
// Contacts
// ═════════════════════════════════════════════════════════════════════════════

export function QuickContactDialog({
  kind,
  open,
  onOpenChange,
  initialName = '',
  onCreated,
}: {
  kind: 'customer' | 'vendor';
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** What the user had typed into the picker before giving up on finding it. */
  initialName?: string;
  onCreated: (id: string) => void;
}) {
  const noun = kind === 'customer' ? 'customer' : 'vendor';

  // The organisation's own registration. Most trading partners are in the same
  // state, and state is what decides CGST+SGST versus IGST — so it is the right
  // default, and a wrong one is not cosmetic.
  const homeState = useAppStore(
    (s) => s.branches.find((b) => b.id === s.activeBranchId)?.stateCode ?? '',
  );

  const [name, setName] = useState(initialName);
  const [treatment, setTreatment] = useState<string>('registered');
  const [gstin, setGstin] = useState('');
  const [stateCode, setStateCode] = useState(homeState);
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [terms, setTerms] = useState('net_30');
  const [isMsme, setIsMsme] = useState(false);
  const [udyam, setUdyam] = useState('');
  const [tdsSection, setTdsSection] = useState('');

  const create = useApiAction(contactsApi.create);

  // Reset each time the dialog opens, so the previous attempt is not still
  // sitting there — and seed the name from what was typed into the picker.
  useEffect(() => {
    if (!open) return;
    setName(initialName);
    setTreatment('registered');
    setGstin('');
    setStateCode(homeState);
    setEmail('');
    setPhone('');
    setTerms('net_30');
    setIsMsme(false);
    setUdyam('');
    setTdsSection('');
  }, [open, initialName, homeState]);

  const needsGstin = NEEDS_GSTIN.has(treatment);
  const gstinValid = gstin.length === 15 ? isValidGstin(gstin.toUpperCase()) : null;

  // The first two characters of a GSTIN are the state code, so entering one
  // settles the state question rather than leaving two fields to disagree.
  const setGstinAndState = (raw: string) => {
    const v = raw.toUpperCase().slice(0, 15);
    setGstin(v);
    if (v.length >= 2 && stateOptions().some((o) => o.value === v.slice(0, 2))) {
      setStateCode(v.slice(0, 2));
    }
  };

  // A registered party must carry a GSTIN — the server enforces it, and
  // discovering that after filling the form in is a worse way to learn it than
  // a required marker on the field. Someone with no GSTIN is unregistered, and
  // that is a different treatment, not a missing field.
  const canSave =
    name.trim().length > 0 &&
    stateCode.length === 2 &&
    (!needsGstin || gstinValid === true);

  const save = async () => {
    const created = await create.run({
      kind,
      displayName: name.trim(),
      gstTreatment: treatment,
      gstin: needsGstin ? gstin.toUpperCase() || null : null,
      stateCode,
      email: email.trim() || null,
      phone: phone.trim() || null,
      paymentTerms: terms || null,
      isMsme: kind === 'vendor' ? isMsme : false,
      msmeUdyamNo: kind === 'vendor' && isMsme ? udyam.trim() || null : null,
      tdsSection: kind === 'vendor' ? tdsSection || null : null,
    });
    if (!created) {
      toast.error(create.error ?? `Could not create that ${noun}`);
      return;
    }

    // Into the store as well as the database: the picker that opened this
    // dialog reads its options from there, and re-loading every master would
    // rebuild the option lists under a half-filled document.
    const record: Contact = {
      id: created.id,
      kind,
      displayName: name.trim(),
      companyName: name.trim(),
      gstin: needsGstin ? gstin.toUpperCase() || null : null,
      gstTreatment: treatment as GstTreatment,
      pan: needsGstin && gstin.length === 15 ? gstin.toUpperCase().slice(2, 12) : null,
      stateCode,
      email: email.trim(),
      phone: phone.trim(),
      billingAddress: { label: 'Billing', line1: '', city: '', stateCode, pincode: '' },
      paymentTermsDays: Number(terms.replace('net_', '')) || 0,
      creditLimit: null,
      isMsme: kind === 'vendor' ? isMsme : false,
      udyamNo: kind === 'vendor' && isMsme ? udyam.trim() : undefined,
      tdsSection: kind === 'vendor' ? tdsSection || undefined : undefined,
      openingBalance: 0,
      isArchived: false,
    };
    useAppStore.setState((s) => ({ contacts: [...s.contacts, record] }));

    toast.success(`${name.trim()} added`, {
      description: `Saved as a ${noun}. Addresses and credit terms can be filled in later.`,
    });
    onCreated(created.id);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" data-slot={`quick-${noun}`}>
        <DialogHeader>
          <DialogTitle>New {noun}</DialogTitle>
          <DialogDescription>
            Just enough to raise the document. The rest of the record — addresses, credit limit,
            opening balance — is edited later under {kind === 'customer' ? 'Sales → Customers' : 'Purchases → Vendors'}.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <Field label={`${kind === 'customer' ? 'Customer' : 'Vendor'} name`} required>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={`${kind === 'customer' ? "Customer's" : "Vendor's"} business name`}
              autoFocus
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="GST treatment" required>
              <Combobox
                options={TREATMENTS}
                value={treatment}
                onChange={setTreatment}
                showAvatar={false}
                searchPlaceholder="Search treatments"
              />
            </Field>

            {needsGstin ? (
              <Field
                label="GSTIN"
                required
                hint={
                  gstinValid === null
                    ? 'A registered party has one — otherwise choose Unregistered'
                    : undefined
                }
                error={gstinValid === false ? 'Checksum does not match' : undefined}
              >
                <div className="relative">
                  <Input
                    value={gstin}
                    onChange={(e) => setGstinAndState(e.target.value)}
                    placeholder="22AAAAA0000A1Z5"
                    className={cn('pr-8 font-mono uppercase', gstinValid === false && 'border-destructive')}
                  />
                  {gstinValid === true && (
                    <BadgeCheck className="absolute right-2 top-1/2 size-4 -translate-y-1/2 text-success" />
                  )}
                </div>
              </Field>
            ) : (
              <Field label="Phone">
                <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+91 00000 00000" />
              </Field>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="State"
              required
              hint={
                stateCode
                  ? `${stateName(stateCode)} — decides intra vs inter-state tax`
                  : 'Decides intra vs inter-state tax'
              }
            >
              <Combobox
                options={stateOptions()}
                value={stateCode}
                onChange={setStateCode}
                placeholder="Select a state"
                searchPlaceholder="Search states"
                showAvatar={false}
              />
            </Field>
            <Field label="Payment terms">
              <Combobox
                options={[
                  { value: 'net_0', label: 'Due on receipt' },
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
          </div>

          {needsGstin && (
            <Field label="Phone">
              <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+91 00000 00000" />
            </Field>
          )}

          <Field label="Email">
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@example.com"
            />
          </Field>

          {/* Vendor-only. Both of these change what a bill does, so they belong
              here rather than being left for a later visit to the master. */}
          {kind === 'vendor' && (
            <>
              <div className="flex items-start justify-between gap-3 rounded-md border p-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">Registered micro or small enterprise</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Starts the Section 43B(h) clock: pay within 45 days or lose the deduction for
                    the year.
                  </p>
                </div>
                <Switch checked={isMsme} onCheckedChange={setIsMsme} />
              </div>

              {isMsme && (
                <Field label="Udyam registration number" hint="From their Udyam certificate">
                  <Input
                    value={udyam}
                    onChange={(e) => setUdyam(e.target.value.toUpperCase())}
                    placeholder="UDYAM-XX-00-0000000"
                    className="font-mono"
                  />
                </Field>
              )}

              <Field label="TDS section" hint="Leave blank if no tax is deducted at source">
                <Combobox
                  options={[
                    { value: '', label: 'No TDS' },
                    ...TDS_SECTIONS.map((t) => ({
                      value: t.code,
                      label: `${t.code} — ${t.description}`,
                      sublabel: `${t.ratePctWithPan}% with PAN`,
                    })),
                  ]}
                  value={tdsSection}
                  onChange={setTdsSection}
                  showAvatar={false}
                  searchPlaceholder="Search sections"
                />
              </Field>
            </>
          )}

          {create.error && (
            <p className="flex items-start gap-1.5 text-sm text-destructive">
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              {create.error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={save} disabled={create.busy || !canSave} className="gap-1.5">
            {create.busy && <Loader2 className="size-3.5 animate-spin" />}
            {create.busy ? 'Saving…' : `Add ${noun}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Items
// ═════════════════════════════════════════════════════════════════════════════

export function QuickItemDialog({
  open,
  onOpenChange,
  initialName = '',
  priceMode = 'sale',
  defaultKind = 'goods',
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialName?: string;
  /** Which price the calling document uses; that one gets focus and a label. */
  priceMode?: PriceMode;
  /**
   * Where the document has already committed to goods or services, open on
   * that side — a services invoice offering HSN codes for goods is offering
   * codes the return will reject.
   */
  defaultKind?: 'goods' | 'service';
  onCreated: (item: Item) => void;
}) {
  const hsnCodes = useAppStore((s) => s.hsnCodes);

  const [kind, setKind] = useState<'goods' | 'service'>(defaultKind);
  const [name, setName] = useState(initialName);
  const [sku, setSku] = useState('');
  const [hsnSac, setHsnSac] = useState('');
  const [uqc, setUqc] = useState('NOS');
  const [salePaise, setSalePaise] = useState(0);
  const [purchasePaise, setPurchasePaise] = useState(0);
  const [gstRatePct, setGstRatePct] = useState(18);

  const create = useApiAction(itemsApi.create);

  useEffect(() => {
    if (!open) return;
    setKind(defaultKind);
    setName(initialName);
    setSku('');
    setHsnSac('');
    setUqc('NOS');
    setSalePaise(0);
    setPurchasePaise(0);
    setGstRatePct(18);
  }, [open, initialName, defaultKind]);

  // Goods carry an HSN, services a SAC — and a SAC always begins 99. Offering
  // the wrong half of the list is how an item ends up with a code the return
  // will reject.
  const codeOptions = useMemo(
    () =>
      hsnCodes
        .filter((h) => h.isActive && (kind === 'service' ? h.kind === 'sac' : h.kind === 'hsn'))
        .map((h) => ({
          value: h.code,
          label: h.code,
          sublabel: h.description,
          meta: `${h.gstRatePct}%`,
        })),
    [hsnCodes, kind],
  );

  const pickCode = (code: string) => {
    setHsnSac(code);
    // The code is what determines the rate, so choosing one settles it.
    const c = hsnCodes.find((h) => h.code === code);
    if (c) {
      setGstRatePct(c.gstRatePct);
      if (c.uqc) setUqc(c.uqc);
    }
  };

  const canSave = name.trim().length > 0;

  const save = async () => {
    const created = await create.run({
      kind,
      name: name.trim(),
      sku: sku.trim() || null,
      hsnSac: hsnSac || null,
      uqc,
      salePricePaise: salePaise,
      purchasePricePaise: purchasePaise,
      gstRatePct,
      taxPref: 'taxable' as TaxPref,
    });
    if (!created) {
      toast.error(create.error ?? 'Could not create that item');
      return;
    }

    const record: Item = {
      id: created.id,
      kind,
      name: name.trim(),
      sku: sku.trim(),
      hsnSac,
      uqc,
      salePricePaise: salePaise,
      purchasePricePaise: purchasePaise,
      gstRatePct,
      taxPref: 'taxable',
      saleAccountId: '',
      purchaseAccountId: '',
      isArchived: false,
    };
    useAppStore.setState((s) => ({ items: [...s.items, record] }));

    toast.success(`${name.trim()} added to the catalogue`);
    onCreated(record);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" data-slot="quick-item">
        <DialogHeader>
          <DialogTitle>New item</DialogTitle>
          <DialogDescription>
            Saved to the catalogue, so it is there the next time. Cost, stock tracking and
            reorder levels are edited later under Sales → Items.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Goods or service, first: it decides which codes are offered. */}
          <Field label="Type" required>
            <div className="flex gap-2">
              {(['goods', 'service'] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => { setKind(k); setHsnSac(''); }}
                  className={cn(
                    'flex-1 rounded-md border px-3 py-2 text-sm capitalize transition-colors',
                    kind === k
                      ? 'border-primary bg-primary/10 font-medium text-primary'
                      : 'hover:bg-accent',
                  )}
                >
                  {k}
                </button>
              ))}
            </div>
          </Field>

          <Field label="Item name" required>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Item name"
              autoFocus
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label={kind === 'service' ? 'SAC code' : 'HSN code'}
              hint={
                codeOptions.length === 0
                  ? 'None approved yet — an admin adds them under Settings → HSN & SAC Codes'
                  : 'Sets the GST rate'
              }
            >
              <Combobox
                options={codeOptions}
                value={hsnSac}
                onChange={pickCode}
                placeholder={codeOptions.length ? 'Select a code' : 'No approved codes'}
                searchPlaceholder="Type the first digits"
                emptyMessage="Not on the approved list. Ask an admin to add it."
                matchMode="prefix"
                showAvatar={false}
                clearable
                disabled={codeOptions.length === 0}
              />
            </Field>
            <Field label="GST rate" required>
              <Combobox
                options={GST_RATES.map((r) => ({ value: String(r), label: `${r}%` }))}
                value={String(gstRatePct)}
                onChange={(v) => setGstRatePct(Number(v))}
                showAvatar={false}
              />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Selling price"
              hint={priceMode === 'sale' ? 'Excluding GST' : 'Excluding GST — optional here'}
            >
              <MoneyInput valuePaise={salePaise} onChangePaise={setSalePaise} />
            </Field>
            <Field
              label="Purchase price"
              hint={priceMode === 'purchase' ? 'Excluding GST' : 'Excluding GST — optional here'}
            >
              <MoneyInput valuePaise={purchasePaise} onChangePaise={setPurchasePaise} />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Unit" hint="The UQC that appears on the return">
              <Combobox
                options={UQC_OPTIONS}
                value={uqc}
                onChange={setUqc}
                showAvatar={false}
                searchPlaceholder="Search units"
              />
            </Field>
            <Field label="SKU">
              <Input value={sku} onChange={(e) => setSku(e.target.value)} placeholder="SKU-0001" />
            </Field>
          </div>

          {create.error && (
            <p className="flex items-start gap-1.5 text-sm text-destructive">
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              {create.error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={save} disabled={create.busy || !canSave} className="gap-1.5">
            {create.busy && <Loader2 className="size-3.5 animate-spin" />}
            {create.busy ? 'Saving…' : 'Add item'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// The picker most document forms actually want
// ═════════════════════════════════════════════════════════════════════════════

/**
 * A customer or vendor Combobox with the "+ New …" footer already wired to the
 * dialog above.
 *
 * Bundled rather than left to each caller because there are a dozen of these
 * across sales and purchases, and the failure mode of doing it by hand is a
 * picker whose create action silently navigates away — which is the behaviour
 * this replaces.
 */
export function ContactPicker({
  kind,
  value,
  onChange,
  placeholder,
  disabled,
  invalid,
  className,
  canCreate = true,
}: {
  kind: 'customer' | 'vendor';
  value: string;
  onChange: (id: string) => void;
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  className?: string;
  /** False where the signed-in role may read the module but not add to it. */
  canCreate?: boolean;
}) {
  const contacts = useAppStore((s) => s.contacts);
  const [creatingName, setCreatingName] = useState<string | null>(null);

  const options = useMemo(
    () =>
      contacts
        .filter((c) => !c.isArchived && (c.kind === kind || c.kind === 'both'))
        .map((c) => ({
          value: c.id,
          label: c.displayName + (kind === 'vendor' && c.isMsme ? '  · MSME' : ''),
          sublabel: c.gstin ?? `${c.gstTreatment.replace(/_/g, ' ')} · ${stateName(c.stateCode)}`,
        })),
    [contacts, kind],
  );

  return (
    <>
      <Combobox
        options={options}
        value={value}
        onChange={onChange}
        placeholder={placeholder ?? `Select or add a ${kind}`}
        searchPlaceholder={`Search ${kind}s`}
        disabled={disabled}
        invalid={invalid}
        className={className}
        createLabel={canCreate ? `New ${kind}` : undefined}
        onCreate={canCreate ? (q) => setCreatingName(q) : undefined}
      />
      <QuickContactDialog
        kind={kind}
        open={creatingName !== null}
        onOpenChange={(o) => !o && setCreatingName(null)}
        initialName={creatingName ?? ''}
        onCreated={onChange}
      />
    </>
  );
}
