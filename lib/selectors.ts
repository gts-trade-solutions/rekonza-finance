// ─────────────────────────────────────────────────────────────────────────────
// Derived views over store state. Pure functions — used by dashboard, reports
// and list screens so numbers can never disagree between screens.
// ─────────────────────────────────────────────────────────────────────────────

import type { AppState } from './store';
import type { Bill, Contact, Invoice, Paise } from './types';
import { ageingBucket } from './ledger/reports';

/**
 * Today, as a yyyy-mm-dd string in the user's own timezone.
 *
 * This used to return a frozen date — the demo book's "today" — so that the
 * seeded invoices always looked like they had been raised last week. With real
 * organisations in the database that constant became a bug with teeth: it is
 * what every document form offers as the date, so a business signing up would
 * have had its first invoice stamped weeks in the past, and every "overdue"
 * on the dashboard measured against a day that had already gone.
 *
 * Built from the local parts rather than toISOString(), which is UTC: between
 * midnight and half past five in the morning IST those disagree, and dating a
 * tax invoice to yesterday is not a rounding error.
 */
export const today = (): string => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

export function contactName(s: AppState, id: string | null | undefined): string {
  if (!id) return '—';
  return s.contacts.find((c) => c.id === id)?.displayName ?? '—';
}

export function customers(s: AppState): Contact[] {
  return s.contacts.filter((c) => c.kind === 'customer' || c.kind === 'both');
}

export function vendors(s: AppState): Contact[] {
  return s.contacts.filter((c) => c.kind === 'vendor' || c.kind === 'both');
}

export function invoiceBalance(i: Invoice): Paise {
  return i.totalPaise - i.amountPaidPaise;
}

export function billBalance(b: Bill): Paise {
  return b.totalPaise - b.amountPaidPaise;
}

/** Live status — 'overdue' is derived, never stale. */
export function effectiveInvoiceStatus(i: Invoice, asOf = today()): Invoice['status'] {
  if (i.status === 'void' || i.status === 'paid' || i.status === 'draft' || i.status === 'written_off') return i.status;
  if (invoiceBalance(i) > 0 && i.dueDate < asOf) return 'overdue';
  return i.status;
}

export function openInvoices(s: AppState): Invoice[] {
  return s.invoices.filter((i) => i.status !== 'void' && i.status !== 'draft' && invoiceBalance(i) > 0);
}

export function openBills(s: AppState): Bill[] {
  return s.bills.filter((b) => b.status !== 'void' && b.status !== 'draft' && billBalance(b) > 0);
}

export function totalReceivable(s: AppState): Paise {
  return openInvoices(s).reduce((t, i) => t + invoiceBalance(i), 0);
}

export function totalPayable(s: AppState): Paise {
  return openBills(s).reduce((t, b) => t + billBalance(b), 0);
}

export function overdueReceivable(s: AppState, asOf = today()): Paise {
  return openInvoices(s).filter((i) => i.dueDate < asOf).reduce((t, i) => t + invoiceBalance(i), 0);
}

/** Bank/cash position straight from the ledger (never a stored number). */
export function cashPosition(s: AppState): { accountId: string; name: string; balance: Paise }[] {
  return s.bankAccounts.map((b) => {
    const balance = s.entries
      .flatMap((e) => e.lines)
      .filter((l) => l.accountId === b.ledgerAccountId)
      .reduce((t, l) => t + l.debit - l.credit, 0);
    return { accountId: b.id, name: b.name, balance };
  });
}

export function totalCash(s: AppState): Paise {
  return cashPosition(s)
    .filter((c) => {
      const acc = s.bankAccounts.find((b) => b.id === c.accountId);
      return acc?.kind !== 'card';
    })
    .reduce((t, c) => t + c.balance, 0);
}

export interface AgeingRow {
  contactId: string;
  name: string;
  buckets: Record<string, Paise>;
  total: Paise;
}

export function receivablesAgeing(s: AppState, asOf = today()): AgeingRow[] {
  const map = new Map<string, AgeingRow>();
  for (const inv of openInvoices(s)) {
    const bucket = ageingBucket(inv.dueDate, asOf);
    const row = map.get(inv.customerId) ?? {
      contactId: inv.customerId,
      name: contactName(s, inv.customerId),
      buckets: {},
      total: 0,
    };
    row.buckets[bucket] = (row.buckets[bucket] ?? 0) + invoiceBalance(inv);
    row.total += invoiceBalance(inv);
    map.set(inv.customerId, row);
  }
  return [...map.values()].sort((a, b) => b.total - a.total);
}

export function payablesAgeing(s: AppState, asOf = today()): AgeingRow[] {
  const map = new Map<string, AgeingRow>();
  for (const bill of openBills(s)) {
    const bucket = ageingBucket(bill.dueDate, asOf);
    const row = map.get(bill.vendorId) ?? {
      contactId: bill.vendorId,
      name: contactName(s, bill.vendorId),
      buckets: {},
      total: 0,
    };
    row.buckets[bucket] = (row.buckets[bucket] ?? 0) + billBalance(bill);
    row.total += billBalance(bill);
    map.set(bill.vendorId, row);
  }
  return [...map.values()].sort((a, b) => b.total - a.total);
}

/** MSME bills nearing/past the statutory 45-day payment limit (Sec 43B(h)). */
export function msmeTracker(s: AppState, asOf = today()) {
  return s.bills
    .filter((b) => {
      const v = s.contacts.find((c) => c.id === b.vendorId);
      return v?.isMsme && b.status !== 'void' && billBalance(b) > 0;
    })
    .map((b) => {
      const age = Math.floor((new Date(asOf).getTime() - new Date(b.date).getTime()) / 86_400_000);
      return {
        bill: b,
        vendorName: contactName(s, b.vendorId),
        age,
        daysLeft: 45 - age,
        risk: age >= 45 ? ('breached' as const) : age >= 38 ? ('critical' as const) : ('ok' as const),
      };
    })
    .sort((a, b) => a.daysLeft - b.daysLeft);
}

/** Monthly sales/expense series for dashboard charts. */
export function monthlySeries(s: AppState, months = 6) {
  const out: { month: string; sales: number; expenses: number }[] = [];
  const base = new Date(today());
  for (let k = months - 1; k >= 0; k--) {
    const d = new Date(base.getFullYear(), base.getMonth() - k, 1);
    const prefix = d.toISOString().slice(0, 7);
    const label = d.toLocaleDateString('en-IN', { month: 'short' });
    const sales = s.invoices
      .filter((i) => i.status !== 'void' && i.date.startsWith(prefix))
      .reduce((t, i) => t + i.subtotalPaise, 0);
    const purchaseExp = s.bills
      .filter((b) => b.status !== 'void' && b.date.startsWith(prefix))
      .reduce((t, b) => t + b.subtotalPaise, 0);
    const directExp = s.expenses
      .filter((e) => e.status !== 'void' && e.date.startsWith(prefix))
      .reduce((t, e) => t + e.tax.taxablePaise, 0);
    out.push({ month: label, sales: sales / 100, expenses: (purchaseExp + directExp) / 100 });
  }
  return out;
}

/** Live stock on hand per item (from stock moves). */
export function stockOnHand(s: AppState): { itemId: string; name: string; sku: string; qty: number; valuePaise: Paise; reorderLevel: number }[] {
  return s.items
    .filter((i) => i.trackInventory)
    .map((item) => {
      const moves = s.stockMoves.filter((m) => m.itemId === item.id);
      const purchased = moves.reduce((t, m) => t + m.qty, 0);
      const sold = s.invoices
        .filter((i) => i.status !== 'void' && i.status !== 'draft')
        .flatMap((i) => i.lines)
        .filter((l) => l.itemId === item.id)
        .reduce((t, l) => t + l.qty, 0);
      const received = s.bills
        .filter((b) => b.status !== 'void')
        .flatMap((b) => b.lines)
        .filter((l) => l.itemId === item.id)
        .reduce((t, l) => t + l.qty, 0);
      const qty = purchased + received - sold;
      return {
        itemId: item.id,
        name: item.name,
        sku: item.sku,
        qty,
        valuePaise: qty * item.purchasePricePaise,
        reorderLevel: item.reorderLevel ?? 0,
      };
    });
}
