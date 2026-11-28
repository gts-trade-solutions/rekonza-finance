'use client';

// Whether the sidebar is folded down to the icon rail.
//
// It is open when the app first opens, and folds as soon as a page is chosen
// from it (the client, 2026-11-28: "initially the sidebar should be open; when
// I click something inside of it, at that time it should hide"); before that,
// from 2026-11-25, every page opened with it folded. So: open on the first page
// the app loads, folded on every page after, the page getting the room. The top
// bar's menu button, or the rail's expand button, opens it again; it stays open
// on that page and folds when a page is chosen from it or the next page opens.
//
// A screen can also hold it folded while it is on screen (a record open in
// the split view, an entry window): a "force" taken by that screen and
// released when it unmounts. Opening the menu over such a screen opens it
// anyway, for as long as that screen stays.

import { useEffect, useSyncExternalStore } from 'react';
import { usePathname } from 'next/navigation';

/** Until the first page of the app has shown: open, whatever that page is. */
const OPEN_FIRST = '*';
/**
 * The page the sidebar is open on; it is folded on any other. To begin with,
 * the first page the app shows (taken once it has shown: signing in moves to
 * the dashboard without reloading, so the address at load can still be /login).
 */
let openedOn: string | null = OPEN_FIRST;
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

/** The sidebar is folded: on every page but the one it is open on, and while a screen holds it. */
export function useNavCollapsed(): boolean {
  const pathname = usePathname();
  const s = useSyncExternalStore(subscribe, snapshot, () => `0${OPEN_FIRST}`);
  // The first page shown keeps it open; leaving the page it is open on folds it for good (coming
  // back to that page, by X on a record or Back, does not open it again: only ☰ or » does).
  useEffect(() => {
    if (!pathname) return;
    if (openedOn === OPEN_FIRST) { openedOn = pathname; emit(); } else if (openedOn !== null && openedOn !== pathname) { openedOn = null; emit(); }
  }, [pathname]);
  const openOn = s.slice(1);
  return s[0] === '1' || (openOn !== OPEN_FIRST && openOn !== pathname);
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
