import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Payments received and made, and the allocations that tie them to documents.
//
// A payment is stored separately from what it settles, because the two are
// genuinely independent: one receipt can clear three invoices and leave change
// on account, and one payment run can settle twenty bills. Storing the link on
// the invoice instead would make both impossible to record honestly.
//
// Money that arrives without a document to match is not lost — it becomes an
// advance, a liability, and sits in `unapplied_amount` until somebody applies
// it. Forcing every receipt to name an invoice is how customers' overpayments
// end up quietly absorbed into whichever invoice was nearest.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Trx } from '../db';
import type { Paise } from '../../types';
import { toPaiseFromSql, toSqlFromPaise } from '../money-sql';
import { allocateOrgNumber, postEntry, reverseEntry, type DraftLine } from '../ledger/posting';
import { CODE, accountIds, requireAccount } from '../ledger/chart-of-accounts';
import { ApiError, badRequest, notFound } from '../http';
import { fyLabelFor } from './sales';
import { checkCashPayment, checkCashReceipt } from './guards';
import { voidReason, voidStamp } from './void-reason';

export type PaymentMode =
  | 'cash' | 'cheque' | 'neft' | 'rtgs' | 'imps' | 'upi' | 'card' | 'netbanking' | 'other';

export type AllocationTarget = 'invoice' | 'bill' | 'credit_note' | 'vendor_credit' | 'retainer' | 'opening';

export interface AllocationInput {
  targetType: AllocationTarget;
  targetId: number;
  /** Rupees. For a foreign-currency payment it is worked out from `foreignAmountPaise`. */
  amountPaise: Paise;
  /** A foreign-currency payment: what it settles, in the document's currency (minor units). */
  foreignAmountPaise?: Paise;
}

export interface RecordPaymentInput {
  branchId: number;
  contactId: number;
  date: string;
  mode: PaymentMode;
  /** Gross: what the party parted with, before any TDS they withheld. */
  amountPaise: Paise;
  bankAccountId: number;
  reference?: string | null;
  tdsPaise?: Paise;
  bankChargesPaise?: Paise;
  allocations?: AllocationInput[];
  notes?: string | null;
  /**
   * A receipt in advance for services: GST is due on what is left unapplied,
   * now, at this rate. Advances for goods carry no GST (notification 66/2017).
   */
  advanceGst?: { ratePct: number; placeOfSupply?: string | null } | null;
  /**
   * Received or paid in another currency: the foreign amount and the rate it
   * was converted at. `amountPaise` is then the rupees that reached or left
   * the bank, and the difference from the rupee value of what it settles is a
   * realised exchange gain or loss.
   */
  fx?: { currency: string; rate: number; foreignAmountPaise: Paise } | null;
}

/**
 * Foreign allocations at the rupee value each document carries: its booked
 * rate, or exactly what is left of it when the allocation clears it, so a
 * settled document never keeps a stray paisa.
 */
async function atBookValue(trx: Trx, orgId: number, currency: string, allocations: AllocationInput[]) {
  let foreign = 0;
  const out: AllocationInput[] = [];
  for (const a of allocations) {
    if (a.targetType !== 'invoice' && a.targetType !== 'bill') {
      throw badRequest('A foreign-currency payment settles invoices or bills in that currency.');
    }
    const fc = a.foreignAmountPaise ?? 0;
    if (fc <= 0) throw badRequest('Give the amount each document is settled by, in its currency.');
    const doc = a.targetType === 'invoice'
      ? await trx.selectFrom('invoices').select(['number', 'currency', 'exchange_rate', 'fc_total', 'fc_amount_paid', 'total', 'amount_paid'])
        .where('id', '=', a.targetId).where('org_id', '=', orgId).executeTakeFirst()
      : await trx.selectFrom('bills').select(['internal_no as number', 'currency', 'exchange_rate', 'fc_total', 'fc_amount_paid', 'total', 'amount_paid'])
        .where('id', '=', a.targetId).where('org_id', '=', orgId).executeTakeFirst();
    if (!doc) throw notFound(`That ${a.targetType} does not exist.`);
    if (doc.currency !== currency) throw badRequest(`${doc.number} is in ${doc.currency}, not ${currency}.`);
    const fcOpen = toPaiseFromSql(doc.fc_total ?? '0') - toPaiseFromSql(doc.fc_amount_paid);
    if (fc > fcOpen) throw badRequest(`Only ${(fcOpen / 100).toFixed(2)} ${currency} of ${doc.number} is still owed.`);
    const inrOpen = toPaiseFromSql(doc.total) - toPaiseFromSql(doc.amount_paid);
    const book = fc === fcOpen ? inrOpen : Math.min(inrOpen, Math.round(fc * Number(doc.exchange_rate)));
    out.push({ ...a, amountPaise: book });
    foreign += fc;
  }
  return { allocations: out, foreign };
}

/** Keep each document's foreign paid figure in step with its rupee one. */
async function moveForeignPaid(trx: Trx, allocations: AllocationInput[], direction: 1 | -1) {
  for (const a of allocations) {
    if (!a.foreignAmountPaise) continue;
    const by = toSqlFromPaise(a.foreignAmountPaise * direction);
    if (a.targetType === 'invoice') {
      await trx.updateTable('invoices').set((eb) => ({ fc_amount_paid: eb('fc_amount_paid', '+', by) })).where('id', '=', a.targetId).execute();
    } else if (a.targetType === 'bill') {
      await trx.updateTable('bills').set((eb) => ({ fc_amount_paid: eb('fc_amount_paid', '+', by) })).where('id', '=', a.targetId).execute();
    }
  }
}

/** The exchange difference as a ledger line: on a receipt a positive one is a gain, on a payment a loss. */
function fxLine(acc: Record<string, number>, kind: 'received' | 'made', difference: Paise, memo: string): DraftLine | null {
  if (!difference) return null;
  const gain = kind === 'received' ? difference > 0 : difference < 0;
  const amount = Math.abs(difference);
  return gain
    ? { accountId: requireAccount(acc, CODE.FX_GAIN), credit: amount, description: memo }
    : { accountId: requireAccount(acc, CODE.FX_LOSS), debit: amount, description: memo };
}

/** What each kind of payment may settle. */
const TARGETS: Record<'received' | 'made', AllocationTarget[]> = {
  received: ['invoice', 'retainer', 'opening'],
  made: ['bill', 'opening'],
};
const TARGET_LABEL: Record<AllocationTarget, string> = {
  invoice: 'an invoice', bill: 'a bill', retainer: 'a retainer',
  credit_note: 'a credit note', vendor_credit: 'a vendor credit', opening: 'an opening bill',
};

/**
 * Record money received from a customer.
 *
 *   Dr Bank            what actually landed
 *   Dr TDS receivable  what the customer withheld and paid on our behalf
 *   Dr Bank charges    deducted in transit, if any
 *     Cr Accounts receivable   the invoice balance cleared
 *
 * TDS never reaches the bank, so it cannot be netted into the amount — but it
 * does settle the invoice, because the customer has discharged that much of
 * their debt by paying the government instead of us.
 */
export async function receivePayment(
  trx: Trx,
  orgId: number,
  userId: number | null,
  input: RecordPaymentInput,
): Promise<{ id: number; number: string; unappliedPaise: Paise; journalEntryId: number; warnings?: string[] }> {
  return recordPayment(trx, orgId, userId, input, 'received');
}

/** Record money paid to a vendor. The mirror image of a receipt. */
export async function makePayment(
  trx: Trx,
  orgId: number,
  userId: number | null,
  input: RecordPaymentInput,
): Promise<{ id: number; number: string; unappliedPaise: Paise; journalEntryId: number; warnings?: string[] }> {
  return recordPayment(trx, orgId, userId, input, 'made');
}

/** A party's open invoices (or bills), oldest due first, taken up to an amount. */
async function oldestFirst(trx: Trx, orgId: number, contactId: number, kind: 'received' | 'made', amount: Paise): Promise<AllocationInput[]> {
  const docs = kind === 'received'
    ? await trx.selectFrom('invoices').select(['id', 'total', 'amount_paid'])
        .where('org_id', '=', orgId).where('customer_id', '=', contactId).where('currency', '=', 'INR')
        .where('status', 'in', ['approved', 'sent', 'overdue', 'partially_paid'])
        .orderBy('due_date').orderBy('invoice_date').orderBy('id').execute()
    : await trx.selectFrom('bills').select(['id', 'total', 'amount_paid'])
        .where('org_id', '=', orgId).where('vendor_id', '=', contactId).where('currency', '=', 'INR')
        .where('status', 'in', ['open', 'overdue', 'partially_paid'])
        .orderBy('due_date').orderBy('bill_date').orderBy('id').execute();
  const out: AllocationInput[] = [];
  let left = amount;
  for (const d of docs) {
    if (left <= 0) break;
    const take = Math.min(left, toPaiseFromSql(d.total) - toPaiseFromSql(d.amount_paid));
    if (take <= 0) continue;
    out.push({ targetType: kind === 'received' ? 'invoice' : 'bill', targetId: d.id, amountPaise: take });
    left -= take;
  }
  return out;
}

async function recordPayment(
  trx: Trx,
  orgId: number,
  userId: number | null,
  input: RecordPaymentInput,
  kind: 'received' | 'made',
): Promise<{ id: number; number: string; unappliedPaise: Paise; journalEntryId: number; warnings?: string[] }> {
  if (input.amountPaise <= 0) throw badRequest('A payment needs an amount above zero.');

  const contact = await trx
    .selectFrom('contacts').select(['id', 'display_name', 'bill_wise'])
    .where('id', '=', input.contactId).where('org_id', '=', orgId).executeTakeFirst();
  if (!contact) throw notFound('That contact does not exist.');

  const bank = await trx
    .selectFrom('bank_accounts').select(['id', 'name', 'ledger_account_id', 'kind'])
    .where('id', '=', input.bankAccountId).where('org_id', '=', orgId).executeTakeFirst();
  if (!bank) throw notFound('That account does not exist.');

  // Cash over the statutory limits, under the book's own policy (guards.ts).
  const warnings: string[] = [];
  if (input.mode === 'cash' || bank.kind === 'cash') {
    if (kind === 'received') await checkCashReceipt(trx, orgId, input.contactId, input.date, input.amountPaise, warnings);
    else await checkCashPayment(trx, orgId, input.contactId, input.date, input.amountPaise, warnings);
  }

  const tds = input.tdsPaise ?? 0;
  const charges = input.bankChargesPaise ?? 0;
  let allocations = input.allocations ?? [];

  // In another currency the documents are settled at their own rupee value,
  // and whatever is left over is an advance at this payment's rate.
  const fx = input.fx ? { ...input.fx, currency: input.fx.currency.trim().toUpperCase() } : null;
  let fxUnapplied = 0;
  if (fx) {
    if (!/^[A-Z]{3}$/.test(fx.currency) || fx.currency === 'INR') throw badRequest('A foreign payment needs its currency, such as USD.');
    if (!(fx.rate > 0) || !(fx.foreignAmountPaise > 0)) throw badRequest('Give the foreign amount and the rate it was converted at.');
    const booked = await atBookValue(trx, orgId, fx.currency, allocations);
    if (booked.foreign > fx.foreignAmountPaise) {
      throw badRequest(`You have applied ${(booked.foreign / 100).toFixed(2)} ${fx.currency} of a payment of ${(fx.foreignAmountPaise / 100).toFixed(2)}.`);
    }
    allocations = booked.allocations;
    fxUnapplied = Math.round((fx.foreignAmountPaise - booked.foreign) * fx.rate);
  }

  // A party not kept bill-wise names no bills: what it pays settles its
  // oldest open documents first, as far as it goes.
  if (!contact.bill_wise && !allocations.length && !fx) {
    allocations = await oldestFirst(trx, orgId, input.contactId, kind, input.amountPaise + tds);
  }

  // The settling power of a receipt is the cash plus the TDS: both reduce what
  // the customer owes, even though only one of them reaches the bank. In
  // another currency it is the rupee value of what it settles.
  const allocated = allocations.reduce((t, a) => t + a.amountPaise, 0);
  const settles = fx ? allocated + fxUnapplied : input.amountPaise + tds;
  const fxDifference = fx ? input.amountPaise + tds - settles : 0;

  if (allocated > settles) {
    throw badRequest(
      `You have allocated ${(allocated / 100).toFixed(2)} against a payment worth ` +
        `${(settles / 100).toFixed(2)}. Reduce the allocation, or increase the payment.`,
    );
  }
  for (const a of allocations) {
    if (a.amountPaise <= 0) throw badRequest('An allocation must be for more than zero.');
  }

  const unapplied = settles - allocated;

  // Org-wide, matching uq_pay_org_number. A receipt is an internal document;
  // unlike an invoice it carries no per-registration numbering obligation.
  const prefix = kind === 'received' ? 'RCPT' : 'PAY';
  const number = await allocateOrgNumber(trx, orgId, prefix, fyLabelFor(input.date), prefix);

  const inserted = await trx
    .insertInto('payments')
    .values({
      org_id: orgId,
      branch_id: input.branchId,
      number,
      kind,
      contact_id: input.contactId,
      payment_date: input.date,
      mode: input.mode,
      amount: toSqlFromPaise(input.amountPaise),
      bank_account_id: input.bankAccountId,
      reference: input.reference ?? null,
      tds_amount: toSqlFromPaise(tds),
      bank_charges: toSqlFromPaise(charges),
      unapplied_amount: toSqlFromPaise(unapplied),
      ...(fx ? {
        currency: fx.currency, exchange_rate: String(fx.rate), fc_amount: toSqlFromPaise(fx.foreignAmountPaise),
        fx_difference: toSqlFromPaise(fxDifference),
      } : {}),
      status: 'cleared',
      notes: input.notes ?? null,
      created_by_user_id: userId,
    })
    .executeTakeFirstOrThrow();
  const paymentId = Number(inserted.insertId);

  // A cheque in the register with this number, from this party, is the paper
  // this payment came on. Linking the two is what lets a bounce later undo the
  // right receipt instead of leaving the invoice marked paid.
  const chequeNo = input.reference?.trim();
  if (input.mode === 'cheque' && chequeNo) {
    await trx.updateTable('cheques').set({ payment_id: paymentId })
      .where('org_id', '=', orgId).where('contact_id', '=', input.contactId)
      .where('kind', '=', kind === 'received' ? 'received' : 'issued')
      .where('cheque_no', '=', chequeNo)
      .where('payment_id', 'is', null)
      .where('status', 'not in', ['bounced', 'cancelled'])
      .limit(1)
      .execute();
  }

  if (allocations.length) {
    await trx
      .insertInto('payment_allocations')
      .values(
        allocations.map((a) => ({
          org_id: orgId,
          payment_id: paymentId,
          target_type: a.targetType,
          target_id: a.targetId,
          amount: toSqlFromPaise(a.amountPaise),
          fc_amount: a.foreignAmountPaise ? toSqlFromPaise(a.foreignAmountPaise) : null,
          applied_on: input.date,
          created_by_user_id: userId,
        })),
      )
      .execute();

    await applyAllocations(trx, orgId, allocations, +1, { kind, contactId: input.contactId });
    await moveForeignPaid(trx, allocations, 1);
  }

  const acc = await accountIds(trx, orgId);
  const draft: DraftLine[] = [];

  // GST on an advance for services, worked out of the amount (which includes
  // it) and owed now. Held as an asset until the invoice charges it again.
  if (input.advanceGst && kind === 'received') {
    if (unapplied <= 0) throw badRequest('Nothing is left as an advance, so there is no GST on an advance to pay.');
    const rate = input.advanceGst.ratePct;
    if (!(rate > 0 && rate <= 40)) throw badRequest('Give the GST rate of the services the advance is for.');
    const branch = await trx.selectFrom('branches').select(['state_code'])
      .where('id', '=', input.branchId).where('org_id', '=', orgId).executeTakeFirstOrThrow();
    const party = await trx.selectFrom('contacts').select(['state_code'])
      .where('id', '=', input.contactId).executeTakeFirstOrThrow();
    const pos = input.advanceGst.placeOfSupply || party.state_code || branch.state_code;
    const tax = Math.round((unapplied * rate) / (100 + rate));
    const sgst = pos === branch.state_code ? Math.floor(tax / 2) : 0;
    const t = pos === branch.state_code ? { cgst: tax - sgst, sgst, igst: 0 } : { cgst: 0, sgst: 0, igst: tax };

    draft.push({ accountId: requireAccount(acc, CODE.GST_ON_ADVANCES), debit: tax, description: `GST on advance ${number}` });
    if (t.cgst) draft.push({ accountId: requireAccount(acc, CODE.GST_CGST), credit: t.cgst, description: `On advance ${number}` });
    if (t.sgst) draft.push({ accountId: requireAccount(acc, CODE.GST_SGST), credit: t.sgst, description: `On advance ${number}` });
    if (t.igst) draft.push({ accountId: requireAccount(acc, CODE.GST_IGST), credit: t.igst, description: `On advance ${number}` });

    await trx.updateTable('payments').set({
      advance_gst: 1,
      advance_rate_pct: String(rate),
      advance_pos: pos,
      advance_amount: toSqlFromPaise(unapplied),
      advance_cgst: toSqlFromPaise(t.cgst),
      advance_sgst: toSqlFromPaise(t.sgst),
      advance_igst: toSqlFromPaise(t.igst),
    }).where('id', '=', paymentId).execute();
  }

  if (kind === 'received') {
    draft.push({
      accountId: bank.ledger_account_id,
      debit: input.amountPaise - charges,
      description: `Received from ${contact.display_name}`,
    });
    if (charges > 0) draft.push({ accountId: requireAccount(acc, CODE.BANK_CHARGES), debit: charges });
    if (tds > 0) {
      draft.push({
        accountId: requireAccount(acc, CODE.TDS_RECEIVABLE),
        debit: tds,
        description: 'TDS deducted by customer',
      });
    }
    draft.push({
      accountId: requireAccount(acc, CODE.AR),
      credit: settles,
      contactId: input.contactId,
      description: number,
    });
  } else {
    draft.push({
      accountId: requireAccount(acc, CODE.AP),
      debit: settles,
      contactId: input.contactId,
      description: number,
    });
    if (tds > 0) {
      // TDS we withheld is not paid to the vendor; it is owed to the government.
      draft.push({
        accountId: requireAccount(acc, CODE.TDS_PAYABLE),
        credit: tds,
        description: 'TDS withheld on payment',
      });
    }
    if (charges > 0) draft.push({ accountId: requireAccount(acc, CODE.BANK_CHARGES), debit: charges });
    draft.push({
      accountId: bank.ledger_account_id,
      credit: input.amountPaise + charges,
      description: `Paid to ${contact.display_name}`,
    });
  }

  const fxl = fxLine(acc, kind, fxDifference, `Exchange difference on ${number}`);
  if (fxl) draft.push(fxl);

  const entry = await postEntry(trx, {
    orgId,
    branchId: input.branchId,
    date: input.date,
    memo: `${kind === 'received' ? 'Receipt' : 'Payment'} ${number} — ${contact.display_name}`,
    sourceType: kind === 'received' ? 'payment_received' : 'payment_made',
    sourceId: paymentId,
    userId,
    module: kind === 'received' ? 'sales' : 'purchases',
    lines: draft,
  });

  await trx
    .updateTable('payments').set({ journal_entry_id: entry.id })
    .where('id', '=', paymentId).execute();

  return { id: paymentId, number, unappliedPaise: unapplied, journalEntryId: entry.id, warnings };
}

/**
 * Move each target's paid figure and recompute its status.
 *
 * `direction` is +1 when applying and -1 when a payment is reversed, so the
 * same code undoes what it did rather than a second near-copy of it drifting.
 * Bill-wise journals settle documents through it too (journals.ts).
 */
export async function applyAllocations(
  trx: Trx,
  orgId: number,
  allocations: AllocationInput[],
  direction: 1 | -1,
  payment: { kind: 'received' | 'made'; contactId: number },
): Promise<void> {
  for (const a of allocations) {
    const delta = a.amountPaise * direction;

    // A receipt settles what the customer owes; a payment, what we owe the
    // vendor. Credit notes and vendor credits are settled by a refund instead.
    if (!TARGETS[payment.kind].includes(a.targetType)) {
      throw badRequest(
        `A ${payment.kind === 'received' ? 'receipt' : 'payment'} cannot be set against ${TARGET_LABEL[a.targetType]}.` +
          (a.targetType === 'credit_note' || a.targetType === 'vendor_credit' ? ' Record a refund on the note instead.' : ''),
      );
    }

    if (a.targetType === 'invoice') {
      const inv = await trx
        .selectFrom('invoices').select(['id', 'number', 'total', 'amount_paid', 'status', 'due_date', 'customer_id'])
        .where('id', '=', a.targetId).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
      if (!inv) throw notFound(`Invoice ${a.targetId} not found.`);
      if (inv.customer_id !== payment.contactId) {
        throw badRequest(`Invoice ${inv.number} is for another customer. Money from one customer cannot settle another's invoice.`);
      }
      if (direction > 0 && (inv.status === 'draft' || inv.status === 'void')) {
        throw badRequest(`Invoice ${inv.number} is ${inv.status === 'draft' ? 'still a draft' : 'void'}, so nothing can be set against it.`);
      }

      const paid = toPaiseFromSql(inv.amount_paid) + delta;
      const total = toPaiseFromSql(inv.total);
      if (paid > total) {
        throw new ApiError(
          409,
          `That would allocate more than invoice ${a.targetId} is worth. ` +
            'Leave the extra on account instead — it stays available for the next invoice.',
          'over_allocated',
        );
      }

      await trx
        .updateTable('invoices')
        .set({
          amount_paid: toSqlFromPaise(paid),
          status: paid >= total ? 'paid' : paid > 0 ? 'partially_paid' : 'sent',
        })
        .where('id', '=', a.targetId)
        .execute();
    } else if (a.targetType === 'bill') {
      const bill = await trx
        .selectFrom('bills').select(['id', 'internal_no', 'total', 'amount_paid', 'status', 'vendor_id', 'match_status', 'match_note'])
        .where('id', '=', a.targetId).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
      if (!bill) throw notFound(`Bill ${a.targetId} not found.`);
      if (bill.vendor_id !== payment.contactId) {
        throw badRequest(`Bill ${bill.internal_no} is from another vendor. A payment to one vendor cannot settle another's bill.`);
      }
      if (direction > 0 && (bill.status === 'draft' || bill.status === 'void')) {
        throw badRequest(`Bill ${bill.internal_no} is ${bill.status === 'draft' ? 'still a draft' : 'void'}, so nothing can be set against it.`);
      }
      if (direction > 0 && bill.match_status === 'exception') {
        throw badRequest(
          `Bill ${bill.internal_no} does not agree with its order or receipt. ${bill.match_note ?? ''} ` +
            'Someone with approval rights must accept it before it is paid.',
        );
      }

      const paid = toPaiseFromSql(bill.amount_paid) + delta;
      const total = toPaiseFromSql(bill.total);
      if (paid > total) {
        throw new ApiError(409, `That would pay more than bill ${a.targetId} is worth.`, 'over_allocated');
      }

      await trx
        .updateTable('bills')
        .set({
          amount_paid: toSqlFromPaise(paid),
          status: paid >= total ? 'paid' : paid > 0 ? 'partially_paid' : 'open',
        })
        .where('id', '=', a.targetId)
        .execute();
    } else if (a.targetType === 'opening') {
      // A bill from before the books started, carried in as an opening.
      const d = await trx
        .selectFrom('opening_documents').select(['id', 'ref_no', 'kind', 'amount', 'amount_paid', 'status', 'contact_id'])
        .where('id', '=', a.targetId).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
      if (!d) throw notFound(`Opening bill ${a.targetId} not found.`);
      if (d.contact_id !== payment.contactId) {
        throw badRequest(`Opening bill ${d.ref_no} belongs to another ${payment.kind === 'received' ? 'customer' : 'vendor'}.`);
      }
      if ((d.kind === 'receivable') !== (payment.kind === 'received')) {
        throw badRequest(`${d.ref_no} is money ${d.kind === 'receivable' ? 'owed to us' : 'we owe'}; a ${payment.kind === 'received' ? 'receipt' : 'payment'} cannot settle it.`);
      }
      if (direction > 0 && d.status === 'void') throw badRequest(`Opening bill ${d.ref_no} was withdrawn.`);
      const total = toPaiseFromSql(d.amount);
      const paid = toPaiseFromSql(d.amount_paid) + delta;
      if (paid > total) throw new ApiError(409, `That would settle more than opening bill ${d.ref_no} is worth.`, 'over_allocated');
      await trx.updateTable('opening_documents')
        .set({ amount_paid: toSqlFromPaise(paid), status: paid >= total ? 'paid' : paid > 0 ? 'partially_paid' : 'open' })
        .where('id', '=', a.targetId).execute();
    } else if (a.targetType === 'retainer') {
      // Receiving money against a retainer settles the receivable. It does not
      // spend the advance — that happens later, when work is invoiced and the
      // retainer is applied against it. Two different columns, deliberately.
      const r = await trx
        .selectFrom('retainer_invoices').select(['id', 'amount', 'amount_paid', 'applied_amount', 'customer_id'])
        .where('id', '=', a.targetId).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
      if (!r) throw notFound(`Retainer ${a.targetId} not found.`);
      if (r.customer_id !== payment.contactId) {
        throw badRequest('That retainer is for another customer.');
      }

      const total = toPaiseFromSql(r.amount);
      const paid = toPaiseFromSql(r.amount_paid) + delta;
      if (paid > total) {
        throw new ApiError(
          409,
          `That would collect more than retainer ${a.targetId} is worth. ` +
            'Leave the extra on account instead.',
          'over_allocated',
        );
      }
      const applied = toPaiseFromSql(r.applied_amount);

      await trx
        .updateTable('retainer_invoices')
        .set({
          amount_paid: toSqlFromPaise(paid),
          status:
            applied >= total ? 'applied'
            : applied > 0 ? 'partially_applied'
            : paid >= total ? 'paid'
            : 'sent',
        })
        .where('id', '=', a.targetId)
        .execute();
    }
  }
}

/**
 * Void a payment: reverse its entry and give back what it had settled.
 *
 * The invoices it paid go back to being unpaid, which is the part that is easy
 * to forget — a reversed receipt that leaves an invoice marked paid is money
 * nobody will ever chase.
 *
 * `opts.date` dates the reversal. Left out, it is the payment's own date, which
 * is right for a receipt entered by mistake. A bounced cheque is different: the
 * money did reach the bank and left again on the day it was returned, and the
 * statement shows both, so the reversal belongs on that day.
 */
export async function voidPayment(
  trx: Trx,
  orgId: number,
  userId: number | null,
  paymentId: number,
  reason?: string,
  opts: { date?: string } = {},
): Promise<void> {
  const payment = await trx
    .selectFrom('payments').select(['id', 'number', 'kind', 'status', 'journal_entry_id', 'contact_id', 'payment_date'])
    .where('id', '=', paymentId).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!payment) throw notFound('Payment not found.');
  if (payment.status === 'void') throw new ApiError(409, 'That payment is already void.', 'conflict');
  const paidOn = String(payment.payment_date).slice(0, 10);
  if (opts.date && opts.date < paidOn) {
    throw badRequest(`${payment.number} is dated ${paidOn}; it cannot be reversed on an earlier day.`);
  }
  const why = voidReason(reason);

  const allocations = await trx
    .selectFrom('payment_allocations')
    .select(['id', 'target_type', 'target_id', 'amount', 'fc_amount'])
    .where('payment_id', '=', paymentId)
    .execute();

  const undo = allocations.map((a) => ({
    targetType: a.target_type as AllocationTarget,
    targetId: a.target_id,
    amountPaise: toPaiseFromSql(a.amount),
    foreignAmountPaise: a.fc_amount === null ? undefined : toPaiseFromSql(a.fc_amount),
  }));
  await applyAllocations(trx, orgId, undo, -1, { kind: payment.kind, contactId: payment.contact_id });
  await moveForeignPaid(trx, undo, -1);
  for (const a of allocations) await reverseAdvanceTax(trx, orgId, userId, a.id, `Void of ${payment.number}`, opts.date);

  if (payment.journal_entry_id) {
    await reverseEntry(trx, orgId, payment.journal_entry_id, {
      date: opts.date,
      memo: `Void of ${payment.number} — ${why}`,
      userId,
      module: payment.kind === 'received' ? 'sales' : 'purchases',
    });
  }

  await trx.updateTable('payments').set({ status: 'void', ...voidStamp(why, userId) }).where('id', '=', paymentId).execute();
}

// ── Applying an advance later ────────────────────────────────────────────────

/**
 * Set money already received (or paid) against documents raised since.
 *
 * Nothing new is posted for the money itself: the receipt credited the
 * customer in full when it arrived, so the ledger already shows them owing
 * less. Applying it only says which invoice that money was for, which is what
 * ageing, reminders and the invoice's own status go by.
 *
 * The exception is GST on an advance for services. That tax was paid when the
 * money arrived; the invoice now charges it again, so the advance's share is
 * taken back here, dated the day it is applied.
 */
export async function applyPayment(
  trx: Trx,
  orgId: number,
  userId: number | null,
  paymentId: number,
  input: { date: string; allocations: AllocationInput[] },
): Promise<{ unappliedPaise: Paise; allocationIds: number[] }> {
  const payment = await trx
    .selectFrom('payments')
    .select(['id', 'number', 'kind', 'status', 'contact_id', 'branch_id', 'payment_date', 'unapplied_amount', 'advance_gst', 'currency', 'exchange_rate', 'fc_amount'])
    .where('id', '=', paymentId).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!payment) throw notFound('Payment not found.');
  if (payment.status === 'void') throw badRequest('That payment is void.');
  if (!input.allocations.length) throw badRequest('Choose at least one document to apply it to.');

  const paidOn = String(payment.payment_date).slice(0, 10);
  if (input.date < paidOn) {
    throw badRequest(`It cannot be applied before it was ${payment.kind === 'received' ? 'received' : 'paid'}, on ${paidOn}.`);
  }

  const unapplied = toPaiseFromSql(payment.unapplied_amount);
  let allocations = input.allocations;
  // A foreign advance applied later: each document at its own rupee value, the
  // advance released at the rate it came in at, and the difference posted.
  let released: Paise;
  let fxDifference = 0;
  if (payment.currency !== 'INR') {
    const prior = await trx.selectFrom('payment_allocations').select(sql<string>`COALESCE(SUM(fc_amount), 0)`.as('fc'))
      .where('payment_id', '=', paymentId).executeTakeFirst();
    const fcLeft = toPaiseFromSql(payment.fc_amount ?? '0') - toPaiseFromSql(prior?.fc ?? '0');
    const booked = await atBookValue(trx, orgId, payment.currency, input.allocations);
    if (booked.foreign > fcLeft) {
      throw badRequest(`Only ${(fcLeft / 100).toFixed(2)} ${payment.currency} of ${payment.number} is left to apply.`);
    }
    allocations = booked.allocations;
    released = booked.foreign === fcLeft ? unapplied : Math.round(booked.foreign * Number(payment.exchange_rate));
    fxDifference = released - allocations.reduce((t, a) => t + a.amountPaise, 0);
  } else {
    released = input.allocations.reduce((t, a) => t + a.amountPaise, 0);
    for (const a of input.allocations) {
      if (!(a.amountPaise > 0)) throw badRequest('Each amount applied must be more than zero.');
    }
    if (released > unapplied) {
      throw badRequest(
        `Only ${(unapplied / 100).toFixed(2)} of ${payment.number} is left to apply; ` +
          `this applies ${(released / 100).toFixed(2)}.`,
      );
    }
  }

  await applyAllocations(trx, orgId, allocations, +1, { kind: payment.kind, contactId: payment.contact_id });
  await moveForeignPaid(trx, allocations, 1);

  if (fxDifference) {
    const acc = await accountIds(trx, orgId);
    const control = payment.kind === 'received' ? CODE.AR : CODE.AP;
    // What the advance released and what the documents cleared differ by the
    // exchange difference; the party's balance is brought back to nil with it.
    const partyDebit = payment.kind === 'received' ? fxDifference > 0 : fxDifference < 0;
    await postEntry(trx, {
      orgId, branchId: payment.branch_id, date: input.date, userId, module: payment.kind === 'received' ? 'sales' : 'purchases',
      memo: `Exchange difference applying ${payment.number}`, sourceType: 'fx_settlement', sourceId: paymentId,
      lines: [
        partyDebit
          ? { accountId: requireAccount(acc, control), debit: Math.abs(fxDifference), contactId: payment.contact_id }
          : { accountId: requireAccount(acc, control), credit: Math.abs(fxDifference), contactId: payment.contact_id },
        fxLine(acc, payment.kind, fxDifference, `Exchange difference applying ${payment.number}`)!,
      ],
    });
  }

  const allocationIds: number[] = [];
  for (const a of allocations) {
    if (a.targetType === 'invoice') {
      const inv = await trx.selectFrom('invoices').select(['number', 'invoice_date'])
        .where('id', '=', a.targetId).executeTakeFirstOrThrow();
      const issued = String(inv.invoice_date).slice(0, 10);
      if (input.date < issued) {
        throw badRequest(`Invoice ${inv.number} is dated ${issued}; the advance cannot be applied to it before then.`);
      }
    }
    const id = Number((await trx.insertInto('payment_allocations').values({
      org_id: orgId,
      payment_id: paymentId,
      target_type: a.targetType,
      target_id: a.targetId,
      amount: toSqlFromPaise(a.amountPaise),
      fc_amount: a.foreignAmountPaise ? toSqlFromPaise(a.foreignAmountPaise) : null,
      applied_on: input.date,
      created_by_user_id: userId,
    }).executeTakeFirstOrThrow()).insertId);
    allocationIds.push(id);
    if (payment.advance_gst && a.targetType === 'invoice') {
      await adjustAdvanceTax(trx, orgId, userId, paymentId, id, a.targetId, a.amountPaise, input.date);
    }
  }

  const left = unapplied - released;
  await trx.updateTable('payments').set({ unapplied_amount: toSqlFromPaise(left) }).where('id', '=', paymentId).execute();
  return { unappliedPaise: left, allocationIds };
}

/**
 * Undo one application: the document goes back to owing that much, and the
 * money is free to apply again. For a correction, not a refund.
 */
export async function unapplyAllocation(
  trx: Trx,
  orgId: number,
  userId: number | null,
  allocationId: number,
): Promise<{ paymentId: number; unappliedPaise: Paise }> {
  const alloc = await trx
    .selectFrom('payment_allocations')
    .select(['id', 'payment_id', 'target_type', 'target_id', 'amount', 'fc_amount'])
    .where('id', '=', allocationId).where('org_id', '=', orgId).executeTakeFirst();
  if (!alloc) throw notFound('That application was not found.');
  // A foreign settlement posted its own exchange difference with the payment;
  // taking one document out of it would leave that figure wrong.
  if (alloc.fc_amount !== null) {
    throw badRequest('This was settled in a foreign currency. Void the payment and record it again instead.');
  }

  const payment = await trx
    .selectFrom('payments').select(['id', 'number', 'kind', 'status', 'contact_id', 'unapplied_amount'])
    .where('id', '=', alloc.payment_id).forUpdate().executeTakeFirstOrThrow();
  if (payment.status === 'void') throw badRequest('That payment is void; there is nothing to undo.');

  const amount = toPaiseFromSql(alloc.amount);
  await applyAllocations(
    trx, orgId,
    [{ targetType: alloc.target_type as AllocationTarget, targetId: alloc.target_id, amountPaise: amount }],
    -1, { kind: payment.kind, contactId: payment.contact_id },
  );
  await reverseAdvanceTax(trx, orgId, userId, allocationId, `Undone: ${payment.number} applied to ${alloc.target_type} ${alloc.target_id}`);
  await trx.deleteFrom('payment_allocations').where('id', '=', allocationId).execute();

  const left = toPaiseFromSql(payment.unapplied_amount) + amount;
  await trx.updateTable('payments').set({ unapplied_amount: toSqlFromPaise(left) }).where('id', '=', payment.id).execute();
  return { paymentId: payment.id, unappliedPaise: left };
}

/** Take back the GST paid on the part of an advance now set against an invoice. */
async function adjustAdvanceTax(
  trx: Trx, orgId: number, userId: number | null,
  paymentId: number, allocationId: number, invoiceId: number, amountPaise: Paise, date: string,
) {
  const p = await trx.selectFrom('payments')
    .select(['number', 'branch_id', 'advance_amount', 'advance_cgst', 'advance_sgst', 'advance_igst'])
    .where('id', '=', paymentId).executeTakeFirstOrThrow();
  const done = await trx.selectFrom('advance_tax_adjustments')
    .select([
      sql<string>`COALESCE(SUM(amount), 0)`.as('amount'), sql<string>`COALESCE(SUM(cgst), 0)`.as('cgst'),
      sql<string>`COALESCE(SUM(sgst), 0)`.as('sgst'), sql<string>`COALESCE(SUM(igst), 0)`.as('igst'),
    ])
    .where('payment_id', '=', paymentId).where('reversed_at', 'is', null)
    .executeTakeFirstOrThrow();

  const advance = toPaiseFromSql(p.advance_amount);
  const remaining = advance - toPaiseFromSql(done.amount);
  const portion = Math.min(amountPaise, remaining);
  if (portion <= 0 || advance <= 0) return;

  // The last part takes whatever tax is left, so rounding never strands a paisa.
  const head = (all: string, used: string) => {
    const left = toPaiseFromSql(all) - toPaiseFromSql(used);
    return portion === remaining ? left : Math.min(left, Math.round((toPaiseFromSql(all) * portion) / advance));
  };
  const cgst = head(p.advance_cgst, done.cgst);
  const sgst = head(p.advance_sgst, done.sgst);
  const igst = head(p.advance_igst, done.igst);
  const tax = cgst + sgst + igst;

  let entryId: number | null = null;
  if (tax > 0) {
    const acc = await accountIds(trx, orgId);
    const lines: DraftLine[] = [];
    if (cgst) lines.push({ accountId: requireAccount(acc, CODE.GST_CGST), debit: cgst });
    if (sgst) lines.push({ accountId: requireAccount(acc, CODE.GST_SGST), debit: sgst });
    if (igst) lines.push({ accountId: requireAccount(acc, CODE.GST_IGST), debit: igst });
    lines.push({ accountId: requireAccount(acc, CODE.GST_ON_ADVANCES), credit: tax, description: `Advance ${p.number} applied` });
    entryId = (await postEntry(trx, {
      orgId, branchId: p.branch_id, date,
      memo: `GST on advance ${p.number}, now charged on the invoice`,
      sourceType: 'advance_adjustment', sourceId: paymentId, userId, module: 'sales', lines,
    })).id;
  }

  await trx.insertInto('advance_tax_adjustments').values({
    org_id: orgId, payment_id: paymentId, allocation_id: allocationId, invoice_id: invoiceId,
    adjusted_on: date, amount: toSqlFromPaise(portion),
    cgst: toSqlFromPaise(cgst), sgst: toSqlFromPaise(sgst), igst: toSqlFromPaise(igst),
    journal_entry_id: entryId,
  }).execute();
}

async function reverseAdvanceTax(
  trx: Trx, orgId: number, userId: number | null, allocationId: number, memo: string, date?: string,
) {
  const rows = await trx.selectFrom('advance_tax_adjustments')
    .select(['id', 'journal_entry_id', 'adjusted_on'])
    .where('org_id', '=', orgId).where('allocation_id', '=', allocationId).where('reversed_at', 'is', null)
    .execute();
  for (const r of rows) {
    // Never earlier than the adjustment it undoes.
    const adjusted = String(r.adjusted_on).slice(0, 10);
    const on = date && date > adjusted ? date : undefined;
    const reversal = r.journal_entry_id
      ? await reverseEntry(trx, orgId, r.journal_entry_id, { date: on, memo, userId, module: 'sales' })
      : null;
    await trx.updateTable('advance_tax_adjustments')
      .set({ reversed_at: new Date(), reversal_entry_id: reversal?.id ?? null })
      .where('id', '=', r.id).execute();
  }
}
