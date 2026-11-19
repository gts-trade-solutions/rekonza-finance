// Files chosen on one import screen for another to read: a customer list
// chosen on Tally → Import, say, opened on Settings → Import already set to
// Customers and vendors. Kept in memory while the app moves between its pages
// (it never reloads in between), and taken once by the screen they are for.

export interface HandedOver {
  /** Excel, CSV, text and JSON files: for Settings → Import → Excel, CSV, text or JSON. */
  sheets: File[];
  /** Invoice PDFs and photos: for Settings → Import → Invoices from PDF. */
  pdfs: File[];
}

let waiting: HandedOver = { sheets: [], pdfs: [] };

export function handOver(files: Partial<HandedOver>) {
  waiting = { sheets: [...waiting.sheets, ...(files.sheets ?? [])], pdfs: [...waiting.pdfs, ...(files.pdfs ?? [])] };
}

/** What was handed over, emptied as it is taken. */
export function takeHandedOver(): HandedOver {
  const w = waiting;
  waiting = { sheets: [], pdfs: [] };
  return w;
}
