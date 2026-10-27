'use client';

// Small store-adjacent hooks used across the UI.

import { useEffect, useState } from 'react';
import { useAppStore } from './index';
import { hasPermission, type Action } from '../rbac';

/** True once zustand-persist has rehydrated from localStorage (avoids SSR flicker). */
export function useHydrated(): boolean {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    // persist.onFinishHydration fires after rehydrate; if already done, flag now
    const unsub = useAppStore.persist.onFinishHydration(() => setHydrated(true));
    if (useAppStore.persist.hasHydrated()) setHydrated(true);
    return unsub;
  }, []);
  return hydrated;
}

// ── RBAC ─────────────────────────────────────────────────────────────────────
// Permission matrix for the demo. module keys are coarse ('sales', 'purchases',
// 'banking', 'accountant', 'gst', 'reports', 'settings', 'inventory').

export { hasPermission, type Action } from '../rbac';

export function usePermission(module: string, action: Action = 'view'): boolean {
  const role = useAppStore((s) => s.session?.role);
  return hasPermission(role, module, action);
}

/** Sales role must not see purchase prices / profit figures. */
export function useCanSeeCosts(): boolean {
  const role = useAppStore((s) => s.session?.role);
  return role === 'admin' || role === 'accountant' || role === 'viewer';
}
