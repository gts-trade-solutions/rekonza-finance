// ─────────────────────────────────────────────────────────────────────────────
// Dashboard analytics.
//
// Everything here is derived — nothing is stored. These are deliberately kept
// out of selectors.ts because they answer *management* questions (how are we
// doing, versus what?) rather than *bookkeeping* questions (what is the balance
// of this account?). The two get read at different times by different people.
//
// A note on comparison periods: "vs previous" always means the immediately
// preceding window of the same length. Comparing August against July is only
// meaningful when both are full months, so the caller picks the window and this
// file just mirrors it backwards.
// ─────────────────────────────────────────────────────────────────────────────

import type { AppState } from './store';
import type { Paise } from './types';
import { contactName, invoiceBalance, billBalance, openInvoices, openBills, today } from './selectors';
import { AGEING_BUCKETS, ageingBucket } from './ledger/reports';

export interface Window {
  from: string;
  to: string;
}

/** The window of the same length immediately before `w`. */
export function previousWindow(w: Window): Window {
  const from = new Date(w.from);
  const to = new Date(w.to);
  const days = Math.max(1, Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1);
  const prevTo = new Date(from.getTime() - 86_400_000);
  const prevFrom = new Date(prevTo.getTime() - (days - 1) * 86_400_000);
  return { from: prevFrom.toISOString().slice(0, 10), to: prevTo.toISOString().slice(0, 10) };
}

const inWindow = (d: string, w: Window) => d >= w.from && d <= w.to;

/**
 * Percentage change, guarding the divide-by-zero that makes dashboards lie.
 * Returns null when there is no previous figure to compare against — showing
 * "+∞%" or a confident "+100%" against zero is worse than showing nothing.
 */
export function pctChange(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

// ── Sales performance ────────────────────────────────────────────────────────

export interface SalesPerformance {
  billed: Paise;
  collected: Paise;
  outstanding: Paise;
  invoiceCount: number;
  customerCount: number;
  avgInvoice: Paise;
  paid: number;
  partial: number;
  unpaid: number;
}

/**
 * Billed vs collected for a window.
 *
 * "Billed" is invoice totals dated in the window. "Collected" is cash actually
 * received in the window — which will not tie to billed, and should not: an
 * invoice raised in August may be collected in October. Conflating the two is
 * the most common way a sales dashboard misleads its reader.
 *
 * Draft invoices are excluded throughout, matching how every accounting package
 * treats them: a draft is not a document until it is issued.
 */
export function salesPerformance(s: AppState, w: Window): SalesPerformance {
  const issued = s.invoices.filter(
    (i) => i.status !== 'void' && i.status !== 'draft' && inWindow(i.date, w),
  );

  const billed = issued.reduce((t, i) => t + i.totalPaise, 0);
  const outstanding = issued.reduce((t, i) => t + invoiceBalance(i), 0);

  const collected = s.payments
    .filter((p) => p.kind === 'received' && p.status !== 'void' && inWindow(p.date, w))
    .reduce((t, p) => t + p.amountPaise, 0);

  let paid = 0;
  let partial = 0;
  let unpaid = 0;
  for (const i of issued) {
    const bal = invoiceBalance(i);
    if (bal <= 0) paid++;
    else if (i.amountPaidPaise > 0) partial++;
    else unpaid++;
  }

  const customerCount = new Set(issued.map((i) => i.customerId)).size;

  return {
    billed,
    collected,
    outstanding,
    invoiceCount: issued.length,
    customerCount,
    avgInvoice: issued.length ? Math.round(billed / issued.length) : 0,
    paid,
    partial,
    unpaid,
  };
}

/** Billed against collected, month by month — the shape of the cash gap. */
export function billedVsCollected(s: AppState, months = 6) {
  const out: { month: string; billed: number; collected: number }[] = [];
  const base = new Date(today());
  for (let k = months - 1; k >= 0; k--) {
    const d = new Date(base.getFullYear(), base.getMonth() - k, 1);
    const prefix = d.toISOString().slice(0, 7);
    const billed = s.invoices
      .filter((i) => i.status !== 'void' && i.status !== 'draft' && i.date.startsWith(prefix))
      .reduce((t, i) => t + i.totalPaise, 0);
    const collected = s.payments
      .filter((p) => p.kind === 'received' && p.status !== 'void' && p.date.startsWith(prefix))
      .reduce((t, p) => t + p.amountPaise, 0);
    out.push({
      month: d.toLocaleDateString('en-IN', { month: 'short', year: '2-digit' }),
      billed: billed / 100,
      collected: collected / 100,
    });
  }
  return out;
}

// ── Goods vs services ────────────────────────────────────────────────────────

export interface RevenueSplitRow {
  key: 'goods' | 'service';
  label: string;
  value: Paise;
  lines: number;
}

/**
 * Revenue split by what was actually sold.
 *
 * Resolved from the item behind each line where there is one, and from the code
 * otherwise — a SAC always begins 99, an HSN never does. That fallback matters
 * because ad-hoc lines (a one-off delivery charge, say) carry a code but no
 * catalogue item.
 */
export function goodsVsServices(s: AppState, w: Window): RevenueSplitRow[] {
  const totals: Record<'goods' | 'service', { value: Paise; lines: number }> = {
    goods: { value: 0, lines: 0 },
    service: { value: 0, lines: 0 },
  };

  for (const inv of s.invoices) {
    if (inv.status === 'void' || inv.status === 'draft' || !inWindow(inv.date, w)) continue;
    for (const l of inv.lines) {
      const item = s.items.find((i) => i.id === l.itemId);
      const kind: 'goods' | 'service' = item
        ? item.kind === 'service'
          ? 'service'
          : 'goods'
        : l.hsnSac.startsWith('99')
          ? 'service'
          : 'goods';
      totals[kind].value += l.tax.taxablePaise;
      totals[kind].lines += 1;
    }
  }

  return [
    { key: 'goods', label: 'Goods', value: totals.goods.value, lines: totals.goods.lines },
    { key: 'service', label: 'Services', value: totals.service.value, lines: totals.service.lines },
  ];
}

// ── Gross margin ─────────────────────────────────────────────────────────────

export interface GrossMargin {
  revenue: Paise;
  cogs: Paise;
  gross: Paise;
  marginPct: number;
  units: number;
  /** Lines whose item has no purchase price on file, so cost is understated. */
  linesWithoutCost: number;
}

/**
 * Indicative gross margin: revenue less the purchase price of what was sold.
 *
 * IMPORTANT — this does not tie to the Profit and Loss, and is not meant to.
 * A true cost of goods sold requires perpetual inventory valuation, which this
 * build does not post (purchases are expensed when billed). What this gives you
 * is the trading margin implied by the catalogue's cost prices — useful for
 * pricing decisions, not for filing. It is shown to owners only for that reason.
 */
export function grossMargin(s: AppState, w: Window): GrossMargin {
  let revenue = 0;
  let cogs = 0;
  let units = 0;
  let linesWithoutCost = 0;

  for (const inv of s.invoices) {
    if (inv.status === 'void' || inv.status === 'draft' || !inWindow(inv.date, w)) continue;
    for (const l of inv.lines) {
      revenue += l.tax.taxablePaise;
      const item = s.items.find((i) => i.id === l.itemId);
      if (item && item.purchasePricePaise > 0) {
        cogs += Math.round(item.purchasePricePaise * l.qty);
        units += l.qty;
      } else if (item?.kind === 'service') {
        // Services have no purchase cost by nature — not a data gap.
        units += l.qty;
      } else {
        linesWithoutCost += 1;
        units += l.qty;
      }
    }
  }

  const gross = revenue - cogs;
  return {
    revenue,
    cogs,
    gross,
    marginPct: revenue > 0 ? (gross / revenue) * 100 : 0,
    units: Math.round(units),
    linesWithoutCost,
  };
}

// ── Ageing, as buckets rather than per-party ─────────────────────────────────

export interface BucketRow {
  bucket: string;
  value: Paise;
  pct: number;
  count: number;
}

function bucketise(
  rows: { dueDate: string; balance: Paise }[],
  asOf: string,
): BucketRow[] {
  const totals: Record<string, { value: Paise; count: number }> = {};
  for (const b of AGEING_BUCKETS) totals[b] = { value: 0, count: 0 };
  for (const r of rows) {
    const b = ageingBucket(r.dueDate, asOf);
    totals[b].value += r.balance;
    totals[b].count += 1;
  }
  const grand = Object.values(totals).reduce((t, v) => t + v.value, 0);
  return AGEING_BUCKETS.map((b) => ({
    bucket: b,
    value: totals[b].value,
    count: totals[b].count,
    pct: grand > 0 ? (totals[b].value / grand) * 100 : 0,
  }));
}

/** Receivables split into age buckets, with each bucket's share of the total. */
export function receivableBuckets(s: AppState, asOf = today()): BucketRow[] {
  return bucketise(
    openInvoices(s).map((i) => ({ dueDate: i.dueDate, balance: invoiceBalance(i) })),
    asOf,
  );
}

/** Payables split the same way, so the two can be read side by side. */
export function payableBuckets(s: AppState, asOf = today()): BucketRow[] {
  return bucketise(
    openBills(s).map((b) => ({ dueDate: b.dueDate, balance: billBalance(b) })),
    asOf,
  );
}

// ── Top parties ──────────────────────────────────────────────────────────────

export interface PartyRow {
  contactId: string;
  name: string;
  value: Paise;
  overdue: Paise;
  pct: number;
  count: number;
}

function topParties(
  rows: { contactId: string; balance: Paise; dueDate: string }[],
  s: AppState,
  asOf: string,
  limit: number,
): PartyRow[] {
  const map = new Map<string, { value: Paise; overdue: Paise; count: number }>();
  for (const r of rows) {
    const cur = map.get(r.contactId) ?? { value: 0, overdue: 0, count: 0 };
    cur.value += r.balance;
    if (r.dueDate < asOf) cur.overdue += r.balance;
    cur.count += 1;
    map.set(r.contactId, cur);
  }
  const grand = [...map.values()].reduce((t, v) => t + v.value, 0);
  return [...map.entries()]
    .map(([contactId, v]) => ({
      contactId,
      name: contactName(s, contactId),
      value: v.value,
      overdue: v.overdue,
      count: v.count,
      pct: grand > 0 ? (v.value / grand) * 100 : 0,
    }))
    .sort((a, b) => b.value - a.value)
    .slice(0, limit);
}

/** Debtors — customers who owe us. Ranked by what is outstanding. */
export function topDebtors(s: AppState, limit = 6, asOf = today()): PartyRow[] {
  return topParties(
    openInvoices(s).map((i) => ({
      contactId: i.customerId,
      balance: invoiceBalance(i),
      dueDate: i.dueDate,
    })),
    s,
    asOf,
    limit,
  );
}

/** Creditors — suppliers we owe. The mirror image of the debtor list. */
export function topCreditors(s: AppState, limit = 6, asOf = today()): PartyRow[] {
  return topParties(
    openBills(s).map((b) => ({
      contactId: b.vendorId,
      balance: billBalance(b),
      dueDate: b.dueDate,
    })),
    s,
    asOf,
    limit,
  );
}
