'use client';

// One recurring invoice profile, beside its list in Zoho Books' split view
// (recorded from Zoho's demo on 2026-11-23): the title band with the pencil
// (Edit), Create Invoice and More ▾ (Stop / Resume, Clone, Delete, and
// Rekonza's "create on its dates by itself"); the tabs Overview | Next Invoice
// | Recent Activities. Overview is Zoho's: the customer and DETAILS on the
// left (Profile Status, Start Date, End Date, Remaining billing cycle,
// Payment Terms, Salesperson), the Invoice Amount / Next Invoice Date /
// Recurring Period figures and "All Child Invoices" on the right.

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { ChevronDown, Loader2, Pencil } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { PageHeader } from '@/components/shared/page-header';
import { AsyncPage } from '@/components/shared/async-state';
import { Money } from '@/components/shared/money';
import { StatusBadge } from '@/components/shared/status-badge';
import { refreshSplitList, useSplitRecordRefresh } from '@/components/shared/record-split';
import { usePermission } from '@/lib/store/hooks';
import { useAppStore } from '@/lib/store';
import { useApi } from '@/lib/api/use-api';
import { recurringInvoices, type RecurringProfileDetail } from '@/lib/api/client';
import { termsOptions } from '@/lib/options';

const barButton = 'inline-flex h-8 items-center gap-1.5 rounded-[3px] border px-3 text-[13px] transition-colors hover:bg-accent disabled:opacity-50';
const day = (s: string | null) => (s ? new Date(`${s.slice(0, 10)}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '--');
const STATUS_WORD = { active: 'Active', stopped: 'Stopped', expired: 'Expired' } as const;

export function RecurringRecordView() {
  const { id } = useParams<{ id: string }>();
  const state = useApi<RecurringProfileDetail>(() => recurringInvoices.get(id), [id]);
  const reload = () => { void state.refetch(); refreshSplitList(); };
  useSplitRecordRefresh(reload);
  return <AsyncPage state={state}>{(p) => <Record p={p} reload={reload} />}</AsyncPage>;
}

function Record({ p, reload }: { p: RecurringProfileDetail; reload: () => void }) {
  const router = useRouter();
  const items = useAppStore((s) => s.items);
  const canCreate = usePermission('sales', 'create');
  const canEdit = usePermission('sales', 'edit');
  const [busy, setBusy] = useState(false);
  const terms = termsOptions().find((t) => t.value === p.paymentTerms)?.label ?? p.paymentTerms ?? '';
  const run = async (what: () => Promise<unknown>, ok: string, then?: (r: never) => void) => {
    setBusy(true);
    try {
      const r = await what();
      toast.success(ok);
      if (then) then(r as never); else reload();
    } catch (e) {
      toast.error('Not done', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const actions = (
    <>
      {canEdit && <Link href={`/sales/recurring/${p.id}/edit`} aria-label="Edit" className="grid size-8 place-items-center rounded-[3px] border transition-colors hover:bg-accent" data-slot="recurring-edit"><Pencil className="size-3.5" /></Link>}
      {canCreate && p.status === 'active' && (
        <button type="button" className={barButton} disabled={busy}
          onClick={() => void run(() => recurringInvoices.run(p.id), 'Invoice created', (r: { invoiceId: string }) => router.push(`/sales/invoices/${r.invoiceId}`))}
          data-slot="recurring-create-invoice">{busy && <Loader2 className="size-3.5 animate-spin" />} Create Invoice</button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger className={barButton} data-slot="recurring-more">More <ChevronDown className="size-3" /></DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-52">
          {canEdit && p.status !== 'expired' && (
            p.isActive
              ? <DropdownMenuItem onClick={() => void run(() => recurringInvoices.toggle(p.id, false), `${p.name} stopped`)} data-slot="recurring-stop">Stop</DropdownMenuItem>
              : <DropdownMenuItem onClick={() => void run(() => recurringInvoices.toggle(p.id, true), `${p.name} resumed`)} data-slot="recurring-resume">Resume</DropdownMenuItem>
          )}
          {canCreate && <DropdownMenuItem onClick={() => router.push(`/sales/recurring/new?clone=${p.id}`)} data-slot="recurring-clone">Clone</DropdownMenuItem>}
          {canEdit && (
            <DropdownMenuItem onClick={() => void run(() => recurringInvoices.auto(p.id, !p.autoRun), p.autoRun ? 'It waits for Create Invoice now' : 'It creates each invoice on its date now')} data-slot="recurring-auto">
              {p.autoRun ? 'Stop creating invoices by itself' : 'Create invoices on their dates by itself'}
            </DropdownMenuItem>
          )}
          {canEdit && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-destructive focus:text-destructive" data-slot="recurring-delete"
                onClick={() => { if (window.confirm(`Delete ${p.name}? Invoices it already created are kept.`)) void run(() => recurringInvoices.remove(p.id), `${p.name} deleted`, () => { refreshSplitList(); router.push('/sales/recurring'); }); }}>Delete</DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );

  return (
    <>
      <PageHeader title={p.name} actions={actions} />
      {p.lastError && <Card className="border-warning/40 bg-warning/10 px-5 py-3 text-[13px]" data-slot="recurring-error">{p.lastError}</Card>}
      <Card className="p-0" data-slot="recurring-body">
        <Tabs defaultValue="overview">
          <TabsList className="h-11 w-full justify-start rounded-none border-b bg-transparent px-5">
            <TabsTrigger value="overview" data-slot="tab-overview">Overview</TabsTrigger>
            <TabsTrigger value="next" data-slot="tab-next">Next Invoice</TabsTrigger>
            <TabsTrigger value="activity" data-slot="tab-activity">Recent Activities</TabsTrigger>
          </TabsList>
          <TabsContent value="overview" className="m-0">
            <div className="grid lg:grid-cols-[300px_1fr]">
              <div className="space-y-4 border-r p-5 text-[13px]" data-slot="recurring-details">
                <div className="border-b pb-3"><p className="font-medium">{p.customerName}</p>{p.customerEmail && <p className="text-muted-foreground">{p.customerEmail}</p>}</div>
                <p className="text-[12px] font-semibold uppercase">Details</p>
                {[
                  ['Profile Status:', <StatusBadge key="s" status={p.status === 'active' ? 'active' : p.status === 'expired' ? 'expired' : 'stopped'} />],
                  ['Entity type:', p.entityType === 'bill_of_supply' ? 'Bill Of Supply' : 'Invoice'],
                  ['Start Date:', day(p.startDate)],
                  ['End Date:', p.endDate ? day(p.endDate) : 'Never Expires'],
                  ['Remaining billing cycle:', p.remainingCycles == null ? 'Unlimited' : String(p.remainingCycles)],
                  ['Payment Terms:', terms],
                  ['Salesperson:', p.salespersonName ?? '--'],
                  ...(p.orderNumber ? [['Order Number:', p.orderNumber]] : []),
                  ...(p.priceListName ? [['Price List:', p.priceListName]] : []),
                  ...(p.projects?.length ? [['Project Hours:', p.projects.map((x) => x.name).join(', ')]] : []),
                  ...(p.paymentLink ? [['Payment Options:', 'Online payment link on each invoice']] : []),
                  ...(p.shippingChargePaise ? [['Shipping Charges:', <Money key="sh" value={p.shippingChargePaise} />]] : []),
                  ...(p.adjustmentPaise ? [[`${p.adjustmentLabel}:`, <Money key="ad" value={p.adjustmentPaise} />]] : []),
                  ['Round Off:', p.roundOff === 'whole' ? 'Nearest whole number' : 'No Rounding'],
                  ['Preferences:', p.createAsDraft ? 'Create Invoices as Drafts' : p.autoSend ? 'Send invoices automatically' : 'Create invoices, send by hand'],
                ].map(([k, v], i) => (
                  <div key={i} className="grid grid-cols-[130px_1fr] gap-2"><span className="text-muted-foreground">{k}</span><span>{v}</span></div>
                ))}
              </div>
              <div className="p-5">
                <div className="grid grid-cols-3 divide-x rounded-[var(--radius-card)] bg-muted/30 text-center text-[13px]" data-slot="recurring-figures">
                  <div className="p-3"><p className="text-muted-foreground">Invoice Amount</p><Money value={p.amountPaise} className="text-[15px] font-medium" /></div>
                  <div className="p-3"><p className="text-muted-foreground">Next Invoice Date</p><p className="text-[15px] font-medium">{p.status === 'active' ? day(p.nextRun) : '--'}</p></div>
                  <div className="p-3"><p className="text-muted-foreground">Recurring Period</p><p className="text-[15px] font-medium">{p.repeatLabel}</p></div>
                </div>
                <div className="mt-5 flex items-center justify-between">
                  <p className="text-[15px] font-medium">All Child Invoices</p>
                  <p className="text-[13px]">Unpaid Invoices : <Money value={p.unpaidPaise} className="text-link" /></p>
                </div>
                <div className="mt-2 divide-y rounded-[var(--radius-card)] border" data-slot="recurring-children">
                  {p.invoices.length === 0 ? <p className="p-5 text-center text-[13px] text-muted-foreground">No invoices created yet. The first one is due on {day(p.nextRun)}.</p> : p.invoices.map((i) => (
                    <div key={i.id} className="flex items-center justify-between gap-3 px-4 py-3 text-[13px]">
                      <div><p className="font-medium">{p.customerName}</p><p><Link href={`/sales/invoices/${i.id}`} className="text-link hover:underline">{i.number}</Link> <span className="text-muted-foreground">| {day(i.date)}</span></p></div>
                      <div className="text-right">
                        <Money value={i.totalPaise} className="font-medium" />
                        <p className="text-[11px] uppercase text-muted-foreground">{i.status.replace('_', ' ')}</p>
                        {canCreate && i.balancePaise > 0 && i.status !== 'void' && i.status !== 'draft' && (
                          <Button size="xs" asChild className="mt-1"><Link href={`/sales/payments/new?customer=${p.customerId}&invoice=${i.id}`}>Record Payment</Link></Button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </TabsContent>
          <TabsContent value="next" className="m-0 p-5" data-slot="recurring-next">
            <p className="mb-3 text-[13px] text-muted-foreground">{p.status === 'active' ? `The next invoice is created on ${day(p.nextRun)}${p.createAsDraft ? ', as a draft' : ''}.` : `${STATUS_WORD[p.status]}: no invoice is due.`}</p>
            <table className="w-full text-[13px]">
              <thead className="bg-[#f9f9fb] text-[11px] font-semibold uppercase text-[#6c718a]"><tr><th className="px-3 py-2 text-left">Item Details</th><th className="px-3 py-2 text-right">Quantity</th><th className="px-3 py-2 text-right">Rate</th><th className="px-3 py-2 text-right">Tax</th><th className="px-3 py-2 text-right">Amount</th></tr></thead>
              <tbody>
                {p.lines.map((l, i) => (
                  <tr key={i} className="border-t">
                    <td className="px-3 py-2">{(l.itemId && items.find((x) => x.id === String(l.itemId))?.name) || l.description}</td>
                    <td className="px-3 py-2 text-right">{l.qty}</td>
                    <td className="px-3 py-2 text-right"><Money value={l.ratePaise} /></td>
                    <td className="px-3 py-2 text-right">{l.gstRatePct}%</td>
                    <td className="px-3 py-2 text-right"><Money value={Math.round(l.ratePaise * l.qty)} /></td>
                  </tr>
                ))}
                <tr className="border-t"><td className="px-3 py-2" colSpan={4}>Sub Total</td><td className="px-3 py-2 text-right"><Money value={p.subTotalPaise} /></td></tr>
                {p.entityType !== 'bill_of_supply' && <tr><td className="px-3 py-1.5" colSpan={4}>Tax</td><td className="px-3 py-1.5 text-right"><Money value={p.taxPaise} /></td></tr>}
                {p.shippingChargePaise !== 0 && <tr data-slot="next-shipping"><td className="px-3 py-1.5" colSpan={4}>Shipping Charges</td><td className="px-3 py-1.5 text-right"><Money value={p.shippingChargePaise} /></td></tr>}
                {p.adjustmentPaise !== 0 && <tr data-slot="next-adjustment"><td className="px-3 py-1.5" colSpan={4}>{p.adjustmentLabel}</td><td className="px-3 py-1.5 text-right"><Money value={p.adjustmentPaise} /></td></tr>}
                <tr data-slot="next-round-off"><td className="px-3 py-1.5" colSpan={4}>Round Off <span className="text-muted-foreground">({p.roundOff === 'whole' ? 'Nearest Whole Number' : 'No Rounding'})</span></td><td className="px-3 py-1.5 text-right"><Money value={p.roundOffPaise} /></td></tr>
                <tr className="border-t font-medium"><td className="px-3 py-2" colSpan={4}>Total{p.entityType === 'bill_of_supply' ? ' (bill of supply, no tax)' : ''}</td><td className="px-3 py-2 text-right" data-slot="next-total"><Money value={p.amountPaise} /></td></tr>
              </tbody>
            </table>
          </TabsContent>
          <TabsContent value="activity" className="m-0 p-5">
            {p.activities.length === 0 ? <p className="text-[13px] text-muted-foreground">No activity yet.</p> : (
              <ul className="space-y-3 text-[13px]" data-slot="recurring-activities">
                {p.activities.map((a, i) => (
                  <li key={i} className="flex gap-3">
                    <span className="w-40 shrink-0 text-muted-foreground">{new Date(a.at).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
                    <span><span className="font-medium">{a.detail ?? a.action}</span>{a.actor && <span className="text-muted-foreground"> · by {a.actor}</span>}</span>
                  </li>
                ))}
              </ul>
            )}
          </TabsContent>
        </Tabs>
      </Card>
    </>
  );
}
