import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// This app's books, written as TallyPrime vouchers.
//
// For the business that bills here while its accountant keeps the statutory
// books in Tally. Every posted document already is a balanced journal entry —
// which is exactly what a Tally voucher is — so the export is a translation,
// not a second set of books:
//
//   our journal entry   →  a voucher, its type taken from what made the entry
//   our journal line    →  a ledger entry, Dr or Cr
//   our account         →  a Tally ledger under a Tally group
//   our customer/vendor →  a party ledger under Sundry Debtors / Creditors
//   an invoice or bill  →  a new bill reference, so the party's outstanding
//                          statement in Tally matches ours
//   a payment           →  set against the same invoices we allocated it to
//
// Two things make the result trustworthy rather than merely plausible. The
// vouchers are built from the journal, so what Tally receives is what the
// books say — never a summary that can drift. And each voucher carries a
// REMOTEID of its journal entry, so importing the same file twice updates the
// same vouchers instead of doubling the month.
//
// Money is integer paise here and rupees in the file. Tally writes a debit as
// a negative amount, which is its convention, not a mistake.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor } from '../db';
import { toPaiseFromSql } from '../money-sql';
import { stateName } from '../../tax/gst';
import { CODE } from '../ledger/chart-of-accounts';
import { TALLY_NAME_MAX, type LedgerMapRow, type TallyExportSummary } from '../../tally/export';

// ── What an account is called in Tally ───────────────────────────────────────

interface AccountRow {
  id: number;
  code: string;
  name: string;
  type: string;
  subtype: string | null;
}

/** Which Tally group an account belongs under, from what the account is. */
export function defaultLedger(a: AccountRow): { ledgerName: string; parentGroup: string } {
  const name = a.name.slice(0, TALLY_NAME_MAX);
  const group = (() => {
    // A few accounts have a group of their own regardless of how they are typed.
    if (a.code === CODE.RETAINED || a.code === CODE.OPENING_BALANCE_EQUITY) return 'Reserves & Surplus';
    if (a.code === CODE.COGS || a.code === CODE.PURCHASES) return 'Purchase Accounts';
    if (a.code === CODE.FREIGHT) return 'Direct Expenses';
    if (a.code === CODE.DISCOUNT_ALLOWED) return 'Indirect Expenses';
    if ([CODE.OTHER_INCOME, CODE.DISCOUNT_RECEIVED, CODE.PROFIT_ON_ASSET_SALE, CODE.FX_GAIN].includes(a.code as never)) return 'Indirect Incomes';
    if (a.code === CODE.SECURED_LOANS) return 'Secured Loans';
    if (a.code === CODE.UNSECURED_LOANS) return 'Unsecured Loans';

    switch (a.subtype) {
      case 'bank': return 'Bank Accounts';
      case 'cash': return 'Cash-in-Hand';
      case 'credit_card': case 'bank_od': return 'Bank OD A/c';
      case 'loan': return 'Loans (Liability)';
      case 'provision': return 'Provisions';
      case 'deposit': return a.type === 'asset' ? 'Deposits (Asset)' : 'Current Liabilities';
      case 'advance': return 'Loans & Advances (Asset)';
      case 'investment': case 'current_investment': return 'Investments';
      case 'misc_expense': return 'Misc. Expenses (ASSET)';
      case 'branch': return 'Branch / Divisions';
      case 'suspense': return 'Suspense A/c';
      case 'drawings': return 'Capital Account';
      case 'tax': return 'Duties & Taxes';
      case 'receivable': return 'Sundry Debtors';
      case 'payable': return 'Sundry Creditors';
      case 'stock': return 'Stock-in-Hand';
      case 'fixed_asset': return 'Fixed Assets';
      case 'current': return a.type === 'asset' ? 'Current Assets' : 'Current Liabilities';
      default: break;
    }
    switch (a.type) {
      case 'asset': return 'Current Assets';
      case 'liability': return 'Current Liabilities';
      case 'equity': return 'Capital Account';
      case 'income': return 'Sales Accounts';
      default: return 'Indirect Expenses';
    }
  })();
  return { ledgerName: name, parentGroup: group };
}

/** Which GST head a tax ledger is, so Tally's own GST reports pick it up. */
function dutyHead(code: string): 'CGST' | 'SGST' | 'IGST' | 'Cess' | null {
  if (code === CODE.GST_CGST || code === CODE.ITC_CGST) return 'CGST';
  if (code === CODE.GST_SGST || code === CODE.ITC_SGST) return 'SGST';
  if (code === CODE.GST_IGST || code === CODE.ITC_IGST) return 'IGST';
  if (code === CODE.GST_CESS || code === CODE.ITC_CESS) return 'Cess';
  return null;
}

const GST_REGISTRATION: Record<string, string> = {
  registered: 'Regular', composition: 'Composition', unregistered: 'Unregistered',
  overseas: 'Unknown', sez: 'Regular', sez_developer: 'Regular', deemed_export: 'Regular', uin: 'Regular',
};

// ── The map, as the screen shows it ──────────────────────────────────────────

export async function ledgerMap(ex: Executor, orgId: number): Promise<Map<number, { ledgerName: string; parentGroup: string; isDefault: boolean }>> {
  const [accounts, overrides] = await Promise.all([
    ex.selectFrom('accounts').select(['id', 'code', 'name', 'type', 'subtype']).where('org_id', '=', orgId).execute(),
    ex.selectFrom('tally_ledger_map').select(['account_id', 'ledger_name', 'parent_group']).where('org_id', '=', orgId).execute(),
  ]);
  const byAccount = new Map(overrides.map((o) => [Number(o.account_id), o]));
  const map = new Map<number, { ledgerName: string; parentGroup: string; isDefault: boolean }>();
  for (const a of accounts) {
    const id = Number(a.id);
    const override = byAccount.get(id);
    map.set(id, override
      ? { ledgerName: override.ledger_name, parentGroup: override.parent_group, isDefault: false }
      : { ...defaultLedger({ ...a, id }), isDefault: true });
  }
  return map;
}

export async function ledgerMapRows(ex: Executor, orgId: number, used: Map<number, number>): Promise<LedgerMapRow[]> {
  const accounts = await ex
    .selectFrom('accounts').select(['id', 'code', 'name', 'type', 'subtype'])
    .where('org_id', '=', orgId).where('is_active', '=', 1).orderBy('code').execute();
  const map = await ledgerMap(ex, orgId);
  return accounts.map((a) => {
    const m = map.get(Number(a.id))!;
    return {
      accountId: String(a.id), code: a.code, accountName: a.name, accountType: a.type,
      ledgerName: m.ledgerName, parentGroup: m.parentGroup, isDefault: m.isDefault,
      used: used.get(Number(a.id)) ?? 0,
    };
  });
}

// ── Collecting the period ────────────────────────────────────────────────────

export interface ExportOptions {
  from: string;
  to: string;
  branchId?: number | null;
}

interface BillAllocation {
  name: string;
  billType: 'New Ref' | 'Agst Ref' | 'On Account';
  /** Debits positive, as everywhere in this app. */
  paise: number;
}

interface VoucherEntry {
  ledger: string;
  paise: number;
  bills: BillAllocation[];
}

export interface ExportVoucher {
  remoteId: string;
  date: string;
  voucherType: string;
  number: string;
  reference: string | null;
  narration: string | null;
  partyLedger: string | null;
  entries: VoucherEntry[];
}

export interface ExportLedger {
  name: string;
  parent: string;
  isParty: boolean;
  gstin?: string | null;
  registrationType?: string | null;
  state?: string | null;
  pan?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  dutyHead?: 'CGST' | 'SGST' | 'IGST' | 'Cess' | null;
}

export interface ExportData {
  from: string;
  to: string;
  branchId: number | null;
  vouchers: ExportVoucher[];
  ledgers: ExportLedger[];
  warnings: string[];
  /** Account id → how many vouchers name it, for the mapping screen. */
  used: Map<number, number>;
}

/** Which Tally voucher type an entry becomes. */
function voucherTypeFor(sourceType: string, lines: { subtype: string | null; paise: number }[]): string {
  const money = lines.filter((l) => l.subtype === 'bank' || l.subtype === 'cash' || l.subtype === 'credit_card');
  const intoMoney = money.some((l) => l.paise > 0);
  const outOfMoney = money.some((l) => l.paise < 0);

  switch (sourceType) {
    case 'invoice': return 'Sales';
    case 'bill': return 'Purchase';
    case 'credit_note': return 'Credit Note';
    case 'vendor_credit': return 'Debit Note';
    case 'payment_received': case 'retainer': case 'vendor_credit_refund': return 'Receipt';
    case 'payment_made': case 'credit_note_refund': return 'Payment';
    case 'transfer': return 'Contra';
    case 'expense':
      // An expense paid on the spot is a payment; one left on credit is a journal.
      return outOfMoney ? 'Payment' : 'Journal';
    case 'bank_txn':
      if (money.length > 1 && intoMoney && outOfMoney) return 'Contra';
      return intoMoney ? 'Receipt' : 'Payment';
    default: return 'Journal';
  }
}

/** Where a document's own number lives, per kind of entry. */
const NUMBER_SOURCE: Record<string, { table: 'invoices' | 'bills' | 'credit_notes' | 'vendor_credits' | 'payments' | 'expenses' | 'retainer_invoices'; column: string }> = {
  invoice: { table: 'invoices', column: 'number' },
  bill: { table: 'bills', column: 'internal_no' },
  credit_note: { table: 'credit_notes', column: 'number' },
  credit_note_refund: { table: 'credit_notes', column: 'number' },
  vendor_credit: { table: 'vendor_credits', column: 'number' },
  vendor_credit_refund: { table: 'vendor_credits', column: 'number' },
  payment_received: { table: 'payments', column: 'number' },
  payment_made: { table: 'payments', column: 'number' },
  expense: { table: 'expenses', column: 'number' },
  retainer: { table: 'retainer_invoices', column: 'number' },
  retainer_application: { table: 'retainer_invoices', column: 'number' },
};

async function documentNumbers(ex: Executor, orgId: number, entries: { source_type: string; source_id: number | null }[]) {
  const wanted = new Map<string, Set<number>>();
  for (const e of entries) {
    const source = NUMBER_SOURCE[e.source_type];
    if (!source || !e.source_id) continue;
    const key = `${source.table}:${source.column}`;
    (wanted.get(key) ?? wanted.set(key, new Set()).get(key)!).add(Number(e.source_id));
  }
  const numbers = new Map<string, string>();
  for (const [key, ids] of wanted) {
    const [table, column] = key.split(':') as [keyof typeof NUMBER_SOURCE extends never ? never : string, string];
    const rows = await ex
      .selectFrom(table as 'invoices')
      .select(['id', sql<string>`${sql.ref(column)}`.as('number')])
      .where('org_id', '=', orgId)
      .where('id', 'in', [...ids])
      .execute();
    for (const r of rows) numbers.set(`${table}:${r.id}`, r.number);
  }
  return numbers;
}

/** What each payment was set against, so Tally can close the same bills. */
async function paymentAllocations(ex: Executor, orgId: number, paymentIds: number[]) {
  if (!paymentIds.length) return new Map<number, { number: string; paise: number }[]>();
  const rows = await ex
    .selectFrom('payment_allocations as pa')
    .leftJoin('invoices as i', (join) => join.onRef('i.id', '=', 'pa.target_id').on('pa.target_type', '=', 'invoice'))
    .leftJoin('bills as b', (join) => join.onRef('b.id', '=', 'pa.target_id').on('pa.target_type', '=', 'bill'))
    .select(['pa.payment_id', 'pa.amount', 'i.number as invoice_number', 'b.internal_no as bill_number'])
    .where('pa.org_id', '=', orgId)
    .where('pa.payment_id', 'in', paymentIds)
    .execute();
  const byPayment = new Map<number, { number: string; paise: number }[]>();
  for (const r of rows) {
    const number = r.invoice_number ?? r.bill_number;
    if (!number) continue;
    const id = Number(r.payment_id);
    const list = byPayment.get(id) ?? [];
    list.push({ number, paise: toPaiseFromSql(r.amount) });
    byPayment.set(id, list);
  }
  return byPayment;
}

export async function buildExport(ex: Executor, orgId: number, opts: ExportOptions): Promise<ExportData> {
  const branchId = opts.branchId ?? null;
  const entries = await ex
    .selectFrom('journal_entries')
    .select(['id', 'entry_no', 'entry_date', 'memo', 'source_type', 'source_id'])
    .where('org_id', '=', orgId)
    .where('entry_date', '>=', opts.from)
    .where('entry_date', '<=', opts.to)
    .$if(branchId !== null, (qb) => qb.where('branch_id', '=', branchId!))
    .orderBy('entry_date')
    .orderBy('id')
    .execute();

  const map = await ledgerMap(ex, orgId);
  const used = new Map<number, number>();
  if (!entries.length) {
    return { from: opts.from, to: opts.to, branchId, vouchers: [], ledgers: [], warnings: [], used };
  }

  const entryIds = entries.map((e) => Number(e.id));
  const lines = await ex
    .selectFrom('journal_lines as jl')
    .innerJoin('accounts as a', 'a.id', 'jl.account_id')
    .leftJoin('contacts as c', 'c.id', 'jl.contact_id')
    .select([
      'jl.entry_id', 'jl.line_no', 'jl.account_id', 'jl.debit', 'jl.credit', 'jl.description',
      'a.code as account_code', 'a.name as account_name', 'a.type as account_type', 'a.subtype as account_subtype',
      'c.id as contact_id', 'c.display_name as contact_name', 'c.kind as contact_kind', 'c.gstin', 'c.pan',
      'c.state_code', 'c.gst_treatment', 'c.email', 'c.phone', 'c.billing_address',
    ])
    .where('jl.org_id', '=', orgId)
    .where('jl.entry_id', 'in', entryIds)
    .orderBy('jl.entry_id')
    .orderBy('jl.line_no')
    .execute();

  const numbers = await documentNumbers(ex, orgId, entries);
  const paymentIds = entries
    .filter((e) => (e.source_type === 'payment_received' || e.source_type === 'payment_made') && e.source_id)
    .map((e) => Number(e.source_id));
  const allocations = await paymentAllocations(ex, orgId, paymentIds);

  const linesByEntry = new Map<number, typeof lines>();
  for (const l of lines) {
    const id = Number(l.entry_id);
    const list = linesByEntry.get(id) ?? [];
    list.push(l);
    linesByEntry.set(id, list);
  }

  const ledgers = new Map<string, ExportLedger>();
  const warnings: string[] = [];
  const truncated = new Set<string>();
  const vouchers: ExportVoucher[] = [];

  for (const entry of entries) {
    const entryLines = linesByEntry.get(Number(entry.id)) ?? [];
    if (!entryLines.length) continue;

    const priced = entryLines.map((l) => {
      const paise = toPaiseFromSql(l.debit) - toPaiseFromSql(l.credit);
      // A party line is one on receivables or payables that names a contact:
      // in Tally that is the party's own ledger, not a control account.
      const isParty = !!l.contact_id && (l.account_subtype === 'receivable' || l.account_subtype === 'payable');
      const accountLedger = map.get(Number(l.account_id))!;
      let ledger = accountLedger.ledgerName;
      let parent = accountLedger.parentGroup;
      if (isParty) {
        ledger = (l.contact_name ?? '').slice(0, TALLY_NAME_MAX);
        parent = l.account_subtype === 'receivable' ? 'Sundry Debtors' : 'Sundry Creditors';
      }
      if (!isParty) used.set(Number(l.account_id), (used.get(Number(l.account_id)) ?? 0) + 1);
      if ((isParty ? (l.contact_name ?? '') : accountLedger.ledgerName).length > TALLY_NAME_MAX) truncated.add(ledger);

      if (!ledgers.has(ledger)) {
        ledgers.set(ledger, isParty
          ? {
            name: ledger, parent, isParty: true,
            gstin: l.gstin, registrationType: GST_REGISTRATION[l.gst_treatment ?? 'unregistered'] ?? 'Unknown',
            state: l.state_code ? stateName(l.state_code) : null, pan: l.pan,
            email: l.email, phone: l.phone, address: l.billing_address,
          }
          : { name: ledger, parent, isParty: false, dutyHead: dutyHead(l.account_code) });
      }
      return { ledger, parent, paise, isParty, subtype: l.account_subtype, description: l.description };
    });

    const source = NUMBER_SOURCE[entry.source_type];
    const docNumber = source && entry.source_id ? numbers.get(`${source.table}:${entry.source_id}`) : undefined;
    const number = docNumber ?? `JV-${entry.entry_no}`;
    const voucherType = voucherTypeFor(entry.source_type, priced);
    const party = priced.find((l) => l.isParty);

    // Bill references: what makes a party's outstanding in Tally agree with ours.
    const bills = (line: (typeof priced)[number]): BillAllocation[] => {
      if (!line.isParty) return [];
      if (entry.source_type === 'invoice' || entry.source_type === 'bill') {
        return [{ name: number, billType: 'New Ref', paise: line.paise }];
      }
      if (entry.source_type === 'payment_received' || entry.source_type === 'payment_made') {
        const against = allocations.get(Number(entry.source_id)) ?? [];
        const sign = Math.sign(line.paise);
        const out: BillAllocation[] = [];
        let left = Math.abs(line.paise);
        for (const a of against) {
          const amount = Math.min(a.paise, left);
          if (amount <= 0) continue;
          out.push({ name: a.number, billType: 'Agst Ref', paise: sign * amount });
          left -= amount;
        }
        // Anything not set against a document is an advance, and says so.
        if (left > 0) out.push({ name: number, billType: 'On Account', paise: sign * left });
        return out;
      }
      return [{ name: number, billType: 'New Ref', paise: line.paise }];
    };

    vouchers.push({
      remoteId: `rekonza-${orgId}-${entry.id}`,
      date: String(entry.entry_date).slice(0, 10),
      voucherType,
      number,
      reference: docNumber ?? null,
      narration: entry.memo,
      partyLedger: party?.ledger ?? null,
      entries: priced.map((l) => ({ ledger: l.ledger, paise: l.paise, bills: bills(l) })),
    });
  }

  // Two different things becoming one Tally ledger is the one mistake that is
  // hard to undo after an import, so it is said plainly before the download.
  const byName = new Map<string, Set<string>>();
  for (const l of lines) {
    const accountLedger = map.get(Number(l.account_id))!;
    const key = accountLedger.ledgerName.toLowerCase();
    (byName.get(key) ?? byName.set(key, new Set()).get(key)!).add(`account:${l.account_id}`);
    if (l.contact_id && (l.account_subtype === 'receivable' || l.account_subtype === 'payable')) {
      const party = (l.contact_name ?? '').slice(0, TALLY_NAME_MAX).toLowerCase();
      (byName.get(party) ?? byName.set(party, new Set()).get(party)!).add(`contact:${l.contact_id}`);
    }
  }
  for (const [name, owners] of byName) {
    if (owners.size > 1) warnings.push(`More than one account or party is called "${name}". They will become one ledger in Tally — rename one of them first.`);
  }
  for (const name of truncated) warnings.push(`"${name}" was shortened to ${TALLY_NAME_MAX} characters, which is Tally's limit for a ledger name.`);

  return { from: opts.from, to: opts.to, branchId, vouchers, ledgers: [...ledgers.values()], warnings, used };
}

// ── The files Tally imports ──────────────────────────────────────────────────

// Tally stops reading a file at a control character it did not write itself,
// so they are dropped rather than escaped.
const CONTROL = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(8)}${String.fromCharCode(11)}${String.fromCharCode(12)}${String.fromCharCode(14)}-${String.fromCharCode(31)}]`,
  'g',
);

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(CONTROL, '');

const tag = (name: string, value: string | null | undefined) => (value ? `<${name}>${esc(value)}</${name}>` : '');

/** Paise, debits positive, as Tally writes them: rupees with debits negative. */
const rupees = (paise: number) => (-paise / 100).toFixed(2);

const tallyDate = (iso: string) => iso.slice(0, 10).replace(/-/g, '');

function envelope(reportName: string, body: string): string {
  return (
    '<?xml version="1.0" encoding="utf-8"?>\r\n' +
    '<ENVELOPE>\r\n<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>\r\n<BODY><IMPORTDATA>\r\n' +
    `<REQUESTDESC><REPORTNAME>${reportName}</REPORTNAME></REQUESTDESC>\r\n<REQUESTDATA>\r\n` +
    body +
    '\r\n</REQUESTDATA>\r\n</IMPORTDATA></BODY>\r\n</ENVELOPE>\r\n'
  );
}

/** The ledgers, for importing before the vouchers. Ledgers Tally already has are left alone. */
export function mastersXml(data: ExportData): string {
  const messages = data.ledgers.map((l) => {
    const gst = l.isParty
      ? tag('PARTYGSTIN', l.gstin) + tag('GSTREGISTRATIONTYPE', l.registrationType) + tag('LEDSTATENAME', l.state) +
        tag('COUNTRYNAME', 'India') + tag('INCOMETAXNUMBER', l.pan) + tag('EMAIL', l.email) + tag('LEDGERPHONE', l.phone) +
        (l.address ? `<ADDRESS.LIST TYPE="String"><ADDRESS>${esc(l.address.slice(0, 250))}</ADDRESS></ADDRESS.LIST>` : '')
      : l.dutyHead
        ? '<TAXTYPE>GST</TAXTYPE>' + tag('GSTDUTYHEAD', l.dutyHead)
        : '';
    return (
      `<TALLYMESSAGE xmlns:UDF="TallyUDF">\r\n<LEDGER NAME="${esc(l.name)}" RESERVEDNAME="" ACTION="Create">\r\n` +
      `<NAME.LIST><NAME>${esc(l.name)}</NAME></NAME.LIST>\r\n` +
      tag('PARENT', l.parent) +
      `<ISBILLWISEON>${l.isParty ? 'Yes' : 'No'}</ISBILLWISEON><ISCOSTCENTRESON>No</ISCOSTCENTRESON>\r\n` +
      gst +
      '\r\n</LEDGER>\r\n</TALLYMESSAGE>'
    );
  });
  return envelope('All Masters', messages.join('\r\n'));
}

/** The vouchers. Importing the same file twice updates the same vouchers, by REMOTEID. */
export function vouchersXml(data: ExportData): string {
  const messages = data.vouchers.map((v) => {
    const entries = v.entries.map((e) => {
      const bills = e.bills
        .map((b) =>
          '<BILLALLOCATIONS.LIST>' +
          `<NAME>${esc(b.name)}</NAME><BILLTYPE>${b.billType}</BILLTYPE>` +
          `<AMOUNT>${rupees(b.paise)}</AMOUNT>` +
          '</BILLALLOCATIONS.LIST>')
        .join('');
      return (
        '<ALLLEDGERENTRIES.LIST>' +
        `<LEDGERNAME>${esc(e.ledger)}</LEDGERNAME>` +
        `<ISDEEMEDPOSITIVE>${e.paise > 0 ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>` +
        `<AMOUNT>${rupees(e.paise)}</AMOUNT>` +
        bills +
        '</ALLLEDGERENTRIES.LIST>'
      );
    });
    return (
      `<TALLYMESSAGE xmlns:UDF="TallyUDF">\r\n` +
      `<VOUCHER REMOTEID="${esc(v.remoteId)}" VCHTYPE="${esc(v.voucherType)}" ACTION="Create" OBJVIEW="Accounting Voucher View">\r\n` +
      `<DATE>${tallyDate(v.date)}</DATE><EFFECTIVEDATE>${tallyDate(v.date)}</EFFECTIVEDATE>` +
      tag('VOUCHERTYPENAME', v.voucherType) +
      tag('VOUCHERNUMBER', v.number) +
      tag('REFERENCE', v.reference) +
      tag('PARTYLEDGERNAME', v.partyLedger) +
      tag('NARRATION', v.narration) +
      '<PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW>\r\n' +
      entries.join('\r\n') +
      '\r\n</VOUCHER>\r\n</TALLYMESSAGE>'
    );
  });
  return envelope('Vouchers', messages.join('\r\n'));
}

// ── What the screen shows before the download ────────────────────────────────

export async function exportSummary(ex: Executor, orgId: number, opts: ExportOptions): Promise<TallyExportSummary> {
  const data = await buildExport(ex, orgId, opts);
  const byType = new Map<string, { count: number; amountPaise: number }>();
  for (const v of data.vouchers) {
    const at = byType.get(v.voucherType) ?? { count: 0, amountPaise: 0 };
    at.count += 1;
    at.amountPaise += v.entries.reduce((t, e) => t + Math.max(e.paise, 0), 0);
    byType.set(v.voucherType, at);
  }
  const last = await ex
    .selectFrom('tally_exports as te')
    .leftJoin('users as u', 'u.id', 'te.exported_by_user_id')
    .select(['te.kind', 'te.to_date', 'te.created_at', 'u.name as by'])
    .where('te.org_id', '=', orgId)
    .orderBy('te.created_at', 'desc')
    .limit(1)
    .executeTakeFirst();

  return {
    from: opts.from,
    to: opts.to,
    branchId: opts.branchId ?? null,
    voucherCount: data.vouchers.length,
    partyCount: data.ledgers.filter((l) => l.isParty).length,
    ledgerCount: data.ledgers.length,
    byType: [...byType.entries()].map(([voucherType, v]) => ({ voucherType, ...v })).sort((a, b) => b.count - a.count),
    warnings: data.warnings,
    lastExport: last
      ? { kind: last.kind, to: String(last.to_date).slice(0, 10), at: new Date(last.created_at).toISOString(), by: last.by ?? null }
      : null,
    map: await ledgerMapRows(ex, orgId, data.used),
  };
}
