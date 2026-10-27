// ─────────────────────────────────────────────────────────────────────────────
// Sending this app's books to TallyPrime: the shapes both sides agree on.
//
// Tally's own vocabulary is used throughout, because the person reading these
// screens is looking at Tally on the other monitor: a ledger sits under a
// group, a document is a voucher of some voucher type, and money is Dr or Cr.
// ─────────────────────────────────────────────────────────────────────────────

/** Tally's own groups, the ones every company has from the day it is created. */
export const TALLY_GROUPS = [
  'Bank Accounts', 'Bank OD A/c', 'Capital Account', 'Cash-in-Hand', 'Current Assets',
  'Current Liabilities', 'Deposits (Asset)', 'Direct Expenses', 'Direct Incomes',
  'Duties & Taxes', 'Fixed Assets', 'Indirect Expenses', 'Indirect Incomes',
  'Investments', 'Loans & Advances (Asset)', 'Loans (Liability)', 'Misc. Expenses (ASSET)',
  'Provisions', 'Purchase Accounts', 'Reserves & Surplus', 'Sales Accounts',
  'Secured Loans', 'Stock-in-Hand', 'Sundry Creditors', 'Sundry Debtors',
  'Suspense A/c', 'Unsecured Loans',
] as const;

/** Tally's limit, and what a name is cut to before it is written. */
export const TALLY_NAME_MAX = 100;

/** What each of our accounts becomes in Tally. */
export interface LedgerMapRow {
  accountId: string;
  code: string;
  accountName: string;
  accountType: string;
  ledgerName: string;
  parentGroup: string;
  /** False once someone has changed it: then it no longer follows the account. */
  isDefault: boolean;
  /** How many exported vouchers touch it, over the period being looked at. */
  used: number;
}

export interface VoucherTally {
  voucherType: string;
  count: number;
  amountPaise: number;
}

export interface TallyExportSummary {
  from: string;
  to: string;
  branchId: number | null;
  voucherCount: number;
  /** Party ledgers, and our own accounts, that the vouchers name. */
  partyCount: number;
  ledgerCount: number;
  byType: VoucherTally[];
  /** Things worth saying before the file is imported. */
  warnings: string[];
  lastExport: { kind: 'masters' | 'vouchers'; to: string; at: string; by: string | null } | null;
  map: LedgerMapRow[];
}

export type TallyExportKind = 'masters' | 'vouchers';

/** The file name a download is offered under. */
export function tallyExportFileName(kind: TallyExportKind, from: string, to: string): string {
  return `tally-${kind}-${from}-to-${to}.xml`;
}
