// A bank account number for whoever may see it: the whole number for those who
// pay or edit vendors (purchases, edit), the last four digits for everyone
// else. A viewer or a sales user has no need of a supplier's full account, and
// a full number on every screen is a fraud waiting for a careless export.

import { hasPermission } from '../rbac';
import type { RoleName } from '../types';
import { unseal } from './crypto/fields';

export const MASK = '••••';

export function bankNumberFor(role: RoleName | string, stored: string | null): string | null {
  const full = unseal(stored);
  if (!full) return full;
  return hasPermission(role as RoleName, 'purchases', 'edit') ? full : `${MASK}${full.slice(-4)}`;
}

/** A masked number sent back from a form means "unchanged". */
export const isMasked = (v: unknown) => typeof v === 'string' && v.startsWith(MASK);
