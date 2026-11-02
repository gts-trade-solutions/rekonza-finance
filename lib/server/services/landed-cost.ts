import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Landed cost, as Zoho Books has it: what it cost to get goods to the godown —
// freight, customs duty, clearing, insurance — added to the goods' own cost,
// so the stock is valued at what it really cost and so is everything sold
// from it. (Migration 102.)
//
// The charge is a line with no item on a bill: the transporter's bill, the
// clearing agent's, or a freight line on the supplier's own bill. Some or all
// of it is spread over the stock lines of a bill — by quantity, by value, or
// by hand — and from the charge bill's date reports/stock.ts counts it in each
// line's cost. Its GST is credit, as ever; only the taxable value (and tax
// that cannot be claimed) is cost.
//
// A periodic book needs nothing more: the charge stays where it was posted and
// closing stock is worth more. A perpetual book (services/stock-ledger.ts)
// also moves it in the ledger, Dr Inventory and Cr the charge's account, so
// the Inventory account keeps agreeing with the stock.
// ─────────────────────────────────────────────────────────────────────────────

import type { Executor, Trx } from '../db';
import { badRequest, conflict, notFound } from '../http';
import { toPaiseFromSql, toSqlFromPaise } from '../money-sql';
import type { Paise } from '../../types';
import { postEntry, reverseEntry } from '../ledger/posting';
import { accountIds, CODE, requireAccount } from '../ledger/chart-of-accounts';
import { perpetualOn } from './stock-ledger';

export type LandedMethod = 'quantity' | 'value' | 'manual';
const p = toPaiseFromSql;
const day = (v: unknown) => String(v).slice(0, 10);

/** What a charge line can give: its cost (taxable, and tax that cannot be claimed). */
const chargeCost = (l: { taxable: string; cgst: string; sgst: string; igst: string; cess: string; itc_eligibility: string | null }, rcm: boolean) =>
  p(l.taxable) + (l.itc_eligibility !== 'eligible' && l.itc_eligibility !== 'capital_goods' && !rcm ? p(l.cgst) + p(l.sgst) + p(l.igst) + p(l.cess) : 0);

/** Charges with something left to spread: lines with no item on bills that stand. */
export async function chargeLines(ex: Executor, orgId: number) {
  const rows = await ex.selectFrom('bill_lines as l').innerJoin('bills as b', 'b.id', 'l.bill_id').innerJoin('contacts as c', 'c.id', 'b.vendor_id')
    .leftJoin('accounts as a', 'a.id', 'l.account_id')
    .select(['l.id', 'l.bill_id', 'l.description', 'l.taxable', 'l.cgst', 'l.sgst', 'l.igst', 'l.cess', 'l.itc_eligibility',
      'b.vendor_invoice_no', 'b.internal_no', 'b.bill_date', 'b.is_rcm', 'c.display_name', 'a.name as account_name', 'a.code as account_code'])
    .where('b.org_id', '=', orgId).where('b.status', 'not in', ['draft', 'void']).where('l.item_id', 'is', null)
    .orderBy('b.bill_date', 'desc').limit(300).execute();
  const used = await allocatedByCharge(ex, orgId, rows.map((r) => r.id));
  return rows
    .filter((r) => r.account_code !== CODE.INVENTORY)
    .map((r) => {
      const cost = chargeCost(r, !!r.is_rcm);
      const allocated = used.get(r.id) ?? 0;
      return {
        lineId: String(r.id), billId: String(r.bill_id), bill: r.vendor_invoice_no || r.internal_no, vendor: r.display_name,
        date: day(r.bill_date), description: r.description, account: r.account_name, costPaise: cost, allocatedPaise: allocated, leftPaise: cost - allocated,
      };
    })
    .filter((r) => r.leftPaise > 0);
}

async function allocatedByCharge(ex: Executor, orgId: number, lineIds: number[]) {
  if (!lineIds.length) return new Map<number, Paise>();
  const rows = await ex.selectFrom('landed_costs').select(['charge_line_id', (eb) => eb.fn.sum<string>('amount').as('amt')])
    .where('org_id', '=', orgId).where('charge_line_id', 'in', lineIds).groupBy('charge_line_id').execute();
  return new Map(rows.map((r) => [Number(r.charge_line_id), p(r.amt)]));
}

/** A bill's stock lines, with what landed cost each carries already. */
export async function goodsLines(ex: Executor, orgId: number, billId: number) {
  const rows = await ex.selectFrom('bill_lines as l').innerJoin('bills as b', 'b.id', 'l.bill_id').innerJoin('items as i', 'i.id', 'l.item_id')
    .select(['l.id', 'l.qty', 'l.taxable', 'l.uqc', 'l.description', 'i.name'])
    .where('b.org_id', '=', orgId).where('b.id', '=', billId).where('i.kind', '=', 'goods').where('i.track_inventory', '=', 1).where('l.qty', '>', 0 as never)
    .orderBy('l.line_no').execute();
  const landed = rows.length
    ? await ex.selectFrom('landed_cost_lines').select(['bill_line_id', (eb) => eb.fn.sum<string>('amount').as('amt')])
      .where('org_id', '=', orgId).where('bill_line_id', 'in', rows.map((r) => r.id)).groupBy('bill_line_id').execute()
    : [];
  const by = new Map(landed.map((r) => [Number(r.bill_line_id), p(r.amt)]));
  return rows.map((r) => {
    const landedPaise = by.get(r.id) ?? 0;
    const qty = Number(r.qty);
    return {
      lineId: String(r.id), item: r.description?.trim() || r.name, qty, uqc: r.uqc, valuePaise: p(r.taxable), landedPaise,
      unitCostPaise: qty ? Math.round((p(r.taxable) + landedPaise) / qty) : 0,
    };
  });
}

/** The landed costs spread over a bill's goods, newest first. */
export async function listLandedCosts(ex: Executor, orgId: number, goodsBillId: number) {
  const rows = await ex.selectFrom('landed_costs as lc').innerJoin('bill_lines as l', 'l.id', 'lc.charge_line_id').innerJoin('bills as b', 'b.id', 'lc.charge_bill_id')
    .innerJoin('contacts as c', 'c.id', 'b.vendor_id')
    .select(['lc.id', 'lc.method', 'lc.amount', 'lc.allocated_on', 'lc.journal_entry_id', 'l.description', 'b.id as charge_bill_id', 'b.vendor_invoice_no', 'b.internal_no', 'c.display_name'])
    .where('lc.org_id', '=', orgId).where('lc.goods_bill_id', '=', goodsBillId).orderBy('lc.id', 'desc').execute();
  const lines = rows.length
    ? await ex.selectFrom('landed_cost_lines').select(['landed_cost_id', 'bill_line_id', 'amount']).where('landed_cost_id', 'in', rows.map((r) => r.id)).execute()
    : [];
  return rows.map((r) => ({
    id: String(r.id), method: r.method as LandedMethod, amountPaise: p(r.amount), date: day(r.allocated_on), posted: !!r.journal_entry_id,
    charge: { billId: String(r.charge_bill_id), bill: r.vendor_invoice_no || r.internal_no, vendor: r.display_name, description: r.description },
    lines: lines.filter((x) => x.landed_cost_id === r.id).map((x) => ({ lineId: String(x.bill_line_id), amountPaise: p(x.amount) })),
  }));
}

/** Split an amount over weights to the paisa, the remainder to the largest shares, so the parts add up exactly. */
export function splitByWeight(totalPaise: Paise, weights: number[]): Paise[] {
  const sum = weights.reduce((t, w) => t + w, 0);
  if (sum <= 0) throw badRequest('There is nothing to spread it by: the lines have no quantity or value.');
  const raw = weights.map((w) => (totalPaise * w) / sum);
  const out = raw.map(Math.floor);
  let left = totalPaise - out.reduce((t, n) => t + n, 0);
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; left > 0; k++, left--) out[order[k % order.length].i] += 1;
  return out;
}

export interface AllocateInput {
  chargeLineId: number;
  goodsBillId: number;
  method: LandedMethod;
  /** How much of the charge; all that is left when omitted. */
  amountPaise?: Paise;
  /** By hand: each goods line's share. */
  manual?: { lineId: number; amountPaise: Paise }[];
}

export async function allocateLandedCost(trx: Trx, orgId: number, userId: number | null, input: AllocateInput) {
  const charge = await trx.selectFrom('bill_lines as l').innerJoin('bills as b', 'b.id', 'l.bill_id')
    .leftJoin('accounts as a', 'a.id', 'l.account_id')
    .select(['l.id', 'l.bill_id', 'l.item_id', 'l.account_id', 'l.taxable', 'l.cgst', 'l.sgst', 'l.igst', 'l.cess', 'l.itc_eligibility', 'l.description',
      'b.status', 'b.bill_date', 'b.branch_id', 'b.is_rcm', 'b.vendor_invoice_no', 'b.internal_no', 'a.code as account_code'])
    .where('l.id', '=', input.chargeLineId).where('b.org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!charge) throw notFound('That charge does not exist.');
  if (charge.item_id) throw badRequest('A landed cost is a charge with no item on it — freight, duty, clearing — not goods.');
  if (charge.status === 'draft' || charge.status === 'void') throw badRequest(`That bill is ${charge.status}; only a bill that stands can carry a landed cost.`);
  if (charge.account_code === CODE.INVENTORY) throw badRequest('That line is already in the Inventory account.');

  const goodsBill = await trx.selectFrom('bills').select(['id', 'status', 'bill_date', 'branch_id']).where('id', '=', input.goodsBillId).where('org_id', '=', orgId).executeTakeFirst();
  if (!goodsBill) throw notFound('That bill does not exist.');
  if (goodsBill.status === 'draft' || goodsBill.status === 'void') throw badRequest(`That bill is ${goodsBill.status}; spread the cost over goods on a bill that stands.`);
  const goods = await goodsLines(trx, orgId, input.goodsBillId);
  if (!goods.length) throw badRequest('That bill has no stock items to carry a landed cost.');

  const cost = chargeCost(charge, !!charge.is_rcm);
  const already = (await allocatedByCharge(trx, orgId, [charge.id])).get(charge.id) ?? 0;
  const left = cost - already;
  if (left <= 0) throw conflict('All of that charge has been spread already.');

  let parts: { lineId: number; amountPaise: Paise }[];
  if (input.method === 'manual') {
    const known = new Set(goods.map((g) => Number(g.lineId)));
    parts = (input.manual ?? []).filter((m) => m.amountPaise > 0);
    if (!parts.length) throw badRequest('Give at least one line its share.');
    for (const m of parts) if (!known.has(m.lineId)) throw badRequest('A share is for a line that is not a stock line of that bill.');
    if (parts.some((m) => !Number.isInteger(m.amountPaise))) throw badRequest('Shares are in whole paise.');
  } else {
    const amount = input.amountPaise ?? left;
    if (!(amount > 0) || !Number.isInteger(amount)) throw badRequest('Give an amount above zero.');
    const weights = goods.map((g) => (input.method === 'quantity' ? g.qty : g.valuePaise));
    const split = splitByWeight(amount, weights);
    parts = goods.map((g, i) => ({ lineId: Number(g.lineId), amountPaise: split[i] })).filter((x) => x.amountPaise > 0);
  }
  const total = parts.reduce((t, x) => t + x.amountPaise, 0);
  if (total > left) throw badRequest(`Only ₹${(left / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })} of that charge is left to spread.`);

  const allocatedOn = day(charge.bill_date);
  const inserted = await trx.insertInto('landed_costs').values({
    org_id: orgId, charge_bill_id: charge.bill_id, charge_line_id: charge.id, goods_bill_id: goodsBill.id, method: input.method,
    amount: toSqlFromPaise(total), allocated_on: allocatedOn, created_by_user_id: userId,
  }).executeTakeFirstOrThrow();
  const id = Number(inserted.insertId);
  await trx.insertInto('landed_cost_lines').values(parts.map((x) => ({ org_id: orgId, landed_cost_id: id, bill_line_id: x.lineId, amount: toSqlFromPaise(x.amountPaise) }))).execute();

  // A perpetual book moves it into the Inventory account too.
  let journalEntryId: number | null = null;
  if (charge.account_id && await perpetualOn(trx, orgId, allocatedOn)) {
    const acc = await accountIds(trx, orgId);
    const entry = await postEntry(trx, {
      orgId, branchId: goodsBill.branch_id, date: allocatedOn, sourceType: 'landed_cost', sourceId: id, userId, module: 'purchases',
      memo: `Landed cost: ${charge.description ?? 'charge'} on bill ${charge.vendor_invoice_no || charge.internal_no}, into stock`,
      lines: [
        { accountId: requireAccount(acc, CODE.INVENTORY), debit: total },
        { accountId: charge.account_id, credit: total },
      ],
    });
    journalEntryId = entry.id;
    await trx.updateTable('landed_costs').set({ journal_entry_id: entry.id }).where('id', '=', id).execute();
  }
  return { id, totalPaise: total, parts, journalEntryId };
}

/** Take a landed cost off again; a perpetual book's entry is reversed, never deleted. */
export async function removeLandedCost(trx: Trx, orgId: number, userId: number | null, id: number) {
  const lc = await trx.selectFrom('landed_costs').select(['id', 'journal_entry_id', 'amount', 'goods_bill_id']).where('id', '=', id).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!lc) throw notFound('That landed cost does not exist.');
  if (lc.journal_entry_id) await reverseEntry(trx, orgId, lc.journal_entry_id, { userId, memo: 'Landed cost taken off', module: 'purchases' });
  await trx.deleteFrom('landed_cost_lines').where('landed_cost_id', '=', id).execute();
  await trx.deleteFrom('landed_costs').where('id', '=', id).execute();
  return { goodsBillId: lc.goods_bill_id, amountPaise: p(lc.amount) };
}
