'use client';

// A light paper band separated from the workspace by a hairline. Carries
// global search (focused with "/"), the organisation switcher, quick create and
// the account menu — all in ink, with no filled chrome.
//
// The demo controls that used to live here are gone. They reset a client-side
// mock store, which stopped being where the books lived the moment there was a
// database behind them: the button cleared the browser's copy and left the
// ledger untouched, so it did nothing except look like it had. The demo book is
// now a real organisation flagged is_demo, and it is rebuilt from the seed
// script rather than from a menu inside the app.

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import {
  LogOut, Menu, Moon, Plus,
  Search, Settings, Sun, UserCircle2,
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
import { useSession } from './session-provider';
import { Sidebar } from './sidebar';
import { QuickCreate } from './quick-create';
import { GlobalSearch } from './global-search';
import { CompanyMenu } from './company-menu';
import { CreditsChip } from '@/components/ai/credits-chip';

/** Icon button styled for the navy band. */
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
      onClick={onClick}
      className={cn(
        'grid size-9 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
        className,
      )}
    >
      {children}
    </button>
  );
}

function ThemeToggle() {
  const [dark, setDark] = useState(false);
  useEffect(() => setDark(document.documentElement.classList.contains('dark')), []);
  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle('dark', next);
    localStorage.setItem('rekonza-theme', next ? 'dark' : 'light');
  };
  return (
    <BandButton label="Toggle theme" onClick={toggle}>
      {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </BandButton>
  );
}

export function Topbar() {
  const router = useRouter();
  const serverSession = useSession();
  const { org, branches, activeBranchId, users, session } = useAppStore();
  const logout = useAppStore((s) => s.logout);
  const [quickOpen, setQuickOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const searchRef = useRef<HTMLButtonElement>(null);

  const user = users.find((u) => u.id === session?.userId);
  const branch = branches.find((b) => b.id === activeBranchId);
  const canCreate = hasPermission(session?.role, 'sales', 'create');

  // "/" focuses search, ⌘K / Ctrl-K opens quick create — both Zoho conventions.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement)?.tagName ?? '');
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setQuickOpen(true);
      } else if (e.key === '/' && !typing) {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <>
      <header className="sticky top-0 z-30 flex h-16 shrink-0 items-center gap-2 border-b bg-topbar px-4 sm:px-6 no-print">
        {/* Mobile nav */}
        <Sheet open={mobileNav} onOpenChange={setMobileNav}>
          <SheetTrigger
            aria-label="Open navigation"
            className="grid size-9 place-items-center rounded-md text-muted-foreground hover:bg-accent lg:hidden"
          >
            <Menu className="size-4" />
          </SheetTrigger>
          <SheetContent side="left" className="w-64 border-0 p-0">
            <SheetTitle className="sr-only">Navigation</SheetTitle>
            <Sidebar onNavigate={() => setMobileNav(false)} />
          </SheetContent>
        </Sheet>

        {/* Search */}
        <button
          ref={searchRef}
          type="button"
          onClick={() => setSearchOpen(true)}
          className="flex h-9 max-w-sm flex-1 items-center gap-2.5 rounded-md border bg-background px-3 text-left text-[13px] text-muted-foreground transition-colors hover:border-foreground/20"
        >
          <Search className="size-4 shrink-0 opacity-70" />
          <span className="min-w-0 flex-1 truncate">Search customers, invoices, bills…</span>
          <kbd className="hidden shrink-0 rounded border bg-muted px-1.5 font-sans text-[10px] sm:inline">
            /
          </kbd>
        </button>

        <div className="ml-auto flex items-center gap-1">
          {/*
            Only on the demo book. On a real organisation this space stays
            empty: a permanent "demo data" label over somebody's actual ledger
            teaches them to distrust what the screen says.
          */}
          {serverSession.org?.isDemo && (
            <span
              data-slot="demo-banner"
              className="mr-1 hidden rounded-full border border-warning/40 bg-warning/10 px-2.5 py-1 text-[11px] text-warning xl:inline"
            >
              Demo book · nothing here is filed with any portal
            </span>
          )}

          {/*
            Organisation switcher, as in Zoho. Branch is deliberately NOT here:
            a user works within their own branch, so it comes from their profile
            and is only editable on a document when they have access to more
            than one registration.
          */}
          <CompanyMenu org={org} branch={branch} />

          {/* The AI credit balance, one click from a top-up. */}
          <CreditsChip />

          {/* Quick create */}
          {canCreate && (
            <button
              type="button"
              onClick={() => setQuickOpen(true)}
              aria-label="Quick create"
              className="grid size-9 place-items-center rounded-md bg-primary text-primary-foreground transition-opacity hover:opacity-90"
            >
              <Plus className="size-4" />
            </button>
          )}

          <NotificationsBell />
          <ThemeToggle />
          <BandButton label="Settings" onClick={() => router.push('/settings')}>
            <Settings className="size-4" />
          </BandButton>

          {/* Account */}
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label="Account"
              className="ml-0.5 grid size-9 shrink-0 place-items-center rounded-full text-[11px] font-semibold text-white"
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
      </header>

      <QuickCreate open={quickOpen} onOpenChange={setQuickOpen} />
      <GlobalSearch open={searchOpen} onOpenChange={setSearchOpen} />
    </>
  );
}
