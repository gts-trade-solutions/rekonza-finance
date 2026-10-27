// ─────────────────────────────────────────────────────────────────────────────
// What the portal's Tally screens are given.
//
// Shared by the server that builds them and the pages that draw them. Money is
// integer paise; a balance is signed, positive for a debit, unless a field
// says it is already on its natural side.
// ─────────────────────────────────────────────────────────────────────────────

export interface TallyConnectorView {
  id: string;
  status: 'pending' | 'active' | 'revoked';
  machineName: string | null;
  connectorVersion: string | null;
  tallyVersion: string | null;
  tokenPrefix: string | null;
  pairedAt: string | null;
  lastSeenAt: string | null;
  lastError: string | null;
  companies: number;
}

export interface TallyCompanyView {
  id: string;
  name: string;
  gstin: string | null;
  stateName: string | null;
  booksFrom: string | null;
  fyFrom: string | null;
  asOf: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
  maintainsInventory: boolean;
  connectorName: string | null;
  connectorStatus: 'pending' | 'active' | 'revoked';
  ledgers: number;
  vouchers: number;
  stockItems: number;
  firstVoucherDate: string | null;
  lastVoucherDate: string | null;
}

export interface TallyOverview {
  connectors: TallyConnectorView[];
  companies: TallyCompanyView[];
  /** A pairing code waiting to be used, if one was made. The code itself is never shown again. */
  pendingCodeExpiresAt: string | null;
}

export interface TallyEntry {
  ledger: string;
  debitPaise: number;
  creditPaise: number;
}

export interface DayBookRow {
  id: string;
  date: string;
  voucherType: string;
  baseType: string;
  number: string | null;
  /** The party, or the first ledger when there is none. */
  particulars: string;
  /** What the particulars ledger moved by, on its side. Null when the voucher moves no money. */
  debitPaise: number | null;
  creditPaise: number | null;
  narration: string | null;
  isCancelled: boolean;
  isOptional: boolean;
  entries: TallyEntry[];
}

export interface DayBookView {
  from: string;
  to: string;
  rows: DayBookRow[];
  totalDebitPaise: number;
  totalCreditPaise: number;
  truncated: boolean;
}

export interface LedgerListRow {
  id: string;
  name: string;
  group: string;
  primaryGroup: string;
  openingPaise: number;
  closingPaise: number;
  gstin: string | null;
}

export interface LedgerListView {
  asOf: string | null;
  fyFrom: string;
  rows: LedgerListRow[];
}

export interface LedgerVoucherRow {
  voucherId: string;
  date: string;
  /** The ledger on the other side, and how many more there are. */
  particulars: string;
  others: number;
  voucherType: string;
  number: string | null;
  debitPaise: number;
  creditPaise: number;
  balancePaise: number;
  narration: string | null;
}

export interface LedgerVouchersView {
  ledger: { id: string; name: string; group: string; primaryGroup: string; revenue: boolean };
  from: string;
  to: string;
  openingPaise: number;
  rows: LedgerVoucherRow[];
  totalDebitPaise: number;
  totalCreditPaise: number;
  closingPaise: number;
  truncated: boolean;
  /**
   * The balance worked out from the vouchers held here, against the one Tally
   * reported on its last sync. They differ when vouchers have not all arrived.
   */
  check: { asOf: string; tallyPaise: number; fromVouchersPaise: number; matches: boolean } | null;
}

export interface TrialBalanceNode {
  name: string;
  kind: 'group' | 'ledger';
  ledgerId?: string;
  debitPaise: number;
  creditPaise: number;
  children: TrialBalanceNode[];
}

export interface TrialBalanceView {
  asOf: string | null;
  rows: TrialBalanceNode[];
  totalDebitPaise: number;
  totalCreditPaise: number;
  differencePaise: number;
}

/** A line of a final account, on its own side: always the amount as that side reads it. */
export interface FinalLine {
  name: string;
  amountPaise: number;
  ledgerId?: string;
  children: FinalLine[];
}

export interface ProfitAndLossView {
  fyFrom: string;
  asOf: string | null;
  trading: { debit: FinalLine[]; credit: FinalLine[]; totalPaise: number };
  /** Negative is a gross loss. */
  grossProfitPaise: number;
  profitAndLoss: { debit: FinalLine[]; credit: FinalLine[]; totalPaise: number };
  /** Negative is a net loss. */
  netProfitPaise: number;
  stock: { openingPaise: number; closingPaise: number; from: 'stock items' | 'stock ledgers' };
}

export interface BalanceSheetView {
  asOf: string | null;
  liabilities: FinalLine[];
  assets: FinalLine[];
  totalLiabilitiesPaise: number;
  totalAssetsPaise: number;
  /** Tally's "Difference in opening balances". Zero when the books agree. */
  differencePaise: number;
}

export interface StockSummaryView {
  asOf: string | null;
  groups: {
    name: string;
    items: { id: string; name: string; unit: string | null; closingQty: number; ratePaise: number | null; closingValuePaise: number }[];
    totalValuePaise: number;
  }[];
  totalValuePaise: number;
}
