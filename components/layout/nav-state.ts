'use client';

// Whether the sidebar is folded down to Zoho's icon rail.
//
// Two reasons it folds, kept apart because they last differently:
// - the person pressed the fold button at the foot of the sidebar, which is
//   remembered in this browser (localStorage), as Zoho remembers it;
// - a record is open in the split view (list on the left, record on the
//   right). Zoho folds the sidebar for as long as a record is open and unfolds
//   it when the record closes, so the record gets the room. That is a "force"
//   held by whichever screen needs it and released when it unmounts, so it
//   never overwrites what the person chose.
// - Pressing Expand while a screen holds it folded opens it anyway, for as
//   long as that screen stays open (Zoho's rail opens on the same button).
//   Before this, the button did nothing there and the menu could not be had.

import { useEffect, useSyncExternalStore } from 'react';

const KEY = 'rekonza-nav-collapsed';
let chosen: boolean | null = null;
let forced = 0;
/** The person opened the menu over a screen that folds it; cleared when the last such screen closes. */
let overridden = false;
const listeners = new Set<() => void>();

function readChosen(): boolean {
  if (chosen === null) {
    try { chosen = typeof window !== 'undefined' && localStorage.getItem(KEY) === '1'; } catch { chosen = false; }
  }
  return chosen;
}

function emit() { for (const l of listeners) l(); }

function subscribe(l: () => void) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

/** The sidebar is folded: by choice, or while a record is open. */
export function useNavCollapsed(): boolean {
  return useSyncExternalStore(subscribe, () => readChosen() || (forced > 0 && !overridden), () => false);
}

/** Only the person's own choice, for the fold button's state. */
export function useNavChosenCollapsed(): boolean {
  return useSyncExternalStore(subscribe, () => readChosen(), () => false);
}

export function setNavCollapsed(value: boolean) {
  chosen = value;
  // Expand over a folding screen opens it there too; Collapse gives the fold back.
  overridden = !value && forced > 0;
  try { localStorage.setItem(KEY, value ? '1' : '0'); } catch { /* private mode: it lasts this visit */ }
  emit();
}

/** The fold button: open the menu if it is folded for any reason, fold it if it is open. */
export function toggleNav() {
  const folded = readChosen() || (forced > 0 && !overridden);
  setNavCollapsed(!folded);
}

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
