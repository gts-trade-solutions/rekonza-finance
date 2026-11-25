'use client';

// ─────────────────────────────────────────────────────────────────────────────
// A customer (or vendor), as Zoho Books opens it beside the list, recorded
// from Zoho's own demo and copied to the word.
//
// Header: the name, then "Edit", the paperclip and "More ▾" (Configure
// Customer Portal, Add Bank Account, Link to Vendor, Clone, Merge Customers,
// Mark as Inactive, Delete), and the X. An inactive customer shows "Mark as
// Active", the paperclip and "Delete" instead.
// Tabs:
//   Overview      left: the contact card and the sections Remarks, Address,
//                 Other Details, Contact Persons, Bank Account Details,
//                 Associate Tags, Record Info. Right: the GSTIN request,
//                 "Payment due period" (with its pencil), Receivables, and the
//                 Income chart (This Fiscal Year, Previous Fiscal Year, Last
//                 12 Months, Last 6 Months; Accrual or Cash).
//   Comments      a box with Bold, Italic and Underline, "Add Comment", and
//                 ALL COMMENTS.
//   Transactions  "Go to transactions" and a section per kind of document in
//                 Zoho's order, each with Zoho's columns and "Status:" list.
//   Mails         System Mails, ten to a page.
//   Statement     the period (This Month first), Filter By All/Outstanding,
//                 print, PDF, Excel and Send Email, and the statement itself.
// What Rekonza keeps that Zoho has not (TDS, MSME, credit limit, registration
// details, custom fields, other addresses) sits in the same sections.
// ─────────────────────────────────────────────────────────────────────────────

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { Bar, BarChart, ResponsiveContainer, Tooltip as ChartTooltip, XAxis, YAxis } from 'recharts';
import {
  Bold, Building2, Calendar, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, FileSpreadsheet, FileText, Filter, Italic,
  Mail, Paperclip, Pencil, Plus, Printer, Underline, User,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Combobox } from '@/components/ui/combobox';
import { Money } from '@/components/shared/money';
import { StatusBadge } from '@/components/shared/status-badge';
import { AsyncPage, LoadingRows } from '@/components/shared/async-state';
import { Attachments } from '@/components/shared/attachments';
import { CustomFieldsPanel } from '@/components/shared/custom-fields-panel';
import { PortalAccess } from '@/components/shared/portal-access';
import { ContactAddresses } from '@/components/shared/contact-addresses';
import { ContactPersonActions } from '@/components/contacts/contact-person-actions';
import { MergeContactButton } from '@/components/shared/merge-contact';
import { statementSheet } from '@/components/shared/party-statement';
import { StatementPrint } from '@/components/print/statement-print';
import { refreshSplitList, useSplitRecordRefresh } from '@/components/shared/record-split';
import { usePublishPageTitle } from '@/components/layout/page-context';
import {
  api, comments as commentsApi, contactActivity, contactPersons, contacts,
  type ContactDetail, type ContactPerson, type ContactRow, type ContactTxKind, type ContactTxRow, type IncomePeriod, type PartyStatement,
} from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';
import { useAppStore } from '@/lib/store';
import { stateName } from '@/lib/tax/gst';
import { PAYMENT_TERMS, termsOptions } from '@/lib/options';
import { PRESETS } from '@/lib/date-range';
import { today as todayIso } from '@/lib/selectors';
import { GST_TREATMENTS } from '@/components/contacts/contact-form';
import { formatINR, formatINRCompact } from '@/lib/money';
import { downloadWorkbook } from '@/lib/xlsx';
import { cn } from '@/lib/utils';

type Side = 'customer' | 'vendor';
type Detail = ContactDetail['contact'];

const TERMS: Record<string, string> = Object.fromEntries(PAYMENT_TERMS.map((x) => [x.value, x.label]));
const TREATMENT: Record<string, string> = Object.fromEntries(GST_TREATMENTS.map((x) => [x.value, x.label]));
const day = (d: string | null | undefined) => (d ? new Date(`${d.slice(0, 10)}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '');
const stamp = (d: string) => new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const titleCase = (x: string) => x.replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
const iconBtn = 'grid h-[33px] w-9 place-items-center rounded-[var(--radius-button)] border border-secondary-border bg-secondary hover:brightness-[0.98]';

/** One of Zoho's collapsible sections in the left column: a caps heading with a chevron. */
function Section({ title, children, slot, defaultOpen = true, action }: { title: string; children: ReactNode; slot?: string; defaultOpen?: boolean; action?: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="border-t px-5 py-3" data-slot={slot}>
      <div className="flex items-center justify-between gap-2">
        <button type="button" onClick={() => setOpen((o) => !o)} className="flex flex-1 items-center justify-between text-left text-[12px] font-medium uppercase tracking-wide text-foreground/80" aria-expanded={open}>
          {title}
          {open ? <ChevronUp className="size-3.5 text-primary" /> : <ChevronDown className="size-3.5 text-primary" />}
        </button>
        {action}
      </div>
      {open && <div className="mt-2.5 text-[13px]">{children}</div>}
    </section>
  );
}

/** A label and its value, as Zoho's Other Details reads; Zoho leaves an empty one out. */
function Row({ label, children, keep = false }: { label: string; children: ReactNode; keep?: boolean }) {
  if (!keep && (children === null || children === undefined || children === '' || children === false)) return null;
  return (
    <div className="grid grid-cols-[130px_1fr] gap-2 py-1" data-slot="contact-detail-row">
      <dt className="text-[12px] text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-[13px]">{children}</dd>
    </div>
  );
}

function Address({ title, lines, editHref }: { title: string; lines: (string | null | undefined)[]; editHref?: string }) {
  const shown = lines.filter(Boolean);
  return (
    <div className="mb-3">
      <div className="flex items-center justify-between">
        <p className="text-[12px] text-muted-foreground">{title}</p>
        {editHref && <Link href={editHref} aria-label={`Edit ${title}`} title="Edit the Address" className="text-muted-foreground hover:text-foreground"><Pencil className="size-3" /></Link>}
      </div>
      {shown.length ? <div className="mt-1 space-y-0.5">{shown.map((l, i) => <p key={i} className={i === 0 ? 'font-medium' : ''}>{l}</p>)}</div>
        : <p className="mt-1 text-muted-foreground">No {title} - <Link href={editHref ?? '#'} className="text-link hover:underline">New Address</Link></p>}
    </div>
  );
}

/**
 * Zoho's address block: attention, the two street lines, the city, the state
 * and PIN, the country, phone and fax. An address typed before the parts had
 * boxes of their own holds the city and PIN in its street line; they are not
 * said twice.
 */
function addressLines(...[attention, street1, street2, city, state, pincode, country, phone, fax]: (string | null | undefined)[]) {
  const street = `${street1 ?? ''} ${street2 ?? ''}`.toLowerCase();
  const fresh = (v: string | null | undefined) => (v && !street.includes(v.toLowerCase()) ? v : null);
  return [attention, street1, street2, fresh(city), [fresh(state), fresh(pincode)].filter(Boolean).join(' '), country, phone && `Phone: ${phone}`, fax && `Fax Number: ${fax}`];
}

/** Zoho's pages under a table: "Total Count: View", the page size and the arrows. */
function Pager({ total, page, size, setPage, setSize }: { total: number; page: number; size: number; setPage: (p: number) => void; setSize: (s: number) => void }) {
  const [shown, setShown] = useState(false);
  const from = total ? page * size + 1 : 0;
  const to = Math.min(total, (page + 1) * size);
  return (
    <div className="flex items-center justify-end gap-3 px-4 py-2 text-[12px] text-muted-foreground" data-slot="pager">
      <span>Total Count: {shown ? <span className="text-foreground" data-slot="pager-total">{total}</span> : <button type="button" className="text-link hover:underline" onClick={() => setShown(true)}>View</button>}</span>
      <select value={size} onChange={(e) => { setSize(Number(e.target.value)); setPage(0); }} aria-label="Per page" className="rounded border bg-transparent px-1 py-0.5 outline-none">
        {[10, 25, 50, 100].map((n) => <option key={n} value={n}>{n} per page</option>)}
      </select>
      <span className="flex items-center gap-1">
        <button type="button" aria-label="Previous Page" disabled={page === 0} onClick={() => setPage(page - 1)} className="disabled:opacity-40"><ChevronLeft className="size-4" /></button>
        <span>{from} - {to}</span>
        <button type="button" aria-label="Next Page" disabled={to >= total} onClick={() => setPage(page + 1)} className="disabled:opacity-40"><ChevronRight className="size-4" /></button>
      </span>
    </div>
  );
}

// ── The Overview ────────────────────────────────────────────────────────────

const PERIODS: [IncomePeriod, string][] = [['this_fy', 'This Fiscal Year'], ['prev_fy', 'Previous Fiscal Year'], ['last_12', 'Last 12 Months'], ['last_6', 'Last 6 Months']];

function IncomeChart({ id, side }: { id: string; side: Side }) {
  const [period, setPeriod] = useState<IncomePeriod>('last_6');
  const [basis, setBasis] = useState<'accrual' | 'cash'>('accrual');
  const state = useApi(() => contactActivity.income(id, side, period, basis), [id, side, period, basis]);
  const data = (state.data?.months ?? []).map((m) => ({
    month: new Date(`${m.month}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' }),
    amount: m.amountPaise / 100,
  }));
  const total = (state.data?.months ?? []).reduce((t, m) => t + m.amountPaise, 0);
  const waiting = state.loading && !state.data;
  const label = PERIODS.find(([v]) => v === period)?.[1] ?? '';
  const word = side === 'customer' ? 'Income' : 'Expenses';
  return (
    <div className="space-y-2" data-slot="contact-income">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[15px]">{word} <span className="text-[12px] text-muted-foreground">This chart is displayed in the {side}&apos;s currency (INR).</span></p>
        <div className="flex items-center gap-2 text-[12px]">
          <DropdownMenu>
            <DropdownMenuTrigger className="inline-flex items-center gap-0.5 text-link outline-none" data-slot="income-period">{label} <ChevronDown className="size-3" /></DropdownMenuTrigger>
            <DropdownMenuContent align="end">{PERIODS.map(([v, l]) => <DropdownMenuItem key={v} onClick={() => setPeriod(v)}>{l}</DropdownMenuItem>)}</DropdownMenuContent>
          </DropdownMenu>
          <span className="text-muted-foreground">|</span>
          <DropdownMenu>
            <DropdownMenuTrigger className="inline-flex items-center gap-0.5 text-link outline-none" data-slot="income-basis">{basis === 'accrual' ? 'Accrual' : 'Cash'} <ChevronDown className="size-3" /></DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setBasis('accrual')}>Accrual</DropdownMenuItem>
              <DropdownMenuItem onClick={() => setBasis('cash')}>Cash</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <div className="h-44">
        {waiting ? <div className="h-full animate-pulse rounded bg-muted/60" /> : (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
              <XAxis dataKey="month" tick={{ fontSize: 10 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 10 }} axisLine={false} tickLine={false} width={44} tickFormatter={(v) => formatINRCompact(Number(v) * 100)} />
              <ChartTooltip formatter={(v) => formatINR(Number(v) * 100)} />
              <Bar dataKey="amount" fill="#8bc34a" radius={[2, 2, 0, 0]} maxBarSize={22} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
      {!waiting && <p className="text-[13px]" data-slot="income-total">Total {word} ( {label} ) - <span className="font-medium">{formatINR(total)}</span></p>}
    </div>
  );
}

/** "Payment due period", with Zoho's pencil to change the terms where they show. */
function PaymentDue({ c, canEdit, onChanged }: { c: Detail; canEdit: boolean; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [terms, setTerms] = useState(c.paymentTerms || 'due_on_receipt');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await contacts.update({ id: c.id, paymentTerms: terms, expectedUpdatedAt: c.updatedAt });
      toast.success('Payment terms updated');
      setEditing(false);
      onChanged();
    } catch (e) {
      toast.error('Not saved', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div data-slot="contact-payment-due">
      <p className="text-[13px] text-muted-foreground">Payment due period</p>
      {editing ? (
        <div className="mt-1 flex max-w-sm items-center gap-2">
          <div className="flex-1"><Combobox options={termsOptions()} value={terms} onChange={(v) => setTerms(v || 'due_on_receipt')} showAvatar={false} searchPlaceholder="Search" /></div>
          <Button size="sm" disabled={busy} onClick={() => void save()} data-slot="payment-due-save">Save</Button>
          <Button size="sm" variant="outline" onClick={() => setEditing(false)}>Cancel</Button>
        </div>
      ) : (
        <p className="group flex items-center gap-2 text-[14px]">
          {TERMS[c.paymentTerms ?? ''] ?? c.paymentTerms ?? 'Due on Receipt'}
          {canEdit && <button type="button" title="Edit" aria-label="Edit the payment terms" onClick={() => setEditing(true)} className="text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100" data-slot="payment-due-edit"><Pencil className="size-3" /></button>}
        </p>
      )}
    </div>
  );
}

function Overview({ d, side, canEdit, onChanged }: { d: ContactDetail; side: Side; canEdit: boolean; onChanged: () => void }) {
  const c = d.contact;
  const base = side === 'customer' ? '/sales/customers' : '/purchases/vendors';
  const persons = useApi<{ persons: ContactPerson[] }>(() => contactPersons.list(c.id), [c.id]);
  const tags = useApi(() => api.get<{ tags: { id: string; name: string; options: { id: string; value: string }[] }[]; values: Record<string, string> }>('/api/reporting-tags', { entity: 'contact', id: c.id }), [c.id]);
  const users = useAppStore((s) => s.users);
  const primary = [c.salutation, c.firstName, c.lastName].filter(Boolean).join(' ');
  const owed = side === 'customer' ? d.summary.receivablePaise : d.summary.payablePaise;
  const unused = (side === 'customer' ? d.summary.unusedCreditsPaise : d.summary.vendorUnusedCreditsPaise) ?? 0;
  const tagValues = (tags.data?.tags ?? []).flatMap((t) => {
    const v = tags.data?.values?.[t.id];
    const o = v ? t.options.find((x) => x.id === v) : undefined;
    return o ? [{ tag: t.name, value: o.value }] : [];
  });
  const socials = [c.twitter && `X: ${c.twitter}`, c.facebook && `Facebook: ${c.facebook}`, c.skype && `Skype: ${c.skype}`].filter(Boolean).join(' · ');
  const other = side === 'customer' ? 'Vendor' : 'Customer';
  return (
    <div className="flex flex-col lg:flex-row" data-slot="contact-overview">
      <aside className="w-full shrink-0 border-r bg-[#fbfbfd] dark:bg-muted/30 lg:w-[300px]">
        <div className="m-3 space-y-1 rounded-[var(--radius-card)] bg-[#f4f4f8] px-4 py-3 dark:bg-muted" data-slot="contact-card">
          <p className="border-b pb-2 text-[14px] font-medium">{c.legalName || c.displayName}</p>
          {primary || c.email || c.phone || c.mobile ? (
            <div className="flex gap-3 pt-1 text-[13px]">
              <span className="grid size-9 shrink-0 place-items-center rounded-full bg-background text-muted-foreground"><User className="size-4" /></span>
              <div className="min-w-0 space-y-0.5 text-muted-foreground">
                {primary && <p className="font-medium text-foreground">{primary}</p>}
                {c.email && <p className="truncate">{c.email}</p>}
                {c.phone && <p>{c.phone}</p>}
                {c.mobile && <p>{c.mobile}</p>}
              </div>
            </div>
          ) : (
            <p className="pt-1 text-center text-[13px] text-muted-foreground">There is no primary contact information. {canEdit && <Link href={`${base}/${c.id}/edit`} className="text-link hover:underline">Add New</Link>}</p>
          )}
        </div>
        <Section title="Remarks" slot="contact-remarks">
          {c.notes ? <p className="whitespace-pre-line">{c.notes}</p> : <p className="text-muted-foreground">No remarks.</p>}
        </Section>
        <Section title="Address" slot="contact-address">
          <Address title="Billing Address" editHref={canEdit ? `${base}/${c.id}/edit?tab=address` : undefined}
            lines={addressLines(c.billingAttention, c.billingAddress, c.billingStreet2, c.billingCity, c.billingState, c.billingPincode, c.billingCountry, c.billingPhone, c.billingFax)} />
          <Address title="Shipping Address" editHref={canEdit ? `${base}/${c.id}/edit?tab=address` : undefined}
            lines={addressLines(c.shippingAttention, c.shippingAddress, c.shippingStreet2, c.shippingCity, c.shippingState, c.shippingPincode, c.shippingCountry, c.shippingPhone, c.shippingFax)} />
          <ContactAddresses contactId={c.id} canEdit={canEdit} compact />
        </Section>
        <Section title="Other Details" slot="contact-other">
          {/* Zoho's rows in Zoho's order; an empty one is left out, as Zoho leaves it. */}
          <dl>
            {side === 'customer' && <Row label="Customer Type">{c.contactType === 'individual' ? 'Individual' : 'Business'}</Row>}
            <Row label="Default Currency">{c.currency ?? 'INR'}</Row>
            {side === 'customer' && <Row label="Price List">{c.priceListLabel}</Row>}
            <Row label="GST Treatment">{TREATMENT[c.gstTreatment] ?? titleCase(c.gstTreatment)}</Row>
            <Row label="GSTIN">{c.gstin}</Row>
            <Row label="Business Legal Name">{c.businessLegalName}</Row>
            <Row label="Business Trade Name">{c.businessTradeName}</Row>
            {c.gstTreatment !== 'overseas' && <Row label={side === 'customer' ? 'Place of Supply' : 'Source of Supply'} keep>{c.stateCode && c.stateCode !== '96' ? stateName(c.stateCode) : 'Yet to be updated'}</Row>}
            {side === 'customer' && c.gstTreatment !== 'overseas' && <Row label="Tax Preference">{c.taxPreference === 'exempt' ? `Tax Exempt${c.taxExemptionReason ? ` (${c.taxExemptionReason})` : ''}` : 'Taxable'}</Row>}
            <Row label="Portal Status">{c.portalEnabled ? 'Enabled' : 'Disabled'}</Row>
            <Row label={side === 'customer' ? 'Customer Language' : 'Vendor Language'}>{c.language ?? 'English'}</Row>
            <Row label="Social Networks">{socials}</Row>
            <Row label="Website URL">{c.website ? <a href={/^https?:/.test(c.website) ? c.website : `https://${c.website}`} target="_blank" rel="noreferrer" className="text-link hover:underline">{c.website}</a> : null}</Row>
            {c.linked && <Row label={`Linked ${other}`}><Link href={`${c.linked.kind === 'vendor' ? '/purchases/vendors' : '/sales/customers'}/${c.linked.id}`} className="text-link hover:underline">{c.linked.displayName}</Link></Row>}
            {/* Rekonza's own. */}
            <Row label="PAN">{c.pan || (c.gstin && c.gstin.length === 15 ? c.gstin.slice(2, 12) : '')}</Row>
            <Row label="Credit Limit">{c.creditLimitPaise > 0 ? formatINR(c.creditLimitPaise) : null}</Row>
            <Row label="TDS Sections">{c.tdsSections?.length ? c.tdsSections.join(', ') : null}</Row>
            <Row label="MSME">{c.isMsme ? [c.msmeCategory, c.msmeUdyamNo].filter(Boolean).join(' · ') || 'Yes' : null}</Row>
            <Row label="Kind of Business">{c.constitution}</Row>
            <Row label="GST Registered On">{c.gstRegisteredOn ? day(c.gstRegisteredOn) : null}</Row>
            <Row label="CIN">{c.cin}</Row>
            <Row label="Department">{c.department}</Row>
            <Row label="Designation">{c.designation}</Row>
            <Row label="Account Owner">{c.ownerUserId ? users.find((u) => u.id === c.ownerUserId)?.name : null}</Row>
          </dl>
          <CustomFieldsPanel entity="contact" id={c.id} canEdit={canEdit} className="mt-2" />
        </Section>
        <Section title="Contact Persons" slot="contact-persons"
          action={canEdit ? <Link href={`${base}/${c.id}/edit?tab=persons`} aria-label="Add a contact person" className="grid size-5 place-items-center rounded-full bg-primary text-primary-foreground"><Plus className="size-3" /></Link> : undefined}>
          {(persons.data?.persons ?? []).length ? (
            <ul className="space-y-2">
              {persons.data!.persons.map((p) => (
                <li key={p.id} className="flex items-start gap-2" data-slot="contact-person">
                  <User className="mt-0.5 size-3.5 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{[p.salutation, p.name].filter(Boolean).join(' ')}{p.isPrimary && <span className="ml-1 text-[11px] text-muted-foreground">(Primary)</span>}</span>
                    {[p.email, p.phone, p.mobile].filter(Boolean).map((x) => <span key={x} className="block text-[12px] text-muted-foreground">{x}</span>)}
                    {/* Zoho's Edit and Delete on each person, as buttons with their words. */}
                    {canEdit && <ContactPersonActions contactId={c.id} person={p} onChanged={() => void persons.refetch()} />}
                  </span>
                </li>
              ))}
            </ul>
          ) : <p className="text-muted-foreground">No contact persons found.</p>}
        </Section>
        <Section title="Bank Account Details" slot="contact-bank">
          {c.bankAccountNo || c.bankName ? (
            <dl>
              <Row label="Account Holder">{c.bankAccountName}</Row>
              <Row label="Bank Name">{c.bankName}</Row>
              <Row label="Account Number">{c.bankAccountNo}</Row>
              <Row label="IFSC">{c.bankIfsc}</Row>
            </dl>
          ) : <p className="text-muted-foreground">No bank account added yet</p>}
        </Section>
        <Section title="Associate Tags" slot="contact-tags">
          {tagValues.length ? (
            <div className="flex flex-wrap gap-1.5">{tagValues.map((t) => <span key={t.tag} className="rounded bg-muted px-2 py-0.5 text-[12px]">{t.tag}: {t.value}</span>)}</div>
          ) : <p className="text-muted-foreground">Associate reporting tags to easily filter your contacts in reports</p>}
        </Section>
        <Section title="Record Info" slot="contact-record-info" defaultOpen={false}>
          <dl>
            <Row label={side === 'customer' ? 'Customer ID' : 'Vendor ID'}>{c.id}</Row>
            <Row label="Created On">{c.createdAt ? stamp(c.createdAt) : ''}</Row>
            <Row label="Last Modified">{c.updatedAt ? stamp(c.updatedAt) : ''}</Row>
          </dl>
        </Section>
      </aside>

      <div className="min-w-0 flex-1 space-y-6 px-6 py-5">
        {!c.gstin && c.gstTreatment !== 'overseas' && (
          <p className="text-[13px] text-muted-foreground" data-slot="gstin-request">You can request your contact to directly update the GSTIN by sending an email.{' '}
            <a className="text-link hover:underline" href={`mailto:${c.email ?? ''}?subject=${encodeURIComponent('Please share your GSTIN')}`}>Send email</a>
          </p>
        )}
        <PaymentDue c={c} canEdit={canEdit && !c.isArchived} onChanged={onChanged} />
        <div data-slot="contact-receivables">
          <h3 className="mb-2 text-[17px]">{side === 'customer' ? 'Receivables' : 'Payables'}</h3>
          <table className="w-full max-w-xl border-collapse text-[13px]">
            <thead>
              <tr className="bg-table-head text-left text-[11px] uppercase text-muted-foreground">
                <th className="px-3 py-2 font-normal">Currency</th>
                <th className="px-3 py-2 text-right font-normal">Outstanding {side === 'customer' ? 'Receivables' : 'Payables'}</th>
                <th className="px-3 py-2 text-right font-normal">Unused Credits</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b">
                <td className="px-3 py-2.5">INR- Indian Rupee</td>
                <td className="px-3 py-2.5 text-right"><Money value={owed} className="text-link" /></td>
                <td className="px-3 py-2.5 text-right"><Money value={unused} className="text-link" /></td>
              </tr>
              <tr className="font-medium">
                <td className="px-3 py-2.5">TOTAL (INR)</td>
                <td className="px-3 py-2.5 text-right" data-slot="contact-owed"><Money value={owed} /></td>
                <td className="px-3 py-2.5 text-right" data-slot="contact-unused"><Money value={unused} /></td>
              </tr>
            </tbody>
          </table>
          {c.linked && (
            <p className="mt-2 text-[13px]" data-slot="linked-open">
              Linked {other.toLowerCase()} <Link href={`${c.linked.kind === 'vendor' ? '/purchases/vendors' : '/sales/customers'}/${c.linked.id}`} className="text-link hover:underline">{c.linked.displayName}</Link>:{' '}
              {side === 'customer' ? 'payables' : 'receivables'} <Money value={side === 'customer' ? c.linked.payablePaise : c.linked.receivablePaise} className="font-medium" />
            </p>
          )}
        </div>
        <IncomeChart id={c.id} side={side} />
      </div>
    </div>
  );
}

// ── Transactions ────────────────────────────────────────────────────────────

interface Col { head: string; right?: boolean; cell: (r: ContactTxRow) => ReactNode }
interface TxSection { kind: ContactTxKind; label: string; statuses: string[] | null; cols: Col[]; newHref?: string; open?: boolean }

function num(href: (r: ContactTxRow) => string): Col['cell'] {
  return function NumberCell(r) { return <Link href={href(r)} className="text-link hover:underline">{r.number}</Link>; };
}
const dash = (v: unknown) => (v === null || v === undefined || v === '' ? '-' : String(v));
const C = {
  date: (head = 'Date'): Col => ({ head, cell: (r) => day(r.date) }),
  ref: (head = 'Reference Number'): Col => ({ head, cell: (r) => dash(r.ref) }),
  amount: (head = 'Amount'): Col => ({ head, right: true, cell: (r) => <Money value={r.amountPaise} /> }),
  balance: (head = 'Balance Due'): Col => ({ head, right: true, cell: (r) => (r.balancePaise === null ? '-' : <Money value={r.balancePaise} />) }),
  status: (): Col => ({ head: 'Status', cell: (r) => <StatusBadge status={r.status} className="capitalize" /> }),
  extraDate: (head: string, key: string): Col => ({ head, cell: (r) => (r.extra?.[key] ? day(String(r.extra[key])) : '-') }),
  extraText: (head: string, key: string, fmt = (v: string) => v): Col => ({ head, cell: (r) => (r.extra?.[key] ? fmt(String(r.extra[key])) : '-') }),
};

/** A customer's sections, in Zoho's order, with Zoho's columns and "Status:" lists. */
const CUSTOMER_SECTIONS: TxSection[] = [
  { kind: 'invoice', label: 'Invoices', open: true, newHref: '/sales/invoices/new', statuses: ['All', 'Draft', 'Client Viewed', 'Partially Paid', 'Unpaid', 'Overdue', 'Paid', 'Void'],
    cols: [C.date(), { head: 'Invoice Number', cell: num((r) => `/sales/invoices/${r.id}`) }, C.ref('Order Number'), C.amount(), C.balance(), C.status()] },
  { kind: 'payment_received', label: 'Customer Payments', newHref: '/sales/payments/new', statuses: null,
    cols: [C.date(), { head: 'Payment Number', cell: num((r) => `/print/payment-received/${r.id}`) }, C.ref(), C.extraText('Payment Mode', 'mode', titleCase), C.amount(), C.balance('Unused Amount')] },
  { kind: 'estimate', label: 'Quotes', newHref: '/sales/estimates', statuses: ['All', 'Draft', 'Sent', 'Client Viewed', 'Accepted', 'Invoiced', 'Declined', 'Expired'],
    cols: [C.date(), { head: 'Quote#', cell: num((r) => `/print/estimate/${r.id}`) }, C.ref(), C.amount(), C.status()] },
  // Zoho's "Retainer Invoices", which this book calls Service Invoices.
  { kind: 'retainer_invoice', label: 'Service Invoices', newHref: '/sales/retainers', statuses: ['All', 'Draft', 'Sent', 'Paid', 'Partially Drawn', 'Drawn', 'Void'],
    cols: [C.date(), { head: 'Service Invoice Number', cell: num((r) => `/print/retainer/${r.id}`) }, C.ref(), C.amount(), C.balance(), C.status()] },
  { kind: 'sales_order', label: 'Sales Orders', newHref: '/sales/sales-orders', statuses: ['All', 'Draft', 'Partially Invoiced', 'Invoiced', 'Closed', 'Void', 'Confirmed', 'Overdue'],
    cols: [{ head: 'Sales Order#', cell: num((r) => `/print/sales-order/${r.id}`) }, C.ref(), C.date(), C.extraDate('Shipment Date', 'shipmentDate'), C.amount(), C.status()] },
  { kind: 'challan', label: 'Delivery Challans', newHref: '/sales/challans', statuses: ['All', 'Draft', 'Open', 'Delivered', 'Returned'],
    cols: [{ head: 'Delivery Challan#', cell: num((r) => `/print/challan/${r.id}`) }, C.ref(), C.date(), C.amount(), C.status()] },
  { kind: 'recurring_invoice', label: 'Recurring Invoices', newHref: '/sales/recurring', statuses: ['All', 'Active', 'Stopped', 'Expired'],
    cols: [{ head: 'Profile Name', cell: num(() => '/sales/recurring') }, C.extraText('Frequency', 'frequency', titleCase), C.extraDate('Last Invoice Date', 'lastDate'), C.extraDate('Next Invoice Date', 'nextDate'), C.status()] },
  { kind: 'expense', label: 'Expenses', newHref: '/purchases/expenses', statuses: ['All', 'Unbilled', 'Invoiced', 'Reimbursed', 'Billable', 'Non-Billable', 'With Receipts', 'Without Receipts'],
    cols: [C.date(), C.extraText('Expense Category', 'category'), { head: 'Invoice Number', cell: (r) => (r.extra?.invoiceId ? <Link href={`/sales/invoices/${r.extra.invoiceId}`} className="text-link hover:underline">{r.ref}</Link> : '-') }, C.amount(), C.status()] },
  { kind: 'recurring_expense', label: 'Recurring Expenses', newHref: '/purchases/recurring?kind=expense', statuses: ['All', 'Active', 'Stopped', 'Expired'],
    cols: [{ head: 'Profile Name', cell: (r) => r.number }, C.extraText('Expense Category', 'category'), C.extraText('Frequency', 'frequency', titleCase), C.extraDate('Last Expense Date', 'lastDate'), C.extraDate('Next Expense Date', 'nextDate'), C.status()] },
  { kind: 'project', label: 'Projects', newHref: '/projects', statuses: ['All', 'Active', 'Inactive'],
    cols: [{ head: 'Project Name', cell: num((r) => `/projects/${r.id}`) }, C.extraText('Billing Method', 'billingMethod', titleCase), { head: 'Rate', right: true, cell: (r) => <Money value={Number(r.extra?.ratePaise ?? 0)} /> }] },
  { kind: 'journal', label: 'Journals', newHref: '/accountant/journals', statuses: null,
    cols: [C.date(), { head: 'Journal Number', cell: (r) => <Link href="/accountant/journals" className="text-link hover:underline">JE #{r.number}</Link> }, C.ref(), { head: 'Debit', right: true, cell: (r) => <Money value={Number(r.extra?.debitPaise ?? 0)} /> }, { head: 'Credit', right: true, cell: (r) => <Money value={Number(r.extra?.creditPaise ?? 0)} /> }] },
  { kind: 'bill', label: 'Bills', newHref: '/purchases/bills/new', statuses: ['All', 'Open', 'Overdue', 'Unpaid', 'Partially Paid', 'Paid', 'Void'],
    cols: [C.date(), { head: 'Bill#', cell: num((r) => `/purchases/bills/${r.id}`) }, C.ref('Order Number'), C.extraText('Vendor Name', 'vendorName'), C.amount(), { head: 'Customer Associated Line Items Total', right: true, cell: () => '-' }, C.balance(), C.status()] },
  { kind: 'credit_note', label: 'Credit Notes', newHref: '/sales/credit-notes', statuses: ['All', 'Open', 'Closed', 'Void'],
    cols: [C.date('Credit Date'), { head: 'Credit Note Number', cell: num((r) => `/print/credit-note/${r.id}`) }, C.ref(), C.balance('Balance'), C.amount(), C.status()] },
];
/** A vendor's sections, in Zoho's order, with Zoho's columns and "Status:" lists. */
const VENDOR_SECTIONS: TxSection[] = [
  { kind: 'bill', label: 'Bills', open: true, newHref: '/purchases/bills/new', statuses: ['All', 'Open', 'Overdue', 'Unpaid', 'Partially Paid', 'Paid', 'Void'],
    cols: [C.date(), { head: 'Bill#', cell: num((r) => `/purchases/bills/${r.id}`) }, C.ref('Order Number'), C.extraText('Vendor Name', 'vendorName'), C.amount(), C.balance(), C.status()] },
  { kind: 'payment_made', label: 'Bill Payments', newHref: '/purchases/payments/new', statuses: null,
    cols: [C.date(), { head: 'Payment Number', cell: num((r) => `/print/payment-made/${r.id}`) }, C.ref(), C.extraText('Payment Mode', 'mode', titleCase), C.amount('Amount Paid'), C.balance('Unused Amount')] },
  { kind: 'expense', label: 'Expenses', newHref: '/purchases/expenses', statuses: ['All', 'Unbilled', 'Invoiced', 'Reimbursed', 'Billable', 'Non-Billable', 'With Receipts', 'Without Receipts'],
    cols: [C.date(), C.extraText('Expense Account', 'category'), { head: 'Invoice Number', cell: (r) => (r.extra?.invoiceId ? <Link href={`/sales/invoices/${r.extra.invoiceId}`} className="text-link hover:underline">{r.ref}</Link> : '-') },
      C.extraText('Vendor Name', 'vendorName'), C.extraText('Paid Through', 'paidThrough'), C.extraText('Customer Name', 'customerName'), C.amount(), C.status()] },
  { kind: 'recurring_bill', label: 'Recurring Bills', newHref: '/purchases/recurring', statuses: ['All', 'Active', 'Stopped', 'Expired'],
    cols: [{ head: 'Profile Name', cell: num(() => '/purchases/recurring') }, C.extraText('Frequency', 'frequency', titleCase), C.extraDate('Last Bill Date', 'lastDate'), C.extraDate('Next Bill Date', 'nextDate'), C.status()] },
  { kind: 'recurring_expense', label: 'Recurring Expenses', newHref: '/purchases/recurring?kind=expense', statuses: ['All', 'Active', 'Stopped', 'Expired'],
    cols: [{ head: 'Profile Name', cell: num(() => '/purchases/recurring?kind=expense') }, C.extraText('Expense Account', 'category'), C.extraText('Frequency', 'frequency', titleCase), C.extraDate('Last Expense Date', 'lastDate'), C.extraDate('Next Expense Date', 'nextDate'), C.status()] },
  { kind: 'purchase_order', label: 'Purchase Orders', newHref: '/purchases/purchase-orders', statuses: ['All', 'Draft', 'Billed', 'Partially Billed', 'Closed', 'Canceled', 'Issued'],
    cols: [{ head: 'Purchase Order#', cell: num((r) => `/print/purchase-order/${r.id}`) }, C.ref(), C.date(), C.extraDate('Delivery Date', 'deliveryDate'), C.amount(), C.status()] },
  { kind: 'vendor_credit', label: 'Vendor Credits', newHref: '/purchases/vendor-credits', statuses: ['All', 'Open', 'Closed', 'Void'],
    cols: [C.date(), { head: 'Credit Note Number', cell: num((r) => `/print/vendor-credit/${r.id}`) }, C.ref('Order Number'), C.balance('Balance'), C.amount(), C.status()] },
  { kind: 'journal', label: 'Journals', newHref: '/accountant/journals', statuses: null,
    cols: [C.date(), { head: 'Journal Number', cell: (r) => <Link href="/accountant/journals" className="text-link hover:underline">JE #{r.number}</Link> }, C.ref(), { head: 'Debit', right: true, cell: (r) => <Money value={Number(r.extra?.debitPaise ?? 0)} /> }, { head: 'Credit', right: true, cell: (r) => <Money value={Number(r.extra?.creditPaise ?? 0)} /> }] },
];

function TxBlock({ s, rows, open, setOpen, active }: { s: TxSection; rows: ContactTxRow[]; open: boolean; setOpen: (o: boolean) => void; active: boolean }) {
  const [status, setStatus] = useState('All');
  const [page, setPage] = useState(0);
  const [size, setSize] = useState(10);
  const shown = rows.filter((r) => status === 'All' || r.filters.includes(status.toLowerCase()));
  const pageRows = shown.slice(page * size, (page + 1) * size);
  return (
    <section id={`tx-${s.kind}`} className="rounded-[var(--radius-card)] border" data-slot="contact-tx-section" data-kind={s.kind} data-open={open ? '1' : '0'}>
      <div className="flex items-center gap-3 bg-[#fbfbfd] px-4 py-2.5 dark:bg-muted/30">
        <button type="button" onClick={() => setOpen(!open)} className="flex items-center gap-1.5 text-[14px] font-medium" aria-expanded={open}>
          <ChevronDown className={cn('size-3.5 transition-transform', !open && '-rotate-90')} /> {s.label}
        </button>
        {open && (
          <span className="ml-auto flex items-center gap-3 text-[13px]">
            {s.statuses && (
              <DropdownMenu>
                <DropdownMenuTrigger className="inline-flex items-center gap-1 text-link outline-none" data-slot="tx-status">
                  <Filter className="size-3.5" /> Status: {status} <ChevronDown className="size-3" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-40">
                  {s.statuses.map((x) => <DropdownMenuItem key={x} onClick={() => { setStatus(x); setPage(0); }}>{x}</DropdownMenuItem>)}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {active && s.newHref && <Link href={s.newHref} className="inline-flex items-center gap-1 text-link hover:underline"><Plus className="size-3.5" /> New</Link>}
          </span>
        )}
      </div>
      {open && (shown.length ? (
        <>
          <div className="overflow-x-auto border-t">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr className="bg-table-head text-left text-[11px] uppercase text-muted-foreground">
                  {s.cols.map((c) => <th key={c.head} className={cn('px-4 py-2 font-normal', c.right && 'text-right')}>{c.head}</th>)}
                </tr>
              </thead>
              <tbody>
                {pageRows.map((r) => (
                  <tr key={`${r.kind}-${r.id}`} className="border-t hover:bg-row-hover" data-slot="contact-tx-row">
                    {s.cols.map((c) => <td key={c.head} className={cn('px-4 py-2.5', c.right && 'text-right')}>{c.cell(r)}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {shown.length > 10 && <Pager total={shown.length} page={page} size={size} setPage={setPage} setSize={setSize} />}
        </>
      ) : <p className="border-t px-4 py-5 text-center text-[13px] text-muted-foreground">There are no {s.label.toLowerCase()}{status !== 'All' ? ` in ${status.toLowerCase()}` : ''}.</p>)}
    </section>
  );
}

function Transactions({ id, side, active }: { id: string; side: Side; active: boolean }) {
  const state = useApi(() => contactActivity.transactions(id, side), [id, side]);
  const ref = useRef<HTMLDivElement>(null);
  const sections = side === 'customer' ? CUSTOMER_SECTIONS : VENDOR_SECTIONS;
  const [open, setOpen] = useState<Record<string, boolean>>(() => Object.fromEntries(sections.map((s) => [s.kind, !!s.open])));
  const goTo = (k: ContactTxKind) => {
    setOpen((o) => ({ ...o, [k]: true }));
    setTimeout(() => ref.current?.querySelector(`#tx-${k}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  };
  return (
    <div className="space-y-4 px-5 py-5" data-slot="contact-transactions" ref={ref}>
      <DropdownMenu>
        <DropdownMenuTrigger data-slot="tx-goto" className="inline-flex items-center gap-1 text-[17px] outline-none">
          Go to transactions <ChevronDown className="size-4 text-primary" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-52">
          {sections.map((s) => <DropdownMenuItem key={s.kind} onClick={() => goTo(s.kind)}>{s.label}</DropdownMenuItem>)}
        </DropdownMenuContent>
      </DropdownMenu>
      {state.loading && !state.data ? <LoadingRows /> : sections.map((s) => (
        <TxBlock key={s.kind} s={s} rows={(state.data?.rows ?? []).filter((r) => r.kind === s.kind)} open={!!open[s.kind]} setOpen={(o) => setOpen((x) => ({ ...x, [s.kind]: o }))} active={active} />
      ))}
    </div>
  );
}

// ── Comments, Mails and Statement ───────────────────────────────────────────

/** A comment's **bold**, *italic* and __underline__, shown as such and nothing else: no markup is trusted. */
function Formatted({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*)/g).filter(Boolean);
  return <>{parts.map((p, i) => (p.startsWith('**') ? <strong key={i}>{p.slice(2, -2)}</strong> : p.startsWith('__') ? <u key={i}>{p.slice(2, -2)}</u> : p.startsWith('*') && p.length > 2 ? <em key={i}>{p.slice(1, -1)}</em> : <span key={i}>{p}</span>))}</>;
}

function CommentsTab({ id }: { id: string }) {
  const state = useApi(() => commentsApi.list('contact', id), [id]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const wrap = (mark: string) => {
    const el = box.current;
    if (!el) return;
    const [a, b] = [el.selectionStart, el.selectionEnd];
    const next = `${text.slice(0, a)}${mark}${text.slice(a, b) || 'text'}${mark}${text.slice(b)}`;
    setText(next);
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(a + mark.length, (b > a ? b : a + 4) + mark.length); });
  };
  const add = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      await commentsApi.add('contact', id, text.trim());
      setText('');
      await state.refetch();
    } catch (e) {
      toast.error('Not added', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  const list = state.data?.comments ?? [];
  return (
    <div className="space-y-5 px-5 py-5" data-slot="contact-comments">
      <div className="max-w-3xl rounded-[var(--radius-card)] border">
        <div className="flex items-center gap-1 border-b bg-[#fbfbfd] px-2 py-1 dark:bg-muted/30">
          {([['**', Bold, 'Bold'], ['*', Italic, 'Italic'], ['__', Underline, 'Underline']] as const).map(([m, Icon, l]) => (
            <button key={l} type="button" aria-label={l} title={l} onClick={() => wrap(m)} className="grid size-7 place-items-center rounded hover:bg-muted"><Icon className="size-3.5" /></button>
          ))}
        </div>
        <textarea ref={box} value={text} onChange={(e) => setText(e.target.value)} rows={4} aria-label="Comment" className="w-full resize-y bg-transparent px-3 py-2 text-[13px] outline-none" maxLength={2000} />
      </div>
      <Button size="sm" disabled={busy || !text.trim()} onClick={() => void add()} data-slot="add-comment">{busy ? 'Adding…' : 'Add Comment'}</Button>
      <div>
        <p className="mb-2 text-[12px] font-medium uppercase tracking-wide text-muted-foreground">All Comments</p>
        {state.loading && !state.data ? <LoadingRows rows={2} /> : list.length ? (
          <ul className="space-y-3" data-slot="comment-list">
            {list.map((c) => (
              <li key={c.id} className="border-l-2 border-primary/40 pl-3 text-[13px]">
                <p className="text-[12px] text-muted-foreground">{c.author} · {stamp(c.at)}</p>
                <p className="whitespace-pre-line"><Formatted text={c.body} /></p>
              </li>
            ))}
          </ul>
        ) : <p className="text-[13px] text-muted-foreground" data-slot="comments-empty">No comments yet.</p>}
      </div>
    </div>
  );
}

function Mails({ id }: { id: string }) {
  const state = useApi(() => contactActivity.mails(id), [id]);
  const mails = state.data?.mails ?? [];
  const [page, setPage] = useState(0);
  const [size, setSize] = useState(10);
  return (
    <div className="px-5 py-5" data-slot="contact-mails">
      <h4 className="mb-3 text-[15px]">System Mails</h4>
      {state.loading && !state.data ? <LoadingRows /> : mails.length ? (
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="bg-table-head text-left text-[11px] uppercase text-muted-foreground">
              <th className="px-3 py-2 font-normal">Date</th><th className="px-3 py-2 font-normal">To</th><th className="px-3 py-2 font-normal">Subject</th><th className="px-3 py-2 font-normal">Status</th>
            </tr>
          </thead>
          <tbody>
            {mails.slice(page * size, (page + 1) * size).map((m) => (
              <tr key={m.id} className="border-b">
                <td className="whitespace-nowrap px-3 py-2">{stamp(m.at)}</td>
                <td className="px-3 py-2">{m.to}</td>
                <td className="px-3 py-2">{m.docType === 'invoice' && m.docId ? <Link href={`/sales/invoices/${m.docId}`} className="text-link hover:underline">{m.subject}</Link> : m.subject}</td>
                <td className="px-3 py-2"><StatusBadge status={m.status === 'sent' ? 'sent' : 'failed'} className="capitalize" /></td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <p className="py-10 text-center text-[13px] text-muted-foreground" data-slot="mails-empty">No emails sent.</p>}
      <Pager total={mails.length} page={page} size={size} setPage={setPage} setSize={setSize} />
    </div>
  );
}

/** Zoho's statement periods, This Month first. */
const STATEMENT_RANGES: [string, string][] = [
  ['today', 'Today'], ['this_week', 'This Week'], ['this_month', 'This Month'], ['this_quarter', 'This Quarter'], ['this_fy', 'This Year'],
  ['yesterday', 'Yesterday'], ['prev_week', 'Previous Week'], ['prev_month', 'Previous Month'], ['prev_quarter', 'Previous Quarter'], ['prev_fy', 'Previous Year'],
];
const rangeOf = (key: string, t: string) => PRESETS.find((p) => p.key === key)?.resolve(t) ?? { from: t, to: t };

function StatementTab({ id, side, email }: { id: string; side: Side; email: string | null | undefined }) {
  const t = todayIso();
  const [preset, setPreset] = useState('this_month');
  const [range, setRange] = useState(() => rangeOf('this_month', t));
  const [custom, setCustom] = useState(false);
  const [filter, setFilter] = useState<'all' | 'outstanding'>('all');
  const state = useApi<PartyStatement>(() => contacts.statement(id, { side, from: range.from, to: range.to, filter }), [id, side, range.from, range.to, filter]);
  const mail = useApi(() => api.get<{ configured: boolean }>('/api/email', { docType: 'statement', docId: id }), [id]);
  const [sending, setSending] = useState(false);
  const base = side === 'customer' ? `/sales/customers/${id}` : `/purchases/vendors/${id}`;
  const label = custom ? 'Custom' : STATEMENT_RANGES.find(([k]) => k === preset)?.[1] ?? '';
  const send = async () => {
    if (!email) { toast.error('There is no email address for this contact. Add one, then send the statement.'); return; }
    if (!mail.data?.configured) { toast.error('Email is not set up yet', { description: 'Set up email sending in Settings, then send the statement.' }); return; }
    setSending(true);
    try {
      const r = await api.post<{ to: string[] }>('/api/email', { kind: 'statement', contactId: id, side, from: range.from, to: range.to });
      toast.success('Statement emailed', { description: `To ${r.to.join(', ')}.` });
    } catch (e) {
      toast.error('Not sent', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setSending(false);
    }
  };
  const printHref = `${base}/statement?from=${range.from}&to=${range.to}`;
  return (
    <div className="space-y-5 px-5 py-5" data-slot="contact-statement">
      <div className="flex flex-wrap items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger data-slot="statement-range" className="inline-flex h-[33px] min-w-40 items-center justify-between gap-2 rounded-[var(--radius-button)] border border-input bg-background px-2.5 text-[13px] outline-none">
            <span className="flex items-center gap-2"><Calendar className="size-4 text-muted-foreground" /> {label}</span> <ChevronDown className="size-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-44">
            {STATEMENT_RANGES.map(([k, l]) => <DropdownMenuItem key={k} onClick={() => { setPreset(k); setCustom(false); setRange(rangeOf(k, t)); }}>{l}</DropdownMenuItem>)}
            <DropdownMenuItem onClick={() => setCustom(true)}>Custom</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {custom && (
          <span className="flex items-center gap-1.5 text-[13px]" data-slot="statement-custom">
            <Input type="date" value={range.from} onChange={(e) => e.target.value && setRange({ ...range, from: e.target.value })} className="h-[33px] w-36" aria-label="From" />
            <span>-</span>
            <Input type="date" value={range.to} onChange={(e) => e.target.value && setRange({ ...range, to: e.target.value })} className="h-[33px] w-36" aria-label="To" />
          </span>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger data-slot="statement-filter" className="inline-flex h-[33px] items-center gap-1 rounded-[var(--radius-button)] border border-input bg-background px-2.5 text-[13px] outline-none">
            <span className="text-muted-foreground">Filter By:</span> {filter === 'all' ? 'All' : 'Outstanding'} <ChevronDown className="size-3" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onClick={() => setFilter('all')}>All</DropdownMenuItem>
            <DropdownMenuItem onClick={() => setFilter('outstanding')}>Outstanding</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <span className="ml-auto flex items-center gap-2">
          <Link href={printHref} aria-label="Print" title="Print" className={iconBtn}><Printer className="size-4" /></Link>
          <DropdownMenu>
            <DropdownMenuTrigger aria-label="PDF" title="PDF" className={iconBtn}><FileText className="size-4" /></DropdownMenuTrigger>
            <DropdownMenuContent align="end"><DropdownMenuItem onClick={() => window.open(printHref, '_blank')}>PDF</DropdownMenuItem></DropdownMenuContent>
          </DropdownMenu>
          <button type="button" aria-label="Excel" title="Excel" className={iconBtn} disabled={!state.data}
            onClick={() => state.data && downloadWorkbook(`statement-${state.data.party.name}-${range.from}-${range.to}`, [statementSheet(state.data)])}>
            <FileSpreadsheet className="size-4" />
          </button>
          <Button size="sm" disabled={!state.data || sending} onClick={() => void send()} data-slot="statement-send"><Mail className="size-3.5" /> {sending ? 'Sending…' : 'Send Email'}</Button>
        </span>
      </div>
      <AsyncPage state={state} loading={<LoadingRows rows={6} />}>
        {(s) => (
          <>
            <div className="text-center">
              <p className="text-[17px]">{side === 'customer' ? 'Customer Statement for' : 'Vendor Statement For'} {s.party.name}</p>
              <p className="text-[13px] text-muted-foreground">From {day(range.from)} To {day(range.to)}</p>
            </div>
            <StatementPrint s={s} backHref={base} bare />
          </>
        )}
      </AsyncPage>
    </div>
  );
}

// ── The dialogs behind More ─────────────────────────────────────────────────

function BankDialog({ c, open, onOpenChange, onSaved }: { c: Detail; open: boolean; onOpenChange: (o: boolean) => void; onSaved: () => void }) {
  const [f, setF] = useState({ bankAccountName: c.bankAccountName ?? '', bankName: c.bankName ?? '', bankAccountNo: '', again: '', bankIfsc: c.bankIfsc ?? '' });
  const [busy, setBusy] = useState(false);
  const mismatch = !!f.again && f.again !== f.bankAccountNo;
  const save = async () => {
    if (f.bankAccountNo && f.again !== f.bankAccountNo) { toast.error('The account numbers do not match.'); return; }
    setBusy(true);
    try {
      await contacts.update({ id: c.id, expectedUpdatedAt: c.updatedAt, bankAccountName: f.bankAccountName || null, bankName: f.bankName || null, bankIfsc: f.bankIfsc || null, ...(f.bankAccountNo ? { bankAccountNo: f.bankAccountNo } : {}) });
      toast.success('Bank account details saved');
      onOpenChange(false);
      onSaved();
    } catch (e) {
      toast.error('Not saved', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  const fields = [['bankAccountName', 'Account Holder Name'], ['bankName', 'Bank Name'], ['bankAccountNo', 'Account Number'], ['again', 'Re-enter Account Number'], ['bankIfsc', 'IFSC']] as const;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-slot="bank-dialog">
        <DialogHeader><DialogTitle>Add Bank Account Details</DialogTitle></DialogHeader>
        <div className="space-y-3 text-[13px]">
          {fields.map(([k, l]) => (
            <label key={k} className="block space-y-1"><span className="text-muted-foreground">{l}</span>
              <Input value={f[k]} aria-label={l} aria-invalid={k === 'again' && mismatch}
                onChange={(e) => setF({ ...f, [k]: k === 'bankIfsc' ? e.target.value.toUpperCase() : k === 'bankAccountNo' || k === 'again' ? e.target.value.replace(/\s/g, '') : e.target.value })}
                placeholder={k === 'bankAccountNo' && c.bankAccountNo ? `On file: ${c.bankAccountNo}` : undefined} />
            </label>
          ))}
          {mismatch && <p className="text-[12px] text-destructive">The account numbers do not match.</p>}
        </div>
        <DialogFooter><Button disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</Button><Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LinkDialog({ c, side, open, onOpenChange, onDone }: { c: Detail; side: Side; open: boolean; onOpenChange: (o: boolean) => void; onDone: () => void }) {
  const otherSide = side === 'customer' ? 'vendor' : 'customer';
  const list = useApi(() => (open ? contacts.list({ kind: otherSide }) : Promise.resolve({ contacts: [] as ContactRow[] })), [open, otherSide]);
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  const choices = (list.data?.contacts ?? []).filter((x) => x.kind === otherSide && !x.linkedContactId && x.id !== c.id).map((x) => ({ value: x.id, label: x.displayName }));
  const Other = otherSide === 'vendor' ? 'Vendor' : 'Customer';
  const link = async () => {
    setBusy(true);
    try {
      await contacts.link(c.id, pick);
      toast.success(`${c.displayName} is linked to a ${otherSide}`);
      onOpenChange(false);
      onDone();
    } catch (e) {
      toast.error('Not linked', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-slot="link-dialog">
        <DialogHeader>
          <DialogTitle>Link {c.displayName} to {Other}</DialogTitle>
          <DialogDescription>
            You&apos;re about to link this {side} to a {otherSide}. As a result the {side} profile of the contact will be linked to the {otherSide} profile of the other contact. This process will allow you to view receivables and payables for the contact from the contact&apos;s overview section.
          </DialogDescription>
        </DialogHeader>
        <label className="block space-y-1 text-[13px]"><span>Choose a {otherSide} to link</span>
          <Combobox options={choices} value={pick} onChange={setPick} placeholder={`Select a ${otherSide}`} showAvatar={false} searchPlaceholder="Search" />
        </label>
        <DialogFooter><Button disabled={!pick || busy} onClick={() => void link()} data-slot="link-confirm">Link</Button><Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CloneDialog({ id, open, onOpenChange }: { id: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const router = useRouter();
  const [as, setAs] = useState<'customer' | 'vendor'>('customer');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-slot="clone-dialog">
        <DialogHeader><DialogTitle className="text-[14px] font-normal">Select the contact type under which you want to create the new cloned contact.</DialogTitle></DialogHeader>
        <div className="flex gap-6 text-[13px]">
          {(['customer', 'vendor'] as const).map((k) => (
            <label key={k} className="flex cursor-pointer items-center gap-2">
              <input type="radio" name="clone-as" className="size-3.5 accent-primary" checked={as === k} onChange={() => setAs(k)} /> {k === 'customer' ? 'Customer' : 'Vendor'}
            </label>
          ))}
        </div>
        <DialogFooter>
          <Button onClick={() => router.push(as === 'customer' ? `/sales/customers/new?clone=${id}` : `/purchases/vendors/new?clone=${id}`)} data-slot="clone-proceed">Proceed</Button>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── The header and the page ─────────────────────────────────────────────────

function Header({ d, side, onChanged }: { d: ContactDetail; side: Side; onChanged: () => void }) {
  const router = useRouter();
  const c = d.contact;
  const area = side === 'customer' ? 'sales' : 'purchases';
  const base = side === 'customer' ? '/sales/customers' : '/purchases/vendors';
  const canCreate = usePermission(area, 'create');
  const canEdit = usePermission(area, 'edit');
  const canDelete = usePermission(area, 'void');
  const [dialog, setDialog] = useState<null | 'portal' | 'portal-email' | 'bank' | 'link' | 'clone' | 'merge' | 'delete'>(null);
  const [busy, setBusy] = useState(false);
  usePublishPageTitle(c.displayName);

  const act = async (what: string, call: () => Promise<unknown>, after?: () => void) => {
    setBusy(true);
    try { await call(); toast.success(what); refreshSplitList(); if (after) after(); else onChanged(); }
    catch (e) { toast.error('Not done', { description: e instanceof Error ? e.message : String(e) }); }
    finally { setBusy(false); }
  };
  const toggleActive = () => void act(c.isArchived ? 'The contact has been marked as active.' : 'The contact has been marked as inactive.',
    () => contacts.update({ id: c.id, isArchived: !c.isArchived, expectedUpdatedAt: c.updatedAt }));
  const Other = side === 'customer' ? 'Vendor' : 'Customer';
  const button = 'inline-flex h-[33px] items-center gap-1 rounded-[var(--radius-button)] border border-secondary-border bg-secondary px-2.5 text-[13px] outline-none hover:brightness-[0.98]';
  return (
    <div data-slot="contact-header" className="-mx-6 -mt-5 flex min-h-[65px] items-center gap-3 border-b py-3 pl-5 pr-[3.75rem]">
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        {c.contactType === 'individual' ? <User className="size-5 shrink-0" /> : <Building2 className="size-5 shrink-0" />}
        <h1 className="truncate text-[22px] font-normal leading-tight" data-slot="contact-title">{c.displayName}</h1>
      </div>
      <div className="flex shrink-0 items-center gap-2 no-print">
        {/* Zoho: an inactive contact offers Mark as Active and Delete, not Edit and More. */}
        {c.isArchived
          ? canEdit && <button type="button" className={button} disabled={busy} onClick={toggleActive} data-slot="contact-mark-active">Mark as Active</button>
          : canEdit && <Button variant="outline" size="sm" asChild><Link href={`${base}/${c.id}/edit`} data-slot="contact-edit">Edit</Link></Button>}
        <Popover>
          <PopoverTrigger aria-label="Attachments" title="Attachments" data-slot="contact-attachments" className={iconBtn}>
            <Paperclip className="size-4" />
          </PopoverTrigger>
          <PopoverContent align="end" className="w-96">
            <Attachments targetType="contact" targetId={c.id} canEdit={canEdit} title="Attachments" />
          </PopoverContent>
        </Popover>
        {c.isArchived ? (
          canDelete && <button type="button" className={button} onClick={() => setDialog('delete')} data-slot="contact-delete-button">Delete</button>
        ) : (canEdit || canCreate || canDelete) && (
          <DropdownMenu>
            <DropdownMenuTrigger data-slot="contact-more" disabled={busy} className={button}>
              More <ChevronDown className="size-3.5" strokeWidth={2.2} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-52">
              {canEdit && <DropdownMenuItem onClick={() => setDialog(c.email ? 'portal' : 'portal-email')} data-slot="contact-portal">Configure {side === 'customer' ? 'Customer' : 'Vendor'} Portal</DropdownMenuItem>}
              {canEdit && <DropdownMenuItem onClick={() => setDialog('bank')} data-slot="contact-bank-add">Add Bank Account</DropdownMenuItem>}
              {canEdit && (c.linked
                ? <DropdownMenuItem onClick={() => void act(`${c.displayName} is unlinked`, () => contacts.unlink(c.id))} data-slot="contact-unlink">Unlink {Other}</DropdownMenuItem>
                : <DropdownMenuItem onClick={() => setDialog('link')} data-slot="contact-link">Link to {Other}</DropdownMenuItem>)}
              {canCreate && <DropdownMenuItem onClick={() => setDialog('clone')} data-slot="contact-clone">Clone</DropdownMenuItem>}
              {canEdit && !c.mergedIntoId && <DropdownMenuItem onClick={() => setDialog('merge')}>Merge {side === 'customer' ? 'Customers' : 'Vendors'}</DropdownMenuItem>}
              {canEdit && <DropdownMenuItem data-slot="contact-toggle-active" onClick={toggleActive}>Mark as Inactive</DropdownMenuItem>}
              {canDelete && <DropdownMenuItem onClick={() => setDialog('delete')} data-slot="contact-delete">Delete</DropdownMenuItem>}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      <Dialog open={dialog === 'portal'} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader><DialogTitle>Configure {side === 'customer' ? 'Customer' : 'Vendor'} Portal</DialogTitle><DialogDescription>{side === 'customer' ? `A link ${c.displayName} opens to see and pay their invoices.` : `A link ${c.displayName} opens to see their bills and payments.`}</DialogDescription></DialogHeader>
          <PortalAccess contactId={c.id} side={side} defaultEmail={c.email ?? null} canEdit={canEdit} />
        </DialogContent>
      </Dialog>
      <Dialog open={dialog === 'portal-email'} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent className="sm:max-w-sm" data-slot="portal-no-email">
          <DialogHeader><DialogTitle className="text-[14px] font-normal">You have not entered an email id for this contact. Please enter email id and try again.</DialogTitle></DialogHeader>
          <DialogFooter><Button onClick={() => setDialog(null)}>OK</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      {dialog === 'bank' && <BankDialog c={c} open onOpenChange={(o) => !o && setDialog(null)} onSaved={onChanged} />}
      {dialog === 'link' && <LinkDialog c={c} side={side} open onOpenChange={(o) => !o && setDialog(null)} onDone={() => { refreshSplitList(); onChanged(); }} />}
      {dialog === 'clone' && <CloneDialog id={c.id} open onOpenChange={(o) => !o && setDialog(null)} />}
      <MergeContactButton contactId={c.id} name={c.displayName} side={side} open={dialog === 'merge'} onOpenChange={(o) => setDialog(o ? 'merge' : null)} />
      <Dialog open={dialog === 'delete'} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent className="sm:max-w-sm" data-slot="contact-delete-dialog">
          <DialogHeader><DialogTitle className="text-[14px] font-normal">Do you want to delete this contact?</DialogTitle></DialogHeader>
          <DialogFooter>
            <Button variant="destructive" disabled={busy} data-slot="contact-delete-confirm"
              onClick={() => void act('The contact has been deleted.', () => contacts.remove(c.id), () => router.push(base)).then(() => setDialog(null))}>
              {busy ? 'Deleting…' : 'Delete'}
            </Button>
            <Button variant="outline" onClick={() => setDialog(null)}>Cancel</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function ContactRecord({ id, side }: { id: string; side: Side }) {
  const state = useApi<ContactDetail>(() => contacts.get(id), [id]);
  const canEdit = usePermission(side === 'customer' ? 'sales' : 'purchases', 'edit');
  const [tab, setTab] = useState('overview');
  useSplitRecordRefresh(state.refetch);
  const tabs = useMemo(() => [['overview', 'Overview'], ['comments', 'Comments'], ['transactions', 'Transactions'], ['mails', 'Mails'], ['statement', 'Statement']], []);
  return (
    <AsyncPage state={state}>
      {(d) => (
        <>
          <Header d={d} side={side} onChanged={state.refetch} />
          {d.contact.mergedIntoId && (
            <p className="rounded-[3px] border border-warning/40 bg-warning/10 px-3 py-2 text-sm" data-slot="merged-banner">
              This {side} was merged into another one; everything recorded under it moved there.{' '}
              <Link href={`${side === 'customer' ? '/sales/customers' : '/purchases/vendors'}/${d.contact.mergedIntoId}`} className="font-medium underline underline-offset-2">Open it</Link>
            </p>
          )}
          <Tabs value={tab} onValueChange={(v) => setTab(String(v))} className="-mx-6 gap-0">
            <TabsList className="w-full gap-x-0 px-5" data-slot="contact-tabs">
              {tabs.map(([v, l]) => <TabsTrigger key={v} value={v} className="px-3.5 data-active:font-semibold">{l}</TabsTrigger>)}
            </TabsList>
            <TabsContent value="overview"><Overview d={d} side={side} canEdit={canEdit} onChanged={state.refetch} /></TabsContent>
            <TabsContent value="comments"><CommentsTab id={d.contact.id} /></TabsContent>
            <TabsContent value="transactions"><Transactions id={d.contact.id} side={side} active={!d.contact.isArchived} /></TabsContent>
            <TabsContent value="mails"><Mails id={d.contact.id} /></TabsContent>
            <TabsContent value="statement"><StatementTab id={d.contact.id} side={side} email={d.contact.email} /></TabsContent>
          </Tabs>
        </>
      )}
    </AsyncPage>
  );
}
