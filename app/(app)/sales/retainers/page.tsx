'use client';

// Service invoices — Zoho Books' Retainer Invoices, under the name the client
// asked for (their item 24). Zoho's list (recorded 2026-11-23): DATE | SERVICE
// INVOICE NUMBER | REFERENCE# | CUSTOMER NAME | PROJECT/ESTIMATE | STATUS |
// AMOUNT | BALANCE; a row opens beside the list, New opens the full form.
//
// Money taken before the work is done is a liability, not income: a retainer
// sits in unearned revenue until it is applied to a real invoice.

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { HandCoins, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/shared/page-header';
import { ModuleMenu } from '@/components/shared/module-menu';
import { DataTable, type Column } from '@/components/shared/data-table';
import { BulkPrintButton } from '@/components/shared/document-menu';
import { Money } from '@/components/shared/money';
import { StatusBadge } from '@/components/shared/status-badge';
import { EmptyState } from '@/components/shared/empty-state';
import { AsyncPage } from '@/components/shared/async-state';
import { salesDocuments, type SalesDocListResponse, type SalesDocRow } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';

const day = (s: string) => new Date(`${s.slice(0, 10)}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

export default function RetainersPage() {
  const router = useRouter();
  const canCreate = usePermission('sales', 'create');
  const state = useApi<SalesDocListResponse>(() => salesDocuments.list('retainer', { limit: 500 }), []);

  const columns: Column<SalesDocRow>[] = [
    { key: 'date', header: 'Date', sortValue: (r) => r.date, cell: (r) => day(r.date) },
    { key: 'number', header: 'Service Invoice Number', sortValue: (r) => r.number, cell: (r) => <span className="font-medium text-link">{r.number}</span> },
    { key: 'ref', header: 'Reference#', sortValue: (r) => r.reference ?? '', cell: (r) => r.reference ?? '' },
    { key: 'customer', header: 'Customer Name', sortValue: (r) => r.customerName, cell: (r) => r.customerName },
    { key: 'project', header: 'Project/Estimate', sortValue: (r) => r.linkedNumber ?? '', cell: (r) => r.linkedNumber ?? '' },
    { key: 'status', header: 'Status', sortValue: (r) => r.status, cell: (r) => <StatusBadge status={r.status} /> },
    { key: 'amount', header: 'Amount', align: 'right', sortValue: (r) => r.totalPaise, cell: (r) => <Money value={r.totalPaise} className="font-medium" /> },
    { key: 'balance', header: 'Balance', align: 'right', sortValue: (r) => r.totalPaise - (r.paidPaise ?? 0), cell: (r) => <Money value={Math.max(0, r.totalPaise - (r.paidPaise ?? 0))} /> },
  ];

  return (
    <>
      <PageHeader
        title="Service Invoices"
        description="Advances collected before the work is done: a liability until applied to an invoice."
        actions={
          <>
            {canCreate && (
              <Button size="sm" asChild className="gap-1.5"><Link href="/sales/retainers/new"><Plus className="size-4" /> New</Link></Button>
            )}
            <ModuleMenu slug="retainers" onRefresh={() => void state.refetch()} />
          </>
        }
      />
      <AsyncPage state={state}>
        {(data) => data.documents.length === 0 ? (
          <EmptyState icon={HandCoins} title="No service invoices yet" description="Raise one to collect an advance before the work begins."
            action={canCreate ? <Button asChild><Link href="/sales/retainers/new">New Service Invoice</Link></Button> : undefined} />
        ) : (
          <DataTable
            rows={data.documents}
            columns={columns}
            getRowId={(r) => r.id}
            selectable
            bulkActions={(selected) => <BulkPrintButton kind="retainer" ids={selected.map((r) => r.id)} />}
            initialSort={{ key: 'date', dir: 'desc' }}
            searchPlaceholder="Search number, reference or customer…"
            onRowClick={(r) => router.push(`/sales/retainers/${r.id}`)}
          />
        )}
      </AsyncPage>
    </>
  );
}
