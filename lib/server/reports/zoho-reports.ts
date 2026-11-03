import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// The rest of Zoho Books' report list, from the same books as every other
// report: purchases by item, purchase order and vendor credit details,
// expenses by customer and by project, billable expenses, timesheets and
// project summaries, the receivable and payable registers, inventory
// valuation, committed stock and ABC classification, sales summary by month,
// bank reconciliation status, realised and unrealised exchange gain or loss,
// and the system mails sent.
//
// Each is a query over documents already posted; nothing here writes, and
// nothing is cached, so no two reports can disagree.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor } from '../db';
import { toPaiseFromSql } from '../money-sql';
import { CODE, accountIds } from '../ledger/chart-of-accounts';
import { exposure } from '../services/fx';
import { stockPosition } from './stock';

export interface Window { from: string; to: string }

const day = (v: unknown) => (v instanceof Date ? new Date(v.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10) : String(v).slice(0, 10));
const p = toPaiseFromSql;

// ── Purchases ────────────────────────────────────────────────────────────────

/** Bill lines by item: what was bought, how much of it, at what average price. */
export async function purchasesByItem(ex: Executor, orgId: number, w: Window) {
  const { rows } = await sql<{ item_id: number | null; name: string; uqc: string | null; qty: string; amount: string; bills: string }>`
    SELECT l.item_id, COALESCE(i.name, l.description) AS name, COALESCE(i.uqc, l.uqc) AS uqc,
           SUM(l.qty) AS qty, SUM(l.taxable) AS amount, COUNT(DISTINCT b.id) AS bills
      FROM bill_lines l JOIN bills b ON b.id = l.bill_id LEFT JOIN items i ON i.id = l.item_id
     WHERE b.org_id = ${orgId} AND b.status NOT IN ('draft', 'void') AND b.bill_date BETWEEN ${w.from} AND ${w.to}
     GROUP BY l.item_id, COALESCE(i.name, l.description), COALESCE(i.uqc, l.uqc)
     ORDER BY amount DESC`.execute(ex);
  return rows.map((r) => {
    const qty = Number(r.qty);
    const amount = p(r.amount);
    return { itemId: r.item_id ? String(r.item_id) : null, name: r.name, uqc: r.uqc, qty, amountPaise: amount, averagePaise: qty ? Math.round(amount / qty) : 0, bills: Number(r.bills) };
  });
}

/** Every purchase order in the period, with how much of it is billed and received. */
export async function purchaseOrderDetails(ex: Executor, orgId: number, w: Window) {
  const { rows } = await sql<{ id: number; number: string; order_date: string; expected_date: string | null; status: string; vendor: string; vendor_id: number; total: string; billed_amount: string; ordered: string; received: string; billed: string; vendor_response: string | null }>`
    SELECT o.id, o.number, o.order_date, o.expected_date, o.status, c.display_name AS vendor, o.vendor_id, o.total, o.billed_amount, o.vendor_response,
           COALESCE(SUM(l.qty), 0) AS ordered, COALESCE(SUM(l.qty_received), 0) AS received, COALESCE(SUM(l.qty_billed), 0) AS billed
      FROM purchase_orders o JOIN contacts c ON c.id = o.vendor_id LEFT JOIN purchase_order_lines l ON l.purchase_order_id = o.id
     WHERE o.org_id = ${orgId} AND o.order_date BETWEEN ${w.from} AND ${w.to}
     GROUP BY o.id ORDER BY o.order_date DESC, o.id DESC`.execute(ex);
  return rows.map((r) => ({
    id: String(r.id), number: r.number, date: day(r.order_date), expected: r.expected_date ? day(r.expected_date) : null, status: r.status,
    vendorId: String(r.vendor_id), vendor: r.vendor, totalPaise: p(r.total), billedPaise: p(r.billed_amount),
    orderedQty: Number(r.ordered), receivedQty: Number(r.received), billedQty: Number(r.billed), vendorResponse: r.vendor_response,
  }));
}

/** Every vendor credit in the period, with what is still unused. */
export async function vendorCreditDetails(ex: Executor, orgId: number, w: Window) {
  const { rows } = await sql<{ id: number; number: string; credit_date: string; status: string; reason: string | null; vendor: string; vendor_id: number; total: string; applied_amount: string; against: string | null }>`
    SELECT v.id, v.number, v.credit_date, v.status, v.reason, c.display_name AS vendor, v.vendor_id, v.total, v.applied_amount, b.internal_no AS against
      FROM vendor_credits v JOIN contacts c ON c.id = v.vendor_id LEFT JOIN bills b ON b.id = v.against_bill_id
     WHERE v.org_id = ${orgId} AND v.credit_date BETWEEN ${w.from} AND ${w.to}
     ORDER BY v.credit_date DESC, v.id DESC`.execute(ex);
  return rows.map((r) => ({
    id: String(r.id), number: r.number, date: day(r.credit_date), status: r.status, reason: r.reason, vendorId: String(r.vendor_id), vendor: r.vendor,
    againstBill: r.against, totalPaise: p(r.total), appliedPaise: p(r.applied_amount), balancePaise: r.status === 'void' ? 0 : p(r.total) - p(r.applied_amount),
  }));
}

// ── Expenses ─────────────────────────────────────────────────────────────────

/** Expenses grouped by the customer they were for, or by project. */
export async function expensesBy(ex: Executor, orgId: number, by: 'customer' | 'project', w: Window) {
  const key = by === 'customer' ? sql.ref('e.billable_customer_id') : sql.ref('e.project_id');
  const name = by === 'customer' ? sql`c.display_name` : sql`pr.name`;
  const join = by === 'customer' ? sql`LEFT JOIN contacts c ON c.id = e.billable_customer_id` : sql`LEFT JOIN projects pr ON pr.id = e.project_id`;
  const { rows } = await sql<{ id: number | null; name: string | null; n: string; amount: string; tax: string; billable: string; billed: string }>`
    SELECT ${key} AS id, ${name} AS name, COUNT(*) AS n, SUM(e.amount) AS amount, SUM(e.cgst + e.sgst + e.igst) AS tax,
           SUM(CASE WHEN e.is_billable = 1 THEN e.total ELSE 0 END) AS billable,
           SUM(CASE WHEN e.billed_invoice_id IS NOT NULL THEN e.total ELSE 0 END) AS billed
      FROM expenses e ${join}
     WHERE e.org_id = ${orgId} AND e.status <> 'void' AND e.expense_date BETWEEN ${w.from} AND ${w.to}
     GROUP BY ${key}, ${name} ORDER BY amount DESC`.execute(ex);
  return rows.map((r) => ({
    id: r.id ? String(r.id) : null, name: r.name ?? (by === 'customer' ? 'No customer' : 'No project'), count: Number(r.n),
    amountPaise: p(r.amount), taxPaise: p(r.tax), billablePaise: p(r.billable), billedPaise: p(r.billed),
  }));
}

/** Expenses marked to be charged on to a customer: billed already, or still to bill. */
export async function billableExpenseDetails(ex: Executor, orgId: number, w: Window) {
  const { rows } = await sql<{ id: number; number: string | null; expense_date: string; account: string; customer: string | null; customer_id: number | null; project: string | null; total: string; invoice: string | null; invoice_id: number | null; notes: string | null }>`
    SELECT e.id, e.number, e.expense_date, a.name AS account, c.display_name AS customer, e.billable_customer_id AS customer_id, pr.name AS project,
           e.total, i.number AS invoice, e.billed_invoice_id AS invoice_id, e.notes
      FROM expenses e JOIN accounts a ON a.id = e.account_id
      LEFT JOIN contacts c ON c.id = e.billable_customer_id LEFT JOIN projects pr ON pr.id = e.project_id LEFT JOIN invoices i ON i.id = e.billed_invoice_id
     WHERE e.org_id = ${orgId} AND e.is_billable = 1 AND e.status <> 'void' AND e.expense_date BETWEEN ${w.from} AND ${w.to}
     ORDER BY e.expense_date DESC, e.id DESC`.execute(ex);
  return rows.map((r) => ({
    id: String(r.id), number: r.number, date: day(r.expense_date), account: r.account, customer: r.customer, customerId: r.customer_id ? String(r.customer_id) : null,
    project: r.project, totalPaise: p(r.total), invoice: r.invoice, invoiceId: r.invoice_id ? String(r.invoice_id) : null, notes: r.notes,
  }));
}

// ── Projects and timesheets ──────────────────────────────────────────────────

export async function timesheetDetails(ex: Executor, orgId: number, w: Window) {
  const { rows } = await sql<{ id: number; entry_date: string; minutes: number; billable: number; notes: string | null; project: string; project_id: number; customer: string | null; task: string | null; user: string | null; invoice: string | null }>`
    SELECT t.id, t.entry_date, t.minutes, t.billable, t.notes, pr.name AS project, pr.id AS project_id, c.display_name AS customer,
           tk.name AS task, u.name AS user, i.number AS invoice
      FROM time_entries t JOIN projects pr ON pr.id = t.project_id LEFT JOIN contacts c ON c.id = pr.customer_id
      LEFT JOIN project_tasks tk ON tk.id = t.task_id LEFT JOIN users u ON u.id = t.user_id LEFT JOIN invoices i ON i.id = t.invoice_id
     WHERE t.org_id = ${orgId} AND t.entry_date BETWEEN ${w.from} AND ${w.to}
     ORDER BY t.entry_date DESC, t.id DESC`.execute(ex);
  return rows.map((r) => ({
    id: String(r.id), date: day(r.entry_date), hours: Number(r.minutes) / 60, billable: !!r.billable, notes: r.notes,
    projectId: String(r.project_id), project: r.project, customer: r.customer, task: r.task, user: r.user, invoice: r.invoice,
  }));
}

/** Each project: hours logged and billed, what was invoiced and spent on it, and what is left. */
export async function projectSummary(ex: Executor, orgId: number, w: Window) {
  const { rows } = await sql<{ id: number; name: string; status: string; billing_method: string; customer: string | null; minutes: string; billable: string; billed: string; invoiced: string; expenses: string; budget: string | null }>`
    SELECT pr.id, pr.name, pr.status, pr.billing_method, c.display_name AS customer, pr.budget_amount AS budget,
           (SELECT COALESCE(SUM(t.minutes), 0) FROM time_entries t WHERE t.project_id = pr.id AND t.entry_date BETWEEN ${w.from} AND ${w.to}) AS minutes,
           (SELECT COALESCE(SUM(t.minutes), 0) FROM time_entries t WHERE t.project_id = pr.id AND t.billable = 1 AND t.entry_date BETWEEN ${w.from} AND ${w.to}) AS billable,
           (SELECT COALESCE(SUM(t.minutes), 0) FROM time_entries t WHERE t.project_id = pr.id AND t.invoice_id IS NOT NULL AND t.entry_date BETWEEN ${w.from} AND ${w.to}) AS billed,
           (SELECT COALESCE(SUM(i.subtotal), 0) FROM invoices i WHERE i.project_id = pr.id AND i.status NOT IN ('draft', 'void') AND i.invoice_date BETWEEN ${w.from} AND ${w.to}) AS invoiced,
           (SELECT COALESCE(SUM(e.amount), 0) FROM expenses e WHERE e.project_id = pr.id AND e.status <> 'void' AND e.expense_date BETWEEN ${w.from} AND ${w.to}) AS expenses
      FROM projects pr LEFT JOIN contacts c ON c.id = pr.customer_id
     WHERE pr.org_id = ${orgId}
     ORDER BY pr.name`.execute(ex);
  return rows.map((r) => {
    const invoiced = p(r.invoiced);
    const spent = p(r.expenses);
    return {
      id: String(r.id), name: r.name, status: r.status, billingMethod: r.billing_method, customer: r.customer,
      hours: Number(r.minutes) / 60, billableHours: Number(r.billable) / 60, billedHours: Number(r.billed) / 60,
      invoicedPaise: invoiced, expensesPaise: spent, marginPaise: invoiced - spent, budgetPaise: r.budget === null ? null : p(r.budget),
    };
  });
}

// ── Receivables and payables, document by document ──────────────────────────

/**
 * Zoho's Receivable/Payable Summary and Details: every document that makes or
 * reduces what a party owes — invoices and debit notes, credit notes,
 * retainers; or bills and vendor credits — with its status and balance.
 */
export async function partyRegister(ex: Executor, orgId: number, side: 'customer' | 'vendor', w: Window) {
  const q = side === 'customer'
    ? sql<{ kind: string; id: number; number: string; dt: string; due: string | null; party: string; party_id: number; status: string; total: string; balance: string }>`
        SELECT IF(i.doc_kind = 'debit_note', 'Debit note', 'Invoice') AS kind, i.id, i.number, i.invoice_date AS dt, i.due_date AS due, c.display_name AS party, i.customer_id AS party_id,
               i.status, i.total, i.total - i.amount_paid AS balance
          FROM invoices i JOIN contacts c ON c.id = i.customer_id
         WHERE i.org_id = ${orgId} AND i.status NOT IN ('draft', 'void') AND i.invoice_date BETWEEN ${w.from} AND ${w.to}
        UNION ALL
        SELECT 'Credit note', n.id, n.number, n.note_date, NULL, c.display_name, n.customer_id, n.status, -n.total, -(n.total - n.applied_amount)
          FROM credit_notes n JOIN contacts c ON c.id = n.customer_id
         WHERE n.org_id = ${orgId} AND n.status <> 'void' AND n.note_date BETWEEN ${w.from} AND ${w.to}
        UNION ALL
        SELECT 'Service invoice', r.id, r.number, r.retainer_date, NULL, c.display_name, r.customer_id, r.status, r.amount, r.amount - r.amount_paid
          FROM retainer_invoices r JOIN contacts c ON c.id = r.customer_id
         WHERE r.org_id = ${orgId} AND r.status NOT IN ('draft', 'void') AND r.retainer_date BETWEEN ${w.from} AND ${w.to}
         ORDER BY dt DESC, number DESC`
    : sql<{ kind: string; id: number; number: string; dt: string; due: string | null; party: string; party_id: number; status: string; total: string; balance: string }>`
        SELECT 'Bill' AS kind, b.id, b.internal_no AS number, b.bill_date AS dt, b.due_date AS due, c.display_name AS party, b.vendor_id AS party_id,
               b.status, b.total, b.total - b.amount_paid AS balance
          FROM bills b JOIN contacts c ON c.id = b.vendor_id
         WHERE b.org_id = ${orgId} AND b.status NOT IN ('draft', 'void') AND b.bill_date BETWEEN ${w.from} AND ${w.to}
        UNION ALL
        SELECT 'Vendor credit', v.id, v.number, v.credit_date, NULL, c.display_name, v.vendor_id, v.status, -v.total, -(v.total - v.applied_amount)
          FROM vendor_credits v JOIN contacts c ON c.id = v.vendor_id
         WHERE v.org_id = ${orgId} AND v.status <> 'void' AND v.credit_date BETWEEN ${w.from} AND ${w.to}
         ORDER BY dt DESC, number DESC`;
  const { rows } = await q.execute(ex);
  return rows.map((r) => ({
    kind: r.kind, id: String(r.id), number: r.number, date: day(r.dt), dueDate: r.due ? day(r.due) : null,
    partyId: String(r.party_id), party: r.party, status: r.status, totalPaise: p(r.total), balancePaise: p(r.balance),
  }));
}

// ── Inventory ────────────────────────────────────────────────────────────────

/** Each tracked item's quantity and value at the date: Zoho's Inventory Valuation Summary. */
export async function inventoryValuation(ex: Executor, orgId: number, asOf: string) {
  const pos = await stockPosition(ex, orgId, asOf);
  return {
    totalValuePaise: pos.totalValuePaise,
    rows: pos.lines.filter((l) => l.qty !== 0 || l.valuePaise !== 0).map((l) => ({
      itemId: l.itemId, name: l.name, sku: l.sku, uqc: l.uqc, qty: l.qty, unitCostPaise: l.unitCostPaise, valuePaise: l.valuePaise, valuation: l.valuation,
    })).sort((a, b) => b.valuePaise - a.valuePaise),
  };
}

/** Stock promised on open sales orders and not yet invoiced, against what is on hand. */
export async function committedStock(ex: Executor, orgId: number, asOf: string) {
  const { rows } = await sql<{ item_id: number; name: string; uqc: string | null; committed: string; orders: string }>`
    SELECT l.item_id, i.name, i.uqc, SUM(l.qty - GREATEST(l.qty_invoiced, l.qty_delivered)) AS committed, COUNT(DISTINCT o.id) AS orders
      FROM sales_order_lines l JOIN sales_orders o ON o.id = l.sales_order_id JOIN items i ON i.id = l.item_id
     WHERE o.org_id = ${orgId} AND o.status NOT IN ('cancelled', 'closed', 'invoiced', 'draft') AND o.order_date <= ${asOf}
       AND l.qty > GREATEST(l.qty_invoiced, l.qty_delivered) AND i.track_inventory = 1
     GROUP BY l.item_id, i.name, i.uqc ORDER BY i.name`.execute(ex);
  if (!rows.length) return [];
  const onHand = new Map((await stockPosition(ex, orgId, asOf)).lines.map((l) => [l.itemId, l.qty]));
  return rows.map((r) => {
    const committed = Number(r.committed);
    const qty = onHand.get(String(r.item_id)) ?? 0;
    return { itemId: String(r.item_id), name: r.name, uqc: r.uqc, onHandQty: qty, committedQty: committed, availableQty: qty - committed, orders: Number(r.orders) };
  });
}

/**
 * ABC classification: items ranked by sales in the period. The few that make
 * the first 70% of sales are A, the next 20% B, the long tail C — where to
 * spend counting and reordering care.
 */
export async function abcClassification(ex: Executor, orgId: number, w: Window) {
  const { rows } = await sql<{ item_id: number; name: string; qty: string; amount: string }>`
    SELECT l.item_id, i.name, SUM(l.qty) AS qty, SUM(l.taxable) AS amount
      FROM invoice_lines l JOIN invoices v ON v.id = l.invoice_id JOIN items i ON i.id = l.item_id
     WHERE v.org_id = ${orgId} AND v.status NOT IN ('draft', 'void') AND v.invoice_date BETWEEN ${w.from} AND ${w.to}
     GROUP BY l.item_id, i.name HAVING SUM(l.taxable) > 0 ORDER BY amount DESC`.execute(ex);
  const total = rows.reduce((s, r) => s + p(r.amount), 0);
  let running = 0;
  return rows.map((r) => {
    const amount = p(r.amount);
    const before = running;
    running += amount;
    const startShare = total ? before / total : 0;
    return {
      itemId: String(r.item_id), name: r.name, qty: Number(r.qty), amountPaise: amount,
      sharePct: total ? (amount / total) * 100 : 0, cumulativePct: total ? (running / total) * 100 : 0,
      // Classed by where the item starts in the running share, so the item that crosses 70% is still A.
      klass: (startShare < 0.7 ? 'A' : startShare < 0.9 ? 'B' : 'C') as 'A' | 'B' | 'C',
    };
  });
}

// ── Sales summary ────────────────────────────────────────────────────────────

/** Sales month by month: invoices, credit notes, the net, and the tax on it. */
export async function salesSummary(ex: Executor, orgId: number, w: Window) {
  const { rows } = await sql<{ m: string; invoices: string; taxable: string; tax: string; total: string; credits: string; credit_taxable: string }>`
    SELECT m, SUM(invoices) AS invoices, SUM(taxable) AS taxable, SUM(tax) AS tax, SUM(total) AS total, SUM(credits) AS credits, SUM(credit_taxable) AS credit_taxable FROM (
      SELECT DATE_FORMAT(i.invoice_date, '%Y-%m') AS m, COUNT(*) AS invoices, SUM(i.subtotal) AS taxable,
             SUM(i.cgst + i.sgst + i.igst + i.cess) AS tax, SUM(i.total) AS total, 0 AS credits, 0 AS credit_taxable
        FROM invoices i WHERE i.org_id = ${orgId} AND i.status NOT IN ('draft', 'void') AND i.invoice_date BETWEEN ${w.from} AND ${w.to}
       GROUP BY m
      UNION ALL
      SELECT DATE_FORMAT(n.note_date, '%Y-%m'), 0, 0, 0, 0, COUNT(*), SUM(n.subtotal)
        FROM credit_notes n WHERE n.org_id = ${orgId} AND n.status <> 'void' AND n.note_date BETWEEN ${w.from} AND ${w.to}
       GROUP BY 1
    ) x GROUP BY m ORDER BY m`.execute(ex);
  return rows.map((r) => ({
    month: r.m, invoices: Number(r.invoices), taxablePaise: p(r.taxable), taxPaise: p(r.tax), totalPaise: p(r.total),
    creditNotes: Number(r.credits), creditTaxablePaise: p(r.credit_taxable), netSalesPaise: p(r.taxable) - p(r.credit_taxable),
  }));
}

// ── Banking ──────────────────────────────────────────────────────────────────

/** Each bank account: statement lines matched and not, and the book balance beside the statement's. */
export async function reconciliationStatus(ex: Executor, orgId: number, asOf: string) {
  const { rows } = await sql<{ id: number; name: string; kind: string; ledger_account_id: number; line_count: string; matched: string; unmatched: string; unmatched_in: string; unmatched_out: string; last_line: string | null; statement_balance: string | null; last_reconciled: string | null }>`
    SELECT b.id, b.name, b.kind, b.ledger_account_id,
           COUNT(t.id) AS line_count,
           SUM(CASE WHEN t.status IN ('matched', 'manually_added') THEN 1 ELSE 0 END) AS matched,
           SUM(CASE WHEN t.status = 'unmatched' THEN 1 ELSE 0 END) AS unmatched,
           SUM(CASE WHEN t.status = 'unmatched' THEN t.deposit ELSE 0 END) AS unmatched_in,
           SUM(CASE WHEN t.status = 'unmatched' THEN t.withdrawal ELSE 0 END) AS unmatched_out,
           MAX(t.txn_date) AS last_line,
           (SELECT t2.running_balance FROM bank_transactions t2 WHERE t2.bank_account_id = b.id AND t2.txn_date <= ${asOf} AND t2.running_balance IS NOT NULL ORDER BY t2.txn_date DESC, t2.id DESC LIMIT 1) AS statement_balance,
           (SELECT MAX(t3.matched_at) FROM bank_transactions t3 WHERE t3.bank_account_id = b.id) AS last_reconciled
      FROM bank_accounts b LEFT JOIN bank_transactions t ON t.bank_account_id = b.id AND t.txn_date <= ${asOf}
     WHERE b.org_id = ${orgId} AND b.is_active = 1
     GROUP BY b.id ORDER BY b.name`.execute(ex);
  const out = [];
  for (const r of rows) {
    const { rows: bal } = await sql<{ dr: string | null; cr: string | null }>`
      SELECT SUM(l.debit) AS dr, SUM(l.credit) AS cr FROM journal_lines l
       WHERE l.org_id = ${orgId} AND l.account_id = ${r.ledger_account_id} AND l.entry_date <= ${asOf}`.execute(ex);
    // The opening balance is posted to the ledger like everything else, so the ledger alone is the book balance.
    const book = p(bal[0]?.dr ?? '0') - p(bal[0]?.cr ?? '0');
    const statement = r.statement_balance === null ? null : p(r.statement_balance);
    out.push({
      id: String(r.id), name: r.name, kind: r.kind, lines: Number(r.line_count), matched: Number(r.matched), unmatched: Number(r.unmatched),
      unmatchedInPaise: p(r.unmatched_in ?? '0'), unmatchedOutPaise: p(r.unmatched_out ?? '0'),
      lastLine: r.last_line ? day(r.last_line) : null, lastReconciledAt: r.last_reconciled ? new Date(r.last_reconciled).toISOString() : null,
      bookBalancePaise: book, statementBalancePaise: statement, differencePaise: statement === null ? null : statement - book,
    });
  }
  return out;
}

// ── Foreign exchange ─────────────────────────────────────────────────────────

/** Exchange gains and losses booked when foreign documents were settled. */
export async function realisedFx(ex: Executor, orgId: number, w: Window) {
  const acc = await accountIds(ex, orgId);
  const ids = [acc[CODE.FX_GAIN], acc[CODE.FX_LOSS]].filter((v): v is number => !!v);
  if (!ids.length) return [];
  const { rows } = await sql<{ entry_id: number; entry_date: string; source_type: string | null; memo: string | null; description: string | null; party: string | null; debit: string; credit: string }>`
    SELECT e.id AS entry_id, e.entry_date, e.source_type, e.memo, l.description, c.display_name AS party, l.debit, l.credit
      FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id LEFT JOIN contacts c ON c.id = l.contact_id
     WHERE e.org_id = ${orgId} AND l.account_id IN (${sql.join(ids)})
       AND COALESCE(e.source_type, '') <> 'fx_revaluation' AND e.entry_date BETWEEN ${w.from} AND ${w.to}
       AND e.id NOT IN (SELECT r.reversal_of_entry_id FROM journal_entries r WHERE r.org_id = ${orgId} AND r.reversal_of_entry_id IS NOT NULL)
     ORDER BY e.entry_date, e.id`.execute(ex);
  return rows.map((r) => ({
    entryId: String(r.entry_id), date: day(r.entry_date), source: r.source_type, memo: r.description || r.memo, party: r.party,
    gainPaise: p(r.credit) - p(r.debit),
  }));
}

/** What open foreign documents would gain or lose if restated at the date's closing rates. */
export async function unrealisedFx(ex: Executor, orgId: number, asOf: string) {
  return exposure(ex, orgId, asOf);
}

// ── Activity ─────────────────────────────────────────────────────────────────

/** Zoho's System Mails: every email the books sent, to whom, and whether it went. */
export async function systemMails(ex: Executor, orgId: number, w: Window) {
  const rows = await ex.selectFrom('email_log as m').leftJoin('users as u', 'u.id', 'm.sent_by_user_id')
    .select(['m.id', 'm.created_at', 'm.to_address', 'm.cc_address', 'm.subject', 'm.status', 'm.error', 'm.doc_type', 'm.doc_id', 'u.name as sent_by'])
    .where('m.org_id', '=', orgId)
    .where('m.created_at', '>=', new Date(`${w.from}T00:00:00+05:30`)).where('m.created_at', '<=', new Date(`${w.to}T23:59:59+05:30`))
    .orderBy('m.created_at', 'desc').orderBy('m.id', 'desc').limit(2000).execute();
  return rows.map((r) => ({
    id: String(r.id), at: new Date(r.created_at).toISOString(), to: r.to_address, cc: r.cc_address, subject: r.subject, status: r.status, error: r.error,
    docType: r.doc_type, docId: r.doc_id ? String(r.doc_id) : null, sentBy: r.sent_by,
  }));
}
