'use client';

// The browser's side of the Tally screens. The connector talks to its own two
// endpoints, /api/tally/pair and /api/tally/sync, and never through this.

import { api } from './client';
import type {
  BalanceSheetView, DayBookView, LedgerListView, LedgerVouchersView, ProfitAndLossView, StockSummaryView,
  TallyOverview, TrialBalanceView,
} from '../tally/views';
import type { LedgerMapRow, TallyExportKind, TallyExportSummary } from '../tally/export';

export type * from '../tally/views';
export type * from '../tally/export';

const view = <T,>(companyId: string, v: string, params: Record<string, string | undefined> = {}) =>
  api.get<T>(`/api/tally/companies/${companyId}`, { view: v, ...params });

export const tally = {
  overview: () => api.get<TallyOverview>('/api/tally'),
  createPairingCode: () =>
    api.post<{ code: string; expiresAt: string; minutes: number }>('/api/tally', { action: 'create-pairing-code' }),
  revoke: (connectorId: string) => api.post<{ ok: true }>('/api/tally', { action: 'revoke', connectorId }),

  dayBook: (companyId: string, from: string, to: string) => view<DayBookView>(companyId, 'day-book', { from, to }),
  ledgers: (companyId: string) => view<LedgerListView>(companyId, 'ledgers'),
  ledger: (companyId: string, ledgerId: string, from: string, to: string) =>
    view<LedgerVouchersView>(companyId, 'ledger', { ledgerId, from, to }),
  trialBalance: (companyId: string) => view<TrialBalanceView>(companyId, 'trial-balance'),
  profitAndLoss: (companyId: string) => view<ProfitAndLossView>(companyId, 'profit-loss'),
  balanceSheet: (companyId: string) => view<BalanceSheetView>(companyId, 'balance-sheet'),
  stock: (companyId: string) => view<StockSummaryView>(companyId, 'stock'),

  // ── Sending our own books the other way, into Tally ──
  exportSummary: (from: string, to: string, branchId?: string) =>
    api.get<TallyExportSummary>('/api/tally/export', { view: 'summary', from, to, branchId }),
  /** The address of a file; the browser downloads it rather than reading it. */
  exportFile: (kind: TallyExportKind, from: string, to: string, branchId?: string) => {
    const params = new URLSearchParams({ view: kind, from, to, ...(branchId ? { branchId } : {}) });
    return `/api/tally/export?${params}`;
  },
  saveLedgerNames: (rows: Pick<LedgerMapRow, 'accountId' | 'ledgerName' | 'parentGroup'>[]) =>
    api.post<{ ok: true }>('/api/tally/export', { action: 'map', rows }),
  resetLedgerName: (accountId: string) => api.post<{ ok: true }>('/api/tally/export', { action: 'reset', accountId }),
};
