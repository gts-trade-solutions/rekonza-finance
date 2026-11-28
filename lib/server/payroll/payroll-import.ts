import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Payroll run elsewhere: the month's salary register imported from an
// external payroll system (greytHR, Keka, Zoho Payroll, a payroll bureau's
// sheet), posting the same salary journal a pay run here posts:
//
//   Dr Salaries & Wages        basic, HRA and other earnings (by cost centre
//                              where the department names one)
//   Dr Employer PF, ESI, LWF   the employer's shares
//     Cr PF / ESI / PT / LWF / TDS Payable
//     Cr Loans & Advances      advances recovered
//     Cr Salaries Payable      net pay
//
// and, when the salaries were paid with it, Dr Salaries Payable Cr the bank.
// Every row must add up — gross less the deductions is the net pay, to the
// paisa — or nothing posts: a register that does not foot is not a register.
// The dues it raises are paid from Payroll → Statutory Reports like any other,
// and the integration check reconciles it with the ledger.
// ─────────────────────────────────────────────────────────────────────────────

import type { Executor, Trx } from '../db';
import type { Paise } from '../../types';
import { toPaiseFromSql, toSqlFromPaise } from '../money-sql';
import { badRequest, conflict, notFound } from '../http';
import { postEntry, reverseEntry, type DraftLine } from '../ledger/posting';
import { CODE, accountIds, requireAccount } from '../ledger/chart-of-accounts';
import { bankLineMatched } from '../services/doc-delete';
import { monthLabel } from '../../date-range';

const p = toPaiseFromSql;
const pad = (n: number) => String(n).padStart(2, '0');
const lastDay = (month: string) => { const [y, m] = month.split('-').map(Number); return `${month}-${pad(new Date(y, m, 0).getDate())}`; };

export interface ImportRow {
  code: string; name: string; department?: string | null;
  basicPaise?: Paise; hraPaise?: Paise; otherPaise?: Paise; grossPaise: Paise;
  pfEmployeePaise?: Paise; pfEmployerPaise?: Paise; esiEmployeePaise?: Paise; esiEmployerPaise?: Paise;
  ptPaise?: Paise; lwfEmployeePaise?: Paise; lwfEmployerPaise?: Paise; tdsPaise?: Paise; advancePaise?: Paise; netPaise: Paise;
}

export interface ImportInput {
  month: string; sourceSystem?: string | null; fileName?: string | null; rows: ImportRow[];
  /** Paid with the import: from which bank account, on which day. */
  paidFromBankAccountId?: number | null; paidOn?: string | null;
}

const z = (v: Paise | undefined | null) => v ?? 0;

/** Each row checked: earnings add to gross, gross less deductions is net. */
export function checkRows(rows: ImportRow[]) {
  const problems: { row: number; code: string; message: string }[] = [];
  const codes = new Set<string>();
  rows.forEach((r, i) => {
    const n = i + 2; // the sheet's row, under its heading
    if (!r.code?.trim()) problems.push({ row: n, code: '', message: 'No employee code.' });
    if (codes.has(r.code)) problems.push({ row: n, code: r.code, message: 'The same employee twice.' });
    codes.add(r.code);
    const amounts = [r.basicPaise, r.hraPaise, r.otherPaise, r.grossPaise, r.pfEmployeePaise, r.pfEmployerPaise, r.esiEmployeePaise, r.esiEmployerPaise, r.ptPaise, r.lwfEmployeePaise, r.lwfEmployerPaise, r.tdsPaise, r.advancePaise, r.netPaise];
    if (amounts.some((a) => a !== undefined && a !== null && (!Number.isInteger(a) || a < 0))) problems.push({ row: n, code: r.code, message: 'An amount is negative or not a number.' });
    const parts = z(r.basicPaise) + z(r.hraPaise) + z(r.otherPaise);
    if (parts > 0 && parts !== r.grossPaise) problems.push({ row: n, code: r.code, message: `Basic, HRA and other earnings add to ₹${(parts / 100).toFixed(2)}, not the gross ₹${(r.grossPaise / 100).toFixed(2)}.` });
    const deductions = z(r.pfEmployeePaise) + z(r.esiEmployeePaise) + z(r.ptPaise) + z(r.lwfEmployeePaise) + z(r.tdsPaise) + z(r.advancePaise);
    if (r.grossPaise - deductions !== r.netPaise) {
      problems.push({ row: n, code: r.code, message: `Gross ₹${(r.grossPaise / 100).toFixed(2)} less deductions ₹${(deductions / 100).toFixed(2)} is ₹${((r.grossPaise - deductions) / 100).toFixed(2)}, not the net pay ₹${(r.netPaise / 100).toFixed(2)}.` });
    }
  });
  return problems;
}

export function totalsOf(rows: ImportRow[]) {
  const sum = (f: (r: ImportRow) => Paise | undefined) => rows.reduce((t, r) => t + z(f(r)), 0);
  const basic = sum((r) => r.basicPaise);
  const hra = sum((r) => r.hraPaise);
  const gross = sum((r) => r.grossPaise);
  return {
    employees: rows.length, basicPaise: basic, hraPaise: hra, otherPaise: gross - basic - hra, grossPaise: gross,
    pfPaise: sum((r) => r.pfEmployeePaise) + sum((r) => r.pfEmployerPaise), esiPaise: sum((r) => r.esiEmployeePaise) + sum((r) => r.esiEmployerPaise),
    ptPaise: sum((r) => r.ptPaise), lwfPaise: sum((r) => r.lwfEmployeePaise) + sum((r) => r.lwfEmployerPaise), tdsPaise: sum((r) => r.tdsPaise),
    advancesPaise: sum((r) => r.advancePaise), netPaise: sum((r) => r.netPaise),
    employerPaise: sum((r) => r.pfEmployerPaise) + sum((r) => r.esiEmployerPaise) + sum((r) => r.lwfEmployerPaise),
  };
}

/**
 * Check an import (dryRun) or post it. Refused for a month already run here
 * or already imported: the salary would be in the books twice.
 */
export async function importPayroll(trx: Trx, orgId: number, userId: number | null, input: ImportInput, dryRun: boolean) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.month)) throw badRequest('Say which month the register is for (yyyy-mm).');
  if (!input.rows.length) throw badRequest('The register has no rows.');
  const problems = checkRows(input.rows);
  const t = totalsOf(input.rows);
  const run = await trx.selectFrom('payroll_runs').select('status').where('org_id', '=', orgId).where('month', '=', input.month).executeTakeFirst();
  if (run && run.status !== 'draft') problems.push({ row: 0, code: '', message: `Payroll for ${monthLabel(input.month)} is already run here (${run.status}); importing it too would count the salaries twice.` });
  const dup = await trx.selectFrom('payroll_imports').select('id').where('org_id', '=', orgId).where('month', '=', input.month).where('status', '=', 'posted').executeTakeFirst();
  if (dup) problems.push({ row: 0, code: '', message: `A salary register for ${monthLabel(input.month)} is already imported. Reverse that one first to import it again.` });
  if (input.paidFromBankAccountId && (!input.paidOn || input.paidOn < `${input.month}-01`)) problems.push({ row: 0, code: '', message: 'Give the day the salaries were paid, in or after the month.' });
  if (dryRun || problems.length) return { posted: false, problems, totals: t, importId: null as number | null };

  const acc = await accountIds(trx, orgId);
  const a = (code: string) => requireAccount(acc, code);
  const centres = await trx.selectFrom('cost_centres').select(['id', 'code', 'name']).where('org_id', '=', orgId).where('is_active', '=', 1).execute();
  const ccOf = (dept?: string | null) => {
    const d = dept?.trim().toLowerCase();
    if (!d) return null;
    return centres.find((c) => c.name.toLowerCase() === d || c.code.toLowerCase() === d)?.id ?? null;
  };
  // Earnings by cost centre, so a department's salary lands on its centre.
  const groups = new Map<string, { cc: number | null; label: string; basic: Paise; hra: Paise; other: Paise; employer: Paise }>();
  for (const r of input.rows) {
    const cc = ccOf(r.department);
    const key = String(cc ?? 'none');
    const g = groups.get(key) ?? { cc, label: cc ? ` — ${centres.find((c) => c.id === cc)!.name}` : '', basic: 0, hra: 0, other: 0, employer: 0 };
    const basic = z(r.basicPaise);
    const hra = z(r.hraPaise);
    g.basic += basic; g.hra += hra; g.other += r.grossPaise - basic - hra;
    g.employer += z(r.pfEmployerPaise) + z(r.esiEmployerPaise) + z(r.lwfEmployerPaise);
    groups.set(key, g);
  }
  const lines: DraftLine[] = [];
  for (const g of groups.values()) {
    lines.push({ accountId: a(CODE.SALARIES), debit: g.basic, description: `Basic${g.label}`, costCentreId: g.cc });
    lines.push({ accountId: a(CODE.SALARIES), debit: g.hra, description: `House rent allowance${g.label}`, costCentreId: g.cc });
    lines.push({ accountId: a(CODE.SALARIES), debit: g.other, description: `Other earnings${g.label}`, costCentreId: g.cc });
    lines.push({ accountId: a(CODE.EMPLOYER_CONTRIBUTIONS), debit: g.employer, description: `Employer PF, ESI and LWF${g.label}`, costCentreId: g.cc });
  }
  lines.push(
    { accountId: a(CODE.PF_PAYABLE), credit: t.pfPaise, description: 'PF: both shares' },
    { accountId: a(CODE.ESI_PAYABLE), credit: t.esiPaise, description: 'ESI: both shares' },
    { accountId: a(CODE.PT_PAYABLE), credit: t.ptPaise, description: 'Professional Tax' },
    { accountId: a(CODE.LWF_PAYABLE), credit: t.lwfPaise, description: 'Labour Welfare Fund' },
    { accountId: a(CODE.TDS_PAYABLE), credit: t.tdsPaise, description: 'TDS on salary (section 192)' },
    { accountId: a(CODE.LOANS_ADVANCES), credit: t.advancesPaise, description: 'Advances recovered' },
    { accountId: a(CODE.SALARIES_PAYABLE), credit: t.netPaise, description: `Net salaries for ${monthLabel(input.month)}` },
  );
  const branch = (await trx.selectFrom('branches').select('id').where('org_id', '=', orgId).orderBy('is_primary', 'desc').executeTakeFirstOrThrow()).id;
  const id = Number((await trx.insertInto('payroll_imports').values({
    org_id: orgId, month: input.month, source_system: input.sourceSystem?.trim() || null, file_name: input.fileName?.trim() || null,
    employees: t.employees, gross: toSqlFromPaise(t.grossPaise), employer_cost: toSqlFromPaise(t.employerPaise), pf: toSqlFromPaise(t.pfPaise),
    esi: toSqlFromPaise(t.esiPaise), pt: toSqlFromPaise(t.ptPaise), lwf: toSqlFromPaise(t.lwfPaise), tds: toSqlFromPaise(t.tdsPaise),
    advances: toSqlFromPaise(t.advancesPaise), net_pay: toSqlFromPaise(t.netPaise), created_by_user_id: userId,
  }).executeTakeFirstOrThrow()).insertId);
  const entry = await postEntry(trx, {
    orgId, branchId: branch, date: lastDay(input.month), module: 'accountant', sourceType: 'payroll_import', sourceId: id, userId,
    memo: `Payroll for ${monthLabel(input.month)} imported${input.sourceSystem ? ` from ${input.sourceSystem}` : ''} (${t.employees} employees)`, lines,
  });
  await trx.updateTable('payroll_imports').set({ journal_entry_id: entry.id }).where('id', '=', id).execute();
  await trx.insertInto('payroll_import_lines').values(input.rows.map((r) => ({
    import_id: id, employee_code: r.code.trim().slice(0, 30), employee_name: r.name.trim().slice(0, 150), department: r.department?.trim().slice(0, 100) || null,
    basic: toSqlFromPaise(z(r.basicPaise)), hra: toSqlFromPaise(z(r.hraPaise)), other_earnings: toSqlFromPaise(r.grossPaise - z(r.basicPaise) - z(r.hraPaise)),
    gross: toSqlFromPaise(r.grossPaise), pf_employee: toSqlFromPaise(z(r.pfEmployeePaise)), pf_employer: toSqlFromPaise(z(r.pfEmployerPaise)),
    esi_employee: toSqlFromPaise(z(r.esiEmployeePaise)), esi_employer: toSqlFromPaise(z(r.esiEmployerPaise)), pt: toSqlFromPaise(z(r.ptPaise)),
    lwf_employee: toSqlFromPaise(z(r.lwfEmployeePaise)), lwf_employer: toSqlFromPaise(z(r.lwfEmployerPaise)), tds: toSqlFromPaise(z(r.tdsPaise)),
    advance: toSqlFromPaise(z(r.advancePaise)), net_pay: toSqlFromPaise(r.netPaise),
  }))).execute();
  if (input.paidFromBankAccountId) {
    const bank = await trx.selectFrom('bank_accounts').select(['ledger_account_id', 'name']).where('id', '=', input.paidFromBankAccountId).where('org_id', '=', orgId).executeTakeFirst();
    if (!bank) throw notFound('That bank account does not exist.');
    await postEntry(trx, {
      orgId, branchId: branch, date: input.paidOn!, module: 'banking', sourceType: 'payroll_import_payment', sourceId: id, userId,
      memo: `Salaries for ${monthLabel(input.month)} (imported) paid from ${bank.name}`,
      lines: [{ accountId: a(CODE.SALARIES_PAYABLE), debit: t.netPaise }, { accountId: bank.ledger_account_id, credit: t.netPaise, description: `Salaries ${monthLabel(input.month)}` }],
    });
  }
  return { posted: true, problems, totals: t, importId: id };
}

/** Reverse an imported register: its entries reversed on their dates, the import kept, marked reversed. */
export async function reverseImport(trx: Trx, orgId: number, userId: number | null, id: number, reason: string | null) {
  const imp = await trx.selectFrom('payroll_imports').selectAll().where('id', '=', id).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!imp) throw notFound('That import was not found.');
  if (imp.status === 'reversed') throw conflict('That import is already reversed.');
  const paid = await trx.selectFrom('statutory_payments').select('component').where('org_id', '=', orgId).where('period', '=', imp.month).executeTakeFirst();
  if (paid) throw conflict(`Dues for ${monthLabel(imp.month)} have been paid against it. Delete those payments first (Payroll → Statutory Reports).`);
  const entries = await trx.selectFrom('journal_entries').select(['id', 'source_type']).where('org_id', '=', orgId)
    .where('source_type', 'in', ['payroll_import', 'payroll_import_payment']).where('source_id', '=', id).where('reversal_of_entry_id', 'is', null).execute();
  for (const e of entries) {
    if (e.source_type === 'payroll_import_payment' && await bankLineMatched(trx, orgId, 'journal_entry', e.id)) {
      throw conflict('The salary payment is matched to a line of the bank statement. Undo that match in Banking first.');
    }
  }
  let reversal: number | null = null;
  for (const e of entries) {
    const done = await trx.selectFrom('journal_entries').select('id').where('reversal_of_entry_id', '=', e.id).executeTakeFirst();
    if (done) continue;
    const r = await reverseEntry(trx, orgId, e.id, { memo: `Imported payroll for ${monthLabel(imp.month)} reversed${reason ? ` — ${reason}` : ''}`, userId, module: e.source_type === 'payroll_import' ? 'accountant' : 'banking' });
    if (e.source_type === 'payroll_import') reversal = r.id;
  }
  await trx.updateTable('payroll_imports').set({ status: 'reversed', reversal_entry_id: reversal, reverse_reason: reason }).where('id', '=', id).execute();
  return { month: imp.month };
}

export async function listImports(ex: Executor, orgId: number) {
  const rows = await ex.selectFrom('payroll_imports as i').leftJoin('users as u', 'u.id', 'i.created_by_user_id')
    .selectAll('i').select('u.name as by').where('i.org_id', '=', orgId).orderBy('i.month', 'desc').orderBy('i.id', 'desc').execute();
  return rows.map((r) => ({
    id: String(r.id), month: r.month, sourceSystem: r.source_system, fileName: r.file_name, employees: r.employees, status: r.status,
    grossPaise: p(r.gross), employerPaise: p(r.employer_cost), pfPaise: p(r.pf), esiPaise: p(r.esi), ptPaise: p(r.pt), lwfPaise: p(r.lwf),
    tdsPaise: p(r.tds), advancesPaise: p(r.advances), netPaise: p(r.net_pay), entryId: r.journal_entry_id ? String(r.journal_entry_id) : null,
    reverseReason: r.reverse_reason, by: r.by, at: new Date(r.created_at).toISOString(),
  }));
}
