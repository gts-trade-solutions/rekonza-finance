// Bank statement files other than spreadsheets, as Zoho Books takes them:
//
//   OFX / QFX    Open Financial Exchange, SGML (1.x) or XML (2.x)
//   QIF          Quicken Interchange Format
//   CAMT.053     ISO 20022 bank-to-customer statement (XML)
//   MT940        SWIFT customer statement, which most Indian banks' corporate
//                net banking offers
//   JSON         a list of lines, or a Rekonza export of bank statement lines
//
// Each is read in the browser into the same rows a spreadsheet gives, with
// the account number the file names (when it names one), so a pile of
// statements dropped together can each find their own bank account.

import { amount, guessDateOrder, readStatementGrid, statementDate, type DateOrder, type StatementRow } from './bank-statement';

export type StatementFormat = 'csv' | 'xlsx' | 'ofx' | 'qif' | 'camt' | 'mt940' | 'json';

export interface ParsedStatement {
  format: StatementFormat;
  rows: StatementRow[];
  /** The account number as the file gives it, for matching to a bank account. */
  accountHint: string | null;
  problem: string | null;
}

export const STATEMENT_ACCEPT = '.csv,.tsv,.txt,.xlsx,.xls,.ofx,.qfx,.qif,.xml,.sta,.mt940,.940,.json';

/** Which reader a file wants, from its name and, failing that, its first bytes. */
export function detectFormat(name: string, head: string): StatementFormat {
  const ext = (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? '').toLowerCase();
  if (ext === 'xlsx' || ext === 'xls') return 'xlsx';
  if (ext === 'ofx' || ext === 'qfx' || /<OFX>|OFXHEADER/i.test(head)) return 'ofx';
  if (ext === 'qif' || /^!Type:/im.test(head)) return 'qif';
  if (ext === 'json' || /^\s*[[{]/.test(head)) return 'json';
  if (/camt\.053|<BkToCstmrStmt>/i.test(head) || (ext === 'xml' && /<Stmt>/i.test(head))) return 'camt';
  if (ext === 'sta' || ext === 'mt940' || ext === '940' || /^:20:/m.test(head) && /^:61:/m.test(head)) return 'mt940';
  return 'csv';
}

const tag = (block: string, name: string) => new RegExp(`<${name}>([^<\\r\\n]*)`, 'i').exec(block)?.[1]?.trim() ?? '';
const paise = (n: number) => Math.round(Math.abs(n) * 100);

/** OFX 1.x (SGML, tags left open) and 2.x (XML) alike: each STMTTRN is a line. */
export function parseOfx(text: string): ParsedStatement {
  const rows: StatementRow[] = [];
  for (const block of text.split(/<STMTTRN>/i).slice(1)) {
    const body = block.split(/<\/STMTTRN>/i)[0];
    const date = statementDate(tag(body, 'DTPOSTED') || tag(body, 'DTUSER'));
    const amt = amount(tag(body, 'TRNAMT'));
    if (!date || !amt) continue;
    const name = tag(body, 'NAME');
    const memo = tag(body, 'MEMO');
    rows.push({
      date,
      narration: [name, memo].filter(Boolean).join(' · ') || tag(body, 'TRNTYPE') || 'Imported line',
      reference: tag(body, 'CHECKNUM') || tag(body, 'REFNUM') || tag(body, 'FITID') || null,
      depositPaise: amt > 0 ? paise(amt) : 0,
      withdrawalPaise: amt < 0 ? paise(amt) : 0,
    });
  }
  return { format: 'ofx', rows, accountHint: tag(text, 'ACCTID') || null, problem: rows.length ? null : 'No transactions (STMTTRN) were found in the OFX file.' };
}

/** QIF: one field per line, records ended by ^. D date, T amount, P payee, M memo, N number. */
export function parseQif(text: string, order?: DateOrder): ParsedStatement {
  const records: Record<string, string>[] = [];
  let cur: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('!')) continue;
    if (line === '^') {
      records.push(cur);
      cur = {};
      continue;
    }
    cur[line[0]] = line.slice(1).trim();
  }
  if (Object.keys(cur).length) records.push(cur);
  // QIF writes years with an apostrophe (5/10'26) and orders days by locale.
  const dates = records.map((r) => (r.D ?? '').replace(/'\s*/, '/'));
  const o = order ?? guessDateOrder(dates);
  const rows: StatementRow[] = [];
  records.forEach((r, i) => {
    const date = statementDate(dates[i], o);
    const amt = amount(r.T ?? r.U);
    if (!date || !amt) return;
    rows.push({
      date,
      narration: [r.P, r.M].filter(Boolean).join(' · ') || 'Imported line',
      reference: r.N || null,
      depositPaise: amt > 0 ? paise(amt) : 0,
      withdrawalPaise: amt < 0 ? paise(amt) : 0,
    });
  });
  return { format: 'qif', rows, accountHint: null, problem: rows.length ? null : 'No transactions were found in the QIF file.' };
}

const xmlText = (block: string, path: string[]): string => {
  let cur = block;
  for (const p of path) {
    const m = new RegExp(`<(?:\\w+:)?${p}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${p}>`, 'i').exec(cur);
    if (!m) return '';
    cur = m[1];
  }
  return cur.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
};

/** CAMT.053: each Ntry is a line, CRDT or DBIT, booked on its BookgDt. */
export function parseCamt(text: string): ParsedStatement {
  const rows: StatementRow[] = [];
  const entries = text.split(/<(?:\w+:)?Ntry>/i).slice(1).map((b) => b.split(/<\/(?:\w+:)?Ntry>/i)[0]);
  for (const e of entries) {
    const date = statementDate(xmlText(e, ['BookgDt', 'Dt']) || xmlText(e, ['BookgDt', 'DtTm']) || xmlText(e, ['ValDt', 'Dt']));
    const amt = amount(xmlText(e, ['Amt']));
    const credit = /CRDT/i.test(xmlText(e, ['CdtDbtInd']));
    if (!date || !amt) continue;
    const narration = xmlText(e, ['Ustrd']) || xmlText(e, ['AddtlNtryInf']) || xmlText(e, ['AddtlTxInf']) || 'Imported line';
    rows.push({
      date, narration,
      reference: xmlText(e, ['AcctSvcrRef']) || xmlText(e, ['EndToEndId']) || null,
      depositPaise: credit ? paise(amt) : 0,
      withdrawalPaise: credit ? 0 : paise(amt),
    });
  }
  // The account's IBAN, or its other identifier (nested Id tags defeat a path walk).
  const acct = /<(?:\w+:)?IBAN>\s*([^<\s]+)/i.exec(text)?.[1] ?? /<(?:\w+:)?Othr>\s*<(?:\w+:)?Id>\s*([^<\s]+)/i.exec(text)?.[1] ?? '';
  return { format: 'camt', rows, accountHint: acct || null, problem: rows.length ? null : 'No entries (Ntry) were found in the CAMT.053 file.' };
}

/** MT940: :61: is the line (value date, C or D, amount with a decimal comma), :86: its narrative. */
export function parseMt940(text: string): ParsedStatement {
  const rows: StatementRow[] = [];
  const lines = text.replace(/\r/g, '').split('\n');
  let account: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith(':25:')) account = l.slice(4).trim();
    const m = /^:61:(\d{2})(\d{2})(\d{2})(\d{4})?(R?[CD])[A-Z]?(\d+,\d*)([A-Z]\w{3})?(.*)$/.exec(l);
    if (!m) continue;
    const date = `20${m[1]}-${m[2]}-${m[3]}`;
    const amt = Number(m[6].replace(',', '.'));
    const credit = m[5] === 'C' || m[5] === 'RD';
    // An untagged line straight after :61: is its supplementary detail; the
    // narrative runs from :86: until the next tag.
    let j = i + 1;
    let narrative = '';
    if (j < lines.length && lines[j] && !lines[j].startsWith(':')) narrative = lines[j++];
    if (lines[j]?.startsWith(':86:')) {
      narrative = `${lines[j++].slice(4)} ${narrative}`;
      while (j < lines.length && !/^:\d{2}[A-Z]?:/.test(lines[j]) && !lines[j].startsWith('-')) narrative += ` ${lines[j++]}`;
    }
    const ref = (m[8] ?? '').split('//')[0].trim();
    if (!statementDate(date) || !amt) continue;
    rows.push({
      date,
      narration: narrative.replace(/\s+/g, ' ').trim() || ref || 'Imported line',
      reference: ref && ref !== 'NONREF' ? ref : null,
      depositPaise: credit ? paise(amt) : 0,
      withdrawalPaise: credit ? 0 : paise(amt),
    });
  }
  return { format: 'mt940', rows, accountHint: account, problem: rows.length ? null : 'No :61: statement lines were found in the MT940 file.' };
}

/** JSON: an array of lines with dates and amounts, however the keys are named. */
export function parseJsonStatement(text: string): ParsedStatement {
  let json: unknown;
  try {
    json = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    return { format: 'json', rows: [], accountHint: null, problem: 'That file is not valid JSON.' };
  }
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  const list = Array.isArray(json) ? json : isObj(json) ? (['rows', 'transactions', 'data', 'lines'].map((k) => json[k]).find(Array.isArray) as unknown[] | undefined) : undefined;
  if (!list) return { format: 'json', rows: [], accountHint: null, problem: 'No list of transactions was found in the JSON file.' };
  const objs = list.filter(isObj);
  const keys: string[] = [];
  for (const o of objs) for (const k of Object.keys(o)) if (!keys.includes(k)) keys.push(k);
  // Treat it as a spreadsheet, so the same column guessing applies.
  const grid = [keys, ...objs.map((o) => keys.map((k) => (o[k] === null || o[k] === undefined ? '' : String(o[k]))))];
  const r = readStatementGrid(grid);
  const accountHint = isObj(json) && typeof json.accountNumber === 'string' ? json.accountNumber : null;
  return { format: 'json', rows: r.rows, accountHint, problem: r.problem };
}

/**
 * The account number a spreadsheet statement names in its preamble
 * ("Account No : 50100123456789"), for matching to a bank account.
 */
export function accountInGrid(grid: unknown[][]): string | null {
  for (const r of grid.slice(0, 25)) {
    const text = r.map((c) => String(c ?? '')).join(' ');
    const m = /(?:a\/c|account)\s*(?:no|number|#)?\.?\s*[:\-]?\s*([X*\d][X*\d\s-]{5,})/i.exec(text);
    if (m) return m[1].replace(/[\s-]/g, '');
  }
  return null;
}

/** The bank account a statement belongs to, by the last four digits it names. */
export function matchAccount<T extends { id: string; accountLast4: string | null; name: string }>(
  accounts: T[], hint: string | null, filename: string,
): T | null {
  const digits = (hint ?? '').replace(/\D/g, '');
  if (digits.length >= 4) {
    const last4 = digits.slice(-4);
    const hit = accounts.filter((a) => a.accountLast4 === last4);
    if (hit.length === 1) return hit[0];
  }
  const byName = accounts.filter((a) => a.accountLast4 && filename.includes(a.accountLast4));
  return byName.length === 1 ? byName[0] : null;
}
