import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Payroll → Statutory Reports: each statutory deduction's register, its
// return or upload file where the government publishes one, and its tie to
// the pay runs and to the general ledger.
//
//   PF     the register by employee, and the EPFO's ECR 2.0 text upload:
//          UAN#~#name#~#gross wages#~#EPF wages#~#EPS wages#~#EDLI wages#~#
//          EPF contribution (EE)#~#EPS contribution#~#EPF-EPS difference (ER)#~#
//          NCP days#~#refund of advances — whole rupees, one member a line
//          (EPF Scheme, 1952, paragraph 38; EPS capped at 8.33% of ₹15,000).
//   ESI    the register, and the ESIC monthly contribution upload (IP number,
//          name, days paid, wages, reason code for zero days, last working
//          day) at 0.75% and 3.25% (ESI (Central) Rules, rule 51).
//   PT     by the state the employee works in, month by month with the slab
//          each fell in, for the state's monthly return, and the year.
//   LWF    by state and period (the half-year or year each state collects).
//   TDS    the monthly register, deposits by challan and the links
//          (salary-tds.ts), Form 24Q and Form 16.
//
// Each register's total is set beside what the pay runs posted to its payable
// account and what was paid out of it, so a difference shows at once.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor } from '../db';
import type { Paise } from '../../types';
import { toPaiseFromSql } from '../money-sql';
import { CODE, accountIds } from '../ledger/chart-of-accounts';
import { PF_WAGE_CEILING, PT_RULES, LWF_RULES, esiPeriodOf } from '../../payroll/statutory';
import { GST_STATES } from '../../tax/gst';

const p = toPaiseFromSql;
const rupees = (x: Paise) => Math.round(x / 100);
const pad = (n: number) => String(n).padStart(2, '0');
const lastDay = (month: string) => { const [y, m] = month.split('-').map(Number); return `${month}-${pad(new Date(y, m, 0).getDate())}`; };
const ymd = (v: unknown) => (v ? String(v instanceof Date ? v.toISOString() : v).slice(0, 10) : null);
const dmy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
export const stateName = (code: string) => PT_RULES[code]?.state ?? LWF_RULES[code]?.state ?? GST_STATES[code] ?? `State ${code}`;

/** Every posted line in the months, with what the reports need about the employee. */
async function linesIn(ex: Executor, orgId: number, from: string, to: string) {
  return ex.selectFrom('payroll_lines as l').innerJoin('payroll_runs as r', 'r.id', 'l.run_id')
    .innerJoin('employees as e', 'e.id', 'l.employee_id').innerJoin('branches as b', 'b.id', 'e.branch_id')
    .select(['r.id as run_id', 'r.month', 'l.employee_id', 'e.code', 'e.name', 'e.uan', 'e.esi_ip_number', 'e.pf_member', 'e.date_of_leaving',
      sql<string>`COALESCE(e.work_state_code, b.state_code)`.as('state'),
      'l.days_in_month', 'l.paid_days', 'l.lop_days', 'l.gross', 'l.bonus', 'l.pf_wage', 'l.eps_wage', 'l.pf_employee', 'l.pf_employer_epf',
      'l.pf_employer_eps', 'l.pf_admin', 'l.pf_edli', 'l.esi_wage', 'l.esi_employee', 'l.esi_employer', 'l.pt', 'l.lwf_employee', 'l.lwf_employer', 'l.tds'])
    .where('r.org_id', '=', orgId).where('r.status', 'in', ['posted', 'paid'])
    .where('r.month', '>=', from).where('r.month', '<=', to).orderBy('r.month').orderBy('e.code').execute();
}

/**
 * What the pay runs in the months posted to a payable, and what left it as
 * payments, from the ledger itself: credits by payroll entries (net of their
 * reversals), debits by statutory payments, salary TDS challans or salary payments.
 */
async function ledgerMovement(ex: Executor, orgId: number, code: string, runIds: number[], payTypes: string[], payIds: number[], importIds: number[] = []) {
  const acc = await accountIds(ex, orgId);
  const account = acc[code];
  if (!account) return { postedPaise: 0, paidPaise: 0 };
  const postedBy = async (sourceType: string, ids: number[]) => (ids.length
    ? p((await ex.selectFrom('journal_lines as l').innerJoin('journal_entries as e', 'e.id', 'l.entry_id')
      .select(sql<string>`COALESCE(SUM(l.credit - l.debit), 0)`.as('v'))
      .where('l.account_id', '=', account).where('e.source_type', '=', sourceType).where('e.source_id', 'in', ids).executeTakeFirst())?.v ?? '0')
    : 0);
  const postedPaise = await postedBy('payroll', runIds) + await postedBy('payroll_import', importIds);
  const paid = payIds.length
    ? await ex.selectFrom('journal_lines as l').innerJoin('journal_entries as e', 'e.id', 'l.entry_id')
      .select(sql<string>`COALESCE(SUM(l.debit - l.credit), 0)`.as('v'))
      .where('l.account_id', '=', account).where('e.source_type', 'in', payTypes).where('e.source_id', 'in', payIds).executeTakeFirst()
    : null;
  return { postedPaise, paidPaise: p(paid?.v ?? '0') };
}

async function statutoryPaid(ex: Executor, orgId: number, component: 'pf' | 'esi' | 'pt' | 'lwf', from: string, to: string) {
  const rows = await ex.selectFrom('statutory_payments').select(['id', 'amount']).where('org_id', '=', orgId).where('component', '=', component)
    .where('period', '>=', from).where('period', '<=', to).execute();
  return { ids: rows.map((r) => Number(r.id)), paidPaise: rows.reduce((t, r) => t + p(r.amount), 0) };
}

export interface Tie { registerPaise: Paise; importedPaise: Paise; ledgerPostedPaise: Paise; paidPaise: Paise; ledgerPaidPaise: Paise; ok: boolean }
/** The register (and any imported registers for the months) against the ledger. */
const tie = (register: Paise, imported: Paise, gl: { postedPaise: Paise; paidPaise: Paise }, paid: Paise): Tie => ({
  registerPaise: register + imported, importedPaise: imported, ledgerPostedPaise: gl.postedPaise, paidPaise: paid, ledgerPaidPaise: gl.paidPaise,
  ok: register + imported === gl.postedPaise && paid === gl.paidPaise,
});

/** Payroll run elsewhere and imported for these months (payroll-import.ts): its share of a due. */
async function importedIn(ex: Executor, orgId: number, from: string, to: string, column: 'pf' | 'esi' | 'pt' | 'lwf' | 'tds') {
  const rows = await ex.selectFrom('payroll_imports').select(['id', column]).where('org_id', '=', orgId).where('status', '=', 'posted')
    .where('month', '>=', from).where('month', '<=', to).execute();
  return { ids: rows.map((r) => Number(r.id)), totalPaise: rows.reduce((t, r) => t + p((r as unknown as Record<string, string>)[column]), 0) };
}

// ── PF ──────────────────────────────────────────────────────────────────────

export async function pfReport(ex: Executor, orgId: number, from: string, to: string) {
  const lines = (await linesIn(ex, orgId, from, to)).filter((l) => p(l.pf_employee) > 0 || p(l.pf_wage) > 0);
  const rows = lines.map((l) => {
    const epfWage = p(l.pf_wage);
    return {
      month: l.month, employeeId: String(l.employee_id), code: l.code, name: l.name, uan: l.uan,
      grossPaise: p(l.gross), epfWagesPaise: epfWage, epsWagesPaise: p(l.eps_wage),
      // EDLI is on wages up to the ceiling, whatever the contribution wage.
      edliWagesPaise: Math.min(epfWage, PF_WAGE_CEILING),
      eePaise: p(l.pf_employee), epsPaise: p(l.pf_employer_eps), erDiffPaise: p(l.pf_employer_epf),
      adminPaise: p(l.pf_admin), edliPaise: p(l.pf_edli),
      // Non-contributory period: the days of the month not paid for.
      ncpDays: Math.round(l.days_in_month - Number(l.paid_days)),
      totalPaise: p(l.pf_employee) + p(l.pf_employer_epf) + p(l.pf_employer_eps) + p(l.pf_admin) + p(l.pf_edli),
    };
  });
  const months = [...new Set(rows.map((r) => r.month))];
  const ecr = months.map((month) => {
    const mine = rows.filter((r) => r.month === month && r.eePaise > 0);
    return {
      month,
      text: mine.filter((r) => r.uan).map((r) => [
        r.uan, r.name.replace(/[^A-Za-z .]/g, '').toUpperCase(), rupees(r.grossPaise), rupees(r.epfWagesPaise), rupees(r.epsWagesPaise),
        rupees(r.edliWagesPaise), rupees(r.eePaise), rupees(r.epsPaise), rupees(r.erDiffPaise), r.ncpDays, 0,
      ].join('#~#')).join('\n'),
      members: mine.filter((r) => r.uan).length,
      missing: mine.filter((r) => !r.uan).map((r) => `${r.code} ${r.name}`),
      // The challan the ECR generates: A/c 1 (EE + ER difference), A/c 2 admin, A/c 10 EPS, A/c 21 EDLI.
      challan: {
        ac1Paise: mine.reduce((t, r) => t + r.eePaise + r.erDiffPaise, 0), ac2Paise: mine.reduce((t, r) => t + r.adminPaise, 0),
        ac10Paise: mine.reduce((t, r) => t + r.epsPaise, 0), ac21Paise: mine.reduce((t, r) => t + r.edliPaise, 0),
      },
    };
  });
  const total = rows.reduce((t, r) => t + r.totalPaise, 0);
  const paid = await statutoryPaid(ex, orgId, 'pf', from, to);
  const imp = await importedIn(ex, orgId, from, to, 'pf');
  const gl = await ledgerMovement(ex, orgId, CODE.PF_PAYABLE, [...new Set(lines.map((l) => Number(l.run_id)))], ['statutory_payment'], paid.ids, imp.ids);
  return { rows, ecr, totalPaise: total, tie: tie(total, imp.totalPaise, gl, paid.paidPaise) };
}

// ── ESI ─────────────────────────────────────────────────────────────────────

export async function esiReport(ex: Executor, orgId: number, from: string, to: string) {
  const all = await linesIn(ex, orgId, from, to);
  // Covered: contributions this month, or covered earlier in the same contribution period (a month of no pay still goes in the upload, with a reason).
  const coveredBefore = new Set<string>();
  const rows: {
    month: string; employeeId: string; code: string; name: string; ipNumber: string | null; paidDays: number;
    wagesPaise: Paise; eePaise: Paise; erPaise: Paise; reasonCode: number; lastWorkingDay: string;
  }[] = [];
  for (const l of all) {
    const period = esiPeriodOf(l.month);
    const key = `${l.employee_id}|${period.from}`;
    const covered = p(l.esi_employer) > 0 || p(l.esi_wage) > 0;
    if (covered) coveredBefore.add(key);
    else if (!coveredBefore.has(key)) continue;
    const paidDays = Math.round(Number(l.paid_days));
    const left = ymd(l.date_of_leaving);
    const leftThisMonth = !!left && left <= lastDay(l.month) && left >= `${l.month}-01`;
    // ESIC's reason codes: 0 none, 1 on leave, 2 left service (with the last working day).
    const reason = leftThisMonth ? 2 : paidDays === 0 ? 1 : 0;
    rows.push({
      month: l.month, employeeId: String(l.employee_id), code: l.code, name: l.name, ipNumber: l.esi_ip_number,
      paidDays, wagesPaise: p(l.esi_wage), eePaise: p(l.esi_employee), erPaise: p(l.esi_employer),
      reasonCode: reason, lastWorkingDay: leftThisMonth ? dmy(left!) : '',
    });
  }
  const months = [...new Set(rows.map((r) => r.month))];
  const uploads = months.map((month) => {
    const mine = rows.filter((r) => r.month === month);
    return {
      month,
      rows: [
        ['IP Number', 'IP Name', 'No of Days for which wages paid/payable during the month', 'Total Monthly Wages', 'Reason Code for Zero workings days(numeric only; provide 0 for all other reasons- Click on the link for reference)', 'Last Working Day( Format DD/MM/YYYY  or DD-MM-YYYY)'],
        ...mine.filter((r) => r.ipNumber).map((r) => [r.ipNumber!, r.name, r.paidDays, rupees(r.wagesPaise), r.reasonCode, r.lastWorkingDay]),
      ],
      missing: mine.filter((r) => !r.ipNumber).map((r) => `${r.code} ${r.name}`),
    };
  });
  const total = rows.reduce((t, r) => t + r.eePaise + r.erPaise, 0);
  const paid = await statutoryPaid(ex, orgId, 'esi', from, to);
  const imp = await importedIn(ex, orgId, from, to, 'esi');
  const gl = await ledgerMovement(ex, orgId, CODE.ESI_PAYABLE, [...new Set(all.map((l) => Number(l.run_id)))], ['statutory_payment'], paid.ids, imp.ids);
  return { rows, uploads, totalPaise: total, tie: tie(total, imp.totalPaise, gl, paid.paidPaise) };
}

// ── PT ──────────────────────────────────────────────────────────────────────

export async function ptReport(ex: Executor, orgId: number, from: string, to: string) {
  const all = await linesIn(ex, orgId, from, to);
  const lines = all.filter((l) => p(l.pt) > 0 || PT_RULES[l.state]);
  const states = [...new Set(lines.map((l) => l.state))].sort();
  const byState = states.map((code) => {
    const mine = lines.filter((l) => l.state === code);
    const months = [...new Set(mine.map((l) => l.month))];
    return {
      stateCode: code, state: stateName(code), basis: PT_RULES[code]?.basis ?? null, hasRule: !!PT_RULES[code],
      // The state's monthly return: employees by the slab their tax fell in.
      months: months.map((month) => {
        const m = mine.filter((l) => l.month === month);
        const slabs = new Map<number, { count: number; grossPaise: Paise }>();
        for (const l of m) {
          const s = slabs.get(p(l.pt)) ?? { count: 0, grossPaise: 0 };
          s.count++; s.grossPaise += p(l.gross);
          slabs.set(p(l.pt), s);
        }
        return {
          month, employees: m.length, grossPaise: m.reduce((t, l) => t + p(l.gross), 0), ptPaise: m.reduce((t, l) => t + p(l.pt), 0),
          slabs: [...slabs.entries()].sort((a, b) => a[0] - b[0]).map(([ratePaise, s]) => ({ ratePaise, ...s })),
        };
      }),
      // The year (the annual return and each employee's certificate).
      employees: [...new Set(mine.map((l) => Number(l.employee_id)))].map((id) => {
        const e = mine.filter((l) => Number(l.employee_id) === id);
        return { employeeId: String(id), code: e[0].code, name: e[0].name, months: e.length, grossPaise: e.reduce((t, l) => t + p(l.gross), 0), ptPaise: e.reduce((t, l) => t + p(l.pt), 0) };
      }),
      ptPaise: mine.reduce((t, l) => t + p(l.pt), 0),
    };
  });
  const rows = lines.map((l) => ({ month: l.month, employeeId: String(l.employee_id), code: l.code, name: l.name, state: stateName(l.state), grossPaise: p(l.gross), ptPaise: p(l.pt) }));
  const total = rows.reduce((t, r) => t + r.ptPaise, 0);
  const paid = await statutoryPaid(ex, orgId, 'pt', from, to);
  const imp = await importedIn(ex, orgId, from, to, 'pt');
  const gl = await ledgerMovement(ex, orgId, CODE.PT_PAYABLE, [...new Set(all.map((l) => Number(l.run_id)))], ['statutory_payment'], paid.ids, imp.ids);
  return { byState, rows, totalPaise: total, tie: tie(total, imp.totalPaise, gl, paid.paidPaise) };
}

// ── LWF ─────────────────────────────────────────────────────────────────────

export async function lwfReport(ex: Executor, orgId: number, from: string, to: string) {
  const all = await linesIn(ex, orgId, from, to);
  const lines = all.filter((l) => p(l.lwf_employee) > 0 || p(l.lwf_employer) > 0);
  const keys = [...new Set(lines.map((l) => `${l.state}|${l.month}`))].sort();
  const periods = keys.map((k) => {
    const [code, month] = k.split('|');
    const m = lines.filter((l) => l.state === code && l.month === month);
    const rule = LWF_RULES[code];
    return {
      stateCode: code, state: stateName(code), month,
      // The period the deduction covers: the half-year or the year ending that month.
      period: rule?.months.length === 2 ? (month.endsWith('-06') ? `January–June ${month.slice(0, 4)}` : `July–December ${month.slice(0, 4)}`) : `Year ${month.slice(0, 4)}`,
      employees: m.length, eePaise: m.reduce((t, l) => t + p(l.lwf_employee), 0), erPaise: m.reduce((t, l) => t + p(l.lwf_employer), 0),
    };
  });
  const rows = lines.map((l) => ({ month: l.month, employeeId: String(l.employee_id), code: l.code, name: l.name, state: stateName(l.state), eePaise: p(l.lwf_employee), erPaise: p(l.lwf_employer) }));
  const total = rows.reduce((t, r) => t + r.eePaise + r.erPaise, 0);
  const paid = await statutoryPaid(ex, orgId, 'lwf', from, to);
  const imp = await importedIn(ex, orgId, from, to, 'lwf');
  const gl = await ledgerMovement(ex, orgId, CODE.LWF_PAYABLE, [...new Set(all.map((l) => Number(l.run_id)))], ['statutory_payment'], paid.ids, imp.ids);
  return { periods, rows, totalPaise: total, tie: tie(total, imp.totalPaise, gl, paid.paidPaise) };
}

// ── TDS on salary ───────────────────────────────────────────────────────────

export async function tdsRegister(ex: Executor, orgId: number, from: string, to: string) {
  const all = await linesIn(ex, orgId, from, to);
  const links = await ex.selectFrom('salary_tds_links as k').innerJoin('salary_tds_challans as c', 'c.id', 'k.challan_id')
    .select(['k.employee_id', 'k.month', 'k.amount', 'c.bsr_code', 'c.challan_serial', 'c.challan_date'])
    .where('k.org_id', '=', orgId).where('k.month', '>=', from).where('k.month', '<=', to).execute();
  const rows = all.filter((l) => p(l.tds) > 0).map((l) => {
    const mine = links.filter((k) => Number(k.employee_id) === Number(l.employee_id) && k.month === l.month);
    return {
      month: l.month, employeeId: String(l.employee_id), code: l.code, name: l.name, grossPaise: p(l.gross), tdsPaise: p(l.tds),
      depositedPaise: mine.reduce((t, k) => t + p(k.amount), 0),
      challans: mine.map((k) => `${k.bsr_code}/${ymd(k.challan_date)}/${k.challan_serial}`),
    };
  });
  const challans = await ex.selectFrom('salary_tds_challans').select(['id', 'tax', 'surcharge', 'cess']).where('org_id', '=', orgId)
    .where('for_month', '>=', from).where('for_month', '<=', to).execute();
  const deposited = challans.reduce((t, c) => t + p(c.tax) + p(c.surcharge) + p(c.cess), 0);
  const total = rows.reduce((t, r) => t + r.tdsPaise, 0);
  const imp = await importedIn(ex, orgId, from, to, 'tds');
  const gl = await ledgerMovement(ex, orgId, CODE.TDS_PAYABLE, [...new Set(all.map((l) => Number(l.run_id)))], ['salary_tds_challan'], challans.map((c) => Number(c.id)), imp.ids);
  return { rows, totalPaise: total, tie: tie(total, imp.totalPaise, gl, deposited) };
}
