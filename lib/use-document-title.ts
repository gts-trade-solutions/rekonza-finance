'use client';

// The browser tab's name while a page is open. The browser's "Save as PDF"
// offers it as the file name, so a printed invoice saves as its number
// ("INV-26-27-0001.pdf", as Zoho Books does) rather than as the app's name.

import { useEffect } from 'react';

/** A title a file can be named after: no characters Windows refuses in a file name. */
export function fileTitle(title: string): string {
  return title.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120);
}

export function useDocumentTitle(title: string | null | undefined) {
  useEffect(() => {
    if (!title) return;
    const before = document.title;
    document.title = fileTitle(title);
    return () => { document.title = before; };
  }, [title]);
}
