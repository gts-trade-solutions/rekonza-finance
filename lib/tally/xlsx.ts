// ─────────────────────────────────────────────────────────────────────────────
// An Excel (.xlsx) sheet with each cell's look, for Tally's Excel exports.
//
// Tally tells a group from a ledger in its Excel reports only by the look:
// a group's row is bold, a ledger's italic and indented; and a stock item's
// unit is kept in the number format ("35" shown as 35 Nos). The spreadsheet
// library the imports use gives values only, so this reads the few parts of
// the file needed for that: the shared strings, the styles (fonts, alignment,
// number formats) and the first sheet with anything on it.
//
// Zips are opened with lib/tally/data-files. Shared by the browser and the
// tests; no server code.
// ─────────────────────────────────────────────────────────────────────────────

import { unzipEntry, zipEntries } from './data-files';

export interface StyledCell {
  /** Text, or a number as Excel holds it. */
  v: string | number | null;
  bold?: boolean;
  italic?: boolean;
  /** Excel's indent level (Tally writes 3 per level). */
  indent?: number;
  /** The cell's number format, such as `""0" Nos"`. */
  fmt?: string;
}

const XML_ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unxml = (s: string) =>
  s.replace(/&(amp|lt|gt|quot|apos);/g, (_, e: string) => XML_ENT[e]).replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCharCode(parseInt(n, 16)));
const attr = (s: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(s)?.[1] ?? null;

/** Column letters to a 0-based index: A → 0, AB → 27. */
const colIndex = (ref: string) => {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

/** Excel's built-in number formats that matter here (the rest read as numbers anyway). */
const BUILTIN_FMT: Record<number, string> = { 0: 'General', 1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00', 14: 'm/d/yyyy', 49: '@' };

export async function readStyledXlsx(file: Blob): Promise<StyledCell[][]> {
  const entries = await zipEntries(file);
  const byName = new Map(entries.map((e) => [e.name.replace(/\\/g, '/').toLowerCase(), e]));
  const read = async (name: string) => {
    const e = byName.get(name.toLowerCase());
    return e ? new TextDecoder('utf-8').decode(await unzipEntry(file, e)) : null;
  };

  const shared: string[] = [];
  const sst = await read('xl/sharedStrings.xml');
  if (sst) {
    for (const si of sst.match(/<si>[\s\S]*?<\/si>/g) ?? []) {
      shared.push(unxml((si.match(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g) ?? []).map((t) => t.replace(/<[^>]+>/g, '')).join('')));
    }
  }

  // Styles: each cell's s="n" is an index into cellXfs, which names a font and a number format.
  const fonts: { bold: boolean; italic: boolean }[] = [];
  const xfs: { font: number; fmt: number; indent: number }[] = [];
  const fmts = new Map<number, string>();
  const styles = await read('xl/styles.xml');
  if (styles) {
    for (const f of /<numFmts[^>]*>([\s\S]*?)<\/numFmts>/.exec(styles)?.[1].match(/<numFmt\b[^>]*\/?>/g) ?? []) {
      fmts.set(Number(attr(f, 'numFmtId')), unxml(attr(f, 'formatCode') ?? ''));
    }
    // A self-closing element first, or the lazy match runs on into the next one's closing tag.
    for (const f of /<fonts[^>]*>([\s\S]*?)<\/fonts>/.exec(styles)?.[1].match(/<font\b[^>]*\/>|<font\b[^>]*>[\s\S]*?<\/font>/g) ?? []) {
      fonts.push({ bold: /<b\/>|<b\s+val="(1|true)"/.test(f), italic: /<i\/>|<i\s+val="(1|true)"/.test(f) });
    }
    for (const x of /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1].match(/<xf\b[^>]*\/>|<xf\b[^>]*>[\s\S]*?<\/xf>/g) ?? []) {
      xfs.push({ font: Number(attr(x, 'fontId') ?? 0), fmt: Number(attr(x, 'numFmtId') ?? 0), indent: Number(attr(/<alignment\b[^>]*>/.exec(x)?.[0] ?? '', 'indent') ?? 0) });
    }
  }

  // The sheets in the book's order, the first with anything on it.
  const sheetNames = [...byName.keys()].filter((n) => /^xl\/worksheets\/[^/]+\.xml$/.test(n))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)?.[1] ?? 0) - Number(/(\d+)\.xml$/.exec(b)?.[1] ?? 0));
  for (const name of sheetNames) {
    const sheet = await read(name);
    if (!sheet) continue;
    const grid: StyledCell[][] = [];
    for (const row of sheet.match(/<row\b[^>]*\/>|<row\b[^>]*>[\s\S]*?<\/row>/g) ?? []) {
      const r = Number(attr(row, 'r') ?? grid.length + 1) - 1;
      const cells: StyledCell[] = [];
      for (const c of row.match(/<c\b[^>]*\/>|<c\b[^>]*>[\s\S]*?<\/c>/g) ?? []) {
        const head = /<c\b[^>]*>/.exec(c)?.[0] ?? c;
        const ref = attr(head, 'r') ?? '';
        const t = attr(head, 't');
        const s = Number(attr(head, 's') ?? 0);
        const raw = /<v>([\s\S]*?)<\/v>/.exec(c)?.[1];
        let v: string | number | null = null;
        if (t === 's') v = shared[Number(raw)] ?? '';
        else if (t === 'inlineStr') v = unxml((c.match(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g) ?? []).map((x) => x.replace(/<[^>]+>/g, '')).join(''));
        else if (t === 'str' || t === 'e') v = raw === undefined ? null : unxml(raw);
        else if (t === 'b') v = raw === '1' ? 'TRUE' : 'FALSE';
        else if (raw !== undefined && raw !== '') v = Number(raw);
        const xf = xfs[s];
        const font = xf ? fonts[xf.font] : undefined;
        const cell: StyledCell = { v };
        if (font?.bold) cell.bold = true;
        if (font?.italic) cell.italic = true;
        if (xf?.indent) cell.indent = xf.indent;
        const fmt = xf ? fmts.get(xf.fmt) ?? BUILTIN_FMT[xf.fmt] : undefined;
        if (fmt && fmt !== 'General') cell.fmt = fmt;
        cells[ref ? colIndex(ref) : cells.length] = cell;
      }
      for (let i = 0; i < cells.length; i++) cells[i] ??= { v: null };
      grid[r] = cells;
    }
    for (let i = 0; i < grid.length; i++) grid[i] ??= [];
    if (grid.some((row) => row.some((c) => c.v !== null && c.v !== ''))) return grid;
  }
  return [];
}

/** The unit a number format shows after the figure: `""0" Nos"` → "Nos". */
export function unitOfFormat(fmt: string | undefined): string | null {
  if (!fmt) return null;
  const m = /"\s*([A-Za-z][A-Za-z0-9 ./-]{0,15}?)\s*"\s*;?\s*$/.exec(fmt.split(';')[0]);
  return m ? m[1].trim() : null;
}
