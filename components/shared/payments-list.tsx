'use client';

// The payments list, shared by both directions.
//
// Receipts and payments made differ only in wording and which module's
// permission applies — the columns, the totals and the meaning of every figure
// are identical. Two near-copies would have drifted the moment one of them
// gained a column.

import Link from 'next/link';
import { useState } from 'react';
import { Plus, Wallet } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/shared/page-header';
import { DataTable, type Column } from '@/components/shared/data-table';
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
  const isReceipt = kind === 'received';
  const canCreate = usePermission(isReceipt ? 'sales' : 'purchases', 'create');
  const canEdit = usePermission(isReceipt ? 'sales' : 'purchases', 'edit');
  const [openId, setOpenId] = useState<string | null>(null);
  const [range, setRange] = useState<RangeValue>(() => ({ ...ALL_TIME, mode: 'all' }));

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
  ];

  return (
    <>
      <PageHeader
        title={isReceipt ? 'Payments received' : 'Payments made'}
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
                  <Plus className="size-4" /> {isReceipt ? 'Record receipt' : 'Record payment'}
                </Link>
              </Button>
            )}
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
                columns={columns}
                getRowId={(r) => r.id}
                initialSort={{ key: 'date', dir: 'desc' }}
                searchPlaceholder={`Search ${isReceipt ? 'receipt' : 'payment'} or ${party.toLowerCase()}…`}
                dateFilter={{ getDate: (r) => r.date, value: range, onChange: setRange }}
                onRowClick={(r) => setOpenId(r.id)}
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
