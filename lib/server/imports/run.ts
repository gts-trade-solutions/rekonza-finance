import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Importing masters and vouchers from a spreadsheet.
//
// All or nothing. Every row is checked and written inside one transaction; if
// any row fails, nothing is kept and every failure is reported with its row
// number, so the file can be fixed and sent again whole. A check run does the
// same work and then throws it away, which is the only way to be sure the real
// run will succeed: the rules a voucher has to pass are the posting rules.
//
// Rows use the column keys in lib/imports/templates.ts.
// ─────────────────────────────────────────────────────────────────────────────

import type { Trx } from '../db';
import type { Paise } from '../../types';
import { toSqlFromPaise } from '../money-sql';
import { postEntry, type DraftLine } from '../ledger/posting';
import { CODE } from '../ledger/chart-of-accounts';
import { GST_RATES, GST_STATES, isValidGstin } from '../../tax/gst';
import { TEMPLATES, type ImportKind } from '../../imports/templates';
import { createInvoice } from '../services/sales';
import { createBill, createExpense } from '../services/purchases';
import { createCreditNote, createEstimate, createSalesOrder } from '../services/sales-documents';
import { createPurchaseOrder } from '../services/purchase-documents';
import { makePayment, receivePayment, type PaymentMode } from '../services/payments';
import { toPaiseFromSql } from '../money-sql';
import { addOpeningDocument, setAccountOpenings } from '../services/opening-balances';

export type Row = Record<string, unknown>;

export interface ImportOutcome {
  kind: ImportKind;
  /** What the screen calls this part, when its kind alone would not tell it apart (bank accounts beside accounts). */
  label?: string;
  rows: number;
  created: number;
  skipped: number;
  errors: { row: number; message: string }[];
  notes: string[];
}

export interface ImportContext {
  orgId: number;
  userId: number | null;
  branchId: number;
  /** A party, item or account already in the books: leave it, or count it as an error. */
  onDuplicate: 'skip' | 'error';
}

class RowError extends Error {}
const fail = (m: string): never => { throw new RowError(m); };

// ── Reading cells ────────────────────────────────────────────────────────────

const str = (v: unknown) => (v === null || v === undefined ? '' : String(v).trim());
const opt = (v: unknown) => str(v) || null;
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

function num(v: unknown, label: string): number | null {
  const s = str(v).replace(/[₹,\s]/g, '');
  if (!s) return null;
  // (1,000) is how some exports write a negative.
  const n = Number(s.replace(/^\((.*)\)$/, '-$1'));
  if (!Number.isFinite(n)) fail(`${label} "${str(v)}" is not a number.`);
  return n;
}
const paise = (v: unknown, label: string) => {
  const n = num(v, label);
  return n === null ? null : Math.round(n * 100);
};

/** yyyy-mm-dd, dd-mm-yyyy, dd/mm/yyyy or dd.mm.yyyy. */
function date(v: unknown, label: string): string {
  const s = str(v);
  if (!s) fail(`${label} is missing.`);
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  let y: number, mo: number, d: number;
  if (m) [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  else if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s))) [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  else return fail(`${label} "${s}" is not a date. Use yyyy-mm-dd or dd-mm-yyyy.`);
  const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const back = new Date(`${iso}T00:00:00Z`);
  if (back.getUTCMonth() + 1 !== mo || back.getUTCDate() !== d) fail(`${label} "${s}" is not a real date.`);
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
    if (!GST_STATES[code]) fail(`State code ${s} is not a GST state.`);
    return code;
  }
  return STATE_BY_NAME.get(s.toLowerCase().replace(/[^a-z]/g, '').replace(/^the/, '')) ?? fail(`"${s}" is not a state name GST uses.`);
}

function gstRate(v: unknown): number | null {
  const n = num(v, 'GST rate');
  if (n === null) return null;
  if (!(GST_RATES as readonly number[]).includes(n)) fail(`GST rate ${n}% is not a GST rate (${GST_RATES.join(', ')}).`);
  return n;
}

// ── Lookups shared by the handlers ───────────────────────────────────────────

async function lookups(trx: Trx, orgId: number) {
  const [contacts, items, accounts, hsn, banks] = await Promise.all([
    trx.selectFrom('contacts').select(['id', 'display_name', 'kind']).where('org_id', '=', orgId).execute(),
    trx.selectFrom('items').select(['id', 'name', 'sku']).where('org_id', '=', orgId).execute(),
    trx.selectFrom('accounts').select(['id', 'code', 'name']).where('org_id', '=', orgId).execute(),
    trx.selectFrom('hsn_codes').select(['code']).where('org_id', '=', orgId).execute(),
    trx.selectFrom('bank_accounts').select(['id', 'name']).where('org_id', '=', orgId).where('is_active', '=', 1).execute(),
  ]);
  const key = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  return {
    contacts: new Map(contacts.map((c) => [key(c.display_name), c])),
    items: new Map(items.flatMap((i) => [[key(i.name), i] as const, ...(i.sku ? [[key(i.sku), i] as const] : [])])),
    accounts: new Map(accounts.map((a) => [a.code, a])),
    accountsByName: new Map(accounts.map((a) => [key(a.name), a])),
    banks: new Map(banks.map((b) => [key(b.name), b])),
    hsn: new Set(hsn.map((h) => h.code)),
    key,
  };
}
type Lookups = Awaited<ReturnType<typeof lookups>>;

function party(l: Lookups, name: unknown, want: 'customer' | 'vendor', label: string) {
  const c = l.contacts.get(l.key(str(name)));
  if (!c) return fail(`${label} "${str(name)}" is not in your ${want}s. Import the parties first.`);
  if (c.kind !== want && c.kind !== 'both') fail(`"${c.display_name}" is set up as a ${c.kind}, not a ${want}.`);
  return c.id;
}

/** An HSN or SAC code not yet on the approved list is added, so the line can use it. */
async function ensureHsn(trx: Trx, orgId: number, l: Lookups, code: string | null, rate: number | null, description: string) {
  if (!code) return;
  if (!/^\d{4,8}$/.test(code)) fail(`HSN/SAC "${code}" should be 4 to 8 digits.`);
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
  const name = str(r.name) || fail('Name is missing.');
  const type = str(r.type).toLowerCase();
  if (!['customer', 'vendor', 'both'].includes(type)) fail(`Type "${str(r.type)}" should be customer, vendor or both.`);
  if (l.contacts.has(l.key(name))) {
    if (ctx.onDuplicate === 'skip') return 'skipped';
    fail(`"${name}" is already in your books.`);
  }
  const gstin = opt(r.gstin)?.toUpperCase() ?? null;
  if (gstin && !isValidGstin(gstin)) fail(`GSTIN ${gstin} fails its checksum, so it is mistyped somewhere.`);
  const st = state(r.state) ?? (gstin ? gstin.slice(0, 2) : null) ?? fail('Give the state, or a GSTIN.');
  if (gstin && gstin.slice(0, 2) !== st) fail(`GSTIN ${gstin} is from state ${gstin.slice(0, 2)}, not ${st}.`);
  const pan = opt(r.pan)?.toUpperCase() ?? (gstin ? gstin.slice(2, 12) : null);
  if (pan && !/^[A-Z]{5}\d{4}[A-Z]$/.test(pan)) fail(`PAN ${pan} should be five letters, four digits and a letter.`);
  const days = num(r.credit_days, 'Credit days');
  const udyam = opt(r.msme_udyam_no)?.toUpperCase() ?? null;

  const id = Number((await trx.insertInto('contacts').values({
    org_id: ctx.orgId, kind: type as 'customer', display_name: name, legal_name: opt(r.legal_name),
    gstin, pan, state_code: st, gst_treatment: gstin ? 'registered' : 'unregistered',
    email: opt(r.email), phone: opt(r.phone), billing_address: opt(r.address), billing_city: opt(r.city),
    billing_pincode: opt(r.pincode), payment_terms: days === null ? null : days === 0 ? 'due_on_receipt' : `net_${days}`,
    is_msme: udyam ? 1 : 0, msme_udyam_no: udyam,
  }).executeTakeFirstOrThrow()).insertId);
  l.contacts.set(l.key(name), { id, display_name: name, kind: type as 'customer' });
  return 'created';
};

const items: Handler = async (trx, ctx, l, r) => {
  const name = str(r.name) || fail('Name is missing.');
  if (l.items.has(l.key(name))) {
    if (ctx.onDuplicate === 'skip') return 'skipped';
    fail(`"${name}" is already in your items.`);
  }
  const kind = (str(r.kind).toLowerCase() || 'goods') as 'goods' | 'service';
  if (!['goods', 'service'].includes(kind)) fail(`Kind "${str(r.kind)}" should be goods or service.`);
  const rate = gstRate(r.gst_rate) ?? 18;
  const hsn = opt(r.hsn_sac);
  await ensureHsn(trx, ctx.orgId, l, hsn, rate, name);
  const purchase = paise(r.purchase_price, 'Purchase price') ?? 0;
  const openingQty = num(r.opening_qty, 'Opening quantity');
  const openingRate = paise(r.opening_rate, 'Opening rate');
  const track = yes(r.track_stock) ?? kind === 'goods';
  if (openingQty && !track) fail('An item with opening stock has to track stock.');

  const sku = opt(r.sku);
  const id = Number((await trx.insertInto('items').values({
    org_id: ctx.orgId, kind, name, sku, hsn_sac: hsn, uqc: (opt(r.unit) ?? (kind === 'service' ? 'OTH' : 'NOS')).toUpperCase(),
    sale_price: toSqlFromPaise(paise(r.sale_price, 'Sale price') ?? 0), purchase_price: toSqlFromPaise(purchase),
    gst_rate_pct: rate, track_inventory: track ? 1 : 0,
    opening_stock_qty: openingQty ? String(openingQty) : null,
    opening_stock_rate: openingQty ? toSqlFromPaise(openingRate ?? purchase) : null,
  }).executeTakeFirstOrThrow()).insertId);
  l.items.set(l.key(name), { id, name, sku });
  if (sku) l.items.set(l.key(sku), { id, name, sku });
  return 'created';
};

const TYPES = ['asset', 'liability', 'equity', 'income', 'expense'] as const;
const accounts: Handler = async (trx, ctx, l, r) => {
  const code = str(r.code) || fail('Code is missing.');
  if (!/^[0-9A-Za-z-]{1,20}$/.test(code)) fail(`Code "${code}" should be letters and digits only.`);
  const name = str(r.name) || fail('Name is missing.');
  if (l.accounts.has(code)) {
    if (ctx.onDuplicate === 'skip') return 'skipped';
    fail(`Account ${code} already exists (${l.accounts.get(code)!.name}).`);
  }
  const type = str(r.type).toLowerCase() as (typeof TYPES)[number];
  if (!TYPES.includes(type)) fail(`Type "${str(r.type)}" should be one of ${TYPES.join(', ')}.`);
  const id = Number((await trx.insertInto('accounts').values({
    org_id: ctx.orgId, code, name, type, subtype: opt(r.subtype), description: opt(r.description),
  }).executeTakeFirstOrThrow()).insertId);
  l.accounts.set(code, { id, code, name });
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
  l.banks.get(l.key(str(name))) ?? fail(`${label} "${str(name)}" is not one of your bank or cash accounts.`);

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

const MODES = ['cash', 'cheque', 'upi', 'neft', 'imps', 'card'];
const payment = (side: 'received' | 'made'): Handler => async (trx, ctx, l, r) => {
  const contactId = party(l, side === 'received' ? r.customer : r.vendor, side === 'received' ? 'customer' : 'vendor', side === 'received' ? 'Customer' : 'Vendor');
  const mode = (str(r.mode).toLowerCase() || 'neft') as PaymentMode;
  if (!MODES.includes(mode)) fail(`Mode "${str(r.mode)}" should be one of ${MODES.join(', ')}.`);
  const amount = paise(r.amount, 'Amount') ?? fail('Amount is missing.');
  const allocations = [];
  const doc = str(side === 'received' ? r.invoice : r.bill);
  if (doc) {
    const d = side === 'received'
      ? await trx.selectFrom('invoices').select(['id', 'total', 'amount_paid', 'status']).where('org_id', '=', ctx.orgId).where('customer_id', '=', contactId).where('number', '=', doc).executeTakeFirst()
      : await trx.selectFrom('bills').select(['id', 'total', 'amount_paid', 'status']).where('org_id', '=', ctx.orgId).where('vendor_id', '=', contactId).where('vendor_invoice_no', '=', doc).executeTakeFirst();
    if (!d || d.status === 'void' || d.status === 'draft') fail(`${side === 'received' ? 'Invoice' : 'Bill'} ${doc} is not an open one of theirs.`);
    const open = toPaiseFromSql(d!.total) - toPaiseFromSql(d!.amount_paid);
    if (open <= 0) fail(`${side === 'received' ? 'Invoice' : 'Bill'} ${doc} is paid already.`);
    allocations.push({ targetType: side === 'received' ? 'invoice' as const : 'bill' as const, targetId: d!.id, amountPaise: Math.min(open, amount) });
  }
  const input = {
    branchId: ctx.branchId, contactId, date: date(r.date, 'Date'), mode, amountPaise: amount,
    bankAccountId: bankOf(l, r.account, side === 'received' ? 'Deposited to' : 'Paid from').id, reference: opt(r.reference),
    tdsPaise: paise(r.tds, 'TDS') ?? 0, bankChargesPaise: paise(r.bank_charges, 'Bank charges') ?? 0, allocations, notes: opt(r.notes),
  };
  await (side === 'received' ? receivePayment(trx, ctx.orgId, ctx.userId, input) : makePayment(trx, ctx.orgId, ctx.userId, input));
  return 'created';
};

const HANDLERS: Partial<Record<ImportKind, Handler>> = {
  contacts, items, accounts, 'opening-bills': openingBills, expenses, 'payments-received': payment('received'), 'payments-made': payment('made'),
};

// ── Grouped kinds: one document from several rows ────────────────────────────

type GroupHandler = (trx: Trx, ctx: ImportContext, l: Lookups, rows: Row[]) => Promise<void>;

const journals: GroupHandler = async (trx, ctx, l, rows) => {
  const when = date(rows[0].date, 'Date');
  if (rows.some((r) => str(r.date) && date(r.date, 'Date') !== when)) fail('Every line of a voucher needs the same date.');
  const control = new Set([CODE.AR, CODE.AP] as string[]);
  const lines: DraftLine[] = rows.map((r) => {
    const code = str(r.account_code) || fail('Account code is missing.');
    const acct = l.accounts.get(code) ?? fail(`Account ${code} is not in your chart.`);
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
  const item = str(r.item) ? (l.items.get(l.key(str(r.item))) ?? fail(`Item "${str(r.item)}" is not in your items.`)) : null;
  const description = opt(r.description);
  if (!item && !description) fail('Give an item or a description.');
  const rate = gstRate(r.gst_rate);
  const hsn = opt(r.hsn_sac);
  await ensureHsn(trx, ctx.orgId, l, hsn, rate, description ?? item?.name ?? '');
  return {
    itemId: item?.id ?? null, description, hsnSac: hsn,
    qty: num(r.qty, 'Quantity') ?? fail('Quantity is missing.'),
    ratePaise: paise(r.rate, 'Rate') ?? fail('Rate is missing.'),
    discountPct: num(r.discount_pct, 'Discount') ?? undefined,
    gstRatePct: rate ?? undefined,
  };
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
  const lines = [];
  for (const r of rows) lines.push(await lineOf(trx, ctx, l, r));
  await createBill(trx, ctx.orgId, ctx.userId, {
    branchId: ctx.branchId, vendorId: party(l, rows[0].vendor, 'vendor', 'Vendor'),
    vendorInvoiceNo: str(rows[0].bill_no), date: when,
    dueDate: str(rows[0].due_date) ? date(rows[0].due_date, 'Due date') : when, status: 'open', lines,
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
  const out: ImportOutcome = { kind, rows: rows.length, created: 0, skipped: 0, errors: [], notes: [] };
  const t = TEMPLATES[kind];
  // The spreadsheet's own row number: the heading is row 1.
  const rowNo = (i: number) => i + 2;

  rows.forEach((r, i) => {
    for (const c of t.columns) {
      if (c.required && !str(r[c.key])) out.errors.push({ row: rowNo(i), message: `${c.label} is missing.` });
    }
  });
  if (out.errors.length) return out;

  const l = await lookups(trx, ctx.orgId);

  if (kind === 'opening-ledger') {
    const lines: { accountId: number; netPaise: Paise }[] = [];
    rows.forEach((r, i) => {
      try {
        const code = str(r.account_code);
        const acct = l.accounts.get(code) ?? fail(`Account ${code} is not in your chart.`);
        lines.push({ accountId: acct.id, netPaise: (paise(r.debit, 'Debit') ?? 0) - (paise(r.credit, 'Credit') ?? 0) });
      } catch (err) {
        out.errors.push({ row: rowNo(i), message: messageOf(err) });
      }
    });
    if (out.errors.length) return out;
    try {
      const res = await setAccountOpenings(trx, ctx.orgId, ctx.userId, { branchId: ctx.branchId, lines });
      out.created = res.changed;
      out.skipped = rows.length - res.changed;
    } catch (err) {
      out.errors.push({ row: 2, message: messageOf(err) });
    }
    return out;
  }

  const grouped = GROUPED[kind];
  if (grouped) {
    const by = t.groupBy!;
    const groups = new Map<string, { first: number; rows: Row[] }>();
    rows.forEach((r, i) => {
      // A bill number is the supplier's, so two suppliers may share one.
      const key = kind === 'bills' ? `${str(r.vendor).toLowerCase()}|${str(r[by])}` : str(r[by]);
      const g = groups.get(key) ?? { first: i, rows: [] };
      g.rows.push(r);
      groups.set(key, g);
    });
    for (const g of groups.values()) {
      try {
        await grouped(trx, ctx, l, g.rows);
        out.created++;
      } catch (err) {
        out.errors.push({ row: rowNo(g.first), message: `${str(g.rows[0][by])}: ${messageOf(err)}` });
      }
    }
    return out;
  }

  const handler = HANDLERS[kind]!;
  for (let i = 0; i < rows.length; i++) {
    try {
      if ((await handler(trx, ctx, l, rows[i])) === 'created') out.created++;
      else out.skipped++;
    } catch (err) {
      out.errors.push({ row: rowNo(i), message: messageOf(err) });
    }
  }
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

