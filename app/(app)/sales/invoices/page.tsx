'use client';

// The invoice list, served by the API rather than the local store.
//
// Filtering and totals happen in SQL. The demo held every invoice in memory
// because there were thirty of them; a real book has tens of thousands, and
// shipping them all to the browser to filter would be slow long before it was
// wrong. The date range and status tab go to the server as query parameters,
// and the summary tiles come back describing the same filtered set — so the
// figures above the table always describe the table.

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { Download, FileCheck2, Plus, Receipt, Send } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/shared/page-header';
import { DataTable, type Column } from '@/components/shared/data-table';
import { Money } from '@/components/shared/money';
import { StatusBadge } from '@/components/shared/status-badge';
import { EInvoiceMark } from '@/components/shared/einvoice-mark';
import { EmptyState } from '@/components/shared/empty-state';
import { AsyncPage, LoadingRows, Refreshing } from '@/components/shared/async-state';
import { usePermission } from '@/lib/store/hooks';
import { ALL_TIME, type RangeValue } from '@/lib/date-range';
import { formatINRCompact, toRupees } from '@/lib/money';
import { downloadCsv } from '@/components/shared/report-shell';
import { invoices as invoiceApi, type InvoiceListItem, type InvoiceListResponse } from '@/lib/api/client';
import { useApi, useApiAction } from '@/lib/api/use-api';

const FILTERS = ['all', 'draft', 'sent', 'partially_paid', 'overdue', 'paid', 'void'] as const;

const TAB_LABEL: Record<(typeof FILTERS)[number], string> = {
  all: 'All',
  draft: 'Draft',
  sent: 'Sent',
  partially_paid: 'Partially Paid',
  overdue: 'Overdue',
  paid: 'Paid',
  void: 'Void',
};

export default function InvoicesPage() {
  const router = useRouter();
  const canCreate = usePermission('sales', 'create');
  const canEdit = usePermission('sales', 'edit');

  const [filter, setFilter] = useState<string>('all');
  const [range, setRange] = useState<RangeValue>(() => ({ ...ALL_TIME, mode: 'all' }));

  // Refetched whenever the filter or the period changes, because both are
  // applied by the database rather than in the browser.
  const state = useApi<InvoiceListResponse>(
    () =>
      invoiceApi.list({
        status: filter === 'all' ? undefined : filter,
        from: range.mode === 'all' ? undefined : range.from,
        to: range.mode === 'all' ? undefined : range.to,
        limit: 500,
      }),
    [filter, range.from, range.to, range.mode],
  );

  const send = useApiAction(invoiceApi.send);

  // Tab counts come back with the data, over the same period and ignoring the
  // status filter. A second request for them could land out of order and show
  // counts for a period the table is no longer displaying.
  const tabs = useMemo(() => {
    const counts = state.data?.statusCounts ?? {};
    return FILTERS.map((f) => ({
      value: f,
      label: TAB_LABEL[f],
      count: counts[f] ?? 0,
    })).filter((t) => t.value === 'all' || t.count > 0);
  }, [state.data]);

  const columns: Column<InvoiceListItem>[] = [
    {
      key: 'number',
      header: 'Invoice #',
      sortValue: (r) => r.number,
      cell: (r) => (
        <div className="flex items-center gap-1.5">
          <span className="font-medium">{r.number}</span>
          <EInvoiceMark einvoice={{ status: r.einvoice.status as never, irn: r.einvoice.irn ?? undefined }} />
        </div>
      ),
    },
    { key: 'customer', header: 'Customer', sortValue: (r) => r.customerName, cell: (r) => r.customerName },
    {
      key: 'date',
      header: 'Date',
      sortValue: (r) => r.date,
      cell: (r) => new Date(r.date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' }),
    },
    {
      key: 'due',
      header: 'Due',
      sortValue: (r) => r.dueDate,
      cell: (r) => new Date(r.dueDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' }),
    },
    {
      key: 'supply',
      header: 'Supply',
      sortValue: (r) => r.supplyType,
      cell: (r) => (
        <span className="text-xs uppercase text-muted-foreground">
          {r.supplyType === 'intra' ? 'CGST+SGST' : r.supplyType === 'inter' ? 'IGST' : r.supplyType.replace('_', ' ')}
        </span>
      ),
    },
    { key: 'status', header: 'Status', sortValue: (r) => r.status, cell: (r) => <StatusBadge status={r.status as never} /> },
    { key: 'total', header: 'Total', align: 'right', sortValue: (r) => r.totalPaise, cell: (r) => <Money value={r.totalPaise} /> },
    {
      key: 'balance',
      header: 'Balance due',
      align: 'right',
      sortValue: (r) => r.balancePaise,
      cell: (r) => (
        <Money
          value={r.balancePaise}
          className={r.balancePaise > 0 ? 'font-medium' : 'text-muted-foreground'}
        />
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Invoices"
        description="Every approved invoice posts a balanced journal entry the moment it is created."
        actions={
          <>
            <Refreshing active={state.refreshing} />
            {canCreate && (
              <Button size="sm" asChild className="gap-1.5">
                <Link href="/sales/invoices/new"><Plus className="size-4" /> New invoice</Link>
              </Button>
            )}
          </>
        }
      />

      <AsyncPage state={state} loading={<LoadingRows rows={8} />}>
        {(data) => {
          const awaitingIrn = data.invoices.filter(
            (i) => i.einvoice.status === 'pending' || i.einvoice.status === 'failed',
          ).length;

          return data.summary.count === 0 && range.mode === 'all' && filter === 'all' ? (
            <EmptyState
              icon={Receipt}
              title="No invoices yet"
              description="Create your first invoice — GST is worked out automatically from the customer's state."
              action={
                canCreate && (
                  <Button asChild>
                    <Link href="/sales/invoices/new">New invoice</Link>
                  </Button>
                )
              }
            />
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                {[
                  { label: 'Invoices', value: String(data.summary.count) },
                  { label: 'Total invoiced', value: formatINRCompact(data.summary.totalPaise) },
                  { label: 'Outstanding', value: formatINRCompact(data.summary.duePaise), warn: data.summary.duePaise > 0 },
                  { label: 'Awaiting IRN', value: String(awaitingIrn) },
                ].map((t) => (
                  <Card key={t.label} className="p-4">
                    <p className="text-xs text-muted-foreground">{t.label}</p>
                    <p className={`mt-1.5 tabular text-2xl font-semibold ${t.warn ? 'text-warning' : ''}`}>
                      {t.value}
                    </p>
                  </Card>
                ))}
              </div>

              <DataTable
                rows={data.invoices}
                columns={columns}
                getRowId={(r) => r.id}
                onRowClick={(r) => router.push(`/sales/invoices/${r.id}`)}
                searchPlaceholder="Search invoice no. or customer…"
                initialSort={{ key: 'date', dir: 'desc' }}
                tabs={tabs}
                activeTab={filter}
                onTabChange={setFilter}
                dateFilter={{ getDate: (r) => r.date, value: range, onChange: setRange }}
                selectable={canEdit}
                bulkActions={(selected, clear) => (
                  <>
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={send.busy}
                      onClick={async () => {
                        // Sequential on purpose: each send posts the invoice if
                        // it was still a draft, and firing them together would
                        // have several transactions contending for one counter.
                        let sent = 0;
                        for (const inv of selected) {
                          if (await send.run(inv.id)) sent++;
                        }
                        if (sent) toast.success(`${sent} invoice(s) marked sent`);
                        if (send.error) toast.error(send.error);
                        clear();
                        await state.refetch();
                      }}
                      className="gap-1"
                    >
                      <Send className="size-3" /> Send
                    </Button>
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => {
                        const pending = selected.filter(
                          (i) => i.einvoice.status === 'pending' || i.einvoice.status === 'failed',
                        );
                        toast.info(
                          pending.length
                            ? `${pending.length} invoice(s) queued for the IRP`
                            : 'Those invoices already carry an IRN',
                          {
                            description:
                              'Submission needs a GSP connection, which is not wired up yet.',
                          },
                        );
                        clear();
                      }}
                      className="gap-1"
                    >
                      <FileCheck2 className="size-3" /> Submit to IRP
                    </Button>
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => {
                        downloadCsv('invoices.csv', [
                          ['Invoice', 'Customer', 'Date', 'Due', 'Status', 'Total', 'Balance'],
                          ...selected.map((i) => [
                            i.number, i.customerName, i.date, i.dueDate, i.status,
                            toRupees(i.totalPaise), toRupees(i.balancePaise),
                          ]),
                        ]);
                        clear();
                      }}
                      className="gap-1"
                    >
                      <Download className="size-3" /> Export
                    </Button>
                  </>
                )}
              />
            </>
          );
        }}
      </AsyncPage>
    </>
  );
}
