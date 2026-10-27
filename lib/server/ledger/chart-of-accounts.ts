import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// The standard Indian chart of accounts a new organisation starts with.
//
// System accounts are referenced by CODE rather than by row id. Codes are
// stable, meaningful to an accountant, and survive a database rebuild; an
// auto-increment id survives none of those things. Every posting service looks
// up what it needs through `accountIds()` once per transaction.
//
// The numbering follows the convention every Indian bookkeeper already reads:
// 1xxx assets, 2xxx liabilities, 3xxx equity, 4xxx income, 5xxx–6xxx expenses.
// ─────────────────────────────────────────────────────────────────────────────

import type { Executor, Trx } from '../db';

/** Codes the posting engine depends on. Renaming one is a migration. */
export const CODE = {
  // Assets
  AR: '1100',
  DOUBTFUL_DEBTS_PROVISION: '1190',
  BANK_DEFAULT: '1210',
  PAYMENT_CLEARING: '1250',
  SECURITY_DEPOSITS: '1260',
  LOANS_ADVANCES: '1270',
  CASH: '1290',
  ITC_CGST: '1310',
  ITC_SGST: '1320',
  ITC_IGST: '1330',
  ITC_CESS: '1340',
  GST_ON_ADVANCES: '1350',
  ITC_RECLAIMABLE: '1360',
  TDS_RECEIVABLE: '1400',
  TCS_RECEIVABLE: '1410',
  INVENTORY: '1500',
  FIXED_ASSETS: '1600',
  PLANT_MACHINERY: '1610',
  COMPUTERS: '1620',
  VEHICLES: '1630',
  BUILDINGS: '1640',
  CWIP: '1650',
  ACCUMULATED_DEPRECIATION: '1690',
  ASSET_DISPOSAL: '1695',
  INVESTMENTS: '1700',
  CURRENT_INVESTMENTS: '1710',
  MISC_EXPENSES_ASSET: '1800',
  BRANCH_DIVISIONS: '1900',
  SUSPENSE: '1990',
  // Liabilities
  AP: '2100',
  GOODS_RECEIVED_NOT_BILLED: '2150',
  GST_CGST: '2210',
  GST_SGST: '2220',
  GST_IGST: '2230',
  RCM_PAYABLE: '2240',
  GST_CESS: '2250',
  TDS_PAYABLE: '2300',
  TCS_PAYABLE: '2310',
  PF_PAYABLE: '2320',
  ESI_PAYABLE: '2330',
  PT_PAYABLE: '2340',
  LWF_PAYABLE: '2350',
  UNEARNED: '2400',
  SALARIES_PAYABLE: '2410',
  CREDIT_CARD: '2500',
  BANK_OD: '2510',
  SECURED_LOANS: '2600',
  UNSECURED_LOANS: '2650',
  PROVISIONS: '2700',
  INCOME_TAX_PROVISION: '2720',
  DEPOSITS_RECEIVED: '2800',
  // Equity
  CAPITAL: '3100',
  DRAWINGS: '3150',
  RETAINED: '3200',
  OPENING_BALANCE_EQUITY: '3300',
  // Income
  SALES: '4100',
  SERVICE_INCOME: '4200',
  SHIPPING_INCOME: '4300',
  DISCOUNT_ALLOWED: '4400',
  DISCOUNT_RECEIVED: '4450',
  OTHER_INCOME: '4900',
  PROFIT_ON_ASSET_SALE: '4950',
  FX_GAIN: '4960',
  // Expenses
  COGS: '5100',
  PURCHASES: '5200',
  FREIGHT: '5300',
  RENT: '6100',
  SALARIES: '6200',
  EMPLOYER_CONTRIBUTIONS: '6210',
  STAFF_REIMBURSEMENTS: '6220',
  GRATUITY: '6230',
  PROFESSIONAL: '6300',
  COMMISSION: '6350',
  UTILITIES: '6400',
  INTERNET: '6450',
  FUEL: '6500',
  OFFICE: '6600',
  MARKETING: '6700',
  BANK_CHARGES: '6800',
  ROUNDING: '6900',
  WRITE_OFF: '6950',
  DOUBTFUL_DEBTS_EXPENSE: '6955',
  TAX_INTEREST: '6960',
  COMPOSITION_TAX: '6965',
  DEPRECIATION: '6970',
  ITC_REVERSED_EXEMPT: '6975',
  LOSS_ON_ASSET_SALE: '6980',
  FX_LOSS: '6985',
  CASH_SHORT_EXCESS: '6990',
} as const;

export type AccountCode = (typeof CODE)[keyof typeof CODE];
type AccountType = 'asset' | 'liability' | 'equity' | 'income' | 'expense';

interface SeedAccount {
  code: string;
  name: string;
  type: AccountType;
  subtype?: string;
  /** System accounts cannot be deleted or retyped: postings depend on them. */
  system?: boolean;
  description?: string;
}

export const STANDARD_ACCOUNTS: SeedAccount[] = [
  // ── Assets ────────────────────────────────────────────────────────────────
  { code: CODE.AR, name: 'Accounts Receivable', type: 'asset', subtype: 'receivable', system: true, description: 'What customers owe us' },
  { code: CODE.DOUBTFUL_DEBTS_PROVISION, name: 'Provision for Doubtful Debts', type: 'asset', subtype: 'receivable', system: true, description: 'A credit balance against receivables: what is not expected to be collected' },
  { code: CODE.BANK_DEFAULT, name: 'Bank Account', type: 'asset', subtype: 'bank', system: true },
  { code: CODE.PAYMENT_CLEARING, name: 'Payment Clearing Account', type: 'asset', subtype: 'bank', system: true, description: 'Collected but not yet in a bank account' },
  { code: CODE.CASH, name: 'Cash in Hand', type: 'asset', subtype: 'cash', system: true },
  { code: CODE.SECURITY_DEPOSITS, name: 'Security Deposits', type: 'asset', subtype: 'deposit', description: 'Rent, electricity and other deposits paid, recoverable when the arrangement ends' },
  { code: CODE.LOANS_ADVANCES, name: 'Loans & Advances (Asset)', type: 'asset', subtype: 'advance', description: 'Advances to staff and others, recoverable in cash or kind within the year' },
  { code: CODE.ITC_CGST, name: 'Input CGST (ITC)', type: 'asset', subtype: 'tax', system: true, description: 'Central GST paid on purchases, claimable against output tax' },
  { code: CODE.ITC_SGST, name: 'Input SGST/UTGST (ITC)', type: 'asset', subtype: 'tax', system: true },
  { code: CODE.ITC_IGST, name: 'Input IGST (ITC)', type: 'asset', subtype: 'tax', system: true },
  { code: CODE.ITC_CESS, name: 'Input Cess (ITC)', type: 'asset', subtype: 'tax', system: true, description: 'Compensation cess paid on purchases; it can only be set off against output cess' },
  { code: CODE.GST_ON_ADVANCES, name: 'GST paid on advances', type: 'asset', subtype: 'tax', system: true, description: 'GST paid when an advance for services arrived; cleared as the advance is applied to invoices' },
  { code: CODE.ITC_RECLAIMABLE, name: 'ITC reversed, reclaimable on payment', type: 'asset', subtype: 'tax', system: true, description: 'Credit reversed under Rule 37 because a supplier was not paid in 180 days; it comes back as they are paid' },
  { code: CODE.TDS_RECEIVABLE, name: 'TDS Receivable', type: 'asset', subtype: 'tax', system: true, description: 'Tax customers deducted from our invoices, recoverable from the government' },
  { code: CODE.TCS_RECEIVABLE, name: 'TCS Receivable', type: 'asset', subtype: 'tax', system: true, description: 'Tax collected at source by our sellers; claimed against our own income tax' },
  { code: CODE.INVENTORY, name: 'Inventory Asset', type: 'asset', subtype: 'stock', system: true },
  { code: CODE.FIXED_ASSETS, name: 'Furniture & Equipment', type: 'asset', subtype: 'fixed_asset' },
  { code: CODE.PLANT_MACHINERY, name: 'Plant & Machinery', type: 'asset', subtype: 'fixed_asset' },
  { code: CODE.COMPUTERS, name: 'Computers & Peripherals', type: 'asset', subtype: 'fixed_asset' },
  { code: CODE.VEHICLES, name: 'Vehicles', type: 'asset', subtype: 'fixed_asset' },
  { code: CODE.BUILDINGS, name: 'Buildings', type: 'asset', subtype: 'fixed_asset' },
  { code: CODE.CWIP, name: 'Capital Work-in-Progress', type: 'asset', subtype: 'cwip', system: true, description: 'Cost of assets being built or installed, held until they are put to use' },
  { code: CODE.ACCUMULATED_DEPRECIATION, name: 'Accumulated Depreciation', type: 'asset', subtype: 'fixed_asset', system: true, description: 'Depreciation charged so far; a credit balance that nets against the asset ledgers' },
  { code: CODE.ASSET_DISPOSAL, name: 'Asset Disposal Clearing', type: 'asset', subtype: 'current', system: true, description: 'Holds the sale value of an asset sold by invoice until its disposal is posted' },
  { code: CODE.INVESTMENTS, name: 'Investments', type: 'asset', subtype: 'investment', description: 'Shares, bonds, mutual funds and deposits held for more than a year' },
  { code: CODE.CURRENT_INVESTMENTS, name: 'Current Investments', type: 'asset', subtype: 'current_investment', description: 'Investments to be realised within twelve months' },
  { code: CODE.MISC_EXPENSES_ASSET, name: 'Miscellaneous Expenses (Asset)', type: 'asset', subtype: 'misc_expense', description: 'Preliminary and pre-operative expenses not yet written off' },
  { code: CODE.BRANCH_DIVISIONS, name: 'Branch / Divisions', type: 'asset', subtype: 'branch', description: 'Inter-branch account; its balances across branches net to nil' },
  { code: CODE.SUSPENSE, name: 'Suspense Account', type: 'asset', subtype: 'suspense', system: true, description: 'Holds an entry whose right ledger is not yet known. Should be nil before the books are closed' },

  // ── Liabilities ───────────────────────────────────────────────────────────
  { code: CODE.AP, name: 'Accounts Payable', type: 'liability', subtype: 'payable', system: true, description: 'What we owe suppliers' },
  { code: CODE.GOODS_RECEIVED_NOT_BILLED, name: 'Goods received, bill pending', type: 'liability', subtype: 'current', system: true, description: "The cost of goods received on a goods receipt note until the supplier's bill is entered" },
  { code: CODE.GST_CGST, name: 'Output CGST Payable', type: 'liability', subtype: 'tax', system: true },
  { code: CODE.GST_SGST, name: 'Output SGST/UTGST Payable', type: 'liability', subtype: 'tax', system: true },
  { code: CODE.GST_IGST, name: 'Output IGST Payable', type: 'liability', subtype: 'tax', system: true },
  { code: CODE.RCM_PAYABLE, name: 'GST Payable under Reverse Charge', type: 'liability', subtype: 'tax', system: true, description: 'GST we owe on purchases where the supplier does not charge it. Paid in cash; input credit cannot settle it' },
  { code: CODE.GST_CESS, name: 'Output Cess Payable', type: 'liability', subtype: 'tax', system: true },
  { code: CODE.TDS_PAYABLE, name: 'TDS Payable', type: 'liability', subtype: 'tax', system: true, description: 'Tax withheld from vendors, owed to the government' },
  { code: CODE.TCS_PAYABLE, name: 'TCS Payable', type: 'liability', subtype: 'tax', system: true },
  { code: CODE.PF_PAYABLE, name: 'PF Payable', type: 'liability', subtype: 'current', system: true, description: 'Provident fund deducted and contributed, due to EPFO by the 15th' },
  { code: CODE.ESI_PAYABLE, name: 'ESI Payable', type: 'liability', subtype: 'current', system: true, description: 'ESI deducted and contributed, due to ESIC by the 15th' },
  { code: CODE.PT_PAYABLE, name: 'Professional Tax Payable', type: 'liability', subtype: 'current', system: true, description: 'Professional tax deducted from salaries, due to the state' },
  { code: CODE.LWF_PAYABLE, name: 'Labour Welfare Fund Payable', type: 'liability', subtype: 'current', system: true, description: 'Employee and employer labour welfare fund contributions' },
  { code: CODE.SALARIES_PAYABLE, name: 'Salaries Payable', type: 'liability', subtype: 'current', system: true, description: 'Net salaries for a posted payroll, until they are paid' },
  { code: CODE.UNEARNED, name: 'Unearned Revenue (Retainers)', type: 'liability', subtype: 'current', system: true, description: 'Advances taken for work not yet done' },
  { code: CODE.CREDIT_CARD, name: 'Credit Card', type: 'liability', subtype: 'credit_card', system: true },
  { code: CODE.BANK_OD, name: 'Bank Overdraft / Cash Credit', type: 'liability', subtype: 'bank_od', description: 'Overdraft and cash-credit limits drawn; repayable on demand' },
  { code: CODE.SECURED_LOANS, name: 'Secured Loans', type: 'liability', subtype: 'loan', description: 'Term loans and other borrowings against a charge on assets' },
  { code: CODE.UNSECURED_LOANS, name: 'Unsecured Loans', type: 'liability', subtype: 'loan', description: 'Loans from directors, partners, relatives and others without security' },
  { code: CODE.PROVISIONS, name: 'Provisions', type: 'liability', subtype: 'provision', description: 'Expenses incurred and not yet billed or paid: audit fee, bonus, gratuity' },
  { code: CODE.INCOME_TAX_PROVISION, name: 'Provision for Income Tax', type: 'liability', subtype: 'provision', description: 'Income tax for the year, net of advance tax once it is set off' },
  { code: CODE.DEPOSITS_RECEIVED, name: 'Deposits Received', type: 'liability', subtype: 'deposit', description: 'Security deposits taken from dealers, tenants and customers' },

  // ── Equity ────────────────────────────────────────────────────────────────
  { code: CODE.CAPITAL, name: 'Owner’s Capital', type: 'equity', system: true },
  { code: CODE.DRAWINGS, name: 'Drawings', type: 'equity', subtype: 'drawings', description: 'What a proprietor or partner takes out of the business; reduces their capital' },
  { code: CODE.RETAINED, name: 'Retained Earnings', type: 'equity', system: true },
  { code: CODE.OPENING_BALANCE_EQUITY, name: 'Opening Balance Equity', type: 'equity', system: true, description: 'Holds the other side of opening balances until the books are complete' },

  // ── Income ────────────────────────────────────────────────────────────────
  { code: CODE.SALES, name: 'Sales', type: 'income', system: true },
  { code: CODE.SERVICE_INCOME, name: 'Service Income', type: 'income' },
  { code: CODE.SHIPPING_INCOME, name: 'Shipping & Packing Charges', type: 'income' },
  { code: CODE.DISCOUNT_ALLOWED, name: 'Discount Allowed', type: 'income', description: 'Contra-income: reduces revenue rather than adding an expense' },
  { code: CODE.DISCOUNT_RECEIVED, name: 'Discount Received', type: 'income', description: 'Cash and trade discounts given to us by suppliers' },
  { code: CODE.OTHER_INCOME, name: 'Other Income', type: 'income' },
  { code: CODE.PROFIT_ON_ASSET_SALE, name: 'Profit on Sale of Fixed Assets', type: 'income', system: true },
  { code: CODE.FX_GAIN, name: 'Foreign Exchange Gain', type: 'income', system: true, description: 'Gains on settling or restating foreign-currency balances' },

  // ── Expenses ──────────────────────────────────────────────────────────────
  { code: CODE.COGS, name: 'Cost of Goods Sold', type: 'expense', system: true },
  { code: CODE.PURCHASES, name: 'Purchases – Trading Goods', type: 'expense', system: true },
  { code: CODE.FREIGHT, name: 'Freight & Cartage Inward', type: 'expense' },
  { code: CODE.RENT, name: 'Rent', type: 'expense' },
  { code: CODE.SALARIES, name: 'Salaries & Wages', type: 'expense' },
  { code: CODE.EMPLOYER_CONTRIBUTIONS, name: 'Employer PF, ESI and LWF', type: 'expense', system: true, description: 'The employer contributions and PF charges on salaries' },
  { code: CODE.STAFF_REIMBURSEMENTS, name: 'Staff Reimbursements', type: 'expense', system: true, description: 'Expenses employees incurred for the business, repaid with salary' },
  { code: CODE.GRATUITY, name: 'Gratuity', type: 'expense', system: true, description: 'Gratuity paid or provided under the Payment of Gratuity Act, 1972' },
  { code: CODE.PROFESSIONAL, name: 'Professional & Legal Fees', type: 'expense' },
  { code: CODE.COMMISSION, name: 'Commission & Brokerage', type: 'expense' },
  { code: CODE.UTILITIES, name: 'Electricity & Water', type: 'expense' },
  { code: CODE.INTERNET, name: 'Telephone & Internet', type: 'expense' },
  { code: CODE.FUEL, name: 'Fuel & Vehicle Running', type: 'expense' },
  { code: CODE.OFFICE, name: 'Office Supplies', type: 'expense' },
  { code: CODE.MARKETING, name: 'Advertising & Marketing', type: 'expense' },
  { code: CODE.BANK_CHARGES, name: 'Bank Fees & Charges', type: 'expense', system: true },
  { code: CODE.ROUNDING, name: 'Rounding Off', type: 'expense', system: true, description: 'Absorbs the paisa lost when an invoice total is rounded to the rupee' },
  { code: CODE.WRITE_OFF, name: 'Bad Debts Written Off', type: 'expense', system: true },
  { code: CODE.DOUBTFUL_DEBTS_EXPENSE, name: 'Provision for Doubtful Debts (expense)', type: 'expense', system: true, description: 'The charge, or release, as the provision is raised or lowered' },
  { code: CODE.TAX_INTEREST, name: 'Interest & Fees on Late Taxes', type: 'expense', system: true, description: 'Interest and late fees on TDS, TCS and GST; not deductible for income tax' },
  { code: CODE.COMPOSITION_TAX, name: 'Composition Tax', type: 'expense', system: true, description: 'Tax paid on turnover under the composition scheme; it cannot be collected from buyers' },
  { code: CODE.DEPRECIATION, name: 'Depreciation', type: 'expense', subtype: 'depreciation', system: true, description: 'Charged under Schedule II of the Companies Act' },
  { code: CODE.ITC_REVERSED_EXEMPT, name: 'ITC reversed on exempt supplies', type: 'expense', system: true, description: 'The share of common credit that belongs to exempt supplies, reversed under Rules 42 and 43' },
  { code: CODE.CASH_SHORT_EXCESS, name: 'Cash Short & Excess', type: 'expense', system: true, description: 'Differences found when cash is counted: a debit is a shortage, a credit an excess' },
  { code: CODE.FX_LOSS, name: 'Foreign Exchange Loss', type: 'expense', system: true, description: 'Losses on settling or restating foreign-currency balances' },
  { code: CODE.LOSS_ON_ASSET_SALE, name: 'Loss on Sale or Discard of Fixed Assets', type: 'expense', system: true },
];

/** Install the standard chart for a new organisation. Idempotent. */
export async function installChartOfAccounts(trx: Trx, orgId: number): Promise<number> {
  const existing = await trx
    .selectFrom('accounts')
    .select('code')
    .where('org_id', '=', orgId)
    .execute();
  const have = new Set(existing.map((r) => r.code));

  const missing = STANDARD_ACCOUNTS.filter((a) => !have.has(a.code));
  if (missing.length === 0) return 0;

  await trx
    .insertInto('accounts')
    .values(
      missing.map((a) => ({
        org_id: orgId,
        code: a.code,
        name: a.name,
        type: a.type,
        subtype: a.subtype ?? null,
        description: a.description ?? null,
        is_system: a.system ? 1 : 0,
        is_active: 1,
      })),
    )
    .execute();

  return missing.length;
}

/**
 * Resolve every account code to its row id, in one query.
 *
 * Posting services call this once and then index into the result, rather than
 * issuing a lookup per line — a twenty-line bill would otherwise mean twenty
 * round trips inside a transaction that is holding row locks.
 */
export async function accountIds(
  ex: Executor,
  orgId: number,
): Promise<Record<string, number>> {
  const rows = await ex
    .selectFrom('accounts')
    .select(['id', 'code'])
    .where('org_id', '=', orgId)
    .execute();
  return Object.fromEntries(rows.map((r) => [r.code, r.id]));
}

/** Look one up, failing loudly — a missing system account is not recoverable. */
export function requireAccount(map: Record<string, number>, code: string): number {
  const id = map[code];
  if (!id) {
    throw new Error(
      `Account ${code} is missing from the chart of accounts. ` +
        'It is a system account the posting engine needs; re-run onboarding to restore it.',
    );
  }
  return id;
}
