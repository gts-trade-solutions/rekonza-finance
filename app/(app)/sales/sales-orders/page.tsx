'use client';

// Sales orders — confirmed demand, not yet revenue.
//
// The value on this screen is the order book. It is real information and it is
// deliberately absent from every financial statement: nothing has been supplied
// and nothing is owed. The gap between the order total and what has been
// invoiced is the backlog still to deliver.

import { useState } from 'react';
import { ArrowRight, ClipboardList, FileText, Hammer, PackageCheck, Truck } from 'lucide-react';
import { toast } from 'sonner';
import { useRouter } from 'next/navigation';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/shared/page-header';
import { DataTable, type Column } from '@/components/shared/data-table';
import { BulkPrintButton, documentMenuColumn } from '@/components/shared/document-menu';
import { Money } from '@/components/shared/money';
import { StatusBadge } from '@/components/shared/status-badge';
import { EmptyState } from '@/components/shared/empty-state';
import { AsyncPage } from '@/components/shared/async-state';
import { Field } from '@/components/shared/form-bits';
import { QuickDocumentDialog } from '@/components/shared/quick-document-dialog';
import { LinePickDialog } from '@/components/shared/line-pick-dialog';
import { InvoicesCell, ProductsCell } from '@/components/shared/doc-links';
import { Badge } from '@/components/ui/badge';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { orderFlow, salesDocuments, type SalesDocListResponse, type SalesDocRow } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';

const short = (d: string | null) => (d ? new Date(d).toLocaleDateString('en-IN') : '—');
const today = () => new Date().toISOString().slice(0, 10);

type Stage = NonNullable<SalesDocRow['stage']>;
const STAGES: { key: Stage; label: string; tone: string }[] = [
  { key: 'order', label: 'Order received', tone: 'border-slate-400/50 text-slate-700 dark:text-slate-300' },
  { key: 'proforma', label: 'Proforma sent', tone: 'border-sky-500/50 bg-sky-500/10 text-sky-700 dark:text-sky-300' },
  { key: 'in_process', label: 'Work in process', tone: 'border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-300' },
  { key: 'ready', label: 'Ready for delivery', tone: 'border-emerald-500/50 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' },
];
const stageOf = (r: SalesDocRow) => STAGES.find((s) => s.key === (r.stage ?? 'order')) ?? STAGES[0];

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
  // Ready for delivery raises the invoice: asked once before it does.
  const [readying, setReadying] = useState<SalesDocRow | null>(null);
  const [busy, setBusy] = useState(false);
  const move = async (row: SalesDocRow, stage: Stage, on = today()) => {
    setBusy(true);
    try {
      const done = await orderFlow.stage(row.id, stage, on);
      if (stage === 'proforma') {
        toast.success(`Proforma invoice ${done.proformaNumber}`, { description: 'Opened to print or send. It is not a tax invoice and posts nothing.' });
        router.push(`/print/sales-order/${row.id}?as=proforma`);
        return;
      }
      if (stage === 'ready') {
        setReadying(null);
        if (done.invoice) {
          toast.success(`Invoice ${done.invoice.number} raised${done.challan ? ` with challan ${done.challan.number}` : ''}`, {
            description: done.invoice.heldForApproval ? 'A rule holds the invoice for approval; it posts then.' : 'Posted to the ledger.',
          });
          router.push(`/sales/invoices/${done.invoice.id}`);
          return;
        }
        toast.success(`${row.number} is ready for delivery`, { description: done.openChallans ? 'Its goods are on a challan still to invoice: invoice it from Delivery challans.' : 'Everything on it was invoiced already.' });
      } else {
        toast.success(`${row.number}: ${STAGES.find((s) => s.key === stage)?.label}`);
      }
      void state.refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'The stage was not changed');
    } finally {
      setBusy(false);
    }
  };

  const columns: Column<SalesDocRow>[] = [
    { key: 'number', header: 'Order #', sortValue: (r) => r.number, cell: (r) => <span className="font-medium">{r.number}</span> },
    { key: 'customer', header: 'Customer', sortValue: (r) => r.customerName, cell: (r) => r.customerName },
    { key: 'date', header: 'Date', sortValue: (r) => r.date, cell: (r) => short(r.date) },
    { key: 'ship', header: 'Expected ship', sortValue: (r) => r.detail ?? '', cell: (r) => short(r.detail) },
    { key: 'products', header: 'Products', sortValue: (r) => r.items?.[0]?.name ?? '', cell: (r) => <ProductsCell items={r.items} /> },
    {
      key: 'stage', header: 'Stage', sortValue: (r) => STAGES.indexOf(stageOf(r)),
      cell: (r) => (
        <span className="flex flex-col items-start gap-0.5" data-slot="order-stage">
          <Badge variant="outline" className={`text-[10px] ${stageOf(r).tone}`}>{stageOf(r).label}</Badge>
          {r.proformaNumber && (
            <a href={`/print/sales-order/${r.id}?as=proforma`} className="text-[11px] text-primary hover:underline" onClick={(e) => e.stopPropagation()}>{r.proformaNumber}</a>
          )}
        </span>
      ),
    },
    { key: 'status', header: 'Status', sortValue: (r) => r.status, cell: (r) => <StatusBadge status={r.status} /> },
    { key: 'invoices', header: 'Invoice', sortValue: (r) => r.invoices?.[0]?.number ?? '', cell: (r) => <InvoicesCell invoices={r.invoices} /> },
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
          <div className="flex flex-wrap justify-end gap-1.5" data-slot="order-next">
            {(r.stage ?? 'order') === 'order' && (
              <Button size="xs" variant="outline" className="gap-1" disabled={busy} onClick={() => void move(r, 'proforma')}>
                <FileText className="size-3" /> Proforma invoice
              </Button>
            )}
            {(r.stage ?? 'order') !== 'in_process' && r.stage !== 'ready' && (
              <Button size="xs" variant="outline" className="gap-1" disabled={busy} onClick={() => void move(r, 'in_process')}>
                <Hammer className="size-3" /> Work in process
              </Button>
            )}
            {r.stage !== 'ready' && (
              <Button size="xs" className="gap-1" disabled={busy} onClick={() => { setDate(today()); setReadying(r); }}>
                <PackageCheck className="size-3" /> Ready for delivery
              </Button>
            )}
            <Button size="xs" variant="ghost" className="gap-1" onClick={() => open(r, 'challan')} title="Deliver part of the order on a challan">
              <Truck className="size-3" /> Deliver part
            </Button>
            <Button size="xs" variant="ghost" className="gap-1" onClick={() => open(r, 'invoice')} title="Invoice part of the order now">
              Invoice part <ArrowRight className="size-3" />
            </Button>
          </div>
        ) : null,
    },
  ];

  return (
    <>
      <PageHeader
        title="Sales orders"
        description="Confirmed orders on their way to the invoice: send a proforma, mark the work in process, and Ready for delivery raises the tax invoice and the challan by itself."
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
                columns={[...columns, documentMenuColumn('sales-order', state.refetch)]}
                getRowId={(r) => r.id}
                selectable
                bulkActions={(selected) => <BulkPrintButton kind="sales-order" ids={selected.map((r) => r.id)} />}
                initialSort={{ key: 'date', dir: 'desc' }}
                dateFilter={{ getDate: (r) => r.date }}
                searchPlaceholder="Search order or customer…"
              />
            )}
          </>
        )}
      </AsyncPage>

      <Dialog open={!!readying} onOpenChange={(o) => !o && setReadying(null)}>
        <DialogContent data-slot="ready-dialog">
          <DialogHeader>
            <DialogTitle>{readying?.number} is ready for delivery</DialogTitle>
            <DialogDescription>
              This raises the tax invoice for everything still to invoice on the order, at its prices and discounts, and a
              delivery challan for the goods on it. Both are made now.
            </DialogDescription>
          </DialogHeader>
          <Field label="Invoice date"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          <p className="text-xs text-muted-foreground">The due date follows the customer&apos;s payment terms.</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReadying(null)}>Cancel</Button>
            <Button disabled={busy} onClick={() => readying && void move(readying, 'ready', date)} data-slot="ready-confirm">
              {busy ? 'Raising…' : 'Raise invoice and challan'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
