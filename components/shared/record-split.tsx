'use client';

// Zoho Books' split view. Opening a record from a list does not leave the
// list: it narrows to a column on the left (the name, the amount, the number
// and date, the status) with the open record lit, and the record fills the
// rest. For a transaction (an invoice, a bill), whose page is wide, the sidebar
// folds to its icon rail while it is open; for an item, a customer or a vendor
// Zoho keeps the sidebar open, and so does this. The X at the record's top
// right goes back to the full list.
//
// It is a layout at the module's level (app/(app)/sales/invoices/layout.tsx
// and the rest), so the list on the left stays loaded while you click from
// record to record. The list's own address, the new-record form and a record's
// sub-pages (print, statement, self-invoice) pass straight through.
//
// The record's header becomes Zoho's two bands: the title band, and under it
// the grey action bar with the buttons laid flat (globals.css, "split view").
// The top bar's search filters the column on the left, as Zoho's does.
//
// Where a module has bulk actions, each row in the column has Zoho's tick, and
// ticking rows turns the column's header into "N Selected" and its "Bulk
// Actions" menu (items: Mark as Active, Mark as Inactive, Delete).

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, MoreHorizontal, Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSub, DropdownMenuSubContent,
  DropdownMenuSubTrigger, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { Money } from '@/components/shared/money';
import { StatusBadge } from '@/components/shared/status-badge';
import { InvoiceStatus } from '@/components/shared/invoice-status';
import { usePermission } from '@/lib/store/hooks';
import { bills, contacts, invoices, items, payments, projects, recurringInvoices, salesDocuments, type ContactRow, type ItemRow, type SalesDocRow } from '@/lib/api/client';
import { SALES_DOC, VIEWS, zohoDay, zohoStatus, type SalesDocKindZ } from '@/components/sales/sales-docs';
import { useForceNavCollapsed } from '@/components/layout/nav-state';
import { claimListSearch, releaseListSearch } from '@/components/layout/page-context';

export type SplitKind = 'invoice' | 'bill' | 'customer' | 'vendor' | 'project' | 'item' | 'payment-received' | 'retainer' | 'recurring-invoice' | SalesDocKindZ;

interface SplitRow {
  id: string;
  title: string;
  amount?: number;
  sub: string;
  status?: ReactNode;
  search: string;
  /** The record as the list read it, for bulk actions. */
  raw?: unknown;
}

/** A view of the column (Zoho's "All Items ▾"): its heading and which rows it keeps. */
interface SplitView { value: string; title: string; keep: (r: SplitRow) => boolean }
/** A "Sort by" choice in the column's ⋯. */
interface SplitSort { key: string; label: string; value: (r: SplitRow) => string | number }

/** A module's bulk actions on the ticked rows; `done` clears the ticks and reloads. */
type BulkActions = ComponentType<{ picked: SplitRow[]; openId: string; done: (left?: boolean) => void }>;

/** Zoho's customer and vendor bulk actions in the column: Mark as Active, Mark as Inactive, Delete (an unused one only). */
function ContactBulk({ picked, openId, done }: { picked: SplitRow[]; openId: string; done: (left?: boolean) => void }) {
  const vendor = (picked[0]?.raw as ContactRow | undefined)?.kind === 'vendor';
  const canEdit = usePermission(vendor ? 'purchases' : 'sales', 'edit');
  const canDelete = usePermission(vendor ? 'purchases' : 'sales', 'void');
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const rows = picked.map((p) => p.raw as ContactRow);
  const run = async (what: string, todo: ContactRow[], act: (c: ContactRow) => Promise<unknown>) => {
    setBusy(true);
    const failed: string[] = [];
    for (const c of todo) {
      try { await act(c); } catch (e) { failed.push(`${c.displayName}: ${e instanceof Error ? e.message : String(e)}`); }
    }
    setBusy(false);
    const n = todo.length - failed.length;
    if (n) toast.success(`${n} ${what}`);
    if (failed.length) toast.error(`${failed.length} not changed`, { description: failed.slice(0, 3).join(' · ') });
    return failed;
  };
  if (!canEdit && !canDelete) return null;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger data-slot="split-bulk" disabled={busy}
          className="inline-flex h-8 items-center gap-1 rounded-[var(--radius-button)] border border-secondary-border bg-secondary px-2.5 text-[13px] outline-none hover:brightness-[0.98]">
          Bulk Actions <ChevronDown className="size-3.5" strokeWidth={2.2} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-44">
          {canEdit && <DropdownMenuItem onClick={() => void run('marked as active', rows.filter((c) => c.isArchived), (c) => contacts.update({ id: c.id, isArchived: false, expectedUpdatedAt: c.updatedAt })).then(() => done())}>Mark as Active</DropdownMenuItem>}
          {canEdit && <DropdownMenuItem onClick={() => void run('marked as inactive', rows.filter((c) => !c.isArchived), (c) => contacts.update({ id: c.id, isArchived: true, expectedUpdatedAt: c.updatedAt })).then(() => done())}>Mark as Inactive</DropdownMenuItem>}
          {canDelete && <DropdownMenuItem onClick={() => setConfirming(true)}>Delete</DropdownMenuItem>}
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete {rows.length}?</DialogTitle>
            <DialogDescription>Only one never used is deleted. One on a document or a payment is kept: mark it as inactive instead.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(false)}>Cancel</Button>
            <Button variant="destructive" disabled={busy} onClick={async () => {
              const failed = await run('deleted', rows, (c) => contacts.remove(c.id));
              setConfirming(false);
              done(rows.some((c) => c.id === openId) && !failed.some((f) => f.startsWith(`${rows.find((c) => c.id === openId)?.displayName}:`)));
            }}>{busy ? 'Deleting…' : 'Delete'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** A contact column's views and sorts (Zoho's "All Customers ▾" and its ⋯ → Sort by). */
function contactViews(noun: 'Customers' | 'Vendors'): SplitView[] {
  const c = (r: SplitRow) => r.raw as ContactRow;
  const owed = (r: SplitRow) => (noun === 'Customers' ? c(r).receivablePaise : c(r).payablePaise);
  return [
    { value: 'all', title: `All ${noun}`, keep: () => true },
    { value: 'active', title: `Active ${noun}`, keep: (r) => !c(r).isArchived },
    { value: 'duplicate', title: `Duplicate ${noun}`, keep: (r) => !!c(r).duplicate },
    { value: 'inactive', title: `Inactive ${noun}`, keep: (r) => c(r).isArchived },
    ...(noun === 'Customers' ? [
      { value: 'portal_on', title: 'Client Portal Enabled', keep: (r: SplitRow) => !!c(r).portalEnabled },
      { value: 'portal_off', title: 'Client Portal Disabled', keep: (r: SplitRow) => !c(r).portalEnabled },
    ] : []),
    ...(noun === 'Customers' ? [
      { value: 'overdue', title: `Overdue ${noun}`, keep: (r: SplitRow) => !!c(r).overdue },
      { value: 'unpaid', title: `Unpaid ${noun}`, keep: (r: SplitRow) => owed(r) > 0 },
    ] : [
      { value: 'reorder', title: 'Vendors - Reorder Items', keep: (r: SplitRow) => !!c(r).reorder },
    ]),
  ];
}
function contactSorts(noun: 'Customers' | 'Vendors'): SplitSort[] {
  const c = (r: SplitRow) => r.raw as ContactRow;
  return [
    { key: 'name', label: 'Name', value: (r) => r.title.toLowerCase() },
    { key: 'company', label: 'Company Name', value: (r) => (c(r).legalName ?? '').toLowerCase() },
    { key: 'balance', label: noun === 'Customers' ? 'Receivables' : 'Payables', value: (r) => r.amount ?? 0 },
    { key: 'unused', label: 'Unused Credits', value: (r) => (noun === 'Customers' ? c(r).unusedCreditsPaise : c(r).vendorUnusedCreditsPaise) ?? 0 },
    { key: 'created', label: 'Created Time', value: (r) => c(r).createdAt ?? '' },
    { key: 'updated', label: 'Last Modified Time', value: (r) => c(r).updatedAt ?? '' },
  ];
}

/** Zoho's item bulk actions: Mark as Active, Mark as Inactive, Delete (an unused item only). */
function ItemBulk({ picked, openId, done }: { picked: SplitRow[]; openId: string; done: (left?: boolean) => void }) {
  const canEdit = usePermission('sales', 'edit');
  const canDelete = usePermission('sales', 'void');
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const rows = picked.map((p) => p.raw as ItemRow);
  const run = async (what: string, todo: ItemRow[], act: (r: ItemRow) => Promise<unknown>) => {
    setBusy(true);
    const failed: string[] = [];
    for (const r of todo) {
      try { await act(r); } catch (e) { failed.push(`${r.name}: ${e instanceof Error ? e.message : String(e)}`); }
    }
    setBusy(false);
    const n = todo.length - failed.length;
    if (n) toast.success(`${n} item${n === 1 ? '' : 's'} ${what}`);
    if (failed.length) toast.error(`${failed.length} not changed`, { description: failed.slice(0, 3).join(' · ') });
    return failed;
  };
  const setActive = async (makeActive: boolean) => {
    await run(makeActive ? 'marked as active' : 'marked as inactive', rows.filter((r) => r.isArchived === makeActive),
      (r) => items.update({ id: r.id, isArchived: !makeActive, expectedUpdatedAt: r.updatedAt }));
    done();
  };
  const remove = async () => {
    const failed = await run('deleted', rows, (r) => items.remove(r.id));
    setConfirming(false);
    done(rows.some((r) => r.id === openId) && !failed.some((f) => f.startsWith(`${rows.find((r) => r.id === openId)?.name}:`)));
  };
  if (!canEdit && !canDelete) return null;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger data-slot="split-bulk" disabled={busy}
          className="inline-flex h-8 items-center gap-1 rounded-[var(--radius-button)] border border-secondary-border bg-secondary px-2.5 text-[13px] outline-none hover:brightness-[0.98]">
          Bulk Actions <ChevronDown className="size-3.5" strokeWidth={2.2} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-44">
          {canEdit && <DropdownMenuItem onClick={() => void setActive(true)}>Mark as Active</DropdownMenuItem>}
          {canEdit && <DropdownMenuItem onClick={() => void setActive(false)}>Mark as Inactive</DropdownMenuItem>}
          {canDelete && <DropdownMenuItem onClick={() => setConfirming(true)}>Delete</DropdownMenuItem>}
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete {rows.length} item{rows.length === 1 ? '' : 's'}?</DialogTitle>
            <DialogDescription>Only items never used are deleted. One on a document, a price list or in stock is kept: mark it as inactive instead.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(false)}>Cancel</Button>
            <Button variant="destructive" disabled={busy} onClick={() => void remove()}>{busy ? 'Deleting…' : 'Delete'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** "28 May 2026", as Zoho's column dates a record ("Sep", not the browser's "Sept"). */
const day = (d: string) => zohoDay(d);

/** A quote's, order's, challan's or credit note's column: its views and sorts are its list's. */
function salesDocSplit(kind: SalesDocKindZ) {
  const info = SALES_DOC[kind];
  const raw = (r: SplitRow) => r.raw as SalesDocRow;
  return {
    label: info.plural,
    base: info.base,
    newHref: `${info.base}/new`,
    module: 'sales' as const,
    keepNav: true,
    redClose: true,
    load: async () => (await salesDocuments.list(kind, { limit: 300 })).documents.map((d): SplitRow => ({
      id: d.id,
      title: d.customerName,
      amount: d.totalPaise,
      sub: `${d.number} • ${day(d.date)}`,
      status: <StatusBadge status={zohoStatus(kind, d)} />,
      search: `${d.number} ${d.customerName} ${d.reference ?? ''}`.toLowerCase(),
      raw: d,
    })),
    views: VIEWS[kind].map((v) => ({ value: v.value, title: v.value === 'all' ? `All ${info.viewNoun}` : `${v.label} ${info.viewNoun}`, keep: (r: SplitRow) => v.keep(zohoStatus(kind, raw(r))) })),
    sorts: [
      { key: 'date', label: 'Date', value: (r: SplitRow) => raw(r).date },
      { key: 'number', label: 'Number', value: (r: SplitRow) => raw(r).number },
      { key: 'customer', label: 'Customer Name', value: (r: SplitRow) => r.title.toLowerCase() },
      { key: 'amount', label: 'Amount', value: (r: SplitRow) => r.amount ?? 0 },
    ],
  };
}

const CONFIG: Record<SplitKind, {
  label: string;
  base: string;
  newHref?: string;
  module: 'sales' | 'purchases' | 'projects';
  load: () => Promise<SplitRow[]>;
  Bulk?: BulkActions;
  views?: SplitView[];
  sorts?: SplitSort[];
  /** Zoho keeps the sidebar open beside this module's records (items, customers, vendors). */
  keepNav?: boolean;
  /** Zoho's contact rows: the name, then the amount with the status beside it. */
  amountBelow?: boolean;
  /** The X stays Zoho's red beside a transaction even where the sidebar stays open (quotes, orders, challans, credit notes). */
  redClose?: boolean;
}> = {
  invoice: {
    label: 'Invoices',
    base: '/sales/invoices',
    newHref: '/sales/invoices/new',
    module: 'sales',
    load: async () => (await invoices.list({ limit: 300 })).invoices.map((i) => ({
      id: i.id,
      title: i.customerName,
      amount: i.totalPaise,
      sub: `${i.number} • ${day(i.date)}`,
      status: <InvoiceStatus status={i.status} dueDate={i.dueDate} balancePaise={i.balancePaise} />,
      search: `${i.number} ${i.customerName}`.toLowerCase(),
    })),
  },
  bill: {
    label: 'Bills',
    base: '/purchases/bills',
    newHref: '/purchases/bills/new',
    module: 'purchases',
    load: async () => (await bills.list({ limit: 300 })).bills.map((b) => ({
      id: b.id,
      title: b.vendorName,
      amount: b.totalPaise,
      sub: `${b.vendorInvoiceNo || b.internalNo} • ${day(b.date)}`,
      status: <StatusBadge status={b.status} />,
      search: `${b.internalNo} ${b.vendorInvoiceNo} ${b.vendorName}`.toLowerCase(),
    })),
  },
  customer: {
    label: 'Customers',
    base: '/sales/customers',
    newHref: '/sales/customers/new',
    module: 'sales',
    keepNav: true,
    amountBelow: true,
    load: async () => (await contacts.list({ kind: 'customer', archived: true })).contacts.map((c) => ({
      id: c.id,
      title: c.displayName,
      amount: c.receivablePaise,
      sub: '',
      status: c.isArchived ? <StatusBadge status="inactive" /> : undefined,
      search: `${c.displayName} ${c.legalName ?? ''} ${c.gstin ?? ''} ${c.email ?? ''}`.toLowerCase(),
      raw: c,
    })),
    Bulk: ContactBulk,
    views: contactViews('Customers'),
    sorts: contactSorts('Customers'),
  },
  vendor: {
    label: 'Vendors',
    base: '/purchases/vendors',
    newHref: '/purchases/vendors/new',
    module: 'purchases',
    keepNav: true,
    amountBelow: true,
    load: async () => (await contacts.list({ kind: 'vendor', archived: true })).contacts.map((c) => ({
      id: c.id,
      title: c.displayName,
      amount: c.payablePaise,
      sub: '',
      status: c.isArchived ? <StatusBadge status="inactive" /> : undefined,
      search: `${c.displayName} ${c.legalName ?? ''} ${c.gstin ?? ''} ${c.email ?? ''}`.toLowerCase(),
      raw: c,
    })),
    Bulk: ContactBulk,
    views: contactViews('Vendors'),
    sorts: contactSorts('Vendors'),
  },
  // Zoho's item column: the name and its rate, the SKU under them. Inactive
  // items are in it too, as Zoho's "All Items" has them.
  item: {
    label: 'Items',
    base: '/sales/items',
    newHref: '/sales/items/new',
    module: 'sales',
    keepNav: true,
    load: async () => (await items.list({ archived: true })).items.map((i) => ({
      id: i.id,
      title: i.name,
      amount: i.salePricePaise,
      sub: i.sku ? `SKU: ${i.sku}` : '',
      status: i.isArchived ? <StatusBadge status="inactive" /> : undefined,
      search: `${i.name} ${i.sku ?? ''} ${i.hsnSac ?? ''}`.toLowerCase(),
      raw: i,
    })),
    Bulk: ItemBulk,
    views: [
      { value: 'all', title: 'All Items', keep: () => true },
      { value: 'active', title: 'Active Items', keep: (r) => !(r.raw as ItemRow).isArchived },
      { value: 'inactive', title: 'Inactive Items', keep: (r) => (r.raw as ItemRow).isArchived },
      { value: 'goods', title: 'Goods', keep: (r) => (r.raw as ItemRow).kind === 'goods' && !(r.raw as ItemRow).isArchived },
      { value: 'service', title: 'Services', keep: (r) => (r.raw as ItemRow).kind === 'service' && !(r.raw as ItemRow).isArchived },
    ],
    sorts: [
      { key: 'name', label: 'Name', value: (r) => r.title.toLowerCase() },
      { key: 'sku', label: 'SKU', value: (r) => ((r.raw as ItemRow).sku ?? '').toLowerCase() },
      { key: 'rate', label: 'Rate', value: (r) => r.amount ?? 0 },
    ],
  },
  // Zoho keeps the sidebar open beside a quote, sales order, challan or credit
  // note (recorded 2026-11-23), its column showing the customer, the amount,
  // the number and date, and the status as Zoho words it.
  estimate: salesDocSplit('estimate'),
  'sales-order': salesDocSplit('sales-order'),
  challan: salesDocSplit('challan'),
  'credit-note': salesDocSplit('credit-note'),
  // Zoho's payments column (recorded 2026-11-23): the customer and amount, the
  // payment number and date, the mode under them; the sidebar stays open.
  'payment-received': {
    label: 'Payments Received',
    base: '/sales/payments',
    newHref: '/sales/payments/new',
    module: 'sales',
    keepNav: true,
    load: async () => (await payments.list({ kind: 'received', limit: 300 })).payments.map((pm): SplitRow => ({
      id: pm.id,
      title: pm.contactName,
      amount: pm.amountPaise + pm.tdsPaise + pm.bankChargesPaise,
      sub: `${pm.number} • ${day(pm.date)}`,
      status: pm.status === 'void' ? <StatusBadge status="void" /> : <span className="text-[12px] uppercase text-muted-foreground">{pm.type === 'Customer Advance' ? 'Advance' : pm.mode}</span>,
      search: `${pm.number} ${pm.contactName} ${pm.reference ?? ''}`.toLowerCase(),
      raw: pm,
    })),
    sorts: [
      { key: 'date', label: 'Date', value: (r: SplitRow) => (r.raw as { date: string }).date },
      { key: 'number', label: 'Payment #', value: (r: SplitRow) => (r.raw as { number: string }).number },
      { key: 'amount', label: 'Amount', value: (r: SplitRow) => r.amount ?? 0 },
    ],
  },
  // Service (retainer) invoices, Zoho's column: customer and amount, number and date, status.
  retainer: {
    label: 'Service Invoices',
    base: '/sales/retainers',
    newHref: '/sales/retainers/new',
    module: 'sales',
    keepNav: true,
    load: async () => (await salesDocuments.list('retainer', { limit: 300 })).documents.map((d): SplitRow => ({
      id: d.id,
      title: d.customerName,
      amount: d.totalPaise,
      sub: `${d.number} • ${day(d.date)}`,
      status: <StatusBadge status={d.status} />,
      search: `${d.number} ${d.customerName} ${d.reference ?? ''}`.toLowerCase(),
      raw: d,
    })),
  },
  // Zoho's recurring column: the customer and amount, the profile name and its
  // terms, the status and the next invoice date.
  'recurring-invoice': {
    label: 'Recurring Invoices',
    base: '/sales/recurring',
    newHref: '/sales/recurring/new',
    module: 'sales',
    keepNav: true,
    load: async () => (await recurringInvoices.list()).profiles.map((r): SplitRow => ({
      id: r.id,
      title: r.customerName,
      amount: r.totalPaise,
      sub: `${r.name} • ${r.repeatLabel ?? r.frequency}`,
      status: <span className="flex items-center gap-2"><StatusBadge status={r.status ?? (r.isActive ? 'active' : 'stopped')} />{r.status === 'active' && <span className="text-[12px] text-muted-foreground">Next Invoice on {day(r.nextRun)}</span>}</span>,
      search: `${r.name} ${r.customerName}`.toLowerCase(),
      raw: r,
    })),
  },
  project: {
    label: 'Projects',
    base: '/projects',
    module: 'projects',
    load: async () => (await projects.list({ status: 'all' })).projects.map((p) => ({
      id: p.id,
      title: p.name,
      sub: p.customerName,
      status: <StatusBadge status={p.status} />,
      search: `${p.name} ${p.code ?? ''} ${p.customerName}`.toLowerCase(),
    })),
  },
};

const REFRESH = 'rekonza:split-refresh';
const RECORD = 'rekonza:split-record';

/** Reload the column on the left, after the open record changed in a way it shows (marked inactive, say). */
export function refreshSplitList() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(REFRESH));
}

/** The open record reloads when a bulk action in the column has changed it. */
export function useSplitRecordRefresh(reload: () => void) {
  const ref = useRef(reload);
  ref.current = reload;
  useEffect(() => {
    const on = () => ref.current();
    window.addEventListener(RECORD, on);
    return () => window.removeEventListener(RECORD, on);
  }, []);
}

/** The record id when the address is a record itself (not the list, the form or a sub-page). */
function recordIdFrom(pathname: string, base: string): string | null {
  if (!pathname.startsWith(base + '/')) return null;
  const rest = pathname.slice(base.length + 1).split('/');
  // The list's own pages beneath it (the form, the timesheet, statements printed in bulk) are not records.
  if (rest.length !== 1 || !rest[0] || ['new', 'timesheet', 'statements', 'online'].includes(rest[0])) return null;
  return decodeURIComponent(rest[0]);
}

export function RecordSplit({ kind, children }: { kind: SplitKind; children: ReactNode }) {
  const cfg = CONFIG[kind];
  const pathname = usePathname();
  const id = recordIdFrom(pathname, cfg.base);
  const split = id !== null;
  useForceNavCollapsed(split && !cfg.keepNav);
  if (!split) return <>{children}</>;
  return <SplitFrame kind={kind} id={id}>{children}</SplitFrame>;
}

function SplitFrame({ kind, id, children }: { kind: SplitKind; id: string; children: ReactNode }) {
  const cfg = CONFIG[kind];
  const router = useRouter();
  const canCreate = usePermission(cfg.module, 'create');
  const [rows, setRows] = useState<SplitRow[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState('');
  const owner = useRef(Symbol('split')).current;
  const listRef = useRef<HTMLDivElement>(null);

  // Loaded once for as long as a record of this kind is open; moving between
  // records keeps the column as it is, scroll position included.
  useEffect(() => {
    let live = true;
    const load = () => cfg.load().then((r) => { if (live) setRows(r); }).catch(() => { if (live) setFailed(true); });
    void load();
    window.addEventListener(REFRESH, load);
    return () => { live = false; window.removeEventListener(REFRESH, load); };
  }, [cfg]);

  // The top bar's box filters this column ("Search in Invoices").
  useEffect(() => { claimListSearch(owner, query, setQuery, cfg.label); }, [owner, query, cfg.label]);
  useEffect(() => () => releaseListSearch(owner), [owner]);

  // Bring the open record into view in the column the first time it loads.
  useEffect(() => {
    if (!rows) return;
    listRef.current?.querySelector('[data-active="1"]')?.scrollIntoView({ block: 'nearest' });
  }, [rows]);

  // The column's own view and order (Zoho's "All Items ▾" and its ⋯ → Sort by).
  // The column opens on the view the list was showing (Zoho's "Active Items ▾"), and a change is kept for the list.
  const [view, setViewState] = useState(cfg.views?.[0]?.value ?? 'all');
  const viewKey = `rekonza.view.${cfg.label.toLowerCase()}`;
  useEffect(() => {
    try {
      const kept = sessionStorage.getItem(viewKey);
      if (kept && cfg.views?.some((v) => v.value === kept)) setViewState(kept);
    } catch { /* the first view stands */ }
  }, [viewKey, cfg.views]);
  const setView = (v: string) => {
    setViewState(v);
    try { sessionStorage.setItem(viewKey, v); } catch { /* this page only */ }
  };
  const [sortBy, setSortBy] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(null);
  const currentView = cfg.views?.find((v) => v.value === view);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const kept = (rows ?? []).filter((r) => (!q || r.search.includes(q)) && (!currentView || currentView.keep(r)));
    const s = sortBy && cfg.sorts?.find((x) => x.key === sortBy.key);
    if (!s || !sortBy) return kept;
    return [...kept].sort((a, b) => {
      const va = s.value(a);
      const vb = s.value(b);
      const cmp = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb));
      return sortBy.dir === 'asc' ? cmp : -cmp;
    });
  }, [rows, query, currentView, sortBy, cfg.sorts]);
  const Bulk = cfg.Bulk;
  const pickedRows = (rows ?? []).filter((r) => picked.has(r.id));
  const allShown = shown.length > 0 && shown.every((r) => picked.has(r.id));
  const toggle = (rid: string) => setPicked((p) => { const n = new Set(p); if (n.has(rid)) n.delete(rid); else n.add(rid); return n; });
  /** After a bulk action: clear the ticks, reload the column and the open record, or leave it if it went. */
  const bulkDone = (left?: boolean) => {
    setPicked(new Set());
    refreshSplitList();
    if (left) router.push(cfg.base);
    else window.dispatchEvent(new Event(RECORD));
  };

  return (
    <div data-slot="record-split" className="-mx-6 -mt-5 flex h-[calc(100vh-3rem)] min-h-0 print:m-0 print:block print:h-auto">
      <aside data-slot="split-list" className="hidden w-[360px] shrink-0 flex-col border-r md:flex no-print">
        <div className="flex h-[65px] shrink-0 items-center gap-2 border-b px-4">
          {Bulk && pickedRows.length > 0 ? (
            <div className="flex min-w-0 flex-1 items-center gap-2.5" data-slot="split-selected">
              <input type="checkbox" className="size-3.5 accent-primary" checked={allShown} aria-label="Tick every row shown"
                onChange={() => setPicked(allShown ? new Set() : new Set(shown.map((r) => r.id)))} />
              <span className="text-[13px] font-medium">{pickedRows.length} Selected</span>
              <Bulk picked={pickedRows} openId={id} done={bulkDone} />
              <button type="button" onClick={() => setPicked(new Set())} aria-label="Clear the ticks" className="ml-auto grid size-7 place-items-center rounded text-muted-foreground hover:bg-muted">
                <X className="size-4" />
              </button>
            </div>
          ) : (
          <>
          {cfg.views ? (
            <DropdownMenu>
              <DropdownMenuTrigger data-slot="split-views" className="flex min-w-0 items-center gap-1.5 text-[16px] font-semibold outline-none">
                <span className="truncate">{currentView?.title ?? `All ${cfg.label}`}</span>
                <ChevronDown className="size-4 shrink-0 text-primary" strokeWidth={2.5} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="min-w-52">
                {cfg.views.map((v) => (
                  <DropdownMenuItem key={v.value} data-slot="split-view" data-value={v.value} onClick={() => setView(v.value)} className={cn(v.value === view && 'font-medium')}>
                    {v.title}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <Link href={cfg.base} className="flex min-w-0 items-center gap-1.5 text-[16px] font-semibold">
              <span className="truncate">All {cfg.label}</span>
              <ChevronDown className="size-4 shrink-0 text-primary" strokeWidth={2.5} />
            </Link>
          )}
          {cfg.newHref && canCreate && (
            <Link
              href={cfg.newHref}
              aria-label={`New ${cfg.label.replace(/s$/, '').toLowerCase()}`}
              className="ml-auto grid size-8 place-items-center rounded-[var(--radius-button)] bg-primary text-primary-foreground hover:brightness-95"
            >
              <Plus className="size-4" strokeWidth={2.2} />
            </Link>
          )}
          {cfg.sorts && (
            <DropdownMenu>
              <DropdownMenuTrigger aria-label="More" data-slot="split-more"
                className={cn('grid size-8 shrink-0 place-items-center rounded-[var(--radius-button)] border border-secondary-border bg-secondary hover:brightness-[0.98]', !(cfg.newHref && canCreate) && 'ml-auto')}>
                <MoreHorizontal className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-44">
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>Sort by</DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="min-w-40">
                    {cfg.sorts.map((s) => (
                      <DropdownMenuItem key={s.key} data-slot="split-sort" data-value={s.key} className="justify-between"
                        onClick={() => setSortBy((c) => ({ key: s.key, dir: c?.key === s.key && c.dir === 'asc' ? 'desc' : 'asc' }))}>
                        {s.label}
                        {sortBy?.key === s.key && (sortBy.dir === 'asc' ? <ArrowUp className="size-3.5 text-primary" /> : <ArrowDown className="size-3.5 text-primary" />)}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuItem onClick={() => refreshSplitList()}>Refresh List</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          </>
          )}
        </div>
        <div ref={listRef} className="thin-scroll min-h-0 flex-1 overflow-y-auto">
          {failed ? (
            <p className="px-4 py-6 text-[13px] text-muted-foreground">The list could not be loaded.</p>
          ) : !rows ? (
            <div className="space-y-px">
              {Array.from({ length: 8 }).map((_, i) => <div key={i} className="h-[84px] animate-pulse border-b bg-muted/60" />)}
            </div>
          ) : shown.length === 0 ? (
            <p className="px-4 py-6 text-[13px] text-muted-foreground">{query ? 'Nothing matches the search.' : 'Nothing here yet.'}</p>
          ) : (
            shown.map((r) => {
              const active = r.id === id;
              const body = cfg.amountBelow ? (
                <>
                  <span className="block min-w-0 truncate text-[14px] font-medium">{r.title}</span>
                  <div className="mt-1 flex items-center justify-between gap-3">
                    {r.amount != null && <Money value={r.amount} className="text-[13px] text-[#4c526c] dark:text-muted-foreground" />}
                    {r.status && <span className="shrink-0">{r.status}</span>}
                  </div>
                </>
              ) : (
                <>
                  <div className="flex items-start justify-between gap-3">
                    <span className="min-w-0 truncate text-[14px] font-medium">{r.title}</span>
                    {r.amount != null && <Money value={r.amount} className="shrink-0 text-[14px]" />}
                  </div>
                  {r.sub && <div className="mt-0.5 truncate text-[13px] text-[#4c526c] dark:text-muted-foreground">{r.sub}</div>}
                  {r.status && <div className="mt-1">{r.status}</div>}
                </>
              );
              // With bulk actions, Zoho's tick sits before the row's link.
              return Bulk ? (
                <div
                  key={r.id}
                  data-slot="split-row"
                  data-active={active ? '1' : undefined}
                  className={cn('flex items-start gap-3 border-b pl-4 transition-colors hover:bg-row-hover', (active || picked.has(r.id)) && 'bg-row-hover')}
                >
                  <input type="checkbox" className="mt-[15px] size-3.5 shrink-0 accent-primary" checked={picked.has(r.id)} onChange={() => toggle(r.id)}
                    aria-label={`Tick ${r.title}`} data-slot="split-tick" />
                  <Link href={`${cfg.base}/${r.id}`} className="block min-w-0 flex-1 py-3 pr-4">{body}</Link>
                </div>
              ) : (
                <Link
                  key={r.id}
                  href={`${cfg.base}/${r.id}`}
                  data-slot="split-row"
                  data-active={active ? '1' : undefined}
                  className={cn('block border-b px-4 py-3 transition-colors hover:bg-row-hover', active && 'bg-row-hover')}
                >
                  {body}
                </Link>
              );
            })
          )}
        </div>
      </aside>
      <section data-slot="split-record" className="thin-scroll relative min-w-0 flex-1 overflow-y-auto print:overflow-visible">
        <Link
          href={cfg.base}
          aria-label={`Close and go back to ${cfg.label}`}
          title="Close"
          // Zoho's X is red beside a transaction (an invoice, a bill) and dark grey beside an item, customer or vendor.
          className={cn('absolute right-4 top-4 z-20 grid size-8 place-items-center rounded hover:bg-muted no-print', cfg.keepNav && !cfg.redClose ? 'text-[#5f6380]' : 'text-[#d6141d]')}
          data-slot="split-close"
        >
          <X className="size-5" strokeWidth={1.8} />
        </Link>
        <div className="split-page space-y-5 px-6 pb-6 pt-5 print:p-0">{children}</div>
      </section>
    </div>
  );
}
