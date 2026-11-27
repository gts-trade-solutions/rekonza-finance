import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// What GSTR-7 (GST TDS) and GSTR-8 (e-commerce TCS) share: whether the book
// holds the role and under which registration, whether a month's return is
// marked filed, interest and late fee, the tax paid with the return, the
// amendments made in a later month, and the ledger the return ties to.
//
// Both returns are filed by the 10th of the next month (Rules 66 and 67) and
// both are paid from the electronic cash ledger only: withheld tax is the
// supplier's, so no input credit can ever settle it (s.49(4) reads the credit
// ledger as usable for output tax alone). That is why a payment here is a plain
// Dr payable / Cr bank, with none of GSTR-3B's set-off.
//
// A filed return cannot be revised. A deduction or collection found wrong
// afterwards is corrected in a later month's return, in its amendment table
// (GSTR-7 table 4, GSTR-8 table 4), with the original month, GSTIN and value
// beside the corrected ones. Each such amendment is kept against the document
// in the book's settings store (scope gstr7_amendments / gstr8_amendments,
// keyed by the document's id): a short list, read only by these returns, and
// carrying the original figures so the table never has to guess them back.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor, Trx } from '../db';
import { toPaiseFromSql, toSqlFromPaise } from '../money-sql';
import { badRequest, conflict, notFound } from '../http';
import { postEntry } from '../ledger/posting';
import { CODE, accountIds, requireAccount } from '../ledger/chart-of-accounts';
import { bankLineMatched, plain, recordDeletion, reverseForChange } from '../services/doc-delete';
import { monthLabel } from '../../date-range';
import { headsTotal, withholdingDueDate, type WithholdingHeads } from '../../gst/withholding';

export type WithholdingReturn = 'GSTR7' | 'GSTR8';
export const FILING_KEY: Record<WithholdingReturn, 'gstr7' | 'gstr8'> = { GSTR7: 'gstr7', GSTR8: 'gstr8' };
const LABEL: Record<WithholdingReturn, string> = { GSTR7: 'GSTR-7', GSTR8: 'GSTR-8' };
const PAYABLE: Record<WithholdingReturn, string> = { GSTR7: CODE.GST_TDS_PAYABLE, GSTR8: CODE.GST_TCS_PAYABLE };

export const p = toPaiseFromSql;
export const day = (v: unknown) => (v ? String(v instanceof Date ? v.toISOString() : v).slice(0, 10) : '');
export const MONTH = /^\d{4}-\d{2}$/;

/** First and last day of a 'YYYY-MM'. */
export function monthBounds(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
}

const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

// ── The roles ────────────────────────────────────────────────────────────────

export interface RoleProfile {
  name: string;
  legalName: string;
  branch: { id: number; name: string; gstin: string | null; stateCode: string };
  tds: { on: boolean; gstin: string | null; own: boolean };
  eco: { on: boolean; gstin: string | null; own: boolean };
}

/**
 * Who the book is in these roles. A deductor or an operator files under its
 * own registration (the one with D or C in it); left unset, the primary
 * branch's GSTIN stands in, and the screens say so.
 */
export async function roleProfile(ex: Executor, orgId: number): Promise<RoleProfile> {
  const o = await ex.selectFrom('organizations')
    .select(['name', 'legal_name', 'gst_tds_deductor', 'gst_tds_gstin', 'gst_eco_operator', 'gst_eco_gstin'])
    .where('id', '=', orgId).executeTakeFirstOrThrow();
  const b = await ex.selectFrom('branches').select(['id', 'name', 'gstin', 'state_code'])
    .where('org_id', '=', orgId).orderBy('is_primary', 'desc').orderBy('id').executeTakeFirstOrThrow();
  return {
    name: o.name,
    legalName: o.legal_name ?? o.name,
    branch: { id: b.id, name: b.name, gstin: b.gstin, stateCode: b.state_code },
    tds: { on: !!o.gst_tds_deductor, gstin: o.gst_tds_gstin ?? b.gstin, own: !!o.gst_tds_gstin },
    eco: { on: !!o.gst_eco_operator, gstin: o.gst_eco_gstin ?? b.gstin, own: !!o.gst_eco_gstin },
  };
}

/** The State a role's registration is in: its GSTIN's first two digits, else the branch's. */
export const roleState = (r: RoleProfile, role: 'tds' | 'eco') => (r[role].gstin ?? '').slice(0, 2) || r.branch.stateCode;

// ── Filing ───────────────────────────────────────────────────────────────────

export interface FilingMark { on: string; reference: string | null; by: string | null }

/** The month's return as marked filed (compliance calendar / return status), or null. */
export async function filingOf(ex: Executor, orgId: number, type: WithholdingReturn, month: string): Promise<FilingMark | null> {
  const f = await ex.selectFrom('compliance_filings as f').leftJoin('users as u', 'u.id', 'f.created_by_user_id')
    .select(['f.done_on', 'f.reference', 'u.name'])
    .where('f.org_id', '=', orgId).where('f.item_key', '=', FILING_KEY[type]).where('f.period', '=', month)
    .executeTakeFirst();
  return f ? { on: day(f.done_on), reference: f.reference, by: f.name ?? null } : null;
}

/** Refuse a change to a month whose return is marked filed, saying what to do instead. */
export async function assertNotFiled(ex: Executor, orgId: number, type: WithholdingReturn, month: string, what: string, instead: string) {
  const f = await filingOf(ex, orgId, type, month);
  if (f) {
    throw conflict(
      `${LABEL[type]} for ${monthLabel(month)} is marked filed${f.reference ? ` (ARN ${f.reference})` : ''} on ${f.on}, with ${what} in it. ` +
        `A filed return is not revised: ${instead}`,
    );
  }
}

// ── Interest and late fee ────────────────────────────────────────────────────

export interface InterestLateFee {
  dueDate: string;
  daysLate: number;
  interest: WithholdingHeads;
  lateFee: { cgstPaise: number; sgstPaise: number };
  basis: string;
}

/**
 * Interest under s.50(1) at 18% a year on withheld tax not paid by the due
 * date, for the days it was late (to the day it was paid, or today while it is
 * not); and the late fee for filing late under s.47 —
 *   GSTR-7: ₹25 CGST + ₹25 SGST a day, at most ₹1,000 each (Notification
 *           22/2021-CT, from 1 June 2021);
 *   GSTR-8: ₹100 CGST + ₹100 SGST a day, at most ₹5,000 each (s.47(1)).
 * An estimate: the portal works out the final figures when the return is filed.
 */
export function interestAndLateFee(type: WithholdingReturn, o: {
  month: string; today: string; filedOn: string | null;
  withheld: WithholdingHeads; paid: WithholdingHeads; paidOn: string | null;
}): InterestLateFee {
  const dueDate = withholdingDueDate(o.month);
  const fileDays = Math.max(0, daysBetween(dueDate, o.filedOn ?? o.today));
  const perDay = type === 'GSTR7' ? 25_00 : 100_00;
  const cap = type === 'GSTR7' ? 1_000_00 : 5_000_00;
  const fee = fileDays > 0 ? Math.min(perDay * fileDays, cap) : 0;

  // Paid late: interest on what was paid, for the days after the due date it
  // was paid. Not yet paid: on what is still owed, to today.
  const paidDays = o.paidOn ? Math.max(0, daysBetween(dueDate, o.paidOn)) : 0;
  const owedDays = Math.max(0, daysBetween(dueDate, o.today));
  const head = (k: keyof WithholdingHeads) => {
    const paidLate = paidDays * Math.max(0, o.paid[k]);
    const unpaid = owedDays * Math.max(0, o.withheld[k] - o.paid[k]);
    return Math.round(((paidLate + unpaid) * 18) / (100 * 365));
  };
  const interest = { igstPaise: head('igstPaise'), cgstPaise: head('cgstPaise'), sgstPaise: head('sgstPaise') };
  const lateDays = Math.max(fileDays, paidDays, headsTotal(o.withheld) > headsTotal(o.paid) ? owedDays : 0);
  return {
    dueDate,
    daysLate: lateDays,
    interest,
    lateFee: { cgstPaise: fee, sgstPaise: fee },
    basis: lateDays <= 0
      ? `Due on ${dueDate}: nothing is late.`
      : `${lateDays} day${lateDays === 1 ? '' : 's'} after the due date of ${dueDate}: interest at 18% a year (section 50) on the tax paid late or still unpaid, ` +
        (type === 'GSTR7'
          ? 'and a late fee of ₹25 CGST + ₹25 SGST a day up to ₹1,000 each (Notification 22/2021-CT)'
          : 'and a late fee of ₹100 CGST + ₹100 SGST a day up to ₹5,000 each (section 47)') +
        ' if the return is filed late. An estimate: the portal works out the final figures when you file.',
  };
}

// ── The tax paid with the return ─────────────────────────────────────────────

export interface WithholdingPaymentInput {
  returnType: WithholdingReturn;
  period: string;
  paidOn: string;
  cpin?: string | null;
  bankAccountId: number;
  igstPaise: number;
  cgstPaise: number;
  sgstPaise: number;
  interestPaise?: number;
  lateFeePaise?: number;
  notes?: string | null;
}

export interface WithholdingPaymentView {
  id: string; returnType: WithholdingReturn; period: string; paidOn: string; cpin: string | null;
  bankAccountId: string | null; bankName: string | null;
  igstPaise: number; cgstPaise: number; sgstPaise: number; interestPaise: number; lateFeePaise: number; totalPaise: number;
  journalEntryId: string | null; notes: string | null;
}

export async function paymentFor(ex: Executor, orgId: number, type: WithholdingReturn, month: string): Promise<WithholdingPaymentView | null> {
  const r = await ex.selectFrom('gst_tax_payments as t').leftJoin('bank_accounts as b', 'b.id', 't.bank_account_id')
    .select(['t.id', 't.return_type', 't.period', 't.paid_on', 't.cpin', 't.bank_account_id', 'b.name as bank_name',
      't.cash_igst', 't.cash_cgst', 't.cash_sgst', 't.interest', 't.late_fee', 't.journal_entry_id', 't.notes'])
    .where('t.org_id', '=', orgId).where('t.return_type', '=', type).where('t.period', '=', month)
    .orderBy('t.id').executeTakeFirst();
  if (!r) return null;
  const v = { igstPaise: p(r.cash_igst), cgstPaise: p(r.cash_cgst), sgstPaise: p(r.cash_sgst), interestPaise: p(r.interest), lateFeePaise: p(r.late_fee) };
  return {
    id: String(r.id), returnType: r.return_type as WithholdingReturn, period: r.period, paidOn: day(r.paid_on), cpin: r.cpin,
    bankAccountId: r.bank_account_id ? String(r.bank_account_id) : null, bankName: r.bank_name ?? null,
    ...v, totalPaise: v.igstPaise + v.cgstPaise + v.sgstPaise + v.interestPaise + v.lateFeePaise,
    journalEntryId: r.journal_entry_id ? String(r.journal_entry_id) : null, notes: r.notes,
  };
}

function checkPayment(input: WithholdingPaymentInput) {
  if (!MONTH.test(input.period)) throw badRequest('Say which month the tax is for, as yyyy-mm.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.paidOn)) throw badRequest('Give the date it was paid.');
  if (input.paidOn < `${input.period}-01`) throw badRequest('Tax withheld in a month cannot be paid before the month began.');
  if (input.cpin && !/^[0-9A-Z]{8,20}$/.test(input.cpin.trim().toUpperCase())) throw badRequest('Give the CPIN (14 digits) or the CIN as the challan shows it.');
  const amounts = [input.igstPaise, input.cgstPaise, input.sgstPaise, input.interestPaise ?? 0, input.lateFeePaise ?? 0];
  if (amounts.some((a) => !Number.isInteger(a) || a < 0)) throw badRequest('Amounts are whole paise, none below zero.');
  if (amounts.reduce((t, a) => t + a, 0) <= 0) throw badRequest('A payment pays something.');
}

/** Post the payment: Dr the payable for the tax, Dr Interest and Late Fee, Cr the bank. */
async function postPayment(trx: Trx, orgId: number, userId: number | null, id: number, branchId: number, input: WithholdingPaymentInput) {
  const bank = await trx.selectFrom('bank_accounts').select(['id', 'ledger_account_id', 'name'])
    .where('id', '=', input.bankAccountId).where('org_id', '=', orgId).executeTakeFirst();
  if (!bank) throw badRequest('That bank account is not in this book.');
  const acc = await accountIds(trx, orgId);
  const tax = input.igstPaise + input.cgstPaise + input.sgstPaise;
  const extra = (input.interestPaise ?? 0) + (input.lateFeePaise ?? 0);
  const entry = await postEntry(trx, {
    orgId, branchId, date: input.paidOn, userId, module: 'banking',
    memo: `${LABEL[input.returnType]} tax for ${monthLabel(input.period)} paid${input.cpin ? ` — CPIN ${input.cpin.trim().toUpperCase()}` : ''}`,
    sourceType: 'gst_tax_payment', sourceId: id,
    lines: [
      { accountId: requireAccount(acc, PAYABLE[input.returnType]), debit: tax, description: `IGST ${(input.igstPaise / 100).toFixed(2)}, CGST ${(input.cgstPaise / 100).toFixed(2)}, SGST ${(input.sgstPaise / 100).toFixed(2)}` },
      { accountId: requireAccount(acc, CODE.TAX_INTEREST), debit: extra, description: 'Interest and late fee' },
      { accountId: bank.ledger_account_id, credit: tax + extra, description: `Paid from ${bank.name}` },
    ],
  });
  return entry.id;
}

/** What the month withheld, by head: the documents' own figures plus amendments reported in it. */
export type LiabilityOf = (ex: Executor, orgId: number, month: string) => Promise<WithholdingHeads>;

async function refuseOverpay(trx: Trx, orgId: number, input: WithholdingPaymentInput, liability: LiabilityOf) {
  const owed = await liability(trx, orgId, input.period);
  for (const [k, name] of [['igstPaise', 'IGST'], ['cgstPaise', 'CGST'], ['sgstPaise', 'SGST']] as const) {
    if (input[k] > Math.max(0, owed[k])) {
      throw badRequest(`${name} paid (₹${(input[k] / 100).toFixed(2)}) is more than the ₹${(Math.max(0, owed[k]) / 100).toFixed(2)} withheld in ${monthLabel(input.period)}.`);
    }
  }
}

export async function recordWithholdingPayment(trx: Trx, orgId: number, userId: number | null, input: WithholdingPaymentInput, liability: LiabilityOf) {
  checkPayment(input);
  await assertNotFiled(trx, orgId, input.returnType, input.period, 'its payment', 'record the payment against the month it is for before marking it filed.');
  const have = await paymentFor(trx, orgId, input.returnType, input.period);
  if (have) throw conflict(`The tax for ${monthLabel(input.period)} is already recorded as paid on ${have.paidOn}. Edit that payment instead.`);
  await refuseOverpay(trx, orgId, input, liability);
  const branch = (await roleProfile(trx, orgId)).branch;
  const id = Number((await trx.insertInto('gst_tax_payments').values({
    org_id: orgId, branch_id: branch.id, return_type: input.returnType, period: input.period, paid_on: input.paidOn,
    cpin: input.cpin?.trim().toUpperCase() || null, bank_account_id: input.bankAccountId,
    cash_igst: toSqlFromPaise(input.igstPaise), cash_cgst: toSqlFromPaise(input.cgstPaise), cash_sgst: toSqlFromPaise(input.sgstPaise),
    cash_cess: toSqlFromPaise(0), interest: toSqlFromPaise(input.interestPaise ?? 0), late_fee: toSqlFromPaise(input.lateFeePaise ?? 0),
    notes: input.notes?.trim() || null, created_by_user_id: userId,
  }).executeTakeFirstOrThrow()).insertId);
  const entryId = await postPayment(trx, orgId, userId, id, branch.id, input);
  await trx.updateTable('gst_tax_payments').set({ journal_entry_id: entryId }).where('id', '=', id).execute();
  return { id, totalPaise: input.igstPaise + input.cgstPaise + input.sgstPaise + (input.interestPaise ?? 0) + (input.lateFeePaise ?? 0), journalEntryId: entryId };
}

async function lockedPayment(trx: Trx, orgId: number, id: number) {
  const r = await trx.selectFrom('gst_tax_payments').selectAll().where('id', '=', id).where('org_id', '=', orgId)
    .where('return_type', 'in', ['GSTR7', 'GSTR8']).forUpdate().executeTakeFirst();
  if (!r) throw notFound('That payment was not found.');
  const type = r.return_type as WithholdingReturn;
  await assertNotFiled(trx, orgId, type, r.period, 'this payment', 'it stays as filed.');
  if (r.journal_entry_id && await bankLineMatched(trx, orgId, 'journal_entry', r.journal_entry_id)) {
    throw conflict('This payment is matched to a line of the bank statement. Undo that match in Banking first, then change it here.');
  }
  return { ...r, type };
}

/** Correct a payment: its entry is reversed and posted again as it is now. */
export async function updateWithholdingPayment(trx: Trx, orgId: number, userId: number | null, id: number, input: WithholdingPaymentInput, liability: LiabilityOf) {
  checkPayment(input);
  const r = await lockedPayment(trx, orgId, id);
  if (input.returnType !== r.type) throw badRequest('A payment stays with the return it was made for.');
  if (input.period !== r.period) {
    await assertNotFiled(trx, orgId, r.type, input.period, 'its payment', 'pick a month not yet filed.');
    const other = await paymentFor(trx, orgId, r.type, input.period);
    if (other && other.id !== String(id)) throw conflict(`The tax for ${monthLabel(input.period)} is already recorded as paid. Edit that one.`);
  }
  await refuseOverpay(trx, orgId, input, liability);
  await reverseForChange(trx, orgId, r.journal_entry_id, { memo: `${LABEL[r.type]} payment for ${monthLabel(r.period)} changed`, userId, module: 'banking' });
  const entryId = await postPayment(trx, orgId, userId, id, r.branch_id, input);
  await trx.updateTable('gst_tax_payments').set({
    period: input.period, paid_on: input.paidOn, cpin: input.cpin?.trim().toUpperCase() || null, bank_account_id: input.bankAccountId,
    cash_igst: toSqlFromPaise(input.igstPaise), cash_cgst: toSqlFromPaise(input.cgstPaise), cash_sgst: toSqlFromPaise(input.sgstPaise),
    interest: toSqlFromPaise(input.interestPaise ?? 0), late_fee: toSqlFromPaise(input.lateFeePaise ?? 0),
    notes: input.notes?.trim() || null, journal_entry_id: entryId,
  }).where('id', '=', id).execute();
  return { id, journalEntryId: entryId };
}

/** Delete a payment entered in error: its entry is reversed and the record kept in deleted_documents. */
export async function deleteWithholdingPayment(trx: Trx, orgId: number, userId: number | null, id: number, reason?: string | null) {
  const r = await lockedPayment(trx, orgId, id);
  const label = `${LABEL[r.type]} payment for ${monthLabel(r.period)}`;
  const reversal = await reverseForChange(trx, orgId, r.journal_entry_id, { memo: `${label} deleted${reason?.trim() ? ` — ${reason.trim()}` : ''}`, userId, module: 'banking' });
  await recordDeletion(trx, {
    orgId, userId, docType: 'gst_tax_payment', docId: id, number: r.cpin ?? label, date: day(r.paid_on), branchId: r.branch_id,
    totalPaise: p(r.cash_igst) + p(r.cash_cgst) + p(r.cash_sgst) + p(r.interest) + p(r.late_fee),
    journalEntryId: r.journal_entry_id, reversalEntryId: reversal, reason, snapshot: plain(r),
  });
  await trx.deleteFrom('gst_tax_payments').where('id', '=', id).execute();
  return { label, type: r.type, period: r.period };
}

// ── Amendments in a later month ──────────────────────────────────────────────

export interface AmendmentValues extends WithholdingHeads {
  gstin: string;
  /** GSTR-7: the amount paid on which tax was deducted. GSTR-8: the net value. */
  valuePaise: number;
  /** GSTR-8 only: the four values the net is made of. */
  supR?: number; retsupR?: number; supU?: number; retsupU?: number;
}

export interface Amendment {
  /** The month whose return reports the correction (YYYY-MM). */
  month: string;
  date: string;
  /** The month the document was first reported in. */
  originalMonth: string;
  original: AmendmentValues;
  amended: AmendmentValues;
  /** The entries that posted the difference, where the tax changed (one per correction made in the month). */
  entryIds: number[];
  by: number | null;
}

const SCOPE: Record<WithholdingReturn, string> = { GSTR7: 'gstr7_amendments', GSTR8: 'gstr8_amendments' };

export async function amendmentsOf(ex: Executor, orgId: number, type: WithholdingReturn, docId: number): Promise<Amendment[]> {
  const r = await ex.selectFrom('settings').select('value').where('org_id', '=', orgId)
    .where('scope', '=', SCOPE[type]).where('setting_key', '=', String(docId)).executeTakeFirst();
  if (!r) return [];
  const v = typeof r.value === 'string' ? JSON.parse(r.value) : r.value;
  return Array.isArray(v) ? (v as Amendment[]) : [];
}

export async function saveAmendments(trx: Trx, orgId: number, userId: number | null, type: WithholdingReturn, docId: number, list: Amendment[]) {
  if (!list.length) {
    await trx.deleteFrom('settings').where('org_id', '=', orgId).where('scope', '=', SCOPE[type]).where('setting_key', '=', String(docId)).execute();
    return;
  }
  const value = JSON.stringify(list);
  await trx.insertInto('settings').values({ org_id: orgId, scope: SCOPE[type], setting_key: String(docId), value, updated_by_user_id: userId })
    .onDuplicateKeyUpdate({ value, updated_by_user_id: userId }).execute();
}

/** Every amendment reported in a month, with the document it amends. */
export async function amendmentsIn(ex: Executor, orgId: number, type: WithholdingReturn, month: string): Promise<(Amendment & { docId: number })[]> {
  const rows = await ex.selectFrom('settings').select(['setting_key', 'value']).where('org_id', '=', orgId).where('scope', '=', SCOPE[type]).execute();
  const out: (Amendment & { docId: number })[] = [];
  for (const r of rows) {
    const v = (typeof r.value === 'string' ? JSON.parse(r.value) : r.value) as Amendment[];
    for (const a of Array.isArray(v) ? v : []) if (a.month === month) out.push({ ...a, docId: Number(r.setting_key) });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.docId - b.docId);
}

/** The difference an amendment makes, by head. */
export const amendmentDelta = (a: Pick<Amendment, 'original' | 'amended'>): WithholdingHeads => ({
  igstPaise: a.amended.igstPaise - a.original.igstPaise,
  cgstPaise: a.amended.cgstPaise - a.original.cgstPaise,
  sgstPaise: a.amended.sgstPaise - a.original.sgstPaise,
});

// ── The ledger the return ties to ────────────────────────────────────────────

/** What the payable account took in (credits) and gave out (debits) in a month. */
export async function ledgerMovement(ex: Executor, orgId: number, code: string, month: string) {
  const { from, to } = monthBounds(month);
  const { rows } = await sql<{ credits: string; debits: string }>`
    SELECT COALESCE(SUM(jl.credit), 0) AS credits, COALESCE(SUM(jl.debit), 0) AS debits
      FROM journal_lines jl
      JOIN journal_entries e ON e.id = jl.entry_id
      JOIN accounts a ON a.id = jl.account_id
     WHERE e.org_id = ${orgId} AND a.code = ${code}
       AND e.entry_date BETWEEN ${from} AND ${to}
  `.execute(ex);
  return { creditsPaise: p(rows[0]?.credits), debitsPaise: p(rows[0]?.debits) };
}

/** The payable's movement in a month, by what posted it: credit less debit for each source type. */
export async function ledgerBySource(ex: Executor, orgId: number, code: string, month: string): Promise<Record<string, number>> {
  const { from, to } = monthBounds(month);
  const { rows } = await sql<{ source_type: string; net: string }>`
    SELECT e.source_type, COALESCE(SUM(jl.credit - jl.debit), 0) AS net
      FROM journal_lines jl
      JOIN journal_entries e ON e.id = jl.entry_id
      JOIN accounts a ON a.id = jl.account_id
     WHERE e.org_id = ${orgId} AND a.code = ${code}
       AND e.entry_date BETWEEN ${from} AND ${to}
     GROUP BY e.source_type
  `.execute(ex);
  return Object.fromEntries(rows.map((r) => [r.source_type, p(r.net)]));
}

/** The payable's balance at the end of a month: withheld and not yet paid over. */
export async function ledgerBalanceTo(ex: Executor, orgId: number, code: string, to: string): Promise<number> {
  const { rows } = await sql<{ bal: string }>`
    SELECT COALESCE(SUM(jl.credit - jl.debit), 0) AS bal
      FROM journal_lines jl
      JOIN journal_entries e ON e.id = jl.entry_id
      JOIN accounts a ON a.id = jl.account_id
     WHERE e.org_id = ${orgId} AND a.code = ${code} AND e.entry_date <= ${to}
  `.execute(ex);
  return p(rows[0]?.bal);
}

export const payableCode = (type: WithholdingReturn) => PAYABLE[type];
export const returnLabel = (type: WithholdingReturn) => LABEL[type];
