import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// When the credit on a bill is taken: the decisions made after matching it
// with GSTR-2B (gst_itc_claims, migration 133).
//
// Since 1 January 2022 a buyer may take credit only on what the supplier has
// furnished and GSTR-2B shows (CGST Act s.16(2)(aa), Rule 36(4)). So a bill
// the supplier has not filed yet, or filed with other figures, is not claimed
// in the month it is booked. The book records, bill by bill:
//
//   accept       claim it in the bill's own month (the default: no row);
//   defer        hold it back until the supplier files — not claimed at all
//                until the decision changes;
//   claim later  claim it in a named later month, the one whose 2B carries it
//                (within the time s.16(4) allows: 30 November after the end
//                of the financial year).
//
// GSTR-3B table 4(A)(5) follows these decisions (gstr3b-form.ts, returns.ts),
// and GSTR-9 shows a year's credit claimed in the next (8C, 13). The books
// still carry the input tax from the bill's date; the GSTR-3B tie-out names
// the decisions as the reason the ledger and the return differ.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor, Trx } from '../db';
import type { Paise } from '../../types';
import { toPaiseFromSql } from '../money-sql';
import { badRequest, notFound } from '../http';
import { monthLabel } from '../../date-range';

export type ClaimDecision = 'accept' | 'defer' | 'claim_later';

export interface ClaimShift {
  billId: number;
  number: string;
  vendorInvoiceNo: string | null;
  billDate: string;
  party: string;
  gstin: string | null;
  /** out: credit of a bill of this period held back; in: credit of an earlier bill claimed in this period. */
  direction: 'out' | 'in';
  decision: ClaimDecision;
  claimPeriod: string | null;
  igstPaise: Paise; cgstPaise: Paise; sgstPaise: Paise; cessPaise: Paise;
}

const day = (v: unknown) => String(v instanceof Date ? new Date(v.getTime() - v.getTimezoneOffset() * 60_000).toISOString() : v).slice(0, 10);

/**
 * The credit moved by claim decisions into or out of a return period (one
 * month, or the months of a quarter). Only forward-charge bills: credit on
 * reverse charge is self-assessed and not matched with 2B.
 */
export async function claimShifts(ex: Executor, orgId: number, months: string[], branchId?: number): Promise<ClaimShift[]> {
  if (!months.length) return [];
  const first = months[0];
  const last = months[months.length - 1];
  const from = `${first}-01`;
  // The month's real last day: "2026-11-31" is no date, and MySQL compares a DATE
  // against it as nothing at all, so a deferral in a 30-day month (or February)
  // silently moved no credit.
  const [ly, lm] = last.split('-').map(Number);
  const to = new Date(Date.UTC(ly, lm, 0)).toISOString().slice(0, 10);
  const { rows } = await sql<{
    bill_id: number; number: string; vendor_invoice_no: string | null; bill_date: string; party: string; gstin: string | null;
    decision: ClaimDecision; claim_period: string | null; igst: string; cgst: string; sgst: string; cess: string;
  }>`
    SELECT b.id AS bill_id, b.internal_no AS number, b.vendor_invoice_no, b.bill_date, c.display_name AS party, NULLIF(c.gstin, '') AS gstin,
           g.decision, g.claim_period,
           COALESCE(SUM(bl.igst), 0) AS igst, COALESCE(SUM(bl.cgst), 0) AS cgst, COALESCE(SUM(bl.sgst), 0) AS sgst, COALESCE(SUM(bl.cess), 0) AS cess
      FROM gst_itc_claims g
      JOIN bills b ON b.id = g.bill_id AND b.org_id = g.org_id
      JOIN contacts c ON c.id = b.vendor_id
      JOIN bill_lines bl ON bl.bill_id = b.id AND bl.itc_eligibility IN ('eligible', 'capital_goods')
     WHERE g.org_id = ${orgId} AND g.decision IN ('defer', 'claim_later')
       AND b.status NOT IN ('draft', 'void') AND b.is_rcm = 0
       AND (b.bill_date BETWEEN ${from} AND ${to} OR (g.decision = 'claim_later' AND g.claim_period BETWEEN ${first} AND ${last}))
       ${branchId ? sql`AND b.branch_id = ${branchId}` : sql``}
     GROUP BY b.id, b.internal_no, b.vendor_invoice_no, b.bill_date, c.display_name, c.gstin, g.decision, g.claim_period
  `.execute(ex);
  const inPeriod = (m: string | null) => !!m && m >= first && m <= last;
  const out: ClaimShift[] = [];
  for (const r of rows) {
    const billMonth = day(r.bill_date).slice(0, 7);
    const ownPeriod = inPeriod(billMonth);
    const claimHere = r.decision === 'claim_later' && inPeriod(r.claim_period);
    // A bill claimed later within the same return (month 1 of a quarter, claimed in month 2) moves nothing.
    if (ownPeriod && claimHere) continue;
    const base = {
      billId: Number(r.bill_id), number: r.number, vendorInvoiceNo: r.vendor_invoice_no, billDate: day(r.bill_date), party: r.party, gstin: r.gstin,
      decision: r.decision, claimPeriod: r.claim_period,
      igstPaise: toPaiseFromSql(r.igst), cgstPaise: toPaiseFromSql(r.cgst), sgstPaise: toPaiseFromSql(r.sgst), cessPaise: toPaiseFromSql(r.cess),
    };
    if (ownPeriod) out.push({ ...base, direction: 'out' });
    else if (claimHere) out.push({ ...base, direction: 'in' });
  }
  return out.sort((a, b) => a.billDate.localeCompare(b.billDate));
}

/** The net credit claim decisions move into a period (claimed in less held back), by head. */
export function shiftTotal(shifts: ClaimShift[]) {
  const sign = (s: ClaimShift) => (s.direction === 'in' ? 1 : -1);
  return shifts.reduce((t, s) => ({
    igstPaise: t.igstPaise + sign(s) * s.igstPaise, cgstPaise: t.cgstPaise + sign(s) * s.cgstPaise,
    sgstPaise: t.sgstPaise + sign(s) * s.sgstPaise, cessPaise: t.cessPaise + sign(s) * s.cessPaise,
  }), { igstPaise: 0, cgstPaise: 0, sgstPaise: 0, cessPaise: 0 });
}

/** Every decision on record for a set of bills. */
export async function claimDecisions(ex: Executor, orgId: number, billIds: number[]) {
  if (!billIds.length) return new Map<number, { decision: ClaimDecision; claimPeriod: string | null; note: string | null; by: string | null; at: string }>();
  const rows = await ex.selectFrom('gst_itc_claims as g').leftJoin('users as u', 'u.id', 'g.decided_by_user_id')
    .select(['g.bill_id', 'g.decision', 'g.claim_period', 'g.note', 'u.name', 'g.decided_at'])
    .where('g.org_id', '=', orgId).where('g.bill_id', 'in', billIds).execute();
  return new Map(rows.map((r) => [Number(r.bill_id), {
    decision: r.decision, claimPeriod: r.claim_period, note: r.note, by: r.name ?? null,
    at: new Date(r.decided_at as unknown as string).toISOString(),
  }]));
}

/** The month a bill's credit counts in, given its filed GSTR-3B (none if held back). */
async function filedThreeB(ex: Executor, orgId: number, month: string) {
  const f = await ex.selectFrom('compliance_filings').select(['reference']).where('org_id', '=', orgId).where('item_key', '=', 'gstr3b')
    .where('period', 'in', [month, `${Number(month.slice(5)) >= 4 ? month.slice(0, 4) : Number(month.slice(0, 4)) - 1}-Q${Math.floor(((Number(month.slice(5)) + 8) % 12) / 3) + 1}`])
    .executeTakeFirst();
  return f;
}

/**
 * Record (or change) the decision on bills. `accept` takes the row away, so
 * the bill counts in its own month again. Refused where it would move credit
 * out of, or into, a GSTR-3B already marked filed: a filed return is not
 * revised; the credit is then claimed in the next one.
 */
export async function setClaimDecision(trx: Trx, orgId: number, userId: number | null, input: {
  billIds: number[]; decision: ClaimDecision; claimPeriod?: string | null; note?: string | null;
}) {
  if (!input.billIds.length) throw badRequest('Pick at least one bill.');
  if (input.decision === 'claim_later' && !/^\d{4}-\d{2}$/.test(input.claimPeriod ?? '')) throw badRequest('Say which month the credit is to be claimed in.');
  const bills = await trx.selectFrom('bills').select(['id', 'internal_no', 'bill_date', 'status', 'is_rcm'])
    .where('org_id', '=', orgId).where('id', 'in', input.billIds).forUpdate().execute();
  if (bills.length !== new Set(input.billIds).size) throw notFound('One of those bills is not in this book.');
  const existing = await claimDecisions(trx, orgId, input.billIds);
  let changed = 0;
  for (const b of bills) {
    if (b.status === 'draft' || b.status === 'void') throw badRequest(`${b.internal_no} is ${b.status}: it carries no credit.`);
    if (Number(b.is_rcm) === 1) throw badRequest(`${b.internal_no} is under reverse charge: its credit is self-assessed with the tax, not matched with GSTR-2B.`);
    const billMonth = day(b.bill_date).slice(0, 7);
    if (input.decision === 'claim_later') {
      if (input.claimPeriod! <= billMonth) throw badRequest(`Claim later means a month after ${monthLabel(billMonth)}, the month of ${b.internal_no}. To claim it in its own month, accept it.`);
      // Section 16(4): no later than 30 November after the end of the bill's financial year.
      const fy = Number(billMonth.slice(5)) >= 4 ? Number(billMonth.slice(0, 4)) : Number(billMonth.slice(0, 4)) - 1;
      if (input.claimPeriod! > `${fy + 1}-11`) throw badRequest(`Credit on ${b.internal_no} can be taken no later than November ${fy + 1} (section 16(4)).`);
      const f = await filedThreeB(trx, orgId, input.claimPeriod!);
      if (f) throw badRequest(`GSTR-3B for ${monthLabel(input.claimPeriod!)} is already filed${f.reference ? ` (ARN ${f.reference})` : ''}. Pick a month not yet filed.`);
    }
    // Moving credit out of the bill's own month changes that month's return.
    const prev = existing.get(b.id);
    const ownMonthCounted = !prev || prev.decision === 'accept';
    const ownMonthAfter = input.decision === 'accept';
    if (ownMonthCounted !== ownMonthAfter) {
      const f = await filedThreeB(trx, orgId, billMonth);
      if (f) throw badRequest(`GSTR-3B for ${monthLabel(billMonth)} is filed with ${b.internal_no} ${ownMonthCounted ? 'claimed' : 'held back'} in it. A filed return is not revised: decide for the next month's return instead.`);
    }
    if (prev?.decision === 'claim_later' && prev.claimPeriod && input.claimPeriod !== prev.claimPeriod) {
      const f = await filedThreeB(trx, orgId, prev.claimPeriod);
      if (f) throw badRequest(`${b.internal_no} was claimed in GSTR-3B for ${monthLabel(prev.claimPeriod)}, which is filed. It stays claimed there.`);
    }
    if (input.decision === 'accept') {
      const r = await trx.deleteFrom('gst_itc_claims').where('org_id', '=', orgId).where('bill_id', '=', b.id).executeTakeFirst();
      changed += Number(r.numDeletedRows ?? 0);
    } else {
      const values = { decision: input.decision, claim_period: input.decision === 'claim_later' ? input.claimPeriod! : null, note: input.note?.trim() || null, decided_by_user_id: userId };
      await trx.insertInto('gst_itc_claims').values({ org_id: orgId, bill_id: b.id, ...values }).onDuplicateKeyUpdate(values).execute();
      changed++;
    }
  }
  return { changed, bills: bills.map((b) => b.internal_no) };
}
