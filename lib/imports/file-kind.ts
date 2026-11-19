// ─────────────────────────────────────────────────────────────────────────────
// Which import a file belongs to, wherever it was chosen.
//
// People bring whatever file they have to whichever import screen they found
// first: a customer list to Tally's, an invoice PDF to the spreadsheet tab. So
// a file is told by its name (and, for a .txt, by its first characters), and
// a spreadsheet, CSV or JSON by its headings: the import whose columns they
// fill wins. The screens use this to take any file and pass it on, already
// set to the right import, instead of refusing it.
//
// Plain functions, no browser or server code: shared by the screens and the tests.
// ─────────────────────────────────────────────────────────────────────────────

import { isTallyDataFile } from '../tally/data-files';
import { jsonGrid } from './json';
import { columnFor, IMPORT_KINDS, TEMPLATES, type ImportKind } from './templates';

/**
 * The screen that reads a file.
 * tally: Tally's XML export. tally-data: Tally's own data folder (explained, not read).
 * zip: opened by the Tally screen. pdf: an invoice PDF or photo. sheet: Excel, CSV,
 * text or JSON. quickbooks: a QuickBooks .iif. unreadable: nothing here reads it.
 */
export type FileHome = 'tally' | 'tally-data' | 'zip' | 'pdf' | 'sheet' | 'quickbooks' | 'unreadable';

const ext = (name: string) => (name.split(/[\\/]/).pop() ?? name).toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';

/** Where a file goes, by its name; `head` is a .txt's first characters, as Tally writes XML to .txt too. */
export function fileHome(name: string, head = ''): FileHome {
  if (isTallyDataFile(name)) return 'tally-data';
  const e = ext(name);
  if (e === 'zip') return 'zip';
  if (e === 'xml') return 'tally';
  if (['pdf', 'png', 'jpg', 'jpeg', 'webp'].includes(e)) return 'pdf';
  if (e === 'iif') return 'quickbooks';
  if (e === 'txt') return /^\s*</.test(head.replace(/^﻿/, '').replace(/\0/g, '')) ? 'tally' : 'sheet';
  if (['xlsx', 'csv', 'tsv', 'tab', 'dsv', 'psv', 'prn', 'json'].includes(e)) return 'sheet';
  return 'unreadable';
}

/** What the screens call each home, for a line like "1-items.xlsx: a spreadsheet". */
export const HOME_LABEL: Record<FileHome, string> = {
  tally: 'a Tally export',
  'tally-data': "Tally's own data file",
  zip: 'a zip',
  pdf: 'an invoice to read',
  sheet: 'a spreadsheet',
  quickbooks: 'a QuickBooks file',
  unreadable: 'not a file Rekonza reads',
};

/** A word in the file's name that settles a tie between imports with alike columns. */
const NAME_HINTS: [RegExp, ImportKind][] = [
  [/quot|estimate/, 'estimates'],
  [/sales.?order/, 'sales-orders'],
  [/purchase.?order|\bpo\b/, 'purchase-orders'],
  [/credit.?note/, 'credit-notes'],
  [/payments?.?received|receipts?/, 'payments-received'],
  [/payments?.?made/, 'payments-made'],
  [/expense/, 'expenses'],
  [/journal/, 'journals'],
  [/opening.?(un)?paid|unpaid|outstanding|opening.?bill/, 'opening-bills'],
  [/opening.?(balance|ledger)|trial/, 'opening-ledger'],
  [/purchase|bill/, 'bills'],
  [/invoice|sales/, 'invoices'],
  [/item|product|stock/, 'items'],
  [/account|chart/, 'accounts'],
  [/customer|vendor|supplier|contact|part(y|ies)/, 'contacts'],
];

const hintFor = (fileName: string) => {
  const name = (fileName.split(/[\\/]/).pop() ?? fileName).toLowerCase();
  return NAME_HINTS.find(([re]) => re.test(name))?.[1];
};

/**
 * How well headings fill an import: a hundred for each of its columns found,
 * ten more when all its required ones are among them, five for a name that
 * points at it. So the most columns win; then a complete set; then the name.
 */
function score(kind: ImportKind, headings: string[], hinted: ImportKind | undefined) {
  const found = new Set(headings.map((h) => columnFor(kind, h)).filter((k): k is string => !!k));
  const complete = TEMPLATES[kind].columns.filter((c) => c.required).every((c) => found.has(c.key));
  return { kind, complete, score: found.size * 100 + (complete ? 10 : 0) + (kind === hinted ? 5 : 0) };
}

type Scored = ReturnType<typeof score>;
const better = (a: Scored | null, b: Scored) => (!a || b.score > a.score ? b : a);

/**
 * The import whose columns a file's headings fill best. Null when that import
 * still misses a required column: a customer list without its Type column is
 * a customer list to finish, not an item list because it has a Name.
 */
export function guessImportKind(headings: string[], fileName = '', only: readonly ImportKind[] = IMPORT_KINDS): ImportKind | null {
  const hinted = hintFor(fileName);
  let best: Scored | null = null;
  for (const kind of only) best = better(best, score(kind, headings, hinted));
  return best && best.score >= 100 && best.complete ? best.kind : null;
}

/**
 * The import a JSON file is for. Each import finds its rows its own way (a
 * Rekonza export names its module, { "invoices": [ … ] } its kind), so each
 * one's reading is tried, and the headings it reads decide, as for a sheet.
 */
export function guessJsonKind(text: string, fileName = ''): ImportKind | null {
  const hinted = hintFor(fileName);
  let best: Scored | null = null;
  for (const kind of IMPORT_KINDS) {
    let grid: string[][];
    try {
      grid = jsonGrid(text, kind);
    } catch {
      continue; // Not this import's rows.
    }
    if (grid.length > 1) best = better(best, score(kind, grid[0], hinted));
  }
  return best && best.score >= 100 && best.complete ? best.kind : null;
}
