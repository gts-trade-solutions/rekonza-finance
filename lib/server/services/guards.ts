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
import { explodeKits } from './kits';
import { dayLabel } from '../../date-range';

const rupees = (p: Paise) => `₹${(p / 100).toLocaleString('en-IN')}`;
const rupees2 = (p: Paise) => `₹${(p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const q4 = (n: number) => Math.round(n * 10_000) / 10_000;
/** Today in India (held-journals.ts has the same; not imported, to keep this module free of the journal services). */
const indiaToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
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

/**
 * Lines that take tracked stock out: would any go below zero at this branch,
 * on the document's date or on any day since? Goods cannot be sold, written off
 * or moved that are not there: under AS 2 / Ind AS 2 stock is never less than
 * nothing, and a negative quantity carried to the year end becomes a negative
 * closing stock in the profit and loss and the balance sheet. Measured on the
 * document's date and on today (a back-dated sale can leave later sales short),
 * before the document counts; the message names each item, what is in stock,
 * what is going out and the shortfall. The book's negative-stock rule decides:
 * off, a warning, or a refusal.
 */
export async function checkStock(
  ex: Executor, orgId: number, branchId: number, date: string, lines: { itemId?: number | null; qty: number }[], warnings: string[],
) {
  const out = new Map<number, number>();
  // A kit takes its components out of stock, so those are what must be there.
  for (const l of await explodeKits(ex, orgId, lines)) if (l.itemId && l.qty > 0) out.set(l.itemId, (out.get(l.itemId) ?? 0) + l.qty);
  if (!out.size) return;
  const tracked = await ex.selectFrom('items').select(['id', 'name', 'uqc']).where('org_id', '=', orgId)
    .where('id', 'in', [...out.keys()]).where('track_inventory', '=', 1).where('kind', '=', 'goods').execute();
  if (!tracked.length) return;
  const policy = (await getPolicies(ex, orgId)).negativeStock;
  if (policy === 'off') return;
  const today = indiaToday();
  const days = date < today ? [date, today] : [date];
  const worst = new Map<number, { have: number; date: string }>();
  for (const day of days) {
    const pos = await stockPosition(ex, orgId, day, { branchId, includeArchived: true });
    for (const t of tracked) {
      const have = pos.lines.find((l) => l.itemId === String(t.id))?.qty ?? 0;
      const w = worst.get(t.id);
      if (!w || have < w.have) worst.set(t.id, { have, date: day });
    }
  }
  const short = tracked.flatMap((t) => {
    const w = worst.get(t.id)!;
    const want = out.get(t.id)!;
    const left = w.have - want;
    if (left >= -1e-9) return [];
    const unit = (t.uqc ?? '').toLowerCase();
    return [`${t.name}: ${q4(w.have)} in stock${w.date !== date ? ` on ${dayLabel(w.date)}` : ''}, ${q4(want)} going out, short by ${q4(-left)}${unit ? ` ${unit}` : ''}`];
  });
  if (short.length) {
    enforce(policy, `Not enough stock — ${short.join('; ')}. Stock below zero would show as a negative closing stock in the profit and loss and the balance sheet: record the purchase first, or change the quantity.`, warnings, conflict);
  }
}

/**
 * Money going out of a cash account (Cash in Hand, petty cash): would the
 * account go below nil on the document's date or since? Cash in hand cannot be
 * less than nothing — a negative cash balance in the books means a receipt or a
 * withdrawal from the bank was never recorded, or the payment was not made from
 * cash — and an auditor reads it as a sign the cash book is not kept as the
 * money moves (Companies Act, 2013, s.128: books that give a true and fair
 * view). The balance is the account's own ledger balance, before this document
 * (and without an earlier version of it, on an edit); the message names the
 * account, what is in hand, what is going out and the shortfall. The book's
 * negative-cash rule decides: off, a warning, or a refusal. A bank account may
 * be overdrawn on an overdraft or cash credit limit, so only cash is checked.
 */
export async function checkCashBalance(
  ex: Executor, orgId: number, bankAccountId: number, date: string, outPaise: Paise, warnings: string[],
  exclude?: { sourceTypes: string[]; sourceId: number } | null,
) {
  if (outPaise <= 0) return;
  const bank = await ex.selectFrom('bank_accounts').select(['name', 'kind', 'ledger_account_id'])
    .where('id', '=', bankAccountId).where('org_id', '=', orgId).executeTakeFirst();
  if (!bank || bank.kind !== 'cash') return;
  const policy = (await getPolicies(ex, orgId)).negativeCash;
  if (policy === 'off') return;
  const today = indiaToday();
  const days = date < today ? [date, today] : [date];
  let worst: { have: Paise; date: string } | null = null;
  for (const day of days) {
    const { rows } = await sql<{ v: string | null }>`
      SELECT COALESCE(SUM(jl.debit - jl.credit), 0) AS v FROM journal_lines jl JOIN journal_entries e ON e.id = jl.entry_id
       WHERE jl.org_id = ${orgId} AND jl.account_id = ${bank.ledger_account_id} AND jl.entry_date <= ${day}
         ${exclude ? sql`AND NOT (e.source_type IN (${sql.join(exclude.sourceTypes)}) AND e.source_id = ${exclude.sourceId})` : sql``}
    `.execute(ex);
    const have = toPaiseFromSql(rows[0]?.v ?? '0');
    if (!worst || have < worst.have) worst = { have, date: day };
  }
  const left = worst!.have - outPaise;
  if (left >= 0) return;
  enforce(policy,
    `${bank.name} would go below nil: ${rupees2(worst!.have)} in hand on ${dayLabel(worst!.date)}, ${rupees2(outPaise)} going out — short by ${rupees2(-left)}. ` +
      'Cash in hand cannot be less than nothing: record the cash that came in (a receipt, or a withdrawal from the bank) first, or pay from a bank account.',
    warnings, conflict);
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
  const limit = (transporter?.tds_section ?? '').split(',').map((x) => x.trim()).includes('194C') ? CASH_PAYMENT_LIMIT_TRANSPORT_PAISE : CASH_PAYMENT_LIMIT_PAISE;
  if (day <= limit) return;
  enforce((await getPolicies(ex, orgId)).cashLimits,
    `${rupees(day)} paid in cash to one person on ${date}. Above ${rupees(limit)} in a day, section 40A(3) disallows the expense.`,
    warnings, conflict);
}

/**
 * Segregation of duties: the person who entered a bill, or approved it, is not
 * the one who pays it. With one person able to make, approve and pay the same
 * bill, a made-up supplier and its bill can be paid out with nobody else ever
 * seeing it — the plainest of payment frauds, and the first thing an auditor
 * tests for.
 *
 * A book with one active user cannot split the duties at all, so it is not
 * told to; the Controls page shows that instead.
 */
export async function checkSegregation(
  ex: Executor, orgId: number, userId: number, billIds: number[], warnings: string[],
) {
  if (!billIds.length) return;
  const policy = (await getPolicies(ex, orgId)).controls.segregation;
  if (policy === 'off') return;
  const people = await ex.selectFrom('users').select((eb) => eb.fn.countAll<string>().as('n'))
    .where('org_id', '=', orgId).where('is_active', '=', 1).executeTakeFirstOrThrow();
  if (Number(people.n) < 2) return;
  const own = await ex.selectFrom('bills').select(['internal_no', 'created_by_user_id', 'approved_by_user_id'])
    .where('org_id', '=', orgId).where('id', 'in', billIds)
    .where((eb) => eb.or([eb('created_by_user_id', '=', userId), eb('approved_by_user_id', '=', userId)]))
    .execute();
  if (!own.length) return;
  const names = own.map((b) => b.internal_no).join(', ');
  const role = own.every((b) => Number(b.approved_by_user_id) === userId) ? 'approved' : 'entered';
  enforce(policy,
    `You ${role} ${names}. Someone else should pay ${own.length === 1 ? 'it' : 'them'}, so no one person makes, approves and pays the same bill.`,
    warnings, (m) => Object.assign(conflict(m), { code: 'segregation' }));
}

/**
 * Credit hold: a customer with something long past due is not given more on
 * credit until it is collected. A receivable 306 days old is a collection
 * failure that started with the invoice raised on day 91; this is the check
 * that stops that invoice (Settings → Controls: the days, and off, warn or block).
 */
export async function checkCreditHold(
  ex: Executor, orgId: number, customerId: number, date: string, warnings: string[], override = false,
) {
  const c = (await getPolicies(ex, orgId)).controls;
  if (c.creditHold === 'off' || c.creditHoldDays <= 0) return;
  const late = await ex.selectFrom('invoices').select(['number', 'due_date', sql<string>`total - amount_paid`.as('due')])
    .where('org_id', '=', orgId).where('customer_id', '=', customerId).where('status', 'not in', ['draft', 'void'])
    .where(sql<boolean>`total > amount_paid`).where(sql<boolean>`due_date <= DATE_SUB(${date}, INTERVAL ${c.creditHoldDays} DAY)`)
    .orderBy('due_date').execute();
  if (!late.length) return;
  const owed = late.reduce((t, r) => t + toPaiseFromSql(r.due), 0);
  const oldest = late[0];
  const message = `This customer has ${rupees(owed)} more than ${c.creditHoldDays} days past due (oldest ${oldest.number}, due ${String(oldest.due_date).slice(0, 10)}). Collect it before supplying more on credit.`;
  // An override is a manager's decision to supply anyway: let through, but said.
  enforce(override ? 'warn' : c.creditHold, message, warnings, (m) => Object.assign(conflict(m), { code: 'credit_hold' }));
}
