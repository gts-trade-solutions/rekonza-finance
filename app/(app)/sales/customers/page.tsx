'use client';

// The customer list, with each customer’s outstanding balance.
//
// The balance is aggregated in SQL rather than added up here. A book with ten
// thousand invoices should not ship all of them to the browser so it can total
// the ones belonging to each row.
//
// Laid out as Zoho Books' customer list: the views "Active Customers",
// "Inactive Customers" and "All Customers" in the title, and Zoho's columns —
// Name, Company Name, Email, Work Phone, Receivables. GSTIN, state, terms and
// credit limit are a click away under Customize Columns.

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { Plus, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { PageHeader } from '@/components/shared/page-header';
import { DataTable, type Column } from '@/components/shared/data-table';
import { Money } from '@/components/shared/money';
import { EmptyState } from '@/components/shared/empty-state';
import { AsyncPage } from '@/components/shared/async-state';
import { contacts, type ContactRow } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';
import { stateName } from '@/lib/tax/gst';

const TERMS: Record<string, string> = {
  due_on_receipt: 'Due on receipt',
  net_15: 'Net 15',
  net_30: 'Net 30',
  net_45: 'Net 45',
  net_60: 'Net 60',
};

const columns: Column<ContactRow>[] = [
  {
    key: 'name',
    header: 'Name',
    sortValue: (r) => r.displayName,
    cell: (r) => (
      <span className="font-medium">
        {r.displayName}
        {r.isArchived && <span className="ml-2 text-[11px] font-medium uppercase text-void">Inactive</span>}
      </span>
    ),
  },
  {
    key: 'company',
    header: 'Company Name',
    sortValue: (r) => r.legalName ?? '',
    cell: (r) => <span>{r.legalName ?? ''}</span>,
  },
  { key: 'email', header: 'Email', sortValue: (r) => r.email ?? '', cell: (r) => <span>{r.email ?? ''}</span> },
  { key: 'phone', header: 'Work Phone', sortValue: (r) => r.phone ?? '', cell: (r) => <span>{r.phone ?? ''}</span> },
  {
    key: 'gstin',
    defaultHidden: true,
    header: 'GSTIN / Treatment',
    sortValue: (r) => r.gstin ?? r.gstTreatment,
    cell: (r) =>
      r.gstin ? (
        <span className="font-mono text-xs">{r.gstin}</span>
      ) : (
        <Badge variant="secondary" className="text-[10px] capitalize">
          {r.gstTreatment.replace(/_/g, ' ')}
        </Badge>
      ),
  },
  {
    key: 'state',
    defaultHidden: true,
    header: 'State',
    sortValue: (r) => stateName(r.stateCode),
    cell: (r) => (
      <span className="text-sm">
        {stateName(r.stateCode)}
        <span className="ml-1 text-xs text-muted-foreground">({r.stateCode})</span>
      </span>
    ),
  },
  {
    key: 'terms',
    defaultHidden: true,
    header: 'Terms',
    sortValue: (r) => r.paymentTerms ?? '',
    cell: (r) => <span className="text-sm">{TERMS[r.paymentTerms ?? ''] ?? r.paymentTerms ?? '—'}</span>,
  },
  {
    key: 'limit',
    defaultHidden: true,
    header: 'Credit limit',
    align: 'right',
    sortValue: (r) => r.creditLimitPaise,
    cell: (r) => (r.creditLimitPaise ? <Money value={r.creditLimitPaise} whole /> : <span className="text-muted-foreground">—</span>),
  },
  {
    key: 'outstanding',
    header: 'Receivables',
    align: 'right',
    sortValue: (r) => r.receivablePaise,
    cell: (r) => {
      const over = r.creditLimitPaise > 0 && r.receivablePaise > r.creditLimitPaise;
      return (
        <div className="flex items-center justify-end gap-1.5">
          {over && (
            <Badge variant="outline" className="border-red-500/40 text-[10px] text-red-600 dark:text-red-400">
              Over limit
            </Badge>
          )}
          <Money value={r.receivablePaise} className={r.receivablePaise > 0 ? 'font-medium' : 'text-muted-foreground'} />
        </div>
      );
    },
  },
];

export default function CustomersPage() {
  const router = useRouter();
  const canCreate = usePermission('sales', 'create');
  // Every customer, archived ones too, so the views can switch without a reload.
  const state = useApi<{ contacts: ContactRow[] }>(() => contacts.list({ kind: 'customer', archived: true }), []);
  const [view, setView] = useState('active');
  const all = useMemo(() => state.data?.contacts ?? [], [state.data]);
  const tabs = useMemo(() => [
    { value: 'active', label: 'Active', count: all.filter((c) => !c.isArchived).length },
    { value: 'inactive', label: 'Inactive', count: all.filter((c) => c.isArchived).length },
    { value: 'all', label: 'All', count: all.length },
  ], [all]);
  const rows = view === 'all' ? all : all.filter((c) => (view === 'inactive' ? c.isArchived : !c.isArchived));

  return (
    <>
      <PageHeader
        title="Customers"
        description="A customer’s state decides whether their invoices carry CGST+SGST or IGST."
        actions={
          canCreate && (
            <Button size="sm" asChild className="gap-1.5">
              <Link href="/sales/customers/new">
                <Plus className="size-4" /> New customer
              </Link>
            </Button>
          )
        }
      />
      <AsyncPage state={state}>
        {(d) =>
          d.contacts.length === 0 ? (
            <EmptyState icon={Users} title="No customers yet" description="Add your first customer to start invoicing." />
          ) : (
            <DataTable
              rows={rows}
              columns={columns}
              getRowId={(r) => r.id}
              onRowClick={(r) => router.push(`/sales/customers/${r.id}`)}
              searchPlaceholder="Search name, GSTIN or state…"
              tabs={tabs}
              activeTab={view}
              onTabChange={setView}
            />
          )
        }
      </AsyncPage>
    </>
  );
}
