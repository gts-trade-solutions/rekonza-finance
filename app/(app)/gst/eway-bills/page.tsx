'use client';

// E-way bills.
//
// Goods worth more than ₹50,000 cannot legally move without one. Services do
// not move, so they never need one — which is why this list is filtered to
// goods consignments above the threshold rather than to every invoice.
//
// Validity is one day per 200 km, minimum one day, counted from when Part B —
// the vehicle — is entered, and running to midnight of the last day. An
// expired bill on a lorry that is still in transit is a detention risk, so the
// expiry is shown rather than buried.
//
// A generated bill can still change: the goods move to another lorry, the
// journey outlasts the validity, or the bill turns out to be wrong. The row's
// menu offers each only while the law allows it — a new vehicle while the bill
// is valid, an extension in the 8 hours either side of expiry, cancellation in
// the first 24 hours — and the server checks the same rules again.

import { useState } from 'react';
import { Ban, CalendarClock, Loader2, MoreHorizontal, Truck } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { PageHeader } from '@/components/shared/page-header';
import { DataTable, type Column } from '@/components/shared/data-table';
import { Money } from '@/components/shared/money';
import { StatusBadge } from '@/components/shared/status-badge';
import { EmptyState } from '@/components/shared/empty-state';
import { StatTile } from '@/components/shared/stat-tile';
import { AsyncPage } from '@/components/shared/async-state';
import { Field } from '@/components/shared/form-bits';
import {
  CancelEwayBillDialog, ChangeVehicleDialog, ExtendEwayBillDialog, ewbTime,
} from '@/components/gst/eway-bill-dialogs';
import { gst, type EwayBillRow } from '@/lib/api/client';
import { useApi, useApiAction } from '@/lib/api/use-api';
import { usePermission } from '@/lib/store/hooks';
import { formatINRCompact } from '@/lib/money';
import { cn } from '@/lib/utils';

/** A generated bill whose validity has run out. */
const hasExpired = (r: EwayBillRow) =>
  r.status === 'generated' && !!r.validUntil && Date.parse(r.validUntil) < Date.now();

/** "14:32" in Indian time. */
const clock = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).format(
    new Date(iso),
  );

export default function EwayBillsPage() {
  const canGenerate = usePermission('gst', 'approve');
  const state = useApi<{ ewayBills: EwayBillRow[] }>(() => gst.ewayBills(), []);

  const [target, setTarget] = useState<EwayBillRow | null>(null);
  const [vehicleNo, setVehicleNo] = useState('');
  const [transporter, setTransporter] = useState('');
  const [distance, setDistance] = useState(100);
  const [vehicleFor, setVehicleFor] = useState<EwayBillRow | null>(null);
  const [extendFor, setExtendFor] = useState<EwayBillRow | null>(null);
  const [cancelFor, setCancelFor] = useState<EwayBillRow | null>(null);

  const generate = useApiAction(gst.generateEwayBill);

  const rows = state.data?.ewayBills ?? [];
  const generated = rows.filter((r) => r.status === 'generated');
  // Listed and *required* are different things. Every goods document over
  // ₹50,000 is listed, but a state may set a higher intra-state threshold, so
  // some of those rows need nothing. Counting them as outstanding would put a
  // permanent warning tile in front of somebody with nothing to do.
  const needed = rows.filter((r) => r.status !== 'generated' && r.required);
  const expired = rows.filter(hasExpired);
  const blocked = rows.filter((r) => r.blockers.length > 0);

  const submit = async () => {
    if (!target) return;
    const done = await generate.run({
      // A challan carries no invoice id, so the row says which it is.
      ...(target.docKind === 'invoice'
        ? { invoiceId: target.docId }
        : { challanId: target.docId }),
      vehicleNo: vehicleNo || null,
      transporterName: transporter || null,
      distanceKm: distance,
    });
    if (!done) {
      toast.error(generate.error ?? 'The e-way bill was not generated');
      return;
    }
    const days = Math.max(1, Math.ceil(distance / 200));
    toast.success(`E-way bill ${done.ewayBillNo} generated`, {
      description:
        `Valid ${days} day${days === 1 ? '' : 's'} — one per 200 km — until ` +
        `${done.validUntil.slice(0, 16)}.` +
        (done.live ? '' : ' Nothing was filed: this went to the stand-in, not the live portal.'),
    });
    setTarget(null);
    setVehicleNo('');
    setTransporter('');
    state.refetch();
  };

  const columns: Column<EwayBillRow>[] = [
    {
      key: 'ewb', header: 'E-way bill no.', sortValue: (r) => r.ewayBillNo ?? '',
      cell: (r) =>
        r.ewayBillNo ? (
          <div className="flex items-center gap-1.5">
            <span
              className={cn(
                'font-mono font-medium',
                r.status === 'cancelled' && 'text-muted-foreground line-through decoration-1',
              )}
            >
              {r.ewayBillNo}
            </span>
            {r.extendedCount > 0 && (
              <Badge variant="outline" className="text-[9px]">Extended ×{r.extendedCount}</Badge>
            )}
          </div>
        ) : r.required ? (
          <Badge variant="outline" className="border-amber-500/40 text-[10px]">Needed</Badge>
        ) : (
          // Listed because it is over ₹50,000, but under this state's own
          // limit. Saying "Needed" here contradicted the column beside it.
          <span className="text-xs text-muted-foreground">—</span>
        ),
    },
    {
      key: 'invoice', header: 'Document', sortValue: (r) => r.number,
      cell: (r) => (
        // The reason sits under the document rather than in a column of its
        // own. As a separate column it pushed the Generate button off the edge
        // of an ordinary laptop screen — the one action this page exists for.
        // The cells are nowrap, right for figures and wrong for a sentence,
        // hence the override.
        <div className="w-[18rem] whitespace-normal">
          <div className="flex items-center gap-1.5">
            <p className="font-medium">{r.number}</p>
            {/* A challan is the case people miss — worth saying so on the row. */}
            {r.docKind === 'challan' && (
              <Badge variant="outline" className="text-[9px]">Challan</Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground">{r.customerName}</p>
          <p
            className={cn(
              'mt-1 text-xs leading-snug',
              r.required ? 'text-amber-700 dark:text-amber-300' : 'text-muted-foreground',
            )}
          >
            {r.requirementReason}
          </p>
          {r.blockers.map((b) => (
            <p key={b} className="mt-1 text-xs leading-snug text-destructive">{b}</p>
          ))}
          {r.errorMessage && (
            <p className="mt-1 text-xs leading-snug text-destructive">Last attempt failed: {r.errorMessage}</p>
          )}
          {r.retry && (
            <p className="mt-1 text-xs leading-snug text-muted-foreground">
              The portal did not answer; trying again on its own at {clock(r.retry.at)}.
            </p>
          )}
        </div>
      ),
    },
    {
      key: 'date', header: 'Date', sortValue: (r) => r.date,
      cell: (r) => <span className="tabular text-xs">{new Date(r.date).toLocaleDateString('en-IN')}</span>,
    },
    {
      key: 'vehicle', header: 'Vehicle', sortValue: (r) => r.vehicleNo ?? '',
      cell: (r) => <span className="font-mono text-xs">{r.vehicleNo ?? '—'}</span>,
    },
    {
      key: 'distance', header: 'Distance', align: 'right', sortValue: (r) => r.distanceKm ?? 0,
      cell: (r) => <span className="tabular">{r.distanceKm ? `${r.distanceKm} km` : '—'}</span>,
    },
    {
      key: 'valid', header: 'Valid until', sortValue: (r) => r.validUntil ?? '',
      cell: (r) => {
        if (!r.validUntil || r.status !== 'generated') {
          return <span className="text-xs text-muted-foreground">—</span>;
        }
        const past = hasExpired(r);
        return (
          <div className="flex items-center gap-2">
            <span className={cn('tabular text-xs', past && 'text-destructive')}>{ewbTime(r.validUntil)}</span>
            {past && <Badge variant="outline" className="border-red-500/40 text-[9px]">Expired</Badge>}
          </div>
        );
      },
    },
    { key: 'status', header: 'Status', sortValue: (r) => r.status, cell: (r) => <StatusBadge status={r.status} /> },
    {
      key: 'value', header: 'Consignment', align: 'right', sortValue: (r) => r.totalPaise,
      cell: (r) => <Money value={r.totalPaise} />,
    },
    {
      key: 'actions', header: '', align: 'right',
      cell: (r) => {
        if (!canGenerate) return null;
        if (r.status === 'generated') {
          return (
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label={`Actions for e-way bill ${r.ewayBillNo}`}
                className="grid size-7 place-items-center rounded-[3px] border transition-colors hover:bg-accent"
                data-slot="ewb-actions"
              >
                <MoreHorizontal className="size-3.5" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-64">
                <DropdownMenuItem disabled={!r.changeable} onClick={() => setVehicleFor(r)}>
                  <Truck className="mr-2 size-4" /> Change vehicle
                </DropdownMenuItem>
                <DropdownMenuItem disabled={!r.extension?.allowed} onClick={() => setExtendFor(r)}>
                  <CalendarClock className="mr-2 size-4 shrink-0" />
                  <span>
                    Extend validity
                    {r.extension && !r.extension.allowed && (
                      <span className="block whitespace-normal text-[10px] leading-snug text-muted-foreground">
                        {r.extension.reason}
                      </span>
                    )}
                  </span>
                </DropdownMenuItem>
                {r.cancelUntil && (
                  <DropdownMenuItem onClick={() => setCancelFor(r)}>
                    <Ban className="mr-2 size-4" /> Cancel e-way bill
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          );
        }
        // Not generated, a failed attempt, or a bill cancelled while the goods
        // still have to move: each needs a bill, and each can have one.
        return (
          <Button
            size="xs"
            // Blocked means the portal will refuse it — a document past 180
            // days can never carry a bill, so offering the button would be
            // offering something that cannot work.
            disabled={r.blockers.length > 0}
            variant={r.required ? 'default' : 'outline'}
            onClick={(e) => {
              e.stopPropagation();
              setTarget(r);
              setDistance(100);
            }}
          >
            {r.status === 'pending' ? 'Try again' : r.status === 'cancelled' ? 'Generate again' : 'Generate'}
          </Button>
        );
      },
    },
  ];

  return (
    <>
      <PageHeader
        title="E-way bills"
        description={
          'Goods over ₹50,000 cannot move without one — and some states set a higher limit inside their ' +
          'own borders. Delivery challans are listed too: sending material out for job work is not a sale, ' +
          'but the lorry still has to be declared, and between states it needs a bill at any value.'
        }
      />

      <AsyncPage state={state}>
        {(d) => (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <StatTile
                label="Needing a bill"
                value={String(needed.length)}
                sub={formatINRCompact(needed.reduce((t, r) => t + r.totalPaise, 0))}
                icon={Truck}
                tone={needed.length ? 'warning' : 'positive'}
              />
              <StatTile
                label="Generated"
                value={String(generated.length)}
                sub={formatINRCompact(generated.reduce((t, r) => t + r.totalPaise, 0))}
                tone="positive"
              />
              <StatTile
                label={blocked.length ? 'Past 180 days' : 'Expired'}
                value={String(blocked.length || expired.length)}
                sub={
                  blocked.length
                    ? 'Too old to ever carry a bill'
                    : 'Still in transit is a detention risk'
                }
                tone={blocked.length || expired.length ? 'danger' : 'default'}
              />
            </div>

            {d.ewayBills.length === 0 ? (
              <EmptyState
                icon={Truck}
                title="No consignments above the threshold"
                description="Only goods invoices over ₹50,000 need an e-way bill."
              />
            ) : (
              <DataTable
                rows={d.ewayBills}
                columns={columns}
                // Invoice ids and challan ids are separate sequences, so the
                // kind has to be part of the key or two rows can collide.
                getRowId={(r) => `${r.docKind}:${r.docId}`}
                initialSort={{ key: 'date', dir: 'desc' }}
                searchPlaceholder="Search invoice, customer or vehicle…"
              />
            )}
          </>
        )}
      </AsyncPage>

      <Dialog open={!!target} onOpenChange={(v) => !v && setTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Generate e-way bill for {target?.number}</DialogTitle>
            <DialogDescription>
              A vehicle number is Part B, and validity only starts counting once it is entered — one day per
              200 km, running to midnight of the last day. Getting the distance wrong is the usual reason a
              bill expires with the lorry still on the road.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <Field label="Vehicle number" required hint="Part B — the bill authorises nothing without it">
                <Input
                  value={vehicleNo}
                  onChange={(e) => setVehicleNo(e.target.value.toUpperCase())}
                  placeholder="AA00AA0000"
                  className="font-mono"
                />
              </Field>
              <Field label="Distance (km)" required>
                <Input
                  type="number"
                  min="1"
                  value={distance}
                  onChange={(e) => setDistance(Math.max(1, Number(e.target.value) || 1))}
                />
              </Field>
            </div>
            <Field label="Transporter">
              <Input
                value={transporter}
                onChange={(e) => setTransporter(e.target.value)}
                placeholder="Transporter name"
              />
            </Field>
            <div className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
              Consignment value <Money value={target?.totalPaise ?? 0} className="font-medium text-foreground" /> ·
              valid for {Math.max(1, Math.ceil(distance / 200))} day
              {Math.max(1, Math.ceil(distance / 200)) === 1 ? '' : 's'}
            </div>
            {generate.error && <p className="text-sm text-destructive">{generate.error}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTarget(null)}>Cancel</Button>
            <Button onClick={submit} disabled={generate.busy}>
              {generate.busy ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
              {generate.busy ? 'Generating…' : 'Generate'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Keyed by the bill, so each opening starts with an empty form. */}
      <ChangeVehicleDialog
        key={`vehicle-${vehicleFor?.id ?? ''}`}
        bill={vehicleFor}
        onClose={() => setVehicleFor(null)}
        onDone={() => state.refetch()}
      />
      <ExtendEwayBillDialog
        key={`extend-${extendFor?.id ?? ''}`}
        bill={extendFor}
        onClose={() => setExtendFor(null)}
        onDone={() => state.refetch()}
      />
      <CancelEwayBillDialog
        key={`cancel-${cancelFor?.id ?? ''}`}
        bill={cancelFor}
        onClose={() => setCancelFor(null)}
        onDone={() => state.refetch()}
      />
    </>
  );
}
