'use client';

import { toast } from 'sonner';

/**
 * Show what a save flagged without refusing: a credit limit passed, stock
 * going below zero, cash over a statutory limit. Held on screen long enough to
 * be read, because each one is something the person should act on.
 */
export function toastWarnings(result: unknown) {
  const warnings = (result as { warnings?: unknown } | null)?.warnings;
  if (!Array.isArray(warnings)) return;
  for (const w of warnings) if (typeof w === 'string') toast.warning(w, { duration: 12_000 });
}
