'use client';

// Zoho Books' split view. Opening a record from a list does not leave the
// list: it narrows to a column on the left (the name, the amount, the number
// and date, the status) with the open record lit, and the record fills the
// rest. The sidebar folds to its icon rail for as long as a record is open,
// and the X at the record's top right goes back to the full list.
//
// It is a layout at the module's level (app/(app)/sales/invoices/layout.tsx
// and the rest), so the list on the left stays loaded while you click from
// record to record. The list's own address, the new-record form and a record's
// sub-pages (print, statement, self-invoice) pass straight through.
//
// The record's header becomes Zoho's two bands: the title band, and under it
// the grey action bar with the buttons laid flat (globals.css, "split view").
// The top bar's search filters the column on the left, as Zoho's does.

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, Plus, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Money } from '@/components/shared/money';
import { StatusBadge } from '@/components/shared/status-badge';
import { InvoiceStatus } from '@/components/shared/invoice-status';
import { usePermission } from '@/lib/store/hooks';
import { bills, contacts, invoices, projects } from '@/lib/api/client';
import { useForceNavCollapsed } from '@/components/layout/nav-state';
import { claimListSearch, releaseListSearch } from '@/components/layout/page-context';

export type SplitKind = 'invoice' | 'bill' | 'customer' | 'vendor' | 'project';

interface SplitRow {
  id: string;
  title: string;
  amount?: number;
  sub: string;
  status?: ReactNode;
  search: string;
}

const day = (d: string) => new Date(`${d.slice(0, 10)}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

const CONFIG: Record<SplitKind, {
  label: string;
  base: string;
  newHref?: string;
  module: 'sales' | 'purchases' | 'projects';
  load: () => Promise<SplitRow[]>;
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
    load: async () => (await contacts.list({ kind: 'customer' })).contacts.map((c) => ({
      id: c.id,
      title: c.displayName,
      amount: c.receivablePaise,
      sub: c.legalName && c.legalName !== c.displayName ? c.legalName : c.email ?? c.gstin ?? '',
      search: `${c.displayName} ${c.legalName ?? ''} ${c.gstin ?? ''} ${c.email ?? ''}`.toLowerCase(),
    })),
  },
  vendor: {
    label: 'Vendors',
    base: '/purchases/vendors',
    module: 'purchases',
    load: async () => (await contacts.list({ kind: 'vendor' })).contacts.map((c) => ({
      id: c.id,
      title: c.displayName,
      amount: (c as { payablePaise?: number }).payablePaise ?? 0,
      sub: c.legalName && c.legalName !== c.displayName ? c.legalName : c.email ?? c.gstin ?? '',
      search: `${c.displayName} ${c.legalName ?? ''} ${c.gstin ?? ''} ${c.email ?? ''}`.toLowerCase(),
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

/** The record id when the address is a record itself (not the list, the form or a sub-page). */
function recordIdFrom(pathname: string, base: string): string | null {
  if (!pathname.startsWith(base + '/')) return null;
  const rest = pathname.slice(base.length + 1).split('/');
  if (rest.length !== 1 || !rest[0] || rest[0] === 'new' || rest[0] === 'timesheet') return null;
  return decodeURIComponent(rest[0]);
}

export function RecordSplit({ kind, children }: { kind: SplitKind; children: ReactNode }) {
  const cfg = CONFIG[kind];
  const pathname = usePathname();
  const id = recordIdFrom(pathname, cfg.base);
  const split = id !== null;
  useForceNavCollapsed(split);
  if (!split) return <>{children}</>;
  return <SplitFrame kind={kind} id={id}>{children}</SplitFrame>;
}

function SplitFrame({ kind, id, children }: { kind: SplitKind; id: string; children: ReactNode }) {
  const cfg = CONFIG[kind];
  const canCreate = usePermission(cfg.module, 'create');
  const [rows, setRows] = useState<SplitRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState('');
  const owner = useRef(Symbol('split')).current;
  const listRef = useRef<HTMLDivElement>(null);

  // Loaded once for as long as a record of this kind is open; moving between
  // records keeps the column as it is, scroll position included.
  useEffect(() => {
    let live = true;
    cfg.load().then((r) => { if (live) setRows(r); }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [cfg]);

  // The top bar's box filters this column ("Search in Invoices").
  useEffect(() => { claimListSearch(owner, query, setQuery, cfg.label); }, [owner, query, cfg.label]);
  useEffect(() => () => releaseListSearch(owner), [owner]);

  // Bring the open record into view in the column the first time it loads.
  useEffect(() => {
    if (!rows) return;
    listRef.current?.querySelector('[data-active="1"]')?.scrollIntoView({ block: 'nearest' });
  }, [rows]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (rows ?? []).filter((r) => !q || r.search.includes(q));
  }, [rows, query]);

  return (
    <div data-slot="record-split" className="-mx-6 -mt-5 flex h-[calc(100vh-3rem)] min-h-0 print:m-0 print:block print:h-auto">
      <aside data-slot="split-list" className="hidden w-[360px] shrink-0 flex-col border-r md:flex no-print">
        <div className="flex h-[65px] shrink-0 items-center gap-2 border-b px-4">
          <Link href={cfg.base} className="flex min-w-0 items-center gap-1.5 text-[16px] font-semibold">
            <span className="truncate">All {cfg.label}</span>
            <ChevronDown className="size-4 shrink-0 text-primary" strokeWidth={2.5} />
          </Link>
          {cfg.newHref && canCreate && (
            <Link
              href={cfg.newHref}
              aria-label={`New ${cfg.label.replace(/s$/, '').toLowerCase()}`}
              className="ml-auto grid size-8 place-items-center rounded-[var(--radius-button)] bg-primary text-primary-foreground hover:brightness-95"
            >
              <Plus className="size-4" strokeWidth={2.2} />
            </Link>
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
              return (
                <Link
                  key={r.id}
                  href={`${cfg.base}/${r.id}`}
                  data-slot="split-row"
                  data-active={active ? '1' : undefined}
                  className={cn('block border-b px-4 py-3 transition-colors hover:bg-row-hover', active && 'bg-row-hover')}
                >
                  <div className="flex items-start justify-between gap-3">
                    <span className="min-w-0 truncate text-[14px] font-medium">{r.title}</span>
                    {r.amount != null && <Money value={r.amount} className="shrink-0 text-[14px]" />}
                  </div>
                  {r.sub && <div className="mt-0.5 truncate text-[13px] text-[#4c526c] dark:text-muted-foreground">{r.sub}</div>}
                  {r.status && <div className="mt-1">{r.status}</div>}
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
          className="absolute right-4 top-4 z-20 grid size-8 place-items-center rounded text-[#d6141d] hover:bg-muted no-print"
        >
          <X className="size-5" strokeWidth={1.8} />
        </Link>
        <div className="split-page space-y-5 px-6 pb-6 pt-5 print:p-0">{children}</div>
      </section>
    </div>
  );
}
