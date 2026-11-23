// Zoho Books' "Categorize Manually" on a bank line: what the money was, as a
// list chosen by direction. Money in and money out have their own lists, each
// with the form Zoho shows for it. Shared by the reconcile screen and the
// server (lib/server/services/bank-match.ts), so the two never disagree on
// what a category needs.

export type BankCategoryKey =
  // Money in
  | 'customer_payment' | 'customer_advance' | 'transfer_from' | 'sales_without_invoice' | 'interest_income'
  | 'other_income' | 'expense_refund' | 'deposit_from_other' | 'owner_contribution' | 'vendor_refund'
  // Money out
  | 'expense' | 'vendor_payment' | 'vendor_advance' | 'transfer_to' | 'card_payment' | 'owner_drawings'
  | 'payment_refund' | 'employee_reimbursement' | 'deposit_to_other';

/** How a category is posted: through the documents a person would have raised, or as a journal. */
export type BankCategoryEngine = 'customer' | 'vendor' | 'transfer' | 'expense' | 'refund' | 'journal';

export interface BankCategory {
  key: BankCategoryKey;
  label: string;
  side: 'in' | 'out';
  engine: BankCategoryEngine;
  /** The account a journal category starts on (chart code); the person can change it. */
  defaultCode?: string;
  /** Which kinds of account may be picked, for a journal or expense category. */
  accountTypes?: ('asset' | 'liability' | 'equity' | 'income' | 'expense')[];
  /** The contact it asks for, if any, and whether it must be given. */
  contact?: 'customer' | 'vendor' | 'any';
  contactRequired?: boolean;
  /** Asks for a GST rate: the amount includes the tax. */
  tax?: boolean;
  /** For transfers: the kind of account at the other end. */
  otherAccount?: 'any' | 'card';
  hint: string;
}

export const BANK_CATEGORIES: BankCategory[] = [
  // ── Money in ───────────────────────────────────────────────────────────────
  { key: 'customer_payment', label: 'Customer Payment', side: 'in', engine: 'customer', contact: 'customer', contactRequired: true,
    hint: 'A customer paid: a receipt is recorded into this account and set against the invoices you pick.' },
  { key: 'customer_advance', label: 'Customer Advance', side: 'in', engine: 'customer', contact: 'customer', contactRequired: true,
    hint: 'Money received before an invoice: kept as the customer’s credit, to apply to an invoice later.' },
  { key: 'transfer_from', label: 'Transfer From Another Account', side: 'in', engine: 'transfer', otherAccount: 'any',
    hint: 'Your own money moved here from another bank, cash or card account. Not income.' },
  { key: 'sales_without_invoice', label: 'Sales Without Invoices', side: 'in', engine: 'journal', defaultCode: '4100',
    accountTypes: ['income'], contact: 'customer', tax: true,
    hint: 'A sale with no invoice raised. For a GST return, raise an invoice instead: returns are built from invoices.' },
  { key: 'interest_income', label: 'Interest Income', side: 'in', engine: 'journal', defaultCode: '4900', accountTypes: ['income'],
    hint: 'Interest the bank or a borrower paid you.' },
  { key: 'other_income', label: 'Other Income', side: 'in', engine: 'journal', defaultCode: '4900', accountTypes: ['income'], contact: 'any',
    hint: 'Income that is not a sale: a commission, a rebate, scrap sold.' },
  { key: 'expense_refund', label: 'Expense Refund', side: 'in', engine: 'journal', defaultCode: '6600', accountTypes: ['expense'], contact: 'vendor',
    hint: 'Money back on something you had spent: the expense it came off goes down.' },
  { key: 'deposit_from_other', label: 'Deposit From Other Accounts', side: 'in', engine: 'journal', accountTypes: ['asset', 'liability', 'equity', 'income'], contact: 'any',
    hint: 'Money in for anything else: a loan taken, a deposit returned to you.' },
  { key: 'owner_contribution', label: "Owner's Contribution", side: 'in', engine: 'journal', defaultCode: '3100', accountTypes: ['equity'],
    hint: 'Capital the owner put into the business.' },
  { key: 'vendor_refund', label: 'Vendor Payment Refund', side: 'in', engine: 'refund', contact: 'vendor', contactRequired: true,
    hint: 'A vendor returned an advance you had paid them: it comes off what they hold of yours.' },

  // ── Money out ──────────────────────────────────────────────────────────────
  { key: 'expense', label: 'Expense', side: 'out', engine: 'expense', defaultCode: '6600', accountTypes: ['expense', 'asset'], contact: 'vendor', tax: true,
    hint: 'Money spent: recorded as an expense paid from this account, with its GST.' },
  { key: 'vendor_payment', label: 'Vendor Payment', side: 'out', engine: 'vendor', contact: 'vendor', contactRequired: true,
    hint: 'You paid a vendor: a payment is recorded from this account and set against the bills you pick.' },
  { key: 'vendor_advance', label: 'Vendor Advance', side: 'out', engine: 'vendor', contact: 'vendor', contactRequired: true,
    hint: 'Paid ahead of the bill: kept as an advance with the vendor, to apply to a bill later.' },
  { key: 'transfer_to', label: 'Transfer To Another Account', side: 'out', engine: 'transfer', otherAccount: 'any',
    hint: 'Your own money moved from here to another bank, cash or card account. Not an expense.' },
  { key: 'card_payment', label: 'Card Payment', side: 'out', engine: 'transfer', otherAccount: 'card',
    hint: 'Paying off a credit card from this account.' },
  { key: 'owner_drawings', label: 'Owner Drawings', side: 'out', engine: 'journal', defaultCode: '3150', accountTypes: ['equity'],
    hint: 'Money the owner took out for personal use.' },
  { key: 'payment_refund', label: 'Payment Refund', side: 'out', engine: 'refund', contact: 'customer', contactRequired: true,
    hint: 'Money returned to a customer out of an advance or excess payment they had made.' },
  { key: 'employee_reimbursement', label: 'Employee Reimbursement', side: 'out', engine: 'journal', defaultCode: '6220', accountTypes: ['expense', 'liability'], contact: 'any',
    hint: 'Paying back an employee who spent their own money on the business.' },
  { key: 'deposit_to_other', label: 'Deposit To Other Accounts', side: 'out', engine: 'journal', accountTypes: ['asset', 'liability', 'equity', 'expense'], contact: 'any',
    hint: 'Money out for anything else: a loan repaid, a security deposit, tax paid.' },
];

export const categoriesFor = (side: 'in' | 'out') => BANK_CATEGORIES.filter((c) => c.side === side);
export const categoryOf = (key: string) => BANK_CATEGORIES.find((c) => c.key === key) ?? null;
