import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// The composition scheme: CMP-08 each quarter and GSTR-4 for the year.
//
// A composition dealer issues bills of supply and charges no tax (sales.ts),
// takes no input credit (purchases.ts), and pays a flat rate on turnover in
// the state (CGST Rule 7, read with the State Act, so half as central tax and
// half as state tax):
//
//   manufacturer   1% of turnover
//   trader         1% of turnover of taxable supplies (exempt sales left out)
//   restaurant     5% of turnover
//   services       6% of turnover, under s.10(2A)
//
// Reverse charge still applies to it, and is paid with the CMP-08. The tax on
// turnover cannot be collected from buyers, so it is booked as the dealer's
// own expense: Dr Composition Tax, Cr Output CGST and SGST payable.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor, Trx } from '../db';
import type { Paise } from '../../types';
import { toPaiseFromSql, toSqlFromPaise } from '../money-sql';
import { badRequest, conflict } from '../http';
import { postEntry } from '../ledger/posting';
import { CODE, accountIds, requireAccount } from '../ledger/chart-of-accounts';
import { quarterRange, type Quarter } from '../tax/tds-returns';
import { registrationResolver } from '../services/statutory';

export type CompositionCategory = 'manufacturer' | 'trader' | 'restaurant' | 'services';
export const COMPOSITION_RATES: Record<CompositionCategory, { ratePct: number; label: string; taxableOnly: boolean }> = {
  manufacturer: { ratePct: 1, label: 'Manufacturer', taxableOnly: false },
  trader: { ratePct: 1, label: 'Trader', taxableOnly: true },
  restaurant: { ratePct: 5, label: 'Restaurant (no alcohol)', taxableOnly: false },
  services: { ratePct: 6, label: 'Services or mixed, under s.10(2A)', taxableOnly: false },
};

/** Half of the rate as central tax, half as state tax; the odd paisa to central, as on invoices. */
export function compositionTax(turnoverPaise: Paise, ratePct: number): { cgst: Paise; sgst: Paise } {
  const total = Math.round((turnoverPaise * ratePct) / 100);
  const sgst = Math.floor(total / 2);
  return { cgst: total - sgst, sgst };
}

export interface Cmp08 {
  fy: number;
  quarter: Quarter;
  from: string;
  to: string;
  category: CompositionCategory | null;
  ratePct: number;
  /** Bills of supply issued while in composition, less credit notes, in the quarter. */
  turnoverPaise: Paise;
  /** Sales left out of a trader's turnover because they are exempt. */
  exemptPaise: Paise;
  outward: { cgst: Paise; sgst: Paise };
  reverseCharge: { cgst: Paise; sgst: Paise; igst: Paise; cess: Paise };
  totalPaise: Paise;
  dueDate: string;
  booked: { journalEntryId: string | null; at: string } | null;
  issues: string[];
}

const nextMonth18 = (to: string) => {
  const [y, m] = to.split('-').map(Number);
  return m === 12 ? `${y + 1}-01-18` : `${y}-${String(m + 1).padStart(2, '0')}-18`;
};

export async function cmp08(ex: Executor, orgId: number, fy: number, q: Quarter): Promise<Cmp08> {
  const { from, to } = quarterRange(fy, q);
  const org = await ex.selectFrom('organizations').select('composition_category').where('id', '=', orgId).executeTakeFirstOrThrow();
  const category = (org.composition_category as CompositionCategory | null) ?? null;
  const rule = category ? COMPOSITION_RATES[category] : null;
  const regOn = await registrationResolver(ex, orgId);
  const issues: string[] = [];
  if (!rule) issues.push('The composition category is not set (Settings → Statutory). It decides the rate: 1%, 5% or 6%.');

  // Sales line by line, so a trader's exempt sales can be left out.
  const sales = await sql<{ d: string; taxable: string; rate: string; sign: number }>`
    SELECT i.invoice_date AS d, l.taxable, l.gst_rate_pct AS rate, 1 AS sign
      FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id
     WHERE i.org_id = ${orgId} AND i.status NOT IN ('draft', 'void') AND i.invoice_date BETWEEN ${from} AND ${to}
    UNION ALL
    SELECT n.note_date AS d, cl.taxable, cl.gst_rate_pct AS rate, -1 AS sign
      FROM credit_note_lines cl JOIN credit_notes n ON n.id = cl.credit_note_id
     WHERE n.org_id = ${orgId} AND n.status <> 'void' AND n.note_date BETWEEN ${from} AND ${to}
  `.execute(ex);
  let turnover = 0;
  let exempt = 0;
  for (const r of sales.rows) {
    if (regOn(String(r.d).slice(0, 10)) !== 'composition') continue;
    const v = toPaiseFromSql(r.taxable) * Number(r.sign);
    if (rule?.taxableOnly && Number(r.rate) === 0) exempt += v;
    else turnover += v;
  }

  const rcm = await sql<{ d: string; cgst: string; sgst: string; igst: string; cess: string }>`
    SELECT bill_date AS d, cgst, sgst, igst, cess FROM bills
     WHERE org_id = ${orgId} AND is_rcm = 1 AND status NOT IN ('draft', 'void') AND bill_date BETWEEN ${from} AND ${to}
  `.execute(ex);
  const reverseCharge = { cgst: 0, sgst: 0, igst: 0, cess: 0 };
  for (const r of rcm.rows) {
    if (regOn(String(r.d).slice(0, 10)) !== 'composition') continue;
    reverseCharge.cgst += toPaiseFromSql(r.cgst);
    reverseCharge.sgst += toPaiseFromSql(r.sgst);
    reverseCharge.igst += toPaiseFromSql(r.igst);
    reverseCharge.cess += toPaiseFromSql(r.cess);
  }

  const outward = compositionTax(Math.max(0, turnover), rule?.ratePct ?? 0);
  const booked = await ex.selectFrom('composition_returns').select(['journal_entry_id', 'created_at'])
    .where('org_id', '=', orgId).where('fy', '=', fy).where('quarter', '=', q).executeTakeFirst();
  if (turnover < 0) issues.push('Credit notes in the quarter exceed its sales; nothing is payable on turnover.');

  return {
    fy, quarter: q, from, to, category, ratePct: rule?.ratePct ?? 0,
    turnoverPaise: turnover, exemptPaise: exempt, outward, reverseCharge,
    totalPaise: outward.cgst + outward.sgst + reverseCharge.cgst + reverseCharge.sgst + reverseCharge.igst + reverseCharge.cess,
    dueDate: nextMonth18(to),
    booked: booked ? { journalEntryId: booked.journal_entry_id ? String(booked.journal_entry_id) : null, at: new Date(booked.created_at).toISOString() } : null,
    issues,
  };
}

/**
 * Book the quarter's tax on turnover, dated the last day of the quarter. Once
 * a quarter, because the CMP-08 is filed once; the reverse charge was already
 * booked with each bill, so only the turnover tax is posted here.
 */
export async function bookCmp08(trx: Trx, orgId: number, userId: number | null, fy: number, q: Quarter): Promise<Cmp08> {
  const c = await cmp08(trx, orgId, fy, q);
  if (c.booked) throw conflict(`CMP-08 for ${c.from} to ${c.to} is already booked.`);
  if (!c.category) throw badRequest(c.issues[0]);
  const branch = await trx.selectFrom('branches').select('id').where('org_id', '=', orgId).orderBy('is_primary', 'desc').executeTakeFirstOrThrow();
  let journalEntryId: number | null = null;
  const tax = c.outward.cgst + c.outward.sgst;
  if (tax > 0) {
    const acc = await accountIds(trx, orgId);
    const entry = await postEntry(trx, {
      orgId, branchId: branch.id, date: c.to, userId, module: 'accountant',
      memo: `Composition tax, ${c.from} to ${c.to}: ${c.ratePct}% of ₹${(c.turnoverPaise / 100).toLocaleString('en-IN')}`,
      sourceType: 'composition', sourceId: null,
      lines: [
        { accountId: requireAccount(acc, CODE.COMPOSITION_TAX), debit: tax },
        { accountId: requireAccount(acc, CODE.GST_CGST), credit: c.outward.cgst, description: 'CMP-08 central tax' },
        { accountId: requireAccount(acc, CODE.GST_SGST), credit: c.outward.sgst, description: 'CMP-08 state tax' },
      ],
    });
    journalEntryId = entry.id;
  }
  await trx.insertInto('composition_returns').values({
    org_id: orgId, fy, quarter: q, category: c.category, rate_pct: String(c.ratePct),
    turnover: toSqlFromPaise(c.turnoverPaise), cgst: toSqlFromPaise(c.outward.cgst), sgst: toSqlFromPaise(c.outward.sgst),
    rcm_cgst: toSqlFromPaise(c.reverseCharge.cgst), rcm_sgst: toSqlFromPaise(c.reverseCharge.sgst),
    rcm_igst: toSqlFromPaise(c.reverseCharge.igst), rcm_cess: toSqlFromPaise(c.reverseCharge.cess),
    journal_entry_id: journalEntryId, created_by_user_id: userId,
  }).execute();
  return cmp08(trx, orgId, fy, q);
}

// ── GSTR-4 ───────────────────────────────────────────────────────────────────

export interface Gstr4InwardRow {
  gstin: string | null;
  name: string;
  bills: number;
  taxablePaise: Paise;
  igstPaise: Paise;
  cgstPaise: Paise;
  sgstPaise: Paise;
  cessPaise: Paise;
}

export interface Gstr4 {
  fy: number;
  dueDate: string;
  /** Table 4: inward supplies, by kind. */
  inward: {
    registered: Gstr4InwardRow[];        // 4A
    registeredRcm: Gstr4InwardRow[];     // 4B
    unregistered: Gstr4InwardRow;        // 4C
    importOfServices: Gstr4InwardRow;    // 4D
  };
  /** Table 5: the year's CMP-08s. */
  quarters: Cmp08[];
  /** Table 6: outward supplies, at the composition rate. */
  outward: { ratePct: number; turnoverPaise: Paise; cgstPaise: Paise; sgstPaise: Paise };
}

export async function gstr4(ex: Executor, orgId: number, fy: number): Promise<Gstr4> {
  const from = `${fy}-04-01`;
  const to = `${fy + 1}-03-31`;
  const regOn = await registrationResolver(ex, orgId);
  const { rows } = await sql<{
    d: string; vendor_id: number; name: string; gstin: string | null; treatment: string; is_rcm: number; supply_kind: string | null;
    subtotal: string; igst: string; cgst: string; sgst: string; cess: string;
  }>`
    SELECT b.bill_date AS d, b.vendor_id, c.display_name AS name, c.gstin, c.gst_treatment AS treatment, b.is_rcm,
           NULL AS supply_kind, b.subtotal, b.igst, b.cgst, b.sgst, b.cess
      FROM bills b JOIN contacts c ON c.id = b.vendor_id
     WHERE b.org_id = ${orgId} AND b.status NOT IN ('draft', 'void') AND b.bill_date BETWEEN ${from} AND ${to}
  `.execute(ex);

  const empty = (name: string): Gstr4InwardRow => ({ gstin: null, name, bills: 0, taxablePaise: 0, igstPaise: 0, cgstPaise: 0, sgstPaise: 0, cessPaise: 0 });
  const add = (row: Gstr4InwardRow, r: (typeof rows)[number]) => {
    row.bills += 1;
    row.taxablePaise += toPaiseFromSql(r.subtotal);
    row.igstPaise += toPaiseFromSql(r.igst);
    row.cgstPaise += toPaiseFromSql(r.cgst);
    row.sgstPaise += toPaiseFromSql(r.sgst);
    row.cessPaise += toPaiseFromSql(r.cess);
  };
  const registered = new Map<string, Gstr4InwardRow>();
  const registeredRcm = new Map<string, Gstr4InwardRow>();
  const unregistered = empty('Unregistered suppliers');
  const importOfServices = empty('Import of services');
  for (const r of rows) {
    if (regOn(String(r.d).slice(0, 10)) !== 'composition') continue;
    if (r.treatment === 'overseas') { add(importOfServices, r); continue; }
    if (!r.gstin) { add(unregistered, r); continue; }
    const map = r.is_rcm ? registeredRcm : registered;
    const row = map.get(r.gstin) ?? { ...empty(r.name), gstin: r.gstin };
    add(row, r);
    map.set(r.gstin, row);
  }

  const quarters = await Promise.all(([1, 2, 3, 4] as Quarter[]).map((q) => cmp08(ex, orgId, fy, q)));
  const turnover = quarters.reduce((t, q) => t + q.turnoverPaise, 0);
  return {
    fy,
    dueDate: `${fy + 1}-06-30`,
    inward: {
      registered: [...registered.values()].sort((a, b) => b.taxablePaise - a.taxablePaise),
      registeredRcm: [...registeredRcm.values()].sort((a, b) => b.taxablePaise - a.taxablePaise),
      unregistered,
      importOfServices,
    },
    quarters,
    outward: {
      ratePct: quarters[0]?.ratePct ?? 0,
      turnoverPaise: turnover,
      cgstPaise: quarters.reduce((t, q) => t + q.outward.cgst, 0),
      sgstPaise: quarters.reduce((t, q) => t + q.outward.sgst, 0),
    },
  };
}
