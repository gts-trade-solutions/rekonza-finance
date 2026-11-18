'use client';

// Zoho Books' sidebar, measured from Zoho's own demo: a pale lavender column
// (#f7f7fe) 220px wide, 13px rows 30px tall with a 6px corner, the screen you
// are on filled in Zoho's blue (#408dfb) with a "+" to start a new one, the
// open group tinted (#eaeafb), and at the foot "Configure Features" and the
// button that folds the column down to an icon rail.
//
// Folded, it is Zoho's 72px rail: each part of the books as an icon with its
// name under it, and a group's screens in a menu beside it. It folds by itself
// while a record is open in the split view (nav-state.ts).
//
// Zoho's menu comes first, in Zoho's order. What Rekonza has that Zoho has not
// (GST returns, payroll, Tally and so on) follows below a rule.

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, ChevronsLeft, ChevronsRight, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/lib/store';
import { hasPermission } from '@/lib/store/hooks';
import { navCounts, type NavCounts } from '@/lib/api/client';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { BOTTOM_LEVEL, NAV_GROUPS, TOP_LEVEL, type FeatureKey, type NavGroup, type NavItem } from './nav-config';
import { api } from '@/lib/api/client';
import { useApi } from '@/lib/api/use-api';
import { useSession } from './session-provider';
import { setNavCollapsed, useNavChosenCollapsed, useNavCollapsed } from './nav-state';

/** Where the "+" on a nav row goes, when that screen has a create form. */
const CREATE_HREF: Record<string, string> = {
  '/sales/items': '/sales/items/new',
  '/sales/customers': '/sales/customers/new',
  '/sales/invoices': '/sales/invoices/new',
  '/sales/payments': '/sales/payments/new',
  '/sales/sales-receipts': '/sales/sales-receipts/new',
  '/sales/debit-notes': '/sales/debit-notes/new',
  '/purchases/bills': '/purchases/bills/new',
  '/purchases/payments': '/purchases/payments/new',
};

/**
 * The rail's badges, counted on the server.
 *
 * Counting them here would mean downloading every invoice and bank line to
 * work out a few integers — one small endpoint returns the aggregates instead.
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

/**
 * The one entry the current address belongs to. Several entries can share a
 * path and differ by query (Recurring Bills / Recurring Expenses, Import /
 * Import from PDF), so the best match is the entry whose path matches and
 * whose every query value is present; the most specific of those wins.
 */
function useActiveHref(items: NavItem[]): string | null {
  const pathname = usePathname();
  const params = useSearchParams();
  return useMemo(() => {
    let best: { href: string; score: number } | null = null;
    for (const item of items) {
      const [path, query] = item.href.split('?');
      const exactPath = pathname === path;
      const under = !item.exact && path !== '/' && pathname.startsWith(path + '/');
      if (!exactPath && !under) continue;
      const wanted = new URLSearchParams(query ?? '');
      let ok = true;
      for (const [k, v] of wanted) if (params.get(k) !== v) ok = false;
      if (!ok) continue;
      // A longer path, then more query values, then an exact path is the closer match.
      const score = path.length * 100 + [...wanted].length * 10 + (exactPath ? 1 : 0);
      if (!best || score > best.score) best = { href: item.href, score };
    }
    return best?.href ?? null;
  }, [items, pathname, params]);
}

function Count({ n, onBlue }: { n?: number; onBlue?: boolean }) {
  if (n == null || n <= 0) return null;
  return (
    <span className={cn(
      'shrink-0 rounded-full px-1.5 text-[10px] font-semibold leading-4 tabular',
      onBlue ? 'bg-white/90 text-[#1c5bd9]' : 'bg-overdue text-white',
    )}>
      {n}
    </span>
  );
}

/** A screen inside an open group, or a single top-level screen. */
function NavRow({ item, count, nested, active }: { item: NavItem; count?: number; nested?: boolean; active: boolean }) {
  const createHref = CREATE_HREF[item.href];
  return (
    <div className="group/row relative">
      <Link
        href={item.href}
        data-active={active ? '1' : undefined}
        className={cn(
          'mx-2.5 flex h-[30px] items-center rounded-md pr-2 text-[13px] transition-colors',
          nested ? 'pl-12' : 'gap-[10px] pl-[21px]',
          active
            ? 'bg-sidebar-primary text-sidebar-primary-foreground'
            : 'text-sidebar-foreground hover:bg-sidebar-accent',
          createHref && (active ? 'pr-8' : 'group-hover/row:pr-8'),
        )}
      >
        {!nested && <item.icon className="size-4 shrink-0" strokeWidth={1.6} />}
        <span className="min-w-0 flex-1 truncate">{item.label}</span>
        <Count n={count} onBlue={active} />
      </Link>
      {createHref && (
        <Link
          href={createHref}
          aria-label={`New ${item.label}`}
          onClick={(e) => e.stopPropagation()}
          className={cn(
            'absolute right-[18px] top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded transition-opacity focus-visible:opacity-100',
            active ? 'text-white opacity-100' : 'text-[#408dfb] opacity-0 group-hover/row:opacity-100',
          )}
        >
          <Plus className="size-4" strokeWidth={2} />
        </Link>
      )}
    </div>
  );
}

export function Sidebar({ onNavigate, forceExpanded = false }: { onNavigate?: () => void; forceExpanded?: boolean }) {
  const role = useAppStore((s) => s.session?.role);
  const counts = useBadgeCounts();
  const railFolded = useNavCollapsed();
  const chosenFolded = useNavChosenCollapsed();
  // The phone drawer is always the full menu.
  const folded = railFolded && !forceExpanded;

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

  const groupItems = (g: NavGroup) => g.items.filter((i) => visible(i.module, i.feature) && forBook(i));
  const groups = NAV_GROUPS.filter((g) => visible(g.module, g.feature) && (g.items.length === 0 || groupItems(g).length > 0));
  const top = TOP_LEVEL.filter((i) => visible(i.module, i.feature));
  const bottom = BOTTOM_LEVEL.filter((i) => i.sidebar !== false && visible(i.module, i.feature));

  const allItems = useMemo(
    () => [
      ...top,
      ...bottom,
      ...groups.flatMap((g) => (g.items.length ? groupItems(g) : [{ label: g.label, href: g.href!, icon: g.icon, module: g.module }])),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [role, policies.data, registration],
  );
  const activeHref = useActiveHref(allItems);
  const groupOf = (g: NavGroup) => groupItems(g).some((i) => i.href === activeHref);

  // Zoho keeps one group open: the one you are in, or the one you opened.
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  useEffect(() => {
    const g = groups.find((x) => x.items.length > 0 && groupOf(x));
    if (g) setOpenGroup(g.label);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeHref]);

  const zohoGroups = groups.filter((g) => !g.extra);
  const extraGroups = groups.filter((g) => g.extra);

  const renderGroup = (group: NavGroup) => {
    // A group with no children is a plain destination, as Banking is in Zoho.
    if (group.items.length === 0 && group.href) {
      const item: NavItem = { label: group.label, href: group.href, icon: group.icon, module: group.module };
      return (
        <div key={group.label} className={cn(group.label === 'Banking' && 'pt-2.5')}>
          {folded
            ? <RailLink item={item} active={activeHref === group.href} count={group.badge ? counts[group.badge] : undefined} />
            : <NavRow item={item} active={activeHref === group.href} count={group.badge ? counts[group.badge] : undefined} />}
        </div>
      );
    }
    const items = groupItems(group);
    const isOpen = openGroup === group.label;
    const inside = groupOf(group);

    if (folded) return <RailGroup key={group.label} group={group} items={items} activeHref={activeHref} inside={inside} counts={counts} onNavigate={onNavigate} />;

    return (
      <div key={group.label}>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setOpenGroup(isOpen ? null : group.label);
          }}
          aria-expanded={isOpen}
          className={cn(
            'relative mx-2.5 flex h-[30px] w-[calc(100%-1.25rem)] items-center gap-[10px] rounded-md pl-[21px] pr-2 text-[13px] text-sidebar-foreground transition-colors',
            isOpen ? 'bg-sidebar-accent' : 'hover:bg-sidebar-accent',
          )}
        >
          {isOpen
            ? <ChevronDown className="absolute left-[5px] size-3 opacity-70" strokeWidth={2} />
            : <ChevronRight className="absolute left-[5px] size-3 opacity-70" strokeWidth={2} />}
          <group.icon className="size-4 shrink-0" strokeWidth={1.6} />
          <span className="min-w-0 flex-1 truncate text-left">{group.label}</span>
          {!isOpen && <Count n={items.reduce((n, i) => n + (i.badge ? counts[i.badge] : 0), 0)} />}
        </button>
        {isOpen && (
          <div className="mt-1 space-y-1">
            {items.map((item) => (
              <NavRow key={item.href} item={item} nested active={activeHref === item.href} count={item.badge ? counts[item.badge] : undefined} />
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div
      className="flex h-full flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground"
      onClick={onNavigate}
      data-slot="sidebar"
      data-folded={folded ? '1' : undefined}
    >
      <nav className={cn('thin-scroll flex-1 overflow-y-auto overflow-x-hidden pb-4 pt-4', folded ? 'space-y-1 px-1.5' : 'space-y-1.5')}>
        {top.map((item) =>
          folded
            ? <RailLink key={item.href} item={item} active={activeHref === item.href} count={item.badge ? counts[item.badge] : undefined} />
            : <NavRow key={item.href} item={item} active={activeHref === item.href} count={item.badge ? counts[item.badge] : undefined} />,
        )}
        {zohoGroups.map(renderGroup)}

        {(extraGroups.length > 0 || bottom.length > 0) && (
          <div className={cn('border-t border-[#dfe0eb] pt-3', folded ? '!mt-3 mx-1 space-y-1' : '!mt-4 mx-2.5 space-y-1.5')} data-slot="sidebar-extras">
            <div className={cn(folded ? 'space-y-1' : '-mx-2.5 space-y-1.5')}>
              {extraGroups.map(renderGroup)}
              {bottom.map((item) =>
                folded
                  ? <RailLink key={item.href} item={item} active={activeHref === item.href} count={item.badge ? counts[item.badge] : undefined} />
                  : <NavRow key={item.href} item={item} active={activeHref === item.href} count={item.badge ? counts[item.badge] : undefined} />,
              )}
            </div>
          </div>
        )}
      </nav>

      {/* Zoho's foot: Configure Features (here, Settings → Policies, where parts
          of the books are switched on and off) and the fold button. */}
      {!forceExpanded && (
        <div className={cn('shrink-0 pb-2.5 pt-2', folded ? 'px-1.5' : 'px-2.5')}>
          {!folded && hasPermission(role, 'settings', 'view') && (
            <Link
              href="/settings?tab=policies"
              className="mb-1 flex h-[34px] items-center gap-1 rounded-md bg-sidebar-accent px-[23px] text-[13px] text-[#181c2e] hover:brightness-[0.98] dark:text-sidebar-foreground"
            >
              Configure Features <ChevronRight className="size-3.5" />
            </Link>
          )}
          <div className={cn('flex', folded ? 'justify-center' : 'justify-end')}>
            <button
              type="button"
              aria-label={chosenFolded ? 'Expand the menu' : 'Collapse the menu'}
              title={chosenFolded ? 'Expand' : 'Collapse'}
              onClick={(e) => { e.stopPropagation(); setNavCollapsed(!chosenFolded); }}
              className="grid h-8 w-10 place-items-center rounded-md text-sidebar-foreground/80 hover:bg-sidebar-accent"
            >
              {folded ? <ChevronsRight className="size-4" /> : <ChevronsLeft className="size-4" />}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** A rail name as Zoho sets it: two words on two lines, one long word cut with an ellipsis ("Purchas…"). */
function RailLabel({ text }: { text: string }) {
  return text.includes(' ')
    ? <span className="line-clamp-2 w-full">{text}</span>
    : <span className="block w-full truncate">{text}</span>;
}

/** Folded rail: one icon with its name under it. */
function RailLink({ item, active, count }: { item: NavItem; active: boolean; count?: number }) {
  return (
    <Link
      href={item.href}
      title={item.label}
      data-active={active ? '1' : undefined}
      className={cn(
        'relative flex min-h-[54px] flex-col items-center justify-center gap-1 rounded-md px-1 py-1.5 text-center text-[10.5px] leading-tight transition-colors',
        active ? 'bg-sidebar-accent font-medium' : 'hover:bg-sidebar-accent',
      )}
    >
      <item.icon className="size-[18px]" strokeWidth={1.6} />
      <RailLabel text={item.label} />
      {count != null && count > 0 && <span className="absolute right-1 top-1 size-1.5 rounded-full bg-overdue" />}
    </Link>
  );
}

/** Folded rail group: its screens open in a menu beside the rail, as in Zoho. */
function RailGroup({ group, items, activeHref, inside, counts, onNavigate }: {
  group: NavGroup;
  items: NavItem[];
  activeHref: string | null;
  inside: boolean;
  counts: NavCounts;
  onNavigate?: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        openOnHover
        delay={80}
        className={cn(
          'relative flex min-h-[54px] w-full flex-col items-center justify-center gap-1 rounded-md px-1 py-1.5 text-center text-[10.5px] leading-tight transition-colors',
          inside || open ? 'bg-sidebar-accent font-medium' : 'hover:bg-sidebar-accent',
        )}
      >
        <group.icon className="size-[18px]" strokeWidth={1.6} />
        <RailLabel text={group.label} />
        {/* Zoho's corner mark: this one opens a menu. */}
        <span className="absolute bottom-1 right-1 size-0 border-b-[5px] border-l-[5px] border-b-sidebar-foreground/40 border-l-transparent" />
      </PopoverTrigger>
      <PopoverContent side="right" align="start" sideOffset={6} className="w-56 gap-0.5 p-1">
        <p className="px-2.5 pb-1 pt-1.5 text-[11px] font-semibold uppercase text-muted-foreground">{group.label}</p>
        {items.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            onClick={() => { setOpen(false); onNavigate?.(); }}
            className={cn(
              'flex h-[34px] items-center justify-between rounded-md px-2.5 text-[13px]',
              activeHref === item.href ? 'bg-primary text-primary-foreground' : 'hover:bg-primary hover:text-primary-foreground',
            )}
          >
            <span className="truncate">{item.label}</span>
            <Count n={item.badge ? counts[item.badge] : undefined} onBlue={activeHref === item.href} />
          </Link>
        ))}
      </PopoverContent>
    </Popover>
  );
}
