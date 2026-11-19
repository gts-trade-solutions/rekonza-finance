// ─────────────────────────────────────────────────────────────────────────────
// TallyPrime's JSON (Data Exchange) export, read by turning it back into the
// XML it mirrors.
//
// Tally writes the same objects to JSON as to XML, field for field: the tag
// names in lower case, a ".LIST" collection as an array under the same name
// without ".LIST", an object's own attributes (its NAME, VCHTYPE, REMOTEID…)
// in a "metadata" object, and a typed list such as an address as
// [{ "metadata": true, "type": "String" }, "line 1", "line 2"]. Both of its
// styles ("Export in Plain Format" Yes or No) have that shape; the plain one
// leaves out empty fields.
//
//   { "tallymessage": [
//       { "metadata": { "type": "Ledger", "name": "HDFC Bank" },
//         "parent": "Bank Accounts", "openingbalance": "-151120.00", … },
//       { "metadata": { "type": "Voucher", "vchtype": "Sales", "remoteid": "…" },
//         "date": "20260801", "allinventoryentries": [ { "accountingallocations": [ … ] } ], … } ] }
//
// So the file is written back as Tally's XML and read by the reader the XML
// export already has (lib/tally/xml.ts): one reader, tested against Tally's
// own files, for both. Shared by the browser and the tests; no server code.
// ─────────────────────────────────────────────────────────────────────────────

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };
type Obj = { [k: string]: Json };

const isObj = (v: Json | undefined): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
/** The first element of a typed list: { "metadata": true, "type": "String" }. */
const isTypeMark = (v: Json | undefined): v is Obj => isObj(v) && v.metadata === true;

// Tally's text can hold control characters ("\u0004 Not Applicable" marks a
// value Tally fills in itself); XML cannot.
const clean = (s: string) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
const esc = (s: string) => clean(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const text = (v: Json): string => (typeof v === 'boolean' ? (v ? 'Yes' : 'No') : v === null ? '' : String(v));
const TAG = (k: string) => k.toUpperCase().replace(/[^A-Z0-9._]/g, '');

/** The messages in a parsed file, wherever Tally put them: at the top, or under an envelope. */
function messagesOf(root: Json, depth = 0): Obj[] | null {
  if (depth > 5 || !root || typeof root !== 'object') return null;
  if (Array.isArray(root)) return root.every((m) => isObj(m) && isObj(m.metadata)) && root.length ? (root as Obj[]) : null;
  for (const [k, v] of Object.entries(root)) {
    if (k.toLowerCase() === 'tallymessage') {
      if (Array.isArray(v)) return v.filter(isObj);
      if (isObj(v)) return [v];
    }
  }
  for (const v of Object.values(root)) {
    const found = messagesOf(v, depth + 1);
    if (found) return found;
  }
  return null;
}

/** Whether a text is Tally's JSON export: a parsed file with Tally's messages in it. */
export function isTallyJson(textIn: string): boolean {
  const head = textIn.replace(/^﻿/, '').trimStart();
  if (!head.startsWith('{') && !head.startsWith('[')) return false;
  if (!/"tallymessage"/i.test(head.slice(0, 4000)) && !/"metadata"\s*:\s*\{\s*"type"/i.test(head.slice(0, 4000))) return false;
  try {
    return !!messagesOf(JSON.parse(head) as Json)?.length;
  } catch {
    return false;
  }
}

/** A field and its value, as Tally writes it to XML. */
function field(key: string, v: Json): string {
  const T = TAG(key);
  if (!T || v === null || v === undefined) return '';
  if (Array.isArray(v)) {
    if (!v.length) return '';
    // A typed list of plain values: <ADDRESS.LIST TYPE="String"><ADDRESS>…</ADDRESS>…</ADDRESS.LIST>.
    if (isTypeMark(v[0])) {
      const type = typeof v[0].type === 'string' ? ` TYPE="${esc(v[0].type)}"` : '';
      return `<${T}.LIST${type}>${v.slice(1).map((x) => `<${T}>${esc(text(x))}</${T}>`).join('')}</${T}.LIST>`;
    }
    // A collection: each entry its own <NAME.LIST> block, as in Tally's XML.
    return v.map((x) => (isObj(x) ? `<${T}.LIST>${fields(x)}</${T}.LIST>` : `<${T}.LIST><${T}>${esc(text(x))}</${T}></${T}.LIST>`)).join('');
  }
  if (isObj(v)) {
    // A value with attributes: { "value": " Registration", "taxtype": "GST" }.
    if ('value' in v && Object.values(v).every((x) => !x || typeof x !== 'object')) {
      const attrs = Object.entries(v).filter(([k]) => k !== 'value').map(([k, x]) => ` ${TAG(k)}="${esc(text(x))}"`).join('');
      return `<${T}${attrs}>${esc(text(v.value))}</${T}>`;
    }
    return `<${T}>${fields(v)}</${T}>`;
  }
  return `<${T}>${esc(text(v))}</${T}>`;
}

function fields(o: Obj): string {
  let out = '';
  for (const [k, v] of Object.entries(o)) if (k !== 'metadata') out += field(k, v);
  return out;
}

/** One message: <LEDGER NAME="…">…</LEDGER>, its tag from its type ("Stock Item" → STOCKITEM). */
function message(m: Obj): string {
  const meta = isObj(m.metadata) ? m.metadata : {};
  const type = typeof meta.type === 'string' ? meta.type : '';
  const T = type.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  if (!T) return '';
  const attrs = Object.entries(meta)
    .filter(([k, v]) => k !== 'type' && v !== null && typeof v !== 'object')
    .map(([k, v]) => ` ${TAG(k)}="${esc(text(v))}"`).join('');
  return `<TALLYMESSAGE xmlns:UDF="TallyUDF"><${T}${attrs}>${fields(m)}</${T}></TALLYMESSAGE>`;
}

/**
 * Tally's JSON export as the XML export of the same data, for lib/tally/xml.
 * Throws when the text is not Tally's JSON.
 */
export function tallyJsonToXml(textIn: string): string {
  const root = JSON.parse(textIn.replace(/^﻿/, '')) as Json;
  const messages = messagesOf(root);
  if (!messages) throw new Error('This JSON file is not one Tally exported: it has no Tally masters or vouchers in it.');
  // The company, when the export names it in a header of its own.
  let company: string | null = null;
  const find = (o: Json, depth = 0): void => {
    if (company || depth > 4 || !o || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o)) {
      if (k.toLowerCase() === 'svcurrentcompany' && typeof v === 'string') { company = v; return; }
      if (k.toLowerCase() !== 'tallymessage') find(v as Json, depth + 1);
    }
  };
  find(root);
  return `<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME>` +
    `<STATICVARIABLES>${company ? `<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY>` : ''}</STATICVARIABLES></REQUESTDESC><REQUESTDATA>` +
    messages.map(message).join('\n') + '</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>';
}
