'use client';

// The three states a page can be in before it has data: still loading, failed,
// or loaded but empty. Shared so a migrated page reads the same as every other
// one — and so a failure always offers a way to retry rather than a dead end.

import type { ReactNode } from 'react';
import { AlertCircle, Loader2, RefreshCw } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

export function LoadingRows({ rows = 6 }: { rows?: number }) {
  return (
    <div className="space-y-3" data-slot="loading">
      <Skeleton className="h-9 w-full max-w-sm" />
      <Card className="overflow-hidden p-0">
        <div className="divide-y">
          {Array.from({ length: rows }, (_, i) => (
            <div key={i} className="flex items-center gap-4 p-4">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-4 flex-1" />
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-20" />
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

export function LoadFailed({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Card className="flex flex-col items-center gap-3 p-10 text-center" data-slot="load-error">
      <AlertCircle className="size-7 text-destructive" />
      <div>
        <p className="font-medium">This didn’t load</p>
        <p className="mt-1 max-w-md text-sm text-muted-foreground">{message}</p>
      </div>
      <Button variant="outline" size="sm" onClick={onRetry} className="gap-1.5">
        <RefreshCw className="size-3.5" /> Try again
      </Button>
    </Card>
  );
}

/** A quiet indicator for a refetch that happens with data already on screen. */
export function Refreshing({ active }: { active: boolean }) {
  if (!active) return null;
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground" data-slot="refreshing">
      <Loader2 className="size-3 animate-spin" /> Updating…
    </span>
  );
}

/**
 * Render whichever of the three states applies, or the children with the data.
 *
 * Takes the state object from `useApi` directly, so a page cannot accidentally
 * render its table against `null` while the first request is still in flight.
 */
export function AsyncPage<T>({
  state,
  children,
  loading,
}: {
  state: { data: T | null; loading: boolean; error: string | null; refetch: () => void };
  children: (data: T) => ReactNode;
  loading?: ReactNode;
}) {
  if (state.error) return <LoadFailed message={state.error} onRetry={state.refetch} />;
  if (state.loading || !state.data) return <>{loading ?? <LoadingRows />}</>;
  return <>{children(state.data)}</>;
}
