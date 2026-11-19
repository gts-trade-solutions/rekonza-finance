// ─────────────────────────────────────────────────────────────────────────────
// A spreadsheet, CSV or JSON file read in the browser: as the grid the import
// screen matches to a template, or just far enough to tell which import it is
// for (lib/imports/file-kind). Browser only: Excel is read by read-excel-file.
// ─────────────────────────────────────────────────────────────────────────────

import Papa from 'papaparse';
import { guessDelimiter, readTextFile } from '../delimited';
import { guessImportKind, guessJsonKind } from './file-kind';
import { jsonGrid } from './json';
import { readXls } from './xls';
import type { ImportKind } from './templates';

/** A cell as text the server reads: dates as yyyy-mm-dd. */
export const cellText = (v: unknown) =>
  v instanceof Date ? v.toISOString().slice(0, 10) : v === null || v === undefined ? '' : String(v);

const isXlsx = (f: File) => /\.xlsx$/i.test(f.name);
const isXls = (f: File) => /\.xls$/i.test(f.name);
const isJson = (f: File) => /\.json$/i.test(f.name);

/** The first sheet with anything on it. */
async function xlsxGrid(file: File): Promise<unknown[][]> {
  const { default: readXlsxFile } = await import('read-excel-file/browser');
  const sheets = (await readXlsxFile(file)) as unknown as { sheet: string; data: unknown[][] }[];
  return sheets.find((s) => s.data.some((r) => r.some((c) => c !== null && c !== '')))?.data ?? [];
}

/**
 * The file as rows of cells, its headings first. `delimiter` is a text file's
 * separator, or 'auto' to find it; the one used comes back (null for Excel or JSON).
 */
export async function readGrid(file: File, kind: ImportKind, delimiter = 'auto', encoding = 'utf-8'): Promise<{ grid: unknown[][]; delimiter: string | null }> {
  if (isXlsx(file)) return { grid: await xlsxGrid(file), delimiter: null };
  // Excel 97–2003, or a bank's HTML or text saved as .xls (lib/imports/xls.ts).
  let text: string | null = null;
  if (isXls(file)) {
    const r = readXls(new Uint8Array(await file.arrayBuffer()));
    if ('grid' in r) return { grid: r.grid, delimiter: null };
    text = r.text;
  }
  // JSON becomes the same grid a spreadsheet gives (lib/imports/json.ts).
  if (isJson(file)) return { grid: jsonGrid(await file.text(), kind), delimiter: null };
  // CSV or any delimited text: comma, tab, pipe, semicolon, or a separator of the user's own,
  // in the character encoding chosen (Zoho's list), or found from the file's own mark.
  text ??= encoding && encoding !== 'utf-8' ? new TextDecoder(encoding).decode(await file.arrayBuffer()).replace(/^\uFEFF/, '') : await readTextFile(file);
  const used = delimiter === 'auto' || !delimiter ? guessDelimiter(text) : delimiter;
  return { grid: Papa.parse<string[]>(text, { delimiter: used, skipEmptyLines: 'greedy' }).data, delimiter: used };
}

/** The import a spreadsheet, CSV or JSON file is for, from its headings; null if none takes it whole. */
export async function guessFileKind(file: File): Promise<ImportKind | null> {
  try {
    if (isJson(file)) return guessJsonKind(await file.text(), file.name);
    let headings: unknown[] = [];
    if (isXlsx(file)) headings = (await xlsxGrid(file))[0] ?? [];
    else if (isXls(file)) {
      const r = readXls(new Uint8Array(await file.arrayBuffer()));
      headings = 'grid' in r ? r.grid[0] ?? [] : Papa.parse<string[]>(r.text, { delimiter: guessDelimiter(r.text), preview: 1 }).data[0] ?? [];
    } else {
      const text = await readTextFile(file);
      headings = Papa.parse<string[]>(text, { delimiter: guessDelimiter(text), preview: 1 }).data[0] ?? [];
    }
    return guessImportKind(headings.map((h) => cellText(h).trim()), file.name);
  } catch {
    return null;
  }
}
