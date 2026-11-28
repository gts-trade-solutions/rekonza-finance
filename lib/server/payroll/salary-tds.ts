import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// TDS on salary: depositing it, linking each deduction to its challan, and the
// quarterly return.
//
// Tax deducted from salary under section 192 of the Income-tax Act, 1961
// (section 392 of the 2025 Act) is deposited by the 7th of the next month (30
// April for March; rule 30 of the 1962 Rules), on challan ITNS 281 under
// nature of payment 92B. Each quarter it is reported in Form 24Q (Form 138
// from April 2026):
//
//   Annexure I    every challan, and under it each employee's deduction that
//                 challan paid: PAN, amount paid, tax deducted and deposited,
//                 the dates. TRACES matches the challan by its BSR code, date
//                 and serial number with the bank's record (OLTAS); a
//                 deduction with no challan behind it is a default.
//   Annexure II   in the fourth quarter only: each employee's salary for the
//                 year, exemptions under section 10, deductions under section
//                 16 and Chapter VI-A, the tax worked out and the tax deducted.
//
// The return is laid out here as the rows the government's Return Preparation
// Utility (RPU) takes, sheet by sheet. The RPU writes the text file and the
// File Validation Utility (FVU) checks it against the challan status (CSI)
// file the deductor downloads from the e-filing portal with their own login;
// the .fvu file that comes out is uploaded on the e-filing portal or at a TIN
// facilitation centre. Those last steps need the deductor's credentials and
// the government's own utilities, so they are not done here.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor, Trx } from '../db';
import type { Paise } from '../../types';
import { toPaiseFromSql, toSqlFromPaise } from '../money-sql';
import { badRequest, conflict, notFound } from '../http';
import { postEntry, reverseEntry } from '../ledger/posting';
import { CODE, accountIds, requireAccount } from '../ledger/chart-of-accounts';
import { bankLineMatched, plain, recordDeletion } from '../services/doc-delete';
import { unseal } from '../crypto/fields';
import { monthLabel } from '../../date-range';
import { form16, form16Employees } from './form16';

const p = toPaiseFromSql;
const pad = (n: number) => String(n).padStart(2, '0');
const lastDay = (month: string) => { const [y, m] = month.split('-').map(Number); return `${month}-${pad(new Date(y, m, 0).getDate())}`; };
const ymd = (v: unknown) => String(v instanceof Date ? v.toISOString() : v).slice(0, 10);

export type Quarter = 1 | 2 | 3 | 4;
export const quarterMonths = (fy: number, q: Quarter) => [0, 1, 2].map((i) => {
  const m = 4 + (q - 1) * 3 + i;
  return m > 12 ? `${fy + 1}-${pad(m - 12)}` : `${fy}-${pad(m)}`;
});
export const quarterOf = (month: string): { fy: number; q: Quarter } => {
  const [y, m] = month.split('-').map(Number);
  const fy = m >= 4 ? y : y - 1;
  return { fy, q: (m >= 4 ? Math.floor((m - 4) / 3) + 1 : 4) as Quarter };
};
/** Deposit due: the 7th of the next month, but 30 April for March. */
export const tdsDueDate = (month: string) => {
  const [y, m] = month.split('-').map(Number);
  if (m === 3) return `${y}-04-30`;
  return `${m === 12 ? y + 1 : y}-${pad(m === 12 ? 1 : m + 1)}-07`;
};
/** 24Q due: 31 July, 31 October, 31 January, 31 May. */
export const returnDue = (fy: number, q: Quarter) => ({ 1: `${fy}-07-31`, 2: `${fy}-10-31`, 3: `${fy + 1}-01-31`, 4: `${fy + 1}-05-31` } as const)[q];

export interface SalaryChallanInput {
  forMonth: string; date: string; bsrCode: string; serial: string;
  taxPaise: Paise; surchargePaise?: Paise; cessPaise?: Paise; interestPaise?: Paise; feePaise?: Paise;
  bankAccountId: number; notes?: string | null;
}

/** Each employee's tax deducted in a month, from posted payrolls. */
async function deductions(ex: Executor, orgId: number, months: string[]) {
  if (!months.length) return [];
  const rows = await ex.selectFrom('payroll_lines as l').innerJoin('payroll_runs as r', 'r.id', 'l.run_id')
    .innerJoin('employees as e', 'e.id', 'l.employee_id')
    .select(['r.month', 'r.paid_on', 'l.employee_id', 'e.code', 'e.name', 'e.pan', 'l.gross', 'l.tds'])
    .where('r.org_id', '=', orgId).where('r.status', 'in', ['posted', 'paid']).where('r.month', 'in', months)
    .orderBy('r.month').orderBy('e.code').execute();
  return rows.map((r) => ({
    month: r.month, employeeId: Number(r.employee_id), code: r.code, name: r.name, pan: unseal(r.pan),
    grossPaise: p(r.gross), tdsPaise: p(r.tds), paidOn: r.paid_on ? ymd(r.paid_on) : null,
  }));
}

async function linkedOf(ex: Executor, orgId: number, months: string[]) {
  if (!months.length) return [];
  return ex.selectFrom('salary_tds_links as k').innerJoin('salary_tds_challans as c', 'c.id', 'k.challan_id')
    .select(['k.id', 'k.challan_id', 'k.employee_id', 'k.month', 'k.amount', 'c.bsr_code', 'c.challan_date', 'c.challan_serial'])
    .where('k.org_id', '=', orgId).where('k.month', 'in', months).execute();
}

/**
 * Link a challan to the deductions of its month that no challan pays yet,
 * employee by employee in code order, up to the tax the challan carries.
 * Run again after a payroll is reopened and reposted: it starts afresh.
 */
export async function linkChallan(trx: Trx, orgId: number, challanId: number) {
  const c = await trx.selectFrom('salary_tds_challans').selectAll().where('id', '=', challanId).where('org_id', '=', orgId).executeTakeFirst();
  if (!c) throw notFound('That challan is not on record.');
  await trx.deleteFrom('salary_tds_links').where('challan_id', '=', challanId).execute();
  let left = p(c.tax) + p(c.surcharge) + p(c.cess);
  const [ded, links] = await Promise.all([deductions(trx, orgId, [c.for_month]), linkedOf(trx, orgId, [c.for_month])]);
  const rows: { org_id: number; challan_id: number; employee_id: number; month: string; amount: string }[] = [];
  for (const d of ded) {
    if (left <= 0) break;
    const already = links.filter((k) => Number(k.employee_id) === d.employeeId).reduce((t, k) => t + p(k.amount), 0);
    const open = d.tdsPaise - already;
    if (open <= 0) continue;
    const take = Math.min(open, left);
    rows.push({ org_id: orgId, challan_id: challanId, employee_id: d.employeeId, month: c.for_month, amount: toSqlFromPaise(take) });
    left -= take;
  }
  if (rows.length) await trx.insertInto('salary_tds_links').values(rows).execute();
  return { linked: rows.length, unallocatedPaise: left };
}

async function checkChallan(trx: Trx, orgId: number, input: SalaryChallanInput, replaceId?: number) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.forMonth)) throw badRequest('Say which month’s deductions this pays for.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw badRequest('Give the date on the challan.');
  if (!/^\d{7}$/.test(input.bsrCode)) throw badRequest('A BSR code is the bank branch’s 7 digits, printed on the challan.');
  if (!/^\d{1,5}$/.test(input.serial)) throw badRequest('The challan serial number is up to 5 digits.');
  if (input.date < `${input.forMonth}-01`) throw badRequest('Tax for a month cannot be deposited before that month begins.');
  const tax = input.taxPaise + (input.surchargePaise ?? 0) + (input.cessPaise ?? 0);
  if (!(tax > 0)) throw badRequest('Give the tax the challan paid.');
  // A challan is one deposit: the same one entered twice, here or with the other TDS, is refused.
  const dup = await trx.selectFrom('salary_tds_challans').select('id').where('org_id', '=', orgId).where('bsr_code', '=', input.bsrCode)
    .where('challan_date', '=', input.date).where('challan_serial', '=', input.serial)
    .$if(!!replaceId, (q) => q.where('id', '<>', replaceId!)).executeTakeFirst();
  const other = await trx.selectFrom('tds_challans').select('id').where('org_id', '=', orgId).where('bsr_code', '=', input.bsrCode)
    .where('challan_date', '=', input.date).where('challan_serial', '=', input.serial).executeTakeFirst();
  if (dup || other) throw conflict(`Challan ${input.bsrCode} / ${input.date} / ${input.serial} is already recorded.`);
  const bank = await trx.selectFrom('bank_accounts').select(['id', 'ledger_account_id', 'name']).where('id', '=', input.bankAccountId).where('org_id', '=', orgId).executeTakeFirst();
  if (!bank) throw notFound('That bank account does not exist.');
  return { bank, tax };
}

async function postChallan(trx: Trx, orgId: number, userId: number | null, id: number, input: SalaryChallanInput, bank: { ledger_account_id: number; name: string }) {
  const acc = await accountIds(trx, orgId);
  const branch = (await trx.selectFrom('branches').select('id').where('org_id', '=', orgId).orderBy('is_primary', 'desc').executeTakeFirstOrThrow()).id;
  const tax = input.taxPaise + (input.surchargePaise ?? 0) + (input.cessPaise ?? 0);
  const extra = (input.interestPaise ?? 0) + (input.feePaise ?? 0);
  return postEntry(trx, {
    orgId, branchId: branch, date: input.date, userId, module: 'banking', sourceType: 'salary_tds_challan', sourceId: id,
    memo: `TDS on salary for ${monthLabel(input.forMonth)} deposited — challan ${input.bsrCode} / ${input.serial}`,
    lines: [
      { accountId: requireAccount(acc, CODE.TDS_PAYABLE), debit: tax, description: `TDS on salary (192), ${monthLabel(input.forMonth)}` },
      { accountId: requireAccount(acc, CODE.TAX_INTEREST), debit: extra, description: 'Interest and late fee on TDS' },
      { accountId: bank.ledger_account_id, credit: tax + extra, description: `Challan ITNS 281 from ${bank.name}` },
    ],
  });
}

/** Record a challan: post it (Dr TDS Payable, Dr interest and fees, Cr bank) and link the month's deductions to it. */
export async function recordSalaryChallan(trx: Trx, orgId: number, userId: number | null, input: SalaryChallanInput) {
  const { bank } = await checkChallan(trx, orgId, input);
  const values = {
    for_month: input.forMonth, challan_date: input.date, bsr_code: input.bsrCode, challan_serial: input.serial,
    tax: toSqlFromPaise(input.taxPaise), surcharge: toSqlFromPaise(input.surchargePaise ?? 0), cess: toSqlFromPaise(input.cessPaise ?? 0),
    interest: toSqlFromPaise(input.interestPaise ?? 0), fee: toSqlFromPaise(input.feePaise ?? 0),
    total: toSqlFromPaise(input.taxPaise + (input.surchargePaise ?? 0) + (input.cessPaise ?? 0) + (input.interestPaise ?? 0) + (input.feePaise ?? 0)),
    bank_account_id: input.bankAccountId, notes: input.notes?.trim() || null,
  };
  const id = Number((await trx.insertInto('salary_tds_challans').values({ org_id: orgId, ...values, created_by_user_id: userId }).executeTakeFirstOrThrow()).insertId);
  const entry = await postChallan(trx, orgId, userId, id, input, bank);
  await trx.updateTable('salary_tds_challans').set({ journal_entry_id: entry.id }).where('id', '=', id).execute();
  const link = await linkChallan(trx, orgId, id);
  return { id, entryId: entry.id, ...link };
}

/** Correct a challan: its entry reversed and posted again on the same record, its links made afresh. */
export async function updateSalaryChallan(trx: Trx, orgId: number, userId: number | null, id: number, input: SalaryChallanInput, reason?: string | null) {
  const c = await trx.selectFrom('salary_tds_challans').selectAll().where('id', '=', id).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!c) throw notFound('That challan is not on record.');
  if (c.journal_entry_id && await bankLineMatched(trx, orgId, 'journal_entry', c.journal_entry_id)) {
    throw conflict('That challan’s payment is matched to the bank statement. Undo the match in Banking first.');
  }
  const { bank } = await checkChallan(trx, orgId, input, id);
  if (c.journal_entry_id) await reverseEntry(trx, orgId, c.journal_entry_id, { memo: `Challan ${c.bsr_code}/${c.challan_serial} changed${reason ? ` — ${reason}` : ''}`, userId, module: 'banking' });
  await trx.updateTable('salary_tds_challans').set({
    for_month: input.forMonth, challan_date: input.date, bsr_code: input.bsrCode, challan_serial: input.serial,
    tax: toSqlFromPaise(input.taxPaise), surcharge: toSqlFromPaise(input.surchargePaise ?? 0), cess: toSqlFromPaise(input.cessPaise ?? 0),
    interest: toSqlFromPaise(input.interestPaise ?? 0), fee: toSqlFromPaise(input.feePaise ?? 0),
    total: toSqlFromPaise(input.taxPaise + (input.surchargePaise ?? 0) + (input.cessPaise ?? 0) + (input.interestPaise ?? 0) + (input.feePaise ?? 0)),
    bank_account_id: input.bankAccountId, notes: input.notes?.trim() || null, journal_entry_id: null,
  }).where('id', '=', id).execute();
  const entry = await postChallan(trx, orgId, userId, id, input, bank);
  await trx.updateTable('salary_tds_challans').set({ journal_entry_id: entry.id }).where('id', '=', id).execute();
  return { id, entryId: entry.id, ...(await linkChallan(trx, orgId, id)) };
}

/** Delete a challan entered in error: its entry reversed, the record kept in deleted documents, its links gone. */
export async function deleteSalaryChallan(trx: Trx, orgId: number, userId: number | null, id: number, reason?: string | null) {
  const c = await trx.selectFrom('salary_tds_challans').selectAll().where('id', '=', id).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!c) throw notFound('That challan is not on record.');
  if (c.journal_entry_id && await bankLineMatched(trx, orgId, 'journal_entry', c.journal_entry_id)) {
    throw conflict('That challan’s payment is matched to the bank statement. Undo the match in Banking first.');
  }
  const links = await trx.selectFrom('salary_tds_links').selectAll().where('challan_id', '=', id).execute();
  const rev = c.journal_entry_id
    ? (await reverseEntry(trx, orgId, c.journal_entry_id, { memo: `Challan ${c.bsr_code}/${c.challan_serial} deleted${reason ? ` — ${reason}` : ''}`, userId, module: 'banking' })).id
    : null;
  await recordDeletion(trx, {
    orgId, userId, docType: 'salary_tds_challan', docId: id, number: `${c.bsr_code}/${c.challan_serial}`, date: ymd(c.challan_date),
    totalPaise: p(c.total), journalEntryId: c.journal_entry_id, reversalEntryId: rev, reason, snapshot: { challan: plain(c), links: links.map(plain) },
  });
  await trx.deleteFrom('salary_tds_challans').where('id', '=', id).execute();
  return { label: `${c.bsr_code}/${c.challan_serial}`, amountPaise: p(c.total) };
}

/** The quarter's receipt number from TRACES, for Form 16 Part A. */
export async function setReturnReceipt(trx: Trx, orgId: number, userId: number | null, fy: number, q: Quarter, receiptNo: string, filedOn: string | null) {
  if (!/^[A-Za-z0-9]{8,20}$/.test(receiptNo.trim())) throw badRequest('A provisional receipt number is the 15 characters TRACES gives on filing.');
  await sql`
    INSERT INTO salary_tds_returns (org_id, fy_start, quarter, receipt_no, filed_on, updated_by_user_id)
    VALUES (${orgId}, ${fy}, ${q}, ${receiptNo.trim().toUpperCase()}, ${filedOn}, ${userId})
    ON DUPLICATE KEY UPDATE receipt_no = VALUES(receipt_no), filed_on = VALUES(filed_on), updated_by_user_id = VALUES(updated_by_user_id)
  `.execute(trx);
}

export interface ChallanRow {
  id: string; forMonth: string; date: string; bsrCode: string; serial: string;
  taxPaise: Paise; surchargePaise: Paise; cessPaise: Paise; interestPaise: Paise; feePaise: Paise; totalPaise: Paise;
  bankAccountId: string; bank: string | null; entryId: string | null; notes: string | null; linkedPaise: Paise;
}

export async function listSalaryChallans(ex: Executor, orgId: number, months?: string[]): Promise<ChallanRow[]> {
  const rows = await ex.selectFrom('salary_tds_challans as c').leftJoin('bank_accounts as b', 'b.id', 'c.bank_account_id')
    .select(['c.id', 'c.for_month', 'c.challan_date', 'c.bsr_code', 'c.challan_serial', 'c.tax', 'c.surcharge', 'c.cess', 'c.interest', 'c.fee', 'c.total',
      'c.bank_account_id', 'b.name as bank', 'c.journal_entry_id', 'c.notes',
      sql<string>`(SELECT COALESCE(SUM(k.amount), 0) FROM salary_tds_links k WHERE k.challan_id = c.id)`.as('linked')])
    .where('c.org_id', '=', orgId).$if(!!months?.length, (q) => q.where('c.for_month', 'in', months!))
    .orderBy('c.challan_date').orderBy('c.id').execute();
  return rows.map((c) => ({
    id: String(c.id), forMonth: c.for_month, date: ymd(c.challan_date), bsrCode: c.bsr_code, serial: c.challan_serial,
    taxPaise: p(c.tax), surchargePaise: p(c.surcharge), cessPaise: p(c.cess), interestPaise: p(c.interest), feePaise: p(c.fee), totalPaise: p(c.total),
    bankAccountId: String(c.bank_account_id), bank: c.bank, entryId: c.journal_entry_id ? String(c.journal_entry_id) : null, notes: c.notes, linkedPaise: p(c.linked),
  }));
}

/** Month by month: deducted, deposited, linked, what is left, the due date and whether it was late. */
export async function salaryTdsMonths(ex: Executor, orgId: number, months: string[]) {
  const [ded, challans] = await Promise.all([deductions(ex, orgId, months), listSalaryChallans(ex, orgId, months)]);
  return months.map((month) => {
    const deducted = ded.filter((d) => d.month === month).reduce((t, d) => t + d.tdsPaise, 0);
    const mine = challans.filter((c) => c.forMonth === month);
    const deposited = mine.reduce((t, c) => t + c.taxPaise + c.surchargePaise + c.cessPaise, 0);
    const linked = mine.reduce((t, c) => t + c.linkedPaise, 0);
    const due = tdsDueDate(month);
    const last = mine.length ? mine[mine.length - 1].date : null;
    return {
      month, deductedPaise: deducted, depositedPaise: deposited, linkedPaise: linked, balancePaise: deducted - deposited, dueDate: due,
      late: !!last && last > due, challans: mine,
      status: deducted === 0 ? 'nothing_due' as const : deposited >= deducted ? 'deposited' as const : deposited > 0 ? 'short' as const : 'due' as const,
    };
  }).filter((m) => m.deductedPaise || m.challans.length);
}

export interface Form24Q {
  fy: number; quarter: Quarter; months: string[]; form: string; returnDueDate: string;
  receipt: { receiptNo: string; filedOn: string | null } | null;
  deductor: { name: string; tan: string | null; pan: string | null; address: string | null; type: string | null;
    responsible: { name: string | null; designation: string | null; pan: string | null; mobile: string | null; email: string | null } };
  challans: (ChallanRow & { deductees: { employeeId: string; code: string; name: string; pan: string | null; month: string; paymentDate: string; amountPaidPaise: Paise; tdsPaise: Paise; depositedPaise: Paise; deductedOn: string }[] })[];
  unlinked: { employeeId: string; code: string; name: string; pan: string | null; month: string; tdsPaise: Paise; linkedPaise: Paise }[];
  totals: { paidPaise: Paise; deductedPaise: Paise; depositedPaise: Paise; linkedPaise: Paise };
  annexureII: Awaited<ReturnType<typeof form16>>[] | null;
  issues: { level: 'error' | 'warning'; message: string }[];
}

/** Form 24Q (Form 138 from April 2026) for a quarter: Annexure I by challan, and Annexure II in the fourth. */
export async function form24Q(ex: Executor, orgId: number, fy: number, quarter: Quarter): Promise<Form24Q> {
  const months = quarterMonths(fy, quarter);
  const [org, ded, links, challans, receipt] = await Promise.all([
    ex.selectFrom('organizations').select(['name', 'legal_name', 'tan', 'pan', 'address', 'deductor_type', 'tds_rp_name', 'tds_rp_designation', 'tds_rp_pan', 'tds_rp_mobile', 'tds_rp_email'])
      .where('id', '=', orgId).executeTakeFirstOrThrow(),
    deductions(ex, orgId, months),
    linkedOf(ex, orgId, months),
    listSalaryChallans(ex, orgId, months),
    ex.selectFrom('salary_tds_returns').select(['receipt_no', 'filed_on']).where('org_id', '=', orgId).where('fy_start', '=', fy).where('quarter', '=', quarter).executeTakeFirst(),
  ]);
  const byKey = new Map(ded.map((d) => [`${d.employeeId}|${d.month}`, d]));
  const outChallans = challans.map((c) => ({
    ...c,
    deductees: links.filter((k) => String(k.challan_id) === c.id).map((k) => {
      const d = byKey.get(`${k.employee_id}|${k.month}`);
      return {
        employeeId: String(k.employee_id), code: d?.code ?? '', name: d?.name ?? '', pan: d?.pan ?? null, month: k.month,
        // Salary is credited at the month's end, and the tax deducted then (section 192: at the time of payment).
        paymentDate: d?.paidOn ?? lastDay(k.month), amountPaidPaise: d?.grossPaise ?? 0, tdsPaise: d?.tdsPaise ?? 0,
        depositedPaise: p(k.amount), deductedOn: lastDay(k.month),
      };
    }),
  }));
  const unlinked = ded.map((d) => {
    const linked = links.filter((k) => Number(k.employee_id) === d.employeeId && k.month === d.month).reduce((t, k) => t + p(k.amount), 0);
    return { employeeId: String(d.employeeId), code: d.code, name: d.name, pan: d.pan, month: d.month, tdsPaise: d.tdsPaise, linkedPaise: linked };
  }).filter((x) => x.tdsPaise > x.linkedPaise);
  const totals = {
    paidPaise: ded.reduce((t, d) => t + d.grossPaise, 0), deductedPaise: ded.reduce((t, d) => t + d.tdsPaise, 0),
    depositedPaise: challans.reduce((t, c) => t + c.taxPaise + c.surchargePaise + c.cessPaise, 0), linkedPaise: links.reduce((t, k) => t + p(k.amount), 0),
  };
  let annexureII: Form24Q['annexureII'] = null;
  if (quarter === 4) {
    const people = await form16Employees(ex, orgId, fy);
    annexureII = await Promise.all(people.map((e) => form16(ex, orgId, Number(e.employeeId), fy)));
  }
  const issues: Form24Q['issues'] = [];
  if (!org.tan) issues.push({ level: 'error', message: 'The book has no TAN: every challan and return is filed under it. Add it in Settings → Statutory.' });
  if (!(org.tds_rp_name && org.tds_rp_pan)) issues.push({ level: 'error', message: 'The person responsible for deduction (name, designation, PAN) is not filled in. Settings → Statutory.' });
  const noPan = ded.filter((d) => d.tdsPaise > 0 && !d.pan);
  if (noPan.length) issues.push({ level: 'warning', message: `${noPan.length} deduction(s) are for employees with no PAN: tax at 20% or more applies (section 206AA), and the return needs PANNOTAVBL.` });
  for (const u of unlinked) {
    issues.push({ level: 'error', message: `${u.month}: ${u.name}'s TDS of ₹${(u.tdsPaise / 100).toLocaleString('en-IN')} has ₹${((u.tdsPaise - u.linkedPaise) / 100).toLocaleString('en-IN')} not linked to any challan. Record the challan for ${u.month}, or link again.` });
  }
  for (const m of months) {
    const mine = challans.filter((c) => c.forMonth === m);
    const due = tdsDueDate(m);
    if (mine.some((c) => c.date > due)) issues.push({ level: 'warning', message: `${m}: deposited after ${due}; interest at 1.5% a month is due (section 201(1A)).` });
  }
  return {
    fy, quarter, months, form: fy >= 2026 ? 'Form 138 (earlier 24Q)' : 'Form 24Q', returnDueDate: returnDue(fy, quarter),
    receipt: receipt ? { receiptNo: receipt.receipt_no, filedOn: receipt.filed_on ? ymd(receipt.filed_on) : null } : null,
    deductor: {
      name: org.legal_name ?? org.name, tan: org.tan, pan: org.pan, address: org.address, type: org.deductor_type,
      responsible: { name: org.tds_rp_name, designation: org.tds_rp_designation, pan: org.tds_rp_pan, mobile: org.tds_rp_mobile, email: org.tds_rp_email },
    },
    challans: outChallans, unlinked, totals, annexureII, issues,
  };
}

/**
 * Form 16 Part A for an employee: the tax deducted and deposited, quarter by
 * quarter with each 24Q's receipt number, and every challan that carried
 * their tax — the figures TRACES certifies, from the same links the 24Q uses.
 */
export async function form16PartA(ex: Executor, orgId: number, employeeId: number, fy: number) {
  const months = [1, 2, 3, 4].flatMap((q) => quarterMonths(fy, q as Quarter));
  const [ded, links, receipts] = await Promise.all([
    deductions(ex, orgId, months),
    ex.selectFrom('salary_tds_links as k').innerJoin('salary_tds_challans as c', 'c.id', 'k.challan_id')
      .select(['k.month', 'k.amount', 'c.bsr_code', 'c.challan_date', 'c.challan_serial', 'c.id'])
      .where('k.org_id', '=', orgId).where('k.employee_id', '=', employeeId).where('k.month', 'in', months).orderBy('c.challan_date').execute(),
    ex.selectFrom('salary_tds_returns').select(['quarter', 'receipt_no']).where('org_id', '=', orgId).where('fy_start', '=', fy).execute(),
  ]);
  const mine = ded.filter((d) => d.employeeId === employeeId);
  const quarters = ([1, 2, 3, 4] as Quarter[]).map((q) => {
    const qm = quarterMonths(fy, q);
    return {
      quarter: q, receiptNo: receipts.find((r) => r.quarter === q)?.receipt_no ?? null,
      paidPaise: mine.filter((d) => qm.includes(d.month)).reduce((t, d) => t + d.grossPaise, 0),
      deductedPaise: mine.filter((d) => qm.includes(d.month)).reduce((t, d) => t + d.tdsPaise, 0),
      depositedPaise: links.filter((k) => qm.includes(k.month)).reduce((t, k) => t + p(k.amount), 0),
    };
  });
  return {
    quarters,
    challans: links.map((k) => ({ challanId: String(k.id), month: k.month, bsrCode: k.bsr_code, date: ymd(k.challan_date), serial: k.challan_serial, amountPaise: p(k.amount) })),
    totals: {
      paidPaise: quarters.reduce((t, q) => t + q.paidPaise, 0), deductedPaise: quarters.reduce((t, q) => t + q.deductedPaise, 0),
      depositedPaise: quarters.reduce((t, q) => t + q.depositedPaise, 0),
    },
  };
}
