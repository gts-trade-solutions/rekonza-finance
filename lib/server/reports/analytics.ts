import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Dashboard analytics, aggregated in SQL.
//
// These answer management questions — how are we doing, against what? — rather
// than bookkeeping ones, which is why they live apart from the statements. They
// are still derived from the same journal and documents, so nothing here can
// disagree with a report.
//
// Every figure excludes drafts and voids. A draft is not a document yet and a
// void one was cancelled; counting either flatters the numbers people steer by.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor } from '../db';
import type { Paise } from '../../types';
import { toPaiseFromSql } from '../money-sql';
import { msmeOpenBills } from '../services/msme';

export interface Window {
  from: string;
  to: string;
}

/** The window of the same length immediately before `w`. */
export function previousWindow(w: Window): Window {
  const from = new Date(w.from);
  const to = new Date(w.to);
  const days = Math.max(1, Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1);
  const prevTo = new Date(from.getTime() - 86_400_000);
  const prevFrom = new Date(prevTo.getTime() - (days - 1) * 86_400_000);
  return { from: prevFrom.toISOString().slice(0, 10), to: prevTo.toISOString().slice(0, 10) };
}

export interface SalesPerformance {
  billed: Paise;
  collected: Paise;
  outstanding: Paise;
  invoiceCount: number;
  customerCount: number;
  avgInvoice: Paise;
  paid: number;
  partial: number;
  unpaid: number;
}

/**
 * Billed against collected for a window.
 *
 * The two will not tie, and should not: an invoice raised in August may be
 * collected in October. Conflating them is the most common way a sales
 * dashboard misleads whoever reads it.
 */
export async function salesPerformance(
  ex: Executor,
  orgId: number,
  w: Window,
): Promise<SalesPerformance> {
  const { rows } = await sql<{
    billed: string; outstanding: string; n: string; customers: string;
    paid: string; partial: string; unpaid: string;
  }>`
    SELECT COALESCE(SUM(total), 0) AS billed,
           COALESCE(SUM(total - amount_paid), 0) AS outstanding,
           COUNT(*) AS n,
           COUNT(DISTINCT customer_id) AS customers,
           SUM(amount_paid >= total) AS paid,
           SUM(amount_paid > 0 AND amount_paid < total) AS partial,
           SUM(amount_paid = 0) AS unpaid
      FROM invoices
     WHERE org_id = ${orgId} AND status NOT IN ('draft', 'void')
       AND invoice_date BETWEEN ${w.from} AND ${w.to}
  `.execute(ex);

  // Cash actually received in the window, whenever the invoice was raised.
  const { rows: cash } = await sql<{ collected: string }>`
    SELECT COALESCE(SUM(amount), 0) AS collected
      FROM payments
     WHERE org_id = ${orgId} AND kind = 'received' AND status <> 'void'
       AND payment_date BETWEEN ${w.from} AND ${w.to}
  `.execute(ex);

  const r = rows[0];
  const billed = toPaiseFromSql(r?.billed ?? '0');
  const count = Number(r?.n ?? 0);

  return {
    billed,
    collected: toPaiseFromSql(cash[0]?.collected ?? '0'),
    outstanding: toPaiseFromSql(r?.outstanding ?? '0'),
    invoiceCount: count,
    customerCount: Number(r?.customers ?? 0),
    avgInvoice: count ? Math.round(billed / count) : 0,
    paid: Number(r?.paid ?? 0),
    partial: Number(r?.partial ?? 0),
    unpaid: Number(r?.unpaid ?? 0),
  };
}

/** Billed against collected, month by month — the shape of the cash gap. */
export async function billedVsCollected(
  ex: Executor,
  orgId: number,
  months: number,
  asOf: string,
): Promise<{ month: string; billed: number; collected: number }[]> {
  const start = new Date(asOf);
  start.setMonth(start.getMonth() - (months - 1));
  const from = `${start.toISOString().slice(0, 7)}-01`;

  const [{ rows: billedRows }, { rows: collectedRows }] = await Promise.all([
    sql<{ m: string; total: string }>`
      SELECT DATE_FORMAT(invoice_date, '%Y-%m') AS m, COALESCE(SUM(total), 0) AS total
        FROM invoices
       WHERE org_id = ${orgId} AND status NOT IN ('draft', 'void')
         AND invoice_date BETWEEN ${from} AND ${asOf}
       GROUP BY m
    `.execute(ex),
    sql<{ m: string; total: string }>`
      SELECT DATE_FORMAT(payment_date, '%Y-%m') AS m, COALESCE(SUM(amount), 0) AS total
        FROM payments
       WHERE org_id = ${orgId} AND kind = 'received' AND status <> 'void'
         AND payment_date BETWEEN ${from} AND ${asOf}
       GROUP BY m
    `.execute(ex),
  ]);

  const billedBy = new Map(billedRows.map((r) => [r.m, toPaiseFromSql(r.total)]));
  const collectedBy = new Map(collectedRows.map((r) => [r.m, toPaiseFromSql(r.total)]));

  const out: { month: string; billed: number; collected: number }[] = [];
  for (let k = months - 1; k >= 0; k--) {
    const d = new Date(asOf);
    d.setMonth(d.getMonth() - k);
    const key = d.toISOString().slice(0, 7);
    out.push({
      month: d.toLocaleDateString('en-IN', { month: 'short', year: '2-digit' }),
      // Charted in rupees; the store speaks paise.
      billed: (billedBy.get(key) ?? 0) / 100,
      collected: (collectedBy.get(key) ?? 0) / 100,
    });
  }
  return out;
}

/** Sales and expenses per month, excluding GST. */
export async function monthlySeries(
  ex: Executor,
  orgId: number,
  months: number,
  asOf: string,
): Promise<{ month: string; sales: number; expenses: number }[]> {
  const start = new Date(asOf);
  start.setMonth(start.getMonth() - (months - 1));
  const from = `${start.toISOString().slice(0, 7)}-01`;

  const { rows } = await sql<{ m: string; sales: string; expenses: string }>`
    SELECT m,
           COALESCE(SUM(sales), 0) AS sales,
           COALESCE(SUM(expenses), 0) AS expenses
      FROM (
        SELECT DATE_FORMAT(i.invoice_date, '%Y-%m') AS m, i.subtotal AS sales, 0 AS expenses
          FROM invoices i
         WHERE i.org_id = ${orgId} AND i.status NOT IN ('draft', 'void')
           AND i.invoice_date BETWEEN ${from} AND ${asOf}
        UNION ALL
        SELECT DATE_FORMAT(b.bill_date, '%Y-%m'), 0, b.subtotal
          FROM bills b
         WHERE b.org_id = ${orgId} AND b.status <> 'void'
           AND b.bill_date BETWEEN ${from} AND ${asOf}
        UNION ALL
        SELECT DATE_FORMAT(e.expense_date, '%Y-%m'), 0, e.amount
          FROM expenses e
         WHERE e.org_id = ${orgId} AND e.status <> 'void'
           AND e.expense_date BETWEEN ${from} AND ${asOf}
      ) x
     GROUP BY m
  `.execute(ex);

  const by = new Map(rows.map((r) => [r.m, r]));
  const out: { month: string; sales: number; expenses: number }[] = [];
  for (let k = months - 1; k >= 0; k--) {
    const d = new Date(asOf);
    d.setMonth(d.getMonth() - k);
    const key = d.toISOString().slice(0, 7);
    const r = by.get(key);
    out.push({
      month: d.toLocaleDateString('en-IN', { month: 'short' }),
      sales: toPaiseFromSql(r?.sales ?? '0') / 100,
      expenses: toPaiseFromSql(r?.expenses ?? '0') / 100,
    });
  }
  return out;
}

/**
 * Revenue split by what was actually sold.
 *
 * Resolved from the item where there is one, and from the code otherwise — a
 * SAC always begins 99, an HSN never does. That fallback matters for ad-hoc
 * lines that carry a code but no catalogue item.
 */
export async function goodsVsServices(
  ex: Executor,
  orgId: number,
  w: Window,
): Promise<{ key: 'goods' | 'service'; label: string; value: Paise; lines: number }[]> {
  // The kind is derived in a subquery and grouped outside it. Grouping directly
  // on a CASE that reads non-aggregated columns is rejected under MySQL's
  // only_full_group_by, which is on by default and worth leaving on.
  const { rows } = await sql<{ kind: string; value: string; n: string }>`
    SELECT kind, COALESCE(SUM(taxable), 0) AS value, COUNT(*) AS n
      FROM (
        SELECT CASE
                 WHEN it.kind = 'service' THEN 'service'
                 WHEN it.id IS NULL AND l.hsn_sac LIKE '99%' THEN 'service'
                 ELSE 'goods'
               END AS kind,
               l.taxable AS taxable
          FROM invoice_lines l
          JOIN invoices i ON i.id = l.invoice_id
          LEFT JOIN items it ON it.id = l.item_id
         WHERE i.org_id = ${orgId} AND i.status NOT IN ('draft', 'void')
           AND i.invoice_date BETWEEN ${w.from} AND ${w.to}
      ) x
     GROUP BY kind
  `.execute(ex);

  const by = new Map(rows.map((r) => [r.kind, r]));
  return (['goods', 'service'] as const).map((k) => ({
    key: k,
    label: k === 'goods' ? 'Goods' : 'Services',
    value: toPaiseFromSql(by.get(k)?.value ?? '0'),
    lines: Number(by.get(k)?.n ?? 0),
  }));
}

export interface GrossMargin {
  revenue: Paise;
  cogs: Paise;
  gross: Paise;
  marginPct: number;
  units: number;
  linesWithoutCost: number;
}

/**
 * Indicative gross margin: revenue less the catalogue purchase price of what
 * was sold.
 *
 * IMPORTANT — this does not tie to the Profit and Loss and is not meant to. A
 * true cost of goods sold needs perpetual inventory valuation, which this build
 * does not post; purchases are expensed when billed. Useful for pricing, not
 * for filing, which is why it is owner-only and labelled on the card.
 */
export async function grossMargin(ex: Executor, orgId: number, w: Window): Promise<GrossMargin> {
  const { rows } = await sql<{
    revenue: string; cogs: string; units: string; nocost: string;
  }>`
    SELECT COALESCE(SUM(l.taxable), 0) AS revenue,
           COALESCE(SUM(CASE WHEN it.purchase_price > 0 THEN it.purchase_price * l.qty ELSE 0 END), 0) AS cogs,
           COALESCE(SUM(l.qty), 0) AS units,
           SUM(CASE WHEN it.id IS NULL OR (it.purchase_price = 0 AND it.kind <> 'service') THEN 1 ELSE 0 END) AS nocost
      FROM invoice_lines l
      JOIN invoices i ON i.id = l.invoice_id
      LEFT JOIN items it ON it.id = l.item_id
     WHERE i.org_id = ${orgId} AND i.status NOT IN ('draft', 'void')
       AND i.invoice_date BETWEEN ${w.from} AND ${w.to}
  `.execute(ex);

  const r = rows[0];
  const revenue = toPaiseFromSql(r?.revenue ?? '0');
  const cogs = toPaiseFromSql(r?.cogs ?? '0');
  const gross = revenue - cogs;

  return {
    revenue,
    cogs,
    gross,
    marginPct: revenue > 0 ? (gross / revenue) * 100 : 0,
    units: Math.round(Number(r?.units ?? 0)),
    linesWithoutCost: Number(r?.nocost ?? 0),
  };
}

export interface PartyRow {
  contactId: string;
  name: string;
  value: Paise;
  overdue: Paise;
  pct: number;
  count: number;
}

/** Who owes us the most, or who we owe the most. */
export async function topParties(
  ex: Executor,
  orgId: number,
  side: 'debtors' | 'creditors',
  asOf: string,
  limit = 6,
): Promise<PartyRow[]> {
  const { rows } = side === 'debtors'
    ? await sql<{ id: number; name: string; value: string; overdue: string; n: string }>`
        SELECT c.id, c.display_name AS name,
               COALESCE(SUM(i.total - i.amount_paid), 0) AS value,
               COALESCE(SUM(CASE WHEN i.due_date < ${asOf} THEN i.total - i.amount_paid ELSE 0 END), 0) AS overdue,
               COUNT(*) AS n
          FROM invoices i JOIN contacts c ON c.id = i.customer_id
         WHERE i.org_id = ${orgId} AND i.status NOT IN ('draft', 'void') AND i.total > i.amount_paid
         GROUP BY c.id, c.display_name ORDER BY value DESC LIMIT ${limit}
      `.execute(ex)
    : await sql<{ id: number; name: string; value: string; overdue: string; n: string }>`
        SELECT c.id, c.display_name AS name,
               COALESCE(SUM(b.total - b.amount_paid), 0) AS value,
               COALESCE(SUM(CASE WHEN b.due_date < ${asOf} THEN b.total - b.amount_paid ELSE 0 END), 0) AS overdue,
               COUNT(*) AS n
          FROM bills b JOIN contacts c ON c.id = b.vendor_id
         WHERE b.org_id = ${orgId} AND b.status NOT IN ('draft', 'void') AND b.total > b.amount_paid
         GROUP BY c.id, c.display_name ORDER BY value DESC LIMIT ${limit}
      `.execute(ex);

  const grand = rows.reduce((t, r) => t + toPaiseFromSql(r.value), 0);
  return rows.map((r) => ({
    contactId: String(r.id),
    name: r.name,
    value: toPaiseFromSql(r.value),
    overdue: toPaiseFromSql(r.overdue),
    count: Number(r.n),
    pct: grand > 0 ? (toPaiseFromSql(r.value) / grand) * 100 : 0,
  }));
}

export interface CustomerSales { contactId: string; name: string; salesPaise: Paise; invoices: number; pct: number }

/**
 * Who bought the most in a window: sales before tax, less what was credited
 * back, and each one's share of the window's sales.
 */
export async function topCustomers(ex: Executor, orgId: number, w: Window, limit = 6): Promise<CustomerSales[]> {
  const { rows } = await sql<{ id: number; name: string; sales: string; n: string }>`
    SELECT c.id, c.display_name AS name, SUM(x.amount) AS sales, SUM(x.n) AS n
      FROM (
        SELECT customer_id, subtotal AS amount, 1 AS n FROM invoices
         WHERE org_id = ${orgId} AND status NOT IN ('draft', 'void') AND invoice_date BETWEEN ${w.from} AND ${w.to}
        UNION ALL
        SELECT customer_id, -subtotal, 0 FROM credit_notes
         WHERE org_id = ${orgId} AND status <> 'void' AND note_date BETWEEN ${w.from} AND ${w.to}
      ) x JOIN contacts c ON c.id = x.customer_id
     GROUP BY c.id, c.display_name HAVING SUM(x.amount) > 0
     ORDER BY sales DESC
  `.execute(ex);
  const total = rows.reduce((t, r) => t + toPaiseFromSql(r.sales), 0);
  return rows.slice(0, limit).map((r) => ({
    contactId: String(r.id), name: r.name, salesPaise: toPaiseFromSql(r.sales), invoices: Number(r.n),
    pct: total > 0 ? (toPaiseFromSql(r.sales) / total) * 100 : 0,
  }));
}

/**
 * MSME bills approaching or past the statutory 45-day limit.
 *
 * Section 43B(h) disallows the expense entirely if a registered micro or small
 * supplier is not paid within 45 days — a lost deduction for the year, not
 * interest on a late payment.
 */
export async function msmeRisk(
  ex: Executor,
  orgId: number,
  asOf: string,
): Promise<{ billId: string; internalNo: string; vendorName: string; age: number; daysLeft: number; balancePaise: Paise; risk: 'critical' | 'breached' }[]> {
  // The deadline is each supplier's own: the period agreed in writing, or 15
  // days without one (lib/server/services/msme.ts).
  const bills = await msmeOpenBills(ex, orgId, asOf);
  return bills.filter((b) => b.risk !== 'safe').map((b) => ({
    billId: b.billId, internalNo: b.internalNo, vendorName: b.vendorName, age: b.age, daysLeft: b.daysLeft,
    balancePaise: b.balancePaise, risk: b.risk as 'critical' | 'breached',
  }));
}

/** Live balance per bank account, plus how many statement lines are waiting. */
export async function cashPosition(
  ex: Executor,
  orgId: number,
): Promise<{ id: string; name: string; kind: string; balancePaise: Paise; unmatched: number }[]> {
  const { rows } = await sql<{
    id: number; name: string; kind: string; movement: string; unmatched: number;
  }>`
    SELECT ba.id, ba.name, ba.kind,
           COALESCE((SELECT SUM(jl.debit - jl.credit) FROM journal_lines jl
                      WHERE jl.account_id = ba.ledger_account_id), 0) AS movement,
           (SELECT COUNT(*) FROM bank_transactions bt
             WHERE bt.bank_account_id = ba.id AND bt.status = 'unmatched') AS unmatched
      FROM bank_accounts ba
     WHERE ba.org_id = ${orgId} AND ba.is_active = 1
     ORDER BY ba.is_primary DESC, ba.name
  `.execute(ex);

  return rows.map((r) => ({
    id: String(r.id),
    name: r.name,
    kind: r.kind,
    balancePaise: toPaiseFromSql(r.movement),
    unmatched: Number(r.unmatched),
  }));
}

/** Invoices still awaiting an IRN. A B2B invoice is not valid without one. */
export async function einvoicePending(ex: Executor, orgId: number): Promise<number> {
  const { rows } = await sql<{ n: string }>`
    SELECT COUNT(*) AS n FROM einvoices
     WHERE org_id = ${orgId} AND status IN ('pending', 'failed')
  `.execute(ex);
  return Number(rows[0]?.n ?? 0);
}

export interface WorkingCapitalDays {
  windowDays: number;
  /** Days of sales still owed by customers. */
  receivableDays: number | null;
  /** Days of purchases still owed to suppliers. */
  payableDays: number | null;
  /** Days of cost of sales held as stock. Null where stock is not costed through the ledger. */
  inventoryDays: number | null;
  /** Receivable + inventory − payable: how long money is tied up in the trade cycle. */
  cashCycleDays: number | null;
  /** The same measures one window earlier, for the trend. */
  previous: { receivableDays: number | null; payableDays: number | null; inventoryDays: number | null };
}

const isoDaysBefore = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

/**
 * Receivable, payable and inventory days at a date, each measured against the
 * window before it: what is owed or held, divided by what flowed through in the
 * window, times its length. Balances come from the control accounts, so these
 * agree with the ageing reports; flows are documents with their GST, because
 * the balances include it.
 */
export async function workingCapitalDays(ex: Executor, orgId: number, asOf: string, windowDays = 90): Promise<WorkingCapitalDays> {
  const at = async (to: string) => {
    const from = isoDaysBefore(to, windowDays - 1);
    const { rows } = await sql<{ ar: string; ap: string; stock: string; sales: string; purchases: string; cogs: string }>`
      SELECT
        COALESCE((SELECT SUM(jl.debit - jl.credit) FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
                   WHERE jl.org_id = ${orgId} AND a.code = '1100' AND jl.entry_date <= ${to}), 0) AS ar,
        COALESCE((SELECT SUM(jl.credit - jl.debit) FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
                   WHERE jl.org_id = ${orgId} AND a.code = '2100' AND jl.entry_date <= ${to}), 0) AS ap,
        COALESCE((SELECT SUM(jl.debit - jl.credit) FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
                   WHERE jl.org_id = ${orgId} AND a.code = '1500' AND jl.entry_date <= ${to}), 0) AS stock,
        COALESCE((SELECT SUM(total) FROM invoices
                   WHERE org_id = ${orgId} AND status NOT IN ('draft', 'void') AND invoice_date BETWEEN ${from} AND ${to}), 0) AS sales,
        COALESCE((SELECT SUM(total) FROM bills
                   WHERE org_id = ${orgId} AND status NOT IN ('draft', 'void') AND bill_date BETWEEN ${from} AND ${to}), 0) AS purchases,
        COALESCE((SELECT SUM(jl.debit - jl.credit) FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
                   WHERE jl.org_id = ${orgId} AND a.code = '5100' AND jl.entry_date BETWEEN ${from} AND ${to}), 0) AS cogs
    `.execute(ex);
    const r = rows[0];
    const days = (balance: string, flow: string) => {
      const b = toPaiseFromSql(balance);
      const f = toPaiseFromSql(flow);
      return f > 0 && b >= 0 ? Math.round((b / f) * windowDays) : null;
    };
    return {
      receivableDays: days(r?.ar ?? '0', r?.sales ?? '0'),
      payableDays: days(r?.ap ?? '0', r?.purchases ?? '0'),
      inventoryDays: days(r?.stock ?? '0', r?.cogs ?? '0'),
    };
  };
  const [now, before] = await Promise.all([at(asOf), at(isoDaysBefore(asOf, windowDays))]);
  const cycle = now.receivableDays !== null && now.payableDays !== null
    ? now.receivableDays + (now.inventoryDays ?? 0) - now.payableDays
    : null;
  return { windowDays, ...now, cashCycleDays: cycle, previous: before };
}
