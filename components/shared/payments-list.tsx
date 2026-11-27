'use client';

// The payments list, shared by both directions.
//
// Receipts and payments made differ only in wording and which module's
// permission applies — the columns, the totals and the meaning of every figure
// are identical. Two near-copies would have drifted the moment one of them
// gained a column.

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { Download, MoreHorizontal, Plus, RefreshCw, Upload, Wallet } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/shared/page-header';
import { ModuleMenu } from '@/components/shared/module-menu';
import { DataTable, resetColumnWidths, type Column } from '@/components/shared/data-table';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent,
  DropdownMenuSubTrigger, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { downloadCsv } from '@/components/shared/report-shell';
import { toRupees } from '@/lib/money';
import { BulkPrintButton, DeleteDocumentDialog, documentMenuColumn } from '@/components/shared/document-menu';
import { RowActions } from '@/components/shared/row-actions';
import { Money } from '@/components/shared/money';
import { EmptyState } from '@/components/shared/empty-state';
import { AsyncPage, LoadingRows, Refreshing } from '@/components/shared/async-state';
import { usePermission } from '@/lib/store/hooks';
import { ALL_TIME, type RangeValue } from '@/lib/date-range';
import { formatINRCompact } from '@/lib/money';
import { payments as paymentApi, type PaymentListItem, type PaymentListResponse } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { ApplyPaymentDialog } from '@/components/shared/apply-payment-dialog';

export function PaymentsList({ kind }: { kind: 'received' | 'made' }) {
  const router = useRouter();
  const isReceipt = kind === 'received';
  const canCreate = usePermission(isReceipt ? 'sales' : 'purchases', 'create');
  const canEdit = usePermission(isReceipt ? 'sales' : 'purchases', 'edit');
  const canDelete = usePermission(isReceipt ? 'sales' : 'purchases', 'void');
  // Edit and Delete as worded buttons on each row, beside the ⋯ (the client looks for the words).
  const [deleting, setDeleting] = useState<{ id: string; number: string } | null>(null);
  const editHref = (id: string) => `${isReceipt ? '/sales/payments/new' : '/purchases/payments/new'}?edit=${id}`;
  const [openId, setOpenId] = useState<string | null>(null);
  const [range, setRange] = useState<RangeValue>(() => ({ ...ALL_TIME, mode: 'all' }));
  // Zoho's ⋯ → Sort by on Payments Received.
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' }>({ key: 'date', dir: 'desc' });

  const state = useApi<PaymentListResponse>(
    () =>
      paymentApi.list({
        kind,
        from: range.mode === 'all' ? undefined : range.from,
        to: range.mode === 'all' ? undefined : range.to,
        limit: 500,
      }),
    [kind, range.from, range.to, range.mode],
  );

  const party = isReceipt ? 'Customer' : 'Vendor';
  const docs = isReceipt ? 'invoice' : 'bill';

  const columns: Column<PaymentListItem>[] = [
    { key: 'number', header: isReceipt ? 'Receipt #' : 'Payment #', sortValue: (r) => r.number, cell: (r) => <span className="font-medium">{r.number}</span> },
    { key: 'contact', header: party, sortValue: (r) => r.contactName, cell: (r) => r.contactName },
    {
      key: 'date',
      header: 'Date',
      sortValue: (r) => r.date,
      cell: (r) => new Date(r.date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' }),
    },
    { key: 'mode', header: 'Mode', sortValue: (r) => r.mode, cell: (r) => <Badge variant="secondary" className="uppercase text-[10px]">{r.mode}</Badge> },
    { key: 'bank', header: 'Account', sortValue: (r) => r.bankName, cell: (r) => <span className="text-sm">{r.bankName}</span> },
    {
      key: 'ref',
      header: 'Reference',
      sortValue: (r) => r.reference ?? '',
      cell: (r) => <span className="text-xs text-muted-foreground">{r.reference || '—'}</span>,
    },
    {
      key: 'applied',
      header: 'Settled',
      sortValue: (r) => r.allocationCount,
      cell: (r) =>
        r.allocationCount > 0 ? (
          <span className="text-xs">{r.allocationCount} {docs}{r.allocationCount === 1 ? '' : 's'}</span>
        ) : (
          <span className="text-xs text-muted-foreground">Nothing yet</span>
        ),
    },
    {
      key: 'tds',
      header: 'TDS',
      align: 'right',
      sortValue: (r) => r.tdsPaise,
      cell: (r) => <Money value={r.tdsPaise} showZero={false} className="text-muted-foreground" />,
    },
    {
      key: 'unapplied',
      header: 'On account',
      align: 'right',
      sortValue: (r) => r.unappliedPaise,
      cell: (r) =>
        r.unappliedPaise > 0 && r.status !== 'void' && canEdit ? (
          <button
            type="button"
            className="text-warning underline-offset-2 hover:underline"
            onClick={(e) => { e.stopPropagation(); setOpenId(r.id); }}
            title="Apply it to an open document"
          >
            <Money value={r.unappliedPaise} /> · Apply
          </button>
        ) : (
          <Money value={r.unappliedPaise} showZero={false} className="text-warning" />
        ),
    },
    { key: 'amount', header: 'Amount', align: 'right', sortValue: (r) => r.amountPaise, cell: (r) => <Money value={r.amountPaise} className="font-medium" /> },
    ...(!isReceipt ? [{
      key: 'cheque', header: '', sortValue: () => 0,
      cell: (r: PaymentListItem) => (r.mode === 'cheque' && r.status !== 'void'
        ? <Link href={`/purchases/payments/${r.id}/cheque`} onClick={(e) => e.stopPropagation()} className="text-xs text-primary hover:underline" data-slot="print-cheque">Print cheque</Link>
        : null),
    }] : []),
  ];

  // Zoho's Export → Export Current View: the rows on screen, with Zoho's columns.
  const exportView = (rows: PaymentListItem[]) => downloadCsv('payments-received.csv', [
    ['Date', 'Branch', 'Payment #', 'Type', 'Reference Number', 'Customer Name', 'Invoice#', 'Mode', 'Amount', 'Unused Amount'],
    ...rows.map((r) => [r.date.slice(0, 10), r.branchName ?? '', r.number, r.type ?? '', r.reference ?? '', r.contactName, (r.documentNumbers ?? []).join(' '),
      r.mode, toRupees(r.amountPaise + r.tdsPaise + r.bankChargesPaise), toRupees(r.unappliedPaise)]),
  ]);
  // Zoho's Payments Received columns, in Zoho's order (recorded 2026-11-23).
  const receivedColumns: Column<PaymentListItem>[] = [
    { key: 'date', header: 'Date', sortValue: (r) => r.date, cell: (r) => new Date(`${r.date.slice(0, 10)}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) },
    // Sort by → Created Time / Last Modified Time: sortable, not shown unless chosen under Customize Columns.
    { key: 'created', header: 'Created Time', defaultHidden: true, sortValue: (r) => r.createdAt ?? '', cell: (r) => (r.createdAt ? new Date(r.createdAt).toLocaleString('en-IN') : '') },
    { key: 'modified', header: 'Last Modified Time', defaultHidden: true, sortValue: (r) => r.updatedAt ?? '', cell: (r) => (r.updatedAt ? new Date(r.updatedAt).toLocaleString('en-IN') : '') },
    { key: 'branch', header: 'Branch', sortValue: (r) => r.branchName ?? '', cell: (r) => r.branchName ?? '' },
    { key: 'number', header: 'Payment #', sortValue: (r) => r.number, cell: (r) => <span className="font-medium text-link">{r.number}</span> },
    { key: 'type', header: 'Type', sortValue: (r) => r.type ?? '', cell: (r) => r.type ?? '' },
    { key: 'ref', header: 'Reference Number', sortValue: (r) => r.reference ?? '', cell: (r) => r.reference ?? '' },
    { key: 'contact', header: 'Customer Name', sortValue: (r) => r.contactName, cell: (r) => r.contactName },
    { key: 'docs', header: 'Invoice#', sortValue: (r) => (r.documentNumbers ?? []).join(','), cell: (r) => (r.documentNumbers ?? []).join(', ') },
    { key: 'mode', header: 'Mode', sortValue: (r) => r.mode, cell: (r) => <span className="capitalize">{r.mode}</span> },
    { key: 'amount', header: 'Amount', align: 'right', sortValue: (r) => r.amountPaise + r.tdsPaise + r.bankChargesPaise, cell: (r) => <Money value={r.amountPaise + r.tdsPaise + r.bankChargesPaise} className="font-medium" /> },
    {
      key: 'unapplied', header: 'Unused Amount', align: 'right', sortValue: (r) => r.unappliedPaise,
      cell: (r) => r.unappliedPaise > 0 && r.status !== 'void' && canEdit ? (
        <button type="button" className="underline-offset-2 hover:underline" onClick={(e) => { e.stopPropagation(); setOpenId(r.id); }} title="Apply it to an open invoice">
          <Money value={r.unappliedPaise} />
        </button>
      ) : <Money value={r.unappliedPaise} />,
    },
  ];

  return (
    <>
      <DeleteDocumentDialog kind={isReceipt ? 'payment-received' : 'payment-made'} id={deleting?.id ?? ''} number={deleting?.number ?? ''}
        open={!!deleting} onOpenChange={(v) => { if (!v) setDeleting(null); }} onDeleted={() => void state.refetch()} />
      <PageHeader
        title={isReceipt ? 'Payments Received' : 'Payments Made'}
        description={
          isReceipt
            ? 'One receipt can settle several invoices. TDS the customer withheld still settles the invoice, even though it never reaches the bank.'
            : 'One payment run can settle several bills. TDS withheld is owed to the government, not to the vendor.'
        }
        actions={
          <>
            <Refreshing active={state.refreshing} />
            {canCreate && (
              <Button size="sm" asChild className="gap-1.5">
                <Link href={isReceipt ? '/sales/payments/new' : '/purchases/payments/new'}>
                  <Plus className="size-4" /> {isReceipt ? 'New' : 'Record payment'}
                </Link>
              </Button>
            )}
            {isReceipt
              ? <ReceivedMenu sort={sort} onSort={setSort} onRefresh={() => void state.refetch()} onExportView={() => exportView(state.data?.payments ?? [])} />
              : <ModuleMenu slug="payments-made" onRefresh={() => void state.refetch()} />}
          </>
        }
      />

      <AsyncPage state={state} loading={<LoadingRows rows={6} />}>
        {(data) =>
          data.summary.count === 0 && range.mode === 'all' ? (
            <EmptyState
              icon={Wallet}
              title={isReceipt ? 'No receipts yet' : 'No payments yet'}
              description={
                isReceipt
                  ? 'Record your first customer receipt.'
                  : 'Record your first payment to a supplier.'
              }
            />
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <Card className="p-4">
                  <p className="text-xs text-muted-foreground">{isReceipt ? 'Receipts' : 'Payments'}</p>
                  <p className="mt-1.5 tabular text-2xl font-semibold">{data.summary.count}</p>
                </Card>
                <Card className="p-4">
                  <p className="text-xs text-muted-foreground">
                    {isReceipt ? 'Total received' : 'Total paid'}
                  </p>
                  <p className="mt-1.5 tabular text-2xl font-semibold">
                    {formatINRCompact(data.summary.totalPaise)}
                  </p>
                </Card>
                <Card className="p-4">
                  <p className="text-xs text-muted-foreground">Unapplied</p>
                  <p
                    className={`mt-1.5 tabular text-2xl font-semibold ${
                      data.summary.unappliedPaise > 0 ? 'text-warning' : ''
                    }`}
                  >
                    {formatINRCompact(data.summary.unappliedPaise)}
                  </p>
                </Card>
              </div>

              {data.summary.unappliedPaise > 0 && (
                <p className="text-xs leading-relaxed text-muted-foreground">
                  <Money value={data.summary.unappliedPaise} className="font-medium text-foreground" /> is
                  sitting on account — money {isReceipt ? 'received' : 'paid'} that has not been matched to a{' '}
                  {docs} yet. It is an advance, not a mistake. Open a {isReceipt ? 'receipt' : 'payment'} to apply it.
                </p>
              )}

              <DataTable
                rows={data.payments}
                columns={[...(isReceipt ? receivedColumns : columns), {
                  key: 'change', header: '', align: 'right',
                  cell: (r) => <RowActions onEdit={canEdit && r.status !== 'void' ? () => router.push(editHref(r.id)) : null}
                    onDelete={canDelete ? () => setDeleting({ id: r.id, number: r.number }) : null}
                    editTitle={`Edit ${r.number}`} deleteTitle={`Delete ${r.number}`} />,
                }, documentMenuColumn(isReceipt ? 'payment-received' : 'payment-made', () => void state.refetch(), (r) => router.push(editHref(r.id)))]}
                getRowId={(r) => r.id}
                selectable
                bulkActions={(selected) => <BulkPrintButton kind={isReceipt ? 'payment-received' : 'payment-made'} ids={selected.map((r) => r.id)} />}
                key={isReceipt ? `${sort.key}-${sort.dir}` : 'made'}
                initialSort={isReceipt ? sort : { key: 'date', dir: 'desc' }}
                searchPlaceholder={`Search ${isReceipt ? 'receipt' : 'payment'} or ${party.toLowerCase()}…`}
                dateFilter={{ getDate: (r) => r.date, value: range, onChange: setRange }}
                // A receipt opens beside the list, as in Zoho; a payment made keeps its Apply window.
                onRowClick={(r) => (isReceipt ? router.push(`/sales/payments/${r.id}`) : setOpenId(r.id))}
              />
            </>
          )
        }
      </AsyncPage>

      <ApplyPaymentDialog
        paymentId={openId}
        canEdit={canEdit}
        onClose={() => setOpenId(null)}
        onChanged={() => void state.refetch()}
      />
    </>
  );
}

/** Zoho's Sort by on Payments Received, in Zoho's order. */
const RECEIVED_SORTS: { key: string; label: string }[] = [
  { key: 'created', label: 'Created Time' }, { key: 'modified', label: 'Last Modified Time' }, { key: 'date', label: 'Date' },
  { key: 'number', label: 'Payment #' }, { key: 'contact', label: 'Customer Name' }, { key: 'mode', label: 'Mode' },
  { key: 'amount', label: 'Amount' }, { key: 'unapplied', label: 'Unused Amount' },
];

/**
 * Zoho's ⋯ on Payments Received: Sort by, Import ▸ (Import Payments, Import
 * Retainer Payments, Import Applied Excess Payments), Export ▸ (Export
 * Payments, Export Current View), Manage Custom Fields, Online Payments,
 * Refresh List and Reset Column Width.
 */
function ReceivedMenu({ sort, onSort, onRefresh, onExportView }: {
  sort: { key: string; dir: 'asc' | 'desc' };
  onSort: (s: { key: string; dir: 'asc' | 'desc' }) => void;
  onRefresh: () => void;
  onExportView: () => void;
}) {
  const router = useRouter();
  const canImport = usePermission('sales', 'create');
  const canExport = usePermission('sales', 'export');
  const imports = useMemo(() => [
    { slug: 'payments-received', label: 'Import Payments' },
    { slug: 'retainer-payments', label: 'Import Retainer Payments' },
    { slug: 'applied-excess-payments', label: 'Import Applied Excess Payments' },
  ], []);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger aria-label="More actions" data-slot="module-menu"
        className="grid size-8 place-items-center rounded-[3px] border bg-background transition-colors hover:bg-accent">
        <MoreHorizontal className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        <DropdownMenuSub>
          <DropdownMenuSubTrigger data-slot="list-sort">Sort by</DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="min-w-44">
            {RECEIVED_SORTS.map((x) => (
              <DropdownMenuItem key={x.key} data-slot="list-sort-by" data-value={x.key}
                onClick={() => onSort({ key: x.key, dir: sort.key === x.key && sort.dir === 'desc' ? 'asc' : 'desc' })}>
                {x.label}{sort.key === x.key ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        {canImport && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger><Upload className="mr-2 size-4 text-primary" /> Import</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="min-w-60">
              {imports.map((m, i) => (
                <DropdownMenuItem key={m.slug} onClick={() => router.push(`/import/${m.slug}`)}
                  data-slot={i === 0 ? 'module-import' : `import-${m.slug}`} data-import={m.slug}>{m.label}</DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
        {canExport && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger><Download className="mr-2 size-4 text-primary" /> Export</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem onClick={() => router.push('/settings/export?module=payments-received')} data-slot="module-export">Export Payments</DropdownMenuItem>
              <DropdownMenuItem onClick={onExportView} data-slot="export-view">Export Current View</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => router.push('/settings?tab=custom-fields')}>Manage Custom Fields</DropdownMenuItem>
        <DropdownMenuItem onClick={() => router.push('/sales/payments/online')} data-slot="online-payments">Online Payments</DropdownMenuItem>
        <DropdownMenuItem onClick={() => resetColumnWidths()}>Reset Column Width</DropdownMenuItem>
        <DropdownMenuItem onClick={onRefresh}><RefreshCw className="mr-2 size-4 text-primary" /> Refresh List</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
