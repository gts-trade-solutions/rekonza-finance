// ─────────────────────────────────────────────────────────────────────────────
// Reading what QuickBooks exports.
//
//   QuickBooks Desktop   File → Utilities → Export → Lists to IIF Files: an IIF
//                        file, tab-separated text whose "!ACCNT", "!CUST",
//                        "!VEND", "!INVITEM" rows head each list, and whose
//                        "!TRNS / !SPL / !ENDTRNS" rows hold transactions
//   QuickBooks Online    Settings → Export data, or a report's Export to Excel
//                        or CSV: the Account List, Customers, Vendors,
//                        Products and Services, and the Journal report
//
// Each file is handed over as rows of cells (the browser reads CSV, text and
// Excel alike into that), and what kind of list it is is told from its
// headings. The result is put in the same shapes a Tally file gives, so one
// importer — tested on Tally — brings both into the books: QuickBooks account
// types become the Tally groups that mean the same thing.
//
// Shared by the browser, to show what the files hold, and the server, to
// import them.
// ─────────────────────────────────────────────────────────────────────────────

import type { TallyFileVoucher, TallyLedger, TallyMasters, TallyStockItem } from '../tally/xml';

export interface QbFile { name: string; rows: string[][] }

export type QbDateOrder = 'auto' | 'dmy' | 'mdy';

export interface QbAccount { name: string; type: string; number: string | null; description: string | null; balancePaise: number | null; opening: boolean }
export interface QbParty {
  name: string; company: string | null; email: string | null; phone: string | null; address: string | null;
  state: string | null; pincode: string | null; gstin: string | null; pan: string | null; balancePaise: number | null;
}
export interface QbItem {
  name: string; kind: 'goods' | 'service'; description: string | null; salePricePaise: number | null;
  costPaise: number | null; hsn: string | null; qty: number; gstRatePct: number | null;
}
export interface QbLine { account: string; name: string | null; memo: string | null; debitPaise: number; creditPaise: number }
export interface QbTransaction { id: string; type: string; number: string | null; date: string; memo: string | null; lines: QbLine[] }

export interface QbData {
  accounts: QbAccount[];
  customers: QbParty[];
  vendors: QbParty[];
  items: QbItem[];
  transactions: QbTransaction[];
  /** Each file, and what it was read as. */
  files: { name: string; read: string }[];
  dateOrder: 'dmy' | 'mdy';
  /** True when no date in the files settled the order, and day-first (India's) was taken. */
  dateOrderAssumed: boolean;
  warnings: string[];
}

// ── Cells ────────────────────────────────────────────────────────────────────

const clean = (v: unknown) => (v === null || v === undefined ? '' : String(v)).replace(/^﻿/, '').trim();
const norm = (h: string) => clean(h).toLowerCase().replace(/[^a-z0-9/#]+/g, ' ').trim();
const orNull = (v: string) => (v ? v : null);

/** "₹1,23,456.50", "(1,200.00)", "1200-", "-1200", "1,200.00 Cr" → paise, signed as written. */
export function qbAmount(v: string): number | null {
  const s = clean(v);
  if (!s) return null;
  const negative = /^\(.*\)$/.test(s) || /-\s*$/.test(s) || /^-/.test(s.replace(/[^\d.\-(]/g, '')) || /\bcr\b/i.test(s);
  const digits = s.replace(/[^\d.]/g, '');
  if (!digits || !/\d/.test(digits)) return null;
  const n = Number(digits);
  if (!Number.isFinite(n)) return null;
  const p = Math.round(n * 100);
  return negative ? -p : p;
}

const DATE_PARTS = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/;
const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** Which way round the files write their dates: any day over 12 settles it. */
export function detectDateOrder(dates: string[]): { order: 'dmy' | 'mdy'; assumed: boolean } {
  let dmy = false;
  let mdy = false;
  for (const d of dates) {
    const m = DATE_PARTS.exec(clean(d));
    if (!m) continue;
    if (Number(m[1]) > 12) dmy = true;
    if (Number(m[2]) > 12) mdy = true;
  }
  if (dmy && !mdy) return { order: 'dmy', assumed: false };
  if (mdy && !dmy) return { order: 'mdy', assumed: false };
  return { order: 'dmy', assumed: true };
}

/** A date as QuickBooks writes it — 31/03/2026, 03/31/2026, 2026-03-31, 31-Mar-2026, 31 Mar 2026 — as ISO. */
export function qbDate(v: string, order: 'dmy' | 'mdy'): string | null {
  const s = clean(v);
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = DATE_PARTS.exec(s);
  const iso = (y: number, mo: number, d: number) => {
    if (y < 100) y += 2000;
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  };
  if (m) {
    const [a, b, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return order === 'dmy' ? iso(y, b, a) : iso(y, a, b);
  }
  const w = /^(\d{1,2})[\s-]([A-Za-z]{3})[A-Za-z]*[\s-,]+(\d{2,4})$/.exec(s) ?? null;
  if (w && MONTHS[w[2].toLowerCase()]) return iso(Number(w[3]), MONTHS[w[2].toLowerCase()], Number(w[1]));
  const u = /^([A-Za-z]{3})[A-Za-z]*\s+(\d{1,2}),?\s+(\d{4})$/.exec(s);
  if (u && MONTHS[u[1].toLowerCase()]) return iso(Number(u[3]), MONTHS[u[1].toLowerCase()], Number(u[2]));
  return null;
}

// ── IIF (QuickBooks Desktop) ─────────────────────────────────────────────────

function isIif(rows: string[][]): boolean {
  return rows.some((r) => /^!(ACCNT|CUST|VEND|INVITEM|TRNS|HDR|CLASS|OTHERNAME|EMP)$/i.test(clean(r[0])));
}

function readIif(rows: string[][], order: 'dmy' | 'mdy', out: QbData, file: string) {
  const heads = new Map<string, string[]>();
  let tx: QbTransaction | null = null;
  let seq = 0;
  const read: string[] = [];
  const get = (key: string, r: string[]) => {
    const h = heads.get(key) ?? [];
    return (col: string) => clean(r[h.indexOf(col)] ?? '');
  };
  const finish = () => { if (tx && tx.lines.length) out.transactions.push(tx); tx = null; };
  for (const r of rows) {
    const first = clean(r[0]);
    if (!first) continue;
    if (first.startsWith('!')) { heads.set(first.slice(1).toUpperCase(), r.map((c) => clean(c).toUpperCase())); continue; }
    const key = first.toUpperCase();
    const f = get(key, r);
    if (key === 'ACCNT') {
      const ob = qbAmount(f('OBAMOUNT'));
      out.accounts.push({ name: f('NAME'), type: f('ACCNTTYPE'), number: orNull(f('ACCNUM')), description: orNull(f('DESC')), balancePaise: ob, opening: true });
    } else if (key === 'CUST' || key === 'VEND') {
      const addr = ['ADDR1', 'ADDR2', 'ADDR3', 'ADDR4', 'ADDR5', 'BADDR1', 'BADDR2', 'BADDR3', 'BADDR4', 'BADDR5'].map(f).filter(Boolean);
      const party: QbParty = {
        name: f('NAME'), company: orNull(f('COMPANYNAME')), email: orNull(f('EMAIL')), phone: orNull(f('PHONE1')),
        address: addr.length ? [...new Set(addr)].join(', ') : null, state: null, pincode: null,
        gstin: orNull(f('GSTIN') || (/^\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/i.test(f('TAXID')) ? f('TAXID') : '')),
        pan: null, balancePaise: null,
      };
      if (party.name) (key === 'CUST' ? out.customers : out.vendors).push(party);
    } else if (key === 'INVITEM') {
      const type = f('INVITEMTYPE').toUpperCase();
      if (!f('NAME') || /^(GRP|DISC|PMT|STAX|COMPTAX|SUBT)$/.test(type)) continue;
      out.items.push({
        name: f('NAME'), kind: /^(INVENTORY|PART|ASSEMBLY|INVASSEMBLY)$/.test(type) ? 'goods' : type === 'NONINVENTORY' ? 'goods' : 'service',
        description: orNull(f('DESC')), salePricePaise: qbAmount(f('PRICE')), costPaise: qbAmount(f('COST')),
        hsn: orNull(f('HSN') || f('HSNCODE') || f('SACCODE')), qty: Math.abs(Number(f('QNTY')) || 0), gstRatePct: null,
      });
    } else if (key === 'TRNS') {
      finish();
      const date = qbDate(f('DATE'), order);
      if (!date) { out.warnings.push(`${file}: a transaction with the date "${f('DATE')}" was left out.`); continue; }
      const rawType = f('TRNSTYPE').toUpperCase() || 'GENERAL JOURNAL';
      tx = { id: `iif:${f('TRNSID') || `${date}|${rawType}|${f('DOCNUM')}|${seq++}`}`, type: IIF_TYPES[rawType] ?? rawType.charAt(0) + rawType.slice(1).toLowerCase(), number: orNull(f('DOCNUM')), date, memo: orNull(f('MEMO')), lines: [] };
      const amt = qbAmount(f('AMOUNT')) ?? 0;
      if (amt) tx.lines.push({ account: f('ACCNT'), name: orNull(f('NAME')), memo: orNull(f('MEMO')), debitPaise: Math.max(amt, 0), creditPaise: Math.max(-amt, 0) });
    } else if (key === 'SPL' && tx) {
      const amt = qbAmount(f('AMOUNT')) ?? 0;
      if (amt) tx.lines.push({ account: f('ACCNT'), name: orNull(f('NAME')), memo: orNull(f('MEMO')), debitPaise: Math.max(amt, 0), creditPaise: Math.max(-amt, 0) });
    } else if (key === 'ENDTRNS') {
      finish();
    }
    if (!read.includes(key)) read.push(key);
  }
  finish();
  out.files.push({ name: file, read: `QuickBooks IIF (${read.map((k) => IIF_NAMES[k] ?? k.toLowerCase()).filter(Boolean).join(', ') || 'nothing recognised'})` });
}

/** IIF transaction types as QuickBooks shows them on screen. */
const IIF_TYPES: Record<string, string> = {
  INVOICE: 'Invoice', BILL: 'Bill', BILLPMT: 'Bill Payment', PAYMENT: 'Payment', CHECK: 'Cheque', DEPOSIT: 'Deposit',
  TRANSFER: 'Transfer', 'GENERAL JOURNAL': 'Journal Entry', 'CREDIT MEMO': 'Credit Memo', 'CASH SALE': 'Sales Receipt',
  'BILL REFUND': 'Bill Refund', 'BILL CREDIT': 'Vendor Credit', 'CREDIT CARD': 'Credit Card Charge', 'CC CREDIT': 'Credit Card Credit',
  'ITEM RECEIPT': 'Item Receipt', 'INVENTORY ADJUST': 'Inventory Adjustment', 'SALES TAX PAYMENT': 'Tax Payment',
};

const IIF_NAMES: Record<string, string> = {
  ACCNT: 'accounts', CUST: 'customers', VEND: 'vendors', INVITEM: 'items', TRNS: 'transactions', SPL: '', ENDTRNS: '',
};

// ── QuickBooks Online lists and reports, from their headings ────────────────

type Kind = 'journal' | 'accounts' | 'customers' | 'vendors' | 'items';

/** Finds the headings row (reports open with a title, the company and the period) and says what the file is. */
function headings(rows: string[][]): { at: number; cols: string[]; kind: Kind } | null {
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const cols = rows[i].map(norm);
    const has = (...names: string[]) => names.some((n) => cols.includes(n));
    const starts = (...names: string[]) => cols.some((c) => names.some((n) => c.startsWith(n)));
    if (has('account', 'account name', 'account full name', 'split') && has('debit', 'debit inr', 'debit amount') && has('date', 'transaction date')) return { at: i, cols, kind: 'journal' };
    if (has('customer', 'customer name', 'customer full name', 'customer display name', 'display name as') && !has('vendor')) return { at: i, cols, kind: 'customers' };
    if (has('vendor', 'vendor name', 'supplier', 'supplier name', 'vendor display name')) return { at: i, cols, kind: 'vendors' };
    if (has('product/service', 'product/service name', 'product service', 'product service name', 'item', 'item name') && !has('debit')) return { at: i, cols, kind: 'items' };
    if (has('name') && has('type') && has('sales price/rate', 'sales price', 'price', 'rate', 'qty on hand', 'sku', 'income account', 'hsn/sac')) return { at: i, cols, kind: 'items' };
    if (has('account', 'full name', 'account name', 'name') && has('type', 'account type') && (has('detail type', 'balance', 'balance total', 'description', 'accnt #', 'number') || starts('detail'))) return { at: i, cols, kind: 'accounts' };
  }
  return null;
}

function readGrid(rows: string[][], order: 'dmy' | 'mdy', out: QbData, file: string) {
  const h = headings(rows);
  if (!h) { out.files.push({ name: file, read: 'not recognised' }); out.warnings.push(`${file}: its headings are not a QuickBooks list or the Journal report, so it was left out.`); return; }
  const col = (...names: string[]) => { for (const n of names) { const i = h.cols.indexOf(n); if (i >= 0) return i; } return -1; };
  const body = rows.slice(h.at + 1);
  const cell = (r: string[], i: number) => (i >= 0 ? clean(r[i]) : '');
  const isTotal = (r: string[]) => /^(total|grand total|net )/i.test(clean(r.find((c) => clean(c)) ?? ''));

  if (h.kind === 'journal') {
    const c = {
      date: col('date', 'transaction date'), type: col('transaction type', 'type'), num: col('num', 'no', 'no.', 'number', 'ref no', 'doc num'),
      name: col('name', 'customer/vendor', 'payee'), memo: col('memo/description', 'memo', 'description'),
      account: col('account', 'account name', 'account full name', 'split'), debit: col('debit', 'debit inr', 'debit amount'), credit: col('credit', 'credit inr', 'credit amount'),
    };
    let tx: QbTransaction | null = null;
    let txKey = '';
    let seq = 0;
    const balanced = (t: QbTransaction) => {
      const dr = t.lines.reduce((s, l) => s + l.debitPaise, 0);
      return dr > 0 && dr === t.lines.reduce((s, l) => s + l.creditPaise, 0);
    };
    const finish = () => { if (tx && tx.lines.length) out.transactions.push(tx); tx = null; };
    for (const r of body) {
      if (!r.some((x) => clean(x)) || isTotal(r)) continue;
      const rawDate = cell(r, c.date);
      const key = `${rawDate}|${cell(r, c.type)}|${cell(r, c.num)}`;
      if (rawDate && (!tx || txKey !== key || balanced(tx))) {
        finish();
        const date = qbDate(rawDate, order);
        if (!date) continue;
        txKey = key;
        tx = { id: `qbo:${key}#${seq++}`, type: cell(r, c.type) || 'Journal Entry', number: orNull(cell(r, c.num)), date, memo: orNull(cell(r, c.memo)), lines: [] };
      }
      const account = cell(r, c.account);
      if (!tx || !account) continue;
      const dr = qbAmount(cell(r, c.debit)) ?? 0;
      const cr = qbAmount(cell(r, c.credit)) ?? 0;
      // A negative debit is a credit, as some exports write a reversal.
      const net = dr - cr;
      if (net) tx.lines.push({ account, name: orNull(cell(r, c.name)), memo: orNull(cell(r, c.memo)), debitPaise: Math.max(net, 0), creditPaise: Math.max(-net, 0) });
    }
    finish();
    out.files.push({ name: file, read: 'QuickBooks Journal report (transactions)' });
    return;
  }

  if (h.kind === 'accounts') {
    const c = {
      name: col('full name', 'account', 'account name', 'name'), type: col('type', 'account type'), detail: col('detail type'),
      number: col('number', 'accnt #', 'account number', 'account #'), description: col('description'), balance: col('balance', 'balance total', 'qbo balance', 'bank balance'),
    };
    for (const r of body) {
      if (isTotal(r) || !cell(r, c.name)) continue;
      out.accounts.push({
        name: cell(r, c.name), type: cell(r, c.type) || cell(r, c.detail), number: orNull(cell(r, c.number)),
        description: orNull(cell(r, c.description)), balancePaise: qbAmount(cell(r, c.balance)), opening: false,
      });
    }
    out.files.push({ name: file, read: 'QuickBooks Account List (chart of accounts)' });
    return;
  }

  if (h.kind === 'customers' || h.kind === 'vendors') {
    const c = {
      name: h.kind === 'customers'
        ? col('customer', 'customer name', 'customer full name', 'customer display name', 'display name as')
        : col('vendor', 'vendor name', 'supplier', 'supplier name', 'vendor display name'),
      company: col('company', 'company name'), email: col('email', 'main email', 'email address'),
      phone: col('phone', 'phone numbers', 'phone number', 'mobile', 'main phone'),
      address: col('billing address', 'address', 'street address', 'billing street', 'bill to'),
      city: col('billing city', 'city'), state: col('billing state', 'state', 'state/province', 'place of supply'),
      pincode: col('billing zip', 'zip', 'pin code', 'pincode', 'postal code', 'billing zip code'),
      gstin: col('gstin', 'gst registration number', 'gst number', 'gstin/uin'), pan: col('pan', 'pan number', 'pan no'),
      balance: col('open balance', 'balance', 'opening balance', 'balance total'),
    };
    const list = h.kind === 'customers' ? out.customers : out.vendors;
    for (const r of body) {
      if (isTotal(r) || !cell(r, c.name)) continue;
      const address = [cell(r, c.address), cell(r, c.city)].filter(Boolean).join(', ');
      list.push({
        name: cell(r, c.name), company: orNull(cell(r, c.company)), email: orNull(cell(r, c.email)), phone: orNull(cell(r, c.phone)),
        address: orNull(address), state: orNull(cell(r, c.state)), pincode: orNull(cell(r, c.pincode).replace(/\D/g, '').slice(0, 6)),
        gstin: orNull(cell(r, c.gstin).toUpperCase()), pan: orNull(cell(r, c.pan).toUpperCase()), balancePaise: qbAmount(cell(r, c.balance)),
      });
    }
    out.files.push({ name: file, read: `QuickBooks ${h.kind === 'customers' ? 'Customer' : 'Vendor'} list` });
    return;
  }

  // Products and services.
  const c = {
    name: col('product/service name', 'product/service', 'product service name', 'product service', 'item name', 'item'),
    type: col('type', 'item type'), description: col('sales description', 'description', 'memo/description'),
    price: col('sales price/rate', 'sales price', 'price', 'rate', 'sales rate'), cost: col('purchase cost', 'cost', 'purchase price'),
    hsn: col('hsn/sac', 'hsn/sac code', 'hsn', 'sac', 'hsn code', 'sac code'), qty: col('qty on hand', 'quantity on hand', 'on hand', 'qty'),
    tax: col('sales tax', 'gst rate', 'tax rate', 'sales tax code'),
  };
  for (const r of body) {
    if (isTotal(r) || !cell(r, c.name)) continue;
    const type = cell(r, c.type).toLowerCase();
    const rate = /(\d+(\.\d+)?)\s*%/.exec(cell(r, c.tax));
    out.items.push({
      name: cell(r, c.name), kind: /service/.test(type) ? 'service' : 'goods', description: orNull(cell(r, c.description)),
      salePricePaise: qbAmount(cell(r, c.price)), costPaise: qbAmount(cell(r, c.cost)),
      hsn: orNull(cell(r, c.hsn).replace(/\D/g, '')), qty: Math.abs(Number(cell(r, c.qty).replace(/[^\d.-]/g, '')) || 0),
      gstRatePct: rate ? Number(rate[1]) : null,
    });
  }
  out.files.push({ name: file, read: 'QuickBooks Products and Services' });
}

/** Every file, read: IIF or Online, lists and transactions together. */
export function parseQuickBooks(files: QbFile[], order: QbDateOrder = 'auto'): QbData {
  const dates: string[] = [];
  for (const f of files) for (const r of f.rows.slice(0, 2000)) for (const c of r.slice(0, 8)) if (DATE_PARTS.test(clean(c))) dates.push(clean(c));
  const found = detectDateOrder(dates);
  const use = order === 'auto' ? found.order : order;
  const out: QbData = {
    accounts: [], customers: [], vendors: [], items: [], transactions: [], files: [],
    dateOrder: use, dateOrderAssumed: order === 'auto' && found.assumed, warnings: [],
  };
  for (const f of files) {
    if (isIif(f.rows)) readIif(f.rows, use, out, f.name);
    else readGrid(f.rows, use, out, f.name);
  }
  // A name listed twice (two files, or a list and the IIF) counts once.
  const once = <T extends { name: string }>(xs: T[]) => {
    const seen = new Set<string>();
    return xs.filter((x) => { const k = x.name.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
  };
  out.accounts = once(out.accounts);
  out.customers = once(out.customers);
  out.vendors = once(out.vendors);
  out.items = once(out.items);
  const ids = new Set<string>();
  out.transactions = out.transactions.filter((t) => (ids.has(t.id) ? false : (ids.add(t.id), true)));
  out.transactions.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return out;
}

// ── Into the importer's shapes ──────────────────────────────────────────────

/** A QuickBooks account type, as the Tally group that means the same; null for what parties or items carry. */
export function groupFor(type: string, name: string): string | null {
  const t = type.toLowerCase().replace(/[^a-z]/g, '');
  const n = name.toLowerCase();
  if (/receivable|^ar$/.test(t)) return null;
  if (/payable|^ap$/.test(t) && !/tax|gst/.test(n)) return null;
  if (/nonposting/.test(t)) return null;
  const pnl = /income|revenue|^inc$|^exinc$|expense|^exp$|^exexp$|costofgoodssold|^cogs$|costofsales/.test(t);
  if (!pnl && /gst|cgst|sgst|igst|utgst|cess|\btds\b|\btcs\b|vat|tax payable|tax receivable|input tax|output tax/.test(n)) return 'Duties & Taxes';
  if (/inventory ?asset|stock[ -]in[ -]hand|closing stock/.test(n)) return 'Stock-in-Hand';
  if (/^bank$/.test(t)) return /cash|petty|till/.test(n) && !/bank/.test(n) ? 'Cash-in-Hand' : 'Bank Accounts';
  if (/creditcard|^ccard$/.test(t)) return 'Current Liabilities';
  if (/fixedasset|^fixasset$/.test(t)) return 'Fixed Assets';
  if (/othercurrentasset|^ocasset$|otherasset|^oasset$|currentasset/.test(t)) return /cash|petty/.test(n) ? 'Cash-in-Hand' : 'Current Assets';
  if (/longtermliabilit|^ltliab$|noncurrentliabilit/.test(t)) return 'Loans (Liability)';
  if (/othercurrentliabilit|^ocliab$|currentliabilit|liabilit/.test(t)) return 'Current Liabilities';
  if (/equity/.test(t)) return /retained|profit/.test(n) ? 'Reserves & Surplus' : 'Capital Account';
  if (/costofgoodssold|^cogs$|costofsales/.test(t)) return 'Purchase Accounts';
  if (/otherincome|^exinc$/.test(t)) return 'Indirect Incomes';
  if (/income|revenue|^inc$/.test(t)) return 'Sales Accounts';
  if (/otherexpense|^exexp$|expense|^exp$/.test(t)) return 'Indirect Expenses';
  if (/asset/.test(t)) return 'Current Assets';
  return null;
}

/** Whether an account holds what customers owe or what is owed to vendors: from its type, else its name. */
function ledgerSide(account: string, types: Map<string, string>): 'debtor' | 'creditor' | null {
  const t = (types.get(account.toLowerCase()) ?? '').toLowerCase().replace(/[^a-z]/g, '');
  if (/receivable|^ar$/.test(t)) return 'debtor';
  if (/^ap$|accountspayable/.test(t)) return 'creditor';
  if (t) return null;
  const n = account.toLowerCase();
  if (/accounts receivable|\ba\/r\b|trade receivables|sundry debtors/.test(n)) return 'debtor';
  if (/(accounts payable|\ba\/p\b|trade payables|sundry creditors)/.test(n) && !/gst|tax|tds/.test(n)) return 'creditor';
  return null;
}

const BASE: [RegExp, string][] = [
  [/credit ?memo|refund|sales return/i, 'Credit Note'],
  [/vendor credit|bill credit|purchase return|supplier credit/i, 'Debit Note'],
  [/bill ?p(ay)?m(en)?t|bill payment/i, 'Payment'],
  [/estimate|sales order|purchase order|^po$/i, 'Sales Order'],
  [/invoice|sales receipt|cash sale/i, 'Sales'],
  [/^bill$|^bill /i, 'Purchase'],
  [/payment|deposit|receive/i, 'Receipt'],
  [/cheque|check|expense|cash purchase|credit card charge/i, 'Payment'],
  [/transfer/i, 'Contra'],
];

/** The importer's base type for a QuickBooks transaction type; a payment made is told from one received by its lines. */
function baseOf(t: QbTransaction, sides: (l: QbLine) => 'debtor' | 'creditor' | null): string {
  const hit = BASE.find(([re]) => re.test(t.type))?.[1] ?? 'Journal';
  if (hit === 'Receipt' && t.lines.some((l) => sides(l) === 'creditor' && l.debitPaise > 0)) return 'Payment';
  return hit;
}

export interface QbShapes { masters: TallyMasters; vouchers: TallyFileVoucher[]; partiesFromTransactions: number }

/**
 * QuickBooks' lists and transactions as the importer's ledgers and vouchers.
 * Balances on the lists become opening balances only when no transactions
 * come with them — otherwise the transactions would count the same money twice.
 * An IIF account's opening balance (OBAMOUNT) always does: it is one.
 */
export function toImportShapes(d: QbData): QbShapes {
  const types = new Map(d.accounts.map((a) => [a.name.toLowerCase(), a.type]));
  const withTx = d.transactions.length > 0;
  const ledgers: TallyLedger[] = [];
  const credit = (type: string) => /liabilit|equity|income|revenue|payable|^inc$|^exinc$|^ccard$|^ltliab$|^ocliab$|creditcard/i.test(type.replace(/\s/g, ''));
  const plain = (name: string, parent: string): TallyLedger => ({
    name, parent, balancePaise: 0, gstin: null, pan: null, stateName: null, email: null, phone: null, address: null, pincode: null, creditDays: null, bills: [],
  });

  for (const a of d.accounts) {
    const parent = groupFor(a.type, a.name);
    if (!parent || !a.name) continue;
    let balance = 0;
    if (a.balancePaise && (a.opening || !withTx)) {
      // The IIF writes a credit negative already; a list shows each balance on its normal side, unsigned.
      balance = a.opening ? a.balancePaise : credit(a.type) ? -a.balancePaise : a.balancePaise;
    }
    ledgers.push({ ...plain(a.name, parent), balancePaise: balance, note: `From QuickBooks: ${a.type}${a.number ? ` ${a.number}` : ''}${a.description ? ` — ${a.description}` : ''}`.slice(0, 250) });
  }
  const partyLedger = (p: QbParty, parent: 'Sundry Debtors' | 'Sundry Creditors'): TallyLedger => ({
    ...plain(p.name, parent),
    balancePaise: !withTx && p.balancePaise ? (parent === 'Sundry Debtors' ? p.balancePaise : -p.balancePaise) : 0,
    gstin: p.gstin, pan: p.pan, stateName: p.state, email: p.email, phone: p.phone, address: p.address, pincode: p.pincode,
  });
  for (const c of d.customers) ledgers.push(partyLedger(c, 'Sundry Debtors'));
  for (const v of d.vendors) ledgers.push(partyLedger(v, 'Sundry Creditors'));

  // A customer or vendor named only on a transaction still needs a ledger of their own.
  const known = new Set(ledgers.map((l) => l.name.toLowerCase()));
  const side = (l: QbLine) => ledgerSide(l.account, types);
  let partiesFromTransactions = 0;
  for (const t of d.transactions) {
    for (const l of t.lines) {
      const s = side(l);
      if (!s || !l.name || known.has(l.name.toLowerCase())) continue;
      known.add(l.name.toLowerCase());
      ledgers.push(plain(l.name, s === 'debtor' ? 'Sundry Debtors' : 'Sundry Creditors'));
      partiesFromTransactions++;
    }
  }

  const stockItems: TallyStockItem[] = d.items.map((i) => ({
    name: i.name, unit: null, hsn: i.hsn, gstRatePct: i.gstRatePct, kind: i.kind,
    // Stock on hand is an opening only with no transactions to move it.
    qty: !withTx && i.kind === 'goods' ? i.qty : 0,
    valuePaise: !withTx && i.kind === 'goods' && i.costPaise ? Math.round(i.qty * i.costPaise) : 0,
    salePricePaise: i.salePricePaise, purchasePricePaise: i.costPaise,
  }));

  const vouchers: TallyFileVoucher[] = d.transactions.map((t) => {
    const merged = new Map<string, number>();
    for (const l of t.lines) {
      // A receivable or payable line goes to the party; any other, to its account.
      const ledger = side(l) && l.name ? l.name : l.account;
      merged.set(ledger, (merged.get(ledger) ?? 0) + l.debitPaise - l.creditPaise);
    }
    return {
      guid: t.id.slice(0, 100), voucherType: t.type.slice(0, 100), baseType: baseOf(t, side), number: t.number?.slice(0, 100) ?? null,
      date: t.date, narration: t.memo, party: t.lines.find((l) => l.name)?.name ?? null, cancelled: false, optional: false,
      lines: [...merged].filter(([, p]) => p !== 0).map(([ledger, p]) => ({ ledger, debitPaise: Math.max(p, 0), creditPaise: Math.max(-p, 0) })),
    };
  });

  return { masters: { groups: new Map(), ledgers, stockItems, voucherTypes: new Map() }, vouchers, partiesFromTransactions };
}

// ── What the files hold, for the screen ─────────────────────────────────────

export interface QbSummary {
  files: { name: string; read: string }[];
  accounts: number; customers: number; vendors: number; items: number; transactions: number; posting: number;
  from: string | null; to: string | null;
  byType: { type: string; count: number; amountPaise: number }[];
  dateOrder: 'dmy' | 'mdy'; dateOrderAssumed: boolean;
  balancesUsed: boolean;
  warnings: string[];
}

export function summariseQuickBooks(d: QbData): QbSummary {
  const shapes = toImportShapes(d);
  const byType = new Map<string, { count: number; amountPaise: number }>();
  let posting = 0;
  for (const v of shapes.vouchers) {
    const dr = v.lines.reduce((s, l) => s + l.debitPaise, 0);
    const cr = v.lines.reduce((s, l) => s + l.creditPaise, 0);
    if (!(dr > 0 && dr === cr) || v.baseType === 'Sales Order') continue;
    posting++;
    const at = byType.get(v.voucherType) ?? { count: 0, amountPaise: 0 };
    at.count++;
    at.amountPaise += dr;
    byType.set(v.voucherType, at);
  }
  const warnings = [...d.warnings];
  const unbalanced = shapes.vouchers.length - posting;
  if (unbalanced > 0) warnings.push(`${unbalanced} transaction(s) do not balance or post nothing, so they will be left out.`);
  if (shapes.partiesFromTransactions) warnings.push(`${shapes.partiesFromTransactions} customer(s) or vendor(s) are named only on transactions; they will be added by name. Bring the customer and vendor lists for their details.`);
  return {
    files: d.files,
    accounts: d.accounts.filter((a) => groupFor(a.type, a.name)).length,
    customers: d.customers.length, vendors: d.vendors.length, items: d.items.length,
    transactions: d.transactions.length, posting,
    from: d.transactions[0]?.date ?? null, to: d.transactions.at(-1)?.date ?? null,
    byType: [...byType].map(([type, v]) => ({ type, ...v })).sort((a, b) => b.count - a.count),
    dateOrder: d.dateOrder, dateOrderAssumed: d.dateOrderAssumed,
    balancesUsed: d.transactions.length === 0,
    warnings,
  };
}

/** An IIF file as rows: tab-separated, a quoted field unquoted. */
export function iifRows(text: string): string[][] {
  return text.split(/\r?\n/).filter((l) => l.trim()).map((l) => l.split('\t').map((c) => c.replace(/^"(.*)"$/, '$1').replace(/""/g, '"')));
}
