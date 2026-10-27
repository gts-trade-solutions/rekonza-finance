'use client';

// The e-invoice queue.
//
// A B2B invoice above the turnover threshold is not legally valid without an
// IRN, and the portal only accepts one within 30 days of the invoice date.
// After that the invoice cannot be made valid at all — the only remedy is a
// credit note and a fresh invoice. So the days-left column is the whole point
// of this screen.
//
// Registration goes through whichever connection the branch has in Settings →
// Integrations. Until one is added the built-in stand-in answers: nothing is
// filed, and its IRNs start with DEMO so nothing can mistake them for ones the
// government issued. A registered IRN can be cancelled for 24 hours, which
// voids the invoice with it; after that only a credit note reverses the sale.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Ban, Clock, FileCheck2, Info, Loader2, TriangleAlert, Zap } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/shared/page-header';
import { DataTable, type Column } from '@/components/shared/data-table';
import { Money } from '@/components/shared/money';
import { StatTile } from '@/components/shared/stat-tile';
import { StatusBadge } from '@/components/shared/status-badge';
import { AsyncPage } from '@/components/shared/async-state';
import { CancelEinvoiceDialog } from '@/components/gst/cancel-einvoice-dialog';
import { PortalSetupCard } from '@/components/gst/portal-setup-card';
import { gst, type EinvoiceRow, type PortalReadiness } from '@/lib/api/client';
import { useApi, useApiAction } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';
import { formatINRCompact } from '@/lib/money';
import { timeLeft } from '@/lib/tax/einvoice';
import { cn } from '@/lib/utils';

interface Response {
  einvoices: EinvoiceRow[];
  statusCounts: Record<string, number>;
  portal: PortalReadiness;
}

/** "14:32" in Indian time. */
const clock = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).format(
    new Date(iso),
  );

export default function EInvoicesPage() {
  const router = useRouter();
  const canSubmit = usePermission('gst', 'approve');
  const state = useApi<Response>(() => gst.einvoices(), []);

  const [busy, setBusy] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [cancelling, setCancelling] = useState<EinvoiceRow | null>(null);
  const submit = useApiAction(gst.submitEinvoice);

  const rows = state.data?.einvoices ?? [];
  const pending = rows.filter((r) => r.status === 'pending' || r.status === 'failed');
  const registered = rows.filter((r) => r.status === 'submitted');
  const urgent = pending.filter((r) => r.daysLeft <= 7);
  const expired = pending.filter((r) => r.daysLeft < 0);

  const submitOne = async (r: EinvoiceRow) => {
    setBusy(r.invoiceId);
    const done = await submit.run(r.invoiceId);
    setBusy(null);
    if (!done) {
      // Most refusals now come from our own pre-flight check rather than the
      // portal, and they name the field — so the message is worth showing in
      // full rather than summarising it away.
      toast.error(`${r.number} was not registered`, { description: submit.error ?? undefined });
      return;
    }
    toast.success(`IRN generated for ${r.number}`, {
      description: [
        done.live ? null : 'Nothing was filed: this went to the stand-in or a sandbox, not the live portal.',
        done.ewayBillNo ? `E-way bill ${done.ewayBillNo} was issued with it.` : null,
        ...done.warnings,
      ]
        .filter(Boolean)
        .join(' ') || undefined,
    });
    state.refetch();
  };

  const submitAll = async () => {
    setBulkBusy(true);
    let ok = 0;
    let failed = 0;
    for (const r of pending) {
      const done = await submit.run(r.invoiceId);
      if (done) ok++;
      else failed++;
    }
    setBulkBusy(false);
    if (failed === 0) toast.success(`${ok} invoice(s) registered`);
    else toast.warning(`${ok} registered, ${failed} rejected`, {
      description: 'Open the failed ones to see what the portal objected to.',
    });
    state.refetch();
  };

  const columns: Column<EinvoiceRow>[] = [
    {
      key: 'number', header: 'Invoice', sortValue: (r) => r.number,
      cell: (r) => <span className="font-medium">{r.number}</span>,
    },
    {
      key: 'date', header: 'Date', sortValue: (r) => r.date,
      cell: (r) => <span className="tabular text-xs">{new Date(r.date).toLocaleDateString('en-IN')}</span>,
    },
    { key: 'customer', header: 'Customer', sortValue: (r) => r.customerName, cell: (r) => r.customerName },
    {
      key: 'gstin', header: 'GSTIN', sortValue: (r) => r.gstin ?? '',
      cell: (r) => <span className="font-mono text-[10px]">{r.gstin ?? '—'}</span>,
    },
    { key: 'status', header: 'Status', sortValue: (r) => r.status, cell: (r) => <StatusBadge status={r.status} /> },
    {
      key: 'window', header: 'Registration window', sortValue: (r) => r.daysLeft,
      cell: (r) => {
        if (r.status === 'submitted') {
          return (
            <span className="block">
              <span className="font-mono text-[10px] text-muted-foreground">{r.irn?.slice(0, 20)}…</span>
              {r.cancelUntil && (
                <span className="block text-[10px] text-muted-foreground">
                  Cancellable for {timeLeft(r.cancelUntil)}
                </span>
              )}
            </span>
          );
        }
        if (r.status === 'not_applicable' || r.status === 'cancelled') {
          return <span className="text-xs text-muted-foreground">—</span>;
        }
        return (
          <span className="block">
            <Badge
              variant="outline"
              className={cn(
                'text-[10px]',
                r.daysLeft < 0
                  ? 'border-destructive/40 text-destructive'
                  : r.daysLeft <= 7
                    ? 'border-amber-500/40 text-amber-700 dark:text-amber-300'
                    : '',
              )}
            >
              {r.daysLeft < 0 ? `${Math.abs(r.daysLeft)} days past` : `${r.daysLeft} days left`}
            </Badge>
            {r.retry && (
              <span className="mt-0.5 block text-[10px] text-muted-foreground" data-slot="einvoice-retry">
                Trying again at {clock(r.retry.at)}
              </span>
            )}
          </span>
        );
      },
    },
    {
      key: 'total', header: 'Value', align: 'right', sortValue: (r) => r.totalPaise,
      cell: (r) => <Money value={r.totalPaise} />,
    },
    {
      key: 'actions', header: '', align: 'right',
      cell: (r) => {
        if (!canSubmit) return null;
        if (r.status === 'pending' || r.status === 'failed') {
          return (
            <Button
              size="xs"
              className="gap-1"
              disabled={busy === r.invoiceId || bulkBusy}
              onClick={(e) => { e.stopPropagation(); void submitOne(r); }}
            >
              {busy === r.invoiceId ? <Loader2 className="size-3 animate-spin" /> : <Zap className="size-3" />}
              Register
            </Button>
          );
        }
        if (r.status === 'submitted' && r.cancelUntil) {
          return (
            <Button
              size="xs"
              variant="outline"
              className="gap-1"
              data-slot="cancel-irn"
              onClick={(e) => { e.stopPropagation(); setCancelling(r); }}
            >
              <Ban className="size-3" /> Cancel IRN
            </Button>
          );
        }
        return null;
      },
    },
  ];

  return (
    <>
      <PageHeader
        title="E-invoicing"
        description="B2B invoices must be registered with the government portal within 30 days, or they are not legally valid."
        actions={
          canSubmit &&
          pending.length > 0 && (
            <Button size="sm" className="gap-1.5" disabled={bulkBusy} onClick={() => void submitAll()}>
              {bulkBusy ? <Loader2 className="size-3.5 animate-spin" /> : <Zap className="size-3.5" />}
              {bulkBusy ? 'Registering…' : `Register all ${pending.length}`}
            </Button>
          )
        }
      />

      <AsyncPage state={state}>
        {(d) => (
          <>
            <PortalSetupCard portal={d.portal} />

            <div className="grid gap-3 sm:grid-cols-3">
              <StatTile
                label="Awaiting an IRN"
                value={String(pending.length)}
                sub={formatINRCompact(pending.reduce((t, r) => t + r.totalPaise, 0))}
                icon={Clock}
                tone={pending.length ? 'warning' : 'positive'}
              />
              <StatTile
                label="Window closing"
                value={String(urgent.length)}
                sub={expired.length ? `${expired.length} already past 30 days` : 'Within 7 days of the deadline'}
                icon={TriangleAlert}
                tone={expired.length ? 'danger' : urgent.length ? 'warning' : 'positive'}
              />
              <StatTile
                label="Registered"
                value={String(registered.length)}
                sub={formatINRCompact(registered.reduce((t, r) => t + r.totalPaise, 0))}
                icon={FileCheck2}
                tone="positive"
              />
            </div>

            {expired.length > 0 && (
              <Card className="flex items-start gap-3 border-destructive/40 bg-destructive/5 p-4">
                <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
                <p className="text-xs leading-relaxed text-muted-foreground">
                  <span className="font-medium text-foreground">
                    {expired.length} invoice(s) are past the 30-day window.
                  </span>{' '}
                  The portal will no longer accept them, so they cannot be made valid. The remedy is a credit note
                  against each and a fresh invoice dated today.
                </p>
              </Card>
            )}

            <DataTable
              rows={d.einvoices}
              columns={columns}
              getRowId={(r) => r.id}
              onRowClick={(r) => router.push(`/sales/invoices/${r.invoiceId}`)}
              initialSort={{ key: 'window', dir: 'asc' }}
              dateFilter={{ getDate: (r) => r.date }}
              searchPlaceholder="Search invoice or customer…"
              emptyMessage="No invoices need an IRN."
            />

            <Card className="flex items-start gap-3 p-4">
              <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <p className="text-xs leading-relaxed text-muted-foreground">
                Registrations go through the connection set for each branch in Settings → Integrations. Until one
                is added, the built-in stand-in answers: nothing is filed, and its IRNs start with{' '}
                <span className="font-mono">DEMO</span> so they can never be mistaken for government-issued ones. A
                registered IRN can be cancelled for 24 hours, which also voids the invoice; after that, a credit
                note reverses the sale.
              </p>
            </Card>
          </>
        )}
      </AsyncPage>

      <CancelEinvoiceDialog
        open={cancelling !== null}
        onOpenChange={(open) => {
          if (!open) setCancelling(null);
        }}
        invoiceId={cancelling?.invoiceId ?? ''}
        number={cancelling?.number ?? ''}
        cancelUntil={cancelling?.cancelUntil ?? null}
        onCancelled={() => state.refetch()}
      />
    </>
  );
}
