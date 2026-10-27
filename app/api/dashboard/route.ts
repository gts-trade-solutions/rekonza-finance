import { z } from 'zod';
import { db } from '@/lib/server/db';
import { route, query, asId } from '@/lib/server/http';
import { toPaiseFromSql } from '@/lib/server/money-sql';
import { profitAndLoss, trialBalance, ageing } from '@/lib/server/reports/statements';
import {
  billedVsCollected, cashPosition, einvoicePending, goodsVsServices, grossMargin,
  monthlySeries, msmeRisk, previousWindow, salesPerformance, topCustomers, topParties, workingCapitalDays,
} from '@/lib/server/reports/analytics';

const Q = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  fyStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

/**
 * Everything the dashboard shows, in one request.
 *
 * Fifteen separate endpoints would mean fifteen round trips before the first
 * screen anybody sees finishes painting. These are all aggregates over the same
 * data, so they are computed together and travel together.
 */
export const GET = route(
  async ({ orgId, req }) => {
    const q = query(req, Q);
    const win = { from: q.from, to: q.to };
    const prev = previousWindow(win);

    const [
      perf, perfPrev, margin, mix, bvc, series,
      debtors, creditors, arAgeing, pl, tb, cash, msme, irn, wc, customers,
    ] = await Promise.all([
      salesPerformance(db, orgId, win),
      salesPerformance(db, orgId, prev),
      grossMargin(db, orgId, win),
      goodsVsServices(db, orgId, win),
      billedVsCollected(db, orgId, 6, q.to),
      monthlySeries(db, orgId, 6, q.to),
      topParties(db, orgId, 'debtors', q.to),
      topParties(db, orgId, 'creditors', q.to),
      ageing(db, orgId, 'receivable', q.to),
      profitAndLoss(db, orgId, q.fyStart, q.to),
      trialBalance(db, orgId, q.to),
      cashPosition(db, orgId),
      msmeRisk(db, orgId, q.to),
      einvoicePending(db, orgId),
      workingCapitalDays(db, orgId, q.to),
      topCustomers(db, orgId, win),
    ]);

    // Receivables and payables straight off the control accounts, so the tiles
    // and the ageing reports can never disagree.
    const ar = tb.rows.find((r) => r.code === '1100')?.balancePaise ?? 0;
    const ap = tb.rows.find((r) => r.code === '2100')?.balancePaise ?? 0;

    const recent = await db
      .selectFrom('invoices')
      .innerJoin('contacts', 'contacts.id', 'invoices.customer_id')
      .select([
        'invoices.id', 'invoices.number', 'invoices.invoice_date', 'invoices.status',
        'invoices.total', 'invoices.amount_paid', 'contacts.display_name as customer_name',
      ])
      .where('invoices.org_id', '=', orgId)
      .where('invoices.status', '<>', 'draft')
      .orderBy('invoices.invoice_date', 'desc')
      .orderBy('invoices.id', 'desc')
      .limit(6)
      .execute();

    const overdue = arAgeing.rows.reduce(
      (t, r) => t + Object.entries(r.buckets).reduce((s, [b, v]) => (b === 'Current' ? s : s + v), 0),
      0,
    );

    return {
      period: { ...win, previous: prev },
      workingCapital: wc,
      sales: perf,
      salesPrevious: perfPrev,
      margin,
      goodsVsServices: mix,
      billedVsCollected: bvc,
      monthlySeries: series,
      topCustomers: customers,
      topDebtors: debtors,
      topCreditors: creditors,
      receivableBuckets: Object.entries(arAgeing.totals).map(([bucket, value]) => ({
        bucket,
        value,
        pct: arAgeing.grandTotalPaise > 0 ? (value / arAgeing.grandTotalPaise) * 100 : 0,
        count: arAgeing.rows.filter((r) => (r.buckets[bucket] ?? 0) > 0).length,
      })),
      position: {
        receivablePaise: ar,
        overduePaise: overdue,
        payablePaise: ap,
        cashPaise: cash
          .filter((c) => c.kind !== 'card')
          .reduce((t, c) => t + c.balancePaise, 0),
        openInvoices: arAgeing.rows.reduce((t, r) => t + (r.totalPaise > 0 ? 1 : 0), 0),
      },
      profitAndLoss: {
        totalIncome: pl.totalIncome,
        // After the change in stock, so income less this is the profit shown.
        totalExpense: pl.totalExpense + pl.openingStockPaise - pl.closingStockPaise,
        netProfit: pl.netProfit,
        expenseRows: pl.expenseRows.slice(0, 6).map((r) => ({ name: r.name, value: r.balancePaise })),
      },
      ledger: {
        entryCount: tb.rows.length,
        totalDebitPaise: tb.totalDebit,
        totalCreditPaise: tb.totalCredit,
        balanced: tb.balanced,
      },
      cash,
      msme,
      einvoicePending: irn,
      unmatchedBankLines: cash.reduce((t, c) => t + c.unmatched, 0),
      recentInvoices: recent.map((r) => ({
        id: asId(r.id),
        number: r.number,
        date: r.invoice_date,
        status: r.status,
        customerName: r.customer_name,
        balancePaise: toPaiseFromSql(r.total) - toPaiseFromSql(r.amount_paid),
      })),
    };
  },
  { permission: { module: 'reports', action: 'view' } },
);
