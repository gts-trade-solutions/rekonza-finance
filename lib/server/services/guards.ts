import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Checks made as a document is saved, each under the book's own policy
// (org-settings.ts): off, a warning shown to the person saving, or a refusal.
//
//   * Credit limit — what the customer owes, with this invoice, against the
//     limit on their account.
//   * Negative stock — an item leaving that is not there to leave.
//   * Cash — section 269ST forbids receiving ₹2 lakh or more in cash from one
//     person in a day (or for one transaction or event), on pain of a penalty
//     equal to the amount; section 40A(3) disallows an expense paid in cash
//     above ₹10,000 to one person in a day (₹35,000 to a transporter).
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor } from '../db';
import type { Paise } from '../../types';
import { toPaiseFromSql } from '../money-sql';
import { conflict } from '../http';
import { stockPosition } from '../reports/stock';
import { enforce, getPolicies } from './org-settings';

const rupees = (p: Paise) => `₹${(p / 100).toLocaleString('en-IN')}`;
export const CASH_RECEIPT_LIMIT_PAISE = 2_00_000_00;
export const CASH_PAYMENT_LIMIT_PAISE = 10_000_00;
export const CASH_PAYMENT_LIMIT_TRANSPORT_PAISE = 35_000_00;

/** What a customer owes now: open invoices and opening bills. */
async function owedBy(ex: Executor, orgId: number, customerId: number): Promise<Paise> {
  const { rows } = await sql<{ v: string }>`
    SELECT COALESCE((SELECT SUM(total - amount_paid) FROM invoices
                      WHERE org_id = ${orgId} AND customer_id = ${customerId} AND status NOT IN ('draft', 'void')), 0)
         + COALESCE((SELECT SUM(amount - amount_paid) FROM opening_documents
                      WHERE org_id = ${orgId} AND contact_id = ${customerId} AND kind = 'receivable' AND status <> 'void'), 0) AS v
  `.execute(ex);
  return toPaiseFromSql(rows[0]?.v ?? '0');
}

export async function checkCreditLimit(
  ex: Executor, orgId: number, customerId: number, invoicePaise: Paise, warnings: string[], override = false,
) {
  const c = await ex.selectFrom('contacts').select(['display_name', 'credit_limit']).where('id', '=', customerId).executeTakeFirst();
  const limit = toPaiseFromSql(c?.credit_limit ?? '0');
  if (!c || limit <= 0) return;
  const owed = await owedBy(ex, orgId, customerId);
  if (owed + invoicePaise <= limit) return;
  const policy = (await getPolicies(ex, orgId)).creditLimit;
  enforce(override && policy === 'block' ? 'warn' : policy,
    `${c.display_name} owes ${rupees(owed)}; with this invoice that is ${rupees(owed + invoicePaise)}, over their credit limit of ${rupees(limit)}.`,
    warnings, conflict);
}

/** Lines that take tracked stock out: would any go below zero at this branch, on this date? */
export async function checkStock(
  ex: Executor, orgId: number, branchId: number, date: string, lines: { itemId?: number | null; qty: number }[], warnings: string[],
) {
  const out = new Map<number, number>();
  for (const l of lines) if (l.itemId && l.qty > 0) out.set(l.itemId, (out.get(l.itemId) ?? 0) + l.qty);
  if (!out.size) return;
  const tracked = await ex.selectFrom('items').select(['id', 'name']).where('org_id', '=', orgId)
    .where('id', 'in', [...out.keys()]).where('track_inventory', '=', 1).where('kind', '=', 'goods').execute();
  if (!tracked.length) return;
  const policy = (await getPolicies(ex, orgId)).negativeStock;
  if (policy === 'off') return;
  const pos = await stockPosition(ex, orgId, date, { branchId, includeArchived: true });
  const short = tracked.flatMap((t) => {
    const have = pos.lines.find((l) => l.itemId === String(t.id))?.qty ?? 0;
    const want = out.get(t.id)!;
    return have - want < 0 ? [`${t.name}: ${have} in stock, ${want} going out`] : [];
  });
  if (short.length) enforce(policy, `Not enough stock — ${short.join('; ')}.`, warnings, conflict);
}

/**
 * Legal Metrology: packaged goods may not be sold above the MRP printed on
 * them. The price a unit goes for, tax included, against the item's MRP.
 */
export async function checkMrp(
  ex: Executor, orgId: number, lines: { itemId: number | null; qty: number; total: Paise }[], warnings: string[],
) {
  const ids = [...new Set(lines.map((l) => l.itemId).filter((x): x is number => !!x))];
  if (!ids.length) return;
  const items = await ex.selectFrom('items').select(['id', 'name', 'mrp']).where('org_id', '=', orgId)
    .where('id', 'in', ids).where('mrp', 'is not', null).execute();
  for (const i of items) {
    const mrp = toPaiseFromSql(i.mrp!);
    if (mrp <= 0) continue;
    for (const l of lines) {
      if (l.itemId !== i.id || !(l.qty > 0)) continue;
      const each = Math.round(l.total / l.qty);
      if (each > mrp) warnings.push(`${i.name} goes for ₹${(each / 100).toFixed(2)} a unit with tax, above its MRP of ₹${(mrp / 100).toFixed(2)}. Selling above MRP is an offence under the Legal Metrology rules.`);
    }
  }
}

/** Section 269ST: cash received from one person in a day. */
export async function checkCashReceipt(
  ex: Executor, orgId: number, contactId: number, date: string, amountPaise: Paise, warnings: string[],
) {
  const { rows } = await sql<{ v: string }>`
    SELECT COALESCE(SUM(p.amount), 0) AS v FROM payments p JOIN bank_accounts b ON b.id = p.bank_account_id
     WHERE p.org_id = ${orgId} AND p.contact_id = ${contactId} AND p.kind = 'received' AND p.status <> 'void'
       AND p.payment_date = ${date} AND (p.mode = 'cash' OR b.kind = 'cash')
  `.execute(ex);
  const day = toPaiseFromSql(rows[0]?.v ?? '0') + amountPaise;
  if (day < CASH_RECEIPT_LIMIT_PAISE) return;
  enforce((await getPolicies(ex, orgId)).cashLimits,
    `${rupees(day)} received in cash from one person on ${date}. Section 269ST forbids cash of ₹2 lakh or more from a person in a day, ` +
      'and the penalty is the whole amount. Take it by cheque or bank transfer.',
    warnings, conflict);
}

/** Section 40A(3): cash paid to one person in a day. */
export async function checkCashPayment(
  ex: Executor, orgId: number, contactId: number | null, date: string, amountPaise: Paise, warnings: string[],
) {
  if (!contactId) {
    if (amountPaise > CASH_PAYMENT_LIMIT_PAISE) {
      enforce((await getPolicies(ex, orgId)).cashLimits,
        `${rupees(amountPaise)} paid in cash. Above ₹10,000 to a person in a day, section 40A(3) disallows the expense.`, warnings, conflict);
    }
    return;
  }
  const { rows } = await sql<{ v: string }>`
    SELECT COALESCE((SELECT SUM(p.amount) FROM payments p JOIN bank_accounts b ON b.id = p.bank_account_id
                      WHERE p.org_id = ${orgId} AND p.contact_id = ${contactId} AND p.kind = 'made' AND p.status <> 'void'
                        AND p.payment_date = ${date} AND (p.mode = 'cash' OR b.kind = 'cash')), 0)
         + COALESCE((SELECT SUM(x.total) FROM expenses x JOIN bank_accounts b ON b.id = x.paid_through_bank_account_id
                      WHERE x.org_id = ${orgId} AND x.vendor_id = ${contactId} AND x.status <> 'void'
                        AND x.expense_date = ${date} AND b.kind = 'cash'), 0) AS v
  `.execute(ex);
  const day = toPaiseFromSql(rows[0]?.v ?? '0') + amountPaise;
  const transporter = await ex.selectFrom('contacts').select('tds_section').where('id', '=', contactId).executeTakeFirst();
  const limit = transporter?.tds_section === '194C' ? CASH_PAYMENT_LIMIT_TRANSPORT_PAISE : CASH_PAYMENT_LIMIT_PAISE;
  if (day <= limit) return;
  enforce((await getPolicies(ex, orgId)).cashLimits,
    `${rupees(day)} paid in cash to one person on ${date}. Above ${rupees(limit)} in a day, section 40A(3) disallows the expense.`,
    warnings, conflict);
}
