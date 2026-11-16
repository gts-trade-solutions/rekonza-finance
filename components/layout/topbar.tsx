'use client';

// Zoho Books' top bar, measured from Zoho's own demo: a 48px dark navy band
// (#21263c) across the whole window. On the left, the product block sits over
// the sidebar (220px, or the 72px rail when folded) with a darker rule beside
// it; then the recent-pages clock and the search box (#333850, 8px corners,
// "Search in Invoices ( / )"). On the right, the organisation name, the blue
// quick-create "+", notifications, settings and the account picture.
//
// The search box searches the list on screen, as Zoho's does: the page's main
// list hands its filter to the box (page-context.ts). The magnifier at its left
// opens the search across the whole book; so does typing on a page that has
// no list.
//
// Rekonza's own name and mark stand where Zoho's are: the look is Zoho's, the
// brand is not.

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import {
  ChevronDown, History, LogOut, Menu, Moon, Plus,
  Search, Settings, Sun, UserCircle2, X,
} from 'lucide-react';
import { NotificationsBell } from './notifications-bell';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { useAppStore } from '@/lib/store';
import { auth } from '@/lib/api/client';
import { hasPermission } from '@/lib/store/hooks';
import { cn } from '@/lib/utils';
import { BRAND, LogoMark } from '@/components/brand/logo';
import { useSession } from './session-provider';
import { Sidebar } from './sidebar';
import { QuickCreate } from './quick-create';
import { GlobalSearch } from './global-search';
import { CompanyMenu } from './company-menu';
import { CreditsChip } from '@/components/ai/credits-chip';
import { useNavCollapsed } from './nav-state';
import { useListSearch, usePageTitle } from './page-context';

/** A 32px icon button on the dark band, as Zoho's. */
function BandButton({
  children,
  label,
  onClick,
  className,
}: {
  children: React.ReactNode;
  label: string;
  onClick?: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        'grid size-8 place-items-center rounded-lg text-topbar-foreground transition-colors hover:bg-white/10',
        className,
      )}
    >
      {children}
    </button>
  );
}

function useDarkMode(): [boolean, () => void] {
  const [dark, setDark] = useState(false);
  useEffect(() => setDark(document.documentElement.classList.contains('dark')), []);
  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle('dark', next);
    localStorage.setItem('rekonza-theme', next ? 'dark' : 'light');
  };
  return [dark, toggle];
}

// ── Recent pages: Zoho's clock at the start of the bar ──────────────────────
const RECENT_KEY = 'rekonza-recent-pages';
interface Recent { href: string; title: string; at: number }

function readRecent(): Recent[] {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as Recent[]; } catch { return []; }
}

/** Remembers each screen visited in this browser, newest first, ten at most. */
function useRememberRecent() {
  const pathname = usePathname();
  const title = usePageTitle();
  useEffect(() => {
    if (!title || pathname.startsWith('/print')) return;
    const href = pathname + window.location.search;
    const list = [{ href, title, at: Date.now() }, ...readRecent().filter((r) => r.href !== href)].slice(0, 10);
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch { /* full or private: the list is only a convenience */ }
  }, [pathname, title]);
}

function RecentPages() {
  const router = useRouter();
  const [items, setItems] = useState<Recent[]>([]);
  return (
    <DropdownMenu onOpenChange={(o) => { if (o) setItems(readRecent()); }}>
      <DropdownMenuTrigger
        aria-label="Recent pages"
        title="Recent pages"
        className="grid size-8 shrink-0 place-items-center rounded-lg text-topbar-foreground transition-colors hover:bg-white/10"
      >
        <History className="size-4" strokeWidth={1.8} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuLabel className="text-[11px] font-semibold uppercase text-muted-foreground">Recent pages</DropdownMenuLabel>
        {items.length === 0 ? (
          <p className="px-2.5 py-3 text-[13px] text-muted-foreground">The screens you open will be listed here.</p>
        ) : (
          items.map((r) => (
            <DropdownMenuItem key={r.href} onClick={() => router.push(r.href)} className="flex-col items-start gap-0">
              <span className="w-full truncate">{r.title}</span>
              <span className="w-full truncate text-[11px] opacity-70">{r.href}</span>
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function Topbar() {
  const router = useRouter();
  const serverSession = useSession();
  const { org, branches, activeBranchId, users, session } = useAppStore();
  const logout = useAppStore((s) => s.logout);
  const [quickOpen, setQuickOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [globalQuery, setGlobalQuery] = useState('');
  const [mobileNav, setMobileNav] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const folded = useNavCollapsed();
  const [dark, toggleDark] = useDarkMode();
  const title = usePageTitle();
  const listSearch = useListSearch();
  useRememberRecent();

  const user = users.find((u) => u.id === session?.userId);
  const branch = branches.find((b) => b.id === activeBranchId);
  const canCreate = hasPermission(session?.role, 'sales', 'create');

  const openGlobal = (q = '') => { setGlobalQuery(q); setSearchOpen(true); };

  // "/" goes to the search box, ⌘K / Ctrl-K opens quick create — both Zoho conventions.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement)?.tagName ?? '') || (e.target as HTMLElement)?.isContentEditable;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setQuickOpen(true);
      } else if (e.key === '/' && !typing) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const searchIn = listSearch?.label ?? title;
  const placeholder = listSearch && searchIn ? `Search in ${searchIn} ( / )` : 'Search customers, invoices, bills ( / )';

  return (
    <>
      <header className="z-30 flex h-12 shrink-0 items-center bg-topbar text-topbar-foreground no-print" data-slot="topbar">
        {/* Mobile nav */}
        <Sheet open={mobileNav} onOpenChange={setMobileNav}>
          <SheetTrigger
            aria-label="Open navigation"
            className="ml-2 grid size-8 place-items-center rounded-lg text-topbar-foreground hover:bg-white/10 lg:hidden"
          >
            <Menu className="size-4" />
          </SheetTrigger>
          <SheetContent side="left" className="w-[260px] border-0 p-0">
            <SheetTitle className="sr-only">Navigation</SheetTitle>
            <Suspense><Sidebar forceExpanded onNavigate={() => setMobileNav(false)} /></Suspense>
          </SheetContent>
        </Sheet>

        {/* The product block, over the sidebar. */}
        <Link
          href="/dashboard"
          aria-label={`${BRAND.name} home`}
          className={cn(
            'hidden h-full shrink-0 items-center gap-2.5 border-r border-topbar-divider lg:flex',
            folded ? 'w-[72px] justify-center' : 'w-[220px] px-4',
          )}
        >
          <LogoMark size={24} onDark />
          {!folded && <span className="truncate text-[18px] font-medium leading-none text-topbar-foreground">{BRAND.short}</span>}
        </Link>

        <div className="flex min-w-0 flex-1 items-center gap-2 px-2 sm:px-4">
          <RecentPages />

          {/* Search: on a phone, a button that opens the search across the book. */}
          <BandButton label="Search" onClick={() => openGlobal()} className="shrink-0 sm:hidden">
            <Search className="size-4" strokeWidth={1.8} />
          </BandButton>
          <div className="hidden h-9 w-full min-w-0 max-w-[300px] items-center rounded-lg border border-topbar-field-border bg-topbar-field sm:flex" data-slot="topbar-search">
            <button
              type="button"
              onClick={() => openGlobal(listSearch?.query ?? '')}
              aria-label="Search the whole book"
              title="Search the whole book"
              className="flex h-full w-[42px] shrink-0 items-center justify-center gap-0.5 rounded-l-lg border-r border-topbar-field-border/50 text-topbar-foreground hover:bg-white/5"
            >
              <Search className="size-4" strokeWidth={1.8} />
              <ChevronDown className="size-2.5 text-[#408dfb]" strokeWidth={3} />
            </button>
            <input
              ref={inputRef}
              value={listSearch ? listSearch.query : ''}
              onChange={(e) => {
                if (listSearch) listSearch.setQuery(e.target.value);
                else openGlobal(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') { listSearch?.setQuery(''); (e.target as HTMLInputElement).blur(); }
                if (e.key === 'Enter' && !listSearch) openGlobal((e.target as HTMLInputElement).value);
              }}
              placeholder={placeholder}
              aria-label={placeholder.replace(' ( / )', '')}
              className="h-full min-w-0 flex-1 bg-transparent px-2 text-[13px] text-topbar-foreground outline-none placeholder:text-[#9396a1]"
              data-slot="topbar-search-input"
            />
            {listSearch?.query && (
              <button type="button" aria-label="Clear search" onClick={() => listSearch.setQuery('')} className="mr-1.5 grid size-5 place-items-center rounded text-topbar-foreground/70 hover:text-topbar-foreground">
                <X className="size-3.5" />
              </button>
            )}
          </div>

          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            {/*
              Only on the demo book. On a real organisation this space stays
              empty: a permanent "demo data" label over somebody's actual ledger
              teaches them to distrust what the screen says.
            */}
            {serverSession.org?.isDemo && (
              <span
                data-slot="demo-banner"
                className={`mr-1 hidden text-[13px] text-topbar-foreground ${serverSession.demoSnapshot ? 'md:inline' : 'xl:inline'}`}
              >
                {/* The recorded online demo has nowhere to save, so it says so before anyone fills in a form. */}
                {serverSession.demoSnapshot ? 'Online demo · look around; saving is switched off' : 'Demo book · nothing here is filed with any portal'}
              </span>
            )}

            {/*
              Organisation switcher, as in Zoho. Branch is deliberately NOT here:
              a user works within their own branch, so it comes from their profile
              and is only editable on a document when they have access to more
              than one registration.
            */}
            <CompanyMenu org={org} branch={branch} />
            <span className="mx-1 hidden h-5 w-px bg-white/25 sm:block" />

            {/* The AI credit balance, one click from a top-up. Not on a phone,
                where the bar has no room: the balance is in the assistant's panel. */}
            <span className="hidden sm:flex">
              <CreditsChip />
            </span>

            {/* Quick create: Zoho's blue square. */}
            {canCreate && (
              <button
                type="button"
                onClick={() => setQuickOpen(true)}
                aria-label="Quick create"
                title="Quick create"
                className="mx-1 grid size-8 place-items-center rounded-[5px] bg-primary text-primary-foreground transition-[filter] hover:brightness-110"
              >
                <Plus className="size-[18px]" strokeWidth={2} />
              </button>
            )}

            <NotificationsBell />
            <BandButton label="Settings" onClick={() => router.push('/settings')}>
              <Settings className="size-4" strokeWidth={1.8} />
            </BandButton>

            {/* Account */}
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label="Account"
                className="ml-1 grid size-8 shrink-0 place-items-center rounded-full border border-white/40 text-[11px] font-semibold text-white"
                style={{ backgroundColor: user?.avatarColor ?? 'var(--primary)' }}
              >
                {user?.name.split(' ').map((n) => n[0]).join('') ?? '?'}
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel>
                  <p className="font-medium">{user?.name}</p>
                  <p className="text-xs font-normal text-muted-foreground">{user?.email}</p>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => router.push('/settings')}>
                  <UserCircle2 className="mr-2 size-4" /> Settings
                </DropdownMenuItem>
                <DropdownMenuItem onClick={toggleDark} data-slot="theme-toggle">
                  {dark ? <Sun className="mr-2 size-4" /> : <Moon className="mr-2 size-4" />} {dark ? 'Light mode' : 'Dark mode'}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={async () => {
                    // Revoke on the server first. Clearing the local store alone
                    // would leave a working session cookie behind.
                    try {
                      await auth.logout();
                    } catch {
                      // Already expired, or the network is down — either way the
                      // right move is still to drop the local session and leave.
                    }
                    logout();
                    window.location.href = '/login';
                  }}
                >
                  <LogOut className="mr-2 size-4" /> Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>

      <QuickCreate open={quickOpen} onOpenChange={setQuickOpen} />
      <GlobalSearch open={searchOpen} onOpenChange={setSearchOpen} initialQuery={globalQuery} />
    </>
  );
}
