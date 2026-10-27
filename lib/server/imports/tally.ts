import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Moving a company across from Tally.
//
// Two sources give the same thing: the XML file TallyPrime writes from
// Export → Masters, or a company the connector has already mirrored. Either
// way the ledgers, groups and stock items become this book's masters and
// openings:
//
//   Sundry Debtors / Creditors   customers and vendors, with their unpaid
//                                bills (bill by bill when Tally kept them so)
//   Bank Accounts, Cash-in-Hand  bank and cash accounts, with their balances
//   Duties & Taxes               the GST and TDS ledgers this book already has
//   everything else              ledger accounts, with their balances
//   stock items                  items, with opening quantity and value
//
// Tally writes a debit as a negative number. Here, as everywhere in this app,
// a debit is positive.
// ─────────────────────────────────────────────────────────────────────────────

import type { Executor, Trx } from '../db';
import type { Paise } from '../../types';
import { CODE } from '../ledger/chart-of-accounts';
import { postEntry } from '../ledger/posting';
import { createBankAccount } from '../services/banking';
import { booksStartDate } from '../services/opening-balances';
import { runImport, type ImportContext, type ImportOutcome, type Row } from './run';

export interface TallyLedger {
  name: string;
  parent: string;
  /** Debit positive. */
  balancePaise: Paise;
  gstin: string | null;
  pan: string | null;
  stateName: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  pincode: string | null;
  creditDays: number | null;
  /** Unpaid bills, when the ledger is kept bill by bill. Debit positive. */
  bills: { ref: string; date: string | null; amountPaise: Paise; creditDays: number | null }[];
}

export interface TallyStockItem {
  name: string;
  unit: string | null;
  hsn: string | null;
  gstRatePct: number | null;
  qty: number;
  valuePaise: Paise;
}

export interface TallyMasters {
  groups: Map<string, string>;
  ledgers: TallyLedger[];
  stockItems: TallyStockItem[];
}

// ── Reading Tally's XML ──────────────────────────────────────────────────────

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unescape = (s: string) =>
  s.replace(/&(amp|lt|gt|quot|apos);/g, (_, e: string) => ENT[e]).replace(/&#(\d+);/g, (_, n: string) => {
    const c = Number(n);
    return c < 32 && c !== 9 && c !== 10 && c !== 13 ? '' : String.fromCharCode(c);
  });

const tag = (block: string, name: string) => {
  const m = new RegExp(`<${name.replace(/\./g, '\\.')}(?:\\s[^>]*)?>([\\s\\S]*?)</${name.replace(/\./g, '\\.')}>`).exec(block);
  const v = m ? unescape(m[1]).trim() : '';
  return v || null;
};
const blocks = (xml: string, name: string) => {
  const re = new RegExp(`<${name.replace(/\./g, '\\.')}(\\s[^>]*)?>([\\s\\S]*?)</${name.replace(/\./g, '\\.')}>`, 'g');
  const out: { attrs: string; body: string }[] = [];
  for (let m = re.exec(xml); m; m = re.exec(xml)) out.push({ attrs: m[1] ?? '', body: m[2] });
  return out;
};
const nameAttr = (attrs: string, body: string) => {
  const m = /NAME="([^"]*)"/.exec(attrs);
  return unescape(m ? m[1] : (tag(body, 'NAME') ?? '')).trim();
};

/** Tally's signed rupees, debits negative, as paise with debits positive. */
export function debitPaise(value: string | null): Paise {
  if (!value) return 0;
  const n = Number(value.replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? -Math.round(n * 100) : 0;
}
/** "30 Days" → 30. */
const days = (v: string | null) => {
  const n = v ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : null;
};
/** 20260331 → 2026-03-31. */
const tallyDate = (v: string | null) => (v && /^\d{8}$/.test(v) ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` : null);

export function parseTallyMastersXml(xml: string): TallyMasters {
  const groups = new Map<string, string>();
  for (const g of blocks(xml, 'GROUP')) groups.set(nameAttr(g.attrs, g.body), tag(g.body, 'PARENT') ?? '');

  const ledgers: TallyLedger[] = blocks(xml, 'LEDGER').map((l) => {
    const gstReg = blocks(l.body, 'LEDGSTREGDETAILS.LIST')[0]?.body ?? '';
    const mailing = blocks(l.body, 'LEDMAILINGDETAILS.LIST')[0]?.body ?? '';
    const address = blocks(mailing || l.body, 'ADDRESS.LIST')
      .flatMap((a) => blocks(a.body, 'ADDRESS').map((x) => unescape(x.body).trim()))
      .filter(Boolean).join(', ');
    return {
      name: nameAttr(l.attrs, l.body),
      parent: tag(l.body, 'PARENT') ?? '',
      balancePaise: debitPaise(tag(l.body, 'OPENINGBALANCE')),
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

  return { groups, ledgers, stockItems };
}

/** A company the connector has mirrored, at the end of the period it last read. */
export async function connectedCompanyMasters(ex: Executor, orgId: number, companyId: number): Promise<TallyMasters> {
  const company = await ex.selectFrom('tally_companies').select(['id'])
    .where('id', '=', companyId).where('org_id', '=', orgId).executeTakeFirst();
  if (!company) throw new Error('That Tally company is not connected to this book.');
  const [groups, ledgers, items] = await Promise.all([
    ex.selectFrom('tally_groups').select(['name', 'parent']).where('company_id', '=', companyId).execute(),
    ex.selectFrom('tally_ledgers').select(['name', 'parent', 'closing_paise', 'gstin', 'state_name']).where('company_id', '=', companyId).execute(),
    ex.selectFrom('tally_stock_items').select(['name', 'unit', 'hsn', 'closing_qty', 'closing_value_paise']).where('company_id', '=', companyId).execute(),
  ]);
  return {
    groups: new Map(groups.map((g) => [g.name, g.parent ?? ''])),
    ledgers: ledgers.map((l) => ({
      name: l.name, parent: l.parent, balancePaise: Number(l.closing_paise), gstin: l.gstin, pan: null,
      stateName: l.state_name, email: null, phone: null, address: null, pincode: null, creditDays: null, bills: [],
    })),
    stockItems: items.map((s) => ({
      name: s.name, unit: s.unit, hsn: s.hsn, gstRatePct: null,
      qty: Math.abs(Number(s.closing_qty)), valuePaise: Math.abs(Number(s.closing_value_paise)),
    })),
  };
}

// ── Mapping Tally's groups onto this book ────────────────────────────────────

type Kind = 'debtor' | 'creditor' | 'bank' | 'cash' | 'tax' | 'stock' | 'pl' | 'account';
const RESERVED: Record<string, { kind: Kind; type: 'asset' | 'liability' | 'equity' | 'income' | 'expense'; subtype?: string }> = {
  'sundry debtors': { kind: 'debtor', type: 'asset' },
  'sundry creditors': { kind: 'creditor', type: 'liability' },
  'bank accounts': { kind: 'bank', type: 'asset' },
  'cash-in-hand': { kind: 'cash', type: 'asset' },
  'duties & taxes': { kind: 'tax', type: 'liability', subtype: 'tax' },
  'stock-in-hand': { kind: 'stock', type: 'asset' },
  'bank od a/c': { kind: 'account', type: 'liability', subtype: 'bank_od' },
  'capital account': { kind: 'account', type: 'equity' },
  'reserves & surplus': { kind: 'account', type: 'equity' },
  'loans (liability)': { kind: 'account', type: 'liability', subtype: 'loan' },
  'secured loans': { kind: 'account', type: 'liability', subtype: 'loan' },
  'unsecured loans': { kind: 'account', type: 'liability', subtype: 'loan' },
  'current liabilities': { kind: 'account', type: 'liability' },
  'provisions': { kind: 'account', type: 'liability', subtype: 'provision' },
  'suspense a/c': { kind: 'account', type: 'liability', subtype: 'suspense' },
  'branch / divisions': { kind: 'account', type: 'liability', subtype: 'branch' },
  'current assets': { kind: 'account', type: 'asset' },
  'deposits (asset)': { kind: 'account', type: 'asset', subtype: 'deposit' },
  'loans & advances (asset)': { kind: 'account', type: 'asset', subtype: 'advance' },
  'fixed assets': { kind: 'account', type: 'asset', subtype: 'fixed_asset' },
  'investments': { kind: 'account', type: 'asset', subtype: 'investment' },
  'misc. expenses (asset)': { kind: 'account', type: 'asset', subtype: 'misc_expense' },
  'sales accounts': { kind: 'account', type: 'income' },
  'direct incomes': { kind: 'account', type: 'income' },
  'indirect incomes': { kind: 'account', type: 'income' },
  'purchase accounts': { kind: 'account', type: 'expense' },
  'direct expenses': { kind: 'account', type: 'expense' },
  'indirect expenses': { kind: 'account', type: 'expense' },
};

function primaryOf(groups: Map<string, string>, parent: string) {
  let g = parent;
  for (let i = 0; i < 30 && g; i++) {
    const hit = RESERVED[g.toLowerCase()];
    if (hit) return hit;
    g = groups.get(g) ?? '';
  }
  return null;
}

/** GST and TDS ledgers go to the ones this book already posts to. */
function taxCode(name: string, balancePaise: Paise): string | null {
  const n = name.toLowerCase();
  const input = /input|itc|credit|receivable/.test(n) || balancePaise > 0;
  if (/cess/.test(n)) return input ? CODE.ITC_CESS : CODE.GST_CESS;
  if (/cgst|central/.test(n)) return input ? CODE.ITC_CGST : CODE.GST_CGST;
  if (/sgst|utgst|state/.test(n)) return input ? CODE.ITC_SGST : CODE.GST_SGST;
  if (/igst|integrated/.test(n)) return input ? CODE.ITC_IGST : CODE.GST_IGST;
  if (/tcs/.test(n)) return balancePaise > 0 ? CODE.TCS_RECEIVABLE : CODE.TCS_PAYABLE;
  if (/tds/.test(n)) return balancePaise > 0 ? CODE.TDS_RECEIVABLE : CODE.TDS_PAYABLE;
  return null;
}

const UNITS: Record<string, string> = {
  nos: 'NOS', no: 'NOS', pcs: 'PCS', pc: 'PCS', kgs: 'KGS', kg: 'KGS', ltr: 'LTR', ltrs: 'LTR', mtr: 'MTR', mtrs: 'MTR',
  box: 'BOX', set: 'SET', sets: 'SET', pair: 'PRS', prs: 'PRS', bag: 'BAG', btl: 'BTL', dozen: 'DOZ', doz: 'DOZ',
  gms: 'GMS', gm: 'GMS', tonne: 'TON', ton: 'TON', sqm: 'SQM', sqft: 'SQF', roll: 'ROL', unit: 'UNT', units: 'UNT',
};

const dayBefore = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/**
 * Bring a Tally company in: masters first, then openings, in one transaction
 * of the caller's. Returns one outcome per part.
 */
export async function importTally(trx: Trx, ctx: ImportContext, masters: TallyMasters): Promise<ImportOutcome[]> {
  const start = (await booksStartDate(trx, ctx.orgId)).date;
  const lastDay = dayBefore(start);
  const notes: string[] = [];
  // Tally does not always hold a party's state. Without a GSTIN to read it
  // from, the company's own state is the safer guess: it is where most of a
  // business's parties are, and a wrong guess shows on the first invoice.
  const home = (await trx.selectFrom('branches').select('state_code')
    .where('org_id', '=', ctx.orgId).orderBy('is_primary', 'desc').executeTakeFirst())?.state_code ?? null;
  const guessed: string[] = [];

  const contacts: Row[] = [];
  const openingBills: Row[] = [];
  const accountRows: Row[] = [];
  const ledgerOpenings = new Map<string, Paise>();
  const banks: { name: string; kind: 'bank' | 'cash'; balancePaise: Paise }[] = [];

  const existing = await trx.selectFrom('accounts').select(['code', 'name']).where('org_id', '=', ctx.orgId).execute();
  const used = new Set(existing.map((a) => a.code));
  const byName = new Map(existing.map((a) => [a.name.toLowerCase(), a.code]));
  const nextCode: Record<string, number> = { asset: 1700, liability: 2700, equity: 3700, income: 4700, expense: 7000 };
  const freshCode = (type: string) => {
    while (used.has(String(nextCode[type]))) nextCode[type]++;
    const c = String(nextCode[type]++);
    used.add(c);
    return c;
  };
  let capitalTaken = false;

  for (const l of masters.ledgers) {
    if (l.name.toLowerCase() === 'profit & loss a/c') {
      if (l.balancePaise) ledgerOpenings.set(CODE.RETAINED, (ledgerOpenings.get(CODE.RETAINED) ?? 0) + l.balancePaise);
      continue;
    }
    const p = primaryOf(masters.groups, l.parent);
    if (!p) {
      notes.push(`${l.name}: its group "${l.parent}" does not lead to a Tally primary group, so it was left out.`);
      continue;
    }
    if (p.kind === 'debtor' || p.kind === 'creditor') {
      const want = p.kind === 'debtor' ? 'customer' : 'vendor';
      if (!l.stateName && !l.gstin && home) guessed.push(l.name);
      contacts.push({
        type: want, name: l.name, gstin: l.gstin, pan: l.pan, state: l.stateName ?? (l.gstin ? null : home),
        email: l.email, phone: l.phone,
        address: l.address, pincode: l.pincode, credit_days: l.creditDays,
      });
      // What they owe us is a debit; what we owe them, a credit.
      const sign = p.kind === 'debtor' ? 1 : -1;
      const bills = l.bills.length ? l.bills : l.balancePaise ? [{ ref: 'Opening balance', date: lastDay, amountPaise: l.balancePaise, creditDays: 0 }] : [];
      for (const b of bills) {
        const owed = sign * b.amountPaise;
        if (owed <= 0) {
          notes.push(`${l.name}, ${b.ref}: ${p.kind === 'debtor' ? 'a credit balance (an advance from the customer)' : 'a debit balance (an advance to the vendor)'} of ₹${(Math.abs(owed) / 100).toFixed(2)} was not brought in; enter it as an advance.`);
          continue;
        }
        const billDate = b.date && b.date < start ? b.date : lastDay;
        openingBills.push({
          type: p.kind === 'debtor' ? 'receivable' : 'payable', party: l.name, bill_no: b.ref,
          bill_date: billDate, due_date: addDays(billDate, b.creditDays ?? l.creditDays ?? 0), amount: (owed / 100).toFixed(2),
        });
      }
      continue;
    }
    if (p.kind === 'bank' || p.kind === 'cash') {
      banks.push({ name: l.name, kind: p.kind, balancePaise: l.balancePaise });
      continue;
    }
    if (p.kind === 'stock') {
      notes.push(`${l.name}: opening stock comes from the stock items, not this ledger.`);
      continue;
    }
    // A ledger this book already has, by its tax role or its name.
    let code = p.kind === 'tax' ? taxCode(l.name, l.balancePaise) : null;
    code ??= byName.get(l.name.toLowerCase()) ?? null;
    if (!code && p.type === 'equity' && !capitalTaken && /capital/i.test(l.parent + l.name)) {
      code = CODE.CAPITAL;
      capitalTaken = true;
    }
    if (!code) {
      code = freshCode(p.type);
      accountRows.push({ code, name: l.name, type: p.type, subtype: p.subtype ?? null, description: `From Tally, under ${l.parent}` });
      byName.set(l.name.toLowerCase(), code);
    }
    if (l.balancePaise) ledgerOpenings.set(code, (ledgerOpenings.get(code) ?? 0) + l.balancePaise);
  }

  const items: Row[] = masters.stockItems.map((s) => ({
    name: s.name, kind: 'goods', hsn_sac: s.hsn && /^\d{4,8}$/.test(s.hsn) ? s.hsn : null,
    unit: s.unit ? (UNITS[s.unit.toLowerCase().replace(/[^a-z]/g, '')] ?? 'OTH') : 'NOS',
    gst_rate: s.gstRatePct, track_stock: 'yes',
    opening_qty: s.qty || null, opening_rate: s.qty ? (s.valuePaise / s.qty / 100).toFixed(4) : null,
  }));

  const outcomes: ImportOutcome[] = [];
  outcomes.push(await runImport(trx, ctx, 'contacts', contacts));
  outcomes.push(await runImport(trx, ctx, 'accounts', accountRows));
  outcomes.push(await runImport(trx, ctx, 'items', items));

  // Bank and cash accounts carry their own opening, set on the account.
  const bankOut: ImportOutcome = { kind: 'accounts', rows: banks.length, created: 0, skipped: 0, errors: [], notes: [] };
  const known = new Set((await trx.selectFrom('bank_accounts').select('name').where('org_id', '=', ctx.orgId).execute()).map((b) => b.name.toLowerCase()));
  for (const b of banks) {
    if (known.has(b.name.toLowerCase())) { bankOut.skipped++; continue; }
    try {
      await createBankAccount(trx, ctx.orgId, ctx.userId, {
        kind: b.kind, name: b.name, openingBalancePaise: b.balancePaise, openingDate: start,
      });
      bankOut.created++;
    } catch (err) {
      bankOut.errors.push({ row: 0, message: `${b.name}: ${(err as Error).message}` });
    }
  }
  outcomes.push(bankOut);

  outcomes.push(await runImport(trx, ctx, 'opening-bills', openingBills));
  outcomes.push(await runImport(trx, ctx, 'opening-ledger', [...ledgerOpenings].map(([code, net]) => ({
    account_code: code, debit: net > 0 ? (net / 100).toFixed(2) : '', credit: net < 0 ? (-net / 100).toFixed(2) : '',
  }))));
  if (guessed.length) {
    notes.unshift(`${guessed.length} part${guessed.length === 1 ? 'y has' : 'ies have'} no state or GSTIN in Tally and were placed in your own state: ${guessed.slice(0, 5).join(', ')}${guessed.length > 5 ? '…' : ''}. Check them before invoicing.`);
  }
  outcomes[0].notes.push(...notes);
  return outcomes;
}

// ── Vouchers ─────────────────────────────────────────────────────────────────
//
// Once the masters are across, the company's day-to-day can follow: every
// voucher the connector has mirrored, from the day these books start, posted
// here as a journal entry with its Tally type, number and narration. Each
// ledger resolves the way the masters did — a party to Receivables or
// Payables against that customer or vendor, a bank or cash ledger to its
// account, a GST or TDS ledger to the one this book posts to, anything else
// to the account of the same name. A voucher with a ledger that resolves to
// nothing is left out and named, never guessed at.
//
// They are journal entries, not invoices: they reach every statement and the
// ledgers, but not the GST returns, which are filed from documents raised in
// this book. Bring vouchers across for periods whose returns Tally filed.

export async function importTallyVouchers(
  trx: Trx, ctx: ImportContext, companyId: number, range: { from?: string | null; to?: string | null } = {},
): Promise<ImportOutcome> {
  const out: ImportOutcome = { kind: 'journals', rows: 0, created: 0, skipped: 0, errors: [], notes: [] };
  const company = await trx.selectFrom('tally_companies').select(['id', 'name'])
    .where('id', '=', companyId).where('org_id', '=', ctx.orgId).executeTakeFirst();
  if (!company) throw new Error('That Tally company is not connected to this book.');

  const start = (await booksStartDate(trx, ctx.orgId)).date;
  const from = range.from && range.from > start ? range.from : start;

  const [groups, ledgers, accounts, contacts, banks, done] = await Promise.all([
    trx.selectFrom('tally_groups').select(['name', 'parent']).where('company_id', '=', companyId).execute(),
    trx.selectFrom('tally_ledgers').select(['name', 'parent', 'closing_paise']).where('company_id', '=', companyId).execute(),
    trx.selectFrom('accounts').select(['id', 'code', 'name']).where('org_id', '=', ctx.orgId).execute(),
    trx.selectFrom('contacts').select(['id', 'display_name']).where('org_id', '=', ctx.orgId).execute(),
    trx.selectFrom('bank_accounts').select(['name', 'ledger_account_id']).where('org_id', '=', ctx.orgId).execute(),
    trx.selectFrom('tally_voucher_imports').select('guid').where('org_id', '=', ctx.orgId).where('company_id', '=', companyId).execute(),
  ]);
  const groupMap = new Map(groups.map((g) => [g.name, g.parent ?? '']));
  const byCode = new Map(accounts.map((a) => [a.code, a.id]));
  const byName = new Map(accounts.map((a) => [a.name.toLowerCase(), a.id]));
  const contactBy = new Map(contacts.map((c) => [c.display_name.toLowerCase(), c.id]));
  const bankBy = new Map(banks.map((b) => [b.name.toLowerCase(), b.ledger_account_id]));
  const imported = new Set(done.map((d) => d.guid));

  // Each Tally ledger, resolved once.
  const resolved = new Map<string, { accountId: number; contactId: number | null } | null>();
  for (const l of ledgers) {
    const key = l.name.toLowerCase();
    const p = primaryOf(groupMap, l.parent);
    let r: { accountId: number; contactId: number | null } | null = null;
    if (p?.kind === 'debtor' || p?.kind === 'creditor') {
      const contactId = contactBy.get(key) ?? null;
      const accountId = byCode.get(p.kind === 'debtor' ? CODE.AR : CODE.AP) ?? null;
      r = contactId && accountId ? { accountId, contactId } : null;
    } else if (p?.kind === 'bank' || p?.kind === 'cash') {
      const accountId = bankBy.get(key) ?? null;
      r = accountId ? { accountId, contactId: null } : null;
    } else if (p?.kind === 'tax') {
      const code = taxCode(l.name, Number(l.closing_paise));
      const accountId = (code && byCode.get(code)) || byName.get(key) || null;
      r = accountId ? { accountId, contactId: null } : null;
    } else {
      const accountId = byName.get(key) ?? (key === 'profit & loss a/c' ? byCode.get(CODE.RETAINED) ?? null : null);
      r = accountId ? { accountId, contactId: null } : null;
    }
    resolved.set(key, r);
  }

  const vouchers = await trx.selectFrom('tally_vouchers')
    .select(['id', 'guid', 'voucher_type', 'number', 'date', 'narration'])
    .where('company_id', '=', companyId).where('is_cancelled', '=', 0).where('is_optional', '=', 0)
    .where('amount_paise', '>', 0).where('date', '>=', from)
    .$if(!!range.to, (q) => q.where('date', '<=', range.to!))
    .orderBy('date').orderBy('id').execute();
  const entries = vouchers.length
    ? await trx.selectFrom('tally_voucher_entries').select(['voucher_id', 'line_no', 'ledger', 'debit_paise', 'credit_paise'])
      .where('voucher_id', 'in', vouchers.map((v) => v.id)).orderBy('voucher_id').orderBy('line_no').execute()
    : [];
  const linesOf = new Map<number, typeof entries>();
  for (const e of entries) linesOf.set(e.voucher_id, [...(linesOf.get(e.voucher_id) ?? []), e]);

  const unresolved = new Set<string>();
  for (const [i, v] of vouchers.entries()) {
    out.rows++;
    const label = `${v.voucher_type}${v.number ? ` ${v.number}` : ''} of ${String(v.date).slice(0, 10)}`;
    if (imported.has(v.guid)) { out.skipped++; continue; }
    const lines = linesOf.get(v.id) ?? [];
    const missing = [...new Set(lines.map((l) => l.ledger).filter((name) => !resolved.get(name.toLowerCase())))];
    if (missing.length) {
      missing.forEach((m) => unresolved.add(m));
      out.errors.push({ row: i + 1, message: `${label}: no account for ${missing.join(', ')}.` });
      continue;
    }
    try {
      const entry = await postEntry(trx, {
        orgId: ctx.orgId, branchId: ctx.branchId, date: String(v.date).slice(0, 10), module: 'accountant',
        sourceType: 'tally_import', userId: ctx.userId,
        memo: `Tally ${v.voucher_type}${v.number ? ` ${v.number}` : ''}${v.narration ? ` — ${v.narration}` : ''}`.slice(0, 500),
        lines: lines.map((l) => {
          const r = resolved.get(l.ledger.toLowerCase())!;
          return {
            accountId: r.accountId, contactId: r.contactId, description: l.ledger,
            debit: Number(l.debit_paise), credit: Number(l.credit_paise),
          };
        }),
      });
      await trx.insertInto('tally_voucher_imports').values({ org_id: ctx.orgId, company_id: companyId, guid: v.guid, journal_entry_id: entry.id }).execute();
      out.created++;
    } catch (err) {
      out.errors.push({ row: i + 1, message: `${label}: ${(err as Error).message}` });
    }
  }
  if (unresolved.size) {
    out.notes.push(
      `${unresolved.size} Tally ledger(s) have no account here yet: ${[...unresolved].slice(0, 8).join(', ')}${unresolved.size > 8 ? '…' : ''}. ` +
        'Bring the masters across again, or add them to the chart of accounts with the same name.',
    );
  }
  out.notes.push(
    `Vouchers from ${from}${range.to ? ` to ${range.to}` : ''}; anything earlier is in the opening balances. ` +
      'They post as journal entries and are not part of the GST returns, which are filed from documents raised here.',
  );
  return out;
}
