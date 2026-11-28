'use client';

import { Suspense } from 'react';
import { AlertCircle } from 'lucide-react';
import { Sidebar } from '@/components/layout/sidebar';
import { Topbar } from '@/components/layout/topbar';
import { Skeleton } from '@/components/ui/skeleton';
import { TooltipProvider } from '@/components/ui/tooltip';
import { SessionGate } from '@/components/layout/session-provider';
import { MastersGate } from '@/components/layout/masters-gate';
import { CreditsProvider } from '@/components/ai/credits-provider';
import { AssistantLauncher } from '@/components/ai/assistant-launcher';
import { OutputGuard } from '@/components/layout/output-guard';
import { OfflineSync } from '@/components/layout/offline-sync';
import { ReasonPrompt } from '@/components/layout/reason-prompt';
import { ApprovalSentNotice } from '@/components/layout/approval-sent-notice';
import { useNavCollapsed } from '@/components/layout/nav-state';
import { SettingsTopbar, isSettingsMode } from '@/components/settings/all-settings';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

/**
 * Zoho Books' frame: the dark top bar across the whole window, the sidebar
 * under it (220px, or the 72px icon rail when folded), and the page on white.
 * Pages sit 24px in from the sidebar, as Zoho's do; a page's own list and its
 * header run edge to edge (globals.css, "Zoho list pages").
 */
function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  // Every page opens with the sidebar folded to the rail (nav-state.ts).
  const folded = useNavCollapsed();
  // Zoho's settings are a mode of their own: a white "All Settings" header in
  // place of the top bar, and no sidebar (components/settings/all-settings.tsx).
  const settings = isSettingsMode(pathname);
  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background print:block print:h-auto print:overflow-visible">
      {settings ? <SettingsTopbar /> : <Topbar />}
      <div className="flex min-h-0 flex-1 print:block">
        {!settings && (
          <aside className={cn('hidden shrink-0 transition-[width] duration-150 lg:block no-print', folded ? 'w-[72px]' : 'w-[220px]')}>
            <Suspense><Sidebar /></Suspense>
          </aside>
        )}
        <main className="thin-scroll min-w-0 flex-1 overflow-y-auto print:overflow-visible" data-slot="app-main">
          <div className="app-page space-y-5 px-6 pb-6 pt-5 print:max-w-none print:p-0">{children}</div>
        </main>
      </div>
    </div>
  );
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  // The server decides whether there is a session. A client-side check would
  // let anyone who edits localStorage into the shell.
  return (
    <SessionGate
      fallback={
        <div className="flex h-screen flex-col">
          <div className="h-12 shrink-0 bg-topbar" />
          <div className="flex flex-1">
            <div className="hidden w-[220px] shrink-0 border-r border-sidebar-border bg-sidebar lg:block" />
            <div className="flex-1 space-y-4 p-6">
              <Skeleton className="h-8 w-64" />
              <Skeleton className="h-28 w-full" />
              <Skeleton className="h-64 w-full" />
            </div>
          </div>
        </div>
      }
      onError={(message) => (
        <div className="grid min-h-screen place-items-center p-6">
          <div className="max-w-md text-center">
            <AlertCircle className="mx-auto mb-3 size-8 text-destructive" />
            <h1 className="text-lg font-semibold">Cannot reach the server</h1>
            <p className="mt-2 text-sm text-muted-foreground">{message}</p>
            <p className="mt-3 text-xs text-muted-foreground">
              Nothing was loaded, so nothing could have been changed.
            </p>
          </div>
        </div>
      )}
    >
      {() => (
        <MastersGate>
        <TooltipProvider>
        <CreditsProvider>
          {/* On paper the shell goes: no sidebar or top bar, and no fixed-height
              scroll box, which would print only the first screenful. */}
          <Shell>{children}</Shell>
          <AssistantLauncher />
          <OutputGuard />
          <OfflineSync />
          <ReasonPrompt />
          <ApprovalSentNotice />
        </CreditsProvider>
        </TooltipProvider>
        </MastersGate>
      )}
    </SessionGate>
  );
}
