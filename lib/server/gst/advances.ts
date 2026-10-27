import 'server-only';

// GST on advances for services, month by month.
//
// Tax is due when the advance arrives and is taken back when the advance is
// applied to an invoice that charges it. GSTR-1 reports the two separately:
// table 11A, advances received this month that no invoice has covered by the
// month's end; table 11B, advances from earlier months applied this month.
// An advance received and applied in the same month appears in neither, and
// GSTR-3B carries the difference.

import { sql } from 'kysely';
import type { Executor } from '../db';
import type { Paise } from '../../types';
import { toPaiseFromSql } from '../money-sql';
import type { Period } from './returns';

export interface AdvanceRow {
  pos: string;
  /** INTRA when the place of supply is the branch's own state. */
  supplyType: 'INTRA' | 'INTER';
  ratePct: number;
  /** The advance without its tax. */
  taxablePaise: Paise;
  cgstPaise: Paise;
  sgstPaise: Paise;
  igstPaise: Paise;
}

export interface AdvancesForMonth {
  /** Table 11A: received this month, not yet covered by an invoice at month end. */
  received: AdvanceRow[];
  /** Table 11B: received earlier, applied to invoices this month. */
  adjusted: AdvanceRow[];
  /** Tax heads to add to the month's output tax (11A less 11B). */
  net: { taxablePaise: Paise; cgstPaise: Paise; sgstPaise: Paise; igstPaise: Paise };
}

function group(rows: { pos: string; branch_state: string; rate: string; amount: string; cgst: string; sgst: string; igst: string }[], sign = 1) {
  const out = new Map<string, AdvanceRow>();
  for (const r of rows) {
    const supplyType = r.pos === r.branch_state ? 'INTRA' : 'INTER';
    const key = `${r.pos}|${supplyType}|${Number(r.rate)}`;
    const cgst = toPaiseFromSql(r.cgst), sgst = toPaiseFromSql(r.sgst), igst = toPaiseFromSql(r.igst);
    const taxable = toPaiseFromSql(r.amount) - cgst - sgst - igst;
    const row = out.get(key) ?? { pos: r.pos, supplyType, ratePct: Number(r.rate), taxablePaise: 0, cgstPaise: 0, sgstPaise: 0, igstPaise: 0 };
    row.taxablePaise += sign * taxable;
    row.cgstPaise += sign * cgst;
    row.sgstPaise += sign * sgst;
    row.igstPaise += sign * igst;
    out.set(key, row);
  }
  return out;
}

export async function advancesForMonth(ex: Executor, orgId: number, period: Period, branchId?: number): Promise<AdvancesForMonth> {
  const branch = branchId ? sql`AND p.branch_id = ${branchId}` : sql``;

  const [receivedRes, sameMonthRes, earlierRes] = await Promise.all([
    // Every taxed advance that arrived this month.
    sql<{ pos: string; branch_state: string; rate: string; amount: string; cgst: string; sgst: string; igst: string }>`
      SELECT p.advance_pos AS pos, b.state_code AS branch_state, p.advance_rate_pct AS rate,
             p.advance_amount AS amount, p.advance_cgst AS cgst, p.advance_sgst AS sgst, p.advance_igst AS igst
        FROM payments p JOIN branches b ON b.id = p.branch_id
       WHERE p.org_id = ${orgId} AND p.advance_gst = 1 AND p.status <> 'void'
         AND p.payment_date BETWEEN ${period.from} AND ${period.to} ${branch}
    `.execute(ex),
    // The part of those applied before the month ended: never an advance at the return's date.
    sql<{ pos: string; branch_state: string; rate: string; amount: string; cgst: string; sgst: string; igst: string }>`
      SELECT p.advance_pos AS pos, b.state_code AS branch_state, p.advance_rate_pct AS rate,
             t.amount, t.cgst, t.sgst, t.igst
        FROM advance_tax_adjustments t
        JOIN payments p ON p.id = t.payment_id JOIN branches b ON b.id = p.branch_id
       WHERE t.org_id = ${orgId} AND t.reversed_at IS NULL AND p.status <> 'void'
         AND p.payment_date BETWEEN ${period.from} AND ${period.to}
         AND t.adjusted_on BETWEEN ${period.from} AND ${period.to} ${branch}
    `.execute(ex),
    // Advances from earlier months applied this month.
    sql<{ pos: string; branch_state: string; rate: string; amount: string; cgst: string; sgst: string; igst: string }>`
      SELECT p.advance_pos AS pos, b.state_code AS branch_state, p.advance_rate_pct AS rate,
             t.amount, t.cgst, t.sgst, t.igst
        FROM advance_tax_adjustments t
        JOIN payments p ON p.id = t.payment_id JOIN branches b ON b.id = p.branch_id
       WHERE t.org_id = ${orgId} AND t.reversed_at IS NULL AND p.status <> 'void'
         AND p.payment_date < ${period.from}
         AND t.adjusted_on BETWEEN ${period.from} AND ${period.to} ${branch}
    `.execute(ex),
  ]);

  const received = group(receivedRes.rows);
  for (const [key, row] of group(sameMonthRes.rows, -1)) {
    const r = received.get(key);
    if (!r) continue;
    r.taxablePaise += row.taxablePaise; r.cgstPaise += row.cgstPaise; r.sgstPaise += row.sgstPaise; r.igstPaise += row.igstPaise;
  }
  const live = (m: Map<string, AdvanceRow>) =>
    [...m.values()].filter((r) => r.taxablePaise !== 0 || r.cgstPaise + r.sgstPaise + r.igstPaise !== 0);
  const receivedRows = live(received);
  const adjustedRows = live(group(earlierRes.rows));

  const sum = (rows: AdvanceRow[], k: keyof Pick<AdvanceRow, 'taxablePaise' | 'cgstPaise' | 'sgstPaise' | 'igstPaise'>) =>
    rows.reduce((t, r) => t + r[k], 0);
  return {
    received: receivedRows,
    adjusted: adjustedRows,
    net: {
      taxablePaise: sum(receivedRows, 'taxablePaise') - sum(adjustedRows, 'taxablePaise'),
      cgstPaise: sum(receivedRows, 'cgstPaise') - sum(adjustedRows, 'cgstPaise'),
      sgstPaise: sum(receivedRows, 'sgstPaise') - sum(adjustedRows, 'sgstPaise'),
      igstPaise: sum(receivedRows, 'igstPaise') - sum(adjustedRows, 'igstPaise'),
    },
  };
}
