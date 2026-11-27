'use client';

// A return screen opened from Return Status (or a filing reminder) for one
// period: /gst/gstr1?period=2026-10, /gst/gstr9?fy=2025. Read after the page
// has mounted, not in the first render, so the server's HTML and the
// browser's first paint agree (no hydration mismatch); the screen then moves
// to the period asked for.

import { useEffect } from 'react';

export function useUrlPeriod(apply: (value: string) => void, key: 'period' | 'fy' = 'period', valid: RegExp = /^\d{4}-(\d{2}|Q[1-4])$/) {
  useEffect(() => {
    const v = new URLSearchParams(window.location.search).get(key);
    if (v && valid.test(v)) apply(v);
    // Once, on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/** The address of a return screen for one period. */
export function returnHref(href: string, period: string): string {
  if (/^\d{4}$/.test(period)) return `${href}?fy=${period}`;
  return `${href}?period=${period}`;
}
