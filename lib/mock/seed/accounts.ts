// ─────────────────────────────────────────────────────────────────────────────
// Seeded Indian chart of accounts. System accounts get well-known IDs (ACC.*)
// so posting services can reference them without lookups.
// ─────────────────────────────────────────────────────────────────────────────

import type { Account } from '../../types';

/** Well-known system account IDs used by the posting services. */
export const ACC = {
  // Assets
  AR: 'acc_ar',
  BANK_HDFC: 'acc_bank_hdfc',
  BANK_ICICI: 'acc_bank_icici',
  CASH: 'acc_cash',
  PAYMENT_CLEARING: 'acc_payment_clearing',
  ITC_CGST: 'acc_itc_cgst',
  ITC_SGST: 'acc_itc_sgst',
  ITC_IGST: 'acc_itc_igst',
  TDS_RECEIVABLE: 'acc_tds_recv',
  INVENTORY: 'acc_inventory',
  FIXED_ASSETS: 'acc_fixed_assets',
  // Liabilities
  AP: 'acc_ap',
  GST_CGST: 'acc_gst_cgst',
  GST_SGST: 'acc_gst_sgst',
  GST_IGST: 'acc_gst_igst',
  TDS_PAYABLE: 'acc_tds_payable',
  TCS_PAYABLE: 'acc_tcs_payable',
  UNEARNED: 'acc_unearned',
  CC_HDFC: 'acc_cc_hdfc',
  // Equity
  CAPITAL: 'acc_capital',
  RETAINED: 'acc_retained',
  // Income
  SALES: 'acc_sales',
  SERVICE_INCOME: 'acc_service_income',
  SHIPPING_INCOME: 'acc_shipping_income',
  OTHER_INCOME: 'acc_other_income',
  // Expense
  COGS: 'acc_cogs',
  PURCHASES: 'acc_purchases',
  RENT: 'acc_rent',
  SALARIES: 'acc_salaries',
  FREIGHT: 'acc_freight',
  PROFESSIONAL: 'acc_professional',
  COMMISSION: 'acc_commission',
  UTILITIES: 'acc_utilities',
  INTERNET: 'acc_internet',
  FUEL: 'acc_fuel',
  OFFICE: 'acc_office',
  MARKETING: 'acc_marketing',
  BANK_CHARGES: 'acc_bank_charges',
  ROUNDING: 'acc_rounding',
  WRITE_OFF: 'acc_write_off',
} as const;

const a = (
  id: string,
  code: string,
  name: string,
  type: Account['type'],
  isSystem = false,
  parentId: string | null = null,
  description?: string,
): Account => ({ id, code, name, type, parentId, isSystem, isArchived: false, description });

export const SEED_ACCOUNTS: Account[] = [
  // ── Assets (1xxx)
  a(ACC.AR, '1100', 'Accounts Receivable', 'asset', true, null, 'Amounts customers owe us'),
  a(ACC.BANK_HDFC, '1210', 'HDFC Bank – Current A/c', 'asset', true),
  a(ACC.BANK_ICICI, '1220', 'ICICI Bank – Current A/c', 'asset', true),
  a(ACC.CASH, '1290', 'Cash in Hand', 'asset', true),
  a(ACC.PAYMENT_CLEARING, '1250', 'Payment Clearing Account', 'asset', true, null,
    'Money collected but not yet deposited in a bank account'),
  a(ACC.ITC_CGST, '1310', 'Input CGST (ITC)', 'asset', true, null, 'GST paid on purchases — claimable'),
  a(ACC.ITC_SGST, '1320', 'Input SGST (ITC)', 'asset', true),
  a(ACC.ITC_IGST, '1330', 'Input IGST (ITC)', 'asset', true),
  a(ACC.TDS_RECEIVABLE, '1400', 'TDS Receivable', 'asset', true, null, 'Tax customers deducted on our invoices'),
  a(ACC.INVENTORY, '1500', 'Inventory Asset', 'asset', true),
  a(ACC.FIXED_ASSETS, '1600', 'Furniture & Equipment', 'asset'),
  // ── Liabilities (2xxx)
  a(ACC.AP, '2100', 'Accounts Payable', 'liability', true, null, 'Amounts we owe vendors'),
  a(ACC.GST_CGST, '2210', 'Output CGST Payable', 'liability', true),
  a(ACC.GST_SGST, '2220', 'Output SGST Payable', 'liability', true),
  a(ACC.GST_IGST, '2230', 'Output IGST Payable', 'liability', true),
  a(ACC.TDS_PAYABLE, '2300', 'TDS Payable', 'liability', true, null, 'Tax withheld from vendor payments'),
  a(ACC.TCS_PAYABLE, '2310', 'TCS Payable', 'liability', true),
  a(ACC.UNEARNED, '2400', 'Unearned Revenue (Retainers)', 'liability', true),
  a(ACC.CC_HDFC, '2500', 'HDFC Credit Card', 'liability', true),
  // ── Equity (3xxx)
  a(ACC.CAPITAL, '3100', 'Owner’s Capital', 'equity', true),
  a(ACC.RETAINED, '3200', 'Retained Earnings', 'equity', true),
  // ── Income (4xxx)
  a(ACC.SALES, '4100', 'Sales – Auto Parts', 'income', true),
  a(ACC.SERVICE_INCOME, '4200', 'Service & Fitment Income', 'income'),
  a(ACC.SHIPPING_INCOME, '4300', 'Shipping & Packing Charges', 'income'),
  a(ACC.OTHER_INCOME, '4900', 'Other Income', 'income'),
  // ── Expenses (5xxx–6xxx)
  a(ACC.COGS, '5100', 'Cost of Goods Sold', 'expense', true),
  a(ACC.PURCHASES, '5200', 'Purchases – Trading Goods', 'expense', true),
  a(ACC.FREIGHT, '5300', 'Freight & Cartage Inward', 'expense'),
  a(ACC.RENT, '6100', 'Rent', 'expense'),
  a(ACC.SALARIES, '6200', 'Salaries & Wages', 'expense'),
  a(ACC.PROFESSIONAL, '6300', 'Professional & Legal Fees', 'expense'),
  a(ACC.COMMISSION, '6350', 'Commission & Brokerage', 'expense'),
  a(ACC.UTILITIES, '6400', 'Electricity & Water', 'expense'),
  a(ACC.INTERNET, '6450', 'Telephone & Internet', 'expense'),
  a(ACC.FUEL, '6500', 'Fuel & Vehicle Running', 'expense'),
  a(ACC.OFFICE, '6600', 'Office Supplies', 'expense'),
  a(ACC.MARKETING, '6700', 'Advertising & Marketing', 'expense'),
  a(ACC.BANK_CHARGES, '6800', 'Bank Fees & Charges', 'expense', true),
  a(ACC.ROUNDING, '6900', 'Rounding Off', 'expense', true),
  a(ACC.WRITE_OFF, '6950', 'Bad Debts Written Off', 'expense', true),
];
