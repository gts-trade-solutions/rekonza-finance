import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Paying micro and small enterprises on time.
//
// Section 15 of the MSMED Act: a buyer pays a micro or small supplier within
// the period agreed in writing, which may not exceed 45 days, or within 15 days
// when nothing was agreed in writing — counted from the day the goods or
// services were accepted, which the bill date stands for here. Medium
// enterprises are outside it, and so are traders registered on Udyam, whose
// registration is for priority-sector lending only (OM of 2 July 2021).
//
// What makes it bite is section 43B(h) of the 1961 Act — section 37(2)(g) of
// the 2025 Act: an amount owed to such a supplier past that limit is not a
// deduction in the year the expense was booked, only in the year it is paid.
// So at each year end the question is: of what is still owed for the year's
// bills, what was not paid by its own deadline? That is the disallowance, and
// next year it comes back when paid.
//
// Companies also file MSME-1 with the MCA twice a year, listing dues to micro
// and small suppliers outstanding for more than 45 days.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor } from '../db';
import type { Paise } from '../../types';
import { toPaiseFromSql } from '../money-sql';

const DAY = 86_400_000;
const t = (d: string) => Date.parse(`${d}T00:00:00Z`);
const addDays = (d: string, n: number) => new Date(t(d) + n * DAY).toISOString().slice(0, 10);
const daysFrom = (a: string, b: string) => Math.round((t(b) - t(a)) / DAY);

/** The limit in days: the written period, capped at 45, or 15 without one. */
export function msmeLimitDays(agreementDays: number | null | undefined): number {
  return agreementDays ? Math.min(agreementDays, 45) : 15;
}

/** The last day to pay a bill without losing the deduction. */
export function msmeDeadline(billDate: string, agreementDays: number | null | undefined): string {
  return addDays(billDate, msmeLimitDays(agreementDays));
}

/**
 * Whether the protection applies. A category nobody has filled in is treated
 * as covered: assuming it is not is the expensive mistake.
 */
export function msmeCovered(category: string | null, activity: string | null): boolean {
  if (category === 'medium') return false;
  if (activity === 'trading') return false;
  return true;
}

interface BillRow {
  id: number; internal_no: string; vendor_invoice_no: string; vendor_id: number; name: string; pan: string | null;
  udyam: string | null; category: string | null; activity: string | null; agreement: number | null;
  bill_date: string; subtotal: string; total: string;
}

/** Covered suppliers' bills, with what had been settled on each by a date. */
async function coveredBills(ex: Executor, orgId: number, f: { from?: string; to: string }) {
  const { rows } = await sql<BillRow>`
    SELECT b.id, b.internal_no, b.vendor_invoice_no, b.vendor_id, c.display_name AS name, c.pan,
           c.msme_udyam_no AS udyam, c.msme_category AS category, c.msme_activity AS activity,
           c.msme_agreement_days AS agreement, b.bill_date, b.subtotal, b.total
      FROM bills b JOIN contacts c ON c.id = b.vendor_id
     WHERE b.org_id = ${orgId} AND c.is_msme = 1 AND b.status NOT IN ('draft', 'void')
       AND b.bill_date <= ${f.to} ${f.from ? sql`AND b.bill_date >= ${f.from}` : sql``}
  `.execute(ex);
  return rows
    .filter((r) => msmeCovered(r.category, r.activity))
    .map((r) => ({ ...r, bill_date: String(r.bill_date).slice(0, 10) }));
}

/** Everything that settled each bill, dated: payments applied and vendor credits set against it. */
async function settlements(ex: Executor, orgId: number, billIds: number[]) {
  if (!billIds.length) return new Map<number, { date: string; amount: Paise }[]>();
  const { rows } = await sql<{ bill_id: number; on: string; amount: string }>`
    SELECT a.target_id AS bill_id, COALESCE(a.applied_on, p.payment_date) AS \`on\`, a.amount
      FROM payment_allocations a JOIN payments p ON p.id = a.payment_id
     WHERE a.org_id = ${orgId} AND a.target_type = 'bill' AND p.status <> 'void'
       AND a.target_id IN (${sql.join(billIds)})
    UNION ALL
    SELECT v.against_bill_id, v.credit_date, v.applied_amount
      FROM vendor_credits v
     WHERE v.org_id = ${orgId} AND v.status <> 'void' AND v.applied_amount > 0
       AND v.against_bill_id IN (${sql.join(billIds)})
  `.execute(ex);
  const by = new Map<number, { date: string; amount: Paise }[]>();
  for (const r of rows) {
    const list = by.get(r.bill_id) ?? [];
    list.push({ date: String(r.on).slice(0, 10), amount: toPaiseFromSql(r.amount) });
    by.set(r.bill_id, list);
  }
  return by;
}

const settledBy = (list: { date: string; amount: Paise }[] | undefined, date: string) =>
  (list ?? []).filter((s) => s.date <= date).reduce((t, s) => t + s.amount, 0);

// ── Open bills, against the clock ────────────────────────────────────────────

export interface MsmeOpenBill {
  billId: string; internalNo: string; vendorInvoiceNo: string; vendorId: string; vendorName: string; udyamNo: string | null;
  date: string; deadline: string; limitDays: number; writtenAgreement: boolean; categoryKnown: boolean;
  age: number; daysLeft: number; balancePaise: Paise; totalPaise: Paise;
  risk: 'breached' | 'critical' | 'safe';
}

export async function msmeOpenBills(ex: Executor, orgId: number, asOf: string): Promise<MsmeOpenBill[]> {
  const bills = await coveredBills(ex, orgId, { to: asOf });
  const paid = await settlements(ex, orgId, bills.map((b) => b.id));
  return bills.map((b) => {
    const balance = toPaiseFromSql(b.total) - settledBy(paid.get(b.id), asOf);
    const limit = msmeLimitDays(b.agreement);
    const deadline = msmeDeadline(b.bill_date, b.agreement);
    const left = daysFrom(asOf, deadline);
    return {
      billId: String(b.id), internalNo: b.internal_no, vendorInvoiceNo: b.vendor_invoice_no, vendorId: String(b.vendor_id),
      vendorName: b.name, udyamNo: b.udyam, date: b.bill_date, deadline, limitDays: limit, writtenAgreement: !!b.agreement,
      categoryKnown: !!b.category, age: daysFrom(b.bill_date, asOf), daysLeft: left, balancePaise: balance,
      totalPaise: toPaiseFromSql(b.total),
      // Breached: the deduction for the year is already lost unless paid in the same year.
      risk: (left < 0 ? 'breached' : left <= 7 ? 'critical' : 'safe') as MsmeOpenBill['risk'],
    };
  }).filter((b) => b.balancePaise > 0).sort((a, b) => a.daysLeft - b.daysLeft);
}

// ── The year-end disallowance ────────────────────────────────────────────────

export interface DisallowanceRow {
  billId: string; internalNo: string; vendorName: string; date: string; deadline: string;
  /** Owed on 31 March. */
  owedAtYearEndPaise: Paise;
  /** Of that, paid after 31 March but by the deadline: still allowed this year. */
  paidInTimePaise: Paise;
  /** The part of the bill that is expense, not GST, that is not deductible this year. */
  disallowedPaise: Paise;
  /** Still unpaid today. */
  stillOwedPaise: Paise;
}

export interface Disallowance {
  fy: string;
  yearEnd: string;
  asOf: string;
  rows: DisallowanceRow[];
  totalDisallowedPaise: Paise;
  /** Disallowed last year and paid this year: deductible now. */
  allowedThisYear: { billId: string; internalNo: string; vendorName: string; paidPaise: Paise }[];
  totalAllowedThisYearPaise: Paise;
  /** Deadlines still running after the year end: the figure can still go down. */
  provisional: boolean;
}

/**
 * The disallowance for the year starting 1 April `fyStart`, as known on
 * `asOf`. A bill whose deadline falls after 31 March is out of it if paid by
 * that deadline, so until the last such deadline passes the figure is provisional.
 *
 * The disallowance is on the expense, so the GST in a bill (claimed as credit,
 * never an expense) is taken out pro rata to what is owed.
 */
export async function msmeDisallowance(ex: Executor, orgId: number, fyStart: number, asOf: string): Promise<Disallowance> {
  const from = `${fyStart}-04-01`;
  const yearEnd = `${fyStart + 1}-03-31`;
  const bills = await coveredBills(ex, orgId, { from, to: yearEnd });
  const paid = await settlements(ex, orgId, bills.map((b) => b.id));
  let provisional = false;

  const rows: DisallowanceRow[] = [];
  for (const b of bills) {
    const total = toPaiseFromSql(b.total);
    const owed = total - settledBy(paid.get(b.id), yearEnd);
    if (owed <= 0) continue;
    const deadline = msmeDeadline(b.bill_date, b.agreement);
    const inTime = deadline > yearEnd ? Math.min(owed, settledBy(paid.get(b.id), deadline) - settledBy(paid.get(b.id), yearEnd)) : 0;
    if (deadline > asOf && deadline > yearEnd) provisional = true;
    const late = owed - inTime;
    const expenseShare = total > 0 ? toPaiseFromSql(b.subtotal) / total : 1;
    rows.push({
      billId: String(b.id), internalNo: b.internal_no, vendorName: b.name, date: b.bill_date, deadline,
      owedAtYearEndPaise: owed, paidInTimePaise: inTime, disallowedPaise: Math.round(late * expenseShare),
      stillOwedPaise: total - settledBy(paid.get(b.id), asOf),
    });
  }

  // Last year's disallowance, paid during this year.
  const prev = await coveredBills(ex, orgId, { from: `${fyStart - 1}-04-01`, to: `${fyStart}-03-31` });
  const prevPaid = await settlements(ex, orgId, prev.map((b) => b.id));
  const allowedThisYear = prev.flatMap((b) => {
    const total = toPaiseFromSql(b.total);
    const prevEnd = `${fyStart}-03-31`;
    const owed = total - settledBy(prevPaid.get(b.id), prevEnd);
    if (owed <= 0) return [];
    const deadline = msmeDeadline(b.bill_date, b.agreement);
    const late = owed - (deadline > prevEnd ? Math.min(owed, settledBy(prevPaid.get(b.id), deadline) - settledBy(prevPaid.get(b.id), prevEnd)) : 0);
    if (late <= 0) return [];
    // Paid this year, after the deadline (payments by the deadline were never disallowed).
    const paidThisYear = (prevPaid.get(b.id) ?? []).filter((s) => s.date > (deadline > prevEnd ? deadline : prevEnd) && s.date <= yearEnd)
      .reduce((s, x) => s + x.amount, 0);
    const share = total > 0 ? toPaiseFromSql(b.subtotal) / total : 1;
    const allowed = Math.round(Math.min(late, paidThisYear) * share);
    return allowed > 0 ? [{ billId: String(b.id), internalNo: b.internal_no, vendorName: b.name, paidPaise: allowed }] : [];
  });

  return {
    fy: `${fyStart}-${String((fyStart + 1) % 100).padStart(2, '0')}`,
    yearEnd, asOf,
    rows: rows.sort((a, b) => b.disallowedPaise - a.disallowedPaise),
    totalDisallowedPaise: rows.reduce((s, r) => s + r.disallowedPaise, 0),
    allowedThisYear,
    totalAllowedThisYearPaise: allowedThisYear.reduce((s, r) => s + r.paidPaise, 0),
    provisional,
  };
}

// ── MSME-1 ───────────────────────────────────────────────────────────────────

export interface Msme1Row {
  vendorId: string; vendorName: string; pan: string | null; udyamNo: string | null;
  bills: { internalNo: string; date: string; dueFrom: string; amountPaise: Paise }[];
  amountDuePaise: Paise;
}

/**
 * MSME-1 for the half-year ending `halfEnd` (30 September or 31 March):
 * amounts due to micro and small suppliers at that date, outstanding for more
 * than 45 days from acceptance, with the date each became due. It is filed by
 * 31 October and 30 April; the reasons for delay are the company's to give.
 */
export async function msme1(ex: Executor, orgId: number, halfEnd: string) {
  const bills = await coveredBills(ex, orgId, { to: halfEnd });
  const paid = await settlements(ex, orgId, bills.map((b) => b.id));
  const by = new Map<number, Msme1Row>();
  for (const b of bills) {
    const owed = toPaiseFromSql(b.total) - settledBy(paid.get(b.id), halfEnd);
    if (owed <= 0 || daysFrom(b.bill_date, halfEnd) <= 45) continue;
    const row = by.get(b.vendor_id) ?? {
      vendorId: String(b.vendor_id), vendorName: b.name, pan: b.pan, udyamNo: b.udyam, bills: [], amountDuePaise: 0,
    };
    row.bills.push({ internalNo: b.internal_no, date: b.bill_date, dueFrom: msmeDeadline(b.bill_date, b.agreement), amountPaise: owed });
    row.amountDuePaise += owed;
    by.set(b.vendor_id, row);
  }
  const month = Number(halfEnd.slice(5, 7));
  const year = Number(halfEnd.slice(0, 4));
  return {
    halfEnd,
    period: month === 9 ? `April–September ${year}` : `October ${year - 1}–March ${year}`,
    dueBy: month === 9 ? `${year}-10-31` : `${year}-04-30`,
    rows: [...by.values()].sort((a, b) => b.amountDuePaise - a.amountDuePaise),
    totalPaise: [...by.values()].reduce((s, r) => s + r.amountDuePaise, 0),
  };
}

// ── Interest under section 16 ────────────────────────────────────────────────
//
// Paid late, a micro or small supplier is owed interest at three times the
// bank rate notified by the RBI, compounded with monthly rests, from the day
// after the deadline to the day of payment. Section 23 denies it as a
// deduction, and Schedule III (with s.22 of the Act) asks the accounts to
// disclose it. Each late tranche — a payment after the deadline, or what is
// still unpaid — earns interest on its own; interest is linear in principal,
// so that is the same as compounding the balance.

/** Compound interest with monthly rests: whole months compounded, the odd days simple. */
export function msmeInterest(principal: Paise, from: string, to: string, bankRatePct: number): Paise {
  if (principal <= 0 || to < from) return 0;
  const r = (3 * bankRatePct) / 100 / 12;
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  let months = (ty - fy) * 12 + (tm - fm);
  if (td < fd) months -= 1;
  const anniversary = new Date(Date.UTC(fy, fm - 1 + months, fd)).toISOString().slice(0, 10);
  const oddDays = daysFrom(anniversary, to) + 1;
  const grown = principal * (1 + r) ** months * (1 + (r * oddDays) / 30);
  return Math.round(grown - principal);
}

export interface MsmeInterestRow {
  billId: string; internalNo: string; vendorName: string; date: string; deadline: string;
  /** Paid after the deadline, by the date, and the interest on it to each payment. */
  paidLatePaise: Paise; interestOnPaidPaise: Paise;
  /** Still unpaid past the deadline, and the interest on it to the date. */
  unpaidLatePaise: Paise; interestOnUnpaidPaise: Paise;
}

export async function msmeInterestReport(ex: Executor, orgId: number, fyStart: number, asOf: string, bankRatePct: number) {
  const from = `${fyStart}-04-01`;
  const bills = await coveredBills(ex, orgId, { to: asOf });
  const paid = await settlements(ex, orgId, bills.map((b) => b.id));
  const rows: MsmeInterestRow[] = [];
  for (const b of bills) {
    const deadline = msmeDeadline(b.bill_date, b.agreement);
    const start = addDays(deadline, 1);
    if (start > asOf) continue;
    const list = (paid.get(b.id) ?? []).filter((s) => s.date <= asOf);
    // Late payments made in this year; earlier years' interest was theirs to report.
    const late = list.filter((s) => s.date > deadline && s.date >= from);
    const paidLate = late.reduce((t, s) => t + s.amount, 0);
    const interestOnPaid = late.reduce((t, s) => t + msmeInterest(s.amount, start, s.date, bankRatePct), 0);
    const unpaid = Math.max(0, toPaiseFromSql(b.total) - list.reduce((t, s) => t + s.amount, 0));
    const interestOnUnpaid = msmeInterest(unpaid, start, asOf, bankRatePct);
    if (!paidLate && !unpaid) continue;
    rows.push({
      billId: String(b.id), internalNo: b.internal_no, vendorName: b.name, date: b.bill_date, deadline,
      paidLatePaise: paidLate, interestOnPaidPaise: interestOnPaid, unpaidLatePaise: unpaid, interestOnUnpaidPaise: interestOnUnpaid,
    });
  }
  const sum = (k: keyof MsmeInterestRow) => rows.reduce((t, r) => t + (r[k] as number), 0);
  return {
    fy: fyStart, asOf, bankRatePct, ratePct: 3 * bankRatePct,
    rows: rows.sort((a, b) => a.deadline.localeCompare(b.deadline)),
    // The disclosure Schedule III asks for, read with s.22 of the MSMED Act.
    disclosure: {
      principalUnpaidPaise: sum('unpaidLatePaise'),
      interestOnUnpaidPaise: sum('interestOnUnpaidPaise'),
      paidLatePaise: sum('paidLatePaise'),
      interestDueOnPaidLatePaise: sum('interestOnPaidPaise'),
      interestAccruedUnpaidPaise: sum('interestOnUnpaidPaise') + sum('interestOnPaidPaise'),
    },
  };
}
