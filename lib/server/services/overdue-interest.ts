import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Interest on overdue invoices.
//
// Simple interest at the book's own rate (Settings → Policies), on each
// invoice's unpaid balance, from the day after its due date and any grace
// days, to the date it is worked out to. A charge records how far it went, so
// the next one starts the day after and no day is charged twice.
//
// The interest is billed on an ordinary invoice, raised as a draft for
// someone to check: interest for delayed payment is part of the value of the
// supply (CGST Act s.15(2)(d)), so it carries the HSN and GST rate of the
// invoice it is charged on. Interest invoices are not charged interest.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor, Trx } from '../db';
import type { Paise } from '../../types';
import { toPaiseFromSql, toSqlFromPaise } from '../money-sql';
import { badRequest } from '../http';
import { createInvoice } from './sales';

const DAY = 86_400_000;
const t = (d: string) => Date.parse(`${d}T00:00:00Z`);
const addDays = (d: string, n: number) => new Date(t(d) + n * DAY).toISOString().slice(0, 10);
const daysFrom = (a: string, b: string) => Math.round((t(b) - t(a)) / DAY);

export interface OverdueInterestRow {
  invoiceId: string; number: string; customerId: string; customerName: string;
  dueDate: string; balancePaise: Paise; from: string; to: string; days: number; interestPaise: Paise;
  hsnSac: string | null; gstRatePct: number;
}

export async function overdueInterest(ex: Executor, orgId: number, asOf: string, ratePct: number, graceDays: number): Promise<OverdueInterestRow[]> {
  const { rows } = await sql<{
    id: number; number: string; customer_id: number; customer: string; due_date: string; total: string; amount_paid: string;
    charged_to: string | null; hsn: string | null; rate: string | null;
  }>`
    SELECT i.id, i.number, i.customer_id, c.display_name AS customer, i.due_date, i.total, i.amount_paid,
           (SELECT MAX(to_date) FROM invoice_interest_charges ic WHERE ic.invoice_id = i.id) AS charged_to,
           (SELECT l.hsn_sac FROM invoice_lines l WHERE l.invoice_id = i.id ORDER BY l.taxable DESC, l.id LIMIT 1) AS hsn,
           (SELECT l.gst_rate_pct FROM invoice_lines l WHERE l.invoice_id = i.id ORDER BY l.taxable DESC, l.id LIMIT 1) AS rate
      FROM invoices i JOIN contacts c ON c.id = i.customer_id
     WHERE i.org_id = ${orgId} AND i.status NOT IN ('draft', 'void') AND i.total > i.amount_paid
       AND i.due_date < ${addDays(asOf, -graceDays)}
       AND i.id NOT IN (SELECT charge_invoice_id FROM invoice_interest_charges WHERE org_id = ${orgId})
  `.execute(ex);
  const out: OverdueInterestRow[] = [];
  for (const r of rows) {
    const due = String(r.due_date).slice(0, 10);
    const start = addDays(due, graceDays + 1);
    const from = r.charged_to && String(r.charged_to).slice(0, 10) >= start ? addDays(String(r.charged_to).slice(0, 10), 1) : start;
    if (from > asOf) continue;
    const days = daysFrom(from, asOf) + 1;
    const balance = toPaiseFromSql(r.total) - toPaiseFromSql(r.amount_paid);
    const interest = Math.round((balance * ratePct * days) / 100 / 365);
    if (interest <= 0) continue;
    out.push({
      invoiceId: String(r.id), number: r.number, customerId: String(r.customer_id), customerName: r.customer,
      dueDate: due, balancePaise: balance, from, to: asOf, days, interestPaise: interest,
      hsnSac: r.hsn, gstRatePct: Number(r.rate ?? 0),
    });
  }
  return out.sort((a, b) => a.customerName.localeCompare(b.customerName) || a.dueDate.localeCompare(b.dueDate));
}

/** Raise a draft invoice for one customer's interest to a date, and record what it covers. */
export async function raiseInterestInvoice(
  trx: Trx, orgId: number, userId: number | null,
  o: { customerId: number; asOf: string; ratePct: number; graceDays: number; branchId: number },
): Promise<{ id: number; number: string; totalPaise: Paise }> {
  const rows = (await overdueInterest(trx, orgId, o.asOf, o.ratePct, o.graceDays)).filter((r) => r.customerId === String(o.customerId));
  if (!rows.length) throw badRequest('This customer has no interest to charge to that date.');
  const inv = await createInvoice(trx, orgId, userId, {
    branchId: o.branchId, customerId: o.customerId, date: o.asOf, dueDate: o.asOf, status: 'draft',
    subject: 'Interest on overdue invoices',
    lines: rows.map((r) => ({
      description: `Interest at ${o.ratePct}% a year on ${r.number} (₹${(r.balancePaise / 100).toLocaleString('en-IN')} overdue) for ${r.days} days, ${r.from} to ${r.to}`,
      hsnSac: r.hsnSac ?? undefined, qty: 1, ratePaise: r.interestPaise, gstRatePct: r.gstRatePct,
    })),
  });
  for (const r of rows) {
    await trx.insertInto('invoice_interest_charges').values({
      org_id: orgId, invoice_id: Number(r.invoiceId), charge_invoice_id: inv.id, from_date: r.from, to_date: r.to,
      balance: toSqlFromPaise(r.balancePaise), rate_pct: String(o.ratePct), interest: toSqlFromPaise(r.interestPaise),
    }).execute();
  }
  return { id: inv.id, number: inv.number, totalPaise: inv.totalPaise };
}
