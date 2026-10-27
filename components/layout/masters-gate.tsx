'use client';

// Loads master data into the store before the shell renders its children.
//
// Forms read customers, items and accounts synchronously from the store, so
// they have to be there before a form mounts — a picker that renders empty and
// fills in a moment later loses whatever the user had already selected.

import { useMasters } from '@/lib/api/use-masters';
import { Skeleton } from '@/components/ui/skeleton';

export function MastersGate({ children }: { children: React.ReactNode }) {
  const { ready } = useMasters();

  if (!ready) {
    return (
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
    );
  }

  return <>{children}</>;
}
