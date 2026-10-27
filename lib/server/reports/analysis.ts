import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// The analytical reports — sales by customer, balances, ratios, cash flow.
//
// The statements in statements.ts answer "what do the books say". These answer
// "what does that tell us", and they are all aggregates over the same documents
// and journal, so no figure here can contradict one there.
//
// Drafts and voids are excluded everywhere. A draft was never issued and a void
// one was cancelled; counting either inflates whatever is being measured.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor } from '../db';
import type { Paise } from '../../types';
import { toPaiseFromSql } from '../money-sql';
import { balanceSheet, profitAndLoss, ageing } from './statements';

interface Window {
  from: string;
  to: string;
}

// ── Party balances ───────────────────────────────────────────────────────────

export interface PartyBalanceRow {
  contactId: string;
  name: string;
  gstin: string | null;
  isMsme: boolean;
  invoicedPaise: Paise;
  receivedPaise: Paise;
  outstandingPaise: Paise;
  documentCount: number;
}

/** Invoiced, received and outstanding per customer — or the vendor mirror. */
export async function partyBalances(
  ex: Executor,
  orgId: number,
  side: 'customer' | 'vendor',
  w: Window,
): Promise<PartyBalanceRow[]> {
  const { rows } = side === 'customer'
    ? await sql<{ id: number; name: string; gstin: string | null; is_msme: number; billed: string; paid: string; n: string }>`
        SELECT c.id, c.display_name AS name, c.gstin, c.is_msme,
               COALESCE(SUM(i.total), 0) AS billed,
               COALESCE(SUM(i.amount_paid), 0) AS paid,
               COUNT(*) AS n
          FROM invoices i JOIN contacts c ON c.id = i.customer_id
         WHERE i.org_id = ${orgId} AND i.status NOT IN ('draft', 'void')
           AND i.invoice_date BETWEEN ${w.from} AND ${w.to}
         GROUP BY c.id, c.display_name, c.gstin, c.is_msme
         ORDER BY billed DESC
      `.execute(ex)
    : await sql<{ id: number; name: string; gstin: string | null; is_msme: number; billed: string; paid: string; n: string }>`
        SELECT c.id, c.display_name AS name, c.gstin, c.is_msme,
               COALESCE(SUM(b.total), 0) AS billed,
               COALESCE(SUM(b.amount_paid), 0) AS paid,
               COUNT(*) AS n
          FROM bills b JOIN contacts c ON c.id = b.vendor_id
         WHERE b.org_id = ${orgId} AND b.status NOT IN ('draft', 'void')
           AND b.bill_date BETWEEN ${w.from} AND ${w.to}
         GROUP BY c.id, c.display_name, c.gstin, c.is_msme
         ORDER BY billed DESC
      `.execute(ex);

  return rows.map((r) => ({
    contactId: String(r.id),
    name: r.name,
    gstin: r.gstin,
    isMsme: Boolean(r.is_msme),
    invoicedPaise: toPaiseFromSql(r.billed),
    receivedPaise: toPaiseFromSql(r.paid),
    outstandingPaise: toPaiseFromSql(r.billed) - toPaiseFromSql(r.paid),
    documentCount: Number(r.n),
  }));
}

// ── Sales analysis ───────────────────────────────────────────────────────────

export interface SalesByRow {
  key: string;
  name: string;
  detail: string | null;
  taxablePaise: Paise;
  taxPaise: Paise;
  totalPaise: Paise;
  qty: number;
  count: number;
}

/** Revenue grouped by customer, item, or the salesperson who booked it. */
export async function salesBy(
  ex: Executor,
  orgId: number,
  by: 'customer' | 'item' | 'salesperson',
  w: Window,
): Promise<SalesByRow[]> {
  if (by === 'item') {
    const { rows } = await sql<{
      id: number | null; name: string; sku: string | null; taxable: string;
      tax: string; qty: string; n: string;
    }>`
      SELECT id, name, sku,
             COALESCE(SUM(taxable), 0) AS taxable,
             COALESCE(SUM(tax), 0) AS tax,
             COALESCE(SUM(qty), 0) AS qty,
             COUNT(*) AS n
        FROM (
          SELECT it.id AS id,
                 COALESCE(it.name, l.description, 'Unnamed line') AS name,
                 it.sku AS sku,
                 l.taxable AS taxable,
                 (l.cgst + l.sgst + l.igst + l.cess) AS tax,
                 l.qty AS qty
            FROM invoice_lines l
            JOIN invoices i ON i.id = l.invoice_id
            LEFT JOIN items it ON it.id = l.item_id
           WHERE i.org_id = ${orgId} AND i.status NOT IN ('draft', 'void')
             AND i.invoice_date BETWEEN ${w.from} AND ${w.to}
        ) x
       GROUP BY id, name, sku
       ORDER BY taxable DESC
    `.execute(ex);

    return rows.map((r) => ({
      key: r.id ? String(r.id) : `adhoc:${r.name}`,
      name: r.name,
      detail: r.sku,
      taxablePaise: toPaiseFromSql(r.taxable),
      taxPaise: toPaiseFromSql(r.tax),
      totalPaise: toPaiseFromSql(r.taxable) + toPaiseFromSql(r.tax),
      qty: Number(r.qty),
      count: Number(r.n),
    }));
  }

  const { rows } = by === 'customer'
    ? await sql<{ id: number; name: string; detail: string | null; taxable: string; tax: string; n: string }>`
        SELECT c.id, c.display_name AS name, c.gstin AS detail,
               COALESCE(SUM(i.subtotal), 0) AS taxable,
               COALESCE(SUM(i.cgst + i.sgst + i.igst + i.cess), 0) AS tax,
               COUNT(*) AS n
          FROM invoices i JOIN contacts c ON c.id = i.customer_id
         WHERE i.org_id = ${orgId} AND i.status NOT IN ('draft', 'void')
           AND i.invoice_date BETWEEN ${w.from} AND ${w.to}
         GROUP BY c.id, c.display_name, c.gstin ORDER BY taxable DESC
      `.execute(ex)
    : await sql<{ id: number; name: string; detail: string | null; taxable: string; tax: string; n: string }>`
        SELECT u.id, u.name, u.email AS detail,
               COALESCE(SUM(i.subtotal), 0) AS taxable,
               COALESCE(SUM(i.cgst + i.sgst + i.igst + i.cess), 0) AS tax,
               COUNT(*) AS n
          FROM invoices i JOIN users u ON u.id = i.salesperson_id
         WHERE i.org_id = ${orgId} AND i.status NOT IN ('draft', 'void')
           AND i.invoice_date BETWEEN ${w.from} AND ${w.to}
         GROUP BY u.id, u.name, u.email ORDER BY taxable DESC
      `.execute(ex);

  return rows.map((r) => ({
    key: String(r.id),
    name: r.name,
    detail: r.detail,
    taxablePaise: toPaiseFromSql(r.taxable),
    taxPaise: toPaiseFromSql(r.tax),
    totalPaise: toPaiseFromSql(r.taxable) + toPaiseFromSql(r.tax),
    qty: 0,
    count: Number(r.n),
  }));
}

/** Spending grouped by supplier. */
export async function purchasesByVendor(
  ex: Executor,
  orgId: number,
  w: Window,
): Promise<SalesByRow[]> {
  const { rows } = await sql<{
    id: number; name: string; gstin: string | null; taxable: string; tax: string; n: string;
  }>`
    SELECT c.id, c.display_name AS name, c.gstin,
           COALESCE(SUM(b.subtotal), 0) AS taxable,
           COALESCE(SUM(b.cgst + b.sgst + b.igst + b.cess), 0) AS tax,
           COUNT(*) AS n
      FROM bills b JOIN contacts c ON c.id = b.vendor_id
     WHERE b.org_id = ${orgId} AND b.status NOT IN ('draft', 'void')
       AND b.bill_date BETWEEN ${w.from} AND ${w.to}
     GROUP BY c.id, c.display_name, c.gstin ORDER BY taxable DESC
  `.execute(ex);

  return rows.map((r) => ({
    key: String(r.id),
    name: r.name,
    detail: r.gstin,
    taxablePaise: toPaiseFromSql(r.taxable),
    taxPaise: toPaiseFromSql(r.tax),
    totalPaise: toPaiseFromSql(r.taxable) + toPaiseFromSql(r.tax),
    qty: 0,
    count: Number(r.n),
  }));
}

/**
 * Spend by expense account, from the journal rather than the expense table.
 *
 * Reading the journal catches everything that hit an expense account — bills,
 * standalone expenses and categorised bank lines alike. Reading the expenses
 * table alone would show only the third of them entered that way.
 */
export async function expensesByCategory(
  ex: Executor,
  orgId: number,
  w: Window,
): Promise<{ accountId: string; code: string; name: string; amountPaise: Paise; count: number }[]> {
  const { rows } = await sql<{ id: number; code: string; name: string; amount: string; n: string }>`
    SELECT a.id, a.code, a.name,
           COALESCE(SUM(jl.debit - jl.credit), 0) AS amount,
           COUNT(*) AS n
      FROM journal_lines jl
      JOIN accounts a ON a.id = jl.account_id
     WHERE jl.org_id = ${orgId} AND a.type = 'expense'
       AND jl.entry_date BETWEEN ${w.from} AND ${w.to}
     GROUP BY a.id, a.code, a.name
    HAVING amount <> 0
     ORDER BY amount DESC
  `.execute(ex);

  return rows.map((r) => ({
    accountId: String(r.id),
    code: r.code,
    name: r.name,
    amountPaise: toPaiseFromSql(r.amount),
    count: Number(r.n),
  }));
}

// ── Account views ────────────────────────────────────────────────────────────

/** The five account families at a glance. */
export async function accountTypeSummary(
  ex: Executor,
  orgId: number,
  asOf: string,
): Promise<{ type: string; accounts: number; totalAccounts: number; debitPaise: Paise; creditPaise: Paise; netPaise: Paise }[]> {
  // Two counts: how many accounts of this type exist, and how many have
  // actually been used. A chart of accounts ships with far more accounts than
  // any one business touches, so the second number is the informative one.
  const { rows } = await sql<{ type: string; n: string; used: string; dr: string; cr: string }>`
    SELECT a.type,
           COUNT(DISTINCT a.id) AS n,
           COUNT(DISTINCT CASE WHEN jl.id IS NOT NULL THEN a.id END) AS used,
           COALESCE(SUM(jl.debit), 0) AS dr,
           COALESCE(SUM(jl.credit), 0) AS cr
      FROM accounts a
      LEFT JOIN journal_lines jl ON jl.account_id = a.id AND jl.entry_date <= ${asOf}
     WHERE a.org_id = ${orgId}
     GROUP BY a.type
  `.execute(ex);

  const order = ['asset', 'liability', 'equity', 'income', 'expense'];
  return rows
    .map((r) => {
      const dr = toPaiseFromSql(r.dr);
      const cr = toPaiseFromSql(r.cr);
      // Assets and expenses grow with debits; everything else with credits.
      const debitNormal = r.type === 'asset' || r.type === 'expense';
      return {
        type: r.type,
        accounts: Number(r.used),
        totalAccounts: Number(r.n),
        debitPaise: dr,
        creditPaise: cr,
        netPaise: debitNormal ? dr - cr : cr - dr,
      };
    })
    .sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
}

// ── Cash flow ────────────────────────────────────────────────────────────────

export interface CashFlow {
  openingPaise: Paise;
  closingPaise: Paise;
  operatingPaise: Paise;
  investingPaise: Paise;
  financingPaise: Paise;
  rows: { label: string; group: string; amountPaise: Paise }[];
  from: string;
  to: string;
}

/**
 * Where cash actually came from and went.
 *
 * Built directly from movements on the cash and bank accounts, classified by
 * what the other side of each entry was. That is the direct method, and it is
 * the honest one here: an indirect reconciliation from profit would need
 * working-capital adjustments this build does not track.
 */
export async function cashFlow(ex: Executor, orgId: number, w: Window): Promise<CashFlow> {
  const cashAccounts = await ex
    .selectFrom('bank_accounts')
    .select('ledger_account_id')
    .where('org_id', '=', orgId)
    .execute();
  const ids = cashAccounts.map((a) => a.ledger_account_id);
  if (!ids.length) {
    return {
      openingPaise: 0, closingPaise: 0, operatingPaise: 0, investingPaise: 0,
      financingPaise: 0, rows: [], from: w.from, to: w.to,
    };
  }

  const { rows: opening } = await sql<{ v: string }>`
    SELECT COALESCE(SUM(debit - credit), 0) AS v FROM journal_lines
     WHERE org_id = ${orgId} AND account_id IN (${sql.join(ids)}) AND entry_date < ${w.from}
  `.execute(ex);

  // For every entry that touched cash, what the money went to or came from.
  const { rows } = await sql<{ type: string; code: string; name: string; v: string }>`
    SELECT a.type, a.code, a.name, COALESCE(SUM(other.credit - other.debit), 0) AS v
      FROM journal_lines cashline
      JOIN journal_lines other ON other.entry_id = cashline.entry_id AND other.id <> cashline.id
      JOIN accounts a ON a.id = other.account_id
     WHERE cashline.org_id = ${orgId}
       AND cashline.account_id IN (${sql.join(ids)})
       AND cashline.entry_date BETWEEN ${w.from} AND ${w.to}
     GROUP BY a.type, a.code, a.name
    HAVING v <> 0
     ORDER BY a.type, a.code
  `.execute(ex);

  // Fixed assets are investing; owners' capital is financing; the rest is the
  // trading the business actually does.
  const classify = (type: string, code: string) =>
    type === 'equity' ? 'Financing'
    : code.startsWith('16') ? 'Investing'
    : 'Operating';

  const classified = rows.map((r) => ({
    label: r.name,
    group: classify(r.type, r.code),
    amountPaise: toPaiseFromSql(r.v),
  }));

  const sum = (g: string) =>
    classified.filter((r) => r.group === g).reduce((t, r) => t + r.amountPaise, 0);

  const openingPaise = toPaiseFromSql(opening[0]?.v ?? '0');
  const operating = sum('Operating');
  const investing = sum('Investing');
  const financing = sum('Financing');

  return {
    openingPaise,
    operatingPaise: operating,
    investingPaise: investing,
    financingPaise: financing,
    closingPaise: openingPaise + operating + investing + financing,
    rows: classified,
    from: w.from,
    to: w.to,
  };
}

// ── Ratios and equity ────────────────────────────────────────────────────────

export interface Ratio {
  key: string;
  label: string;
  value: number;
  unit: 'pct' | 'ratio' | 'days';
  explain: string;
  good: boolean | null;
}

/** A handful of ratios, each with the plain-English reason it matters. */
export async function businessRatios(ex: Executor, orgId: number, w: Window): Promise<Ratio[]> {
  const [pl, bs, ar] = await Promise.all([
    profitAndLoss(ex, orgId, w.from, w.to),
    balanceSheet(ex, orgId, w.to),
    ageing(ex, orgId, 'receivable', w.to),
  ]);

  const currentAssets = bs.assetRows
    .filter((r) => !r.code.startsWith('16'))
    .reduce((t, r) => t + r.balancePaise, 0);
  const currentLiabilities = bs.totalLiabilities;

  // Days sales outstanding: how long, on average, money takes to arrive.
  const days = Math.max(
    1,
    Math.round((new Date(w.to).getTime() - new Date(w.from).getTime()) / 86_400_000) + 1,
  );
  const dso = pl.totalIncome > 0 ? (ar.grandTotalPaise / pl.totalIncome) * days : 0;

  const grossPct = pl.totalIncome > 0 ? (pl.grossProfit / pl.totalIncome) * 100 : 0;
  const netPct = pl.totalIncome > 0 ? (pl.netProfit / pl.totalIncome) * 100 : 0;
  const current = currentLiabilities > 0 ? currentAssets / currentLiabilities : 0;

  return [
    {
      key: 'gross_margin', label: 'Gross margin', value: grossPct, unit: 'pct',
      explain: 'What is left of each rupee of sales after the direct cost of what was sold.',
      good: grossPct >= 20,
    },
    {
      key: 'net_margin', label: 'Net margin', value: netPct, unit: 'pct',
      explain: 'What is left after everything, including rent and salaries.',
      good: netPct >= 5,
    },
    {
      key: 'current_ratio', label: 'Current ratio', value: current, unit: 'ratio',
      explain: 'Short-term assets against short-term debts. Below 1 means you cannot cover what falls due.',
      good: current >= 1.2,
    },
    {
      key: 'dso', label: 'Days sales outstanding', value: dso, unit: 'days',
      explain: 'How long money takes to arrive after a sale. Compare it against the terms you actually give.',
      good: dso <= 45,
    },
  ];
}

/** How the owners' stake changed over the period, and why. */
export async function movementOfEquity(
  ex: Executor,
  orgId: number,
  w: Window,
): Promise<{ opening: Paise; closing: Paise; rows: { label: string; amountPaise: Paise }[] }> {
  const [before, after, pl] = await Promise.all([
    balanceSheet(ex, orgId, w.from),
    balanceSheet(ex, orgId, w.to),
    profitAndLoss(ex, orgId, w.from, w.to),
  ]);

  const contributed = after.equityRows.reduce((t, r) => t + r.balancePaise, 0)
    - before.equityRows.reduce((t, r) => t + r.balancePaise, 0);

  return {
    opening: before.totalEquity,
    closing: after.totalEquity,
    rows: [
      { label: 'Opening equity', amountPaise: before.totalEquity },
      { label: 'Capital introduced or withdrawn', amountPaise: contributed },
      { label: pl.netProfit >= 0 ? 'Profit for the period' : 'Loss for the period', amountPaise: pl.netProfit },
      { label: 'Closing equity', amountPaise: after.totalEquity },
    ],
  };
}

// ── Collection speed ─────────────────────────────────────────────────────────

/**
 * How long invoices actually take to settle.
 *
 * Only fully settled invoices count — a partly paid one has no payment date
 * yet, and including it would drag the average down with a wait that has not
 * finished. Invoices cleared by a credit note are excluded for the same
 * reason: no money changed hands.
 */
export async function timeToGetPaid(
  ex: Executor,
  orgId: number,
  w: Window,
): Promise<{
  rows: { invoiceId: string; number: string; customer: string; date: string; dueDate: string; settledOn: string; days: number; vsTerms: number; totalPaise: Paise }[];
  averageDays: number;
  onTimePct: number;
}> {
  const { rows } = await sql<{
    id: number; number: string; customer: string; invoice_date: string;
    due_date: string; settled: string; total: string;
  }>`
    SELECT i.id, i.number, c.display_name AS customer, i.invoice_date, i.due_date,
           MAX(p.payment_date) AS settled, i.total
      FROM invoices i
      JOIN contacts c ON c.id = i.customer_id
      JOIN payment_allocations pa ON pa.target_type = 'invoice' AND pa.target_id = i.id
      JOIN payments p ON p.id = pa.payment_id AND p.status <> 'void'
     WHERE i.org_id = ${orgId} AND i.status NOT IN ('draft', 'void')
       AND i.amount_paid >= i.total
       AND i.invoice_date BETWEEN ${w.from} AND ${w.to}
     GROUP BY i.id, i.number, c.display_name, i.invoice_date, i.due_date, i.total
     ORDER BY settled DESC
  `.execute(ex);

  const day = (a: string, b: string) =>
    Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86_400_000);

  const out = rows.map((r) => {
    const settledOn = String(r.settled).slice(0, 10);
    return {
      invoiceId: String(r.id),
      number: r.number,
      customer: r.customer,
      date: r.invoice_date,
      dueDate: r.due_date,
      settledOn,
      days: Math.max(0, day(r.invoice_date, settledOn)),
      vsTerms: day(r.due_date, settledOn),
      totalPaise: toPaiseFromSql(r.total),
    };
  });

  const onTime = out.filter((r) => r.vsTerms <= 0).length;
  return {
    rows: out,
    averageDays: out.length ? out.reduce((t, r) => t + r.days, 0) / out.length : 0,
    onTimePct: out.length ? (onTime / out.length) * 100 : 0,
  };
}

// ── Refunds ──────────────────────────────────────────────────────────────────

export interface RefundRow {
  id: string;
  direction: 'out' | 'in';
  date: string;
  number: string;
  party: string;
  reason: string;
  againstNumber: string | null;
  amountPaise: Paise;
  bankName: string | null;
}

/**
 * Money actually returned, in both directions.
 *
 * Read from the journal rather than from the credit notes, because a credit
 * note is not a refund. A credit note reduces what a customer owes; a refund is
 * cash leaving the bank. Most credits are set against the next invoice and no
 * money ever moves. What lands here is only the entries where it did — which is
 * what an auditor asks for and what the bank statement will show.
 */
export async function refundHistory(
  ex: Executor,
  orgId: number,
  w: Window,
): Promise<RefundRow[]> {
  const { rows } = await sql<{
    id: number; source_type: string; entry_date: string; memo: string | null;
    amount: string; party: string | null; number: string | null;
    reason: string | null; bank_name: string | null;
  }>`
    SELECT je.id, je.source_type, je.entry_date, je.memo,
           COALESCE(SUM(jl.credit), 0) AS amount,
           c.display_name AS party,
           cn.number AS number,
           cn.reason AS reason,
           ba.name AS bank_name
      FROM journal_entries je
      JOIN journal_lines jl ON jl.entry_id = je.id
      JOIN accounts a ON a.id = jl.account_id
      LEFT JOIN bank_accounts ba ON ba.ledger_account_id = a.id
      LEFT JOIN credit_notes cn
             ON cn.id = je.source_id AND je.source_type = 'credit_note_refund'
      LEFT JOIN contacts c ON c.id = cn.customer_id
     WHERE je.org_id = ${orgId}
       AND je.source_type IN ('credit_note_refund', 'vendor_credit_refund')
       AND je.entry_date BETWEEN ${w.from} AND ${w.to}
       AND ba.id IS NOT NULL
     GROUP BY je.id, je.source_type, je.entry_date, je.memo,
              c.display_name, cn.number, cn.reason, ba.name
     ORDER BY je.entry_date DESC, je.id DESC
  `.execute(ex);

  return rows.map((r) => ({
    id: String(r.id),
    // A customer refund is cash out; a supplier returning money is cash in.
    direction: r.source_type === 'credit_note_refund' ? 'out' : 'in',
    date: String(r.entry_date).slice(0, 10),
    number: r.number ?? `JE #${r.id}`,
    party: r.party ?? '—',
    reason: r.reason ?? r.memo ?? '—',
    againstNumber: null,
    amountPaise: toPaiseFromSql(r.amount),
    bankName: r.bank_name,
  }));
}
