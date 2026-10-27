import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// The compliance calendar: every return, payment and form the book owes, with
// its due date, worked out from what the book is — its GST registration and
// filing frequency, whether it deducts tax, whether it is a company, whether
// it exports under a LUT — and marked done as each is filed.
//
// The dates are the ones in the statutes and rules. The government extends
// them often, by notification and at short notice; an extension moves the date
// but not the obligation, so these are the dates to plan to.
//
//   GST (CGST Rules 59, 61, 62, 80 and the QRMP scheme, notification 84/2020)
//     GSTR-1      11th of the next month; 13th after the quarter under QRMP
//     IFF         13th of the first two months of a QRMP quarter (optional)
//     GSTR-3B     20th of the next month; 22nd or 24th after the quarter
//     PMT-06      25th of the first two months of a QRMP quarter
//     CMP-08      18th after the quarter, for composition
//     GSTR-4      30 June after the year, for composition
//     GSTR-9/9C   31 December after the year
//   Income tax
//     TDS deposit 7th of the next month; 30 April for March
//     TDS return  31 July, 31 October, 31 January, 31 May
//     TCS return  15 July, 15 October, 15 January, 15 May
//     Form 131/16A  fifteen days after the return
//     Advance tax 15 June, 15 September, 15 December, 15 March
//     Tax audit   30 September; the return 31 October where audited, else 31 July
//   Companies Act (companies only; assumes the AGM by 30 September)
//     DPT-3 30 June; AOC-4 30 days after the AGM; MGT-7 60 days after it
//   MSMED Act: MSME-1, 30 April and 31 October, for companies owing MSMEs
//   GST LUT for exports without tax: renewed before the year it covers
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor } from '../db';
import { depositDueDate, returnDueDate, type Quarter } from './tds-returns';
import { certificateDueDate } from './tds-certificates';

export type Area = 'gst' | 'tds' | 'income_tax' | 'roc' | 'msme' | 'payroll';

export interface Obligation {
  key: string;
  /** '2026-05' for a month, '2026-Q1' a quarter, '2026-H1' a half, '2026' the year starting April 2026. */
  period: string;
  periodLabel: string;
  title: string;
  area: Area;
  dueDate: string;
  detail: string;
  href?: string;
  optional?: boolean;
}

export interface CalendarProfile {
  registration: 'regular' | 'composition' | 'unregistered';
  frequency: 'monthly' | 'quarterly';
  /** State of the principal place of business: decides 22nd or 24th for quarterly GSTR-3B. */
  stateCode: string | null;
  einvoicing: boolean;
  deductsTds: boolean;
  collectsTcs: boolean;
  company: boolean;
  owesMsmes: boolean;
  lutValidTo: string | null;
  /** Has employees on the payroll: PF, ESI and the salary TDS return. */
  payroll: boolean;
}

/** States and UTs whose quarterly GSTR-3B is due on the 22nd; the rest file by the 24th. */
const THREE_B_22ND = new Set(['22', '23', '24', '25', '26', '27', '29', '30', '31', '32', '33', '34', '35', '36', '37']);

const pad = (n: number) => String(n).padStart(2, '0');
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** The month after `ym`, on a given day. */
const nextMonthOn = (ym: string, day: number) => {
  const [y, m] = ym.split('-').map(Number);
  return m === 12 ? `${y + 1}-01-${pad(day)}` : `${y}-${pad(m + 1)}-${pad(day)}`;
};
const monthLabel = (ym: string) => `${MONTHS[Number(ym.slice(5)) - 1]} ${ym.slice(0, 4)}`;
const fyLabel = (fy: number) => `FY ${fy}-${String(fy + 1).slice(2)}`;
/** The twelve months of the financial year starting April `fy`. */
const monthsOf = (fy: number) => Array.from({ length: 12 }, (_, i) => (i < 9 ? `${fy}-${pad(i + 4)}` : `${fy + 1}-${pad(i - 8)}`));
const quarterMonths = (fy: number, q: Quarter) => monthsOf(fy).slice((q - 1) * 3, q * 3);
const QLABEL: Record<Quarter, string> = { 1: 'April–June', 2: 'July–September', 3: 'October–December', 4: 'January–March' };

/** Everything the book owes for the financial year starting April `fy`. */
export function obligations(p: CalendarProfile, fy: number): Obligation[] {
  const out: Obligation[] = [];
  const quarters: Quarter[] = [1, 2, 3, 4];

  if (p.registration === 'regular') {
    if (p.frequency === 'monthly') {
      for (const m of monthsOf(fy)) {
        out.push({ key: 'gstr1', period: m, periodLabel: monthLabel(m), title: 'GSTR-1', area: 'gst', dueDate: nextMonthOn(m, 11),
          detail: 'Outward supplies, invoice by invoice.', href: '/gst/gstr1' });
        out.push({ key: 'gstr3b', period: m, periodLabel: monthLabel(m), title: 'GSTR-3B and tax payment', area: 'gst', dueDate: nextMonthOn(m, 20),
          detail: 'The summary return; the tax is paid with it.', href: '/gst/gstr3b' });
      }
    } else {
      const day3b = p.stateCode && THREE_B_22ND.has(p.stateCode) ? 22 : 24;
      for (const q of quarters) {
        const ms = quarterMonths(fy, q);
        const period = `${fy}-Q${q}`;
        const label = `${QLABEL[q]} ${q === 4 ? fy + 1 : fy}`;
        for (const m of ms.slice(0, 2)) {
          out.push({ key: 'iff', period: m, periodLabel: monthLabel(m), title: 'IFF (invoice furnishing facility)', area: 'gst', dueDate: nextMonthOn(m, 13),
            detail: 'B2B invoices of the month, so buyers can take credit before the quarter ends.', href: '/gst/iff', optional: true });
          out.push({ key: 'pmt06', period: m, periodLabel: monthLabel(m), title: 'PMT-06 monthly tax payment', area: 'gst', dueDate: nextMonthOn(m, 25),
            detail: 'Tax for the month, paid by challan; the quarter\'s GSTR-3B sets it off.', href: '/gst/gstr3b' });
        }
        out.push({ key: 'gstr1', period, periodLabel: label, title: 'GSTR-1 (quarterly)', area: 'gst', dueDate: nextMonthOn(ms[2], 13),
          detail: 'Outward supplies for the quarter.', href: '/gst/gstr1' });
        out.push({ key: 'gstr3b', period, periodLabel: label, title: 'GSTR-3B (quarterly)', area: 'gst', dueDate: nextMonthOn(ms[2], day3b),
          detail: `Due on the ${day3b}th for a business registered in this state.`, href: '/gst/gstr3b' });
      }
    }
    out.push({ key: 'gstr9', period: String(fy), periodLabel: fyLabel(fy), title: 'GSTR-9 annual return', area: 'gst', dueDate: `${fy + 1}-12-31`,
      detail: 'Optional where aggregate turnover is ₹2 crore or less.', href: '/gst/gstr9' });
    if (p.einvoicing) {
      out.push({ key: 'gstr9c', period: String(fy), periodLabel: fyLabel(fy), title: 'GSTR-9C reconciliation statement', area: 'gst', dueDate: `${fy + 1}-12-31`,
        detail: 'Self-certified, where aggregate turnover is above ₹5 crore.', href: '/gst/gstr9c' });
    }
  } else if (p.registration === 'composition') {
    for (const q of quarters) {
      const ms = quarterMonths(fy, q);
      out.push({ key: 'cmp08', period: `${fy}-Q${q}`, periodLabel: `${QLABEL[q]} ${q === 4 ? fy + 1 : fy}`, title: 'CMP-08', area: 'gst',
        dueDate: nextMonthOn(ms[2], 18), detail: 'Composition tax for the quarter, self-assessed and paid.' });
    }
    out.push({ key: 'gstr4', period: String(fy), periodLabel: fyLabel(fy), title: 'GSTR-4 annual return', area: 'gst', dueDate: `${fy + 1}-06-30`,
      detail: 'The composition dealer\'s annual return.' });
  }

  if (p.lutValidTo) {
    out.push({ key: 'lut', period: String(fy + 1), periodLabel: fyLabel(fy + 1), title: 'LUT for the next year', area: 'gst', dueDate: `${fy + 1}-03-31`,
      detail: 'Exports and SEZ supplies without tax need a LUT in force for the year (Form GST RFD-11).', href: '/settings' });
  }

  if (p.deductsTds) {
    for (const m of monthsOf(fy)) {
      out.push({ key: 'tds-deposit', period: m, periodLabel: monthLabel(m), title: 'TDS / TCS deposit', area: 'tds', dueDate: depositDueDate(m),
        detail: 'Tax deducted or collected in the month, paid by challan.', href: '/gst/tds-tcs' });
    }
    for (const q of quarters) {
      const label = `${QLABEL[q]} ${q === 4 ? fy + 1 : fy}`;
      out.push({ key: 'tds-return', period: `${fy}-Q${q}`, periodLabel: label, title: 'TDS return', area: 'tds', dueDate: returnDueDate(fy, q),
        detail: fy >= 2026 ? 'Form 140 (residents) and Form 144 (non-residents).' : 'Form 26Q (residents) and Form 27Q (non-residents).', href: '/gst/tds-tcs' });
      out.push({ key: 'tds-certificates', period: `${fy}-Q${q}`, periodLabel: label, title: fy >= 2026 ? 'Form 131 certificates' : 'Form 16A certificates',
        area: 'tds', dueDate: certificateDueDate(fy, q), detail: 'Downloaded from TRACES and issued to each deductee.', href: '/gst/tds-tcs' });
      if (p.collectsTcs) {
        const due = ({ 1: `${fy}-07-15`, 2: `${fy}-10-15`, 3: `${fy + 1}-01-15`, 4: `${fy + 1}-05-15` } as const)[q];
        out.push({ key: 'tcs-return', period: `${fy}-Q${q}`, periodLabel: label, title: 'TCS return', area: 'tds', dueDate: due,
          detail: fy >= 2026 ? 'Form 143.' : 'Form 27EQ.', href: '/gst/tds-tcs' });
      }
    }
  }

  if (p.payroll) {
    for (const m of monthsOf(fy)) {
      out.push({ key: 'pf', period: m, periodLabel: monthLabel(m), title: 'PF challan and ECR', area: 'payroll', dueDate: nextMonthOn(m, 15),
        detail: 'Both shares of provident fund, with admin and EDLI charges, by the ECR on the EPFO portal.', href: '/payroll/runs' });
      out.push({ key: 'esi', period: m, periodLabel: monthLabel(m), title: 'ESI contribution', area: 'payroll', dueDate: nextMonthOn(m, 15),
        detail: 'Both shares of ESI for covered employees, on the ESIC portal.', href: '/payroll/runs' });
    }
    for (const q of quarters) {
      out.push({ key: 'salary-tds-return', period: `${fy}-Q${q}`, periodLabel: `${QLABEL[q]} ${q === 4 ? fy + 1 : fy}`,
        title: fy >= 2026 ? 'Salary TDS return (Form 138)' : 'Salary TDS return (Form 24Q)', area: 'payroll', dueDate: returnDueDate(fy, q),
        detail: 'Tax deducted from salaries in the quarter, employee by employee.', href: '/payroll/runs' });
    }
    out.push({ key: 'form16', period: String(fy), periodLabel: fyLabel(fy), title: fy >= 2026 ? 'Form 130 to employees' : 'Form 16 to employees', area: 'payroll',
      dueDate: `${fy + 1}-06-15`, detail: 'The salary TDS certificate, from TRACES with the salary details.', href: '/payroll/runs' });
  }

  for (const [n, d] of [[1, `${fy}-06-15`], [2, `${fy}-09-15`], [3, `${fy}-12-15`], [4, `${fy + 1}-03-15`]] as const) {
    out.push({ key: 'advance-tax', period: `${fy}-I${n}`, periodLabel: `${fyLabel(fy)}, instalment ${n}`, title: 'Advance tax', area: 'income_tax', dueDate: d,
      detail: `${['15', '45', '75', '100'][n - 1]}% of the year's tax, cumulatively.` });
  }
  out.push({ key: 'tax-audit', period: String(fy), periodLabel: fyLabel(fy), title: 'Tax audit report', area: 'income_tax', dueDate: `${fy + 1}-09-30`,
    detail: 'Where turnover crosses the audit limit, or for a company.', optional: !p.company });
  out.push({ key: 'itr', period: String(fy), periodLabel: fyLabel(fy), title: 'Income-tax return', area: 'income_tax',
    dueDate: p.company ? `${fy + 1}-10-31` : `${fy + 1}-07-31`,
    detail: p.company ? 'Companies file by 31 October (30 November with a transfer-pricing report).' : '31 October instead where the accounts are audited.' });

  if (p.company) {
    out.push({ key: 'dpt3', period: String(fy), periodLabel: fyLabel(fy), title: 'DPT-3 (return of deposits)', area: 'roc', dueDate: `${fy + 1}-06-30`,
      detail: 'Outstanding loans and money received that are not deposits, as at 31 March.' });
    out.push({ key: 'aoc4', period: String(fy), periodLabel: fyLabel(fy), title: 'AOC-4 (financial statements)', area: 'roc', dueDate: `${fy + 1}-10-30`,
      detail: 'Thirty days after the AGM; dated here for an AGM on 30 September.', href: '/reports' });
    out.push({ key: 'mgt7', period: String(fy), periodLabel: fyLabel(fy), title: 'MGT-7 (annual return)', area: 'roc', dueDate: `${fy + 1}-11-29`,
      detail: 'Sixty days after the AGM; dated here for an AGM on 30 September.' });
    if (p.owesMsmes) {
      out.push({ key: 'msme1', period: `${fy}-H1`, periodLabel: `April–September ${fy}`, title: 'MSME-1', area: 'msme', dueDate: `${fy}-10-31`,
        detail: 'Amounts owed to micro and small suppliers for more than 45 days.', href: '/purchases/msme-tracker' });
      out.push({ key: 'msme1', period: `${fy}-H2`, periodLabel: `October ${fy}–March ${fy + 1}`, title: 'MSME-1', area: 'msme', dueDate: `${fy + 1}-04-30`,
        detail: 'Amounts owed to micro and small suppliers for more than 45 days.', href: '/purchases/msme-tracker' });
    }
  }
  return out;
}

export interface CalendarRow extends Obligation {
  status: 'done' | 'overdue' | 'due_soon' | 'upcoming';
  daysLeft: number;
  done: { on: string; reference: string | null; by: string | null } | null;
}

const COMPANY_NAME = /\b(private|pvt\.?)\s*(limited|ltd\.?)|\b(limited|ltd\.?)\s*$/i;

export async function calendarProfile(ex: Executor, orgId: number): Promise<CalendarProfile> {
  const o = await ex.selectFrom('organizations')
    .select(['name', 'legal_name', 'gst_registration_type', 'gst_filing_frequency', 'aato_above_5cr', 'tan', 'deductor_type', 'lut_valid_to'])
    .where('id', '=', orgId).executeTakeFirstOrThrow();
  const branch = await ex.selectFrom('branches').select('state_code').where('org_id', '=', orgId).orderBy('is_primary', 'desc').executeTakeFirst();
  const { rows } = await sql<{ tcs: number; msme: number; payroll: number }>`
    SELECT EXISTS(SELECT 1 FROM invoices WHERE org_id = ${orgId} AND tcs > 0 AND status <> 'void') AS tcs,
           EXISTS(SELECT 1 FROM employees WHERE org_id = ${orgId}) AS payroll,
           EXISTS(SELECT 1 FROM contacts WHERE org_id = ${orgId} AND is_msme = 1) AS msme
  `.execute(ex);
  const company = o.deductor_type ? ['K', 'M'].includes(o.deductor_type) : COMPANY_NAME.test(o.legal_name ?? o.name);
  return {
    registration: o.gst_registration_type,
    frequency: o.gst_filing_frequency,
    stateCode: branch?.state_code ?? null,
    einvoicing: !!o.aato_above_5cr,
    deductsTds: !!o.tan,
    collectsTcs: !!Number(rows[0]?.tcs),
    company,
    owesMsmes: !!Number(rows[0]?.msme),
    lutValidTo: o.lut_valid_to ? String(o.lut_valid_to).slice(0, 10) : null,
    payroll: !!Number(rows[0]?.payroll),
  };
}

const fyOf = (iso: string) => (Number(iso.slice(5, 7)) >= 4 ? Number(iso.slice(0, 4)) : Number(iso.slice(0, 4)) - 1);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** What falls due between two dates, with what has been done about it. */
export async function complianceCalendar(ex: Executor, orgId: number, from: string, to: string, today: string): Promise<{ profile: CalendarProfile; rows: CalendarRow[] }> {
  const profile = await calendarProfile(ex, orgId);
  const items: Obligation[] = [];
  // An annual return falls due well into the next year, so the year before is generated too.
  for (let fy = fyOf(from) - 1; fy <= fyOf(to); fy++) items.push(...obligations(profile, fy));
  const inRange = items.filter((i) => i.dueDate >= from && i.dueDate <= to);

  const filed = await ex.selectFrom('compliance_filings as f').leftJoin('users as u', 'u.id', 'f.created_by_user_id')
    .select(['f.item_key', 'f.period', 'f.done_on', 'f.reference', 'u.name'])
    .where('f.org_id', '=', orgId).execute();
  const doneOf = new Map(filed.map((f) => [`${f.item_key}|${f.period}`, f]));

  const rows = inRange.map((i): CalendarRow => {
    const d = doneOf.get(`${i.key}|${i.period}`);
    const daysLeft = daysBetween(today, i.dueDate);
    return {
      ...i,
      daysLeft,
      done: d ? { on: String(d.done_on).slice(0, 10), reference: d.reference, by: d.name } : null,
      status: d ? 'done' : daysLeft < 0 ? 'overdue' : daysLeft <= 7 ? 'due_soon' : 'upcoming',
    };
  }).sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.title.localeCompare(b.title));
  return { profile, rows };
}
