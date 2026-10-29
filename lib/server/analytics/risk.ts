import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Risk analytics: what looks wrong in the books, which customers are a credit
// risk, and when each one's money will really come in.
//
// Anomalies. The patterns an auditor samples for when looking for error or
// fraud in a journal — none of them proof of anything, each a reason to look:
//   * manual journals for round sums (₹50,000.00 exactly);
//   * manual journals keyed in at night, or dated long before they were keyed;
//   * manual journals touching cash or bank, which documents normally move;
//   * the same amount paid to the same party twice within a week;
//   * a bill far above what that supplier usually bills;
//   * first digits of expense postings that stray from Benford's law, which
//     naturally occurring amounts follow and made-up ones tend not to.
//
// Customer risk. A score out of 100 from how late they are now, how much of
// what they owe is overdue, how late they have paid before, and how much of
// their credit limit they use. Weighted to what predicts a bad debt: lateness
// now matters most.
//
// Collections. Each customer's open invoices, expected not on their due date
// but on the due date plus that customer's own average lateness — the
// difference between a forecast and a hope.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor } from '../db';
import type { Paise } from '../../types';
import { toPaiseFromSql } from '../money-sql';

const rupees = (p: Paise) => `₹${Math.round(p / 100).toLocaleString('en-IN')}`;
const DAY = 86_400_000;
const ymd = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);

export interface Anomaly {
  kind: 'round_sum' | 'odd_hours' | 'backdated' | 'manual_cash' | 'duplicate_payment' | 'unusual_bill' | 'benford';
  severity: 'low' | 'medium' | 'high';
  title: string;
  detail: string;
  date: string | null;
  amountPaise: Paise | null;
  href: string | null;
}

export async function anomalies(ex: Executor, orgId: number, from: string, to: string): Promise<Anomaly[]> {
  const out: Anomaly[] = [];

  // Manual journals in the period, with what they touch.
  const { rows: manual } = await sql<{ id: number; entry_no: number; entry_date: string; memo: string | null; total: string; posted_at: Date; cash: number }>`
    SELECT e.id, e.entry_no, e.entry_date, e.memo, e.total_debit AS total, e.posted_at,
           MAX(a.subtype IN ('cash', 'bank')) AS cash
      FROM journal_entries e
      JOIN journal_lines jl ON jl.entry_id = e.id
      JOIN accounts a ON a.id = jl.account_id
     WHERE e.org_id = ${orgId} AND e.source_type = 'manual' AND e.reversal_of_entry_id IS NULL
       AND e.entry_date BETWEEN ${from} AND ${to}
     GROUP BY e.id, e.entry_no, e.entry_date, e.memo, e.total_debit, e.posted_at
  `.execute(ex);
  for (const j of manual) {
    const amount = toPaiseFromSql(j.total);
    const label = `Journal #${j.entry_no}${j.memo ? ` (${j.memo.slice(0, 60)})` : ''}`;
    const date = ymd(j.entry_date);
    const href = '/accountant/journals';
    if (amount >= 10_000_00 && amount % 10_000_00 === 0) {
      out.push({ kind: 'round_sum', severity: 'low', title: `${label}: a round ${rupees(amount)}`, date, amountPaise: amount, href,
        detail: 'Real transactions rarely come to an exact round sum. Check what it is supported by.' });
    }
    // Keyed in between 10 pm and 6 am, India time.
    const hour = (new Date(j.posted_at).getUTCHours() + 5.5 + 24) % 24;
    if (hour >= 22 || hour < 6) {
      out.push({ kind: 'odd_hours', severity: 'low', title: `${label} keyed at ${String(Math.floor(hour)).padStart(2, '0')}:${String(Math.round((hour % 1) * 60)).padStart(2, '0')}`,
        date, amountPaise: amount, href, detail: 'Entered outside working hours. Usually innocent; worth knowing who and why.' });
    }
    const lag = daysBetween(date, ymd(j.posted_at));
    if (lag > 30) {
      out.push({ kind: 'backdated', severity: lag > 90 ? 'medium' : 'low', title: `${label} dated ${lag} days before it was keyed`, date, amountPaise: amount, href,
        detail: 'An entry back-dated into a period already reported changes figures people have relied on.' });
    }
    if (j.cash) {
      out.push({ kind: 'manual_cash', severity: 'medium', title: `${label} moves cash or bank by hand`, date, amountPaise: amount, href,
        detail: 'Money normally moves through receipts, payments and transfers. A journal to cash or bank bypasses them.' });
    }
  }

  // The same amount to the same party twice within seven days.
  const { rows: dupes } = await sql<{ a: number; b: number; an: string; bn: string; amount: string; d: string; party: string }>`
    SELECT p1.id AS a, p2.id AS b, p1.number AS an, p2.number AS bn, p1.amount, p2.payment_date AS d, c.display_name AS party
      FROM payments p1
      JOIN payments p2 ON p2.org_id = p1.org_id AND p2.contact_id = p1.contact_id AND p2.kind = p1.kind
                      AND p2.amount = p1.amount AND p2.id > p1.id AND p2.status <> 'void'
                      AND ABS(DATEDIFF(p2.payment_date, p1.payment_date)) <= 7
      JOIN contacts c ON c.id = p1.contact_id
     WHERE p1.org_id = ${orgId} AND p1.kind = 'made' AND p1.status <> 'void'
       AND p2.payment_date BETWEEN ${from} AND ${to}
  `.execute(ex);
  for (const d of dupes) {
    out.push({ kind: 'duplicate_payment', severity: 'high', title: `${d.an} and ${d.bn}: ${rupees(toPaiseFromSql(d.amount))} to ${d.party} twice in a week`,
      date: ymd(d.d), amountPaise: toPaiseFromSql(d.amount), href: '/purchases/payments',
      detail: 'Paid the same amount to the same supplier twice within seven days. Confirm both were owed.' });
  }

  // A bill far above the supplier's usual: over three times their median, with at least three before it.
  const { rows: bills } = await sql<{ id: number; vendor_id: number; internal_no: string; bill_date: string; total: string; party: string }>`
    SELECT b.id, b.vendor_id, b.internal_no, b.bill_date, b.total, c.display_name AS party
      FROM bills b JOIN contacts c ON c.id = b.vendor_id
     WHERE b.org_id = ${orgId} AND b.status NOT IN ('draft', 'void') AND b.bill_date <= ${to}
     ORDER BY b.vendor_id, b.bill_date, b.id
  `.execute(ex);
  const history = new Map<number, Paise[]>();
  for (const b of bills) {
    const amount = toPaiseFromSql(b.total);
    const before = history.get(b.vendor_id) ?? [];
    const date = ymd(b.bill_date);
    if (date >= from && before.length >= 3) {
      const sorted = [...before].sort((x, y) => x - y);
      const median = sorted[Math.floor(sorted.length / 2)];
      if (median > 0 && amount > median * 3) {
        out.push({ kind: 'unusual_bill', severity: 'medium', title: `${b.internal_no} from ${b.party}: ${rupees(amount)}, ${(amount / median).toFixed(1)} times their usual`,
          date, amountPaise: amount, href: `/purchases/bills/${b.id}`,
          detail: `This supplier's bills are usually around ${rupees(median)}. Check the quantity and rate against the order and the goods received.` });
      }
    }
    before.push(amount);
    history.set(b.vendor_id, before);
  }

  // Benford's law over the period's expense postings.
  const { rows: amounts } = await sql<{ v: string }>`
    SELECT jl.debit AS v FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
     WHERE jl.org_id = ${orgId} AND a.type = 'expense' AND jl.debit >= 10 AND jl.entry_date BETWEEN ${from} AND ${to}
  `.execute(ex);
  if (amounts.length >= 100) {
    const seen = Array(10).fill(0);
    for (const a of amounts) seen[Number(String(Math.trunc(Number(a.v))).replace(/^0+/, '')[0])]++;
    // Mean absolute deviation from Benford's proportions (Nigrini: over 0.015 is nonconforming).
    const mad = [1, 2, 3, 4, 5, 6, 7, 8, 9].reduce((t, d) => t + Math.abs(seen[d] / amounts.length - Math.log10(1 + 1 / d)), 0) / 9;
    if (mad > 0.015) {
      out.push({ kind: 'benford', severity: mad > 0.022 ? 'medium' : 'low', title: `Expense amounts stray from Benford's law (MAD ${mad.toFixed(3)})`,
        date: null, amountPaise: null, href: '/reports/general-ledger',
        detail: `Over ${amounts.length} expense postings, the first digits do not follow the pattern natural amounts do. Look for many amounts just under an approval limit or repeated figures.` });
    }
  }

  const rank = { high: 0, medium: 1, low: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity] || (b.date ?? '').localeCompare(a.date ?? ''));
}

export interface CustomerRisk {
  id: string;
  name: string;
  owedPaise: Paise;
  overduePaise: Paise;
  oldestDaysOverdue: number;
  avgDaysLate: number | null;
  limitUsePct: number | null;
  score: number;
  band: 'low' | 'medium' | 'high';
  /** When their open invoices are expected to be paid, going by how late they usually are. */
  expectedPaise: { next30: Paise; next60: Paise; next90: Paise; later: Paise };
}

export async function customerRisk(ex: Executor, orgId: number, today: string): Promise<CustomerRisk[]> {
  const [open, paid] = await Promise.all([
    sql<{ customer_id: number; name: string; credit_limit: string | null; due_date: string; left: string }>`
      SELECT i.customer_id, c.display_name AS name, c.credit_limit, i.due_date, i.total - i.amount_paid AS \`left\`
        FROM invoices i JOIN contacts c ON c.id = i.customer_id
       WHERE i.org_id = ${orgId} AND i.status NOT IN ('draft', 'void') AND i.total > i.amount_paid
    `.execute(ex),
    // How late each paid invoice was: its last payment against its due date.
    sql<{ customer_id: number; late: string }>`
      SELECT i.customer_id, DATEDIFF(MAX(p.payment_date), i.due_date) AS late
        FROM invoices i
        JOIN payment_allocations pa ON pa.org_id = i.org_id AND pa.target_type = 'invoice' AND pa.target_id = i.id
        JOIN payments p ON p.id = pa.payment_id AND p.status <> 'void'
       WHERE i.org_id = ${orgId} AND i.status = 'paid'
       GROUP BY i.id, i.customer_id, i.due_date
    `.execute(ex),
  ]);
  const lateness = new Map<number, number[]>();
  for (const r of paid.rows) {
    const list = lateness.get(r.customer_id) ?? [];
    list.push(Math.max(0, Number(r.late)));
    lateness.set(r.customer_id, list);
  }
  const by = new Map<number, CustomerRisk & { raw: number }>();
  for (const r of open.rows) {
    const left = toPaiseFromSql(r.left);
    const due = ymd(r.due_date);
    const overdueDays = Math.max(0, daysBetween(due, today));
    const history = lateness.get(r.customer_id);
    const avgLate = history?.length ? history.reduce((t, x) => t + x, 0) / history.length : null;
    const c = by.get(r.customer_id) ?? {
      id: String(r.customer_id), name: r.name, owedPaise: 0, overduePaise: 0, oldestDaysOverdue: 0,
      avgDaysLate: avgLate === null ? null : Math.round(avgLate),
      limitUsePct: null, score: 0, band: 'low' as const, raw: r.credit_limit === null ? 0 : toPaiseFromSql(r.credit_limit),
      expectedPaise: { next30: 0, next60: 0, next90: 0, later: 0 },
    };
    c.owedPaise += left;
    if (overdueDays > 0) c.overduePaise += left;
    c.oldestDaysOverdue = Math.max(c.oldestDaysOverdue, overdueDays);
    // Expected on: the due date plus their usual lateness. Already a month past
    // even that, it is no longer expected on any date: it is at risk, under Later.
    const expectedIn = daysBetween(today, due) + Math.round(avgLate ?? 0);
    const bucket = expectedIn < -30 ? 'later' : expectedIn <= 30 ? 'next30' : expectedIn <= 60 ? 'next60' : expectedIn <= 90 ? 'next90' : 'later';
    c.expectedPaise[bucket] += left;
    by.set(r.customer_id, c);
  }
  return [...by.values()].map(({ raw, ...c }) => {
    const limitUse = raw > 0 ? c.owedPaise / raw : null;
    const score = Math.round(100 * (
      0.40 * Math.min(1, c.oldestDaysOverdue / 90)
      + 0.25 * (c.owedPaise > 0 ? c.overduePaise / c.owedPaise : 0)
      + 0.20 * Math.min(1, (c.avgDaysLate ?? 0) / 60)
      + 0.15 * Math.min(1, limitUse ?? 0)
    ));
    return {
      ...c, limitUsePct: limitUse === null ? null : Math.round(limitUse * 100), score,
      band: score >= 60 ? 'high' as const : score >= 30 ? 'medium' as const : 'low' as const,
    };
  }).sort((a, b) => b.score - a.score);
}
