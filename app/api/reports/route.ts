import { z } from 'zod';
import { db } from '@/lib/server/db';
import { route, query, badRequest, forbidden } from '@/lib/server/http';
import { hasPermission } from '@/lib/rbac';
import { REPORT_GROUP_LABEL, reportGroupOf, reportModule } from '@/lib/report-groups';
import {
  trialBalance, profitAndLoss, balanceSheet, generalLedger, ageing,
} from '@/lib/server/reports/statements';
import {
  accountTypeSummary, businessRatios, cashFlow, expensesByCategory,
  movementOfEquity, partyBalances, purchasesByVendor, refundHistory, salesBy, timeToGetPaid,
} from '@/lib/server/reports/analysis';
import { scheduleIIIBalanceSheet, scheduleIIIProfitAndLoss } from '@/lib/server/reports/schedule-iii';
import { pendingPurchaseOrders, pendingSalesOrders } from '@/lib/server/reports/orders';
import { fundFlow } from '@/lib/server/reports/fund-flow';
import { groupedBalanceSheet, groupedProfitAndLoss } from '@/lib/server/reports/statement-groups';
import { portalActivityReport } from '@/lib/server/services/portal';
import {
  abcClassification, billableExpenseDetails, committedStock, expensesBy, inventoryValuation, partyRegister, projectSummary,
  purchaseOrderDetails, purchasesByItem, realisedFx, reconciliationStatus, salesSummary, systemMails, timesheetDetails, unrealisedFx,
  vendorCreditDetails,
} from '@/lib/server/reports/zoho-reports';

const ReportQuery = z.object({
  report: z.enum([
    // Statements — what the books say.
    'trial-balance', 'profit-and-loss', 'balance-sheet',
    // The same, laid out as Schedule III to the Companies Act requires.
    'schedule-iii-balance-sheet', 'schedule-iii-profit-and-loss',
    // And grouped by category, as Zoho Books groups them (also the T-form's source).
    'profit-and-loss-grouped', 'balance-sheet-grouped',
    'general-ledger', 'ar-ageing', 'ap-ageing',
    // Analysis — what that tells us. Same journal, different question.
    'customer-balances', 'vendor-balances', 'sales-by-customer', 'sales-by-item',
    'sales-by-salesperson', 'purchases-by-vendor', 'expenses-by-category',
    'account-type-summary', 'cash-flow', 'fund-flow', 'business-ratios', 'movement-of-equity',
    'time-to-get-paid', 'refund-history',
    // The order backlog: promised, not yet delivered or invoiced.
    'pending-sales-orders', 'pending-purchase-orders',
    // What customers and vendors did on their portal (Zoho's Portal activities).
    'portal-activities',
    // The rest of Zoho Books' list (lib/server/reports/zoho-reports.ts).
    'purchases-by-item', 'purchase-order-details', 'vendor-credit-details', 'expenses-by-customer', 'expenses-by-project',
    'billable-expense-details', 'timesheet-details', 'project-summary', 'receivable-details', 'payable-details', 'sales-summary',
    'abc-classification', 'system-mails', 'realised-fx',
    // As at a date: no start needed.
    'inventory-valuation', 'committed-stock', 'reconciliation-status', 'unrealised-fx',
  ]),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Give an end date as yyyy-mm-dd.'),
  branchId: z.string().optional(),
  accountId: z.string().optional(),
  /** Zoho's "Report basis": accrual (the default) or cash, for the statements. */
  basis: z.enum(['accrual', 'cash']).default('accrual'),
});

/**
 * Every statement, from one endpoint.
 *
 * They share a period, a branch filter and a shape, and the only thing that
 * differs is which aggregate runs. Six near-identical route files would have
 * six near-identical copies of the parsing and the permission check.
 *
 * Nothing is cached. Each figure is computed from the journal on the request,
 * which is what makes it impossible for two reports to disagree.
 */
export const GET = route(
  async ({ orgId, role, req }) => {
    const q = query(req, ReportQuery);
    // Report-level rights: a custom role may see some groups of reports only.
    if (!hasPermission(role, reportModule(q.report), 'view')) {
      throw forbidden(`Your role does not include ${REPORT_GROUP_LABEL[reportGroupOf(q.report)].toLowerCase()}.`);
    }
    const branchId = q.branchId ? Number(q.branchId) : undefined;

    switch (q.report) {
      case 'trial-balance': {
        const tb = await trialBalance(db, orgId, q.to, branchId, q.basis);
        return { report: q.report, asOf: q.to, ...tb };
      }

      case 'balance-sheet': {
        const bs = await balanceSheet(db, orgId, q.to, branchId, q.basis);
        return { report: q.report, ...bs };
      }

      case 'balance-sheet-grouped':
        return { report: q.report, ...(await groupedBalanceSheet(db, orgId, q.to, branchId, q.basis)) };

      case 'profit-and-loss-grouped': {
        if (!q.from) throw badRequest('A profit and loss needs a start date — it covers a period.');
        return { report: q.report, ...(await groupedProfitAndLoss(db, orgId, q.from, q.to, branchId, q.basis)) };
      }

      case 'schedule-iii-balance-sheet':
        return { report: q.report, ...(await scheduleIIIBalanceSheet(db, orgId, q.to, branchId, q.basis)) };

      case 'pending-sales-orders':
        return { report: q.report, ...(await pendingSalesOrders(db, orgId, q.to, branchId)) };

      case 'pending-purchase-orders':
        return { report: q.report, ...(await pendingPurchaseOrders(db, orgId, q.to, branchId)) };

      case 'schedule-iii-profit-and-loss': {
        if (!q.from) throw badRequest('A profit and loss needs a start date — it covers a period.');
        return { report: q.report, ...(await scheduleIIIProfitAndLoss(db, orgId, q.from, q.to, branchId, q.basis)) };
      }

      case 'profit-and-loss': {
        if (!q.from) throw badRequest('A profit and loss needs a start date — it covers a period.');
        const pl = await profitAndLoss(db, orgId, q.from, q.to, branchId, q.basis);
        return { report: q.report, ...pl };
      }

      case 'general-ledger': {
        if (!q.accountId) throw badRequest('Choose an account to see its ledger.');
        if (!q.from) throw badRequest('A ledger needs a start date.');
        const account = await db
          .selectFrom('accounts').select(['id', 'code', 'name', 'type'])
          .where('id', '=', Number(q.accountId)).where('org_id', '=', orgId).executeTakeFirst();
        if (!account) throw badRequest('That account does not exist.');

        const gl = await generalLedger(db, orgId, Number(q.accountId), q.from, q.to);
        return {
          report: q.report,
          account: { id: String(account.id), code: account.code, name: account.name, type: account.type },
          from: q.from,
          to: q.to,
          ...gl,
        };
      }

      case 'ar-ageing':
      case 'ap-ageing': {
        const side = q.report === 'ar-ageing' ? 'receivable' : 'payable';
        const result = await ageing(db, orgId, side, q.to);
        return { report: q.report, asOf: q.to, side, ...result };
      }

      // ── As at a date.
      case 'inventory-valuation':
        return { report: q.report, asOf: q.to, ...(await inventoryValuation(db, orgId, q.to)) };
      case 'committed-stock':
        return { report: q.report, asOf: q.to, rows: await committedStock(db, orgId, q.to) };
      case 'reconciliation-status':
        return { report: q.report, asOf: q.to, rows: await reconciliationStatus(db, orgId, q.to) };
      case 'unrealised-fx':
        return { report: q.report, asOf: q.to, rows: await unrealisedFx(db, orgId, q.to) };

      // ── Analysis. All of these cover a period, so all need a start date.
      default: {
        if (!q.from) throw badRequest('This report covers a period, so it needs a start date.');
        const w = { from: q.from, to: q.to };

        switch (q.report) {
          case 'customer-balances':
            return { report: q.report, ...w, rows: await partyBalances(db, orgId, 'customer', w) };
          case 'vendor-balances':
            return { report: q.report, ...w, rows: await partyBalances(db, orgId, 'vendor', w) };
          case 'sales-by-customer':
            return { report: q.report, ...w, rows: await salesBy(db, orgId, 'customer', w) };
          case 'sales-by-item':
            return { report: q.report, ...w, rows: await salesBy(db, orgId, 'item', w) };
          case 'sales-by-salesperson':
            return { report: q.report, ...w, rows: await salesBy(db, orgId, 'salesperson', w) };
          case 'purchases-by-vendor':
            return { report: q.report, ...w, rows: await purchasesByVendor(db, orgId, w) };
          case 'expenses-by-category':
            return { report: q.report, ...w, rows: await expensesByCategory(db, orgId, w) };
          case 'account-type-summary':
            return { report: q.report, asOf: q.to, rows: await accountTypeSummary(db, orgId, q.to) };
          case 'cash-flow':
            return { report: q.report, ...(await cashFlow(db, orgId, w)) };
          case 'fund-flow':
            return { report: q.report, ...(await fundFlow(db, orgId, w.from, w.to)) };
          case 'business-ratios':
            return { report: q.report, ...w, ratios: await businessRatios(db, orgId, w) };
          case 'movement-of-equity':
            return { report: q.report, ...w, ...(await movementOfEquity(db, orgId, w)) };
          case 'time-to-get-paid':
            return { report: q.report, ...w, ...(await timeToGetPaid(db, orgId, w)) };
          case 'refund-history':
            return { report: q.report, ...w, rows: await refundHistory(db, orgId, w) };
          case 'purchases-by-item':
            return { report: q.report, ...w, rows: await purchasesByItem(db, orgId, w) };
          case 'purchase-order-details':
            return { report: q.report, ...w, rows: await purchaseOrderDetails(db, orgId, w) };
          case 'vendor-credit-details':
            return { report: q.report, ...w, rows: await vendorCreditDetails(db, orgId, w) };
          case 'expenses-by-customer':
            return { report: q.report, ...w, rows: await expensesBy(db, orgId, 'customer', w) };
          case 'expenses-by-project':
            return { report: q.report, ...w, rows: await expensesBy(db, orgId, 'project', w) };
          case 'billable-expense-details':
            return { report: q.report, ...w, rows: await billableExpenseDetails(db, orgId, w) };
          case 'timesheet-details':
            return { report: q.report, ...w, rows: await timesheetDetails(db, orgId, w) };
          case 'project-summary':
            return { report: q.report, ...w, rows: await projectSummary(db, orgId, w) };
          case 'receivable-details':
            return { report: q.report, ...w, rows: await partyRegister(db, orgId, 'customer', w) };
          case 'payable-details':
            return { report: q.report, ...w, rows: await partyRegister(db, orgId, 'vendor', w) };
          case 'sales-summary':
            return { report: q.report, ...w, rows: await salesSummary(db, orgId, w) };
          case 'abc-classification':
            return { report: q.report, ...w, rows: await abcClassification(db, orgId, w) };
          case 'system-mails':
            return { report: q.report, ...w, rows: await systemMails(db, orgId, w) };
          case 'realised-fx':
            return { report: q.report, ...w, rows: await realisedFx(db, orgId, w) };
          case 'portal-activities': {
            // A customer's doings are sales', a vendor's purchasing's.
            const sides = new Set([hasPermission(role, 'sales', 'view') && 'customer', hasPermission(role, 'purchases', 'view') && 'vendor']);
            return { report: q.report, ...w, rows: (await portalActivityReport(db, orgId, w)).filter((r) => sides.has(r.side)) };
          }
        }
      }
    }
  },
  { permission: { module: 'reports', action: 'view' } },
);
