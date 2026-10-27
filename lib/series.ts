// ─────────────────────────────────────────────────────────────────────────────
// Document number series — per branch × doc type × fiscal year, gapless.
// GST rules: consecutive, ≤16 chars, alphanumeric plus '-' and '/'.
// ─────────────────────────────────────────────────────────────────────────────

import type { NumberSeriesState } from './types';

export type DocType =
  | 'INV' | 'EST' | 'SO' | 'DC' | 'CN' | 'RET'
  | 'BILL' | 'EXP' | 'PO' | 'VC'
  | 'PAY' | 'VPAY' | 'JRN';

const PREFIX: Record<DocType, string> = {
  INV: 'INV', EST: 'EST', SO: 'SO', DC: 'DC', CN: 'CN', RET: 'RET',
  BILL: 'BILL', EXP: 'EXP', PO: 'PO', VC: 'VC',
  PAY: 'PAY', VPAY: 'VPAY', JRN: 'JRN',
};

export function seriesKey(branchId: string, docType: DocType): string {
  return `${branchId}:${docType}`;
}

/** Format e.g. INV/26-27/0042 (kept ≤16 chars for GST compliance). */
export function formatDocNumber(docType: DocType, fyShort: string, n: number): string {
  return `${PREFIX[docType]}/${fyShort}/${String(n).padStart(4, '0')}`;
}

/**
 * The number a document *would* get, without consuming it. Forms show this so
 * the user sees the real number before saving, the way Zoho does.
 */
export function peekNumber(
  state: NumberSeriesState,
  branchId: string,
  docType: DocType,
  fyShort: string,
): string {
  return formatDocNumber(docType, fyShort, state[seriesKey(branchId, docType)] ?? 1);
}

/**
 * Allocate the next number. Pure function: returns the formatted number and the
 * updated series state (the store commits it atomically with the document).
 */
export function allocateNumber(
  state: NumberSeriesState,
  branchId: string,
  docType: DocType,
  fyShort: string, // '26-27'
): { number: string; nextState: NumberSeriesState } {
  const key = seriesKey(branchId, docType);
  const current = state[key] ?? 1;
  return {
    number: formatDocNumber(docType, fyShort, current),
    nextState: { ...state, [key]: current + 1 },
  };
}
