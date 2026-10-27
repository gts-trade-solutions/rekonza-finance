'use client';

// Sales orders — confirmed demand, not yet revenue.
//
// The value on this screen is the order book. It is real information and it is
// deliberately absent from every financial statement: nothing has been supplied
// and nothing is owed. The gap between the order total and what has been
// invoiced is the backlog still to deliver.

import { useState } from 'react';
import { ArrowRight, ClipboardList, Truck } from 'lucide-react';
import { toast } from 'sonner';
import { useRouter } from 'next/navigation';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/shared/page-header';
import { DataTable, type Column } from '@/components/shared/data-table';
import { Money } from '@/components/shared/money';
import { StatusBadge } from '@/components/shared/status-badge';
import { EmptyState } from '@/components/shared/empty-state';
import { AsyncPage } from '@/components/shared/async-state';
import { Field } from '@/components/shared/form-bits';
import { QuickDocumentDialog } from '@/components/shared/quick-document-dialog';
import { LinePickDialog } from '@/components/shared/line-pick-dialog';
import { orderFlow, salesDocuments, type SalesDocListResponse, type SalesDocRow } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';

const short = (d: string | null) => (d ? new Date(d).toLocaleDateString('en-IN') : '—');
const today = () => new Date().toISOString().slice(0, 10);

function inDays(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

export default function SalesOrdersPage() {
  const router = useRouter();
  const canCreate = usePermission('sales', 'create');
  const state = useApi<SalesDocListResponse>(() => salesDocuments.list('sales-order'), []);
  // An order goes on line by line: invoiced now, or delivered on a challan first.
  const [step, setStep] = useState<{ row: SalesDocRow; to: 'invoice' | 'challan' } | null>(null);
  const [date, setDate] = useState(today());
  const [dueDate, setDueDate] = useState(inDays(30));
  const open = (row: SalesDocRow, to: 'invoice' | 'challan') => {
    setDate(today()); setDueDate(inDays(30)); setStep({ row, to });
  };

  const columns: Column<SalesDocRow>[] = [
    { key: 'number', header: 'Order #', sortValue: (r) => r.number, cell: (r) => <span className="font-medium">{r.number}</span> },
    { key: 'customer', header: 'Customer', sortValue: (r) => r.customerName, cell: (r) => r.customerName },
    { key: 'date', header: 'Date', sortValue: (r) => r.date, cell: (r) => short(r.date) },
    { key: 'ship', header: 'Expected ship', sortValue: (r) => r.detail ?? '', cell: (r) => short(r.detail) },
    { key: 'status', header: 'Status', sortValue: (r) => r.status, cell: (r) => <StatusBadge status={r.status} /> },
    {
      key: 'invoiced', header: 'Invoiced', align: 'right',
      sortValue: (r) => r.appliedPaise ?? 0,
      cell: (r) => <Money value={r.appliedPaise ?? 0} showZero={false} />,
    },
    { key: 'total', header: 'Order value', align: 'right', sortValue: (r) => r.totalPaise, cell: (r) => <Money value={r.totalPaise} /> },
    {
      key: 'actions', header: '', align: 'right',
      cell: (r) =>
        r.status === 'invoiced' ? (
          <span className="text-xs text-muted-foreground">Invoiced</span>
        ) : r.status === 'cancelled' ? (
          <span className="text-xs text-muted-foreground">Cancelled</span>
        ) : canCreate ? (
          <div className="flex justify-end gap-1.5">
            <Button size="xs" variant="outline" className="gap-1" onClick={() => open(r, 'challan')}>
              <Truck className="size-3" /> Deliver
            </Button>
            <Button size="xs" className="gap-1" onClick={() => open(r, 'invoice')}>
              Invoice <ArrowRight className="size-3" />
            </Button>
          </div>
        ) : null,
    },
  ];

  return (
    <>
      <PageHeader
        title="Sales orders"
        description="Confirmed orders awaiting fulfilment. Convert to an invoice when the goods ship."
        actions={
          canCreate && (
            <QuickDocumentDialog
              kind="sales-order"
              title="New sales order"
              description="Record a confirmed order. It is a commitment to supply, not revenue — nothing posts yet."
              buttonLabel="New order"
              onCreated={state.refetch}
              extra={(v, set) => (
                <Field label="Expected ship date">
                  <Input type="date" value={v || inDays(14)} onChange={(e) => set(e.target.value)} />
                </Field>
              )}
            />
          )
        }
      />
      <AsyncPage state={state}>
        {(d) => (
          <>
            {d.summary.openPaise > 0 && (
              <p className="text-xs text-muted-foreground">
                <Money value={d.summary.openPaise} className="font-medium" /> of orders still open — committed
                demand that has not yet reached the books.
              </p>
            )}
            {d.documents.length === 0 ? (
              <EmptyState
                icon={ClipboardList}
                title="No sales orders"
                description="Accept an estimate and convert it to an order to see it here."
              />
            ) : (
              <DataTable
                rows={d.documents}
                columns={columns}
                getRowId={(r) => r.id}
                initialSort={{ key: 'date', dir: 'desc' }}
                dateFilter={{ getDate: (r) => r.date }}
                searchPlaceholder="Search order or customer…"
              />
            )}
          </>
        )}
      </AsyncPage>

      <LinePickDialog
        open={!!step}
        onClose={() => setStep(null)}
        doc="sales_order"
        docId={step?.row.id ?? null}
        use={step?.to === 'challan' ? 'move' : 'invoice'}
        title={step?.to === 'challan' ? `Deliver against ${step?.row.number}` : `Invoice ${step?.row.number}`}
        description={step?.to === 'challan'
          ? 'A delivery challan moves the goods; the sale is invoiced from the challan later.'
          : 'Invoice what is left, or part of it. The rest stays on the order.'}
        submitLabel={step?.to === 'challan' ? 'Create challan' : 'Create invoice'}
        header={
          <>
            <Field label={step?.to === 'challan' ? 'Challan date' : 'Invoice date'}>
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
            {step?.to === 'invoice' && (
              <Field label="Due date"><Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></Field>
            )}
          </>
        }
        onSubmit={async (lines) => {
          if (!step) return;
          if (step.to === 'challan') {
            const done = await orderFlow.deliver(step.row.id, { date, lines });
            toast.success(`Challan ${done.number} created`, { description: 'Invoice it from Delivery challans when the sale is made.' });
            void state.refetch();
            return;
          }
          const done = await orderFlow.invoiceSalesOrder(step.row.id, { date, dueDate, lines });
          if (done.heldForApproval) toast.info(`Invoice ${done.number} saved for approval`, { description: 'A rule holds it until someone approves it; it posts then.' });
          else toast.success(`Invoice ${done.number} created`, { description: 'Posted to the ledger.' });
          router.push(`/sales/invoices/${done.invoiceId}`);
        }}
      />
    </>
  );
}
