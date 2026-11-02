// Reports in groups, so a custom role can be given some of them and not
// others: sales staff their sales reports without the profit and loss.
// Shared by the reports index, the reports API and the role editor.

export type ReportGroup = 'financial' | 'sales' | 'purchases' | 'banking';

export const REPORT_GROUP_LABEL: Record<ReportGroup, string> = {
  financial: 'Financial statements',
  sales: 'Sales reports',
  purchases: 'Purchase reports',
  banking: 'Banking reports',
};

/** Each report's group, by its name in the reports API and its page under /reports. */
const GROUP: Record<string, ReportGroup> = {
  'trial-balance': 'financial', 'profit-and-loss': 'financial', 'balance-sheet': 'financial', 'schedule-iii': 'financial',
  'schedule-iii-balance-sheet': 'financial', 'schedule-iii-profit-and-loss': 'financial',
  'profit-and-loss-grouped': 'financial', 'balance-sheet-grouped': 'financial', 'general-ledger': 'financial',
  'account-transactions': 'financial', 'account-type-summary': 'financial', 'cash-flow': 'financial', 'fund-flow': 'financial', 'profit-by-tag': 'financial', 'cash-forecast': 'financial',
  'business-ratios': 'financial', 'inventory-valuation': 'financial', 'realised-fx': 'financial', 'unrealised-fx': 'financial', 'system-mails': 'financial', 'movement-of-equity': 'financial', 'consolidated': 'financial', 'journal-report': 'financial', 'day-book': 'financial',
  'ar-ageing': 'sales', 'ar-ageing-details': 'sales', 'customer-balances': 'sales', 'sales-by-customer': 'sales', 'sales-by-item': 'sales',
  'sales-by-salesperson': 'sales', 'time-to-get-paid': 'sales', 'refund-history': 'sales', 'pending-sales-orders': 'sales',
  'invoice-details': 'sales', 'estimate-details': 'sales', 'sales-order-details': 'sales', 'credit-note-details': 'sales',
  'payments-received': 'sales', 'retainer-details': 'sales', 'portal-activities': 'sales',
  'receivable-details': 'sales', 'sales-summary': 'sales', 'committed-stock': 'sales', 'abc-classification': 'sales', 'timesheet-details': 'sales', 'project-summary': 'sales',
  'ap-ageing': 'purchases', 'ap-ageing-details': 'purchases', 'vendor-balances': 'purchases', 'purchases-by-vendor': 'purchases', 'expenses-by-category': 'purchases',
  'pending-purchase-orders': 'purchases', 'bill-details': 'purchases', 'expense-details': 'purchases', 'payments-made': 'purchases',
  'purchases-by-item': 'purchases', 'purchase-order-details': 'purchases', 'vendor-credit-details': 'purchases', 'expenses-by-customer': 'purchases',
  'expenses-by-project': 'purchases', 'billable-expense-details': 'purchases', 'payable-details': 'purchases',
  'cash-book': 'banking', 'reconciliation-status': 'banking',
};

export const reportGroupOf = (name: string): ReportGroup => GROUP[name] ?? 'financial';

/** The permission module for a report: reports.financial and so on. */
export const reportModule = (name: string) => `reports.${reportGroupOf(name)}`;
