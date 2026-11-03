'use client';

// Sales receipts and debit notes: both are invoices underneath (they post the
// same way and open on the invoice's own page), listed apart because they are
// looked for apart — the counter's takings for the day, the corrections raised
// against a customer.

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { FilePlus2, Plus, ReceiptIndianRupee } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/shared/page-header';
import { DataTable, type Column } from '@/components/shared/data-table';
import { DateRangePicker } from '@/components/shared/date-range-picker';
import { useReportRange } from '@/components/shared/report-shell';
import { Money } from '@/components/shared/money';
import { StatusBadge } from '@/components/shared/status-badge';
import { StatTile } from '@/components/shared/stat-tile';
import { AsyncPage } from '@/components/shared/async-state';
import { EmptyState } from '@/components/shared/empty-state';
import { invoices, type InvoiceListItem, type InvoiceListResponse } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';
import { formatINRCompact } from '@/lib/money';

const COPY = {
  receipt: {
    title: 'Sales Receipts',
    description: 'Sales paid for at the counter: each is a tax invoice and its receipt, recorded together, so it is born settled.',
    newLabel: 'New sales receipt',
    newHref: '/sales/sales-receipts/new',
    empty: 'No sales paid at the counter in this period.',
    number: 'Receipt / invoice #',
  },
  debit_note: {
    title: 'Debit Note',
    description: 'Raised when an invoice charged too little — a price revised upward, goods short-billed (CGST Act s.34(3)). Reported in GSTR-1 with the notes, as type D.',
    newLabel: 'New debit note',
    newHref: '/sales/debit-notes/new',
    empty: 'No debit notes in this period.',
    number: 'Debit note #',
  },
} as const;

export function InvoiceKindList({ kind }: { kind: 'receipt' | 'debit_note' }) {
  const c = COPY[kind];
  const router = useRouter();
  const canCreate = usePermission('sales', 'create');
  const [range, setRange] = useReportRange();
  const state = useApi<InvoiceListResponse>(
    () => invoices.list({ kind, from: range.from, to: range.to, limit: 500 }),
    [kind, range.from, range.to],
  );

  const columns: Column<InvoiceListItem>[] = [
    { key: 'date', header: 'Date', sortValue: (r) => r.date, cell: (r) => new Date(r.date).toLocaleDateString('en-IN') },
    { key: 'number', header: c.number, sortValue: (r) => r.number, cell: (r) => <span className="font-medium">{r.number}</span> },
    { key: 'customer', header: 'Customer', sortValue: (r) => r.customerName, cell: (r) => r.customerName },
    { key: 'status', header: 'Status', sortValue: (r) => r.status, cell: (r) => <StatusBadge status={r.status} /> },
    { key: 'total', header: 'Amount', align: 'right', sortValue: (r) => r.totalPaise, cell: (r) => <Money value={r.totalPaise} /> },
    ...(kind === 'debit_note'
      ? [{ key: 'balance', header: 'Balance', align: 'right' as const, sortValue: (r: InvoiceListItem) => r.balancePaise, cell: (r: InvoiceListItem) => <Money value={r.balancePaise} showZero={false} /> }]
      : []),
  ];

  return (
    <>
      <PageHeader
        title={c.title}
        description={c.description}
        actions={canCreate ? (
          <Button size="sm" asChild className="gap-1.5">
            <Link href={c.newHref}><Plus className="size-4" /> {c.newLabel}</Link>
          </Button>
        ) : undefined}
      />
      <div className="flex justify-end">
        <DateRangePicker value={range} onChange={setRange} label="Period" />
      </div>
      <AsyncPage state={state}>
        {(d) => {
          const live = d.invoices.filter((r) => r.status !== 'void');
          return (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <StatTile label={kind === 'receipt' ? 'Taken at the counter' : 'Raised'} value={formatINRCompact(live.reduce((t, r) => t + r.totalPaise, 0))} />
                <StatTile label="Documents" value={String(live.length)} />
                <StatTile label={kind === 'receipt' ? 'Cancelled' : 'Still owed'}
                  value={kind === 'receipt' ? String(d.invoices.length - live.length) : formatINRCompact(live.reduce((t, r) => t + r.balancePaise, 0))} />
              </div>
              {d.invoices.length ? (
                <DataTable rows={d.invoices} columns={columns} getRowId={(r) => r.id}
                  onRowClick={(r) => router.push(`/sales/invoices/${r.id}`)} searchPlaceholder="Search number or customer…" />
              ) : (
                <EmptyState icon={kind === 'receipt' ? ReceiptIndianRupee : FilePlus2} title={c.empty} description={c.description} />
              )}
            </>
          );
        }}
      </AsyncPage>
    </>
  );
}
