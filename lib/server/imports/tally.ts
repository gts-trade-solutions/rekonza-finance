import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Moving a company across from Tally.
//
// Two sources give the same thing: the XML files TallyPrime writes (Export →
// Masters, and Export → Transactions for the vouchers), or a company the
// connector has already mirrored. Either way the ledgers, groups and stock
// items become this book's masters and openings:
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

import {
  parseTallyMastersXml, NON_ACCOUNTING_TYPES, postsToBooks,
  type TallyMasters, type TallyFileVoucher,
} from '../../tally/xml';

export type { TallyLedger, TallyStockItem, TallyMasters } from '../../tally/xml';
export { parseTallyMastersXml };

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
    voucherTypes: new Map(),
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
export async function importTally(trx: Trx, ctx: ImportContext, masters: TallyMasters, source = 'Tally'): Promise<ImportOutcome[]> {
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
      accountRows.push({ code, name: l.name, type: p.type, subtype: p.subtype ?? null, description: l.note ?? `From ${source}, under ${l.parent}` });
      byName.set(l.name.toLowerCase(), code);
    }
    if (l.balancePaise) ledgerOpenings.set(code, (ledgerOpenings.get(code) ?? 0) + l.balancePaise);
  }

  const items: Row[] = masters.stockItems.map((s) => ({
    name: s.name, kind: s.kind ?? 'goods', hsn_sac: s.hsn && /^\d{4,8}$/.test(s.hsn) ? s.hsn : null,
    unit: s.unit ? (UNITS[s.unit.toLowerCase().replace(/[^a-z]/g, '')] ?? 'OTH') : 'NOS',
    gst_rate: s.gstRatePct, track_stock: s.kind === 'service' ? 'no' : 'yes',
    sale_price: s.salePricePaise ? (s.salePricePaise / 100).toFixed(2) : null,
    purchase_price: s.purchasePricePaise ? (s.purchasePricePaise / 100).toFixed(2) : null,
    opening_qty: s.kind === 'service' ? null : s.qty || null,
    opening_rate: s.kind !== 'service' && s.qty ? (s.valuePaise / s.qty / 100).toFixed(4) : null,
  }));

  const outcomes: ImportOutcome[] = [];
  outcomes.push(await runImport(trx, ctx, 'contacts', contacts));
  outcomes.push(await runImport(trx, ctx, 'accounts', accountRows));
  outcomes.push(await runImport(trx, ctx, 'items', items));

  // Bank and cash accounts carry their own opening, set on the account.
  const bankOut: ImportOutcome = { kind: 'accounts', label: 'Bank and cash accounts', rows: banks.length, created: 0, skipped: 0, errors: [], notes: [] };
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

/** Where a Tally ledger's lines go here: an account, and the customer or vendor for a party. */
type Resolved = { accountId: number; contactId: number | null };
/** One voucher, in the shape both sources give: lines debit-positive, in paise. */
interface PostableVoucher {
  guid: string; voucherType: string; baseType: string; number: string | null; date: string; narration: string | null;
  lines: { ledger: string; debitPaise: number; creditPaise: number }[];
}

/** A file is not a connected company: its vouchers are kept apart from any connector's under this id. */
export const FILE_COMPANY_ID = 0;
/** QuickBooks files: their transactions are kept apart from Tally's under this id (the table predates QuickBooks). */
export const QUICKBOOKS_COMPANY_ID = -1;

const SALES_SIDE = /^(Sales|Credit Note|Receipt)$/;
const PURCHASE_SIDE = /^(Purchase|Debit Note|Payment)$/;

/** What this book already holds, to name a Tally ledger's account from. */
async function bookIndex(trx: Trx, orgId: number) {
  const [accounts, contacts, banks] = await Promise.all([
    trx.selectFrom('accounts').select(['id', 'code', 'name']).where('org_id', '=', orgId).execute(),
    trx.selectFrom('contacts').select(['id', 'display_name', 'kind']).where('org_id', '=', orgId).execute(),
    trx.selectFrom('bank_accounts').select(['name', 'ledger_account_id']).where('org_id', '=', orgId).execute(),
  ]);
  return {
    byCode: new Map(accounts.map((a) => [a.code, a.id])),
    byName: new Map(accounts.map((a) => [a.name.toLowerCase(), a.id])),
    contactBy: new Map(contacts.map((c) => [c.display_name.toLowerCase(), { id: c.id, kind: c.kind }])),
    bankBy: new Map(banks.map((b) => [b.name.toLowerCase(), b.ledger_account_id])),
  };
}

/**
 * Post vouchers as journal entries, each once. A voucher with a ledger that
 * names no account here is left out and named, never guessed at; one dated
 * before the books start is in the opening balances already.
 */
async function postVouchers(
  trx: Trx, ctx: ImportContext, companyId: number, start: string, vouchers: PostableVoucher[],
  resolve: (ledger: string, v: PostableVoucher, line: PostableVoucher['lines'][number]) => Resolved | null,
  source = 'Tally',
): Promise<ImportOutcome> {
  const out: ImportOutcome = { kind: 'journals', rows: 0, created: 0, skipped: 0, errors: [], notes: [] };
  const done = await trx.selectFrom('tally_voucher_imports').select('guid')
    .where('org_id', '=', ctx.orgId).where('company_id', '=', companyId).execute();
  const imported = new Set(done.map((d) => d.guid));
  const unresolved = new Set<string>();
  for (const [i, v] of vouchers.entries()) {
    out.rows++;
    const label = `${v.voucherType}${v.number ? ` ${v.number}` : ''} of ${v.date}`;
    if (imported.has(v.guid)) { out.skipped++; continue; }
    const placed = v.lines.map((l) => ({ l, r: resolve(l.ledger, v, l) }));
    const missing = [...new Set(placed.filter((p) => !p.r).map((p) => p.l.ledger))];
    if (missing.length) {
      missing.forEach((m) => unresolved.add(m));
      out.errors.push({ row: i + 1, message: `${label}: no account for ${missing.join(', ')}.` });
      continue;
    }
    try {
      const entry = await postEntry(trx, {
        orgId: ctx.orgId, branchId: ctx.branchId, date: v.date, module: 'accountant',
        sourceType: 'tally_import', userId: ctx.userId,
        memo: `${source} ${v.voucherType}${v.number ? ` ${v.number}` : ''}${v.narration ? ` — ${v.narration}` : ''}`.slice(0, 500),
        lines: placed.map(({ l, r }) => ({
          accountId: r!.accountId, contactId: r!.contactId, description: l.ledger,
          debit: l.debitPaise, credit: l.creditPaise,
        })),
      });
      await trx.insertInto('tally_voucher_imports').values({ org_id: ctx.orgId, company_id: companyId, guid: v.guid, journal_entry_id: entry.id }).execute();
      imported.add(v.guid);
      out.created++;
    } catch (err) {
      out.errors.push({ row: i + 1, message: `${label}: ${(err as Error).message}` });
    }
  }
  if (unresolved.size) {
    out.notes.push(
      `${unresolved.size} ${source} ${source === 'Tally' ? 'ledger' : 'account'}(s) have no account here yet: ${[...unresolved].slice(0, 8).join(', ')}${unresolved.size > 8 ? '…' : ''}. ` +
        (source === 'Tally'
          ? 'Bring the masters across first (Export → Masters in TallyPrime), or add them to the chart of accounts with the same name.'
          : 'Bring the chart of accounts, customer and vendor lists along, or add them here with the same names.'),
    );
  }
  out.notes.push(
    `Vouchers from ${start}; anything earlier is in the opening balances. ` +
      'They post as journal entries and are not part of the GST returns, which are filed from documents raised here.',
  );
  return out;
}

export async function importTallyVouchers(
  trx: Trx, ctx: ImportContext, companyId: number, range: { from?: string | null; to?: string | null } = {},
): Promise<ImportOutcome> {
  const company = await trx.selectFrom('tally_companies').select(['id', 'name'])
    .where('id', '=', companyId).where('org_id', '=', ctx.orgId).executeTakeFirst();
  if (!company) throw new Error('That Tally company is not connected to this book.');

  const start = (await booksStartDate(trx, ctx.orgId)).date;
  const from = range.from && range.from > start ? range.from : start;

  const [groups, ledgers, book] = await Promise.all([
    trx.selectFrom('tally_groups').select(['name', 'parent']).where('company_id', '=', companyId).execute(),
    trx.selectFrom('tally_ledgers').select(['name', 'parent', 'closing_paise']).where('company_id', '=', companyId).execute(),
    bookIndex(trx, ctx.orgId),
  ]);
  const groupMap = new Map(groups.map((g) => [g.name, g.parent ?? '']));

  // Each Tally ledger, resolved once, through its group.
  const resolved = new Map<string, Resolved | null>();
  for (const l of ledgers) {
    const key = l.name.toLowerCase();
    const p = primaryOf(groupMap, l.parent);
    let r: Resolved | null = null;
    if (p?.kind === 'debtor' || p?.kind === 'creditor') {
      const contactId = book.contactBy.get(key)?.id ?? null;
      const accountId = book.byCode.get(p.kind === 'debtor' ? CODE.AR : CODE.AP) ?? null;
      r = contactId && accountId ? { accountId, contactId } : null;
    } else if (p?.kind === 'bank' || p?.kind === 'cash') {
      const accountId = book.bankBy.get(key) ?? null;
      r = accountId ? { accountId, contactId: null } : null;
    } else if (p?.kind === 'tax') {
      const code = taxCode(l.name, Number(l.closing_paise));
      const accountId = (code && book.byCode.get(code)) || book.byName.get(key) || null;
      r = accountId ? { accountId, contactId: null } : null;
    } else {
      const accountId = book.byName.get(key) ?? (key === 'profit & loss a/c' ? book.byCode.get(CODE.RETAINED) ?? null : null);
      r = accountId ? { accountId, contactId: null } : null;
    }
    resolved.set(key, r);
  }

  const rows = await trx.selectFrom('tally_vouchers')
    .select(['id', 'guid', 'voucher_type', 'base_type', 'number', 'date', 'narration'])
    .where('company_id', '=', companyId).where('is_cancelled', '=', 0).where('is_optional', '=', 0)
    .where('amount_paise', '>', 0).where('date', '>=', from)
    .$if(!!range.to, (q) => q.where('date', '<=', range.to!))
    .orderBy('date').orderBy('id').execute();
  const entries = rows.length
    ? await trx.selectFrom('tally_voucher_entries').select(['voucher_id', 'line_no', 'ledger', 'debit_paise', 'credit_paise'])
      .where('voucher_id', 'in', rows.map((v) => v.id)).orderBy('voucher_id').orderBy('line_no').execute()
    : [];
  const linesOf = new Map<number, typeof entries>();
  for (const e of entries) linesOf.set(e.voucher_id, [...(linesOf.get(e.voucher_id) ?? []), e]);

  const vouchers: PostableVoucher[] = rows.map((v) => ({
    guid: v.guid, voucherType: v.voucher_type, baseType: v.base_type, number: v.number,
    date: String(v.date).slice(0, 10), narration: v.narration,
    lines: (linesOf.get(v.id) ?? []).map((l) => ({ ledger: l.ledger, debitPaise: Number(l.debit_paise), creditPaise: Number(l.credit_paise) })),
  }));
  const out = await postVouchers(trx, ctx, companyId, from, vouchers, (ledger) => resolved.get(ledger.toLowerCase()) ?? null);
  if (range.to) out.notes[out.notes.length - 1] = out.notes[out.notes.length - 1].replace(`Vouchers from ${from};`, `Vouchers from ${from} to ${range.to};`);
  return out;
}

/**
 * Vouchers read from Tally files (Export → Transactions). Each ledger is named
 * the way the masters were brought in: through its group, when the same upload
 * carried the masters; otherwise by what this book already has under that name
 * — a customer or vendor, a bank or cash account, a GST or TDS ledger, or an
 * account. Run the same file again and only what is new comes across.
 */
export async function importTallyFileVouchers(
  trx: Trx, ctx: ImportContext, fileVouchers: TallyFileVoucher[], masters?: TallyMasters,
  from: { companyId: number; source: string } = { companyId: FILE_COMPANY_ID, source: 'Tally' },
): Promise<ImportOutcome> {
  const start = (await booksStartDate(trx, ctx.orgId)).date;
  const book = await bookIndex(trx, ctx.orgId);
  const groups = masters?.groups ?? new Map<string, string>();
  const parentOf = new Map((masters?.ledgers ?? []).map((l) => [l.name.toLowerCase(), l.parent]));

  const posting = fileVouchers.filter(postsToBooks);
  const early = posting.filter((v) => v.date < start);
  const vouchers = posting.filter((v) => v.date >= start);

  const resolve = (ledger: string, v: PostableVoucher, line: PostableVoucher['lines'][number]): Resolved | null => {
    const key = ledger.toLowerCase();
    if (key === 'profit & loss a/c') return accountOnly(book.byCode.get(CODE.RETAINED));
    const parent = parentOf.get(key);
    const p = parent !== undefined ? primaryOf(groups, parent) : null;
    const contact = book.contactBy.get(key);
    // A party: by its group when the masters came along, else by the customer or vendor of that name.
    if (p?.kind === 'debtor' || p?.kind === 'creditor' || (!p && contact)) {
      if (!contact) return null;
      const receivable = p ? p.kind === 'debtor'
        : contact.kind === 'customer' ? true
          : contact.kind === 'vendor' ? false
            : !PURCHASE_SIDE.test(v.baseType);
      const accountId = book.byCode.get(receivable ? CODE.AR : CODE.AP);
      return accountId ? { accountId, contactId: contact.id } : null;
    }
    if (p?.kind === 'bank' || p?.kind === 'cash' || (!p && book.bankBy.has(key))) return accountOnly(book.bankBy.get(key));
    const looksTax = p?.kind === 'tax' || (!p && /\b(c|s|ut|i)gst\b|cess|\btds\b|\btcs\b|integrated tax|central tax|state tax/i.test(ledger));
    if (looksTax && /\btds\b|\btcs\b/i.test(ledger)) {
      // Tax deducted or collected: a debit is owed to us (receivable), a credit is ours to deposit (payable).
      const code = taxCode(ledger, line.debitPaise > 0 ? 1 : -1);
      return accountOnly((code && book.byCode.get(code)) || book.byName.get(key));
    }
    if (looksTax) {
      // A single "CGST" ledger in Tally serves both ways: which side of the books it is, the voucher says.
      const input = /input|itc/i.test(ledger) ? true : /output/i.test(ledger) ? false
        : PURCHASE_SIDE.test(v.baseType) && v.baseType !== 'Payment' ? true
          : SALES_SIDE.test(v.baseType) && v.baseType !== 'Receipt' ? false
            : line.debitPaise > 0;
      const code = taxCode(input ? `input ${ledger}` : ledger.replace(/input|itc/gi, ''), input ? 1 : -1);
      return accountOnly((code && book.byCode.get(code)) || book.byName.get(key));
    }
    return accountOnly(book.byName.get(key));
  };

  const out = await postVouchers(trx, ctx, from.companyId, start, vouchers, resolve, from.source);
  const left = fileVouchers.length - posting.length;
  if (early.length) out.notes.unshift(`${early.length} voucher(s) are dated before the books start (${start}): they are in the opening balances, so they were left out.`);
  if (left) out.notes.unshift(`${left} voucher(s) in the file post nothing to the books (cancelled, optional, orders, stock or memo vouchers, or entries that do not balance), so they were left out.`);
  out.rows += early.length;
  out.skipped += early.length;
  return out;
}

const accountOnly = (accountId: number | null | undefined): Resolved | null => (accountId ? { accountId, contactId: null } : null);

export { NON_ACCOUNTING_TYPES };
