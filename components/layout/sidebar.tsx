'use client';

// Navigation as an accounting app has it: a deep navy rail, each part of the
// books with an icon in its own colour so Sales, Purchases and GST are told
// apart at a glance, and the screen you are on filled in blue.

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ChevronRight, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/lib/store';
import { hasPermission } from '@/lib/store/hooks';
import { navCounts, type NavCounts } from '@/lib/api/client';
import { BRAND, LogoMark } from '@/components/brand/logo';
import { BOTTOM_LEVEL, NAV_GROUPS, TOP_LEVEL, type FeatureKey, type NavItem } from './nav-config';
import { api } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { useSession } from './session-provider';

/** Each part of the books in its own colour, keyed by its label. Light shades: they sit on navy. */
const TINT: Record<string, string> = {
  Dashboard: 'text-sky-400',
  Alerts: 'text-rose-400',
  Sales: 'text-emerald-400',
  Purchases: 'text-orange-400',
  'Time Tracking': 'text-cyan-400',
  Banking: 'text-teal-300',
  Accountant: 'text-indigo-300',
  Payroll: 'text-pink-400',
  'GST & Taxes': 'text-amber-400',
  Inventory: 'text-lime-400',
  Reports: 'text-blue-400',
  'Software Checklist': 'text-green-400',
  Tally: 'text-yellow-300',
  'Import & Export': 'text-emerald-300',
  Analytics: 'text-fuchsia-400',
  'AI Assistant': 'text-violet-400',
  Settings: 'text-slate-300',
  'Web Tabs': 'text-cyan-300',
  Help: 'text-sky-300',
};

/** Where the "+" on a nav row should go, when that module has a create form. */
const CREATE_HREF: Record<string, string> = {
  '/sales/customers': '/sales/customers/new',
  '/sales/invoices': '/sales/invoices/new',
  '/sales/payments': '/sales/payments/new',
  '/purchases/bills': '/purchases/bills/new',
  '/purchases/payments': '/purchases/payments/new',
};

/**
 * The rail's three badges, counted on the server.
 *
 * They were counted in the browser while the book lived in a Zustand store.
 * Now the book is in a database, so counting them here would mean downloading
 * every invoice and bank line to work out three integers — one small endpoint
 * returns the aggregates instead.
 *
 * A failed request yields zeros rather than an error: a missing badge is a
 * missing hint, and breaking the whole navigation over one would be a poor
 * trade.
 */
function useBadgeCounts(): NavCounts {
  const [counts, setCounts] = useState<NavCounts>({
    einvoicePending: 0,
    unmatched: 0,
    msmeRisk: 0,
    complianceDue: 0,
    exceptions: 0,
  });

  useEffect(() => {
    let cancelled = false;
    navCounts
      .load()
      .then((c) => { if (!cancelled) setCounts(c); })
      .catch(() => { /* leave the badges hidden */ });
    return () => { cancelled = true; };
  }, []);

  return counts;
}

function NavRow({ item, count, nested }: { item: NavItem; count?: number; nested?: boolean }) {
  const pathname = usePathname();
  const active = pathname === item.href || (!item.exact && pathname.startsWith(item.href + '/'));
  const createHref = CREATE_HREF[item.href];

  return (
    <div className="group/row relative">
      <Link
        href={item.href}
        data-active={active ? '1' : undefined}
        className={cn(
          'flex h-9 items-center gap-2.5 rounded-md pr-2 text-[13.5px] transition-colors',
          nested ? 'h-8 pl-10 text-[13px]' : 'pl-3',
          active
            ? 'bg-sidebar-primary font-medium text-sidebar-primary-foreground shadow-sm'
            : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
        )}
      >
        {!nested && <item.icon className={cn('size-[17px] shrink-0', active ? 'text-white' : TINT[item.label] ?? 'opacity-80')} />}
        <span className="min-w-0 flex-1 truncate">{item.label}</span>
        {count != null && count > 0 && (
          <span className="shrink-0 rounded-full bg-amber-400 px-1.5 py-px text-[10px] font-semibold tabular text-amber-950">
            {count}
          </span>
        )}
      </Link>
      {createHref && (
        <Link
          href={createHref}
          aria-label={`New ${item.label}`}
          onClick={(e) => e.stopPropagation()}
          className="absolute right-1.5 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded-full bg-white text-sidebar opacity-0 transition-opacity group-hover/row:opacity-100 focus-visible:opacity-100"
        >
          <Plus className="size-3" />
        </Link>
      )}
    </div>
  );
}

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const role = useAppStore((s) => s.session?.role);
  const org = useAppStore((s) => s.org);
  const counts = useBadgeCounts();

  const [open, setOpen] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const group = NAV_GROUPS.find((g) => g.items.some((i) => pathname.startsWith(i.href)));
    if (group) setOpen((o) => ({ ...o, [group.label]: true }));
  }, [pathname]);

  const policies = useApi(() => api.get<{ features: Partial<Record<FeatureKey, boolean>> }>('/api/settings/policies').catch(() => ({ features: {} as Partial<Record<FeatureKey, boolean>> })), [role]);
  // A part the book has switched off leaves the menu (Settings → Policies).
  // An item can need several parts switched on: e-way bills need GST too.
  const on = (feature?: FeatureKey | FeatureKey[]) =>
    !feature || [feature].flat().every((f) => (policies.data?.features as Record<string, boolean> | undefined)?.[f] !== false);
  // Help is for everyone, whatever their role.
  const visible = (module: string, feature?: FeatureKey | FeatureKey[]) => (module === 'help' || hasPermission(role, module, 'view')) && on(feature);
  // GST returns differ by registration: a composition book files CMP-08 and GSTR-4, not GSTR-1 and 3B.
  const registration = useSession().org?.gstRegistrationType;
  const forBook = (i: NavItem) => !i.registration || i.registration === registration;

  return (
    <div className="flex h-full flex-col border-r border-sidebar-border bg-sidebar" onClick={onNavigate}>
      {/* Wordmark. The glyph rather than the full lockup: the rail is narrow,
          and it inverts cleanly when the sidebar goes dark, which a navy
          wordmark on a navy ground would not. */}
      <Link href="/dashboard" className="flex h-16 shrink-0 items-center gap-2.5 border-b border-sidebar-border px-5">
        <LogoMark size={26} onDark />
        <span className="min-w-0">
          <span className="block text-[16px] font-semibold leading-none tracking-[-0.02em] text-white">
            {BRAND.display}
          </span>
          <span className="mt-1 block text-[10px] font-semibold uppercase tracking-[0.11em] text-sidebar-foreground/70">{org?.fiscalYearLabel ?? 'Books'}</span>
        </span>
      </Link>

      <nav className="thin-scroll flex-1 space-y-0.5 overflow-y-auto px-3 pb-4 pt-3">
        {TOP_LEVEL.filter((i) => visible(i.module, i.feature)).map((item) => (
          <NavRow key={item.href} item={item} count={item.badge ? counts[item.badge] : undefined} />
        ))}

        {NAV_GROUPS.filter((g) => visible(g.module, g.feature)).map((group) => {
          // A group with no children is a plain destination, not an accordion.
          if (group.href && group.items.length === 0) {
            return (
              <NavRow
                key={group.label}
                item={{ label: group.label, href: group.href, icon: group.icon, module: group.module }}
                count={group.badge ? counts[group.badge] : undefined}
              />
            );
          }
          const isOpen = open[group.label] ?? false;
          const groupActive = group.items.some((i) => pathname.startsWith(i.href));
          return (
            <div key={group.label}>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setOpen((o) => ({ ...o, [group.label]: !isOpen }));
                }}
                className={cn(
                  'flex h-9 w-full items-center gap-2.5 rounded-md px-3 text-[13.5px] transition-colors',
                  groupActive && !isOpen
                    ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
                    : isOpen
                      ? 'font-medium text-white hover:bg-sidebar-accent'
                      : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
                )}
              >
                <group.icon className={cn('size-[17px] shrink-0', TINT[group.label] ?? 'opacity-80')} />
                <span className="min-w-0 flex-1 truncate text-left">{group.label}</span>
                <ChevronRight
                  className={cn('size-3.5 shrink-0 opacity-50 transition-transform', isOpen && 'rotate-90')}
                />
              </button>
              {isOpen && (
                <div className="my-1 space-y-0.5 rounded-md bg-black/15 py-1">
                  {group.items.filter((i) => visible(i.module, i.feature) && forBook(i)).map((item) => (
                    <NavRow
                      key={item.href}
                      item={item}
                      nested
                      count={item.badge ? counts[item.badge] : undefined}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}

        <div className="!mt-4 space-y-0.5 border-t border-sidebar-border pt-4">
          {BOTTOM_LEVEL.filter((i) => visible(i.module, i.feature)).map((item) => (
            <NavRow key={item.href} item={item} />
          ))}
        </div>
      </nav>
    </div>
  );
}
