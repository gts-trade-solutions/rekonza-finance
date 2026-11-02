// Reading an import from JSON, and the JSON template.
//
// JSON goes through exactly the same check and import as a spreadsheet: the
// file is turned into the same grid of headings and rows, and from there
// nothing knows where it came from. What it accepts:
//
//   * an array of objects, one per row, keyed by the template's keys or labels;
//   * that array under "rows", "data" or the import's own name;
//   * a Rekonza export ({ format: 'rekonza-export', module, rows }), or a full
//     backup ({ format: 'rekonza-backup', modules: { … } }), from which the
//     matching module is taken — so an export comes straight back in;
//   * documents with their lines nested ({ invoice_no, customer, lines: [ … ] }),
//     which become one row per line, the document's fields repeated on each.

import { TEMPLATES, type ImportKind } from './templates';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Which module of an export or backup an import kind reads. */
export const EXPORT_MODULE_FOR: Record<ImportKind, string> = {
  contacts: 'contacts', items: 'items', accounts: 'accounts', 'opening-ledger': 'opening-ledger',
  'opening-bills': 'opening-bills', journals: 'journals', invoices: 'invoices', bills: 'bills',
  estimates: 'estimates', 'sales-orders': 'sales-orders', 'credit-notes': 'credit-notes', 'purchase-orders': 'purchase-orders',
  expenses: 'expenses', 'payments-received': 'payments-received', 'payments-made': 'payments-made',
};

const NESTED = ['lines', 'items', 'entries', 'line_items'];

function flatten(rows: Obj[]): Obj[] {
  const out: Obj[] = [];
  for (const r of rows) {
    const nestedKey = NESTED.find((k) => Array.isArray(r[k]) && (r[k] as unknown[]).some(isObj));
    if (!nestedKey) {
      out.push(r);
      continue;
    }
    const head = Object.fromEntries(Object.entries(r).filter(([k]) => k !== nestedKey));
    for (const l of (r[nestedKey] as unknown[]).filter(isObj)) out.push({ ...head, ...l });
  }
  return out;
}

function pickRows(json: unknown, kind: ImportKind): Obj[] {
  if (Array.isArray(json)) return json.filter(isObj);
  if (!isObj(json)) throw new Error('The JSON file should hold a list of rows.');
  const exportKey = EXPORT_MODULE_FOR[kind];
  if (isObj(json.modules)) {
    const m = json.modules[exportKey];
    if (!Array.isArray(m)) throw new Error(`This backup has no ${TEMPLATES[kind].title.toLowerCase()}.`);
    return m.filter(isObj);
  }
  if (typeof json.module === 'string' && json.module !== exportKey && Array.isArray(json.rows)) {
    throw new Error(`This file is an export of ${json.module}, not ${TEMPLATES[kind].title.toLowerCase()}.`);
  }
  for (const key of ['rows', 'data', exportKey, kind]) {
    if (Array.isArray(json[key])) return (json[key] as unknown[]).filter(isObj);
  }
  throw new Error('No list of rows was found in the JSON file. Give an array, or { "rows": [ … ] }.');
}

const cell = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
};

/** The JSON as a grid: headings first, then one row per entry. */
export function jsonGrid(text: string, kind: ImportKind): string[][] {
  let json: unknown;
  try {
    json = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    throw new Error('That file is not valid JSON.');
  }
  const rows = flatten(pickRows(json, kind));
  const headings: string[] = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!headings.includes(k)) headings.push(k);
  return [headings, ...rows.map((r) => headings.map((h) => cell(r[h])))];
}

/** The template as JSON: one example row, keyed as the import reads it. */
export function templateJson(kind: ImportKind): Obj[] {
  return [Object.fromEntries(TEMPLATES[kind].columns.map((c) => [c.key, c.example]))];
}
