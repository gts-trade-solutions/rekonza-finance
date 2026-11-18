'use client';

// ─────────────────────────────────────────────────────────────────────────────
// A customer (or vendor), as Zoho Books opens it beside the list.
//
// Zoho's header: the name, "Edit", the paperclip (attachments), "More ▾"
// (Configure Customer Portal, Add Bank Account, Link to Vendor, Clone, Merge,
// Mark as Inactive, Delete) and the X. Five tabs:
//   Overview      on the left, the primary contact and Zoho's sections —
//                 Remarks, Address, Other Details, Contact Persons, Bank
//                 Account Details, Associate Tags, Record Info; on the right
//                 the payment terms, the Receivables table (outstanding and
//                 unused credits) and the Income chart.
//   Comments, Transactions (a section per kind of document, each with its
//   status and "+ New"), Mails, and Statement (the statement itself, to print
//   or send).
// What Rekonza keeps that Zoho has not (TDS, MSME, credit limit, registration
// details, custom fields, extra addresses) sits in the same sections.
// ─────────────────────────────────────────────────────────────────────────────

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { Bar, BarChart, ResponsiveContainer, Tooltip as ChartTooltip, XAxis, YAxis } from 'recharts';
import { Building2, ChevronDown, ChevronUp, FileSpreadsheet, FileText, Paperclip, Pencil, Plus, Printer, User } from 'lucide-react';
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
import { Money } from '@/components/shared/money';
import { StatusBadge } from '@/components/shared/status-badge';
import { AsyncPage, LoadingRows } from '@/components/shared/async-state';
import { Attachments } from '@/components/shared/attachments';
import { ActivityPanel } from '@/components/shared/activity-panel';
import { CustomFieldsPanel } from '@/components/shared/custom-fields-panel';
import { PortalAccess } from '@/components/shared/portal-access';
import { ContactAddresses } from '@/components/shared/contact-addresses';
import { MergeContactButton } from '@/components/shared/merge-contact';
import { DateRangePicker } from '@/components/shared/date-range-picker';
import { useReportRange } from '@/components/shared/report-shell';
import { statementSheet } from '@/components/shared/party-statement';
import { StatementPrint } from '@/components/print/statement-print';
import { refreshSplitList, useSplitRecordRefresh } from '@/components/shared/record-split';
import { usePublishPageTitle } from '@/components/layout/page-context';
import {
  api, contactActivity, contactPersons, contacts,
  type ContactDetail, type ContactPerson, type ContactTxKind, type ContactTxRow, type PartyStatement,
} from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';
import { useAppStore } from '@/lib/store';
import { stateName } from '@/lib/tax/gst';
import { PAYMENT_TERMS } from '@/lib/options';
import { GST_TREATMENTS } from '@/components/contacts/contact-form';
import { formatINR, formatINRCompact } from '@/lib/money';
import { downloadWorkbook } from '@/lib/xlsx';
import { cn } from '@/lib/utils';

type Side = 'customer' | 'vendor';

const TERMS: Record<string, string> = Object.fromEntries(PAYMENT_TERMS.map((x) => [x.value, x.label]));
const TREATMENT: Record<string, string> = Object.fromEntries(GST_TREATMENTS.map((x) => [x.value, x.label]));
const day = (d: string | null | undefined) => (d ? new Date(`${d.slice(0, 10)}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '');
const stamp = (d: string) => new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

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

/** Label above value, as Zoho's Other Details reads. */
function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[130px_1fr] gap-2 py-1">
      <dt className="text-[12px] text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-[13px]">{children || '—'}</dd>
    </div>
  );
}

function Address({ title, lines, editHref }: { title: string; lines: (string | null | undefined)[]; editHref?: string }) {
  const shown = lines.filter(Boolean);
  return (
    <div className="mb-3">
      <div className="flex items-center justify-between">
        <p className="text-[12px] text-muted-foreground">{title}</p>
        {editHref && <Link href={editHref} aria-label={`Edit ${title}`} className="text-muted-foreground hover:text-foreground"><Pencil className="size-3" /></Link>}
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

// ── The Overview ────────────────────────────────────────────────────────────

function IncomeChart({ id, side }: { id: string; side: Side }) {
  const [months, setMonths] = useState<6 | 12>(6);
  const [basis, setBasis] = useState<'accrual' | 'cash'>('accrual');
  const state = useApi(() => contactActivity.income(id, side, months, basis), [id, side, months, basis]);
  const data = (state.data?.months ?? []).map((m) => ({
    month: new Date(`${m.month}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'short', year: '2-digit' }),
    amount: m.amountPaise / 100,
  }));
  const total = (state.data?.months ?? []).reduce((t, m) => t + m.amountPaise, 0);
  const waiting = state.loading && !state.data;
  return (
    <div className="space-y-2" data-slot="contact-income">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[15px]">{side === 'customer' ? 'Income' : 'Expense'} <span className="text-[12px] text-muted-foreground">This chart is displayed in the {side}&apos;s currency (INR).</span></p>
        <div className="flex items-center gap-2 text-[12px]">
          <select value={months} onChange={(e) => setMonths(Number(e.target.value) as 6 | 12)} aria-label="Period" className="bg-transparent text-link outline-none">
            <option value={6}>Last 6 Months</option>
            <option value={12}>Last 12 Months</option>
          </select>
          <span className="text-muted-foreground">|</span>
          <select value={basis} onChange={(e) => setBasis(e.target.value as 'accrual' | 'cash')} aria-label="Basis" className="bg-transparent text-link outline-none">
            <option value="accrual">Accrual</option>
            <option value="cash">Cash</option>
          </select>
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
      {!waiting && <p className="text-[13px]" data-slot="income-total">Total {side === 'customer' ? 'Income' : 'Expense'} ( Last {months} Months ) - <span className="font-medium">{formatINR(total)}</span></p>}
    </div>
  );
}

function Overview({ d, side, canEdit }: { d: ContactDetail; side: Side; canEdit: boolean }) {
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
  return (
    <div className="flex flex-col lg:flex-row" data-slot="contact-overview">
      <aside className="w-full shrink-0 border-r bg-[#fbfbfd] dark:bg-muted/30 lg:w-[300px]">
        <div className="space-y-1 px-5 py-4" data-slot="contact-card">
          <p className="text-[14px] font-medium">{c.legalName || c.displayName}</p>
          {primary || c.email || c.phone || c.mobile ? (
            <div className="space-y-0.5 text-[13px] text-muted-foreground">
              {primary && <p className="text-foreground">{primary}</p>}
              {c.email && <p>{c.email}</p>}
              {c.phone && <p>{c.phone}</p>}
              {c.mobile && <p>{c.mobile}</p>}
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
          <dl>
            <Detail label={side === 'customer' ? 'Customer Type' : 'Vendor Type'}>{c.contactType === 'individual' ? 'Individual' : 'Business'}</Detail>
            <Detail label="Default Currency">{c.currency ?? 'INR'}</Detail>
            {side === 'customer' && <Detail label="Price List">{c.priceListId ? 'Assigned' : '—'}</Detail>}
            <Detail label="GST Treatment">{TREATMENT[c.gstTreatment] ?? c.gstTreatment}</Detail>
            <Detail label="GSTIN">{c.gstin}</Detail>
            <Detail label={side === 'customer' ? 'Place of Supply' : 'Source of Supply'}>{c.stateCode ? stateName(c.stateCode) : ''}</Detail>
            <Detail label="PAN">{c.pan || (c.gstin && c.gstin.length === 15 ? c.gstin.slice(2, 12) : '')}</Detail>
            <Detail label="Tax Preference">{c.taxPreference === 'exempt' ? `Tax Exempt${c.taxExemptionReason ? ` (${c.taxExemptionReason})` : ''}` : 'Taxable'}</Detail>
            <Detail label="Payment Terms">{TERMS[c.paymentTerms ?? ''] ?? c.paymentTerms}</Detail>
            {side === 'customer' && <Detail label="Portal Status">{c.portalEnabled ? 'Enabled' : 'Disabled'}</Detail>}
            <Detail label={side === 'customer' ? 'Customer Language' : 'Vendor Language'}>{c.language ?? 'English'}</Detail>
            {(c.twitter || c.facebook || c.skype) && <Detail label="Social Networks">{[c.twitter && `Twitter: ${c.twitter}`, c.facebook && `Facebook: ${c.facebook}`, c.skype && `Skype: ${c.skype}`].filter(Boolean).join(' · ')}</Detail>}
            {c.website && <Detail label="Website URL"><a href={/^https?:/.test(c.website) ? c.website : `https://${c.website}`} target="_blank" rel="noreferrer" className="text-link hover:underline">{c.website}</a></Detail>}
            {c.creditLimitPaise > 0 && <Detail label="Credit Limit">{formatINR(c.creditLimitPaise)}</Detail>}
            {!!c.tdsSections?.length && <Detail label="TDS Sections">{c.tdsSections.join(', ')}</Detail>}
            {c.isMsme && <Detail label="MSME">{[c.msmeCategory, c.msmeUdyamNo].filter(Boolean).join(' · ') || 'Yes'}</Detail>}
            {c.constitution && <Detail label="Kind of Business">{c.constitution}</Detail>}
            {c.gstRegisteredOn && <Detail label="GST Registered On">{day(c.gstRegisteredOn)}</Detail>}
            {c.cin && <Detail label="CIN">{c.cin}</Detail>}
            {c.ownerUserId && <Detail label="Owner">{users.find((u) => u.id === c.ownerUserId)?.name ?? '—'}</Detail>}
          </dl>
          <CustomFieldsPanel entity="contact" id={c.id} canEdit={canEdit} className="mt-2" />
        </Section>
        <Section title="Contact Persons" slot="contact-persons"
          action={canEdit ? <Link href={`${base}/${c.id}/edit?tab=persons`} aria-label="Add a contact person" className="grid size-5 place-items-center rounded-full bg-primary text-primary-foreground"><Plus className="size-3" /></Link> : undefined}>
          {(persons.data?.persons ?? []).length ? (
            <ul className="space-y-2">
              {persons.data!.persons.map((p) => (
                <li key={p.id} className="flex items-start gap-2">
                  <User className="mt-0.5 size-3.5 text-muted-foreground" />
                  <span className="min-w-0">
                    <span className="block font-medium">{[p.salutation, p.name].filter(Boolean).join(' ')}{p.isPrimary && <span className="ml-1 text-[11px] text-muted-foreground">(Primary)</span>}</span>
                    {[p.email, p.phone, p.mobile].filter(Boolean).map((x) => <span key={x} className="block text-[12px] text-muted-foreground">{x}</span>)}
                  </span>
                </li>
              ))}
            </ul>
          ) : <p className="text-muted-foreground">No contact persons found.</p>}
        </Section>
        <Section title="Bank Account Details" slot="contact-bank">
          {c.bankAccountNo || c.bankName ? (
            <dl>
              <Detail label="Account Holder">{c.bankAccountName}</Detail>
              <Detail label="Bank Name">{c.bankName}</Detail>
              <Detail label="Account Number">{c.bankAccountNo}</Detail>
              <Detail label="IFSC">{c.bankIfsc}</Detail>
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
            <Detail label="Created On">{c.createdAt ? stamp(c.createdAt) : ''}</Detail>
            <Detail label="Last Modified">{c.updatedAt ? stamp(c.updatedAt) : ''}</Detail>
          </dl>
        </Section>
      </aside>

      <div className="min-w-0 flex-1 space-y-6 px-6 py-5">
        {side === 'customer' && !c.gstin && c.email && (
          <p className="text-[13px] text-muted-foreground">You can request your contact to directly update the GSTIN by sending an email.{' '}
            <a className="text-link hover:underline" href={`mailto:${c.email}?subject=${encodeURIComponent('Please share your GSTIN')}`}>Send email</a>
          </p>
        )}
        <div>
          <p className="text-[13px] text-muted-foreground">Payment due period</p>
          <p className="text-[14px]">{TERMS[c.paymentTerms ?? ''] ?? c.paymentTerms ?? 'Due on Receipt'}</p>
        </div>
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
        </div>
        <IncomeChart id={c.id} side={side} />
      </div>
    </div>
  );
}

// ── Transactions ────────────────────────────────────────────────────────────

interface TxSection { kind: ContactTxKind; label: string; cols: [string, string, string, string, string, string]; newHref?: string; href: (r: ContactTxRow) => string }
const SECTIONS: Record<Side, TxSection[]> = {
  customer: [
    { kind: 'invoice', label: 'Invoices', cols: ['Date', 'Invoice Number', 'Order Number', 'Amount', 'Balance Due', 'Status'], newHref: '/sales/invoices/new', href: (r) => `/sales/invoices/${r.id}` },
    { kind: 'payment_received', label: 'Customer Payments', cols: ['Date', 'Payment#', 'Mode', 'Amount', 'Unused Amount', 'Status'], newHref: '/sales/payments/new', href: (r) => `/print/payment-received/${r.id}` },
    { kind: 'estimate', label: 'Quotes', cols: ['Date', 'Quote Number', '', 'Amount', '', 'Status'], newHref: '/sales/estimates', href: (r) => `/print/estimate/${r.id}` },
    { kind: 'sales_order', label: 'Sales Orders', cols: ['Date', 'Sales Order#', '', 'Amount', '', 'Status'], newHref: '/sales/sales-orders', href: (r) => `/print/sales-order/${r.id}` },
    { kind: 'challan', label: 'Delivery Challans', cols: ['Date', 'Delivery Challan#', '', 'Amount', '', 'Status'], newHref: '/sales/challans', href: (r) => `/print/challan/${r.id}` },
    { kind: 'credit_note', label: 'Credit Notes', cols: ['Date', 'Credit Note#', '', 'Amount', 'Balance', 'Status'], newHref: '/sales/credit-notes', href: (r) => `/print/credit-note/${r.id}` },
    { kind: 'recurring_invoice', label: 'Recurring Invoices', cols: ['Next Invoice Date', 'Profile Name', 'Frequency', 'Amount', '', 'Status'], newHref: '/sales/recurring', href: () => '/sales/recurring' },
    { kind: 'project', label: 'Projects', cols: ['Created On', 'Project Name', 'Billing Method', '', '', 'Status'], newHref: '/projects', href: (r) => `/projects/${r.id}` },
  ],
  vendor: [
    { kind: 'bill', label: 'Bills', cols: ['Date', 'Bill#', 'Reference Number', 'Amount', 'Balance Due', 'Status'], newHref: '/purchases/bills/new', href: (r) => `/purchases/bills/${r.id}` },
    { kind: 'payment_made', label: 'Vendor Payments', cols: ['Date', 'Payment#', 'Mode', 'Amount', 'Unused Amount', 'Status'], newHref: '/purchases/payments/new', href: (r) => `/print/payment-made/${r.id}` },
    { kind: 'purchase_order', label: 'Purchase Orders', cols: ['Date', 'Purchase Order#', '', 'Amount', '', 'Status'], newHref: '/purchases/purchase-orders', href: (r) => `/print/purchase-order/${r.id}` },
    { kind: 'vendor_credit', label: 'Vendor Credits', cols: ['Date', 'Vendor Credit#', '', 'Amount', 'Balance', 'Status'], newHref: '/purchases/vendor-credits', href: (r) => `/print/vendor-credit/${r.id}` },
    { kind: 'expense', label: 'Expenses', cols: ['Date', 'Expense#', 'Reference#', 'Amount', '', 'Status'], newHref: '/purchases/expenses', href: () => '/purchases/expenses' },
  ],
};

function TxBlock({ s, rows }: { s: TxSection; rows: ContactTxRow[] }) {
  const [open, setOpen] = useState(true);
  const [status, setStatus] = useState('all');
  const statuses = [...new Set(rows.map((r) => r.status))];
  const shown = rows.filter((r) => status === 'all' || r.status === status);
  const label = (x: string) => x.replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
  return (
    <section id={`tx-${s.kind}`} className="rounded-[var(--radius-card)] border" data-slot="contact-tx-section" data-kind={s.kind}>
      <div className="flex items-center gap-3 border-b bg-[#fbfbfd] px-4 py-2.5 dark:bg-muted/30">
        <button type="button" onClick={() => setOpen((o) => !o)} className="flex items-center gap-1.5 text-[14px] font-medium" aria-expanded={open}>
          {open ? <ChevronDown className="size-3.5" /> : <ChevronDown className="size-3.5 -rotate-90" />} {s.label}
        </button>
        <span className="ml-auto flex items-center gap-3 text-[13px]">
          <label className="flex items-center gap-1 text-link">
            <span>Status:</span>
            <select value={status} onChange={(e) => setStatus(e.target.value)} className="bg-transparent outline-none" aria-label={`${s.label} status`}>
              <option value="all">All</option>
              {statuses.map((x) => <option key={x} value={x}>{label(x)}</option>)}
            </select>
          </label>
          {s.newHref && <Link href={s.newHref} className="inline-flex items-center gap-1 text-link hover:underline"><Plus className="size-3.5" /> New</Link>}
        </span>
      </div>
      {open && (shown.length ? (
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="bg-table-head text-left text-[11px] uppercase text-muted-foreground">
              {s.cols.map((h, i) => <th key={i} className={cn('px-4 py-2 font-normal', (i === 3 || i === 4) && 'text-right')}>{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={`${r.kind}-${r.id}`} className="border-b hover:bg-row-hover" data-slot="contact-tx-row">
                <td className="px-4 py-2">{day(r.date)}</td>
                <td className="px-4 py-2"><Link href={s.href(r)} className="text-link hover:underline">{r.number}</Link></td>
                <td className="px-4 py-2">{s.cols[2] ? r.ref ?? '-' : ''}</td>
                <td className="px-4 py-2 text-right">{s.cols[3] ? <Money value={r.amountPaise} /> : ''}</td>
                <td className="px-4 py-2 text-right">{s.cols[4] && r.balancePaise !== null ? <Money value={r.balancePaise} /> : ''}</td>
                <td className="px-4 py-2"><StatusBadge status={r.status} className="capitalize" /></td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <p className="px-4 py-5 text-center text-[13px] text-muted-foreground">There are no {s.label.toLowerCase()}{status !== 'all' ? ` in ${label(status).toLowerCase()}` : ''}.</p>)}
    </section>
  );
}

function Transactions({ id, side }: { id: string; side: Side }) {
  const state = useApi(() => contactActivity.transactions(id, side), [id, side]);
  const ref = useRef<HTMLDivElement>(null);
  const sections = SECTIONS[side];
  return (
    <div className="space-y-4 px-5 py-5" data-slot="contact-transactions" ref={ref}>
      <DropdownMenu>
        <DropdownMenuTrigger data-slot="tx-goto" className="inline-flex items-center gap-1 text-[17px] outline-none">
          Go to transactions <ChevronDown className="size-4 text-primary" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-52">
          {sections.map((s) => (
            <DropdownMenuItem key={s.kind} onClick={() => ref.current?.querySelector(`#tx-${s.kind}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>{s.label}</DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {state.loading && !state.data ? <LoadingRows /> : sections.map((s) => <TxBlock key={s.kind} s={s} rows={(state.data?.rows ?? []).filter((r) => r.kind === s.kind)} />)}
    </div>
  );
}

// ── Mails and Statement ─────────────────────────────────────────────────────

function Mails({ id }: { id: string }) {
  const state = useApi(() => contactActivity.mails(id), [id]);
  const mails = state.data?.mails ?? [];
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
            {mails.map((m) => (
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
    </div>
  );
}

function StatementTab({ id, side }: { id: string; side: Side }) {
  const [range, setRange] = useReportRange();
  const state = useApi<PartyStatement>(() => contacts.statement(id, { side, from: range.from, to: range.to }), [id, side, range.from, range.to]);
  const mail = useApi(() => api.get<{ configured: boolean }>('/api/email', { docType: 'statement', docId: id }), [id]);
  const [sending, setSending] = useState(false);
  const base = side === 'customer' ? `/sales/customers/${id}` : `/purchases/vendors/${id}`;
  const send = async () => {
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
  const icon = 'grid h-[33px] w-9 place-items-center rounded-[var(--radius-button)] border border-secondary-border bg-secondary hover:brightness-[0.98]';
  return (
    <div className="space-y-5 px-5 py-5" data-slot="contact-statement">
      <div className="flex flex-wrap items-center gap-2">
        <DateRangePicker value={range} onChange={setRange} align="start" />
        <span className="ml-auto flex items-center gap-2">
          <Link href={`${base}/statement?from=${range.from}&to=${range.to}`} aria-label="Print" title="Print" className={icon}><Printer className="size-4" /></Link>
          <Link href={`${base}/statement?from=${range.from}&to=${range.to}`} aria-label="PDF" title="PDF" className={icon}><FileText className="size-4" /></Link>
          <button type="button" aria-label="Excel" title="Excel" className={icon} disabled={!state.data}
            onClick={() => state.data && downloadWorkbook(`statement-${state.data.party.name}-${range.from}-${range.to}`, [statementSheet(state.data)])}>
            <FileSpreadsheet className="size-4" />
          </button>
          {mail.data?.configured && <Button size="sm" disabled={!state.data || sending} onClick={() => void send()} data-slot="statement-send">{sending ? 'Sending…' : 'Send Email'}</Button>}
        </span>
      </div>
      <AsyncPage state={state} loading={<LoadingRows rows={6} />}>
        {(s) => (
          <>
            <div className="text-center">
              <p className="text-[17px]">{side === 'customer' ? 'Customer' : 'Vendor'} Statement for {s.party.name}</p>
              <p className="text-[13px] text-muted-foreground">From {day(range.from)} To {day(range.to)}</p>
            </div>
            <StatementPrint s={s} backHref={base} bare />
          </>
        )}
      </AsyncPage>
    </div>
  );
}

// ── The header and the page ─────────────────────────────────────────────────

function BankDialog({ d, open, onOpenChange, onSaved }: { d: ContactDetail; open: boolean; onOpenChange: (o: boolean) => void; onSaved: () => void }) {
  const c = d.contact;
  const [f, setF] = useState({ bankAccountName: c.bankAccountName ?? '', bankName: c.bankName ?? '', bankAccountNo: '', bankIfsc: c.bankIfsc ?? '' });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await contacts.update({ id: c.id, expectedUpdatedAt: c.updatedAt, bankAccountName: f.bankAccountName || null, bankName: f.bankName || null, bankIfsc: f.bankIfsc || null, ...(f.bankAccountNo ? { bankAccountNo: f.bankAccountNo } : {}) });
      toast.success('Bank account saved');
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
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>Add Bank Account</DialogTitle><DialogDescription>Where payments to or from {c.displayName} go.</DialogDescription></DialogHeader>
        <div className="space-y-3 text-[13px]">
          {([['bankAccountName', 'Account Holder Name'], ['bankName', 'Bank Name'], ['bankAccountNo', c.bankAccountNo ? `Account Number (on file: ${c.bankAccountNo})` : 'Account Number'], ['bankIfsc', 'IFSC']] as const).map(([k, l]) => (
            <label key={k} className="block space-y-1"><span className="text-muted-foreground">{l}</span>
              <Input value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} aria-label={l} />
            </label>
          ))}
        </div>
        <DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Header({ d, side, onChanged }: { d: ContactDetail; side: Side; onChanged: () => void }) {
  const router = useRouter();
  const c = d.contact;
  const area = side === 'customer' ? 'sales' : 'purchases';
  const base = side === 'customer' ? '/sales/customers' : '/purchases/vendors';
  const canCreate = usePermission(area, 'create');
  const canEdit = usePermission(area, 'edit');
  const canDelete = usePermission(area, 'void');
  const [dialog, setDialog] = useState<null | 'portal' | 'bank' | 'merge' | 'delete'>(null);
  const [busy, setBusy] = useState(false);
  usePublishPageTitle(c.displayName);

  const act = async (what: string, call: () => Promise<unknown>, after?: () => void) => {
    setBusy(true);
    try { await call(); toast.success(what); refreshSplitList(); if (after) after(); else onChanged(); }
    catch (e) { toast.error('Not done', { description: e instanceof Error ? e.message : String(e) }); }
    finally { setBusy(false); }
  };
  const other = side === 'customer' ? 'Vendor' : 'Customer';
  return (
    <div data-slot="contact-header" className="-mx-6 -mt-5 flex min-h-[65px] items-center gap-3 border-b py-3 pl-5 pr-[3.75rem]">
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        {c.contactType === 'individual' ? <User className="size-5 shrink-0" /> : <Building2 className="size-5 shrink-0" />}
        <h1 className="truncate text-[22px] font-normal leading-tight" data-slot="contact-title">{c.displayName}</h1>
        {c.isArchived && <StatusBadge status="inactive" />}
      </div>
      <div className="flex shrink-0 items-center gap-2 no-print">
        {canEdit && <Button variant="outline" size="sm" asChild><Link href={`${base}/${c.id}/edit`} data-slot="contact-edit">Edit</Link></Button>}
        <Popover>
          <PopoverTrigger aria-label="Attachments" title="Attachments" data-slot="contact-attachments"
            className="grid h-[33px] w-9 place-items-center rounded-[var(--radius-button)] border border-secondary-border bg-secondary hover:brightness-[0.98]">
            <Paperclip className="size-4" />
          </PopoverTrigger>
          <PopoverContent align="end" className="w-96">
            <Attachments targetType="contact" targetId={c.id} canEdit={canEdit} title="Attachments" />
          </PopoverContent>
        </Popover>
        {(canEdit || canCreate || canDelete) && (
          <DropdownMenu>
            <DropdownMenuTrigger data-slot="contact-more" disabled={busy}
              className="inline-flex h-[33px] items-center gap-1 rounded-[var(--radius-button)] border border-secondary-border bg-secondary px-2.5 text-[13px] outline-none hover:brightness-[0.98]">
              More <ChevronDown className="size-3.5" strokeWidth={2.2} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-52">
              {side === 'customer' && canEdit && <DropdownMenuItem onClick={() => setDialog('portal')}>Configure Customer Portal</DropdownMenuItem>}
              {canEdit && <DropdownMenuItem onClick={() => setDialog('bank')}>Add Bank Account</DropdownMenuItem>}
              {canEdit && c.kind !== 'both' && (
                <DropdownMenuItem onClick={() => void act(`${c.displayName} is a ${other.toLowerCase()} too`, () => contacts.update({ id: c.id, kind: 'both', expectedUpdatedAt: c.updatedAt }))}>Link to {other}</DropdownMenuItem>
              )}
              {canCreate && <DropdownMenuItem onClick={() => router.push(`${base}/new?clone=${c.id}`)} data-slot="contact-clone">Clone</DropdownMenuItem>}
              {canEdit && !c.mergedIntoId && <DropdownMenuItem onClick={() => setDialog('merge')}>Merge {side === 'customer' ? 'Customers' : 'Vendors'}</DropdownMenuItem>}
              {canEdit && (
                <DropdownMenuItem data-slot="contact-toggle-active"
                  onClick={() => void act(c.isArchived ? `${c.displayName} is active again` : `${c.displayName} is marked as inactive`, () => contacts.update({ id: c.id, isArchived: !c.isArchived, expectedUpdatedAt: c.updatedAt }))}>
                  {c.isArchived ? 'Mark as Active' : 'Mark as Inactive'}
                </DropdownMenuItem>
              )}
              {canDelete && <DropdownMenuItem onClick={() => setDialog('delete')} data-slot="contact-delete">Delete</DropdownMenuItem>}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      <Dialog open={dialog === 'portal'} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader><DialogTitle>Configure Customer Portal</DialogTitle><DialogDescription>A link {c.displayName} opens to see and pay their invoices.</DialogDescription></DialogHeader>
          <PortalAccess contactId={c.id} side={side} defaultEmail={c.email ?? null} canEdit={canEdit} />
        </DialogContent>
      </Dialog>
      {dialog === 'bank' && <BankDialog d={d} open onOpenChange={(o) => !o && setDialog(null)} onSaved={onChanged} />}
      <MergeContactButton contactId={c.id} name={c.displayName} side={side} open={dialog === 'merge'} onOpenChange={(o) => setDialog(o ? 'merge' : null)} />
      <Dialog open={dialog === 'delete'} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete {c.displayName}?</DialogTitle>
            <DialogDescription>Only a {side} never used can be deleted. One on a document or a payment is kept: mark it as inactive instead.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialog(null)}>Cancel</Button>
            <Button variant="destructive" disabled={busy} data-slot="contact-delete-confirm"
              onClick={() => void act(`${c.displayName} deleted`, () => contacts.remove(c.id), () => router.push(base)).then(() => setDialog(null))}>
              {busy ? 'Deleting…' : 'Delete'}
            </Button>
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
            <TabsContent value="overview"><Overview d={d} side={side} canEdit={canEdit} /></TabsContent>
            <TabsContent value="comments"><div className="px-5 py-5"><ActivityPanel targetType="contact" targetId={d.contact.id} /></div></TabsContent>
            <TabsContent value="transactions"><Transactions id={d.contact.id} side={side} /></TabsContent>
            <TabsContent value="mails"><Mails id={d.contact.id} /></TabsContent>
            <TabsContent value="statement"><StatementTab id={d.contact.id} side={side} /></TabsContent>
          </Tabs>
        </>
      )}
    </AsyncPage>
  );
}
