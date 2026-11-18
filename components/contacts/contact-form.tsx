'use client';

// ─────────────────────────────────────────────────────────────────────────────
// New / Edit Customer (and Vendor), laid out as Zoho Books lays it out,
// recorded from Zoho's demo and copied field for field.
//
// Top to bottom: a blue band offering to prefill from the GST portal; Customer
// Type (Business / Individual), Primary Contact (salutation, first, last),
// Company Name, Display Name* (chosen from those, or typed), Email Address,
// Phone (work, mobile), Customer Language; then the tabs
//   Other Details    GST Treatment* (none chosen until you choose), GSTIN /
//                    UIN*, Business Legal Name and Business Trade Name for a
//                    registered one, Place of Supply* (none until chosen; no
//                    such row for Overseas), PAN, Tax Preference* (not for
//                    Overseas), Currency, Opening Balance (new only), Payment
//                    Terms, Price List, Enable Portal? (new only), Documents,
//                    "Add more details" (Website URL, Department, Designation,
//                    X, Skype Name/Number, Facebook);
//   Address          Billing and Shipping side by side, "Copy billing address";
//   Contact Persons  a table to type them into;
//   Custom Fields, Reporting Tags, Remarks (For Internal Use);
// and Save / Cancel at the foot. A failed save lists every problem in Zoho's
// pink box at the head of the form, and under each field. A vendor's form has
// Bank Details as well. What Rekonza asks that Zoho does not (what they buy,
// credit limit, TDS sections, account owner, registration details, MSME)
// follows Zoho's own rows in Other Details.
// ─────────────────────────────────────────────────────────────────────────────

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowDown, Mail, Phone as PhoneIcon, PlusCircle, Smartphone, Trash2, Upload, X, Zap } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Combobox } from '@/components/ui/combobox';
import { MultiCombobox } from '@/components/ui/multi-combobox';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { DocumentForm, FormErrors, FormRow } from '@/components/shared/form-layout';
import { MoneyInput } from '@/components/shared/form-bits';
import { Attachments } from '@/components/shared/attachments';
import { KindOfBusinessSelect } from '@/components/shared/kind-of-business';
import { SupplyKindPicker } from '@/components/forms/supply-kind-picker';
import { CinLookupButton, GstinLookupButton, GstinNumberOnlyNote, gstinTreatment, type GstinDetails } from '@/components/gst/gstn-portal';
import {
  api, contactPersons, contacts, customFields, files,
  type ContactPerson, type ContactRow, type CustomFieldDefinition,
} from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { useAppStore } from '@/lib/store';
import { termsOptions } from '@/lib/options';
import { COUNTRIES, currencyOptions } from '@/lib/countries';
import { GST_STATES, isValidGstin } from '@/lib/tax/gst';
import { TDS_SECTIONS } from '@/lib/tax/tds';
import { companyTypeFrom } from '@/lib/company-profile';
import type { SupplyKind } from '@/lib/types';
import { cn } from '@/lib/utils';

type Side = 'customer' | 'vendor';
type Treatment = ContactRow['gstTreatment'];
/** A contact as the record page reads it. */
export type EditableContact = Omit<ContactRow, 'receivablePaise' | 'payablePaise' | 'invoiceCount' | 'billCount'>;

/** Zoho's salutations. */
const SALUTATIONS = ['Mr.', 'Mrs.', 'Ms.', 'Miss', 'Dr.'];
/** Zoho's customer languages, each in its own words. */
const LANGUAGES = ['العربية', 'Deutsch', 'English', 'español', 'français', 'italiano', '日本語', 'Nederlands', 'português', 'svenska', '中文'];

/** Zoho's GST treatments, in its order and words; three carry Zoho's note under them. */
export const GST_TREATMENTS: { value: Treatment; label: string; sublabel?: string; hidden?: boolean }[] = [
  { value: 'registered', label: 'Registered Business - Regular' },
  { value: 'registered_composition', label: 'Registered Business - Composition' },
  { value: 'unregistered', label: 'Unregistered Business' },
  { value: 'consumer', label: 'Consumer' },
  { value: 'overseas', label: 'Overseas' },
  { value: 'sez', label: 'Special Economic Zone' },
  { value: 'deemed_export', label: 'Deemed Export', sublabel: 'Notified list of goods manufactured and supplied within India classified as Deemed Export.' },
  { value: 'tax_deductor', label: 'Tax Deductor', sublabel: 'Departments of the State/Central government, governmental agencies or local authorities' },
  { value: 'sez_developer', label: 'SEZ Developer', sublabel: 'A person/organisation who owns at least 26% of the equity in creating business units in a Special Economic Zone (SEZ)' },
  // Kept for a contact that already has it; Zoho no longer offers it.
  { value: 'uin', label: 'UIN Holders', hidden: true },
];
/** The treatments that carry a GSTIN (or UIN), and Zoho's legal and trade names with it. */
const NEEDS_GSTIN: string[] = ['registered', 'registered_composition', 'sez', 'sez_developer', 'deemed_export', 'tax_deductor', 'uin'];

/** Each state's two letters, as Zoho shows the place of supply: "[TN] - Tamil Nadu". */
const STATE_ALPHA: Record<string, string> = {
  '01': 'JK', '02': 'HP', '03': 'PB', '04': 'CH', '05': 'UK', '06': 'HR', '07': 'DL', '08': 'RJ', '09': 'UP', '10': 'BR', '11': 'SK', '12': 'AR',
  '13': 'NL', '14': 'MN', '15': 'MZ', '16': 'TR', '17': 'ML', '18': 'AS', '19': 'WB', '20': 'JH', '21': 'OD', '22': 'CG', '23': 'MP', '24': 'GJ',
  '26': 'DN', '27': 'MH', '29': 'KA', '30': 'GA', '31': 'LD', '32': 'KL', '33': 'TN', '34': 'PY', '35': 'AN', '36': 'TS', '37': 'AP', '38': 'LA', '97': 'OT',
};
const PLACES = Object.entries(GST_STATES).filter(([code]) => code !== '96')
  .map(([code, name]) => ({ value: code, label: `[${STATE_ALPHA[code] ?? code}] - ${name}`, name }))
  .sort((a, b) => a.name.localeCompare(b.name));
/** An address's Country/Region: India first, then every other (lib/countries.ts lists those abroad). */
const ADDRESS_COUNTRIES = [{ value: 'India', label: 'India' }, ...COUNTRIES.map((c) => ({ value: c.name, label: c.name }))];
/** Currencies by name, as Zoho shows them ("Indian Rupee"). */
function currencyChoices() {
  const names = typeof Intl !== 'undefined' && 'DisplayNames' in Intl ? new Intl.DisplayNames(['en'], { type: 'currency' }) : null;
  return currencyOptions().map((c) => {
    const name = names?.of(c.value);
    return { value: c.value, label: name ? name.replace(/\b\w/g, (m) => m.toUpperCase()) : c.value, sublabel: c.value };
  });
}

// Zoho's own words for its (i) tips, where they hold for Rekonza too.
const PRIVACY = 'Privacy Info: This data will be stored without encryption and will be visible only to your organisation users who have the required permission.';

interface Address { attention: string; country: string; street1: string; street2: string; city: string; state: string; pincode: string; phone: string; fax: string }
interface PersonDraft {
  key: string; id: string | null; salutation: string; firstName: string; lastName: string; email: string; phone: string; mobile: string;
  designation: string | null; department: string | null; isPrimary: boolean; receivesDocuments: boolean;
}
interface FormState {
  contactType: 'business' | 'individual'; salutation: string; firstName: string; lastName: string; legalName: string;
  displayName: string; email: string; phone: string; mobile: string; language: string;
  gstTreatment: Treatment | ''; gstin: string; businessLegalName: string; businessTradeName: string; stateCode: string; pan: string;
  taxPreference: 'taxable' | 'exempt'; taxExemptionReason: string; currency: string; openingBalance: number;
  paymentTerms: string; priceListId: string; portal: boolean;
  website: string; department: string; designation: string; twitter: string; skype: string; facebook: string;
  supplies: SupplyKind; creditLimit: number; tdsSections: string[]; ownerUserId: string;
  constitution: string; gstStatus: string; gstRegisteredOn: string; cin: string; incorporatedOn: string;
  isMsme: boolean; msmeUdyamNo: string; msmeCategory: string; msmeActivity: string; msmeAgreementDays: string;
  bankAccountName: string; bankAccountNo: string; bankIfsc: string; bankName: string;
  billing: Address; shipping: Address; notes: string;
}

const BLANK_ADDRESS: Address = { attention: '', country: '', street1: '', street2: '', city: '', state: '', pincode: '', phone: '', fax: '' };
const s = (v: string | null | undefined) => v ?? '';
let keySeq = 0;
const newKey = () => `p${++keySeq}`;
const blankPerson = (): PersonDraft => ({ key: newKey(), id: null, salutation: '', firstName: '', lastName: '', email: '', phone: '', mobile: '', designation: null, department: null, isPrimary: false, receivesDocuments: true });

/** A new contact: nothing chosen that Zoho leaves to you (the GST treatment, the place of supply). */
function blank(): FormState {
  return {
    contactType: 'business', salutation: '', firstName: '', lastName: '', legalName: '', displayName: '', email: '', phone: '', mobile: '', language: 'English',
    gstTreatment: '', gstin: '', businessLegalName: '', businessTradeName: '', stateCode: '', pan: '', taxPreference: 'taxable', taxExemptionReason: '',
    currency: 'INR', openingBalance: 0, paymentTerms: 'due_on_receipt', priceListId: '', portal: false,
    website: '', department: '', designation: '', twitter: '', skype: '', facebook: '',
    supplies: 'both', creditLimit: 0, tdsSections: [], ownerUserId: '',
    constitution: '', gstStatus: '', gstRegisteredOn: '', cin: '', incorporatedOn: '',
    isMsme: false, msmeUdyamNo: '', msmeCategory: '', msmeActivity: '', msmeAgreementDays: '',
    bankAccountName: '', bankAccountNo: '', bankIfsc: '', bankName: '',
    billing: { ...BLANK_ADDRESS }, shipping: { ...BLANK_ADDRESS }, notes: '',
  };
}

/** The form as a saved contact fills it; a clone drops the GSTIN, which is one registration's alone. */
function fromContact(c: EditableContact, clone: boolean): FormState {
  const addr = (p: 'billing' | 'shipping'): Address => ({
    attention: s(c[`${p}Attention`]), country: s(c[`${p}Country`]),
    street1: s(p === 'billing' ? c.billingAddress : c.shippingAddress), street2: s(c[`${p}Street2`]),
    city: s(c[`${p}City`]), state: s(c[`${p}State`]), pincode: s(c[`${p}Pincode`]), phone: s(c[`${p}Phone`]), fax: s(c[`${p}Fax`]),
  });
  return {
    contactType: c.contactType === 'individual' ? 'individual' : 'business', salutation: s(c.salutation), firstName: s(c.firstName), lastName: s(c.lastName),
    legalName: s(c.legalName), displayName: c.displayName, email: s(c.email), phone: s(c.phone), mobile: s(c.mobile), language: c.language || 'English',
    gstTreatment: c.gstTreatment, gstin: clone ? '' : s(c.gstin), businessLegalName: clone ? '' : s(c.businessLegalName), businessTradeName: clone ? '' : s(c.businessTradeName),
    stateCode: c.stateCode === '96' ? '' : c.stateCode, pan: s(c.pan),
    taxPreference: c.taxPreference === 'exempt' ? 'exempt' : 'taxable', taxExemptionReason: s(c.taxExemptionReason),
    currency: c.currency || 'INR', openingBalance: 0, paymentTerms: c.paymentTerms || 'due_on_receipt', priceListId: s(c.priceListId), portal: false,
    website: s(c.website), department: s(c.department), designation: s(c.designation), twitter: s(c.twitter), skype: s(c.skype), facebook: s(c.facebook),
    supplies: c.supplies ?? 'both', creditLimit: c.creditLimitPaise ?? 0, tdsSections: c.tdsSections ?? (c.tdsSection ? [c.tdsSection] : []),
    ownerUserId: s(c.ownerUserId),
    constitution: s(c.constitution), gstStatus: clone ? '' : s(c.gstStatus), gstRegisteredOn: clone ? '' : s(c.gstRegisteredOn),
    cin: s(c.cin), incorporatedOn: s(c.incorporatedOn),
    isMsme: !!c.isMsme, msmeUdyamNo: s(c.msmeUdyamNo), msmeCategory: s(c.msmeCategory), msmeActivity: s(c.msmeActivity),
    msmeAgreementDays: c.msmeAgreementDays ? String(c.msmeAgreementDays) : '',
    // The stored number comes back masked; it is kept unless a new one is typed.
    bankAccountName: s(c.bankAccountName), bankAccountNo: clone ? '' : s(c.bankAccountNo), bankIfsc: s(c.bankIfsc), bankName: s(c.bankName),
    billing: addr('billing'), shipping: addr('shipping'), notes: s(c.notes),
  };
}

const personFrom = (p: ContactPerson, clone: boolean): PersonDraft => {
  const [first, ...rest] = (p.name ?? '').split(' ');
  return {
    key: newKey(), id: clone ? null : p.id, salutation: s(p.salutation), firstName: p.firstName ?? first ?? '', lastName: p.lastName ?? rest.join(' '),
    email: s(p.email), phone: s(p.phone), mobile: s(p.mobile), designation: p.designation, department: p.department,
    isPrimary: p.isPrimary, receivesDocuments: p.receivesDocuments,
  };
};

const selectCls = 'h-[34px] w-full rounded-[var(--radius-button)] border border-input bg-background px-2 text-[13px] outline-none focus:border-primary';

/** Zoho's radio pair. */
function Radios<T extends string>({ name, value, options, onChange, slot }: { name: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; slot?: string }) {
  return (
    <div className="flex h-[34px] flex-wrap items-center gap-x-6" role="radiogroup" aria-label={name} data-slot={slot}>
      {options.map((o) => (
        <label key={o.value} className="flex cursor-pointer items-center gap-2 text-[13px]">
          <input type="radio" name={name} className="size-3.5 accent-primary" checked={value === o.value} onChange={() => onChange(o.value)} />
          {o.label}
        </label>
      ))}
    </div>
  );
}

/** An input with Zoho's icon inside it (the envelope, the phone, the mobile). */
function IconInput({ icon, ...props }: { icon: ReactNode } & React.ComponentProps<typeof Input>) {
  return (
    <div className="relative">
      <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground [&_svg]:size-3.5">{icon}</span>
      <Input {...props} className={cn('pl-8', props.className)} />
    </div>
  );
}

/** An input with Zoho's grey box before it: "INR", "https://x.com/". */
function PrefixInput({ prefix, ...props }: { prefix: string } & React.ComponentProps<typeof Input>) {
  return (
    <div className="flex">
      <span className="grid h-[34px] shrink-0 place-items-center rounded-l-[var(--radius-button)] border border-r-0 bg-muted px-2.5 text-[13px] text-muted-foreground">{prefix}</span>
      <Input {...props} className={cn('rounded-l-none', props.className)} />
    </div>
  );
}

interface TagList { tags: { id: string; name: string; isActive: boolean; options: { id: string; value: string; isActive: boolean }[] }[]; values?: Record<string, string> }
interface PriceListRow { id: string; name: string; isActive: boolean; basis?: 'percent' | 'per_item'; percent?: number }

type FormTab = 'other' | 'address' | 'persons' | 'bank' | 'custom' | 'tags' | 'remarks';

export function ContactForm({ side, editing, clone, initialTab }: { side: Side; editing?: EditableContact | null; clone?: EditableContact | null; initialTab?: string | null }) {
  const router = useRouter();
  const noun = side === 'customer' ? 'Customer' : 'Vendor';
  const base = side === 'customer' ? '/sales/customers' : '/purchases/vendors';
  const back = editing ? `${base}/${editing.id}` : clone ? `${base}/${clone.id}` : base;
  const users = useAppStore((st) => st.users);
  const [f, setF] = useState<FormState>(() => (editing ? fromContact(editing, false) : clone ? fromContact(clone, true) : blank()));
  const set = (patch: Partial<FormState>) => setF((x) => ({ ...x, ...patch }));
  const [tab, setTab] = useState<FormTab>(() => (['address', 'persons', 'bank', 'custom', 'tags', 'remarks'].includes(initialTab ?? '') ? initialTab as FormTab : 'other'));
  const [moreDetails, setMoreDetails] = useState(() => !!(editing && (editing.website || editing.department || editing.designation || editing.twitter || editing.skype || editing.facebook)));
  const [nameTouched, setNameTouched] = useState(!!(editing || clone));
  const [lookup, setLookup] = useState<GstinDetails | null>(null);
  const [prefill, setPrefill] = useState(false);
  const [prefillGstin, setPrefillGstin] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<File[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);

  // The people, the price lists, the custom fields and the reporting tags.
  const source = editing?.id ?? clone?.id ?? null;
  const personsState = useApi<{ persons: ContactPerson[] }>(() => (source ? contactPersons.list(source) : Promise.resolve({ persons: [] })), [source]);
  const [persons, setPersons] = useState<PersonDraft[] | null>(null);
  const rows = persons ?? (personsState.data?.persons ?? []).map((p) => personFrom(p, !editing));
  const setRows = (next: PersonDraft[]) => setPersons(next);
  // Zoho opens the table with one empty row to type into; left empty, it is not saved.
  const [spare] = useState(blankPerson);
  const shownRows = rows.length ? rows : personsState.loading ? [] : [spare];
  const priceLists = useApi<{ lists: PriceListRow[] }>(() => (side === 'customer' ? api.get('/api/price-lists') : Promise.resolve({ lists: [] })), [side]);
  const fieldDefs = useApi(() => customFields.list('contact'), []);
  const fieldValues = useApi(() => (source ? customFields.values('contact', source) : Promise.resolve({ values: [] })), [source]);
  const [custom, setCustom] = useState<Record<string, string | null> | null>(null);
  const defs: CustomFieldDefinition[] = (fieldDefs.data?.fields ?? []).filter((d) => d.isActive);
  const customValue = (key: string) => (custom ?? Object.fromEntries((fieldValues.data?.values ?? []).map((v) => [v.key, v.value])))[key] ?? '';
  const tagState = useApi<TagList>(() => api.get<TagList>('/api/reporting-tags', source ? { entity: 'contact', id: source } : undefined), [source]);
  const [tagValues, setTagValues] = useState<Record<string, string> | null>(null);
  const tags = (tagState.data?.tags ?? []).filter((t) => t.isActive);
  const tagValue = (id: string) => (tagValues ?? tagState.data?.values ?? {})[id] ?? '';
  // An edit or a clone saves what it read: its people, fields and tags must have come before Save can.
  const ready = !source || !(personsState.loading || fieldValues.loading || tagState.loading);
  const currencies = useMemo(currencyChoices, []);

  const overseas = f.gstTreatment === 'overseas';
  const needsGstin = NEEDS_GSTIN.includes(f.gstTreatment);
  const gstinValid = f.gstin.length === 15 ? isValidGstin(f.gstin) : null;

  // Zoho's Display Name choices: the person's name in its usual forms, then the company.
  const nameChoices = useMemo(() => {
    const first = f.firstName.trim(); const last = f.lastName.trim();
    const all = [
      f.salutation && (first || last) ? [f.salutation, first, last].filter(Boolean).join(' ') : '',
      [first, last].filter(Boolean).join(' '),
      first && last ? `${last}, ${first}` : '',
      f.legalName.trim(),
      f.displayName.trim(),
    ];
    return [...new Set(all.filter(Boolean))].map((v) => ({ value: v, label: v }));
  }, [f.legalName, f.salutation, f.firstName, f.lastName, f.displayName]);
  /** Until a name is chosen, Zoho fills it from what is typed first: the company, or the person. */
  const autoName = (patch: Partial<FormState>) => {
    const next = { ...f, ...patch };
    const guess = next.legalName.trim() || [next.salutation, next.firstName.trim(), next.lastName.trim()].filter(Boolean).join(' ');
    set(nameTouched ? patch : { ...patch, displayName: guess });
  };

  const treatmentChanged = (v: Treatment) => {
    dropError('gstTreatment');
    set({ gstTreatment: v, ...(NEEDS_GSTIN.includes(v) ? {} : { gstin: '', businessLegalName: '', businessTradeName: '' }) });
  };

  /** What a GSTIN lookup brings: the registered names and address, the state, the PAN and the kind of registration. */
  const found = (d: GstinDetails) => {
    setLookup(d);
    const stateName = d.address?.stateCode ? GST_STATES[d.address.stateCode] ?? '' : '';
    setF((x) => ({
      ...x,
      gstin: d.gstin,
      businessLegalName: d.legalName ?? x.businessLegalName,
      businessTradeName: d.tradeName ?? x.businessTradeName,
      legalName: x.legalName || d.tradeName || d.legalName || '',
      displayName: nameTouched && x.displayName ? x.displayName : d.tradeName || d.legalName || x.displayName,
      pan: d.pan,
      constitution: d.constitution ? companyTypeFrom(d.constitution) ?? d.constitution : x.constitution,
      gstStatus: d.status ?? x.gstStatus,
      gstRegisteredOn: d.registeredOn ?? x.gstRegisteredOn,
      gstTreatment: d.fromPortal || !NEEDS_GSTIN.includes(x.gstTreatment) ? (gstinTreatment(d) as Treatment) : x.gstTreatment,
      stateCode: d.address?.stateCode ?? x.stateCode,
      billing: d.address ? {
        ...x.billing, country: 'India', street1: d.address.line ?? x.billing.street1, city: d.address.city ?? x.billing.city,
        pincode: d.address.pincode ?? x.billing.pincode, state: stateName || x.billing.state,
      } : x.billing,
    }));
    if (d.tradeName || d.legalName) setNameTouched(true);
  };

  /** A field's message goes once it is put right. */
  function dropError(key: string) { setErrors((e) => { const next = { ...e }; delete next[key]; return next; }); }

  const setAddr = (which: 'billing' | 'shipping', patch: Partial<Address>) => set({ [which]: { ...f[which], ...patch } } as Partial<FormState>);

  const save = async () => {
    // Zoho's own messages, every one at once.
    const problems: Record<string, string> = {};
    if (!f.displayName.trim()) problems.displayName = side === 'customer' ? 'Please enter the Display Name.' : 'Enter the Display Name of your vendor.';
    if (!f.gstTreatment) problems.gstTreatment = 'Please choose proper GST Treatment.';
    if (needsGstin && !f.gstin) problems.gstin = 'Please enter a valid GSTIN / UIN.';
    else if (f.gstin && gstinValid === false) problems.gstin = 'Please enter a valid GSTIN / UIN.';
    if (!overseas && !f.stateCode) problems.stateCode = side === 'customer' ? 'Please select a place of supply' : 'Please select a source of supply';
    if (!overseas && f.taxPreference === 'exempt' && !f.taxExemptionReason.trim()) problems.taxExemptionReason = 'Please enter the exemption reason.';
    if (f.isMsme && f.msmeAgreementDays && !(Number(f.msmeAgreementDays) >= 1 && Number(f.msmeAgreementDays) <= 45)) problems.msmeAgreementDays = 'The credit period agreed is between 1 and 45 days.';
    setErrors(problems);
    setBanner(Object.values(problems));
    if (Object.keys(problems).length) {
      if (problems.gstTreatment || problems.gstin || problems.stateCode || problems.taxExemptionReason || problems.msmeAgreementDays) setTab('other');
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    const n = (v: string) => (v.trim() ? v.trim() : null);
    // An overseas party's country is the billing address's (Zoho asks it there).
    const countryCode = overseas ? COUNTRIES.find((c) => c.name === f.billing.country)?.code ?? null : null;
    const payload: Record<string, unknown> = {
      contactType: f.contactType, salutation: n(f.salutation), firstName: n(f.firstName), lastName: n(f.lastName),
      legalName: n(f.legalName), displayName: f.displayName.trim(), email: n(f.email) ?? '', phone: n(f.phone), mobile: n(f.mobile), language: f.language,
      gstTreatment: f.gstTreatment, gstin: needsGstin ? f.gstin : '',
      businessLegalName: needsGstin && side === 'customer' ? n(f.businessLegalName) : null, businessTradeName: needsGstin && side === 'customer' ? n(f.businessTradeName) : null,
      stateCode: overseas ? '96' : f.stateCode, country: countryCode,
      pan: f.pan || (f.gstin.length === 15 ? f.gstin.slice(2, 12) : ''),
      taxPreference: overseas ? 'taxable' : f.taxPreference, taxExemptionReason: !overseas && f.taxPreference === 'exempt' ? n(f.taxExemptionReason) : null,
      currency: (f.currency || 'INR').toUpperCase(), paymentTerms: f.paymentTerms,
      website: n(f.website), department: n(f.department), designation: n(f.designation), twitter: n(f.twitter), skype: n(f.skype), facebook: n(f.facebook),
      creditLimitPaise: f.creditLimit, tdsSections: overseas ? [] : f.tdsSections,
      constitution: n(f.constitution), gstStatus: n(f.gstStatus), gstRegisteredOn: f.gstRegisteredOn || '', cin: f.cin || '', incorporatedOn: f.incorporatedOn || '',
      billingAttention: n(f.billing.attention), billingCountry: n(f.billing.country), billingAddress: n(f.billing.street1), billingStreet2: n(f.billing.street2),
      billingCity: n(f.billing.city), billingState: n(f.billing.state), billingPincode: n(f.billing.pincode), billingPhone: n(f.billing.phone), billingFax: n(f.billing.fax),
      shippingAttention: n(f.shipping.attention), shippingCountry: n(f.shipping.country), shippingAddress: n(f.shipping.street1), shippingStreet2: n(f.shipping.street2),
      shippingCity: n(f.shipping.city), shippingState: n(f.shipping.state), shippingPincode: n(f.shipping.pincode), shippingPhone: n(f.shipping.phone), shippingFax: n(f.shipping.fax),
      notes: n(f.notes),
      ...(side === 'customer' ? { supplies: f.supplies, priceListId: f.priceListId || null, ownerUserId: f.ownerUserId || null } : {}),
      ...(side === 'vendor' ? {
        isMsme: f.isMsme, msmeUdyamNo: f.isMsme ? n(f.msmeUdyamNo) : null, msmeCategory: f.isMsme ? f.msmeCategory || null : null,
        msmeActivity: f.isMsme ? f.msmeActivity || null : null, msmeAgreementDays: f.isMsme && f.msmeAgreementDays ? Number(f.msmeAgreementDays) : null,
        bankAccountName: n(f.bankAccountName), bankIfsc: f.bankIfsc, bankName: n(f.bankName), ...(f.bankAccountNo ? { bankAccountNo: f.bankAccountNo } : editing ? {} : { bankAccountNo: '' }),
      } : {}),
    };
    setBusy(true);
    try {
      let id: string;
      if (editing) {
        await contacts.update({ ...payload, id: editing.id, expectedUpdatedAt: editing.updatedAt });
        id = editing.id;
      } else {
        const r = await contacts.create({ ...payload, kind: side, ...(f.openingBalance > 0 ? { openingBalancePaise: f.openingBalance } : {}) });
        id = r.id;
      }
      // What hangs off the contact goes on once it exists; a failure there leaves the contact saved.
      const after: string[] = [];
      const people = rows.filter((p) => p.firstName.trim() || p.lastName.trim() || p.email.trim());
      if (persons !== null || (!editing && people.length)) {
        try {
          await contactPersons.save(id, people.map((p, i) => ({
            id: p.id, salutation: p.salutation || null, firstName: p.firstName.trim() || null, lastName: p.lastName.trim() || null,
            name: [p.firstName.trim(), p.lastName.trim()].filter(Boolean).join(' '), email: p.email.trim() || null, phone: p.phone.trim() || null,
            mobile: p.mobile.trim() || null, designation: p.designation, department: p.department,
            isPrimary: p.isPrimary || (i === 0 && !people.some((x) => x.isPrimary)), receivesDocuments: p.receivesDocuments,
          })));
        } catch (e) { after.push(`contact persons: ${e instanceof Error ? e.message : String(e)}`); }
      }
      const chosenFields = custom ?? (clone ? Object.fromEntries((fieldValues.data?.values ?? []).map((v) => [v.key, v.value])) : null);
      if (chosenFields && Object.keys(chosenFields).length) {
        try { await customFields.setValues('contact', id, chosenFields); } catch (e) { after.push(`custom fields: ${e instanceof Error ? e.message : String(e)}`); }
      }
      const chosenTags = tagValues ?? tagState.data?.values ?? {};
      const tagPatch = Object.fromEntries(tags.map((t) => [t.id, chosenTags[t.id] || null]).filter(([, v]) => v || editing));
      if (Object.keys(tagPatch).length) {
        try { await api.post('/api/reporting-tags', { action: 'assign', entity: 'contact', id, values: tagPatch }); } catch (e) { after.push(`reporting tags: ${e instanceof Error ? e.message : String(e)}`); }
      }
      for (const file of pending) {
        try { await files.upload('contact', id, file); } catch (e) { after.push(`${file.name}: ${e instanceof Error ? e.message : String(e)}`); }
      }
      if (f.portal) {
        try { await api.post('/api/portal-access', { action: 'create', contactId: id, side, emailTo: n(f.email) }); } catch (e) { after.push(`portal: ${e instanceof Error ? e.message : String(e)}`); }
      }
      if (after.length) toast.error(`The ${noun.toLowerCase()} is saved; some details were not`, { description: after.slice(0, 3).join(' · ') });
      toast.success(editing ? `The ${noun.toLowerCase()} has been updated.` : `The ${noun.toLowerCase()} has been created.`);
      router.push(`${base}/${id}`);
    } catch (e) {
      const details = (e as { details?: Record<string, string> }).details;
      const message = e instanceof Error ? e.message : String(e);
      if (details && typeof details === 'object') { setErrors(details); setBanner(Object.values(details)); }
      else setBanner([message]);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } finally {
      setBusy(false);
    }
  };

  const TABS: [FormTab, string][] = [
    ['other', 'Other Details'], ['address', 'Address'], ['persons', 'Contact Persons'],
    ...(side === 'vendor' ? [['bank', 'Bank Details'] as [FormTab, string]] : []),
    ['custom', 'Custom Fields'], ['tags', 'Reporting Tags'], ['remarks', 'Remarks'],
  ];
  const priceChoices = (priceLists.data?.lists ?? []).filter((l) => l.isActive || l.id === f.priceListId).map((l) => ({
    value: l.id,
    label: l.basis === 'percent' && l.percent ? `${l.name} [ ${Math.abs(l.percent).toFixed(6)}% ${l.percent > 0 ? 'Markup' : 'Markdown'} ]` : l.name,
  }));

  const addressColumn = (which: 'billing' | 'shipping') => {
    const a = f[which];
    const india = !a.country || a.country === 'India';
    const stateChoices = india ? Object.entries(GST_STATES).filter(([c]) => c !== '96').map(([, v]) => ({ value: v, label: v })) : a.state ? [{ value: a.state, label: a.state }] : [];
    return (
      <div className="min-w-0 flex-1 space-y-3.5" data-slot={`address-${which}`}>
        <h3 className="flex items-center gap-2 text-[15px]">
          {which === 'billing' ? 'Billing Address' : 'Shipping Address'}
          {which === 'shipping' && (
            <button type="button" className="inline-flex items-center gap-1 text-[13px] text-link hover:underline" data-slot="copy-billing"
              onClick={() => set({ shipping: { ...f.billing } })}>
              ( <ArrowDown className="size-3.5" /> Copy billing address )
            </button>
          )}
        </h3>
        <FormRow label="Attention"><Input value={a.attention} onChange={(e) => setAddr(which, { attention: e.target.value })} aria-label={`${which} attention`} /></FormRow>
        <FormRow label="Country/Region">
          <Combobox options={ADDRESS_COUNTRIES} value={a.country} onChange={(v) => setAddr(which, { country: v })}
            placeholder="Select" searchPlaceholder="Search" showAvatar={false} clearable />
        </FormRow>
        <FormRow label="Address">
          <div className="space-y-2">
            <Textarea rows={2} value={a.street1} onChange={(e) => setAddr(which, { street1: e.target.value })} placeholder="Street 1" aria-label={`${which} street 1`} />
            <Textarea rows={2} value={a.street2} onChange={(e) => setAddr(which, { street2: e.target.value })} placeholder="Street 2" aria-label={`${which} street 2`} />
          </div>
        </FormRow>
        <FormRow label="City"><Input value={a.city} onChange={(e) => setAddr(which, { city: e.target.value })} aria-label={`${which} city`} /></FormRow>
        <FormRow label="State">
          <Combobox options={stateChoices} value={a.state} onChange={(v) => setAddr(which, { state: v })} onCreate={(q) => setAddr(which, { state: q })}
            createLabel="Add" placeholder="Select or type to add" searchPlaceholder="Search" showAvatar={false} clearable />
        </FormRow>
        <FormRow label="Pin Code"><Input value={a.pincode} onChange={(e) => setAddr(which, { pincode: e.target.value })} aria-label={`${which} pin code`} /></FormRow>
        <FormRow label="Phone"><Input value={a.phone} onChange={(e) => setAddr(which, { phone: e.target.value })} aria-label={`${which} phone`} /></FormRow>
        <FormRow label="Fax Number"><Input value={a.fax} onChange={(e) => setAddr(which, { fax: e.target.value })} aria-label={`${which} fax`} /></FormRow>
      </div>
    );
  };

  return (
    <DocumentForm
      title={editing ? `Edit ${noun}` : `New ${noun}`}
      backHref={back}
      footer={
        <>
          <Button onClick={() => void save()} disabled={busy || !ready} data-slot="contact-save">{busy ? 'Saving…' : 'Save'}</Button>
          <Button variant="outline" asChild><Link href={back}>Cancel</Link></Button>
        </>
      }
    >
      {/* Zoho's blue band: fill the form from the GST portal. */}
      <div className="-mx-5 -mt-7 mb-6 flex items-center gap-2 bg-[#eef5ff] px-5 py-2 text-[13px] shadow-[0_0_0_100vmax_#eef5ff] [clip-path:inset(0_-100vmax_0_0)] dark:bg-[#1c2a40] dark:shadow-[0_0_0_100vmax_#1c2a40]" data-slot="contact-prefill">
        <Zap className="size-4 text-primary" />
        <span>Prefill {noun} details from the GST portal using the {noun}&apos;s GSTIN.</span>
        <button type="button" className="font-medium text-link hover:underline" onClick={() => { setPrefillGstin(f.gstin); setPrefill(true); }}>Prefill ›</button>
      </div>

      <FormErrors errors={banner} onClose={() => setBanner([])} />

      <div className="max-w-[760px] space-y-4" data-slot="contact-top">
        {side === 'customer' && (
          <FormRow label="Customer Type" help="A business is a company you sell to; an individual is a person buying for themselves.">
            <Radios name="Customer type" slot="contact-type" value={f.contactType}
              options={[{ value: 'business', label: 'Business' }, { value: 'individual', label: 'Individual' }]}
              onChange={(v) => set({ contactType: v })} />
          </FormRow>
        )}
        <FormRow label="Primary Contact" width="lg" help={`The primary contact will receive all emails related to transactions. You can add multiple contact persons below or from this ${noun.toLowerCase()}'s details page.`}>
          <div className="grid grid-cols-[140px_1fr_1fr] gap-2.5">
            <select className={selectCls} value={f.salutation} onChange={(e) => autoName({ salutation: e.target.value })} aria-label="Salutation">
              <option value="">Salutation</option>
              {SALUTATIONS.map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
            <Input value={f.firstName} onChange={(e) => autoName({ firstName: e.target.value })} placeholder="First Name" aria-label="First Name" />
            <Input value={f.lastName} onChange={(e) => autoName({ lastName: e.target.value })} placeholder="Last Name" aria-label="Last Name" />
          </div>
        </FormRow>
        <FormRow label="Company Name"><Input value={f.legalName} onChange={(e) => autoName({ legalName: e.target.value })} aria-label="Company Name" /></FormRow>
        <FormRow label="Display Name" required error={errors.displayName} help={`This name will be displayed on all the transactions you create for this ${side === 'customer' ? 'customer' : 'Vendor'}.`}>
          <div data-slot="contact-display-name">
            <Combobox options={nameChoices} value={f.displayName} onChange={(v) => { setNameTouched(true); set({ displayName: v }); }}
              onCreate={(q) => { setNameTouched(true); set({ displayName: q.trim() }); }} createLabel="Use"
              placeholder="Select or type to add" searchPlaceholder="Type a name" showAvatar={false} invalid={!!errors.displayName} />
          </div>
        </FormRow>
        <FormRow label="Email Address" error={errors.email} help={PRIVACY}>
          <IconInput icon={<Mail />} type="email" value={f.email} onChange={(e) => set({ email: e.target.value })} aria-label="Email Address" />
        </FormRow>
        <FormRow label="Phone" help={PRIVACY}>
          <div className="grid grid-cols-2 gap-2.5">
            <IconInput icon={<PhoneIcon />} value={f.phone} onChange={(e) => set({ phone: e.target.value })} placeholder="Work Phone" aria-label="Work Phone" />
            <IconInput icon={<Smartphone />} value={f.mobile} onChange={(e) => set({ mobile: e.target.value })} placeholder="Mobile" aria-label="Mobile" />
          </div>
        </FormRow>
        <FormRow label={`${noun} Language`} help={`The language this ${noun.toLowerCase()} prefers, kept with their record.`}>
          <Combobox options={[...new Set([...LANGUAGES, f.language])].map((l) => ({ value: l, label: l }))} value={f.language} onChange={(v) => set({ language: v || 'English' })} showAvatar={false} searchPlaceholder="Search" />
        </FormRow>
      </div>

      <div className="mt-8 flex gap-1 overflow-x-auto border-b" role="tablist" data-slot="contact-form-tabs">
        {TABS.map(([v, l]) => (
          <button key={v} type="button" role="tab" aria-selected={tab === v} onClick={() => setTab(v)}
            className={cn('-mb-px shrink-0 border-b-2 px-3.5 py-2.5 text-[13px]', tab === v ? 'border-primary font-semibold text-foreground' : 'border-transparent text-foreground/80 hover:text-foreground')}>
            {l}
          </button>
        ))}
      </div>

      <div className="py-6">
        {tab === 'other' && (
          <div className="max-w-[760px] space-y-4" data-slot="contact-other-details">
            <FormRow label="GST Treatment" required error={errors.gstTreatment}>
              <div data-slot="gst-treatment">
                <Combobox options={GST_TREATMENTS.filter((t) => (!t.hidden || t.value === f.gstTreatment) && (side === 'customer' || t.value !== 'consumer' || f.gstTreatment === 'consumer'))} value={f.gstTreatment} onChange={(v) => treatmentChanged(v as Treatment)}
                  placeholder="Select a GST treatment" showAvatar={false} searchPlaceholder="Search" invalid={!!errors.gstTreatment} />
              </div>
            </FormRow>
            {needsGstin && (
              <>
                <FormRow label="GSTIN / UIN" required error={errors.gstin} help="The 15-character GST registration number. Its first two digits are the state code.">
                  <div className="flex gap-2">
                    <Input value={f.gstin} maxLength={15} className="font-mono" aria-label="GSTIN" aria-invalid={gstinValid === false || !!errors.gstin}
                      onChange={(e) => {
                        const g = e.target.value.toUpperCase().replace(/\s/g, '');
                        set({ gstin: g, ...(g.length >= 2 && GST_STATES[g.slice(0, 2)] ? { stateCode: g.slice(0, 2) } : {}), ...(g.length === 15 && !f.pan ? { pan: g.slice(2, 12) } : {}) });
                      }} />
                    <GstinLookupButton gstin={f.gstin} auto={f.gstin !== s(editing?.gstin)} onFound={found} />
                  </div>
                  <GstinNumberOnlyNote details={lookup} gstin={f.gstin} />
                </FormRow>
                {side === 'customer' && (
                  <>
                    <FormRow label="Business Legal Name"><Input value={f.businessLegalName} onChange={(e) => set({ businessLegalName: e.target.value })} aria-label="Business Legal Name" /></FormRow>
                    <FormRow label="Business Trade Name"><Input value={f.businessTradeName} onChange={(e) => set({ businessTradeName: e.target.value })} aria-label="Business Trade Name" /></FormRow>
                  </>
                )}
              </>
            )}
            {!overseas && (
              <FormRow label={side === 'customer' ? 'Place of Supply' : 'Source of Supply'} required error={errors.stateCode}>
                <div data-slot="place-of-supply">
                  <Combobox options={PLACES} value={f.stateCode} onChange={(v) => { dropError('stateCode'); set({ stateCode: v }); }}
                    placeholder="" searchPlaceholder="Search" showAvatar={false} invalid={!!errors.stateCode} />
                </div>
              </FormRow>
            )}
            <FormRow label="PAN" error={errors.pan} help={PRIVACY}>
              <Input value={f.pan} maxLength={10} className="font-mono" aria-label="PAN" onChange={(e) => set({ pan: e.target.value.toUpperCase() })} />
            </FormRow>
            {!overseas && (
              <FormRow label="Tax Preference" required>
                <Radios name="Tax preference" slot="tax-preference" value={f.taxPreference}
                  options={[{ value: 'taxable', label: 'Taxable' }, { value: 'exempt', label: 'Tax Exempt' }]} onChange={(v) => set({ taxPreference: v })} />
              </FormRow>
            )}
            {!overseas && f.taxPreference === 'exempt' && (
              <FormRow label="Exemption Reason" required error={errors.taxExemptionReason}>
                <Input value={f.taxExemptionReason} onChange={(e) => set({ taxExemptionReason: e.target.value })} aria-label="Exemption Reason" placeholder="Why their supplies carry no tax" />
              </FormRow>
            )}
            <FormRow label="Currency">
              <Combobox options={currencies} value={f.currency} onChange={(v) => set({ currency: v || 'INR' })} showAvatar={false} searchPlaceholder="Search currencies" />
            </FormRow>
            {!editing && (
              <FormRow label="Opening Balance" help={side === 'customer' ? 'What they owed you before your books started. It is kept as an opening invoice dated the day before.' : 'What you owed them before your books started. It is kept as an opening bill dated the day before.'}>
                <div className="flex" data-slot="contact-opening">
                  <span className="grid h-[34px] place-items-center rounded-l-[var(--radius-button)] border border-r-0 bg-muted px-2.5 text-[13px] text-muted-foreground">{f.currency || 'INR'}</span>
                  <MoneyInput valuePaise={f.openingBalance} onChangePaise={(v) => set({ openingBalance: v })} className="rounded-l-none" />
                </div>
              </FormRow>
            )}
            <FormRow label="Payment Terms">
              <Combobox options={termsOptions()} value={f.paymentTerms} onChange={(v) => set({ paymentTerms: v || 'due_on_receipt' })} showAvatar={false} searchPlaceholder="Search" />
            </FormRow>
            {side === 'customer' && (
              <FormRow label="Price List">
                <Combobox options={priceChoices} value={f.priceListId} onChange={(v) => set({ priceListId: v })} placeholder="" showAvatar={false} clearable searchPlaceholder="Search" />
              </FormRow>
            )}
            {!editing && (
              <FormRow label="Enable Portal?" help={side === 'customer' ? 'A link they open to see their invoices and statement and to pay; it is emailed to them.' : 'A link they open to see their bills and payments; it is emailed to them.'}>
                <label className="flex h-[34px] cursor-pointer items-center gap-2 text-[13px]">
                  <input type="checkbox" className="size-3.5 accent-primary" checked={f.portal} onChange={(e) => set({ portal: e.target.checked })} data-slot="contact-portal" />
                  Allow portal access for this {side}
                </label>
              </FormRow>
            )}
            <FormRow label="Documents">
              {editing ? <Attachments targetType="contact" targetId={editing.id} canEdit title="" /> : (
                <div>
                  <input ref={fileInput} type="file" multiple className="hidden" onChange={(e) => { setPending([...pending, ...Array.from(e.target.files ?? [])].slice(0, 5)); e.target.value = ''; }} />
                  <Button type="button" variant="outline" size="sm" onClick={() => fileInput.current?.click()} disabled={pending.length >= 5}><Upload className="size-3.5" /> Upload File</Button>
                  <p className="mt-1 text-[11px] text-muted-foreground">You can upload a maximum of 5 files, 10MB each</p>
                  {pending.map((p, i) => (
                    <p key={`${p.name}${i}`} className="mt-1 flex items-center gap-2 text-[12px]">{p.name}
                      <button type="button" aria-label={`Remove ${p.name}`} onClick={() => setPending(pending.filter((_, j) => j !== i))}><X className="size-3" /></button>
                    </p>
                  ))}
                </div>
              )}
            </FormRow>
            {!moreDetails ? (
              <button type="button" className="text-[14px] text-link hover:underline" onClick={() => setMoreDetails(true)} data-slot="contact-more-details">Add more details</button>
            ) : (
              <div className="space-y-4" data-slot="contact-more-fields">
                <FormRow label="Website URL"><Input value={f.website} onChange={(e) => set({ website: e.target.value })} placeholder="ex: www.zylker.com" aria-label="Website URL" /></FormRow>
                <FormRow label="Department"><Input value={f.department} onChange={(e) => set({ department: e.target.value })} aria-label="Department" /></FormRow>
                <FormRow label="Designation"><Input value={f.designation} onChange={(e) => set({ designation: e.target.value })} aria-label="Designation" /></FormRow>
                <FormRow label="X"><PrefixInput prefix="https://x.com/" value={f.twitter} onChange={(e) => set({ twitter: e.target.value })} aria-label="X" /></FormRow>
                <FormRow label="Skype Name/Number"><Input value={f.skype} onChange={(e) => set({ skype: e.target.value })} aria-label="Skype Name/Number" /></FormRow>
                <FormRow label="Facebook"><PrefixInput prefix="http://www.facebook.com/" value={f.facebook} onChange={(e) => set({ facebook: e.target.value })} aria-label="Facebook" /></FormRow>
              </div>
            )}

            {/* Rekonza's own, after Zoho's. */}
            <div className="space-y-4 border-t pt-5" data-slot="contact-rekonza-details">
              {side === 'customer' && (
                <FormRow label="They buy" help="Their quotes, orders and invoices offer only these items.">
                  <div data-slot="customer-supplies"><SupplyKindPicker value={f.supplies} onChange={(v) => set({ supplies: v })} /></div>
                </FormRow>
              )}
              <FormRow label="Credit Limit" help="Invoices that take them beyond it are flagged.">
                <MoneyInput valuePaise={f.creditLimit} onChangePaise={(v) => set({ creditLimit: v })} />
              </FormRow>
              {!overseas && (
                <FormRow label={side === 'customer' ? 'TDS Sections' : 'TDS'} width="lg"
                  help={side === 'customer' ? 'The sections they deduct tax under when they pay you; it is tracked as TDS Receivable.' : 'The sections you deduct tax under when you pay them; the first is the default.'}>
                  <MultiCombobox options={TDS_SECTIONS.map((t) => ({ value: t.code, label: `${t.code} — ${t.description}`, sublabel: `${t.ratePctWithPan}% with PAN` }))}
                    value={f.tdsSections} onChange={(v) => set({ tdsSections: v })} placeholder={side === 'customer' ? 'They do not deduct TDS' : 'No TDS'} searchPlaceholder="Search sections" />
                </FormRow>
              )}
              {side === 'customer' && (
                <FormRow label="Account Owner" help="Their overdue invoices and credit risks are raised to this person.">
                  <select className={selectCls} value={f.ownerUserId} onChange={(e) => set({ ownerUserId: e.target.value })} aria-label="Account Owner">
                    <option value="">No one</option>
                    {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                  </select>
                </FormRow>
              )}
              {!overseas && (
                <>
                  <FormRow label="Kind of Business"><KindOfBusinessSelect value={f.constitution} onChange={(v) => set({ constitution: v })} /></FormRow>
                  <FormRow label="GST Registered On" error={errors.gstRegisteredOn} hint={f.gstStatus ? `Registration is ${f.gstStatus}` : undefined}>
                    <Input type="date" value={f.gstRegisteredOn} onChange={(e) => set({ gstRegisteredOn: e.target.value })} aria-label="GST Registered On" />
                  </FormRow>
                  <FormRow label="CIN" error={errors.cin} help="A company's or LLP's identity number. Its incorporation date is read from it.">
                    <div className="flex gap-2">
                      <Input value={f.cin} maxLength={21} className="font-mono" aria-label="CIN" onChange={(e) => set({ cin: e.target.value.toUpperCase() })} placeholder="U74999TN2015PTC123456" />
                      <CinLookupButton cin={f.cin} auto={f.cin !== s(editing?.cin)} onFound={(d) => set({
                        ...(d.incorporatedOn ? { incorporatedOn: d.incorporatedOn } : {}),
                        ...(!f.constitution && d.kind ? { constitution: companyTypeFrom(d.kind) ?? d.kind } : {}),
                      })} />
                    </div>
                  </FormRow>
                  <FormRow label="Incorporated On" error={errors.incorporatedOn}>
                    <Input type="date" value={f.incorporatedOn} onChange={(e) => set({ incorporatedOn: e.target.value })} aria-label="Incorporated On" />
                  </FormRow>
                </>
              )}
              {side === 'vendor' && (
                <>
                  <FormRow label="MSME Registered?" help="A micro or small enterprise must be paid within the agreed period, at most 45 days, or interest runs.">
                    <label className="flex h-[34px] cursor-pointer items-center gap-2 text-[13px]">
                      <input type="checkbox" className="size-3.5 accent-primary" checked={f.isMsme} onChange={(e) => set({ isMsme: e.target.checked })} data-slot="vendor-msme" />
                      This vendor is MSME registered
                    </label>
                  </FormRow>
                  {f.isMsme && (
                    <>
                      <FormRow label="MSME/Udyam Registration Type">
                        <select className={selectCls} value={f.msmeCategory} onChange={(e) => set({ msmeCategory: e.target.value })} aria-label="MSME category">
                          <option value="">Select the type</option>
                          <option value="micro">Micro</option><option value="small">Small</option><option value="medium">Medium</option>
                        </select>
                      </FormRow>
                      <FormRow label="MSME/Udyam Registration Number"><Input value={f.msmeUdyamNo} onChange={(e) => set({ msmeUdyamNo: e.target.value })} placeholder="UDYAM-XX-00-0000000" aria-label="Udyam number" /></FormRow>
                      <FormRow label="Activity">
                        <select className={selectCls} value={f.msmeActivity} onChange={(e) => set({ msmeActivity: e.target.value })} aria-label="MSME activity">
                          <option value="">Select</option>
                          <option value="manufacturing">Manufacturing</option><option value="services">Services</option><option value="trading">Trading</option>
                        </select>
                      </FormRow>
                      <FormRow label="Credit Period Agreed" error={errors.msmeAgreementDays} hint="Days, at most 45. Empty when there is no written agreement: the limit is then 15 days.">
                        <Input inputMode="numeric" value={f.msmeAgreementDays} onChange={(e) => set({ msmeAgreementDays: e.target.value.replace(/\D/g, '') })} aria-label="Credit period agreed" />
                      </FormRow>
                    </>
                  )}
                </>
              )}
            </div>
          </div>
        )}

        {tab === 'address' && (
          <div>
            <div className="flex flex-col gap-10 xl:flex-row">
              {addressColumn('billing')}
              {addressColumn('shipping')}
            </div>
            <div className="mt-8 max-w-3xl border-l-2 border-warning bg-warning/5 px-4 py-3 text-[13px]">
              <p className="font-medium">Note:</p>
              <ul className="ml-4 list-disc space-y-0.5">
                <li>Add and manage additional addresses from this {noun}&apos;s details section.</li>
                <li>The billing address is printed on their invoices; the shipping address where goods go elsewhere.</li>
              </ul>
            </div>
          </div>
        )}

        {tab === 'persons' && (
          <div data-slot="contact-persons-table">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[860px] border-collapse text-[13px]">
                <thead>
                  <tr className="border-b bg-table-head text-left text-[11px] uppercase text-muted-foreground">
                    {['Salutation', 'First Name', 'Last Name', 'Email Address', 'Work Phone', 'Mobile', ''].map((h) => <th key={h} className="border-r px-3 py-2 font-medium last:border-r-0">{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {shownRows.map((p, i) => {
                    const upd = (patch: Partial<PersonDraft>) => setRows(shownRows.map((x, j) => (j === i ? { ...x, ...patch } : x)));
                    const cell = 'h-[34px] w-full border-0 bg-transparent px-3 text-[13px] outline-none focus:ring-1 focus:ring-primary';
                    return (
                      <tr key={p.key} className="border-b" data-slot="contact-person-row">
                        <td className="w-[130px] border-r">
                          <select className={cell} value={p.salutation} onChange={(e) => upd({ salutation: e.target.value })} aria-label="Salutation">
                            <option value="" />
                            {SALUTATIONS.map((x) => <option key={x} value={x}>{x}</option>)}
                          </select>
                        </td>
                        <td className="border-r"><input className={cell} value={p.firstName} onChange={(e) => upd({ firstName: e.target.value })} aria-label="First name" /></td>
                        <td className="border-r"><input className={cell} value={p.lastName} onChange={(e) => upd({ lastName: e.target.value })} aria-label="Last name" /></td>
                        <td className="border-r"><input className={cell} type="email" value={p.email} onChange={(e) => upd({ email: e.target.value })} aria-label="Email address" /></td>
                        <td className="border-r"><input className={cell} value={p.phone} onChange={(e) => upd({ phone: e.target.value })} aria-label="Work phone" /></td>
                        <td className="border-r"><input className={cell} value={p.mobile} onChange={(e) => upd({ mobile: e.target.value })} aria-label="Mobile" /></td>
                        <td className="w-10 text-center">
                          <button type="button" aria-label="Delete contact person" className="text-muted-foreground hover:text-destructive" onClick={() => setRows(shownRows.filter((_, j) => j !== i))}><Trash2 className="size-3.5" /></button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <button type="button" onClick={() => setRows([...shownRows, blankPerson()])} data-slot="add-contact-person"
              className="mt-4 inline-flex items-center gap-1.5 rounded-[var(--radius-button)] bg-muted px-3 py-1.5 text-[13px] hover:bg-muted/80">
              <PlusCircle className="size-4 text-primary" /> Add Contact Person
            </button>
          </div>
        )}

        {tab === 'bank' && side === 'vendor' && (
          <div className="max-w-[760px] space-y-4" data-slot="vendor-bank">
            <FormRow label="Account Holder Name"><Input value={f.bankAccountName} onChange={(e) => set({ bankAccountName: e.target.value })} aria-label="Account Holder Name" /></FormRow>
            <FormRow label="Bank Name"><Input value={f.bankName} onChange={(e) => set({ bankName: e.target.value })} aria-label="Bank Name" /></FormRow>
            <FormRow label="Account Number" error={errors.bankAccountNo} hint={editing?.bankAccountNo ? `On file: ${editing.bankAccountNo}. Type a new one to change it.` : undefined}>
              <Input value={f.bankAccountNo === editing?.bankAccountNo ? '' : f.bankAccountNo} className="font-mono" aria-label="Account Number" onChange={(e) => set({ bankAccountNo: e.target.value.replace(/\s/g, '') })} />
            </FormRow>
            <FormRow label="IFSC" error={errors.bankIfsc}><Input value={f.bankIfsc} maxLength={11} className="font-mono" aria-label="IFSC" onChange={(e) => set({ bankIfsc: e.target.value.toUpperCase() })} /></FormRow>
          </div>
        )}

        {tab === 'custom' && (
          <div className="max-w-[760px] space-y-4" data-slot="contact-custom-fields">
            {defs.length ? defs.map((d) => {
              const v = customValue(d.key) ?? '';
              const put = (val: string | null) => setCustom({ ...(custom ?? Object.fromEntries((fieldValues.data?.values ?? []).map((x) => [x.key, x.value]))), [d.key]: val });
              return (
                <FormRow key={d.id} label={d.label} required={d.required}>
                  {d.type === 'checkbox' ? (
                    <input type="checkbox" className="mt-2.5 size-3.5 accent-primary" checked={v === 'true'} onChange={(e) => put(e.target.checked ? 'true' : 'false')} aria-label={d.label} />
                  ) : d.type === 'select' ? (
                    <select className={selectCls} value={v} onChange={(e) => put(e.target.value || null)} aria-label={d.label}>
                      <option value="" />
                      {d.options.map((o) => <option key={o} value={o}>{o}</option>)}
                    </select>
                  ) : (
                    <Input type={d.type === 'number' ? 'number' : d.type === 'date' ? 'date' : 'text'} value={v} onChange={(e) => put(e.target.value || null)} aria-label={d.label} />
                  )}
                </FormRow>
              );
            }) : (
              <p className="text-[13px] text-muted-foreground" data-slot="custom-fields-empty">
                Start adding custom fields for your Customers and Vendors by going to <Link href="/settings/custom-fields" className="text-link hover:underline">Settings ➡ Custom Fields</Link>.
              </p>
            )}
          </div>
        )}

        {tab === 'tags' && (
          <div className="max-w-[760px] space-y-4" data-slot="contact-reporting-tags">
            {tags.length ? tags.map((t) => (
              <FormRow key={t.id} label={t.name}>
                <select className={selectCls} value={tagValue(t.id)} aria-label={t.name}
                  onChange={(e) => setTagValues({ ...(tagValues ?? tagState.data?.values ?? {}), [t.id]: e.target.value })}>
                  <option value="">None</option>
                  {t.options.filter((o) => o.isActive || o.id === tagValue(t.id)).map((o) => <option key={o.id} value={o.id}>{o.value}</option>)}
                </select>
              </FormRow>
            )) : (
              <p className="text-[13px] text-muted-foreground">There are no reporting tags yet. <Link href="/settings/reporting-tags" className="text-link hover:underline">Create one in Settings</Link>.</p>
            )}
          </div>
        )}

        {tab === 'remarks' && (
          <div className="max-w-[760px]" data-slot="contact-remarks-field">
            <label className="mb-2 block text-[13px]">Remarks <span className="text-muted-foreground">(For Internal Use)</span></label>
            <Textarea rows={5} value={f.notes} onChange={(e) => set({ notes: e.target.value })} aria-label="Remarks" maxLength={1000} />
          </div>
        )}
      </div>

      <Dialog open={prefill} onOpenChange={setPrefill}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Prefill from the GST portal</DialogTitle>
            <DialogDescription>Type the {noun.toLowerCase()}&apos;s GSTIN: their registered names, address, state and PAN are filled in.</DialogDescription>
          </DialogHeader>
          <div className="flex gap-2">
            <Input value={prefillGstin} maxLength={15} className="font-mono" aria-label="GSTIN to prefill from" placeholder="22AAAAA0000A1Z5"
              onChange={(e) => setPrefillGstin(e.target.value.toUpperCase().replace(/\s/g, ''))} />
            <GstinLookupButton gstin={prefillGstin} onFound={(d) => { found(d); setPrefill(false); setTab('other'); }} />
          </div>
          <GstinNumberOnlyNote details={lookup} gstin={prefillGstin} />
          <DialogFooter><Button variant="outline" onClick={() => setPrefill(false)}>Cancel</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </DocumentForm>
  );
}
