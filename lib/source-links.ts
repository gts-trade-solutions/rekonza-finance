// Where the document behind a journal entry lives, so a ledger line can be
// followed back to it. A document with its own page opens that page; the
// rest open their list, which is as close as the app can take you.

const DETAIL: Record<string, string> = {
  invoice: '/sales/invoices',
  bill: '/purchases/bills',
  payroll: '/payroll/runs',
  payroll_payment: '/payroll/runs',
};

const LIST: Record<string, string> = {
  payment_received: '/sales/payments',
  payment_made: '/purchases/payments',
  credit_note: '/sales/credit-notes',
  credit_note_refund: '/sales/credit-notes',
  retainer: '/sales/retainers',
  retainer_application: '/sales/retainers',
  vendor_credit: '/purchases/vendor-credits',
  vendor_credit_refund: '/purchases/vendor-credits',
  expense: '/purchases/expenses',
  goods_receipt: '/purchases/goods-receipts',
  manual: '/accountant/journals',
  write_off: '/accountant/journals',
  doubtful_debts: '/accountant/journals',
  recurring: '/accountant/recurring-journals',
  fnf: '/payroll/full-and-final',
  fnf_payment: '/payroll/full-and-final',
  depreciation: '/accountant/fixed-assets',
  asset_purchase: '/accountant/fixed-assets',
  asset_capitalisation: '/accountant/fixed-assets',
  asset_disposal: '/accountant/fixed-assets',
  fx_revaluation: '/accountant/foreign-currency',
  opening: '/accountant/opening-balances',
  opening_balance: '/accountant/opening-balances',
  opening_document: '/accountant/opening-balances',
  // Perpetual inventory's own entries (services/stock-ledger.ts).
  stock_valuation: '/inventory/stock',
  stock_opening: '/inventory/stock',
};

export function sourceHref(sourceType: string, sourceId: string | null): string | null {
  const detail = DETAIL[sourceType];
  if (detail && sourceId) return `${detail}/${sourceId}`;
  return LIST[sourceType] ?? detail ?? null;
}

/** The general ledger of one account over a range: where a report figure drills to. */
export const ledgerHref = (accountId: string, from: string, to: string) =>
  `/reports/general-ledger?account=${encodeURIComponent(accountId)}&from=${from}&to=${to}`;
