import 'server-only';

// A bank statement file read on the server, the way Banking → Import Statement
// reads one in the browser (app/(app)/banking/imports/page.tsx): CSV, TSV and
// text; Excel (.xlsx, and .xls as Indian banks still send it, including their
// HTML or text saved as .xls); OFX/QFX; QIF; camt.053 XML; MT940; JSON. Used
// by statements that arrive by email (services/inbound-statements.ts), where
// there is no browser to read the attachment. The columns are found the same
// way (guessMapping); a file whose columns cannot be found is refused, with
// the reason, rather than guessed at.

import Papa from 'papaparse';
import { detectFormat, parseCamt, parseJsonStatement, parseMt940, parseOfx, parseQif, type StatementFormat } from '../bank-formats';
import { guessMapping, readWithMapping, type StatementRow } from '../bank-statement';
import { readXls } from '../imports/xls';

/** The attachments worth trying: a statement in one of the formats Import Statement reads. */
export const STATEMENT_FILE = /\.(csv|tsv|txt|xlsx|xls|ofx|qfx|qif|xml|sta|mt940|940|json)$/i;

export interface ReadStatement { format: StatementFormat; rows: StatementRow[]; problem: string | null }

function fromGrid(format: StatementFormat, grid: unknown[][]): ReadStatement {
  const mapping = guessMapping(grid);
  if (!mapping) return { format, rows: [], problem: 'No header row with a date and a description was found.' };
  const { rows, problem } = readWithMapping(grid, mapping);
  return { format, rows, problem };
}

export async function readStatementFile(name: string, bytes: Uint8Array): Promise<ReadStatement> {
  const head = /\.xlsx?$/i.test(name) ? '' : new TextDecoder().decode(bytes.slice(0, 4096));
  const format = detectFormat(name, head);
  if (format === 'xlsx') {
    if (/\.xls$/i.test(name)) {
      const r = readXls(bytes);
      if ('grid' in r) return fromGrid(format, r.grid);
      return fromGrid(format, Papa.parse<string[]>(r.text, { skipEmptyLines: true }).data);
    }
    // The first sheet's rows, as the browser's import reads the first sheet with anything in it.
    const { default: readXlsxFile } = await import('read-excel-file/node');
    const grid = (await readXlsxFile(Buffer.from(bytes))) as unknown as unknown[][];
    return fromGrid(format, grid);
  }
  const text = new TextDecoder().decode(bytes).replace(/^﻿/, '');
  const parsed = format === 'ofx' ? parseOfx(text) : format === 'qif' ? parseQif(text) : format === 'camt' ? parseCamt(text)
    : format === 'mt940' ? parseMt940(text) : format === 'json' ? parseJsonStatement(text) : null;
  if (parsed) return { format, rows: parsed.rows, problem: parsed.problem };
  return fromGrid(format, Papa.parse<string[]>(text, { skipEmptyLines: true }).data);
}
