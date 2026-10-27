'use client';

// The customer list, with each customer’s outstanding balance.
//
// The balance is aggregated in SQL rather than added up here. A book with ten
// thousand invoices should not ship all of them to the browser so it can total
// the ones belonging to each row.

import Link from 'next/link';
import { useRouter } from 'next/navigation';
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
    header: 'Customer',
    sortValue: (r) => r.displayName,
    cell: (r) => (
      <div>
        <p className="font-medium">{r.displayName}</p>
        <p className="text-xs text-muted-foreground">{r.email ?? r.phone ?? ''}</p>
      </div>
    ),
  },
  {
    key: 'gstin',
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
    header: 'Terms',
    sortValue: (r) => r.paymentTerms ?? '',
    cell: (r) => <span className="text-sm">{TERMS[r.paymentTerms ?? ''] ?? r.paymentTerms ?? '—'}</span>,
  },
  {
    key: 'limit',
    header: 'Credit limit',
    align: 'right',
    sortValue: (r) => r.creditLimitPaise,
    cell: (r) => (r.creditLimitPaise ? <Money value={r.creditLimitPaise} whole /> : <span className="text-muted-foreground">—</span>),
  },
  {
    key: 'outstanding',
    header: 'Outstanding',
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
  const state = useApi<{ contacts: ContactRow[] }>(() => contacts.list({ kind: 'customer' }), []);

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
              rows={d.contacts}
              columns={columns}
              getRowId={(r) => r.id}
              onRowClick={(r) => router.push(`/sales/customers/${r.id}`)}
              searchPlaceholder="Search name, GSTIN or state…"
            />
          )
        }
      </AsyncPage>
    </>
  );
}
