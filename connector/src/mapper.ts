// ─────────────────────────────────────────────────────────────────────────────
// Tally's rows, turned into what the portal accepts.
//
// All the converting happens here, once, so the portal never has to know how
// Tally writes anything:
//
//   money      Tally's signed rupees, debits negative, become integer paise
//              with debits positive
//   nature     a group's IsRevenue and IsDeemedPositive become assets,
//              liabilities, income or expenses
//   types      a company's own voucher type ("GST Sales") is followed up to
//              the one Tally ships with ("Sales")
//   the year   the start of the current financial year, from the day the
//              company's year begins
//
// Pure functions, so every rule is tested without Tally running.
// ─────────────────────────────────────────────────────────────────────────────

import type { TallyNature, TallyVoucher } from '../../lib/tally/protocol';

/** Signed rupees as Tally writes them — debits negative — to paise with debits positive. */
export function debitPaise(value: string | null): number {
  if (!value) return 0;
  const n = Number(value.replace(/,/g, ''));
  if (!Number.isFinite(n)) return 0;
  // Rounded before the sign turns, so -0.005 and 0.005 land on the same paisa.
  const paise = Math.round(Math.abs(n) * 100);
  return n < 0 ? paise : -paise;
}

export const quantity = (value: string | null): number => {
  const n = Number((value ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
};

export const yes = (value: string | null): boolean => value === '1' || value?.toLowerCase() === 'yes';

export function natureOf(isRevenue: boolean, isDeemedPositive: boolean): TallyNature {
  if (isRevenue) return isDeemedPositive ? 'expenses' : 'income';
  return isDeemedPositive ? 'assets' : 'liabilities';
}

/** The voucher types Tally ships with. Every other type is based on one of these. */
export const PREDEFINED_VOUCHER_TYPES = new Set([
  'Attendance', 'Contra', 'Credit Note', 'Debit Note', 'Delivery Note', 'Job Work In Order', 'Job Work Out Order',
  'Journal', 'Material In', 'Material Out', 'Memorandum', 'Payment', 'Payroll', 'Physical Stock', 'Purchase',
  'Purchase Order', 'Receipt', 'Receipt Note', 'Rejections In', 'Rejections Out', 'Reversing Journal', 'Sales',
  'Sales Order', 'Stock Journal',
]);

export function baseTypeOf(typeName: string, parents: Map<string, string | null>): string {
  let at = typeName;
  for (let i = 0; i < 20; i++) {
    if (PREDEFINED_VOUCHER_TYPES.has(at)) return at;
    const parent = parents.get(at);
    if (!parent || parent === at) break;
    at = parent;
  }
  return typeName;
}

/** The first day of the financial year `today` is in, for a company whose year begins on `startingFrom`'s day. */
export function currentFyStart(startingFrom: string | null, today: string): string {
  const md = startingFrom ? startingFrom.slice(5) : '04-01';
  const year = Number(today.slice(0, 4));
  const candidate = `${year}-${md}`;
  return candidate <= today ? candidate : `${year - 1}-${md}`;
}

export const addDays = (iso: string, n: number): string =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** A period cut into calendar months, so a large company is read a piece at a time. */
export function months(from: string, to: string): { from: string; to: string }[] {
  const out: { from: string; to: string }[] = [];
  let start = from;
  while (start <= to) {
    const [y, m] = start.split('-').map(Number);
    const nextMonth = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
    const end = addDays(nextMonth, -1);
    out.push({ from: start, to: end < to ? end : to });
    start = nextMonth;
  }
  return out;
}

export interface VoucherRow {
  guid: string | null;
  alterId: string | null;
  type: string | null;
  date: string | null;
  number: string | null;
  party: string | null;
  narration: string | null;
  reference: string | null;
  cancelled: string | null;
  optional: string | null;
}

export interface EntryRow {
  guid: string | null;
  ledger: string | null;
  amount: string | null;
}

/** Vouchers with their entries, in the portal's shape. A row missing its GUID or date cannot be kept, and is dropped. */
export function toVouchers(rows: VoucherRow[], entryRows: EntryRow[], parents: Map<string, string | null>): TallyVoucher[] {
  const entries = new Map<string, { ledger: string; debitPaise: number; creditPaise: number }[]>();
  for (const e of entryRows) {
    if (!e.guid || !e.ledger) continue;
    const paise = debitPaise(e.amount);
    if (paise === 0) continue;
    const list = entries.get(e.guid) ?? [];
    list.push({ ledger: e.ledger, debitPaise: Math.max(paise, 0), creditPaise: Math.max(-paise, 0) });
    entries.set(e.guid, list);
  }
  const out: TallyVoucher[] = [];
  for (const r of rows) {
    if (!r.guid || !r.date || !r.type) continue;
    const cancelled = yes(r.cancelled);
    out.push({
      guid: r.guid,
      alterId: Math.max(0, Math.floor(quantity(r.alterId))),
      voucherType: r.type.slice(0, 100),
      baseType: baseTypeOf(r.type, parents).slice(0, 40),
      number: r.number?.slice(0, 100) ?? null,
      date: r.date.slice(0, 10),
      party: r.party?.slice(0, 200) ?? null,
      narration: r.narration?.slice(0, 1000) ?? null,
      reference: r.reference?.slice(0, 100) ?? null,
      isCancelled: cancelled,
      isOptional: yes(r.optional),
      entries: cancelled ? [] : (entries.get(r.guid) ?? []),
    });
  }
  return out;
}
