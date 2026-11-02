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
import { badRequest } from '../http';
import { createInvoice, type CreateInvoiceInput } from './sales';
import { receivePayment, type PaymentMode } from './payments';

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
