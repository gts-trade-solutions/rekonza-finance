'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Data fetching for pages that have moved to the API.
//
// Every migrated page needs the same four states — loading, loaded, empty and
// failed — and the same ability to refetch after a write. Left to each page,
// that becomes forty slightly different implementations, and the differences
// are always in the error handling, which is the part nobody exercises.
//
// Deliberately small. There is no cache, no deduplication and no background
// revalidation, because an accounting screen showing a figure from thirty
// seconds ago is worse than one that takes another moment to load. When a page
// says the balance is ₹4,20,000, that has to be true now.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ApiError } from './client';

export interface ApiState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  /** True while refetching with data already on screen — for a subtle spinner. */
  refreshing: boolean;
  refetch: () => Promise<void>;
}

/**
 * Run `fetcher` on mount and whenever `deps` change.
 *
 * `fetcher` is intentionally not a dependency: an inline arrow function is a
 * new value on every render, so including it would refetch forever. The caller
 * lists what actually changed instead.
 */
export function useApi<T>(fetcher: () => Promise<T>, deps: unknown[] = []): ApiState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Held in a ref so `load` does not change identity every render.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  // Guards against a slow first request landing after a faster second one and
  // overwriting it — the classic out-of-order response bug behind a filter box.
  const generation = useRef(0);
  const hasData = useRef(false);

  const load = useCallback(async () => {
    const mine = ++generation.current;
    if (hasData.current) setRefreshing(true);
    else setLoading(true);
    setError(null);

    try {
      const result = await fetcherRef.current();
      if (mine !== generation.current) return; // a newer request has since started
      setData(result);
      hasData.current = true;
    } catch (err) {
      if (mine !== generation.current) return;
      if (err instanceof ApiError && err.isAuthFailure) {
        // The session went away — the shell's gate will handle the redirect,
        // and a page-level error message would flash first and confuse.
        window.location.href = '/login';
        return;
      }
      setError(err instanceof ApiError ? err.message : 'Something went wrong loading this page.');
    } finally {
      if (mine === generation.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, loading, error, refreshing, refetch: load };
}

/**
 * Run a write, with a busy flag and the server's field errors.
 *
 * Validation messages come back keyed by field, so a form can put each one
 * beside the input it belongs to rather than dumping a list at the top.
 */
export function useApiAction<Args extends unknown[], Result>(
  action: (...args: Args) => Promise<Result>,
): {
  run: (...args: Args) => Promise<Result | null>;
  busy: boolean;
  error: string | null;
  fieldErrors: Record<string, string>;
  reset: () => void;
  /** The last run was kept on this device to send later (offline): neither saved nor failed. */
  wasQueued: () => boolean;
} {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const actionRef = useRef(action);
  actionRef.current = action;
  const queued = useRef(false);

  const run = useCallback(async (...args: Args): Promise<Result | null> => {
    setBusy(true);
    setError(null);
    setFieldErrors({});
    queued.current = false;
    try {
      return await actionRef.current(...args);
    } catch (err) {
      if (err instanceof ApiError && err.isQueued) {
        queued.current = true;
        toast.success('Kept on this device', { description: 'It will be sent when you are back online.' });
        return null;
      }
      if (err instanceof ApiError) {
        setError(err.message);
        if (err.details) setFieldErrors(err.details);
      } else {
        setError('Something went wrong. Nothing was saved.');
      }
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  const reset = useCallback(() => {
    setError(null);
    setFieldErrors({});
  }, []);

  const wasQueued = useCallback(() => queued.current, []);

  return { run, busy, error, fieldErrors, reset, wasQueued };
}
