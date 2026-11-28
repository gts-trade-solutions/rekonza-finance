// ─────────────────────────────────────────────────────────────────────────────
// What an edit changed, field by field, old → new: the heart of the edit log.
//
// Rule 3(1) of the Companies (Accounts) Rules, 2014 (as amended from 1 April
// 2023) requires the books to be kept in software that records an audit trail
// of each and every transaction, "creating an edit log of each change made in
// the books of account along with the date when such changes were made". An
// edit log that says only "Edited INV/26-27/0007" does not show the change;
// the auditor has to see that line 1's rate went from 500 to 550, and that a
// setting went from Warn to Block.
//
// Services record edits in one of three shapes, from different eras of the
// code: a flat `changes` map ({ rate: { from, to } }); `changes: { before,
// after }` with two whole snapshots; or `before` and `after` at the top of the
// payload. This module turns all three into the flat map, so the screen and
// every export read one shape, and old rows written in the other shapes read
// correctly too. Document snapshots ({ invoice: {...}, lines: [...] }) are
// compared header field by header field and line by line ("line 1 · rate").
//
// No server-only imports: the audit writer, the export and the tests share it.
// ─────────────────────────────────────────────────────────────────────────────

export type Changes = Record<string, { from: unknown; to: unknown }>;

/**
 * Bookkeeping columns that move on every save without anyone changing them:
 * row ids (lines are written afresh on an edit), timestamps, the journal entry
 * an edit reposts, who saved it. Leaving them out keeps the log to what a
 * person changed.
 */
const NOISE = new Set([
  'id', 'org_id', 'created_by_user_id', 'updated_by_user_id', 'version', 'lock_version', 'row_version', 'hash', 'row_hash',
]);
const noise = (key: string) => NOISE.has(key) || /_at$/.test(key) || /(^|_)entry_id$/.test(key) || key === 'journalEntryId' || /At$/.test(key);

/** The part of a document snapshot that is its header: compared without a prefix. */
const WRAPPERS = new Set([
  'invoice', 'bill', 'entry', 'head', 'header', 'doc', 'document', 'payment', 'expense', 'note', 'order', 'receipt', 'record',
  'row', 'transfer', 'cheque', 'batch', 'adjustment', 'production', 'credit_note', 'vendor_credit', 'creditNote', 'vendorCredit',
  'purchase_order', 'goods_receipt', 'estimate', 'sales_order', 'challan', 'retainer',
]);

/** Sealed (encrypted) values are written afresh with a new IV each time: comparing them says nothing. */
const sealed = (v: unknown) => typeof v === 'string' && v.startsWith('enc:v1:');

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);

/** "cashLimit" → "cash limit"; "invoice_date" stays, the screen shows underscores as spaces. */
export function fieldLabel(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/\s+/g, ' ').toLowerCase();
}

/** One value as the log keeps it: decimals without trailing zeros, dates as dates. */
export function auditValue(v: unknown): unknown {
  if (v === undefined || v === null || v === '') return null;
  if (v instanceof Date) return isoDay(v.toISOString());
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    // DECIMAL columns come back as '500.0000'; the same figure typed is '500'.
    if (/^-?\d+\.\d+$/.test(v)) return String(Number(v));
    return isoDay(v);
  }
  return v;
}

/** A midnight ISO instant is a date column read through the driver: show the date. */
function isoDay(s: string): string {
  const m = s.match(/^(\d{4}-\d{2}-\d{2})T00:00:00(\.000)?Z$/);
  return m ? m[1] : s;
}

const same = (a: unknown, b: unknown) => {
  const x = auditValue(a);
  const y = auditValue(b);
  if (x === y) return true;
  if (x === null || y === null) return false;
  if (typeof x === 'object' || typeof y === 'object') return JSON.stringify(x) === JSON.stringify(y);
  // 1 and '1', true and 1: what a form sends and what the database returns.
  return String(x) === String(y) || (typeof x === 'boolean' || typeof y === 'boolean' ? Number(x) === Number(y) : false);
};

/** A line added or removed, in a few words: its item or description, quantity and rate. */
function lineSummary(line: Record<string, unknown>): string {
  const pick = (...keys: string[]) => keys.map((k) => line[k]).find((v) => v !== undefined && v !== null && v !== '');
  const what = pick('description', 'item_name', 'itemName', 'name', 'narration', 'account_name', 'accountName', 'item_id', 'itemId', 'account_id', 'accountId');
  const qty = pick('qty', 'quantity');
  const rate = pick('rate', 'unit_price', 'unitPrice', 'price');
  const amount = pick('amount', 'line_total', 'total', 'debit', 'credit');
  const parts = [what != null ? String(what) : null, qty != null ? `qty ${auditValue(qty)}` : null, rate != null ? `rate ${auditValue(rate)}` : null,
    rate == null && amount != null ? `amount ${auditValue(amount)}` : null].filter(Boolean);
  return parts.length ? parts.join(', ') : JSON.stringify(Object.fromEntries(Object.entries(line).filter(([k]) => !noise(k))));
}

const singular = (key: string) => {
  const k = fieldLabel(key);
  if (k === 'lines' || k.endsWith(' lines')) return k.replace(/lines$/, 'line');
  return k.endsWith('ies') ? `${k.slice(0, -3)}y` : k.endsWith('s') ? k.slice(0, -1) : k;
};

const MAX_FIELDS = 300;

/**
 * Every field that differs between two snapshots, by path: header fields by
 * name, lines as "line 2 · rate", nested settings as "controls · cash limit".
 * A line added or removed is one entry with the line in a few words.
 */
export function diffSnapshots(before: unknown, after: unknown): Changes {
  const out: Changes = {};
  const put = (path: string, from: unknown, to: unknown) => {
    if (Object.keys(out).length < MAX_FIELDS) out[path || 'value'] = { from: auditValue(from), to: auditValue(to) };
  };
  const walk = (a: unknown, b: unknown, path: string, depth: number) => {
    if (isPlainObject(a) && isPlainObject(b)) {
      for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])]) {
        if (noise(key)) continue;
        const flatten = depth === 0 && WRAPPERS.has(key) && (isPlainObject(a[key]) || isPlainObject(b[key]));
        walk(a[key], b[key], flatten ? path : path ? `${path} · ${fieldLabel(key)}` : fieldLabel(key), depth + 1);
      }
      return;
    }
    if (Array.isArray(a) || Array.isArray(b)) {
      const xs = Array.isArray(a) ? a : [];
      const ys = Array.isArray(b) ? b : [];
      const objects = [...xs, ...ys].some(isPlainObject);
      if (!objects) {
        if (JSON.stringify(xs.map(auditValue)) !== JSON.stringify(ys.map(auditValue))) put(path, xs.length ? xs.join(', ') : null, ys.length ? ys.join(', ') : null);
        return;
      }
      const name = singular(path.split(' · ').pop() || 'line');
      const prefix = path.includes(' · ') ? `${path.slice(0, path.lastIndexOf(' · '))} · ` : '';
      for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
        const label = `${prefix}${name} ${i + 1}`;
        const x = xs[i];
        const y = ys[i];
        if (x === undefined) put(`${label} (added)`, null, isPlainObject(y) ? lineSummary(y) : y);
        else if (y === undefined) put(`${label} (removed)`, isPlainObject(x) ? lineSummary(x) : x, null);
        else walk(x, y, label, depth + 1);
      }
      return;
    }
    if (sealed(a) || sealed(b)) return;
    if (!same(a, b)) put(path, a, b);
  };
  walk(before, after, '', 0);
  return out;
}

/** A flat change map: every value an object with `from` and `to`. */
function isChangeMap(v: unknown): v is Changes {
  return isPlainObject(v) && Object.keys(v).length > 0
    && Object.values(v).every((x) => isPlainObject(x) && 'from' in x && 'to' in x);
}

const parse = (payload: unknown): unknown => {
  if (typeof payload !== 'string') return payload;
  try { return JSON.parse(payload); } catch { return null; }
};

/**
 * The field-by-field changes an audit payload carries, whichever shape it was
 * written in; null when it carries none.
 */
export function changesOf(payload: unknown): Changes | null {
  const p = parse(payload);
  if (!isPlainObject(p)) return null;
  const c = p.changes;
  if (isChangeMap(c)) return c;
  // { changes: { before: {...}, after: {...} } }: two whole snapshots.
  if (isPlainObject(c) && ('before' in c || 'after' in c) && Object.keys(c).every((k) => k === 'before' || k === 'after')) {
    const d = diffSnapshots(c.before ?? {}, c.after ?? {});
    return Object.keys(d).length ? d : null;
  }
  // { before: {...}, after: {...} } at the top.
  if ('before' in p && 'after' in p && (p.before != null || p.after != null)) {
    const d = diffSnapshots(p.before ?? {}, p.after ?? {});
    return Object.keys(d).length ? d : null;
  }
  return null;
}

/**
 * The payload as the audit row stores it: whatever the caller gave, with the
 * flat `changes` map worked out from any before and after snapshots, so the
 * row says what changed on its own (and the hash chain seals that).
 */
export function normalizeAuditPayload(payload: unknown): unknown {
  if (!isPlainObject(payload)) return payload;
  if (isChangeMap(payload.changes)) return payload;
  const changes = changesOf(payload);
  if (!changes) return payload;
  const c = payload.changes;
  const rest = { ...payload };
  if (isPlainObject(c) && !isChangeMap(c)) {
    // The snapshots stay, under their own names; `changes` becomes the flat map.
    delete rest.changes;
    if (c.before !== undefined && rest.before === undefined) rest.before = c.before;
    if (c.after !== undefined && rest.after === undefined) rest.after = c.after;
  }
  return { ...rest, changes };
}
