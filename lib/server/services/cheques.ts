import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// The cheque register and what happens when a cheque comes back.
//
// A cheque on its own posts nothing: until it clears, the money is neither
// ours nor theirs. The payment that moves the money is recorded separately,
// and the two are linked by the cheque number — when the payment is entered
// with the cheque number as its reference, or when the cheque is marked
// cleared and a matching payment is found.
//
// The link matters on the day a cheque bounces. A returned cheque means the
// receipt never really happened: the payment is reversed on the return date,
// so the invoices it settled are owed again and chased again, and the bank's
// return charge is posted — to the bank-charges expense, or to the customer
// when it is to be recovered from them. Charges for a dishonoured cheque are
// not consideration for a supply (CBIC circular 178/10/2022-GST), so no GST is
// added when they are recovered.
// ─────────────────────────────────────────────────────────────────────────────

import type { Trx } from '../db';
import type { Paise } from '../../types';
import { toSqlFromPaise } from '../money-sql';
import { postEntry, type DraftLine } from '../ledger/posting';
import { CODE, accountIds, requireAccount } from '../ledger/chart-of-accounts';
import { badRequest, conflict, notFound } from '../http';
import { voidPayment } from './payments';

export type ChequeStatus = 'in_hand' | 'deposited' | 'cleared' | 'bounced' | 'cancelled';

/** Where a cheque may go from where it is. Returned and cancelled cheques are finished. */
const NEXT: Record<ChequeStatus, ChequeStatus[]> = {
  in_hand: ['deposited', 'cleared', 'bounced', 'cancelled'],
  deposited: ['cleared', 'bounced'],
  cleared: ['bounced'],
  bounced: [],
  cancelled: [],
};

async function lockCheque(trx: Trx, orgId: number, id: number) {
  const c = await trx.selectFrom('cheques').selectAll()
    .where('id', '=', id).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!c) throw notFound('That cheque does not exist.');
  return c;
}

function assertMove(chequeNo: string, from: ChequeStatus, to: ChequeStatus) {
  if (from === to) throw conflict(`Cheque ${chequeNo} is already ${to.replace('_', ' ')}.`);
  if (!NEXT[from].includes(to)) {
    throw conflict(
      from === 'cleared'
        ? `Cheque ${chequeNo} has already cleared. Only a return can change it after that.`
        : `Cheque ${chequeNo} is ${from.replace('_', ' ')}; it cannot be marked ${to.replace('_', ' ')}.`,
    );
  }
}

/** The live payment a cheque paid, if it is linked to one. */
async function linkedPayment(trx: Trx, orgId: number, paymentId: number | null) {
  if (!paymentId) return null;
  const p = await trx.selectFrom('payments')
    .select(['id', 'number', 'status', 'bank_account_id', 'payment_date', 'branch_id'])
    .where('id', '=', paymentId).where('org_id', '=', orgId).executeTakeFirst();
  return p && p.status !== 'void' ? p : null;
}

/**
 * Find the payment a cheque paid when nobody has linked them: same party, same
 * direction, same amount, entered as a cheque with this number as reference,
 * and not already tied to another cheque. Only an unambiguous match is taken.
 */
async function findPayment(trx: Trx, orgId: number, c: { id: number; kind: 'issued' | 'received'; contact_id: number; cheque_no: string; amount: string }) {
  const rows = await trx.selectFrom('payments as p')
    .leftJoin('cheques as q', (j) => j.onRef('q.payment_id', '=', 'p.id').on('q.id', '<>', c.id))
    .select(['p.id', 'p.number'])
    .where('p.org_id', '=', orgId)
    .where('p.contact_id', '=', c.contact_id)
    .where('p.kind', '=', c.kind === 'received' ? 'received' : 'made')
    .where('p.mode', '=', 'cheque')
    .where('p.status', '<>', 'void')
    .where('p.amount', '=', c.amount)
    .where('p.reference', '=', c.cheque_no)
    .where('q.id', 'is', null)
    .limit(2)
    .execute();
  return rows.length === 1 ? rows[0] : null;
}

/**
 * Mark a cheque cleared, and tie it to the payment that recorded the money.
 *
 * Clearing posts nothing itself — the payment did that. If no payment can be
 * found the cheque still clears, and the caller is told so: the money is in
 * the bank but not yet in the books.
 */
export async function clearCheque(
  trx: Trx, orgId: number, id: number, input: { date: string; paymentId?: number | null },
): Promise<{ paymentId: number | null; paymentNumber: string | null }> {
  const c = await lockCheque(trx, orgId, id);
  assertMove(c.cheque_no, c.status, 'cleared');

  let payment: { id: number; number: string } | null = null;
  if (input.paymentId) {
    const p = await trx.selectFrom('payments').select(['id', 'number', 'contact_id', 'kind', 'status'])
      .where('id', '=', input.paymentId).where('org_id', '=', orgId).executeTakeFirst();
    if (!p || p.status === 'void') throw notFound('That payment does not exist or is void.');
    if (p.contact_id !== c.contact_id) throw badRequest(`${p.number} is from another party.`);
    if ((p.kind === 'received') !== (c.kind === 'received')) {
      throw badRequest(`${p.number} is a ${p.kind === 'received' ? 'receipt' : 'payment made'}; this cheque was ${c.kind}.`);
    }
    const taken = await trx.selectFrom('cheques').select('cheque_no')
      .where('org_id', '=', orgId).where('payment_id', '=', p.id).where('id', '<>', c.id).executeTakeFirst();
    if (taken) throw conflict(`${p.number} is already linked to cheque ${taken.cheque_no}.`);
    payment = p;
  } else {
    payment = (await linkedPayment(trx, orgId, c.payment_id)) ?? (await findPayment(trx, orgId, c));
  }

  await trx.updateTable('cheques')
    .set({ status: 'cleared', is_pdc: 0, cleared_on: input.date, payment_id: payment?.id ?? c.payment_id })
    .where('id', '=', id).execute();
  return { paymentId: payment?.id ?? null, paymentNumber: payment?.number ?? null };
}

export interface ReturnInput {
  date: string;
  reason: string;
  /** What the bank charged for the return. */
  chargesPaise?: Paise;
  /** Recover the charge from the customer rather than bearing it. Received cheques only. */
  chargeToParty?: boolean;
  /** The account the charge came out of, when no payment says which. */
  bankAccountId?: number | null;
  branchId: number;
}

/**
 * A cheque came back unpaid.
 *
 * Its payment, if one was recorded, is reversed on the return date — the
 * invoices or bills it settled are open again — and the bank's charge is
 * posted. A cheque returned before any payment was recorded only changes
 * status; there is nothing in the books to undo.
 */
export async function returnCheque(
  trx: Trx, orgId: number, userId: number | null, id: number, input: ReturnInput,
): Promise<{ reversedPayment: string | null; chargesEntryId: number | null }> {
  const c = await lockCheque(trx, orgId, id);
  assertMove(c.cheque_no, c.status, 'bounced');
  const charges = input.chargesPaise ?? 0;
  if (charges < 0) throw badRequest('Return charges cannot be negative.');
  if (input.chargeToParty && c.kind !== 'received') {
    throw badRequest('Only a customer can be asked to bear the charge for their own returned cheque.');
  }

  const payment = await linkedPayment(trx, orgId, c.payment_id);
  if (payment) {
    await voidPayment(trx, orgId, userId, payment.id, `Cheque ${c.cheque_no} returned: ${input.reason}`, { date: input.date });
  }

  let chargesEntryId: number | null = null;
  if (charges > 0) {
    const bankId = payment?.bank_account_id ?? input.bankAccountId;
    if (!bankId) throw badRequest('Say which bank account the return charge was taken from.');
    const bank = await trx.selectFrom('bank_accounts').select(['ledger_account_id', 'name'])
      .where('id', '=', bankId).where('org_id', '=', orgId).executeTakeFirst();
    if (!bank) throw notFound('That bank account does not exist.');
    const contact = await trx.selectFrom('contacts').select('display_name')
      .where('id', '=', c.contact_id).executeTakeFirstOrThrow();

    const acc = await accountIds(trx, orgId);
    const lines: DraftLine[] = [
      input.chargeToParty
        ? { accountId: requireAccount(acc, CODE.AR), debit: charges, contactId: c.contact_id, description: `Return charges, cheque ${c.cheque_no}` }
        : { accountId: requireAccount(acc, CODE.BANK_CHARGES), debit: charges, description: `Return charges, cheque ${c.cheque_no}` },
      { accountId: bank.ledger_account_id, credit: charges, description: `Cheque ${c.cheque_no} returned` },
    ];
    chargesEntryId = (await postEntry(trx, {
      orgId, branchId: payment?.branch_id ?? input.branchId, date: input.date,
      memo: `Cheque ${c.cheque_no} of ${contact.display_name} returned — ${input.reason}` +
        (input.chargeToParty ? '; charge recoverable from the customer' : ''),
      sourceType: 'cheque_return', sourceId: c.id, userId, module: 'banking', lines,
    })).id;
  }

  await trx.updateTable('cheques').set({
    status: 'bounced', is_pdc: 0, returned_on: input.date, return_reason: input.reason,
    return_charges: toSqlFromPaise(charges), charges_to_party: input.chargeToParty ? 1 : 0,
    charges_entry_id: chargesEntryId,
  }).where('id', '=', id).execute();

  return { reversedPayment: payment?.number ?? null, chargesEntryId };
}

/** The simple moves: deposited, or cancelled before anything was paid with it. */
export async function moveCheque(trx: Trx, orgId: number, id: number, to: 'deposited' | 'cancelled') {
  const c = await lockCheque(trx, orgId, id);
  assertMove(c.cheque_no, c.status, to);
  if (to === 'cancelled') {
    const p = await linkedPayment(trx, orgId, c.payment_id);
    if (p) {
      throw conflict(
        `Cheque ${c.cheque_no} paid ${p.number}. Void that payment first, or mark the cheque returned if the bank sent it back.`,
      );
    }
  }
  await trx.updateTable('cheques').set({ status: to, is_pdc: to === 'cancelled' ? 0 : c.is_pdc })
    .where('id', '=', id).execute();
}

/**
 * The last day to send the drawer a demand notice for a returned cheque:
 * thirty days from the bank's return memo (section 138(b), Negotiable
 * Instruments Act). Miss it and the cheque can no longer found a complaint.
 */
export function noticeDeadline(returnedOn: string): string {
  const d = new Date(`${returnedOn}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 30);
  return d.toISOString().slice(0, 10);
}
