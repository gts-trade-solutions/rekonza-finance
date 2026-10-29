// What each kind of exception is called and which part of the business it
// belongs to: shared by the scheduler that raises them (lib/server/services/
// exceptions.ts) and the screens that show them.

export type ExceptionKind =
  | 'irn_pending' | 'irn_failed'
  | 'receivable_overdue' | 'credit_limit' | 'concentration'
  | 'bill_due' | 'bill_overdue' | 'msme_due'
  | 'bank_unreconciled' | 'stock_below_min' | 'master_data' | 'system_errors' | 'document_expiring';

export type ExceptionSeverity = 'low' | 'medium' | 'high' | 'critical';
export type ExceptionStatus = 'open' | 'in_progress' | 'resolved' | 'waived';

export const EXCEPTION_KINDS: Record<ExceptionKind, { label: string; area: string }> = {
  irn_pending: { label: 'IRN not generated', area: 'GST' },
  irn_failed: { label: 'IRN refused', area: 'GST' },
  receivable_overdue: { label: 'Customer overdue', area: 'Receivables' },
  credit_limit: { label: 'Over credit limit', area: 'Receivables' },
  concentration: { label: 'Customer concentration', area: 'Receivables' },
  bill_due: { label: 'Bill falling due', area: 'Payables' },
  bill_overdue: { label: 'Bill overdue', area: 'Payables' },
  msme_due: { label: 'MSME 45-day limit', area: 'Payables' },
  bank_unreconciled: { label: 'Bank lines unreconciled', area: 'Banking' },
  stock_below_min: { label: 'Stock below minimum', area: 'Inventory' },
  master_data: { label: 'Master data', area: 'Data quality' },
  system_errors: { label: 'System errors', area: 'System' },
  document_expiring: { label: 'Document expiring', area: 'Documents' },
};

export const SEVERITY_RANK: Record<ExceptionSeverity, number> = { low: 0, medium: 1, high: 2, critical: 3 };
