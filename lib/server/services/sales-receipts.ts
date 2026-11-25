import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// A sales receipt: a sale paid for at the counter — cash, UPI, a card — so the
// invoice and the money are recorded together, in one transaction, and the
// invoice is born settled.
//
// It is still a tax invoice. Rule 46 does not care how quickly a customer
// pays, so the sale gets its number from the invoice series, its IRN if one is
// due, and its place in GSTR-1; the receipt is an ordinary payment received,
// allocated to it in full. `paid_at_sale` marks the pair so the Sales receipts
// list can find them.
// ─────────────────────────────────────────────────────────────────────────────

import type { Trx } from '../db';
import { ApiError, badRequest, notFound } from '../http';
import { createInvoice, deleteInvoice, updateInvoice, type CreateInvoiceInput } from './sales';
import { deletePayment, receivePayment, updatePayment, type PaymentMode } from './payments';

export interface PaidAtSale {
  mode: PaymentMode;
  bankAccountId: number;
  reference?: string | null;
}

export async function createSalesReceipt(
  trx: Trx,
  orgId: number,
  userId: number | null,
  input: CreateInvoiceInput,
  paid: PaidAtSale,
) {
  if (input.docKind === 'debit_note') throw badRequest('A debit note is settled against the account, not paid at the counter.');
  if ((input.currency ?? 'INR').toUpperCase() !== 'INR') {
    throw badRequest('A sale in another currency is paid at its own rate: issue the invoice, then record the receipt on it.');
  }
  const inv = await createInvoice(trx, orgId, userId, { ...input, status: 'approved', holdForApproval: false });
  if (!inv.journalEntryId) {
    throw badRequest('The sale could not be issued, so there is nothing to record the payment against.');
  }
  const pay = await receivePayment(trx, orgId, userId, {
    branchId: input.branchId,
    contactId: input.customerId,
    date: input.date,
    mode: paid.mode,
    amountPaise: inv.totalPaise,
    bankAccountId: paid.bankAccountId,
    reference: paid.reference ?? null,
    allocations: [{ targetType: 'invoice', targetId: inv.id, amountPaise: inv.totalPaise }],
  });
  await trx.updateTable('invoices').set({ paid_at_sale: 1 }).where('id', '=', inv.id).execute();
  return { ...inv, payment: { id: pay.id, number: pay.number }, warnings: [...(inv.warnings ?? []), ...(pay.warnings ?? [])] };
}

// ── Edit and Delete, as Zoho Books has them on a sales receipt ──────────────
//
// The receipt is one thing to the person at the counter, two in the books: a
// tax invoice and a payment received, allocated to it in full. Edit changes
// both together — the payment comes off the invoice, the invoice is reversed
// and posted again as corrected, and the payment is recorded again for the new
// total, the same number on each. Delete takes the payment back first, then
// the invoice: each entry reversed, each kept in deleted_documents, the
// invoice number still counted as cancelled in GSTR-1. The invoice's own rules
// still hold (an IRN, an e-way bill, a credit note against it), as do the
// payment's (matched to a bank line, refunded in part).

/** The payments taken at the counter for this receipt: those allocated to it and to nothing else. */
async function counterPayments(trx: Trx, orgId: number, invoiceId: number, number: string) {
  const allocs = await trx.selectFrom('payment_allocations as a').innerJoin('payments as p', 'p.id', 'a.payment_id')
    .select(['p.id', 'p.number']).where('a.org_id', '=', orgId).where('a.target_type', '=', 'invoice').where('a.target_id', '=', invoiceId).execute();
  for (const a of allocs) {
    const other = await trx.selectFrom('payment_allocations').select('id').where('payment_id', '=', a.id)
      .where((eb) => eb.or([eb('target_type', '<>', 'invoice'), eb('target_id', '<>', invoiceId)])).executeTakeFirst();
    if (other) {
      throw new ApiError(409, `${a.number} pays ${number} and other documents too. Change it in Payments received first.`, 'locked_document');
    }
  }
  return [...new Set(allocs.map((a) => a.id))];
}

async function receiptInvoice(trx: Trx, orgId: number, invoiceId: number) {
  const inv = await trx.selectFrom('invoices').select(['id', 'number', 'paid_at_sale', 'status'])
    .where('id', '=', invoiceId).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!inv) throw notFound('That sales receipt does not exist.');
  if (!inv.paid_at_sale) throw badRequest(`${inv.number} is an invoice, not a sales receipt.`);
  return inv;
}

/** Edit a sales receipt: the invoice and its counter payment, together, under their own numbers. */
export async function updateSalesReceipt(
  trx: Trx, orgId: number, userId: number | null, invoiceId: number, input: CreateInvoiceInput, paid: PaidAtSale,
) {
  if ((input.currency ?? 'INR').toUpperCase() !== 'INR') throw badRequest('A sales receipt is in rupees.');
  if (input.docKind === 'debit_note') throw badRequest('A debit note is settled against the account, not paid at the counter.');
  const inv = await receiptInvoice(trx, orgId, invoiceId);
  if (inv.status === 'void') throw badRequest(`${inv.number} is void. Clone it to raise it again.`);
  const payIds = await counterPayments(trx, orgId, invoiceId, inv.number);
  if (payIds.length > 1) {
    throw new ApiError(409, `${inv.number} was paid in parts. Change those payments in Payments received, then edit it as an invoice.`, 'locked_document');
  }
  const invoiceInput: CreateInvoiceInput = { ...input, status: 'approved', holdForApproval: false };
  const paymentFor = (totalPaise: number) => ({
    branchId: input.branchId, contactId: input.customerId, date: input.date, mode: paid.mode, amountPaise: totalPaise,
    bankAccountId: paid.bankAccountId, reference: paid.reference ?? null,
    allocations: [{ targetType: 'invoice' as const, targetId: invoiceId, amountPaise: totalPaise }],
  });
  let made: Awaited<ReturnType<typeof updateInvoice>> | null = null;
  let payment: { id: number; number: string };
  if (payIds.length) {
    const pay = await updatePayment(trx, orgId, userId, payIds[0], async () => {
      made = await updateInvoice(trx, orgId, userId, invoiceId, invoiceInput);
      return paymentFor(made.totalPaise);
    });
    payment = { id: pay.id, number: pay.number };
  } else {
    // Its payment was deleted on its own: the edited sale is paid at the counter again.
    made = await updateInvoice(trx, orgId, userId, invoiceId, invoiceInput);
    const pay = await receivePayment(trx, orgId, userId, paymentFor(made.totalPaise));
    payment = { id: pay.id, number: pay.number };
  }
  await trx.updateTable('invoices').set({ paid_at_sale: 1 }).where('id', '=', invoiceId).execute();
  return { ...(made as unknown as Awaited<ReturnType<typeof updateInvoice>>), payment };
}

/** Delete a sales receipt: its counter payment, then its invoice, each reversed and kept on record. */
export async function deleteSalesReceipt(trx: Trx, orgId: number, userId: number | null, invoiceId: number, reason?: string | null) {
  const inv = await receiptInvoice(trx, orgId, invoiceId);
  const payIds = await counterPayments(trx, orgId, invoiceId, inv.number);
  const payments: string[] = [];
  for (const id of payIds) payments.push((await deletePayment(trx, orgId, userId, id, reason)).number);
  const gone = await deleteInvoice(trx, orgId, userId, invoiceId, reason);
  return { number: gone.number, payments };
}
