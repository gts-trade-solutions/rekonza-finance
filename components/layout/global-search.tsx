'use client';

// Global search — Zoho's "/" shortcut. Searches every entity type at once and
// groups the hits, so you can jump to a customer, an invoice or a bill without
// first navigating to the right module.
//
// Two sources, deliberately. Customers, vendors and items are already in the
// store — a few hundred rows, loaded once — so those match instantly as you
// type, with no round trip. Documents are not and never will be: there can be
// tens of thousands of them, so they are searched on the server, debounced,
// and the results merge into the same list.
//
// Which means the list can grow a moment after the local hits appear. The
// highlighted row is therefore tracked by identity rather than by index, or an
// arriving response would move the selection out from under the Enter key.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Building2, FileText, Package, Receipt, Search, Users, Wallet, type LucideIcon,
} from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { useAppStore } from '@/lib/store';
import { search as searchApi, type SearchResponse } from '@/lib/api/client';
import { formatINR } from '@/lib/money';
import { cn } from '@/lib/utils';

interface Hit {
  id: string;
  group: string;
  icon: LucideIcon;
  label: string;
  sublabel: string;
  meta?: string;
  href: string;
}

export function GlobalSearch({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  // Selected individually: returning an object from a Zustand selector builds a
  // new snapshot every render and loops useSyncExternalStore.
  const contacts = useAppStore((st) => st.contacts);
  const items = useAppStore((st) => st.items);

  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [docs, setDocs] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
      setDocs(null);
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);

  // ── Local: contacts and items, straight from the store ───────────────────
  const localHits = useMemo<Hit[]>(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 1) return [];
    const out: Hit[] = [];
    const match = (...parts: (string | null | undefined)[]) =>
      parts.some((p) => p?.toLowerCase().includes(q));

    for (const c of contacts) {
      if (c.isArchived || !match(c.displayName, c.gstin, c.email, c.phone)) continue;
      const isCustomer = c.kind === 'customer' || c.kind === 'both';
      out.push({
        id: `contact-${c.id}`,
        group: isCustomer ? 'Customers' : 'Vendors',
        icon: isCustomer ? Users : Building2,
        label: c.displayName,
        sublabel: c.gstin ?? c.email ?? c.gstTreatment.replace(/_/g, ' '),
        href: isCustomer ? `/sales/customers/${c.id}` : '/purchases/vendors',
      });
    }

    for (const it of items) {
      if (it.isArchived || !match(it.name, it.sku, it.hsnSac)) continue;
      out.push({
        id: `item-${it.id}`,
        group: 'Items',
        icon: Package,
        label: it.name,
        sublabel: [it.sku, it.hsnSac && `HSN ${it.hsnSac}`].filter(Boolean).join(' · '),
        meta: formatINR(it.salePricePaise),
        href: '/sales/items',
      });
    }

    return out.slice(0, 12);
  }, [query, contacts, items]);

  // ── Remote: documents ────────────────────────────────────────────────────
  //
  // 180ms is long enough that a fast typist makes one request instead of
  // twelve, and short enough that it still feels like it is keeping up.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setDocs(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(() => {
      searchApi
        .run(q)
        .then((r) => { if (!cancelled) setDocs(r); })
        .catch(() => { if (!cancelled) setDocs(null); })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      setLoading(false);
    };
  }, [query]);

  const remoteHits = useMemo<Hit[]>(() => {
    if (!docs) return [];
    const out: Hit[] = [];

    for (const i of docs.invoices) {
      out.push({
        id: `invoice-${i.id}`,
        group: 'Invoices',
        icon: Receipt,
        label: i.number,
        sublabel: i.party,
        meta: formatINR(i.totalPaise),
        href: `/sales/invoices/${i.id}`,
      });
    }
    for (const b of docs.bills) {
      out.push({
        id: `bill-${b.id}`,
        group: 'Bills',
        icon: FileText,
        label: b.vendorNumber ? `${b.number} · ${b.vendorNumber}` : b.number,
        sublabel: b.party,
        meta: formatINR(b.totalPaise),
        href: `/purchases/bills/${b.id}`,
      });
    }
    for (const p of docs.payments) {
      out.push({
        id: `payment-${p.id}`,
        group: 'Payments',
        icon: Wallet,
        label: p.number,
        sublabel: p.reference ? `${p.party} · ${p.reference}` : p.party,
        meta: formatINR(p.totalPaise),
        href: p.kind === 'received' ? '/sales/payments' : '/purchases/payments',
      });
    }
    for (const e of docs.expenses) {
      out.push({
        id: `expense-${e.id}`,
        group: 'Expenses',
        icon: Receipt,
        label: e.number,
        sublabel: e.notes ? `${e.party} · ${e.notes}` : e.party,
        meta: formatINR(e.totalPaise),
        href: '/purchases/expenses',
      });
    }

    return out;
  }, [docs]);

  const hits = useMemo(() => [...localHits, ...remoteHits], [localHits, remoteHits]);

  const grouped = useMemo(() => {
    const m = new Map<string, Hit[]>();
    for (const h of hits) m.set(h.group, [...(m.get(h.group) ?? []), h]);
    return [...m.entries()];
  }, [hits]);

  // Results arrive in two waves, so the highlight can end up past the end of
  // a list that just shrank. Pull it back rather than leaving Enter inert.
  useEffect(() => {
    if (active > 0 && active >= hits.length) setActive(0);
  }, [active, hits.length]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const go = (h: Hit) => {
    onOpenChange(false);
    router.push(h.href);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="top-[12%] max-w-xl translate-y-0 gap-0 overflow-hidden p-0"
      >
        <DialogTitle className="sr-only">Search</DialogTitle>

        <div className="flex items-center gap-2.5 border-b px-3.5">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActive(0); }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(i + 1, hits.length - 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
              else if (e.key === 'Enter' && hits[active]) { e.preventDefault(); go(hits[active]); }
            }}
            placeholder="Search customers, invoices, bills, items…"
            className="h-12 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <kbd className="hidden shrink-0 rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground sm:inline">
            Esc
          </kbd>
        </div>

        <div ref={listRef} className="thin-scroll max-h-[52vh] overflow-y-auto py-1.5">
          {loading && hits.length > 0 && (
            <p className="px-4 pb-1 pt-2 text-[10px] uppercase tracking-wide text-muted-foreground">
              Searching documents…
            </p>
          )}
          {!query.trim() ? (
            <p className="px-4 py-10 text-center text-xs text-muted-foreground">
              Start typing to search across every module.
            </p>
          ) : hits.length === 0 ? (
            <p className="px-4 py-10 text-center text-xs text-muted-foreground">
              {loading ? 'Searching…' : `Nothing matches “${query}”.`}
            </p>
          ) : (
            grouped.map(([group, items]) => (
              <div key={group}>
                <p className="px-4 pb-1 pt-2.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {group}
                </p>
                {items.map((h) => {
                  const idx = hits.indexOf(h);
                  const isActive = idx === active;
                  return (
                    <button
                      key={`${h.group}-${h.id}`}
                      type="button"
                      data-active={isActive}
                      onMouseEnter={() => setActive(idx)}
                      onClick={() => go(h)}
                      className={cn(
                        'flex w-full items-center gap-3 px-4 py-2 text-left',
                        isActive ? 'bg-primary text-primary-foreground' : 'hover:bg-accent',
                      )}
                    >
                      <h.icon className={cn('size-4 shrink-0', !isActive && 'text-muted-foreground')} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{h.label}</p>
                        <p className={cn('truncate text-xs', isActive ? 'text-primary-foreground/75' : 'text-muted-foreground')}>
                          {h.sublabel}
                        </p>
                      </div>
                      {h.meta && (
                        <span className={cn('shrink-0 text-xs tabular', isActive ? 'text-primary-foreground/85' : 'text-muted-foreground')}>
                          {h.meta}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
