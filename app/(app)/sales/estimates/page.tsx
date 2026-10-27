'use client';

// Estimates and quotes.
//
// A quote is a price somebody has been offered, nothing more. It posts nothing,
// carries no GST liability, and appears in no report of revenue — until it is
// accepted and converted, at which point it becomes an order or an invoice and
// the ledger finally hears about it.

import { ArrowRight, FileText } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/shared/page-header';
import { DataTable, type Column } from '@/components/shared/data-table';
import { Money } from '@/components/shared/money';
import { StatusBadge } from '@/components/shared/status-badge';
import { EmptyState } from '@/components/shared/empty-state';
import { AsyncPage } from '@/components/shared/async-state';
import { Field } from '@/components/shared/form-bits';
import { QuickDocumentDialog } from '@/components/shared/quick-document-dialog';
import { salesDocuments, type SalesDocListResponse, type SalesDocRow } from '@/lib/api/client';
import { useApi, useApiAction } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';

const short = (d: string | null) => (d ? new Date(d).toLocaleDateString('en-IN') : '—');
const today = () => new Date().toISOString().slice(0, 10);

function inDays(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

export default function EstimatesPage() {
  const canCreate = usePermission('sales', 'create');
  const state = useApi<SalesDocListResponse>(() => salesDocuments.list('estimate'), []);
  const setStatus = useApiAction(salesDocuments.setStatus);
  const convert = useApiAction(salesDocuments.convert);
  const order = useApiAction(salesDocuments.toOrder);
  const busy = setStatus.busy || convert.busy || order.busy;

  const toOrder = async (r: SalesDocRow) => {
    const done = await order.run(r.id, today());
    if (!done) {
      toast.error(order.error ?? 'Could not turn that estimate into an order');
      return;
    }
    toast.success(`Sales order ${done.number} raised`, {
      description: 'Deliver against it with a challan and invoice what is delivered, in part or in full.',
    });
    state.refetch();
  };

  const accept = async (r: SalesDocRow) => {
    if (!(await setStatus.run('estimate', r.id, 'accepted'))) {
      toast.error(setStatus.error ?? 'Could not update that estimate');
      return;
    }
    toast.success(`${r.number} marked accepted`);
    state.refetch();
  };

  const toInvoice = async (r: SalesDocRow) => {
    const done = await convert.run('estimate', r.id, today(), inDays(30));
    if (!done) {
      toast.error(convert.error ?? 'Could not convert that estimate');
      return;
    }
    toast.success(`Invoice ${done.number} raised`, {
      description: 'This is the point the sale reaches the ledger.',
    });
    state.refetch();
  };

  const columns: Column<SalesDocRow>[] = [
    { key: 'number', header: 'Estimate #', sortValue: (r) => r.number, cell: (r) => <span className="font-medium">{r.number}</span> },
    { key: 'customer', header: 'Customer', sortValue: (r) => r.customerName, cell: (r) => r.customerName },
    { key: 'date', header: 'Date', sortValue: (r) => r.date, cell: (r) => short(r.date) },
    {
      key: 'expiry', header: 'Valid until', sortValue: (r) => r.expiry ?? '',
      cell: (r) => (
        <span className={r.expiry && r.expiry < today() && r.status !== 'converted' ? 'text-destructive' : undefined}>
          {short(r.expiry)}
        </span>
      ),
    },
    { key: 'status', header: 'Status', sortValue: (r) => r.status, cell: (r) => <StatusBadge status={r.status} /> },
    { key: 'total', header: 'Total', align: 'right', sortValue: (r) => r.totalPaise, cell: (r) => <Money value={r.totalPaise} /> },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (r) =>
        r.status === 'converted' ? (
          <span className="text-xs text-muted-foreground">Converted</span>
        ) : r.status === 'declined' ? (
          <span className="text-xs text-muted-foreground">Declined</span>
        ) : canCreate ? (
          <div className="flex justify-end gap-1.5">
            {r.status !== 'accepted' && (
              <Button variant="outline" size="xs" disabled={busy} onClick={() => void accept(r)}>
                Accept
              </Button>
            )}
            <Button variant="outline" size="xs" disabled={busy} onClick={() => void toOrder(r)}>
              To order
            </Button>
            <Button size="xs" className="gap-1" disabled={busy} onClick={() => void toInvoice(r)}>
              To invoice <ArrowRight className="size-3" />
            </Button>
          </div>
        ) : null,
    },
  ];

  return (
    <>
      <PageHeader
        title="Estimates & quotes"
        description="A quote is a promise, not a sale — nothing touches the ledger until it becomes an invoice."
        actions={
          canCreate && (
            <QuickDocumentDialog
              kind="estimate"
              title="New estimate"
              description="Quote a price. Nothing posts until the customer accepts and it becomes an invoice."
              buttonLabel="New estimate"
              onCreated={state.refetch}
              extra={(v, set) => (
                <Field label="Valid until" hint="After this date the quote lapses">
                  <Input type="date" value={v || inDays(15)} onChange={(e) => set(e.target.value)} />
                </Field>
              )}
            />
          )
        }
      />
      <AsyncPage state={state}>
        {(d) =>
          d.documents.length === 0 ? (
            <EmptyState icon={FileText} title="No estimates" description="Send a quote before committing to an invoice." />
          ) : (
            <DataTable
              rows={d.documents}
              columns={columns}
              getRowId={(r) => r.id}
              initialSort={{ key: 'date', dir: 'desc' }}
              dateFilter={{ getDate: (r) => r.date }}
              searchPlaceholder="Search estimate or customer…"
            />
          )
        }
      </AsyncPage>
    </>
  );
}
