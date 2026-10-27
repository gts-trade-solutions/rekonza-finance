// ─────────────────────────────────────────────────────────────────────────────
// Printing and exporting, through one gate.
//
// Every download and every print in the app goes through allowOutput(), which
// the signed-in shell sets to check the user's print or export right for the
// page they are on, and to record that they took a copy. With no shell (a
// script, the server) everything is allowed. Kept free of imports so the
// workbook writer, which also runs on the server, can use it.
// ─────────────────────────────────────────────────────────────────────────────

export type OutputAction = 'print' | 'export';
type Guard = (action: OutputAction, what: string) => boolean;

let guard: Guard = () => true;

export function setOutputGuard(g: Guard) {
  guard = g;
}

export function allowOutput(action: OutputAction, what: string): boolean {
  return guard(action, what);
}

/** Print the page, if the user may. */
export function printPage(what?: string) {
  if (allowOutput('print', what ?? (typeof document === 'undefined' ? 'page' : document.title))) window.print();
}
