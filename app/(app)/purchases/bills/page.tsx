'use client';

// The bills list, served by the API.
//
// The MSME column is not decoration. Section 43B(h) disallows the expense
// altogether if a registered micro or small supplier is not paid within 45
// days, so which of these vendors are MSME — and how old their unpaid bills
// are — is a tax question, not a courtesy.

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { FileText, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/shared/page-header';
import { DataTable, type Column } from '@/components/shared/data-table';
import { Money } from '@/components/shared/money';
import { StatusBadge } from '@/components/shared/status-badge';
import { EmptyState } from '@/components/shared/empty-state';
import { AsyncPage, LoadingRows, Refreshing } from '@/components/shared/async-state';
import { usePermission } from '@/lib/store/hooks';
import { ALL_TIME, type RangeValue } from '@/lib/date-range';
import { today } from '@/lib/selectors';
import { formatINRCompact } from '@/lib/money';
import { bills as billApi, type BillListItem, type BillListResponse } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';

const FILTERS = ['all', 'draft', 'open', 'partially_paid', 'paid', 'void'] as const;
const TAB_LABEL: Record<(typeof FILTERS)[number], string> = {
  all: 'All',
  draft: 'Draft',
  open: 'Open',
  partially_paid: 'Partially Paid',
  paid: 'Paid',
  void: 'Void',
};

export default function BillsPage() {
  const router = useRouter();
  const canCreate = usePermission('purchases', 'create');

  const [filter, setFilter] = useState<string>('all');
  const [range, setRange] = useState<RangeValue>(() => ({ ...ALL_TIME, mode: 'all' }));

  const state = useApi<BillListResponse>(
    () =>
      billApi.list({
        status: filter === 'all' ? undefined : filter,
        from: range.mode === 'all' ? undefined : range.from,
        to: range.mode === 'all' ? undefined : range.to,
        limit: 500,
      }),
    [filter, range.from, range.to, range.mode],
  );

  const tabs = useMemo(() => {
    const rows = state.data?.bills ?? [];
    return FILTERS.map((f) => ({
      value: f,
      label: TAB_LABEL[f],
      count: f === 'all' ? rows.length : rows.filter((b) => b.status === f).length,
    })).filter((t) => t.value === 'all' || t.count > 0);
  }, [state.data]);

  const asOf = today();
  const isOverdue = (r: BillListItem) => r.balancePaise > 0 && r.dueDate < asOf;

  const columns: Column<BillListItem>[] = [
    {
      key: 'internalNo',
      header: 'Bill #',
      sortValue: (r) => r.internalNo,
      cell: (r) => (
        <div>
          <p className="font-medium">{r.internalNo}</p>
          <p className="text-xs text-muted-foreground">{r.vendorInvoiceNo}</p>
        </div>
      ),
    },
    {
      key: 'vendor',
      header: 'Vendor',
      sortValue: (r) => r.vendorName,
      cell: (r) => (
        <div className="flex items-center gap-1.5">
          <span>{r.vendorName}</span>
          {r.isMsme && <Badge variant="outline" className="text-[9px]">MSME</Badge>}
          {r.isRcm && <Badge variant="secondary" className="text-[9px]">RCM</Badge>}
        </div>
      ),
    },
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
      cell: (r) => (
        <span className={isOverdue(r) ? 'text-destructive' : undefined}>
          {new Date(r.dueDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' })}
        </span>
      ),
    },
    { key: 'status', header: 'Status', sortValue: (r) => r.status, cell: (r) => <StatusBadge status={r.status as never} /> },
    {
      key: 'tds',
      header: 'TDS',
      align: 'right',
      sortValue: (r) => r.tdsPaise,
      cell: (r) =>
        r.tdsPaise > 0 ? (
          <span className="text-xs">
            <Money value={r.tdsPaise} />
            {r.tdsSection && <span className="ml-1 text-muted-foreground">{r.tdsSection}</span>}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        ),
    },
    { key: 'total', header: 'Total', align: 'right', sortValue: (r) => r.totalPaise, cell: (r) => <Money value={r.totalPaise} /> },
    {
      key: 'balance',
      header: 'Balance due',
      align: 'right',
      sortValue: (r) => r.balancePaise,
      cell: (r) => (
        <Money
          value={r.balancePaise}
          className={isOverdue(r) ? 'font-medium text-destructive' : r.balancePaise > 0 ? 'font-medium' : 'text-muted-foreground'}
        />
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Bills"
        description="Supplier invoices. Input credit, reverse charge and TDS are worked out from the vendor and the lines."
        actions={
          <>
            <Refreshing active={state.refreshing} />
            {canCreate && (
              <Button size="sm" asChild className="gap-1.5">
                <Link href="/purchases/bills/new"><Plus className="size-4" /> New bill</Link>
              </Button>
            )}
          </>
        }
      />

      <AsyncPage state={state} loading={<LoadingRows rows={8} />}>
        {(data) => {
          const overdue = data.bills.filter(isOverdue).reduce((t, b) => t + b.balancePaise, 0);
          const tds = data.bills.reduce((t, b) => t + b.tdsPaise, 0);

          return data.summary.count === 0 && range.mode === 'all' && filter === 'all' ? (
            <EmptyState
              icon={FileText}
              title="No bills yet"
              description="Record a supplier invoice — input credit and TDS are worked out for you."
              action={
                canCreate && (
                  <Button asChild><Link href="/purchases/bills/new">New bill</Link></Button>
                )
              }
            />
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                {[
                  { label: 'Bills', value: String(data.summary.count) },
                  { label: 'Total billed', value: formatINRCompact(data.summary.totalPaise) },
                  { label: 'Outstanding', value: formatINRCompact(data.summary.duePaise), warn: data.summary.duePaise > 0 },
                  { label: 'Overdue', value: formatINRCompact(overdue), danger: overdue > 0 },
                ].map((t) => (
                  <Card key={t.label} className="p-4">
                    <p className="text-xs text-muted-foreground">{t.label}</p>
                    <p
                      className={`mt-1.5 tabular text-2xl font-semibold ${
                        t.danger ? 'text-destructive' : t.warn ? 'text-warning' : ''
                      }`}
                    >
                      {t.value}
                    </p>
                  </Card>
                ))}
              </div>

              {tds > 0 && (
                <p className="text-xs text-muted-foreground">
                  <Money value={tds} className="font-medium text-foreground" /> withheld as TDS across these
                  bills. That is owed to the government, not to the vendors.
                </p>
              )}

              <DataTable
                rows={data.bills}
                columns={columns}
                getRowId={(r) => r.id}
                onRowClick={(r) => router.push(`/purchases/bills/${r.id}`)}
                searchPlaceholder="Search bill no. or vendor…"
                initialSort={{ key: 'date', dir: 'desc' }}
                tabs={tabs}
                activeTab={filter}
                onTabChange={setFilter}
                dateFilter={{ getDate: (r) => r.date, value: range, onChange: setRange }}
              />
            </>
          );
        }}
      </AsyncPage>
    </>
  );
}
