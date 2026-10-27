import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Pending orders: what has been promised and not yet completed.
//
// A sales order is done when every line is invoiced; until then each line has
// something left to deliver, to invoice, or both. A purchase order likewise,
// for receiving and billing. These are read off the lines' own running
// quantities, which the challans, invoices, goods receipts and bills move as
// they are raised (order-flow.ts), so the backlog is exact to the unit.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor } from '../db';
import type { Paise } from '../../types';
import { toPaiseFromSql } from '../money-sql';

export interface PendingLine {
  lineId: string;
  description: string;
  uqc: string | null;
  ordered: number;
  /** Delivered (sales) or received (purchases). */
  moved: number;
  /** Invoiced (sales) or billed (purchases). */
  settled: number;
  toMove: number;
  toSettle: number;
  /** The value still to be invoiced or billed, before tax. */
  pendingPaise: Paise;
}

export interface PendingOrder {
  id: string;
  number: string;
  partyName: string;
  date: string;
  expectedDate: string | null;
  overdue: boolean;
  status: string;
  lines: PendingLine[];
  pendingPaise: Paise;
}

const value = (rate: string, qty: number, discountPct: string) =>
  Math.round(toPaiseFromSql(rate) * qty * (1 - Number(discountPct) / 100));

function group(rows: {
  id: number; number: string; party: string; date: string; expected: string | null; status: string;
  line_id: number; description: string | null; uqc: string | null; qty: string; moved: string; settled: string;
  rate: string; discount_pct: string;
}[], asOf: string): PendingOrder[] {
  const by = new Map<number, PendingOrder>();
  for (const r of rows) {
    const ordered = Number(r.qty);
    const moved = Number(r.moved);
    const settled = Number(r.settled);
    const toSettle = Math.max(0, ordered - settled);
    if (toSettle <= 0) continue;
    const o = by.get(r.id) ?? {
      id: String(r.id), number: r.number, partyName: r.party, date: String(r.date).slice(0, 10),
      expectedDate: r.expected ? String(r.expected).slice(0, 10) : null, overdue: false, status: r.status, lines: [], pendingPaise: 0,
    };
    const pending = value(r.rate, toSettle, r.discount_pct);
    o.lines.push({
      lineId: String(r.line_id), description: r.description ?? '', uqc: r.uqc, ordered, moved, settled,
      toMove: Math.max(0, ordered - moved), toSettle, pendingPaise: pending,
    });
    o.pendingPaise += pending;
    o.overdue = !!o.expectedDate && o.expectedDate < asOf && o.lines.some((l) => l.toMove > 0);
    by.set(r.id, o);
  }
  return [...by.values()].sort((a, b) => Number(b.overdue) - Number(a.overdue) || a.date.localeCompare(b.date));
}

export async function pendingSalesOrders(ex: Executor, orgId: number, asOf: string, branchId?: number) {
  const { rows } = await sql<Parameters<typeof group>[0][number]>`
    SELECT o.id, o.number, c.display_name AS party, o.order_date AS date, o.expected_ship_date AS expected, o.status,
           l.id AS line_id, l.description, l.uqc, l.qty, l.qty_delivered AS moved, l.qty_invoiced AS settled,
           l.rate, l.discount_pct
      FROM sales_order_lines l
      JOIN sales_orders o ON o.id = l.sales_order_id
      JOIN contacts c ON c.id = o.customer_id
     WHERE o.org_id = ${orgId} AND o.status NOT IN ('cancelled', 'closed', 'invoiced')
       AND o.order_date <= ${asOf} ${branchId ? sql`AND o.branch_id = ${branchId}` : sql``}
     ORDER BY o.order_date, o.id, l.line_no
  `.execute(ex);
  const orders = group(rows, asOf);
  return {
    asOf, orders,
    totalPendingPaise: orders.reduce((t, o) => t + o.pendingPaise, 0),
    overdue: orders.filter((o) => o.overdue).length,
  };
}

export async function pendingPurchaseOrders(ex: Executor, orgId: number, asOf: string, branchId?: number) {
  const { rows } = await sql<Parameters<typeof group>[0][number]>`
    SELECT o.id, o.number, c.display_name AS party, o.order_date AS date, o.expected_date AS expected, o.status,
           l.id AS line_id, l.description, l.uqc, l.qty, l.qty_received AS moved, l.qty_billed AS settled,
           l.rate, l.discount_pct
      FROM purchase_order_lines l
      JOIN purchase_orders o ON o.id = l.purchase_order_id
      JOIN contacts c ON c.id = o.vendor_id
     WHERE o.org_id = ${orgId} AND o.status NOT IN ('draft', 'cancelled', 'closed', 'billed')
       AND o.order_date <= ${asOf} ${branchId ? sql`AND o.branch_id = ${branchId}` : sql``}
     ORDER BY o.order_date, o.id, l.line_no
  `.execute(ex);
  const orders = group(rows, asOf);
  return {
    asOf, orders,
    totalPendingPaise: orders.reduce((t, o) => t + o.pendingPaise, 0),
    overdue: orders.filter((o) => o.overdue).length,
  };
}
