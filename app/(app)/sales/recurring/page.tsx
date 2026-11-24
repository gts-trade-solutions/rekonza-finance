'use client';

// Recurring Invoices, as Zoho Books lists them (recorded 2026-11-23): CUSTOMER
// NAME | PROFILE NAME | FREQUENCY | LAST INVOICE DATE | NEXT INVOICE DATE |
// STATUS | AMOUNT; a row opens the profile beside the list, New opens the
// full form (/sales/recurring/new).
//
// Links already sent out keep working: ?invoice= (an invoice's Make
// Recurring), ?from=form (the New Invoice form's Make Recurring) and ?new=1
// (the invoice list's New ▾) go on to the form with the same query.

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect } from 'react';
import { Plus, Repeat } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/shared/page-header';
import { DataTable, type Column } from '@/components/shared/data-table';
import { Money } from '@/components/shared/money';
import { StatusBadge } from '@/components/shared/status-badge';
import { EmptyState } from '@/components/shared/empty-state';
import { AsyncPage } from '@/components/shared/async-state';
import { recurringInvoices, type RecurringInvoiceRow } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';

const day = (s: string | null) => (s ? new Date(`${s.slice(0, 10)}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '');

function RecurringList() {
  const router = useRouter();
  const params = useSearchParams();
  const canCreate = usePermission('sales', 'create');
  const handoff = params.get('invoice') || params.get('from') || params.get('new');
  useEffect(() => {
    if (handoff) router.replace(`/sales/recurring/new?${params.toString()}`);
  }, [handoff, params, router]);
  const state = useApi<{ profiles: RecurringInvoiceRow[] }>(() => recurringInvoices.list(), []);

  const columns: Column<RecurringInvoiceRow>[] = [
    { key: 'customer', header: 'Customer Name', sortValue: (r) => r.customerName, cell: (r) => r.customerName },
    { key: 'name', header: 'Profile Name', sortValue: (r) => r.name, cell: (r) => <span className="font-medium text-link">{r.name}</span> },
    { key: 'frequency', header: 'Frequency', sortValue: (r) => r.repeatLabel ?? r.frequency, cell: (r) => r.repeatLabel ?? r.frequency },
    { key: 'last', header: 'Last Invoice Date', sortValue: (r) => r.lastGeneratedAt ?? '', cell: (r) => day(r.lastGeneratedAt) },
    { key: 'next', header: 'Next Invoice Date', sortValue: (r) => r.nextRun, cell: (r) => (r.status === 'active' ? day(r.nextRun) : '') },
    { key: 'status', header: 'Status', sortValue: (r) => r.status ?? '', cell: (r) => <StatusBadge status={r.status ?? (r.isActive ? 'active' : 'stopped')} /> },
    { key: 'amount', header: 'Amount', align: 'right', sortValue: (r) => r.totalPaise, cell: (r) => <Money value={r.totalPaise} className="font-medium" /> },
  ];

  if (handoff) return null;
  return (
    <>
      <PageHeader
        title="Recurring Invoices"
        description="Profiles that create an invoice on every date they repeat."
        actions={canCreate && <Button size="sm" asChild className="gap-1.5"><Link href="/sales/recurring/new"><Plus className="size-4" /> New</Link></Button>}
      />
      <AsyncPage state={state}>
        {(data) => data.profiles.length === 0 ? (
          <EmptyState icon={Repeat} title="No recurring invoices yet" description="Create a profile once and an invoice is made on every date it repeats."
            action={canCreate ? <Button asChild><Link href="/sales/recurring/new">New Recurring Invoice</Link></Button> : undefined} />
        ) : (
          <DataTable
            rows={data.profiles}
            columns={columns}
            getRowId={(r) => r.id}
            initialSort={{ key: 'next', dir: 'asc' }}
            searchPlaceholder="Search profile or customer…"
            onRowClick={(r) => router.push(`/sales/recurring/${r.id}`)}
          />
        )}
      </AsyncPage>
    </>
  );
}

export default function RecurringPage() {
  return <Suspense><RecurringList /></Suspense>;
}
