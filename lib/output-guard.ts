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
/** `recorded`: the server has already written this copy into the audit trail, so the gate only checks the right. */
type Guard = (action: OutputAction, what: string, recorded?: boolean) => boolean;

let guard: Guard = () => true;
let recordedByServer = false;

export function setOutputGuard(g: Guard) {
  guard = g;
}

export function allowOutput(action: OutputAction, what: string): boolean {
  return guard(action, what, recordedByServer);
}

/**
 * Hand over a file the server has already recorded in the audit trail (the
 * audit trail's own export, GET /api/audit/export, records the format, the
 * filters and the row count). The gate still checks the right to export, but
 * does not write a second line for the same copy.
 */
export function outputRecorded<T>(fn: () => T): T {
  recordedByServer = true;
  try {
    return fn();
  } finally {
    recordedByServer = false;
  }
}

/** Print the page, if the user may. */
export function printPage(what?: string) {
  if (allowOutput('print', what ?? (typeof document === 'undefined' ? 'page' : document.title))) window.print();
}
