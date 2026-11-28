import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Importing masters and vouchers from a spreadsheet.
//
// Every row is checked and written inside one transaction, each row (or each
// document, for the kinds that group rows) behind its own savepoint, so a row
// that fails leaves nothing behind and the rows after it are checked as if it
// had never been there. Every failure is reported with its row number, the
// field and the reason ("Row 7, GSTIN: … fails the GSTIN check digit"), and a
// duplicate (of a record already in the books, or of an earlier row of the
// same file) is reported as one. The caller then keeps everything or nothing
// (mode 'all'), or keeps the rows that passed and skips the rest
// ('valid_only'). A check run does the same work and throws it away, which is
// the only way to be sure the real run will succeed: the rules a voucher has
// to pass are the posting rules, and a master's are the form's own
// (lib/validation/masters.ts).
//
// Rows use the column keys in lib/imports/templates.ts.
// ─────────────────────────────────────────────────────────────────────────────

import type { Trx } from '../db';
import type { Paise } from '../../types';
import { toSqlFromPaise } from '../money-sql';
import { postEntry, type DraftLine } from '../ledger/posting';
import { CODE } from '../ledger/chart-of-accounts';
import { GST_RATES, GST_STATES, stateFromAlpha } from '../../tax/gst';
import { TEMPLATES, type ImportKind } from '../../imports/templates';
import { createInvoice } from '../services/sales';
import { createBill, createExpense } from '../services/purchases';
import { createCreditNote, createEstimate, createSalesOrder } from '../services/sales-documents';
import { createPurchaseOrder } from '../services/purchase-documents';
import { applyPayment, makePayment, receivePayment, type PaymentMode } from '../services/payments';
import { toPaiseFromSql } from '../money-sql';
import { addOpeningDocument, setAccountOpenings } from '../services/opening-balances';
import { findBillDuplicates } from '../services/bill-duplicates';
import { sql } from 'kysely';
import { contactProblems, itemProblems, unitProblem, type FieldProblem } from '../../validation/masters';
import { checkHsnCode, type HsnDigits } from '../../tax/hsn';
import { getPolicies } from '../services/org-settings';

export type Row = Record<string, unknown>;

/** One row's problem: its line in the file, the field and what was in it, and why. */
export interface ImportRowError {
  row: number;
  message: string;
  field?: string;
  value?: string;
  /** A duplicate of a record already in the books, or of an earlier row of this file. */
  duplicate?: boolean;
}

export interface ImportOutcome {
  kind: ImportKind;
  /** What the screen calls this part, when its kind alone would not tell it apart (bank accounts beside accounts). */
  label?: string;
  rows: number;
  created: number;
  skipped: number;
  errors: ImportRowError[];
  notes: string[];
  /** Rows (or documents) that passed every check. */
  valid?: number;
  /** Rows refused or skipped as duplicates. */
  duplicates?: number;
  /** Rows left out as already in the books ("Skip Duplicates"), with why. */
  skippedRows?: ImportRowError[];
  /** What the import made, by table: the masters an undo can take away again. */
  createdIds?: Record<string, number[]>;
}

export interface ImportContext {
  orgId: number;
  userId: number | null;
  branchId: number;
  /** A party, item or account already in the books: leave it, or count it as an error. */
  onDuplicate: 'skip' | 'error';
  /**
   * A file of opening balances a person uploads has to balance (or name
   * Opening Balance Adjustments). Tally's and QuickBooks' trial balances leave
   * the parties and banks to their own imports, so they are not held to it.
   */
  requireBalancedOpenings?: boolean;
}

/** A row's failure: the message, and, where known, the field and its value. */
class RowError extends Error {
  constructor(message: string, readonly field?: string, readonly value?: string, readonly duplicate = false, readonly more: FieldProblem[] = []) { super(message); }
  line?: number;
}
const fail = (m: string, field?: string, value?: unknown): never => {
  throw new RowError(m, field, value === undefined ? undefined : str(value));
};
/** The same record again: already in the books, or on an earlier row of the file. */
const duplicate = (m: string, field?: string, value?: unknown): never => {
  throw new RowError(m, field, value === undefined ? undefined : str(value), true);
};
/** All of a row's problems from the shared rules (lib/validation/masters.ts), first one as the message. */
const failAll = (problems: FieldProblem[]) => {
  if (!problems.length) return;
  const [first, ...rest] = problems;
  throw new RowError(first.message, first.field, first.value ?? undefined, false, rest);
};

// ── Reading cells ────────────────────────────────────────────────────────────

const str = (v: unknown) => (v === null || v === undefined ? '' : String(v).trim());
const opt = (v: unknown) => str(v) || null;
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

function num(v: unknown, label: string): number | null {
  // Zoho and Excel write ₹1,200.00, Rs. 1200, INR 1200 or 18%.
  const s = str(v).replace(/^(?:rs\.?|inr)\s*/i, '').replace(/[₹,\s%]/g, '').replace(/(?:cr|dr)\.?$/i, '');
  if (!s) return null;
  // (1,000) and 1000- are how some exports write a negative.
  const n = Number(s.replace(/^\((.*)\)$/, '-$1').replace(/^([\d.]+)-$/, '-$1'));
  if (!Number.isFinite(n)) fail(`"${str(v)}" is not a number.`, label, v);
  return n;
}
const paise = (v: unknown, label: string) => {
  const n = num(v, label);
  return n === null ? null : Math.round(n * 100);
};

const MONTH_NO: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** yyyy-mm-dd, yyyy/mm/dd, dd-mm-yyyy, dd/mm/yyyy, dd.mm.yyyy, and Zoho's "15 Nov 2026" or "Nov 15, 2026". */
function date(v: unknown, label: string): string {
  // A spreadsheet date read as a timestamp ("2026-11-15T00:00:00.000Z") is its day.
  const s = str(v).replace(/T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z?$/, '');
  if (!s) fail(`${label} is missing.`, label, '');
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s);
  let y: number, mo: number, d: number;
  if (m) [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  else if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})$/.exec(s))) [d, mo, y] = [Number(m[1]), Number(m[2]), m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])];
  else if ((m = /^(\d{1,2})[\s\-/.]([A-Za-z]{3})[A-Za-z]*[\s\-/.,]+(\d{4}|\d{2})$/.exec(s)) && MONTH_NO[m[2].toLowerCase()]) [d, mo, y] = [Number(m[1]), MONTH_NO[m[2].toLowerCase()], m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])];
  else if ((m = /^([A-Za-z]{3})[A-Za-z]*\s+(\d{1,2}),?\s+(\d{4})$/.exec(s)) && MONTH_NO[m[1].toLowerCase()]) [d, mo, y] = [Number(m[2]), MONTH_NO[m[1].toLowerCase()], Number(m[3])];
  else return fail(`"${s}" is not a date. Use yyyy-mm-dd, dd-mm-yyyy or 15 Nov 2026.`, label, s);
  const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const back = new Date(`${iso}T00:00:00Z`);
  if (back.getUTCMonth() + 1 !== mo || back.getUTCDate() !== d) fail(`"${s}" is not a real date.`, label, s);
  return iso;
}

function yes(v: unknown): boolean | null {
  const s = str(v).toLowerCase();
  if (!s) return null;
  if (['yes', 'y', 'true', '1'].includes(s)) return true;
  if (['no', 'n', 'false', '0'].includes(s)) return false;
  return fail(`"${str(v)}" should be yes or no.`);
}

const STATE_BY_NAME = new Map(Object.entries(GST_STATES).map(([code, name]) => [name.toLowerCase().replace(/[^a-z]/g, ''), code]));
function state(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  if (/^\d{1,2}$/.test(s)) {
    const code = s.padStart(2, '0');
    if (!GST_STATES[code]) fail(`State code ${s} is not a GST state.`, 'State', s);
    return code;
  }
  // Zoho's place of supply: the state's two letters (TN), or "[TN] - Tamil Nadu".
  const bracket = /^\[?([A-Za-z]{2})\]?(\s*-\s*.*)?$/.exec(s);
  if (bracket) {
    const code = stateFromAlpha(bracket[1]);
    if (code) return code;
  }
  return STATE_BY_NAME.get(s.toLowerCase().replace(/[^a-z]/g, '').replace(/^the/, '')) ?? fail(`"${s}" is not a state name GST uses.`, 'State', s);
}

function gstRate(v: unknown): number | null {
  const n = num(v, 'GST rate');
  if (n === null) return null;
  if (!(GST_RATES as readonly number[]).includes(n)) fail(`${n}% is not a GST rate (${GST_RATES.join(', ')}).`, 'GST rate', v);
  return n;
}

// ── Lookups shared by the handlers ───────────────────────────────────────────

async function lookups(trx: Trx, orgId: number) {
  const [contacts, items, accounts, hsn, banks, home, policies] = await Promise.all([
    trx.selectFrom('contacts').select(['id', 'display_name', 'kind']).where('org_id', '=', orgId).execute(),
    trx.selectFrom('items').select(['id', 'name', 'sku']).where('org_id', '=', orgId).execute(),
    trx.selectFrom('accounts').select(['id', 'code', 'name']).where('org_id', '=', orgId).execute(),
    trx.selectFrom('hsn_codes').select(['code']).where('org_id', '=', orgId).execute(),
    trx.selectFrom('bank_accounts').select(['id', 'name']).where('org_id', '=', orgId).where('is_active', '=', 1).execute(),
    // The head office's state: where a party with no address on record is taken to be.
    trx.selectFrom('branches').select('state_code').where('org_id', '=', orgId).orderBy('is_primary', 'desc').orderBy('id').executeTakeFirst(),
    getPolicies(trx, orgId),
  ]);
  const key = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  return {
    contacts: new Map(contacts.map((c) => [key(c.display_name), c])),
    items: new Map(items.flatMap((i) => [[key(i.name), i] as const, ...(i.sku ? [[key(i.sku), i] as const] : [])])),
    accounts: new Map(accounts.map((a) => [a.code, a])),
    accountsByName: new Map(accounts.map((a) => [key(a.name), a])),
    banks: new Map(banks.map((b) => [key(b.name), b])),
    hsn: new Set(hsn.map((h) => h.code)),
    homeState: home?.state_code ?? null,
    key,
    /** The HSN digits the book prints (Settings → Items), as the item form checks them. */
    hsnDigits: policies.hsn.digits as HsnDigits,
    /** Units the book already uses: allowed, as the item form allows them. */
    units: new Set(items.length ? (await trx.selectFrom('items').select('uqc').distinct().where('org_id', '=', orgId).execute()).map((u) => String(u.uqc).toUpperCase()) : []),
    /** This file's own masters so far, for a name or code given twice: key → the row it was first on. */
    seen: new Map<string, number>(),
    /** The row being read, for the duplicate-in-file message. */
    row: 0,
    /** Why the row being read was left out as already in the books, for the preview. */
    skipReason: null as string | null,
    /** The field and value that matched the record already in the books, shown beside the reason. */
    skipField: null as string | null,
    skipValue: null as string | null,
    created: {} as Record<string, number[]>,
  };
}
type Lookups = Awaited<ReturnType<typeof lookups>>;

function party(l: Lookups, name: unknown, want: 'customer' | 'vendor', label: string) {
  const c = l.contacts.get(l.key(str(name)));
  if (!c) return fail(`"${str(name)}" is not one of your ${want}s. Add or import the ${want} first.`, label, name);
  if (c.kind !== want && c.kind !== 'both') fail(`"${c.display_name}" is set up as a ${c.kind}, not a ${want}.`, label, name);
  return c.id;
}

/** The same name or code on an earlier row of this file. */
function seenInFile(l: Lookups, what: string, key: string, field: string, value: string) {
  const first = l.seen.get(`${what}|${key}`);
  if (first !== undefined) duplicate(`"${value}" is already on row ${first} of this file.`, field, value);
  l.seen.set(`${what}|${key}`, l.row);
}
const track = (l: Lookups, table: string, id: number) => { (l.created[table] ??= []).push(id); };

/** An HSN or SAC code not yet on the approved list is added, so the line can use it. */
async function ensureHsn(trx: Trx, orgId: number, l: Lookups, code: string | null, rate: number | null, description: string, kind: 'goods' | 'service' | null = null) {
  if (!code) return;
  // As the item form checks it (lib/tax/hsn.ts): digits only, a length the
  // tariff uses, at least the digits the book prints, a SAC on a service.
  const check = checkHsnCode(code, { digits: l.hsnDigits, kind });
  if (!check.ok) fail(check.problem ?? `${code} is not an HSN or SAC code.`, 'HSN/SAC', code);
  if (l.hsn.has(code)) return;
  await trx.insertInto('hsn_codes').values({
    org_id: orgId, code, kind: code.startsWith('99') ? 'sac' : 'hsn',
    description: description.slice(0, 300) || code, gst_rate_pct: rate ?? 18, is_active: 1,
  }).execute();
  l.hsn.add(code);
}

// ── The handlers ─────────────────────────────────────────────────────────────

type Handler = (trx: Trx, ctx: ImportContext, l: Lookups, row: Row) => Promise<'created' | 'skipped'>;

const contacts: Handler = async (trx, ctx, l, r) => {
  const name = str(r.name) || fail('Name is missing.', 'Name', '');
  // Zoho writes Customer, Vendor; some lists say Supplier or Customer & Vendor.
  const raw = str(r.type).toLowerCase();
  const type = raw === 'supplier' ? 'vendor' : /customer.*(vendor|supplier)|both/.test(raw) ? 'both' : raw;
  if (!['customer', 'vendor', 'both'].includes(type)) fail(`"${str(r.type)}" should be customer, vendor or both.`, 'Type', r.type);
  seenInFile(l, 'contact', l.key(name), 'Name', name);
  if (l.contacts.has(l.key(name))) {
    l.skipReason = `"${name}" is already in your books: left as it is.`;
    l.skipField = 'Name'; l.skipValue = name;
    if (ctx.onDuplicate === 'skip') return 'skipped';
    duplicate(`"${name}" is already in your books.`, 'Name', name);
  }
  const gstin = opt(r.gstin)?.toUpperCase() ?? null;
  // No state and no GSTIN: an unregistered party with no address on record is in
  // the supplier's own state (IGST Act s.10(1)(d) and s.12(2)(b)), as Zoho assumes too.
  const st = state(r.state) ?? (gstin ? gstin.slice(0, 2) : null) ?? l.homeState ?? fail('Give the state, or a GSTIN.', 'State', '');
  const pan = opt(r.pan)?.toUpperCase() ?? (gstin && /^\d{2}[A-Z]{5}\d{4}[A-Z]/.test(gstin) ? gstin.slice(2, 12) : null);
  // Exactly the form's rules (app/api/contacts uses the same function): GSTIN
  // shape and check digit, its state against the state given, PAN, email,
  // phone and PIN code.
  failAll(contactProblems({
    gstin, pan, gstTreatment: gstin ? 'registered' : 'unregistered', stateCode: st, country: 'IN',
    email: opt(r.email), phone: opt(r.phone), pincode: opt(r.pincode),
  }));
  // The same GSTIN as a party already in the books is one party entered twice (the form refuses it too).
  if (gstin) {
    const twin = await trx.selectFrom('contacts').select('display_name').where('org_id', '=', ctx.orgId).where('gstin', '=', gstin).where('is_archived', '=', 0).executeTakeFirst();
    if (twin) duplicate(`${twin.display_name} already has GSTIN ${gstin}.`, 'GSTIN', gstin);
    seenInFile(l, 'gstin', gstin, 'GSTIN', gstin);
  }
  // Days, or Zoho's terms as written: "Net 30", "Due on Receipt".
  const terms = str(r.credit_days);
  const days = /due\s*on\s*receipt/i.test(terms) ? 0 : /net\s*(\d+)/i.test(terms) ? Number(/net\s*(\d+)/i.exec(terms)![1]) : num(r.credit_days, 'Credit days');
  const udyam = opt(r.msme_udyam_no)?.toUpperCase() ?? null;

  const id = Number((await trx.insertInto('contacts').values({
    org_id: ctx.orgId, kind: type as 'customer', display_name: name, legal_name: opt(r.legal_name),
    gstin, pan, state_code: st, gst_treatment: gstin ? 'registered' : 'unregistered',
    email: opt(r.email), phone: opt(r.phone), billing_address: opt(r.address), billing_city: opt(r.city),
    billing_pincode: opt(r.pincode), payment_terms: days === null ? null : days === 0 ? 'due_on_receipt' : `net_${days}`,
    is_msme: udyam ? 1 : 0, msme_udyam_no: udyam,
  }).executeTakeFirstOrThrow()).insertId);
  l.contacts.set(l.key(name), { id, display_name: name, kind: type as 'customer' });
  track(l, 'contacts', id);
  return 'created';
};

const items: Handler = async (trx, ctx, l, r) => {
  const name = str(r.name) || fail('Name is missing.', 'Name', '');
  seenInFile(l, 'item', l.key(name), 'Name', name);
  if (str(r.sku)) seenInFile(l, 'sku', l.key(str(r.sku)), 'SKU', str(r.sku));
  if (l.items.has(l.key(name))) {
    l.skipReason = `"${name}" is already in your items: left as it is.`;
    l.skipField = 'Name'; l.skipValue = name;
    if (ctx.onDuplicate === 'skip') return 'skipped';
    duplicate(`"${name}" is already in your items.`, 'Name', name);
  }
  if (str(r.sku) && l.items.has(l.key(str(r.sku)))) duplicate(`SKU ${str(r.sku)} is already on ${l.items.get(l.key(str(r.sku)))!.name}.`, 'SKU', r.sku);
  // Zoho's Product Type is goods or service; "services" and "Service" mean the same.
  const kind = (str(r.kind).toLowerCase().replace(/^services$/, 'service') || 'goods') as 'goods' | 'service';
  if (!['goods', 'service'].includes(kind)) fail(`"${str(r.kind)}" should be goods or service.`, 'Kind', r.kind);
  const rate = gstRate(r.gst_rate) ?? 18;
  const hsn = opt(r.hsn_sac);
  const purchase = paise(r.purchase_price, 'Purchase price') ?? 0;
  const sale = paise(r.sale_price, 'Sale price') ?? 0;
  const openingQty = num(r.opening_qty, 'Opening quantity');
  const openingRate = paise(r.opening_rate, 'Opening rate');
  // Exactly the item form's rules (lib/validation/masters.ts): the HSN as the
  // book's setting asks, a GST rate, a GST unit, no negative stock or price.
  failAll(itemProblems({ kind, hsnSac: hsn, unit: opt(r.unit), openingQty, salePricePaise: sale, purchasePricePaise: purchase },
    { hsnDigits: l.hsnDigits, knownUnits: l.units, gstRates: GST_RATES }));
  if (openingRate !== null && openingRate < 0) fail('An opening rate cannot be negative.', 'Opening rate', r.opening_rate);
  await ensureHsn(trx, ctx.orgId, l, hsn, rate, name, kind);
  const tracking = yes(r.track_stock) ?? kind === 'goods';
  if (openingQty && !tracking) fail('An item with opening stock has to track stock.', 'Track stock', r.track_stock);
  const unit = unitProblem(opt(r.unit), l.units).unit ?? (kind === 'service' ? 'OTH' : 'NOS');

  const sku = opt(r.sku);
  // Zoho's columns: the preferred vendor by name, the product codes, the purchase description.
  const vendor = str(r.preferred_vendor) ? party(l, r.preferred_vendor, 'vendor', 'Preferred vendor') : null;
  const codeOf = (v: unknown, max: number, label: string) => {
    const c = opt(v)?.toUpperCase() ?? null;
    if (c && c.length > max) fail(`${label} "${c}" is longer than ${max} characters.`);
    return c;
  };
  // The income and expense heads an item made by hand gets: Sales (Service
  // Income for a service) and Purchases.
  const head = (code: string) => l.accounts.get(code)?.id ?? null;
  const id = Number((await trx.insertInto('items').values({
    org_id: ctx.orgId, kind, name, sku, hsn_sac: hsn, uqc: unit,
    sale_price: toSqlFromPaise(sale), purchase_price: toSqlFromPaise(purchase),
    gst_rate_pct: rate, track_inventory: tracking ? 1 : 0,
    opening_stock_qty: openingQty ? String(openingQty) : null,
    opening_stock_rate: openingQty ? toSqlFromPaise(openingRate ?? purchase) : null,
    description: opt(r.description), purchase_description: opt(r.purchase_description),
    upc: codeOf(r.upc, 20, 'UPC'), ean: codeOf(r.ean, 20, 'EAN'), isbn: codeOf(r.isbn, 20, 'ISBN'), mpn: codeOf(r.mpn, 40, 'MPN'),
    preferred_vendor_id: vendor,
    sale_account_id: head(kind === 'service' ? CODE.SERVICE_INCOME : CODE.SALES), purchase_account_id: head(CODE.PURCHASES),
    created_source: 'import',
  }).executeTakeFirstOrThrow()).insertId);
  l.items.set(l.key(name), { id, name, sku });
  if (sku) l.items.set(l.key(sku), { id, name, sku });
  l.units.add(unit);
  track(l, 'items', id);
  return 'created';
};

const TYPES = ['asset', 'liability', 'equity', 'income', 'expense'] as const;
const accounts: Handler = async (trx, ctx, l, r) => {
  const code = str(r.code) || fail('Code is missing.', 'Code', '');
  if (!/^[0-9A-Za-z-]{1,20}$/.test(code)) fail(`"${code}" should be letters and digits only.`, 'Code', code);
  const name = str(r.name) || fail('Name is missing.', 'Name', '');
  seenInFile(l, 'account', code, 'Code', code);
  if (l.accounts.has(code)) {
    if (ctx.onDuplicate === 'skip') return 'skipped';
    duplicate(`Account ${code} already exists (${l.accounts.get(code)!.name}).`, 'Code', code);
  }
  if (l.accountsByName.has(l.key(name))) duplicate(`An account called "${name}" already exists (${l.accountsByName.get(l.key(name))!.code}).`, 'Name', name);
  const type = str(r.type).toLowerCase() as (typeof TYPES)[number];
  if (!TYPES.includes(type)) fail(`"${str(r.type)}" should be one of ${TYPES.join(', ')}.`, 'Type', r.type);
  const id = Number((await trx.insertInto('accounts').values({
    org_id: ctx.orgId, code, name, type, subtype: opt(r.subtype), description: opt(r.description),
  }).executeTakeFirstOrThrow()).insertId);
  l.accounts.set(code, { id, code, name });
  l.accountsByName.set(l.key(name), { id, code, name });
  track(l, 'accounts', id);
  return 'created';
};

const openingBills: Handler = async (trx, ctx, l, r) => {
  const type = str(r.type).toLowerCase();
  if (type !== 'receivable' && type !== 'payable') fail(`Type "${str(r.type)}" should be receivable or payable.`);
  const contactId = party(l, r.party, type === 'receivable' ? 'customer' : 'vendor', 'Party');
  const amount = paise(r.amount, 'Amount') ?? fail('Amount is missing.');
  const refNo = str(r.bill_no) || fail('Bill number is missing.');
  // A party's bill number is entered once (withdrawn ones included): the same
  // file brought in again, or a later Tally export, finds it already there.
  const there = await trx.selectFrom('opening_documents').select('status')
    .where('org_id', '=', ctx.orgId).where('contact_id', '=', contactId)
    .where('kind', '=', type as 'receivable').where('ref_no', '=', refNo.trim()).executeTakeFirst();
  if (there) {
    if (ctx.onDuplicate === 'skip') return 'skipped';
    fail(there.status === 'void'
      ? `${refNo} was entered for ${str(r.party)} before and withdrawn. Give it another bill number to enter it again.`
      : `${refNo} is already an opening bill for ${str(r.party)}.`);
  }
  await addOpeningDocument(trx, ctx.orgId, ctx.userId, {
    branchId: ctx.branchId, contactId, kind: type as 'receivable', refNo,
    docDate: date(r.bill_date, 'Bill date'), dueDate: date(r.due_date, 'Due date'), amountPaise: amount,
  });
  return 'created';
};

const bankOf = (l: Lookups, name: unknown, label: string) =>
  l.banks.get(l.key(str(name))) ?? fail(`"${str(name)}" is not one of your bank or cash accounts (Banking).`, label, name);

const expenses: Handler = async (trx, ctx, l, r) => {
  const ref = str(r.account_code);
  const acct = l.accounts.get(ref) ?? l.accountsByName.get(l.key(ref)) ?? fail(`Account ${ref} is not in your chart.`);
  const itc = (str(r.itc).toLowerCase() || 'eligible') as 'eligible' | 'ineligible' | 'capital_goods';
  if (!['eligible', 'ineligible', 'capital_goods'].includes(itc)) fail(`Input credit "${str(r.itc)}" should be eligible, ineligible or capital_goods.`);
  const customerId = str(r.customer) ? party(l, r.customer, 'customer', 'Billable to customer') : null;
  await createExpense(trx, ctx.orgId, ctx.userId, {
    branchId: ctx.branchId, date: date(r.date, 'Date'), accountId: acct.id, paidThroughBankAccountId: bankOf(l, r.paid_through, 'Paid through').id,
    amountPaise: paise(r.total, 'Amount paid') ?? fail('Amount paid is missing.'), gstRatePct: gstRate(r.gst_rate) ?? 0,
    vendorId: str(r.vendor) ? party(l, r.vendor, 'vendor', 'Vendor') : null, itcEligibility: itc,
    isBillable: !!customerId, billableCustomerId: customerId, reference: opt(r.reference), notes: opt(r.notes),
  });
  return 'created';
};

const MODES: PaymentMode[] = ['cash', 'cheque', 'neft', 'rtgs', 'imps', 'upi', 'card', 'netbanking', 'other'];
/** Zoho's and the banks' words for a mode: "Bank Transfer", "Net Banking", "Credit Card", "Check". */
const MODE_WORDS: Record<string, PaymentMode> = {
  banktransfer: 'neft', bank: 'neft', transfer: 'neft', netbanking: 'netbanking', internetbanking: 'netbanking', creditcard: 'card',
  debitcard: 'card', check: 'cheque', chq: 'cheque', dd: 'cheque', demanddraft: 'cheque', gpay: 'upi', phonepe: 'upi', paytm: 'upi', others: 'other',
};
const payment = (side: 'received' | 'made'): Handler => async (trx, ctx, l, r) => {
  const who = side === 'received' ? 'Customer' : 'Vendor';
  const contactId = party(l, side === 'received' ? r.customer : r.vendor, side === 'received' ? 'customer' : 'vendor', who);
  const word = str(r.mode).toLowerCase().replace(/[^a-z]/g, '');
  const mode = (word ? (MODES as string[]).includes(word) ? word : MODE_WORDS[word] : 'neft') as PaymentMode | undefined;
  if (!mode) fail(`"${str(r.mode)}" should be one of ${MODES.join(', ')}.`, 'Mode', r.mode);
  const amount = paise(r.amount, 'Amount') ?? fail('Amount is missing.', 'Amount', '');
  if (amount <= 0) fail('A payment is for more than zero.', 'Amount', r.amount);
  const tds = paise(r.tds, 'TDS') ?? 0;
  if (tds < 0) fail('TDS cannot be negative.', 'TDS', r.tds);
  const bank = bankOf(l, r.account, side === 'received' ? 'Deposited to' : 'Paid from');
  const day = date(r.date, 'Date');
  const ref = opt(r.reference);
  // The same payment already in the books (same party, day, amount and
  // reference): this file, or an earlier one, imported twice: left alone.
  const twin = await trx.selectFrom('payments').select(['id', 'number'])
    .where('org_id', '=', ctx.orgId).where('contact_id', '=', contactId).where('kind', '=', side)
    .where('payment_date', '=', day).where('amount', '=', toSqlFromPaise(amount as Paise))
    .$if(!!ref, (q) => q.where('reference', '=', ref!))
    .where('status', '!=', 'void')
    .executeTakeFirst();
  if (twin) {
    l.skipReason = `This ${side === 'received' ? 'receipt' : 'payment'} (${day}, ₹${(amount / 100).toLocaleString('en-IN')}${ref ? `, ${ref}` : ''}) is already in your books as ${twin.number}: left out, not entered twice.`;
    l.skipField = 'Reference'; l.skipValue = ref ?? '';
    if (ctx.onDuplicate === 'skip') return 'skipped';
    duplicate(`This ${side === 'received' ? 'receipt' : 'payment'} (${day}, ₹${(amount / 100).toLocaleString('en-IN')}${ref ? `, ${ref}` : ''}) is already in your books as ${twin.number}.`, 'Reference', ref ?? '');
  }
  // A bank reference (UTR, cheque number) is used once: the same one on
  // another payment of this party, or on an earlier row, is a duplicate.
  if (ref) {
    seenInFile(l, `payref-${side}`, `${contactId}|${ref.toUpperCase()}`, 'Reference', ref);
    const same = await trx.selectFrom('payments').select(['number', 'payment_date', 'amount'])
      .where('org_id', '=', ctx.orgId).where('contact_id', '=', contactId).where('kind', '=', side)
      .where('reference', '=', ref).where('status', '!=', 'void').executeTakeFirst();
    if (same) duplicate(`Reference ${ref} is already on ${same.number} of ${String(same.payment_date).slice(0, 10)} for ₹${(toPaiseFromSql(same.amount) / 100).toLocaleString('en-IN')}.`, 'Reference', ref);
  }
  // The invoices (or bills) it pays: one, or several separated by commas or
  // semicolons, settled in the order given. A bill is found by the supplier's
  // number or by ours.
  const allocations: { targetType: 'invoice' | 'bill'; targetId: number; amountPaise: number }[] = [];
  const docField = side === 'received' ? 'Invoice' : 'Bill';
  const docs = str(side === 'received' ? r.invoice : r.bill).split(/[;,]/).map((x) => x.trim()).filter(Boolean);
  let left = amount + tds;
  let owed = 0;
  for (const doc of docs) {
    const d = side === 'received'
      ? await trx.selectFrom('invoices').select(['id', 'number', 'total', 'amount_paid', 'status']).where('org_id', '=', ctx.orgId).where('customer_id', '=', contactId).where('number', '=', doc).executeTakeFirst()
      : await trx.selectFrom('bills').select(['id', 'internal_no as number', 'total', 'amount_paid', 'status']).where('org_id', '=', ctx.orgId).where('vendor_id', '=', contactId)
          .where((eb) => eb.or([eb('vendor_invoice_no', '=', doc), eb('internal_no', '=', doc)])).where('status', '!=', 'void').executeTakeFirst();
    if (!d) fail(`${docField} ${doc} is not one of ${str(side === 'received' ? r.customer : r.vendor)}'s.`, docField, doc);
    if (d!.status === 'void' || d!.status === 'draft') fail(`${docField} ${doc} is ${d!.status}: nothing can be paid on it.`, docField, doc);
    const open = toPaiseFromSql(d!.total) - toPaiseFromSql(d!.amount_paid);
    if (open <= 0) fail(`${docField} ${doc} is paid already.`, docField, doc);
    owed += open;
    const take = Math.min(open, left);
    if (take > 0) allocations.push({ targetType: side === 'received' ? 'invoice' : 'bill', targetId: d!.id, amountPaise: take });
    left -= take;
  }
  // More than the documents named still owe: refused, not quietly kept as an
  // advance, so the person sees the difference; leave the document blank for
  // money paid in advance.
  if (docs.length && left > 0) {
    fail(`₹${((amount + tds) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })} is more than the ₹${(owed / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })} still owed on ${docs.join(', ')}. ` +
      `Correct the amount, add the other ${side === 'received' ? 'invoices' : 'bills'}, or put the extra on its own row with no ${docField.toLowerCase()} (an advance).`, 'Amount', r.amount);
  }
  const input = {
    branchId: ctx.branchId, contactId, date: day, mode: mode!, amountPaise: amount,
    bankAccountId: bank.id, reference: ref,
    tdsPaise: tds, bankChargesPaise: paise(r.bank_charges, 'Bank charges') ?? 0, allocations, notes: opt(r.notes),
  };
  const made = await (side === 'received' ? receivePayment(trx, ctx.orgId, ctx.userId, input) : makePayment(trx, ctx.orgId, ctx.userId, input));
  track(l, 'payments', Number((made as { id: number }).id));
  return 'created';
};

/** A payment against a retainer invoice: received, posted, and applied to the retainer the row names. */
const retainerPayment: Handler = async (trx, ctx, l, r) => {
  const contactId = party(l, r.customer, 'customer', 'Customer');
  const number = str(r.retainer) || fail('Retainer invoice number is missing.');
  const ret = await trx.selectFrom('retainer_invoices').select(['id', 'status', 'amount', 'amount_paid'])
    .where('org_id', '=', ctx.orgId).where('customer_id', '=', contactId).where('number', '=', number).executeTakeFirst();
  if (!ret || ret.status === 'void') fail(`Retainer invoice ${number} is not one of theirs.`);
  const open = toPaiseFromSql(ret!.amount) - toPaiseFromSql(ret!.amount_paid);
  if (open <= 0) fail(`Retainer invoice ${number} is paid already.`);
  const amount = paise(r.amount, 'Amount') ?? fail('Amount is missing.');
  if (amount > open) fail(`Only ₹${(open / 100).toLocaleString('en-IN')} is still owed on ${number}.`);
  const word = str(r.mode).toLowerCase().replace(/[^a-z]/g, '');
  const mode = (word ? (MODES as string[]).includes(word) ? word : MODE_WORDS[word] : 'neft') as PaymentMode | undefined;
  if (!mode) fail(`Mode "${str(r.mode)}" should be one of ${MODES.join(', ')}.`);
  const day = date(r.date, 'Date');
  const ref = opt(r.reference);
  const twin = await trx.selectFrom('payment_allocations as a').innerJoin('payments as p', 'p.id', 'a.payment_id')
    .select('p.id').where('p.org_id', '=', ctx.orgId).where('a.target_type', '=', 'retainer').where('a.target_id', '=', ret!.id)
    .where('p.payment_date', '=', day).where('p.amount', '=', toSqlFromPaise(amount as Paise)).where('p.status', '!=', 'void').executeTakeFirst();
  if (twin) {
    if (ctx.onDuplicate === 'skip') return 'skipped';
    fail(`This payment on ${number} (${day}, ₹${(amount / 100).toLocaleString('en-IN')}) is already in your books.`);
  }
  await receivePayment(trx, ctx.orgId, ctx.userId, {
    branchId: ctx.branchId, contactId, date: day, mode: mode!, amountPaise: amount, bankAccountId: bankOf(l, r.account, 'Deposited to').id,
    reference: ref, allocations: [{ targetType: 'retainer', targetId: ret!.id, amountPaise: amount }], notes: opt(r.notes),
  });
  return 'created';
};

/** Money already received and left unused, set against an invoice: nothing new is posted for the money itself. */
const appliedExcess: Handler = async (trx, ctx, l, r) => {
  const contactId = party(l, r.customer, 'customer', 'Customer');
  const payNo = str(r.payment) || fail('Payment number is missing.');
  const invNo = str(r.invoice) || fail('Invoice number is missing.');
  const pay = await trx.selectFrom('payments').select(['id', 'status', 'unapplied_amount'])
    .where('org_id', '=', ctx.orgId).where('kind', '=', 'received').where('contact_id', '=', contactId).where('number', '=', payNo).executeTakeFirst();
  if (!pay || pay.status === 'void') fail(`Payment ${payNo} is not one of theirs.`);
  const inv = await trx.selectFrom('invoices').select(['id', 'status', 'total', 'amount_paid'])
    .where('org_id', '=', ctx.orgId).where('customer_id', '=', contactId).where('number', '=', invNo).executeTakeFirst();
  if (!inv || inv.status === 'void' || inv.status === 'draft') fail(`Invoice ${invNo} is not an open one of theirs.`);
  const amount = paise(r.amount, 'Amount applied') ?? fail('Amount applied is missing.');
  const unused = toPaiseFromSql(pay!.unapplied_amount);
  if (unused <= 0) {
    if (ctx.onDuplicate === 'skip') return 'skipped';
    fail(`Nothing of ${payNo} is left unused.`);
  }
  if (amount > unused) fail(`Only ₹${(unused / 100).toLocaleString('en-IN')} of ${payNo} is unused.`);
  const owing = toPaiseFromSql(inv!.total) - toPaiseFromSql(inv!.amount_paid);
  if (amount > owing) fail(`Only ₹${(owing / 100).toLocaleString('en-IN')} is still owed on ${invNo}.`);
  await applyPayment(trx, ctx.orgId, ctx.userId, pay!.id, { date: date(r.date, 'Date applied'), allocations: [{ targetType: 'invoice', targetId: inv!.id, amountPaise: amount }] });
  return 'created';
};

const HANDLERS: Partial<Record<ImportKind, Handler>> = {
  contacts, items, accounts, 'opening-bills': openingBills, expenses, 'payments-received': payment('received'), 'payments-made': payment('made'),
  'retainer-payments': retainerPayment, 'applied-excess-payments': appliedExcess,
};

// ── Grouped kinds: one document from several rows ────────────────────────────

type GroupHandler = (trx: Trx, ctx: ImportContext, l: Lookups, rows: Row[]) => Promise<void | 'skipped'>;

const journals: GroupHandler = async (trx, ctx, l, rows) => {
  const when = date(rows[0].date, 'Date');
  if (rows.some((r) => str(r.date) && date(r.date, 'Date') !== when)) fail('Every line of a voucher needs the same date.');
  const control = new Set([CODE.AR, CODE.AP] as string[]);
  const lines: DraftLine[] = rows.map((r) => {
    const code = str(r.account_code) || fail('Account code is missing.');
    // A code, or the account's name as Zoho's exports give it.
    const acct = l.accounts.get(code) ?? l.accountsByName.get(l.key(code)) ?? fail(`Account ${code} is not in your chart.`);
    const dr = paise(r.debit, 'Debit') ?? 0;
    const cr = paise(r.credit, 'Credit') ?? 0;
    if ((dr > 0) === (cr > 0)) fail(`Account ${code}: give a debit or a credit, not both or neither.`);
    let contactId: number | null = null;
    if (str(r.party)) {
      const c = l.contacts.get(l.key(str(r.party))) ?? fail(`Party "${str(r.party)}" is not in your books.`);
      contactId = c.id;
    } else if (control.has(code)) {
      fail(`Account ${code} is a receivable or payable: name the party on the line.`);
    }
    return { accountId: acct.id, debit: dr, credit: cr, contactId, description: opt(r.narration) };
  });
  await postEntry(trx, {
    orgId: ctx.orgId, branchId: ctx.branchId, date: when,
    memo: str(rows[0].narration) || `Imported voucher ${str(rows[0].voucher_no)}`,
    sourceType: 'manual', userId: ctx.userId, module: 'accountant', lines,
  });
};

const lineOf = async (trx: Trx, ctx: ImportContext, l: Lookups, r: Row) => {
  try {
    const item = str(r.item) ? (l.items.get(l.key(str(r.item))) ?? fail(`"${str(r.item)}" is not in your items. Add or import the item first.`, 'Item', r.item)) : null;
    const description = opt(r.description);
    if (!item && !description) fail('Give an item or a description.', 'Item', '');
    const rate = gstRate(r.gst_rate);
    const hsn = opt(r.hsn_sac);
    await ensureHsn(trx, ctx.orgId, l, hsn, rate, description ?? item?.name ?? '');
    const qty = num(r.qty, 'Quantity') ?? fail('Quantity is missing.', 'Quantity', '');
    if (qty <= 0) fail(`${qty} is not a quantity: it has to be more than zero (a return goes on a credit note).`, 'Quantity', r.qty);
    const ratePaise = paise(r.rate, 'Rate') ?? fail('Rate is missing.', 'Rate', '');
    if (ratePaise < 0) fail('A rate cannot be negative.', 'Rate', r.rate);
    const discountPct = num(r.discount_pct, 'Discount %') ?? undefined;
    if (discountPct !== undefined && (discountPct < 0 || discountPct > 100)) fail(`${discountPct}% is not a discount: give 0 to 100.`, 'Discount %', r.discount_pct);
    return { itemId: item?.id ?? null, description, hsnSac: hsn, qty, ratePaise, discountPct, gstRatePct: rate ?? undefined };
  } catch (err) {
    // A document's line names its own row, not the document's first one.
    if (err instanceof RowError && err.line === undefined) err.line = Number(r.__line) || undefined;
    throw err;
  }
};

const invoices: GroupHandler = async (trx, ctx, l, rows) => {
  const when = date(rows[0].date, 'Date');
  const lines = [];
  for (const r of rows) lines.push(await lineOf(trx, ctx, l, r));
  await createInvoice(trx, ctx.orgId, ctx.userId, {
    branchId: ctx.branchId, customerId: party(l, rows[0].customer, 'customer', 'Customer'),
    number: str(rows[0].invoice_no), date: when, dueDate: str(rows[0].due_date) ? date(rows[0].due_date, 'Due date') : when,
    status: 'approved', lines,
    // An export comes in as it was billed: IGST paid when the sheet says so, nil otherwise.
    exportAsBilled: /^(paid|igst|with)/i.test(str(rows[0].export_igst)),
  });
};

const bills: GroupHandler = async (trx, ctx, l, rows) => {
  const when = date(rows[0].date, 'Date');
  // The supplier's bill already in the books: left alone ("Skip Duplicates"), or named.
  const vendorId = party(l, rows[0].vendor, 'vendor', 'Vendor');
  const twin = (await findBillDuplicates(trx, ctx.orgId, { vendorId, vendorInvoiceNo: str(rows[0].bill_no) })).exact;
  if (twin) {
    l.skipReason = `${str(rows[0].bill_no)} from ${str(rows[0].vendor)} is already in your books as ${twin.internalNo}, dated ${twin.date} (${twin.why}): left out, not entered twice.`;
    l.skipField = "Supplier's bill number"; l.skipValue = str(rows[0].bill_no);
    if (ctx.onDuplicate === 'skip') return 'skipped';
    duplicate(`already in your books as ${twin.internalNo}, dated ${twin.date} (${twin.why}).`, "Supplier's bill number", rows[0].bill_no);
  }
  const lines = [];
  for (const r of rows) lines.push(await lineOf(trx, ctx, l, r));
  await createBill(trx, ctx.orgId, ctx.userId, {
    branchId: ctx.branchId, vendorId,
    vendorInvoiceNo: str(rows[0].bill_no), date: when,
    dueDate: str(rows[0].due_date) ? date(rows[0].due_date, 'Due date') : when, status: 'open', lines,
    // A look-alike of another bill is imported only with the file's reason (services/bill-duplicates.ts).
    duplicateReason: opt(rows[0].duplicate_reason),
  });
};

const linesOf = async (trx: Trx, ctx: ImportContext, l: Lookups, rows: Row[]) => {
  const lines = [];
  for (const r of rows) lines.push(await lineOf(trx, ctx, l, r));
  return lines;
};

const estimates: GroupHandler = async (trx, ctx, l, rows) => {
  const when = date(rows[0].date, 'Date');
  const until = str(rows[0].expiry_date) ? date(rows[0].expiry_date, 'Valid until') : addDays(when, 30);
  if (until < when) fail('A quote is valid until a date after its own.');
  await createEstimate(trx, ctx.orgId, ctx.userId, {
    branchId: ctx.branchId, customerId: party(l, rows[0].customer, 'customer', 'Customer'),
    number: str(rows[0].number), date: when, expiryDate: until, status: 'sent', lines: await linesOf(trx, ctx, l, rows),
  });
};

const salesOrders: GroupHandler = async (trx, ctx, l, rows) => {
  await createSalesOrder(trx, ctx.orgId, ctx.userId, {
    branchId: ctx.branchId, customerId: party(l, rows[0].customer, 'customer', 'Customer'), number: str(rows[0].number),
    date: date(rows[0].date, 'Date'), expectedShipDate: str(rows[0].expected_ship_date) ? date(rows[0].expected_ship_date, 'Expected shipment') : null,
    lines: await linesOf(trx, ctx, l, rows),
  });
};

const creditNotes: GroupHandler = async (trx, ctx, l, rows) => {
  const customerId = party(l, rows[0].customer, 'customer', 'Customer');
  let againstInvoiceId: number | null = null;
  if (str(rows[0].against_invoice)) {
    const inv = await trx.selectFrom('invoices').select(['id', 'customer_id']).where('org_id', '=', ctx.orgId).where('number', '=', str(rows[0].against_invoice)).executeTakeFirst();
    if (!inv) fail(`Invoice ${str(rows[0].against_invoice)} is not in your books.`);
    if (inv!.customer_id !== customerId) fail(`Invoice ${str(rows[0].against_invoice)} is another customer's.`);
    againstInvoiceId = inv!.id;
  }
  await createCreditNote(trx, ctx.orgId, ctx.userId, {
    branchId: ctx.branchId, customerId, number: str(rows[0].number), date: date(rows[0].date, 'Date'),
    reason: str(rows[0].reason) || fail('Reason is missing.'), againstInvoiceId, lines: await linesOf(trx, ctx, l, rows),
  });
};

const purchaseOrders: GroupHandler = async (trx, ctx, l, rows) => {
  await createPurchaseOrder(trx, ctx.orgId, ctx.userId, {
    branchId: ctx.branchId, vendorId: party(l, rows[0].vendor, 'vendor', 'Vendor'), number: str(rows[0].number),
    date: date(rows[0].date, 'Date'), expectedDate: str(rows[0].expected_date) ? date(rows[0].expected_date, 'Expected') : null,
    status: 'open', lines: await linesOf(trx, ctx, l, rows),
  });
};

const GROUPED: Partial<Record<ImportKind, GroupHandler>> = {
  journals, invoices, bills, estimates, 'sales-orders': salesOrders, 'credit-notes': creditNotes, 'purchase-orders': purchaseOrders,
};

/** A failure as the rows the screen lists: the row's own problem, and any more the shared rules found. */
function errorsOf(err: unknown, row: number): ImportRowError[] {
  if (err instanceof RowError) {
    const at = err.line ?? row;
    return [
      { row: at, message: err.message, ...(err.field ? { field: err.field } : {}), ...(err.value !== undefined ? { value: err.value } : {}), ...(err.duplicate ? { duplicate: true } : {}) },
      ...err.more.map((p) => ({ row: at, message: p.message, field: p.field, ...(p.value ? { value: p.value } : {}) })),
    ];
  }
  const code = (err as { code?: string })?.code;
  if (code === 'duplicate_bill' || code === 'possible_duplicate') {
    return [{ row, message: messageOf(err), field: "Supplier's bill number", duplicate: true }];
  }
  return [{ row, message: messageOf(err) }];
}

function messageOf(err: unknown): string {
  if (err instanceof RowError) return err.message;
  const e = err as { message?: string; code?: string; issues?: { message: string }[] };
  if (e?.code === 'ER_DUP_ENTRY') return 'That number is already used.';
  if (e?.issues?.length) return e.issues.map((i) => i.message).join(' ');
  return e?.message ?? String(err);
}

/**
 * Import `rows` of one kind. Writes as it goes; the caller decides, from the
 * errors and whether this was a check, to keep the transaction or drop it.
 */
export async function runImport(trx: Trx, ctx: ImportContext, kind: ImportKind, rows: Row[]): Promise<ImportOutcome> {
  const out: ImportOutcome = { kind, rows: rows.length, created: 0, skipped: 0, errors: [], notes: [], valid: 0, duplicates: 0, skippedRows: [], createdIds: {} };
  const t = TEMPLATES[kind];
  // The file's own line number, as the import screen sends it (it skips blank
  // lines and any title rows above the headings); else the heading is row 1.
  const rowNo = (i: number) => {
    const line = Number(rows[i]?.__line);
    return Number.isInteger(line) && line > 0 ? line : i + 2;
  };

  // A mandatory field left empty fails its row (and the document it is part of).
  const blank = new Set<number>();
  rows.forEach((r, i) => {
    for (const c of t.columns) {
      if (c.required && !str(r[c.key])) { out.errors.push({ row: rowNo(i), field: c.label, value: '', message: `${c.label} is missing: it is a mandatory field.` }); blank.add(i); }
    }
  });

  const l = await lookups(trx, ctx.orgId);
  // Each row (or document) behind its own savepoint: one that fails leaves
  // nothing, so the rows after it are checked against the books as they are.
  let n = 0;
  const attempt = async (row: number, fn: () => Promise<'created' | 'skipped' | void>, label?: string) => {
    const sp = sql.raw(`imp_${++n}`);
    await sql`SAVEPOINT ${sp}`.execute(trx);
    l.row = row;
    l.skipReason = null; l.skipField = null; l.skipValue = null;
    try {
      const r = await fn();
      await sql`RELEASE SAVEPOINT ${sp}`.execute(trx);
      if (r === 'skipped') {
        out.skipped++;
        out.duplicates!++;
        out.skippedRows!.push({ row, ...(l.skipField ? { field: l.skipField, value: l.skipValue ?? '' } : {}), message: l.skipReason ?? 'Already in your books: left out, not entered twice.', duplicate: true });
      } else { out.created++; out.valid!++; }
    } catch (err) {
      await sql`ROLLBACK TO SAVEPOINT ${sp}`.execute(trx);
      const errs = errorsOf(err, row).map((e) => (label ? { ...e, message: `${label}: ${e.message}` } : e));
      if (errs.some((e) => e.duplicate)) out.duplicates!++;
      out.errors.push(...errs);
    }
  };

  if (kind === 'opening-ledger') {
    const lines: { accountId: number; netPaise: Paise }[] = [];
    let dr = 0, cr = 0;
    let equityRow = false;
    rows.forEach((r, i) => {
      if (blank.has(i)) return;
      try {
        const code = str(r.account_code);
        // A code, or the account's name as Zoho's exports give it.
        const acct = l.accounts.get(code) ?? l.accountsByName.get(l.key(code)) ?? fail(`Account ${code} is not in your chart.`, 'Account code', code);
        const d = paise(r.debit, 'Debit') ?? 0;
        const c = paise(r.credit, 'Credit') ?? 0;
        if (d < 0 || c < 0) fail('Give a debit or a credit, not a negative.', d < 0 ? 'Debit' : 'Credit', d < 0 ? r.debit : r.credit);
        if (d && c) fail('Give a debit or a credit on a line, not both.', 'Debit', r.debit);
        seenInFile(l, 'opening', String(acct.id), 'Account code', code);
        dr += d; cr += c;
        // Opening Balance Adjustments takes whatever difference is left: named in
        // the file it says the difference is meant, and is not set directly.
        if (acct.code === CODE.OPENING_BALANCE_EQUITY) equityRow = true;
        else lines.push({ accountId: acct.id, netPaise: d - c });
        out.valid!++;
      } catch (err) {
        out.errors.push(...errorsOf(err, rowNo(i)));
      }
    });
    // Opening balances are a trial balance: its debits and credits agree. A
    // difference would be posted to Opening Balance Adjustments without anyone
    // deciding it should, so it is refused unless the file names that account.
    if (ctx.requireBalancedOpenings && !out.errors.length && dr !== cr && !equityRow) {
      const fmt = (p: number) => `₹${(p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
      out.errors.push({ row: rowNo(rows.length - 1), field: 'Debit / Credit', message:
        `The opening balances do not balance: debits ${fmt(dr)}, credits ${fmt(cr)}, a difference of ${fmt(Math.abs(dr - cr))}. ` +
        `Add the missing balance, or a row for account ${CODE.OPENING_BALANCE_EQUITY} (Opening Balance Adjustments) to take the difference.` });
    }
    // All or nothing: a part of a trial balance is not one.
    if (out.errors.length) { out.valid = 0; return out; }
    try {
      const res = await setAccountOpenings(trx, ctx.orgId, ctx.userId, { branchId: ctx.branchId, lines });
      out.created = res.changed;
      out.skipped = rows.length - res.changed;
    } catch (err) {
      out.errors.push(...errorsOf(err, 2));
      out.valid = 0;
    }
    return out;
  }

  const grouped = GROUPED[kind];
  if (grouped) {
    const by = t.groupBy!;
    const groups = new Map<string, { first: number; rows: Row[]; blank: boolean }>();
    rows.forEach((r, i) => {
      // A bill number is the supplier's, so two suppliers may share one.
      const key = kind === 'bills' ? `${str(r.vendor).toLowerCase()}|${str(r[by])}` : str(r[by]);
      const g = groups.get(key) ?? { first: i, rows: [], blank: false };
      g.rows.push(r);
      if (blank.has(i)) g.blank = true;
      groups.set(key, g);
    });
    for (const g of groups.values()) {
      if (g.blank) continue;
      await attempt(rowNo(g.first), () => grouped(trx, ctx, l, g.rows), str(g.rows[0][by]) || undefined);
    }
    out.createdIds = l.created;
    return out;
  }

  const handler = HANDLERS[kind]!;
  for (let i = 0; i < rows.length; i++) {
    if (blank.has(i)) continue;
    await attempt(rowNo(i), () => handler(trx, ctx, l, rows[i]));
  }
  out.createdIds = l.created;
  return out;
}

/** Thrown to drop the transaction after a check run, or a run with errors. */
export class DiscardImport extends Error {
  constructor(readonly outcome: ImportOutcome | ImportOutcome[]) {
    super('import discarded');
  }
}

/** Run inside a transaction of the caller's; true when nothing failed. */
export const clean = (o: ImportOutcome | ImportOutcome[]) => (Array.isArray(o) ? o : [o]).every((x) => x.errors.length === 0);

/** Whether a run kept anything worth keeping: in 'valid_only', the rows that passed. */
export const keptAny = (o: ImportOutcome | ImportOutcome[]) => (Array.isArray(o) ? o : [o]).some((x) => x.created > 0 || x.skipped > 0);

