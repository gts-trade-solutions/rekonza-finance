'use client';

// Sets the gate every print and download goes through (lib/output-guard.ts):
// the right to print or export on the page in view, a refusal when it is not
// there, and a line in the audit trail when a copy is taken. Printing with the
// browser's own shortcut is caught too: without the right, the page prints
// blank but for a notice.

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { toast } from 'sonner';
import { hasPermission } from '@/lib/rbac';
import { useAppStore } from '@/lib/store';
import { setOutputGuard, type OutputAction } from '@/lib/output-guard';
import { api } from '@/lib/api/client';
import { BOTTOM_LEVEL, NAV_GROUPS, TOP_LEVEL } from './nav-config';

const ITEMS = [...TOP_LEVEL, ...BOTTOM_LEVEL, ...NAV_GROUPS.flatMap((g) => g.items)];

/** The module a page belongs to: the menu item whose link is the longest start of its path. */
export function moduleForPath(path: string): string | null {
  let best: { len: number; module: string } | null = null;
  for (const i of ITEMS) {
    if ((path === i.href || path.startsWith(`${i.href}/`)) && (!best || i.href.length > best.len)) best = { len: i.href.length, module: i.module };
  }
  return best?.module ?? null;
}

export function OutputGuard() {
  const role = useAppStore((s) => s.session?.role);
  const path = usePathname();

  useEffect(() => {
    const may = (action: OutputAction) => {
      const part = moduleForPath(window.location.pathname);
      return !part || hasPermission(role, part, action);
    };
    setOutputGuard((action, what) => {
      if (!may(action)) {
        toast.error(action === 'print' ? 'Your role cannot print this' : 'Your role cannot export this', { description: 'Ask an admin if you need a copy.' });
        return false;
      }
      void api.post('/api/audit/output', { action, what: what.slice(0, 200), path: window.location.pathname }).catch(() => {});
      return true;
    });
    // The browser's own print command: blank, with a notice, without the right.
    if (may('print')) delete document.body.dataset.noPrint;
    else document.body.dataset.noPrint = 'true';
    return () => setOutputGuard(() => true);
  }, [role, path]);

  return null;
}
