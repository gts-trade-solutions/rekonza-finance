// ─────────────────────────────────────────────────────────────────────────────
// Delimited text: CSV and its cousins, in and out.
//
// A "CSV" from another system is often not comma-separated at all: tabs
// (Excel's "Text (Tab delimited)", QuickBooks' IIF), pipes (bank and ERP
// exports), semicolons (Europe, where the comma is the decimal point). DSV —
// delimiter-separated values — is the name for all of them. They read the same
// way and are written the same way, with only the separator changed.
// ─────────────────────────────────────────────────────────────────────────────

export type DelimiterKey = 'comma' | 'tab' | 'pipe' | 'semicolon' | 'other';

export const DELIMITERS: { key: Exclude<DelimiterKey, 'other'>; char: string; label: string; ext: string }[] = [
  { key: 'comma', char: ',', label: 'Comma ( , )', ext: 'csv' },
  { key: 'tab', char: '\t', label: 'Tab', ext: 'txt' },
  { key: 'pipe', char: '|', label: 'Pipe ( | )', ext: 'txt' },
  { key: 'semicolon', char: ';', label: 'Semicolon ( ; )', ext: 'txt' },
];

/** The file types a delimited-text import accepts. */
export const TEXT_FILE_TYPES = '.csv,.txt,.tsv,.tab,.dsv,.psv,.prn,text/csv,text/plain,text/tab-separated-values';

/** What a separator is called on screen. */
export function delimiterName(char: string): string {
  const known = DELIMITERS.find((d) => d.char === char);
  if (known) return known.label;
  return char ? `"${char}"` : 'not found';
}

/** One file's rows as delimited text: a field with the separator, a quote or a line break is quoted. */
export function toDelimited(rows: (string | number | null | undefined)[][], delimiter: string): string {
  const needs = (s: string) => s.includes(delimiter) || /["\r\n]/.test(s) || /^\s|\s$/.test(s);
  return rows
    .map((r) => r.map((c) => {
      const s = c === null || c === undefined ? '' : String(c);
      return needs(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(delimiter))
    .join('\r\n');
}

/** A text file as the browser holds it: UTF-8, or UTF-16 as Excel's "Unicode text" and Tally write it. */
export async function readTextFile(file: Blob): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());
  const le = (buf[0] === 0xff && buf[1] === 0xfe) || (buf.length > 3 && buf[1] === 0 && buf[3] === 0 && buf[0] !== 0);
  const be = (buf[0] === 0xfe && buf[1] === 0xff) || (buf.length > 3 && buf[0] === 0 && buf[2] === 0 && buf[1] !== 0);
  return new TextDecoder(be ? 'utf-16be' : le ? 'utf-16le' : 'utf-8').decode(buf).replace(/^\uFEFF/, '');
}

/** The separator a file most likely uses: the candidate that splits its first lines into the same number of columns. */
export function guessDelimiter(text: string): string {
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 20);
  let best = ',';
  let bestScore = -1;
  for (const d of [',', '\t', '|', ';']) {
    const counts = lines.map((l) => splitOutsideQuotes(l, d));
    if (!counts.length || counts[0] < 1) continue;
    const same = counts.filter((c) => c === counts[0]).length;
    const score = same * 100 + counts[0];
    if (score > bestScore) { best = d; bestScore = score; }
  }
  return best;
}

/** How many separators a line has outside quotes. */
function splitOutsideQuotes(line: string, d: string): number {
  let n = 0;
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === d && !quoted) n++;
  }
  return n;
}
