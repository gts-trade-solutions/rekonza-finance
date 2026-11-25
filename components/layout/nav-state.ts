'use client';

// Whether the sidebar is folded down to the icon rail.
//
// Every page opens with it folded (the client, 2026-11-25: "when I entered the
// page the sidebar should close for all the pages"), so the page gets the
// room. The top bar's menu button, or the rail's expand button, opens it; it
// stays open on that page and folds again when the next page opens. Before
// this the choice was remembered in the browser, as Zoho remembers it.
//
// A screen can also hold it folded while it is on screen (a record open in
// the split view, an entry window): a "force" taken by that screen and
// released when it unmounts. Opening the menu over such a screen opens it
// anyway, for as long as that screen stays.

import { useEffect, useSyncExternalStore } from 'react';
import { usePathname } from 'next/navigation';

/** The page the person opened the sidebar on; it folds again on any other. */
let openedOn: string | null = null;
let forced = 0;
/** The person opened the menu over a screen that folds it; cleared when the last such screen closes. */
let overridden = false;
const listeners = new Set<() => void>();

const here = () => (typeof window === 'undefined' ? '' : window.location.pathname);

function emit() { for (const l of listeners) l(); }

function subscribe(l: () => void) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

// One string, so a change to any part re-renders (useSyncExternalStore compares snapshots).
const snapshot = () => `${forced > 0 && !overridden ? '1' : '0'}${openedOn ?? ''}`;

/** The sidebar is folded: on every page until the person opens it there, and while a screen holds it. */
export function useNavCollapsed(): boolean {
  const pathname = usePathname();
  const s = useSyncExternalStore(subscribe, snapshot, () => '0');
  return s[0] === '1' || s.slice(1) !== pathname;
}

/** Open (false) or fold (true) the sidebar on the page that is open. */
export function setNavCollapsed(value: boolean) {
  openedOn = value ? null : here();
  // Opening it over a screen that holds it folded opens it there too.
  overridden = !value && forced > 0;
  emit();
}

/** The fold button: open the menu if it is folded for any reason, fold it if it is open. */
export function toggleNav() {
  const folded = openedOn !== here() || (forced > 0 && !overridden);
  setNavCollapsed(!folded);
}

// The pages that are a transaction's entry form (the client's first ask, on
// 2026-11-23: "when ledgering the sidebar should minimized"). Every page folds
// it now; entry windows over a list still put <FoldNav /> inside them, so a
// menu opened over the list folds again when the window opens.
const ENTRY_MODULES = [
  'sales/(?:invoices|estimates|sales-orders|challans|credit-notes|debit-notes|sales-receipts|payments|recurring|retainers)',
  'purchases/(?:bills|expenses|purchase-orders|vendor-credits|payments|recurring|goods-receipts|bills-of-entry)',
  'accountant/(?:journals|recurring-journals)',
  'inventory/(?:adjustments|transfers|production)',
  // An account's Add and Edit, and a rule's New and Edit, as well as transfers and cheques.
  'banking(?:/(?:transfers|cheques|rules))?',
].join('|');
const ENTRY_PAGE = new RegExp(`^/(?:${ENTRY_MODULES})/(?:new|[^/]+/edit)/?$`);

/** A page that is a transaction's entry form: a new one, or an edit. */
export const isEntryPage = (path: string | null | undefined) => !!path && ENTRY_PAGE.test(path);

/** Folds the sidebar while the calling screen is mounted (the split record view). */
export function useForceNavCollapsed(active = true) {
  useEffect(() => {
    if (!active) return;
    forced++;
    emit();
    return () => {
      forced--;
      if (forced === 0) overridden = false;
      emit();
    };
  }, [active]);
}

/**
 * Folds the sidebar for as long as it is on screen: put it inside an entry
 * window (a new expense, journal, quote …). A closed window's content is gone,
 * and the sidebar opens again with it.
 */
export function FoldNav(): null {
  useForceNavCollapsed(true);
  return null;
}
