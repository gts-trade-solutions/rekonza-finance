// ─────────────────────────────────────────────────────────────────────────────
// Talking to TallyPrime on this PC.
//
// Tally's data port speaks XML over plain HTTP, and reads and writes it as
// UTF-16 — sending UTF-8 works for English names and quietly mangles the rest,
// so both directions are UTF-16 here. The replies are rows of numbered tags,
// read back into named columns.
//
// A closed Tally, a port that is switched off, and a request Tally refuses are
// three different problems with three different fixes, so each has its own
// error and message.
// ─────────────────────────────────────────────────────────────────────────────

import http from 'node:http';
import { NULL_MARK, reportRequest, type ReportSpec } from './tally-requests';

/** A leading byte-order mark, dropped from a decoded reply. */
const BOM = new RegExp('^' + String.fromCharCode(0xfeff));

export interface TallyAddress {
  host: string;
  port: number;
  timeoutMs?: number;
}

/** TallyPrime is not answering: closed, or its data port is off. Worth trying again later. */
export class TallyUnavailable extends Error {
  constructor(address: TallyAddress, cause?: unknown) {
    super(
      `TallyPrime is not answering on ${address.host}:${address.port}. Open TallyPrime, and check F1 Help → Settings → ` +
        'Connectivity is set to act as a server on this port.',
    );
    this.name = 'TallyUnavailable';
    this.cause = cause;
  }
}

/** Tally answered, and refused: a company that is not open, or a request it cannot run. */
export class TallyRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TallyRefused';
  }
}

export function postTally(xml: string, address: TallyAddress): Promise<string> {
  const body = Buffer.from(xml, 'utf16le');
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: address.host,
        port: address.port,
        method: 'POST',
        path: '/',
        headers: { 'Content-Type': 'text/xml;charset=utf-16', 'Content-Length': body.length },
        timeout: address.timeoutMs ?? 120_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks);
          // Tally writes UTF-16, but a proxy or an older release may not: a
          // byte-order mark or zero bytes in the second position say which.
          const utf16 = (raw[0] === 0xff && raw[1] === 0xfe) || (raw.length > 1 && raw[1] === 0);
          resolve(utf16 ? raw.toString('utf16le').replace(BOM, '') : raw.toString('utf8'));
        });
        res.on('error', (err) => reject(new TallyUnavailable(address, err)));
      },
    );
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', (err) => reject(new TallyUnavailable(address, err)));
    req.end(body);
  });
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function unescape(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|apos);/g, (_, e: string) => ENTITIES[e]).replace(/&#(\d+);/g, (_, n: string) => {
    const code = Number(n);
    // Tally writes some control characters as numeric escapes. They are noise.
    return code < 32 && code !== 9 && code !== 10 && code !== 13 ? '' : String.fromCharCode(code);
  });
}

export type Row<C extends readonly string[]> = Record<C[number], string | null>;

/** Rows of named columns from a reply of numbered tags. Empty values and the empty-date mark are null. */
export function parseRows<C extends readonly string[]>(xml: string, columns: C): Row<C>[] {
  const error = xml.match(/<LINEERROR>([\s\S]*?)<\/LINEERROR>/);
  if (error) throw new TallyRefused(unescape(error[1]).trim());

  const rows: Row<C>[] = [];
  let row: Record<string, string | null> | null = null;
  const tags = /<F(\d{2})(?:\/>|>([\s\S]*?)<\/F\1>)/g;
  for (let m = tags.exec(xml); m; m = tags.exec(xml)) {
    const index = Number(m[1]) - 1;
    if (index === 0) {
      row = {};
      rows.push(row as Row<C>);
    }
    if (!row || index < 0 || index >= columns.length) continue;
    const value = m[2] === undefined ? '' : unescape(m[2]).trim();
    row[columns[index]] = value === '' || value === NULL_MARK ? null : value;
  }
  for (const r of rows) for (const c of columns) if (!(c in r)) (r as Record<string, string | null>)[c] = null;
  return rows;
}

/** Ask Tally for one report and read it back. */
export async function fetchRows<C extends readonly string[]>(
  spec: ReportSpec & { columns: C },
  address: TallyAddress,
): Promise<Row<C>[]> {
  return parseRows(await postTally(reportRequest(spec), address), spec.columns);
}
