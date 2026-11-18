'use client';

// The customer (or vendor) list, as Zoho Books has it.
//
// Title views: All, Active, Duplicate, Inactive, Portal Enabled, Portal
// Disabled, Overdue, Unpaid (Zoho's CRM views need Zoho CRM and are left out),
// with the custom views under "Created by me" and "New View". Zoho's columns:
// Name, Company Name, Email, Work Phone, Receivables (Payables), Unused
// Credits; Rekonza's own wait under Customize Columns. Its ⋯: Sort by, Import,
// Export (the current view too), Preferences, Refresh List, Reset Column Width.
// Ticked rows: Print Customer Statements, Mark as Active, Mark as Inactive,
// Merge, Request GST Information, and More → Delete.

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, MoreHorizontal, Plus, Users } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSub, DropdownMenuSubContent,
  DropdownMenuSubTrigger, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { PageHeader } from '@/components/shared/page-header';
import { DataTable, resetColumnWidths, type Column } from '@/components/shared/data-table';
import { Money } from '@/components/shared/money';
import { EmptyState } from '@/components/shared/empty-state';
import { AsyncPage } from '@/components/shared/async-state';
import { ExportDialog, ExportViewDialog, type ExportModule } from '@/components/shared/export-dialog';
import { contains, type AdvancedSearchConfig } from '@/components/shared/advanced-search';
import { ImportContactsDialog } from '@/components/contacts/contact-import';
import { api, contactPersons, contacts, type ContactRow } from '@/lib/api/client';
import type { Sheet } from '@/lib/xlsx';
import { useApi } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';
import { stateName } from '@/lib/tax/gst';
import type { ViewField } from '@/lib/custom-views';

type Side = 'customer' | 'vendor';
type SortKey = 'name' | 'company' | 'balance' | 'unused' | 'created' | 'updated';

const TERMS: Record<string, string> = { due_on_receipt: 'Due on receipt', net_15: 'Net 15', net_30: 'Net 30', net_45: 'Net 45', net_60: 'Net 60' };
const TREATMENT: Record<string, string> = {
  registered: 'Registered Business - Regular', registered_composition: 'Registered Business - Composition', unregistered: 'Unregistered Business',
  consumer: 'Consumer', overseas: 'Overseas', sez: 'Special Economic Zone', sez_developer: 'SEZ Developer', deemed_export: 'Deemed Export', uin: 'UIN Holder',
};

export function ContactList({ side }: { side: Side }) {
  const router = useRouter();
  const customer = side === 'customer';
  const noun = customer ? 'Customer' : 'Vendor';
  const nouns = `${noun}s`;
  const base = customer ? '/sales/customers' : '/purchases/vendors';
  const area = customer ? 'sales' : 'purchases';
  const canCreate = usePermission(area, 'create');
  const canEdit = usePermission(area, 'edit');
  const canDelete = usePermission(area, 'void');
  const canImport = usePermission('accountant', 'view');
  const canExport = usePermission(area, 'export');
  const balanceOf = (c: ContactRow) => (customer ? c.receivablePaise : c.payablePaise);
  const unusedOf = (c: ContactRow) => (customer ? c.unusedCreditsPaise : c.vendorUnusedCreditsPaise) ?? 0;
  const overdueOf = (c: ContactRow) => !!(customer ? c.overdue : c.vendorOverdue);

  // Every contact, inactive ones too, so the views switch without a reload.
  const state = useApi<{ contacts: ContactRow[] }>(() => contacts.list({ kind: side, archived: true }), [side]);
  const all = useMemo(() => state.data?.contacts ?? [], [state.data]);

  // The view chosen last in this tab, shared with the column beside an open record.
  const viewKey = `rekonza.view.${nouns.toLowerCase()}`;
  const [view, setViewState] = useState('active');
  const setView = (v: string) => {
    setViewState(v);
    try { sessionStorage.setItem(viewKey, v); } catch { /* this page only */ }
  };
  useEffect(() => {
    try { const k = sessionStorage.getItem(viewKey); if (k) setViewState(k); } catch { /* Zoho's default */ }
  }, [viewKey]);

  const VIEWS: { value: string; label: string; keep: (c: ContactRow) => boolean }[] = [
    { value: 'all', label: `All ${nouns}`, keep: () => true },
    { value: 'active', label: `Active ${nouns}`, keep: (c) => !c.isArchived },
    { value: 'duplicate', label: `Duplicate ${nouns}`, keep: (c) => !!c.duplicate },
    { value: 'inactive', label: `Inactive ${nouns}`, keep: (c) => c.isArchived },
    ...(customer ? [
      { value: 'portal_on', label: 'Client Portal Enabled', keep: (c: ContactRow) => !!c.portalEnabled },
      { value: 'portal_off', label: 'Client Portal Disabled', keep: (c: ContactRow) => !c.portalEnabled },
    ] : []),
    // Zoho's customers have Overdue and Unpaid; its vendors have Reorder Items instead.
    ...(customer ? [
      { value: 'overdue', label: `Overdue ${nouns}`, keep: (c: ContactRow) => overdueOf(c) },
      { value: 'unpaid', label: `Unpaid ${nouns}`, keep: (c: ContactRow) => balanceOf(c) > 0 },
    ] : [
      { value: 'reorder', label: 'Vendors - Reorder Items', keep: (c: ContactRow) => !!c.reorder },
    ]),
  ];
  const current = VIEWS.find((v) => v.value === view) ?? VIEWS[1];
  const tabs = VIEWS.map((v) => ({ value: v.value, label: v.label, title: v.label, count: all.filter(v.keep).length }));

  const SORTS: { key: SortKey; label: string; value: (c: ContactRow) => string | number }[] = [
    { key: 'name', label: 'Name', value: (c) => c.displayName.toLowerCase() },
    { key: 'company', label: 'Company Name', value: (c) => (c.legalName ?? '').toLowerCase() },
    { key: 'balance', label: customer ? 'Receivables' : 'Payables', value: balanceOf },
    { key: 'unused', label: 'Unused Credits', value: unusedOf },
    { key: 'created', label: 'Created Time', value: (c) => c.createdAt ?? '' },
    { key: 'updated', label: 'Last Modified Time', value: (c) => c.updatedAt ?? '' },
  ];
  const [sortBy, setSortBy] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'name', dir: 'asc' });
  const chooseSort = (key: SortKey) => setSortBy((s) => ({ key, dir: s.key === key && s.dir === 'asc' ? 'desc' : 'asc' }));
  const rows = useMemo(() => {
    const s = SORTS.find((x) => x.key === sortBy.key)!;
    return all.filter(current.keep).sort((a, b) => {
      const va = s.value(a); const vb = s.value(b);
      const cmp = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb));
      return sortBy.dir === 'asc' ? cmp : -cmp;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, view, sortBy]);

  const columns: Column<ContactRow>[] = [
    { key: 'name', header: 'Name', sortValue: (c) => c.displayName, cell: (c) => <span className="font-medium">{c.displayName}</span> },
    { key: 'company', header: 'Company Name', sortValue: (c) => c.legalName ?? '', cell: (c) => c.legalName ?? '' },
    { key: 'email', header: 'Email', sortable: false, sortValue: (c) => c.email ?? '', cell: (c) => c.email ?? '' },
    { key: 'phone', header: 'Work Phone', sortable: false, sortValue: (c) => c.phone ?? '', cell: (c) => c.phone ?? '' },
    { key: 'balance', header: customer ? 'Receivables' : 'Payables', align: 'right', sortValue: balanceOf, cell: (c) => <Money value={balanceOf(c)} /> },
    { key: 'unused', header: 'Unused Credits', align: 'right', sortValue: unusedOf, cell: (c) => <Money value={unusedOf(c)} /> },
    // Rekonza's own, under Customize Columns.
    { key: 'mobile', header: 'Mobile', defaultHidden: true, sortable: false, sortValue: (c) => c.mobile ?? '', cell: (c) => c.mobile ?? '' },
    { key: 'gstin', header: 'GSTIN', defaultHidden: true, sortValue: (c) => c.gstin ?? '', cell: (c) => <span className="font-mono text-[12px]">{c.gstin ?? '—'}</span> },
    { key: 'treatment', header: 'GST Treatment', defaultHidden: true, sortValue: (c) => c.gstTreatment, cell: (c) => TREATMENT[c.gstTreatment] ?? c.gstTreatment },
    { key: 'state', header: 'Place of Supply', defaultHidden: true, sortValue: (c) => stateName(c.stateCode), cell: (c) => stateName(c.stateCode) },
    { key: 'terms', header: 'Payment Terms', defaultHidden: true, sortValue: (c) => c.paymentTerms ?? '', cell: (c) => TERMS[c.paymentTerms ?? ''] ?? c.paymentTerms ?? '' },
    { key: 'credit', header: 'Credit Limit', align: 'right', defaultHidden: true, sortValue: (c) => c.creditLimitPaise, cell: (c) => (c.creditLimitPaise ? <Money value={c.creditLimitPaise} /> : '—') },
    // A vendor's: whether its GST can be claimed, its TDS sections, and MSME.
    ...(!customer ? [
      { key: 'itc', header: 'ITC', defaultHidden: true, sortValue: (c: ContactRow) => c.gstTreatment, cell: (c: ContactRow) => (c.gstTreatment === 'registered_composition' || c.gstTreatment === 'unregistered' ? 'No credit' : 'Claimable') },
      { key: 'tds', header: 'TDS Sections', defaultHidden: true, sortValue: (c: ContactRow) => c.tdsSection ?? '', cell: (c: ContactRow) => (c.tdsSections?.length ? c.tdsSections.join(', ') : c.tdsSection ?? '—') },
      { key: 'msme', header: 'MSME', defaultHidden: true, sortValue: (c: ContactRow) => (c.isMsme ? 1 : 0), cell: (c: ContactRow) => (c.isMsme ? 'Yes' : '—') },
    ] : []),
  ];

  const viewFields: ViewField<ContactRow>[] = [
    { key: 'name', label: 'Name', type: 'text', value: (c) => c.displayName },
    { key: 'company', label: 'Company Name', type: 'text', value: (c) => c.legalName },
    { key: 'email', label: 'Email', type: 'text', value: (c) => c.email },
    { key: 'phone', label: 'Work Phone', type: 'text', value: (c) => c.phone },
    { key: 'mobile', label: 'Mobile', type: 'text', value: (c) => c.mobile },
    { key: 'gstin', label: 'GSTIN', type: 'text', value: (c) => c.gstin },
    { key: 'treatment', label: 'GST Treatment', type: 'choice', options: Object.values(TREATMENT), value: (c) => TREATMENT[c.gstTreatment] ?? c.gstTreatment },
    { key: 'state', label: 'Place of Supply', type: 'text', value: (c) => stateName(c.stateCode) },
    { key: 'balance', label: customer ? 'Receivables' : 'Payables', type: 'number', value: (c) => balanceOf(c) / 100 },
    { key: 'unused', label: 'Unused Credits', type: 'number', value: (c) => unusedOf(c) / 100 },
    { key: 'status', label: 'Status', type: 'choice', options: ['Active', 'Inactive'], value: (c) => (c.isArchived ? 'Inactive' : 'Active') },
    { key: 'created', label: 'Created Time', type: 'date', value: (c) => c.createdAt?.slice(0, 10) },
  ];

  // ── Bulk actions on the ticked rows.
  const [busy, setBusy] = useState(false);
  const [merging, setMerging] = useState<{ rows: ContactRow[]; clear: () => void; into: string } | null>(null);
  const [deleting, setDeleting] = useState<{ rows: ContactRow[]; clear: () => void } | null>(null);
  const runEach = async (todo: ContactRow[], what: string, act: (c: ContactRow) => Promise<unknown>) => {
    setBusy(true);
    const failed: string[] = [];
    for (const c of todo) {
      try { await act(c); } catch (e) { failed.push(`${c.displayName}: ${e instanceof Error ? e.message : String(e)}`); }
    }
    setBusy(false);
    const n = todo.length - failed.length;
    if (n) toast.success(`${n} ${n === 1 ? noun.toLowerCase() : nouns.toLowerCase()} ${what}`);
    if (failed.length) toast.error(`${failed.length} not changed`, { description: failed.slice(0, 3).join(' · ') });
    state.refetch();
  };
  const setActive = (picked: ContactRow[], clear: () => void, active: boolean) => {
    const todo = picked.filter((c) => c.isArchived === active);
    if (!todo.length) { toast.info(active ? 'They are all active already.' : 'They are all inactive already.'); return; }
    void runEach(todo, active ? 'marked as active' : 'marked as inactive', (c) => contacts.update({ id: c.id, isArchived: !active, expectedUpdatedAt: c.updatedAt })).then(clear);
  };
  const merge = async () => {
    if (!merging) return;
    const others = merging.rows.filter((c) => c.id !== merging.into);
    await runEach(others, 'merged', (c) => api.post(`/api/contacts/${c.id}/merge`, { intoId: merging.into }));
    merging.clear();
    setMerging(null);
  };
  const remove = async () => {
    if (!deleting) return;
    await runEach(deleting.rows, 'deleted', (c) => contacts.remove(c.id));
    deleting.clear();
    setDeleting(null);
  };
  /** Zoho's "Request GST Information": a mail to the ticked customers asking for their GSTIN and address. */
  const requestGst = (picked: ContactRow[]) => {
    const emails = picked.map((c) => c.email).filter(Boolean);
    if (!emails.length) { toast.error('None of them has an email address.'); return; }
    const subject = 'Please confirm your GST details';
    const body = customer
      ? 'Dear Customer,\n\nTo issue GST-compliant invoices, please reply with your GSTIN, legal name, billing address and place of supply.\n\nThank you.'
      : 'Dear Vendor,\n\nTo record your bills correctly and claim input credit, please reply with your GSTIN, legal name, billing address and source of supply.\n\nThank you.';
    window.location.href = `mailto:?bcc=${encodeURIComponent(emails.join(','))}&subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  };
  // ── Zoho's ⋯ → Import and Export, as dialogs.
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportingView, setExportingView] = useState(false);
  /** Export Current View: the view's rows and Zoho's visible columns. */
  const viewSheet = (): Sheet => ({
    name: current.label.slice(0, 31),
    rows: [
      ['Name', 'Company Name', 'Email', 'Work Phone', customer ? 'Receivables' : 'Payables', 'Unused Credits'],
      ...rows.map((c) => [c.displayName, c.legalName ?? '', c.email ?? '', c.phone ?? '', balanceOf(c) / 100, unusedOf(c) / 100]),
    ],
  });
  const inPeriod = (c: ContactRow, from: string | null, to: string | null) => !from || !to || ((c.createdAt ?? '').slice(0, 10) >= from && (c.createdAt ?? '').slice(0, 10) <= to);
  const exportModules: ExportModule[] = [
    {
      value: nouns.toLowerCase(), label: nouns,
      sheets: ({ from, to, pii }) => [{
        name: nouns,
        rows: [
          ['Display Name', 'Company Name', 'Salutation', 'First Name', 'Last Name', 'Email', 'Work Phone', 'Mobile', `${noun} Type`, 'GST Treatment', 'GSTIN', 'PAN',
            'Place of Supply', 'Currency', 'Payment Terms', customer ? 'Receivables' : 'Payables', 'Unused Credits', 'Credit Limit', 'Status', 'Website', 'Remarks', 'Created Time'],
          ...all.filter((c) => inPeriod(c, from, to)).map((c) => [
            c.displayName, c.legalName ?? '', c.salutation ?? '', c.firstName ?? '', c.lastName ?? '',
            pii ? c.email ?? '' : '', pii ? c.phone ?? '' : '', pii ? c.mobile ?? '' : '',
            c.contactType === 'individual' ? 'Individual' : 'Business', TREATMENT[c.gstTreatment] ?? c.gstTreatment, c.gstin ?? '', pii ? c.pan ?? '' : '',
            c.stateCode === '96' ? 'Foreign Country' : stateName(c.stateCode), c.currency ?? 'INR', TERMS[c.paymentTerms ?? ''] ?? c.paymentTerms ?? '',
            balanceOf(c) / 100, unusedOf(c) / 100, c.creditLimitPaise / 100, c.isArchived ? 'Inactive' : 'Active', c.website ?? '', c.notes ?? '', (c.createdAt ?? '').slice(0, 10),
          ]),
        ],
      }],
    },
    {
      value: 'contact-persons', label: `${noun}'s Contact Persons`,
      sheets: async ({ from, to, pii }) => {
        const out: (string | number)[][] = [['Display Name', 'Salutation', 'First Name', 'Last Name', 'Email Address', 'Work Phone', 'Mobile', 'Designation', 'Department', 'Primary']];
        for (const c of all.filter((x) => inPeriod(x, from, to))) {
          for (const p of (await contactPersons.list(c.id)).persons) {
            out.push([c.displayName, p.salutation ?? '', p.firstName ?? p.name, p.lastName ?? '', pii ? p.email ?? '' : '', pii ? p.phone ?? '' : '', pii ? p.mobile ?? '' : '', p.designation ?? '', p.department ?? '', p.isPrimary ? 'Yes' : 'No']);
          }
        }
        return [{ name: 'Contact Persons', rows: out }];
      },
    },
    {
      value: 'addresses', label: `${noun}'s Addresses`,
      sheets: ({ from, to, pii }) => [{
        name: 'Addresses',
        rows: [
          ['Display Name', 'Address Type', 'Attention', 'Address', 'Street 2', 'City', 'State', 'Pin Code', 'Country', 'Phone', 'Fax Number'],
          ...all.filter((c) => inPeriod(c, from, to)).flatMap((c) => (['billing', 'shipping'] as const).map((k) => [
            c.displayName, k === 'billing' ? 'Billing' : 'Shipping', c[`${k}Attention`] ?? '', (k === 'billing' ? c.billingAddress : c.shippingAddress) ?? '', c[`${k}Street2`] ?? '',
            c[`${k}City`] ?? '', c[`${k}State`] ?? '', c[`${k}Pincode`] ?? '', c[`${k}Country`] ?? '', pii ? c[`${k}Phone`] ?? '' : '', pii ? c[`${k}Fax`] ?? '' : '',
          ]).filter((r) => r.slice(2).some(Boolean))),
        ],
      }],
    },
  ];
  /** Zoho's advanced search: the magnifier at the end of the header row. */
  const advancedSearch: AdvancedSearchConfig<ContactRow> = {
    module: nouns,
    fields: [
      { key: 'name', label: 'Display Name', match: (c, v) => contains(c.displayName, v) },
      ...(customer ? [{ key: 'type', label: `${noun} Type`, options: [{ value: '', label: '' }, { value: 'business', label: 'Business' }, { value: 'individual', label: 'Individual' }], match: (c: ContactRow, v: string) => (c.contactType ?? 'business') === v }] : []),
      { key: 'company', label: 'Company Name', match: (c, v) => contains(c.legalName, v) },
      { key: 'first', label: 'First Name', match: (c, v) => contains(c.firstName, v) },
      { key: 'last', label: 'Last Name', match: (c, v) => contains(c.lastName, v) },
      { key: 'email', label: 'Email', match: (c, v) => contains(c.email, v) },
      { key: 'status', label: 'Status', options: [{ value: '', label: 'All' }, { value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }], match: (c, v) => (v === 'active' ? !c.isArchived : c.isArchived) },
      { key: 'phone', label: 'Phone', match: (c, v) => contains(`${c.phone ?? ''} ${c.mobile ?? ''}`, v) },
      { key: 'address', label: 'Address', match: (c, v) => contains([c.billingAddress, c.billingStreet2, c.billingCity, c.billingState, c.billingPincode, c.shippingAddress, c.shippingCity].join(' '), v) },
      { key: 'pan', label: 'PAN', match: (c, v) => contains(c.pan, v) },
      { key: 'notes', label: 'Notes', match: (c, v) => contains(c.notes, v) },
    ],
  };

  return (
    <>
      <PageHeader
        title={nouns}
        description={customer ? 'A customer’s state decides whether their invoices carry CGST+SGST or IGST.' : 'A vendor’s state decides whether their bills carry CGST+SGST or IGST.'}
        actions={
          <div className="flex gap-2">
            {canCreate && (
              <Button size="sm" asChild className="gap-1.5">
                <Link href={`${base}/new`} data-slot="new-contact"><Plus className="size-4" /> New</Link>
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger aria-label="More" data-slot="contacts-more"
                className="grid size-[33px] place-items-center rounded-[var(--radius-button)] border border-secondary-border bg-secondary hover:brightness-[0.98]">
                <MoreHorizontal className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-52">
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger data-slot="contacts-sort">Sort by</DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="min-w-48">
                    {SORTS.map((s) => (
                      <DropdownMenuItem key={s.key} onClick={() => chooseSort(s.key)} data-slot="contacts-sort-option" data-value={s.key} className="justify-between">
                        {s.label}
                        {sortBy.key === s.key && (sortBy.dir === 'asc' ? <ArrowUp className="size-3.5 text-primary" /> : <ArrowDown className="size-3.5 text-primary" />)}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                {canImport && (
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>Import</DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="min-w-48">
                      <DropdownMenuItem onClick={() => setImporting(true)} data-slot="contacts-import">Import {nouns}</DropdownMenuItem>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                )}
                {(canImport || canExport) && (
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>Export</DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="min-w-48">
                      {canExport && <DropdownMenuItem onClick={() => setExporting(true)} data-slot="contacts-export">Export {nouns}</DropdownMenuItem>}
                      {canExport && <DropdownMenuItem onClick={() => setExportingView(true)} data-slot="contacts-export-view">Export Current View</DropdownMenuItem>}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                )}
                <DropdownMenuItem onClick={() => router.push('/settings?tab=policies')}>Preferences</DropdownMenuItem>
                <DropdownMenuItem onClick={() => state.refetch()}>Refresh List</DropdownMenuItem>
                <DropdownMenuItem onClick={resetColumnWidths}>Reset Column Width</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        }
      />
      <AsyncPage state={state}>
        {(d) =>
          d.contacts.length === 0 ? (
            <EmptyState icon={Users} title={`No ${nouns.toLowerCase()} yet`} description={customer ? 'Add your first customer to start invoicing.' : 'Add your first vendor to start recording bills.'} />
          ) : (
            <DataTable
              rows={rows}
              columns={columns}
              getRowId={(c) => c.id}
              onRowClick={(c) => router.push(`${base}/${c.id}`)}
              searchPlaceholder="Search name, GSTIN or email…"
              tabs={tabs}
              activeTab={current.value}
              onTabChange={setView}
              customViews={{ list: nouns.toLowerCase(), baseTab: 'all', fields: viewFields }}
              advancedSearch={advancedSearch}
              selectable={canEdit || canDelete}
              bulkActions={(picked, clear) => (
                <div className="flex flex-wrap gap-2" data-slot="contacts-bulk">
                  <Button size="sm" variant="outline" onClick={() => router.push(`${base}/statements?ids=${picked.map((c) => c.id).join(',')}`)}>
                    Print {noun} Statements
                  </Button>
                  {canEdit && <Button size="sm" variant="outline" disabled={busy} onClick={() => setActive(picked, clear, true)}>Mark as Active</Button>}
                  {canEdit && <Button size="sm" variant="outline" disabled={busy} onClick={() => setActive(picked, clear, false)}>Mark as Inactive</Button>}
                  {canEdit && (
                    <Button size="sm" variant="outline" disabled={busy || picked.length < 2}
                      onClick={() => setMerging({ rows: picked, clear, into: picked[0].id })}>Merge</Button>
                  )}
                  <Button size="sm" variant="outline" onClick={() => requestGst(picked)}>Request GST Information</Button>
                  {canDelete && (
                    <DropdownMenu>
                      <DropdownMenuTrigger data-slot="contacts-bulk-more"
                        className="inline-flex h-8 items-center gap-1 rounded-[var(--radius-button)] border border-secondary-border bg-secondary px-2.5 text-[13px] hover:brightness-[0.98]">
                        More Actions <ChevronDown className="size-3.5" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start" className="min-w-36">
                        <DropdownMenuItem onClick={() => setDeleting({ rows: picked, clear })}>Delete</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </div>
              )}
            />
          )
        }
      </AsyncPage>

      <Dialog open={!!merging} onOpenChange={(o) => !o && setMerging(null)}>
        <DialogContent className="sm:max-w-md" data-slot="merge-dialog">
          <DialogHeader>
            <DialogTitle>Merge {nouns}</DialogTitle>
            <DialogDescription>Choose the {noun.toLowerCase()} to keep. Everything recorded under the others moves to it, and they are closed.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2 text-[13px]">
            {merging?.rows.map((c) => (
              <label key={c.id} className="flex items-center gap-2">
                <input type="radio" name="merge-into" className="size-3.5 accent-primary" checked={merging.into === c.id} onChange={() => setMerging({ ...merging, into: c.id })} />
                {c.displayName}{c.gstin ? <span className="text-muted-foreground">· {c.gstin}</span> : null}
              </label>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMerging(null)}>Cancel</Button>
            <Button disabled={busy} onClick={() => void merge()} data-slot="merge-confirm">{busy ? 'Merging…' : 'Merge'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete {deleting?.rows.length} {deleting?.rows.length === 1 ? noun.toLowerCase() : nouns.toLowerCase()}?</DialogTitle>
            <DialogDescription>Only a {noun.toLowerCase()} never used is deleted. One on a document or a payment is kept: mark it as inactive instead.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)}>Cancel</Button>
            <Button variant="destructive" disabled={busy} onClick={() => void remove()}>{busy ? 'Deleting…' : 'Delete'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ImportContactsDialog side={side} open={importing} onOpenChange={setImporting} onDone={() => state.refetch()} />
      {exporting && <ExportDialog open onOpenChange={setExporting} title={`Export ${nouns}`} noun={nouns} modules={exportModules} filename={nouns.toLowerCase()} />}
      {exportingView && <ExportViewDialog open onOpenChange={setExportingView} filename={`${nouns.toLowerCase()}-${view}`} sheet={viewSheet} />}
    </>
  );
}
