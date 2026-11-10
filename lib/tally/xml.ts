// ─────────────────────────────────────────────────────────────────────────────
// Reading the XML files TallyPrime (and Tally.ERP 9) export.
//
// Two kinds of file, and one upload may hold either or both:
//
//   masters    Export → Masters: groups, ledgers (with their opening balances
//              and unpaid bills), stock items, voucher types
//   vouchers   Export → Transactions (Day Book, or a register): each voucher
//              with its date, type, number, narration and ledger entries
//
// Shared by the server, which imports what is read, and the browser, which
// shows what a file holds before anything is saved. So nothing here touches
// a database, and nothing here needs Node.
//
// Tally writes a debit as a negative amount. Here, as everywhere in this app,
// a debit is positive.
// ─────────────────────────────────────────────────────────────────────────────

import { readTextFile } from '../delimited';

export interface TallyLedger {
  name: string;
  parent: string;
  /** Debit positive, in paise. */
  balancePaise: number;
  gstin: string | null;
  pan: string | null;
  stateName: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  pincode: string | null;
  creditDays: number | null;
  /** Unpaid bills, when the ledger is kept bill by bill. Debit positive. */
  bills: { ref: string; date: string | null; amountPaise: number; creditDays: number | null }[];
  /** What the account is called where it came from ("QuickBooks: Other Current Assets"), for its description here. */
  note?: string;
}

export interface TallyStockItem {
  name: string;
  unit: string | null;
  hsn: string | null;
  gstRatePct: number | null;
  qty: number;
  valuePaise: number;
  /** Tally's stock items are all goods; QuickBooks also lists services. */
  kind?: 'goods' | 'service';
  salePricePaise?: number | null;
  purchasePricePaise?: number | null;
}

export interface TallyMasters {
  groups: Map<string, string>;
  ledgers: TallyLedger[];
  stockItems: TallyStockItem[];
  /** A company's own voucher types ("GST Sales") and the type each is based on ("Sales"). */
  voucherTypes?: Map<string, string>;
}

export interface TallyFileLine {
  ledger: string;
  debitPaise: number;
  creditPaise: number;
}

export interface TallyFileVoucher {
  /** Tally's own id for the voucher, so a second import of the same file adds nothing. */
  guid: string;
  /** As named in the company: "GST Sales". */
  voucherType: string;
  /** The predefined type it is a kind of: "Sales". */
  baseType: string;
  number: string | null;
  /** ISO date. */
  date: string;
  narration: string | null;
  party: string | null;
  cancelled: boolean;
  optional: boolean;
  lines: TallyFileLine[];
}

export interface TallyFile {
  /** The company named in the file's header, when Tally wrote one. */
  company: string | null;
  masters: TallyMasters;
  vouchers: TallyFileVoucher[];
}

// ── The XML, read with patterns: Tally's files are regular, and large ───────

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export const unescapeXml = (s: string) =>
  s.replace(/&(amp|lt|gt|quot|apos);/g, (_, e: string) => ENT[e]).replace(/&#(\d+);/g, (_, n: string) => {
    const c = Number(n);
    return c < 32 && c !== 9 && c !== 10 && c !== 13 ? '' : String.fromCharCode(c);
  });

const esc = (name: string) => name.replace(/\./g, '\\.');
/** The text of the first <name> in a block, or null. */
export const tag = (block: string, name: string) => {
  const m = new RegExp(`<${esc(name)}(?:\\s[^>]*)?>([\\s\\S]*?)</${esc(name)}>`).exec(block);
  const v = m ? unescapeXml(m[1]).trim() : '';
  return v || null;
};
/** Every <name>…</name> in a block, with its attributes. */
export const blocks = (xml: string, name: string) => {
  const re = new RegExp(`<${esc(name)}(\\s[^>]*)?>([\\s\\S]*?)</${esc(name)}>`, 'g');
  const out: { attrs: string; body: string }[] = [];
  for (let m = re.exec(xml); m; m = re.exec(xml)) out.push({ attrs: m[1] ?? '', body: m[2] });
  return out;
};
const attr = (attrs: string, name: string) => {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs);
  return m ? unescapeXml(m[1]).trim() : null;
};
const nameAttr = (attrs: string, body: string) => (attr(attrs, 'NAME') ?? tag(body, 'NAME') ?? '').trim();

/** Tally's signed rupees, debits negative, as paise with debits positive. "1,180.00 Dr" reads too. */
export function debitPaise(value: string | null): number {
  if (!value) return 0;
  const n = Number(value.replace(/[^0-9.-]/g, ''));
  if (!Number.isFinite(n)) return 0;
  const p = -Math.round(n * 100);
  // A balance written with its side ("1,180.00 Dr") carries no sign of its own.
  if (/\bDr\b/i.test(value)) return Math.abs(p);
  if (/\bCr\b/i.test(value)) return -Math.abs(p);
  return p === 0 ? 0 : p;
}
/** "30 Days" → 30. */
const days = (v: string | null) => {
  const n = v ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : null;
};
/** 20260331 → 2026-03-31. */
export const tallyDate = (v: string | null) => (v && /^\d{8}$/.test(v) ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` : null);
const yes = (v: string | null) => /^yes$/i.test(v ?? '');

// ── Masters ──────────────────────────────────────────────────────────────────

export function parseTallyMastersXml(xml: string): TallyMasters {
  const groups = new Map<string, string>();
  for (const g of blocks(xml, 'GROUP')) groups.set(nameAttr(g.attrs, g.body), tag(g.body, 'PARENT') ?? '');

  const voucherTypes = new Map<string, string>();
  for (const t of blocks(xml, 'VOUCHERTYPE')) {
    const name = nameAttr(t.attrs, t.body);
    if (name) voucherTypes.set(name, tag(t.body, 'PARENT') ?? name);
  }

  const ledgers: TallyLedger[] = blocks(xml, 'LEDGER').map((l) => {
    const gstReg = blocks(l.body, 'LEDGSTREGDETAILS.LIST')[0]?.body ?? '';
    const mailing = blocks(l.body, 'LEDMAILINGDETAILS.LIST')[0]?.body ?? '';
    // Its own opening balance, not one of its bills': each bill carries an OPENINGBALANCE too.
    const mine = ownFields(l.body);
    const address = blocks(mailing || l.body, 'ADDRESS.LIST')
      .flatMap((a) => blocks(a.body, 'ADDRESS').map((x) => unescapeXml(x.body).trim()))
      .filter(Boolean).join(', ');
    return {
      name: nameAttr(l.attrs, l.body),
      parent: tag(mine, 'PARENT') ?? tag(l.body, 'PARENT') ?? '',
      balancePaise: debitPaise(tag(mine, 'OPENINGBALANCE')),
      gstin: (tag(gstReg, 'GSTIN') ?? tag(l.body, 'PARTYGSTIN'))?.toUpperCase() ?? null,
      pan: tag(l.body, 'INCOMETAXNUMBER')?.toUpperCase() ?? null,
      stateName: tag(mailing, 'STATE') ?? tag(l.body, 'LEDSTATENAME') ?? tag(gstReg, 'STATE'),
      email: tag(l.body, 'EMAIL'),
      phone: tag(l.body, 'LEDGERMOBILE') ?? tag(l.body, 'LEDGERPHONE'),
      address: address || null,
      pincode: tag(mailing, 'PINCODE') ?? tag(l.body, 'PINCODE'),
      creditDays: days(tag(l.body, 'BILLCREDITPERIOD')),
      bills: blocks(l.body, 'BILLALLOCATIONS.LIST').map((b) => ({
        ref: tag(b.body, 'NAME') ?? 'Opening',
        date: tallyDate(tag(b.body, 'BILLDATE')),
        amountPaise: debitPaise(tag(b.body, 'OPENINGBALANCE')),
        creditDays: days(tag(b.body, 'BILLCREDITPERIOD')),
      })).filter((b) => b.amountPaise !== 0),
    };
  }).filter((l) => l.name);

  const stockItems: TallyStockItem[] = blocks(xml, 'STOCKITEM').map((s) => {
    const gst = blocks(s.body, 'GSTDETAILS.LIST').map((g) => g.body).join('');
    const igst = blocks(gst, 'RATEDETAILS.LIST').find((r) => /IGST|Integrated/i.test(tag(r.body, 'GSTRATEDUTYHEAD') ?? ''));
    const qty = Number((tag(s.body, 'OPENINGBALANCE') ?? '').replace(/[^0-9.-]/g, '')) || 0;
    return {
      name: nameAttr(s.attrs, s.body),
      unit: tag(s.body, 'BASEUNITS'),
      hsn: tag(gst, 'HSNCODE') ?? tag(s.body, 'HSNCODE'),
      gstRatePct: igst ? Number(tag(igst.body, 'GSTRATE')) || null : null,
      qty: Math.abs(qty),
      // Stock is an asset: Tally writes its value as a debit, negative.
      valuePaise: Math.abs(debitPaise(tag(s.body, 'OPENINGVALUE'))),
    };
  }).filter((s) => s.name);

  return { groups, ledgers, stockItems, voucherTypes };
}

// ── Vouchers ─────────────────────────────────────────────────────────────────

/** The voucher types every Tally company starts with, in the order a name is matched against them. */
const BASE_TYPES: [RegExp, string][] = [
  [/credit\s*note/i, 'Credit Note'],
  [/debit\s*note/i, 'Debit Note'],
  [/sales?\s*order/i, 'Sales Order'],
  [/purchase\s*order/i, 'Purchase Order'],
  [/delivery\s*note/i, 'Delivery Note'],
  [/receipt\s*note/i, 'Receipt Note'],
  [/rejections?\s*in/i, 'Rejections In'],
  [/rejections?\s*out/i, 'Rejections Out'],
  [/stock\s*journal/i, 'Stock Journal'],
  [/physical\s*stock/i, 'Physical Stock'],
  [/memorandum/i, 'Memorandum'],
  [/reversing/i, 'Reversing Journal'],
  [/payroll/i, 'Payroll'],
  [/attendance/i, 'Attendance'],
  [/sales?|invoice/i, 'Sales'],
  [/purchase/i, 'Purchase'],
  [/receipt/i, 'Receipt'],
  [/payment/i, 'Payment'],
  [/contra/i, 'Contra'],
  [/journal/i, 'Journal'],
];

/** The predefined type a company's own type is based on: followed through the masters, else read from its name. */
export function baseTypeOf(name: string, voucherTypes?: Map<string, string>): string {
  let t = name;
  for (let i = 0; i < 10 && voucherTypes?.has(t) && voucherTypes.get(t) !== t; i++) t = voucherTypes.get(t)!;
  return BASE_TYPES.find(([re]) => re.test(t))?.[1] ?? t;
}

/** Types that move no money in the books: orders, notes of goods, stock and memo vouchers. */
export const NON_ACCOUNTING_TYPES = new Set([
  'Sales Order', 'Purchase Order', 'Delivery Note', 'Receipt Note', 'Rejections In', 'Rejections Out',
  'Stock Journal', 'Physical Stock', 'Memorandum', 'Reversing Journal', 'Attendance',
]);

/** A block without the .LIST blocks nested in it. */
function ownFields(body: string): string {
  let s = body;
  for (let prev = ''; prev !== s;) {
    prev = s;
    s = s.replace(/<([A-Z0-9.]+\.LIST)(\s[^>]*)?>[\s\S]*?<\/\1>/g, '');
  }
  return s;
}

/**
 * The ledger entries of a voucher: those on the voucher itself and, in an
 * invoice-mode voucher, the sales or purchase ledger each stock line is
 * allocated to — which Tally writes inside the inventory entry, not beside the
 * party's line.
 */
function voucherLines(body: string): TallyFileLine[] {
  const raw: { ledger: string; paise: number }[] = [];
  const take = (b: string) => {
    // The entry's own fields only: its bill, bank and cost-centre allocations carry amounts of their own.
    const mine = ownFields(b);
    const ledger = tag(mine, 'LEDGERNAME');
    const paise = debitPaise(tag(mine, 'AMOUNT'));
    if (ledger && paise) raw.push({ ledger, paise });
  };
  // Inventory first, and cut out, so its accounting allocations are not read twice.
  let rest = body;
  for (const name of ['ALLINVENTORYENTRIES.LIST', 'INVENTORYENTRIES.LIST', 'INVENTORYENTRIESIN.LIST', 'INVENTORYENTRIESOUT.LIST']) {
    for (const inv of blocks(rest, name)) for (const a of blocks(inv.body, 'ACCOUNTINGALLOCATIONS.LIST')) take(a.body);
    rest = rest.replace(new RegExp(`<${esc(name)}(\\s[^>]*)?>[\\s\\S]*?</${esc(name)}>`, 'g'), '');
  }
  for (const name of ['ALLLEDGERENTRIES.LIST', 'LEDGERENTRIES.LIST']) for (const e of blocks(rest, name)) take(e.body);
  // One line per ledger and side, as the journal keeps it.
  const merged = new Map<string, number>();
  for (const r of raw) merged.set(r.ledger, (merged.get(r.ledger) ?? 0) + r.paise);
  return [...merged].filter(([, p]) => p !== 0).map(([ledger, p]) => ({
    ledger, debitPaise: p > 0 ? p : 0, creditPaise: p < 0 ? -p : 0,
  }));
}

export function parseTallyVouchersXml(xml: string, voucherTypes?: Map<string, string>): TallyFileVoucher[] {
  const out: TallyFileVoucher[] = [];
  for (const v of blocks(xml, 'VOUCHER')) {
    const date = tallyDate(tag(v.body, 'DATE')) ?? tallyDate(tag(v.body, 'EFFECTIVEDATE'));
    if (!date) continue;
    const voucherType = tag(v.body, 'VOUCHERTYPENAME') ?? attr(v.attrs, 'VCHTYPE') ?? 'Journal';
    const number = tag(v.body, 'VOUCHERNUMBER');
    const guid = tag(v.body, 'GUID') ?? attr(v.attrs, 'REMOTEID') ?? attr(v.attrs, 'VCHKEY')
      ?? `${date}|${voucherType}|${number ?? ''}|${tag(v.body, 'MASTERID') ?? out.length}`;
    out.push({
      guid: guid.slice(0, 100),
      voucherType: voucherType.slice(0, 100),
      baseType: baseTypeOf(voucherType, voucherTypes),
      number: number?.slice(0, 100) ?? null,
      date,
      narration: tag(v.body, 'NARRATION'),
      party: tag(v.body, 'PARTYLEDGERNAME') ?? tag(v.body, 'PARTYNAME'),
      cancelled: yes(tag(v.body, 'ISCANCELLED')) || yes(tag(v.body, 'ISDELETED')),
      optional: yes(tag(v.body, 'ISOPTIONAL')),
      lines: voucherLines(v.body),
    });
  }
  return out;
}

/** Everything in one or more files: masters and vouchers together, whichever each holds. */
export function parseTallyFiles(xmls: string[]): TallyFile {
  const voucherTypes = new Map<string, string>();
  const masters: TallyMasters = { groups: new Map(), ledgers: [], stockItems: [], voucherTypes };
  const seenLedger = new Set<string>();
  const seenItem = new Set<string>();
  let company: string | null = null;
  const all = xmls.map((x) => ({ xml: x, m: parseTallyMastersXml(x) }));
  for (const { xml, m } of all) {
    company ??= tag(xml, 'SVCURRENTCOMPANY') ?? tag(xml, 'COMPANYNAME');
    for (const [k, v] of m.groups) masters.groups.set(k, v);
    for (const [k, v] of m.voucherTypes ?? []) voucherTypes.set(k, v);
    for (const l of m.ledgers) if (!seenLedger.has(l.name.toLowerCase())) { seenLedger.add(l.name.toLowerCase()); masters.ledgers.push(l); }
    for (const s of m.stockItems) if (!seenItem.has(s.name.toLowerCase())) { seenItem.add(s.name.toLowerCase()); masters.stockItems.push(s); }
  }
  const seenVoucher = new Set<string>();
  const vouchers: TallyFileVoucher[] = [];
  for (const { xml } of all) {
    for (const v of parseTallyVouchersXml(xml, voucherTypes)) {
      if (seenVoucher.has(v.guid)) continue;
      seenVoucher.add(v.guid);
      vouchers.push(v);
    }
  }
  vouchers.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { company, masters, vouchers };
}

// ── What a file holds, for the screen ───────────────────────────────────────

export interface TallyFileSummary {
  company: string | null;
  groups: number;
  ledgers: number;
  parties: number;
  stockItems: number;
  vouchers: number;
  /** Vouchers that post: not cancelled, not optional, not orders or memos, with entries that balance. */
  posting: number;
  cancelled: number;
  nonAccounting: number;
  unbalanced: number;
  from: string | null;
  to: string | null;
  byType: { type: string; count: number; amountPaise: number }[];
}

/** A voucher that posts to the books: what the importer will try to bring in. */
export function postsToBooks(v: TallyFileVoucher): boolean {
  if (v.cancelled || v.optional || NON_ACCOUNTING_TYPES.has(v.baseType) || !v.lines.length) return false;
  const dr = v.lines.reduce((t, l) => t + l.debitPaise, 0);
  const cr = v.lines.reduce((t, l) => t + l.creditPaise, 0);
  return dr > 0 && dr === cr;
}

export function summariseTallyFile(f: TallyFile): TallyFileSummary {
  const byType = new Map<string, { count: number; amountPaise: number }>();
  let cancelled = 0, nonAccounting = 0, unbalanced = 0, posting = 0;
  for (const v of f.vouchers) {
    if (v.cancelled || v.optional) { cancelled++; continue; }
    if (NON_ACCOUNTING_TYPES.has(v.baseType) || !v.lines.length) { nonAccounting++; continue; }
    if (!postsToBooks(v)) { unbalanced++; continue; }
    posting++;
    const at = byType.get(v.voucherType) ?? { count: 0, amountPaise: 0 };
    at.count++;
    at.amountPaise += v.lines.reduce((t, l) => t + l.debitPaise, 0);
    byType.set(v.voucherType, at);
  }
  const parties = f.masters.ledgers.filter((l) => {
    let g = l.parent;
    for (let i = 0; i < 30 && g; i++) {
      if (/^sundry (debtors|creditors)$/i.test(g)) return true;
      g = f.masters.groups.get(g) ?? '';
    }
    return false;
  }).length;
  return {
    company: f.company,
    groups: f.masters.groups.size,
    ledgers: f.masters.ledgers.length,
    parties,
    stockItems: f.masters.stockItems.length,
    vouchers: f.vouchers.length,
    posting, cancelled, nonAccounting, unbalanced,
    from: f.vouchers[0]?.date ?? null,
    to: f.vouchers.at(-1)?.date ?? null,
    byType: [...byType].map(([type, v]) => ({ type, ...v })).sort((a, b) => b.count - a.count),
  };
}

/** Tally writes its XML in UTF-16; a saved copy may be UTF-8. For the browser's file picker. */
export const readTallyFile = readTextFile;
