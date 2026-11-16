'use client';

// What the top bar needs to know about the screen below it, as Zoho's does:
// - the page's title, so its search box can say "Search in Invoices ( / )";
// - the page's own list, so typing in that box filters the list in place.
//
// PageHeader publishes the title. The page's main DataTable (one that is not
// inside a card, a tab or a dialog) publishes its search; it then hides its own
// search box, because Zoho has exactly one, in the top bar. When the page has
// no list, the top bar's box opens the search across the whole book instead.

import { useEffect, useSyncExternalStore } from 'react';

export interface ListSearch {
  owner: symbol;
  query: string;
  setQuery: (q: string) => void;
  /** What the box says it searches, when not the page's title ("Invoices" beside an open invoice). */
  label?: string;
}

let title: string | null = null;
let titleOwner: symbol | null = null;
let list: ListSearch | null = null;
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

export function usePageTitle(): string | null {
  return useSyncExternalStore(subscribe, () => title, () => null);
}

export function useListSearch(): ListSearch | null {
  return useSyncExternalStore(subscribe, () => list, () => null);
}

/** PageHeader: this is the page's title while it is mounted. */
export function usePublishPageTitle(value: string) {
  useEffect(() => {
    const me = Symbol('title');
    title = value;
    titleOwner = me;
    emit();
    return () => {
      if (titleOwner === me) { title = null; titleOwner = null; emit(); }
    };
  }, [value]);
}

/**
 * The page's main list claims the top bar's search. The first list to claim
 * it keeps it; a second list on the same page keeps its own box. Returns
 * whether this list holds the claim (and so should hide its own box).
 */
export function claimListSearch(owner: symbol, query: string, setQuery: (q: string) => void, label?: string): boolean {
  if (list && list.owner !== owner) return false;
  if (!list || list.query !== query || list.setQuery !== setQuery || list.label !== label) {
    list = { owner, query, setQuery, label };
    emit();
  }
  return true;
}

export function releaseListSearch(owner: symbol) {
  if (list?.owner === owner) { list = null; emit(); }
}

/** Whether this list currently holds the top bar's search. */
export function useHoldsListSearch(owner: symbol): boolean {
  return useSyncExternalStore(subscribe, () => list?.owner === owner, () => false);
}

// ── The view picker's place in the header ───────────────────────────────────
// Zoho's list title is itself the view menu: "All Invoices ▾". The page's main
// list draws its status views there (DataTable portals into this element).
let viewSlot: HTMLElement | null = null;

export function setViewSlot(el: HTMLElement | null) {
  if (viewSlot !== el) { viewSlot = el; emit(); }
}

export function useViewSlot(): HTMLElement | null {
  return useSyncExternalStore(subscribe, () => viewSlot, () => null);
}
