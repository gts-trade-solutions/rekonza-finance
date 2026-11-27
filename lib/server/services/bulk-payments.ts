import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Record bulk payments, as Zoho Books does from the Bills and Invoices lists
// (status review 7, item 6): pick many open bills, of one vendor or several,
// set what is paid on each (and any TDS deducted at payment), and one payment
// is recorded per vendor, settling its bills; the same for customers'
// invoices, one receipt per customer. Each payment goes to the bank or cash
// account chosen, so the bank's statement lines reconcile against them one
// for one (Banking → reconcile, matchEnteredPayments).
//
// All or nothing: a bill already paid, an amount over what is owed, or a
// document of another kind is refused by its number before anything posts.
// ─────────────────────────────────────────────────────────────────────────────

import type { Trx } from '../db';
import type { Paise } from '../../types';
import { toPaiseFromSql } from '../money-sql';
import { badRequest, notFound } from '../http';
import { makePayment, receivePayment, type PaymentMode } from './payments';

export interface BulkPaymentInput {
  side: 'received' | 'made';
  branchId: number;
  date: string;
  mode: PaymentMode;
  bankAccountId: number;
  /** One reference for all (a cheque run, a batch); each payment's own can follow it. */
  reference?: string | null;
  rows: { docId: number; amountPaise: Paise; tdsPaise?: Paise; reference?: string | null }[];
}

const rupees = (p: number) => `₹${(p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

export async function recordBulkPayments(trx: Trx, orgId: number, userId: number | null, input: BulkPaymentInput) {
  const rows = input.rows.filter((r) => r.amountPaise > 0 || (r.tdsPaise ?? 0) > 0);
  if (!rows.length) throw badRequest('Give an amount against at least one document.');
  const bank = await trx.selectFrom('bank_accounts').select(['id', 'name', 'is_active']).where('id', '=', input.bankAccountId).where('org_id', '=', orgId).executeTakeFirst();
  if (!bank || !bank.is_active) throw notFound('That bank or cash account is not one of yours.');
  const ids = [...new Set(rows.map((r) => r.docId))];
  if (ids.length !== rows.length) throw badRequest('A document is listed twice.');
  const docs = input.side === 'received'
    ? await trx.selectFrom('invoices as d').innerJoin('contacts as c', 'c.id', 'd.customer_id')
        .select(['d.id', 'd.number', 'd.customer_id as party_id', 'c.display_name', 'd.total', 'd.amount_paid', 'd.status'])
        .where('d.org_id', '=', orgId).where('d.id', 'in', ids).execute()
    : await trx.selectFrom('bills as d').innerJoin('contacts as c', 'c.id', 'd.vendor_id')
        .select(['d.id', 'd.internal_no as number', 'd.vendor_id as party_id', 'c.display_name', 'd.total', 'd.amount_paid', 'd.status'])
        .where('d.org_id', '=', orgId).where('d.id', 'in', ids).execute();
  const what = input.side === 'received' ? 'Invoice' : 'Bill';
  const byParty = new Map<number, { name: string; amount: number; tds: number; refs: string[]; allocations: { targetType: 'invoice' | 'bill'; targetId: number; amountPaise: number }[] }>();
  for (const r of rows) {
    const d = docs.find((x) => x.id === r.docId);
    if (!d) throw notFound(`That ${what.toLowerCase()} is not in your books.`);
    if (d.status === 'void' || d.status === 'draft') throw badRequest(`${what} ${d.number} is ${d.status}: nothing can be paid on it.`);
    const open = toPaiseFromSql(d.total) - toPaiseFromSql(d.amount_paid);
    if (open <= 0) throw badRequest(`${what} ${d.number} is paid already.`);
    const settles = r.amountPaise + (r.tdsPaise ?? 0);
    if (r.amountPaise < 0 || (r.tdsPaise ?? 0) < 0) throw badRequest(`${what} ${d.number}: an amount cannot be negative.`);
    if (settles > open) throw badRequest(`${what} ${d.number}: ${rupees(settles)} is more than the ${rupees(open)} still owed on it.`);
    const g = byParty.get(d.party_id) ?? { name: d.display_name, amount: 0, tds: 0, refs: [], allocations: [] };
    g.amount += r.amountPaise;
    g.tds += r.tdsPaise ?? 0;
    if (r.reference?.trim()) g.refs.push(r.reference.trim());
    g.allocations.push({ targetType: input.side === 'received' ? 'invoice' : 'bill', targetId: d.id, amountPaise: settles });
    byParty.set(d.party_id, g);
  }
  const made: { partyId: number; partyName: string; paymentId: number; number: string; amountPaise: number; tdsPaise: number; documents: number }[] = [];
  for (const [partyId, g] of byParty) {
    if (g.amount <= 0) throw badRequest(`${g.name}: a payment needs an amount above zero (TDS alone settles nothing in the bank).`);
    const payload = {
      branchId: input.branchId, contactId: partyId, date: input.date, mode: input.mode, amountPaise: g.amount, bankAccountId: bank.id,
      reference: g.refs[0] ?? input.reference?.trim() ?? null, tdsPaise: g.tds, allocations: g.allocations,
      notes: `Recorded with bulk ${input.side === 'received' ? 'receipts' : 'payments'}${input.reference ? ` (${input.reference})` : ''}`,
    };
    const p = await (input.side === 'received' ? receivePayment(trx, orgId, userId, payload) : makePayment(trx, orgId, userId, payload));
    made.push({ partyId, partyName: g.name, paymentId: p.id, number: p.number, amountPaise: g.amount, tdsPaise: g.tds, documents: g.allocations.length });
  }
  return made;
}
