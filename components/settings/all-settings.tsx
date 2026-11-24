'use client';

// Zoho Books' settings, measured from Zoho's own demo. Settings is a mode of
// its own: the sidebar and the dark top bar give way to a white header ("All
// Settings", the organisation, a search box and "Close Settings ×"), and the
// first screen is a grid of groups, each a white box with a tinted heading and
// its settings listed under it. Opening one keeps a left menu of every setting,
// grouped as on the grid, beside the page.
//
// Rekonza's settings are the tabs of /settings plus a few pages of their own
// (tax rates, HSN codes, print templates, email templates, billing). The groups
// below place each where Zoho has it; what Zoho has not got sits in the groups
// after Zoho's.

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Building2, ChevronDown, ChevronLeft, ChevronRight, CreditCard, Database, Package, Palette, Search, Settings2, ShieldCheck, Users, Wrench, X,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { usePermission } from '@/lib/store/hooks';
import { useAppStore } from '@/lib/store';
import { BRAND, LogoMark } from '@/components/brand/logo';
import { claimListSearch, releaseListSearch, useListSearch, usePublishPageTitle } from '@/components/layout/page-context';

export interface SettingLink {
  label: string;
  /** A tab of /settings, or a settings page of its own. */
  tab?: string;
  href?: string;
  /** Only for those who may change settings. */
  editOnly?: boolean;
  billing?: boolean;
}

export interface SettingGroup {
  title: string;
  icon: LucideIcon;
  tint: string;
  links: SettingLink[];
}

export const SETTING_SECTIONS: { title: string; groups: SettingGroup[] }[] = [
  {
    title: 'Organization Settings',
    groups: [
      {
        title: 'Organization', icon: Building2, tint: 'from-[#e3f6ed] text-[#13865a]',
        links: [
          { label: 'Profile', tab: 'org' },
          { label: 'Branches and GSTINs', tab: 'statutory' },
        ],
      },
      {
        title: 'Users & Roles', icon: Users, tint: 'from-[#fde8ea] text-[#d6141d]',
        links: [
          { label: 'Users', tab: 'users' },
          { label: 'Sign-ins', tab: 'sign-ins' },
        ],
      },
      {
        title: 'Taxes & Compliance', icon: ShieldCheck, tint: 'from-[#e5eefc] text-[#1c5bd9]',
        links: [
          { label: 'Taxes', href: '/settings/tax-rates' },
          { label: 'HSN and SAC codes', href: '/settings/hsn-codes' },
          { label: 'Statutory details', tab: 'statutory' },
        ],
      },
      {
        // Zoho's module settings: Items holds the HSN Code or SAC digits.
        title: 'Module Settings', icon: Package, tint: 'from-[#e8f3fb] text-[#1673b5]',
        links: [
          { label: 'Items', href: '/settings/items' },
          { label: 'Quotes', href: '/settings/preferences/quotes' },
          { label: 'Sales Orders', href: '/settings/preferences/sales-orders' },
          { label: 'Invoices', href: '/settings/preferences/invoices' },
          { label: 'Delivery Challans', href: '/settings/preferences/delivery-challans' },
          { label: 'Credit Notes', href: '/settings/preferences/credit-notes' },
        ],
      },
      {
        title: 'Setup & Configurations', icon: Settings2, tint: 'from-[#fdeedf] text-[#c46614]',
        links: [
          { label: 'General', tab: 'policies' },
          { label: 'Controls', tab: 'controls' },
          { label: 'Integrations', tab: 'integrations' },
          { label: 'Backups', tab: 'backups' },
        ],
      },
      {
        title: 'Customization', icon: Palette, tint: 'from-[#fdf3dd] text-[#9e6a03]',
        links: [
          { label: 'Transaction Number Series', tab: 'numbering' },
          { label: 'PDF Templates', href: '/settings/templates' },
          { label: 'Bank, UPI and Terms on PDFs', href: '/settings/invoice-print' },
          { label: 'Email Notifications', href: '/settings/email-templates' },
          { label: 'Reporting Tags', tab: 'tags' },
          { label: 'Custom Fields', tab: 'custom-fields' },
          { label: 'Workflow Rules', tab: 'workflows' },
        ],
      },
    ],
  },
  {
    title: 'More Settings',
    groups: [
      {
        title: 'Data', icon: Database, tint: 'from-[#ddf4f1] text-[#0e7c72]',
        links: [
          { label: 'Import data', href: '/settings/import' },
          { label: 'Export data', href: '/settings/export' },
          { label: 'Privacy', tab: 'privacy' },
        ],
      },
      {
        title: 'Developer & System', icon: Wrench, tint: 'from-[#e6e8fc] text-[#3f4bbd]',
        links: [
          { label: 'Developer', tab: 'developer', editOnly: true },
          { label: 'System health', tab: 'health', editOnly: true },
        ],
      },
      {
        title: 'Billing', icon: CreditCard, tint: 'from-[#efe7fb] text-[#713dbf]',
        links: [{ label: 'Plan and AI credits', href: '/settings/billing', billing: true }],
      },
    ],
  },
];

const hrefOf = (l: SettingLink) => l.href ?? `/settings?tab=${l.tab}`;

function useVisible() {
  const canEdit = usePermission('settings', 'edit');
  const canBilling = usePermission('billing', 'view');
  return (l: SettingLink) => (!l.editOnly || canEdit) && (!l.billing || canBilling);
}

/** The white header that stands in for the top bar while in settings. */
export function SettingsTopbar() {
  const router = useRouter();
  const org = useAppStore((s) => s.org);
  const search = useListSearch();
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement)?.tagName ?? '');
      if (e.key === '/' && !typing) { e.preventDefault(); inputRef.current?.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <header className="z-30 flex h-[75px] shrink-0 items-center gap-4 border-b bg-surface px-6 no-print" data-slot="settings-topbar">
      <Link href="/settings" className="flex min-w-0 items-center gap-3" aria-label="All Settings">
        <LogoMark size={30} />
        <span className="h-9 w-px bg-border" />
        <span className="min-w-0">
          <span className="block text-[18px] font-medium leading-tight">All Settings</span>
          <span className="block truncate text-[12px] text-muted-foreground">{org?.name ?? BRAND.short}</span>
        </span>
      </Link>
      <div className="mx-auto hidden w-full max-w-[350px] md:block">
        {search && (
          <label className="flex h-10 items-center gap-2 rounded-lg border border-ring px-3 shadow-[0_0_0_3px_rgba(64,141,251,0.12)]">
            <Search className="size-4 text-primary" />
            <input
              ref={inputRef}
              value={search.query}
              onChange={(e) => search.setQuery(e.target.value)}
              placeholder="Search settings ( / )"
              className="h-full min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-[#9ea3b8]"
              data-slot="settings-search"
            />
          </label>
        )}
      </div>
      <button
        type="button"
        onClick={() => router.push('/dashboard')}
        className="ml-auto flex h-8 items-center gap-1.5 rounded-[var(--radius-button)] bg-secondary px-3 text-[13px] text-secondary-foreground hover:brightness-95"
        data-slot="close-settings"
      >
        Close Settings <X className="size-4 text-[#d6141d]" strokeWidth={2} />
      </button>
    </header>
  );
}

/** The first screen: every setting, grouped as Zoho groups them. */
export function AllSettings() {
  usePublishPageTitle('All Settings');
  const visible = useVisible();
  const [query, setQuery] = useState('');
  const owner = useRef(Symbol('settings')).current;
  useEffect(() => { claimListSearch(owner, query, setQuery, 'settings'); }, [owner, query]);
  useEffect(() => () => releaseListSearch(owner), [owner]);

  const q = query.trim().toLowerCase();
  const sections = useMemo(() => SETTING_SECTIONS.map((s) => ({
    ...s,
    groups: s.groups
      .map((g) => ({ ...g, links: g.links.filter((l) => visible(l) && (!q || l.label.toLowerCase().includes(q) || g.title.toLowerCase().includes(q))) }))
      .filter((g) => g.links.length),
  })).filter((s) => s.groups.length), [q, visible]);

  return (
    <div className="-mx-6 -mb-6 -mt-5 min-h-[calc(100vh-75px)] space-y-8 bg-[#f7f7fe] px-6 py-8 dark:bg-background sm:px-12" data-slot="all-settings">
      {sections.length === 0 && <p className="text-center text-[13px] text-muted-foreground">No setting matches “{query}”.</p>}
      {sections.map((s) => (
        <section key={s.title} className="rounded-xl bg-surface px-5 pb-6 pt-7 shadow-[0_2px_10px_rgba(23,26,36,0.04)]">
          <h2 className="px-2 text-[18px] font-normal">{s.title}</h2>
          <div className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5">
            {s.groups.map((g) => (
              <div key={g.title} className="rounded-lg border bg-surface pb-3" data-slot="settings-group">
                <div className={cn('m-1 flex items-center gap-2 rounded-md bg-gradient-to-r to-transparent px-2.5 py-2.5', g.tint)}>
                  <g.icon className="size-4" strokeWidth={1.8} />
                  <h3 className="text-[15px] font-medium text-foreground">{g.title}</h3>
                </div>
                <ul className="mt-2 space-y-1 px-1">
                  {g.links.map((l) => (
                    <li key={l.label}>
                      <Link href={hrefOf(l)} className="block rounded-md px-2.5 py-2 text-[14px] hover:bg-row-hover hover:text-link" data-slot="settings-link">
                        {l.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

/** The left menu beside an open setting. */
export function SettingsNav({ tab, href }: { tab?: string; href?: string }) {
  const visible = useVisible();
  const [open, setOpen] = useState<string | null>(null);
  const current = SETTING_SECTIONS.flatMap((s) => s.groups).find((g) => g.links.some((l) => (tab && l.tab === tab) || (href && l.href === href)))?.title ?? null;
  useEffect(() => { setOpen(current); }, [current]);
  return (
    <nav className="thin-scroll sticky top-0 max-h-[calc(100vh-75px)] w-[240px] shrink-0 overflow-y-auto border-r bg-surface py-4" data-slot="settings-nav">
      <Link href="/settings" className="mx-3 mb-2 flex items-center gap-1 text-[13px] text-link hover:underline">
        <ChevronLeft className="size-3.5" /> All Settings
      </Link>
      {SETTING_SECTIONS.map((s) => (
        <div key={s.title} className="mt-3">
          <p className="px-4 pb-1 text-[11px] font-medium uppercase text-muted-foreground">{s.title}</p>
          {s.groups.map((g) => {
            const links = g.links.filter(visible);
            if (!links.length) return null;
            const isOpen = open === g.title;
            return (
              <div key={g.title} className="px-2">
                <button
                  type="button"
                  onClick={() => setOpen(isOpen ? null : g.title)}
                  className={cn('flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-[14px]', isOpen ? 'bg-sidebar-accent' : 'hover:bg-row-hover')}
                >
                  {isOpen ? <ChevronDown className="size-3.5 shrink-0" strokeWidth={2} /> : <ChevronRight className="size-3.5 shrink-0" strokeWidth={2} />}
                  <span className="flex-1 truncate">{g.title}</span>
                </button>
                {isOpen && (
                  <div className="my-1 space-y-1">
                    {links.map((l) => {
                      const active = (l.tab === tab && !!l.tab) || (!!href && l.href === href);
                      return (
                        <Link
                          key={l.label}
                          href={hrefOf(l)}
                          data-active={active ? '1' : undefined}
                          className={cn(
                            'flex h-9 items-center rounded-md pl-8 pr-2 text-[13px]',
                            active ? 'bg-primary font-medium text-primary-foreground' : 'hover:bg-row-hover',
                          )}
                        >
                          {l.label}
                        </Link>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

/** Settings pages that open in the settings mode (no sidebar, the white header). */
export function isSettingsMode(pathname: string): boolean {
  return pathname === '/settings'
    || ['/settings/tax-rates', '/settings/hsn-codes', '/settings/invoice-print', '/settings/templates', '/settings/email-templates', '/settings/billing']
      .some((p) => pathname === p || pathname.startsWith(p + '/'));
}

/** The page title for an open setting ("Organization Profile"). */
export function settingTitle(tab: string): string {
  const titles: Record<string, string> = {
    org: 'Organization Profile', statutory: 'Branches and Statutory Details', users: 'Users & Roles', numbering: 'Transaction Number Series',
    'custom-fields': 'Custom Fields', workflows: 'Workflow Rules', tags: 'Reporting Tags', integrations: 'Integrations',
    backups: 'Backups', policies: 'General Preferences', controls: 'Controls', health: 'System Health', 'sign-ins': 'Sign-ins',
    privacy: 'Privacy', developer: 'Developer',
  };
  return titles[tab] ?? 'Settings';
}
