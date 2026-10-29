'use client';

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

export default function AppLayout({ children }: { children: React.ReactNode }) {
  // The server decides whether there is a session. A client-side check would
  // let anyone who edits localStorage into the shell.
  return (
    <SessionGate
      fallback={
        <div className="flex h-screen">
          <div className="hidden w-64 shrink-0 border-r bg-sidebar lg:block" />
          <div className="flex-1">
            <div className="h-16 border-b bg-topbar" />
            <div className="space-y-4 p-6">
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
          <div className="flex h-screen overflow-hidden bg-background print:block print:h-auto print:overflow-visible">
            <aside className="hidden w-64 shrink-0 lg:block no-print">
              <Sidebar />
            </aside>
            <div className="flex min-w-0 flex-1 flex-col print:block">
              <Topbar />
              <main className="thin-scroll flex-1 overflow-y-auto print:overflow-visible">
                <div className="app-page mx-auto max-w-[1440px] space-y-7 p-5 sm:p-8 print:max-w-none print:p-0">{children}</div>
              </main>
            </div>
          </div>
          <AssistantLauncher />
          <OutputGuard />
          <OfflineSync />
          <ReasonPrompt />
        </CreditsProvider>
        </TooltipProvider>
        </MastersGate>
      )}
    </SessionGate>
  );
}
