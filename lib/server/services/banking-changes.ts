import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Edit and Delete in Banking, wherever the client looked for them
// (2026-11-25): transfers between accounts, the cheque register, bank
// statement lines, and cash counts.
//
// The rules are the documents' (doc-delete.ts):
//
// - What posted is never erased. A transfer, or a cash count's short/excess,
//   is deleted by reversing its entry on its own date, and edited by
//   reversing and posting the corrected one; deleted_documents keeps the
//   record as it stood.
// - What a statement line is matched to cannot change behind the bank's back:
//   a transfer matched to a line is refused until the line is unmatched (as a
//   payment or an expense is), and a statement line already categorised is
//   refused until its categorisation is undone.
// - A statement line is the bank's own record. While it is uncategorised it
//   can be corrected (a mis-read date or narration) or deleted (imported by
//   mistake); its import fingerprint is kept, so the same statement imported
//   again does not bring the line back twice.
// ─────────────────────────────────────────────────────────────────────────────

import type { Trx } from '../db';
import type { Paise } from '../../types';
import { ApiError, badRequest, conflict, notFound } from '../http';
import { toPaiseFromSql, toSqlFromPaise } from '../money-sql';
import { postEntry } from '../ledger/posting';
import { checkCashBalance } from './guards';
import { bankLineMatched, plain, recordDeletion, reverseForChange, unlinkDocument } from './doc-delete';

// ── Transfers ───────────────────────────────────────────────────────────────

export interface TransferInput { fromBankAccountId: number; toBankAccountId: number; date: string; amountPaise: Paise; reference?: string | null }

async function transferForChange(trx: Trx, orgId: number, id: number) {
  const t = await trx.selectFrom('bank_transfers').selectAll().where('id', '=', id).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!t) throw notFound('That transfer was not found.');
  if (await bankLineMatched(trx, orgId, 'transfer', id)) {
    throw new ApiError(409, 'This transfer is matched to a bank statement line. Undo that match in Banking first, then change it.', 'locked_document');
  }
  return t;
}

/** The two accounts of a transfer, and the primary branch it posts under. */
export async function transferSides(trx: Trx, orgId: number, input: TransferInput) {
  if (input.fromBankAccountId === input.toBankAccountId) throw badRequest('Choose two different accounts.');
  if (!(input.amountPaise > 0)) throw badRequest('Enter an amount above zero.');
  const accounts = await trx.selectFrom('bank_accounts').select(['id', 'name', 'ledger_account_id'])
    .where('org_id', '=', orgId).where('id', 'in', [input.fromBankAccountId, input.toBankAccountId]).execute();
  const from = accounts.find((a) => a.id === input.fromBankAccountId);
  const to = accounts.find((a) => a.id === input.toBankAccountId);
  if (!from || !to) throw notFound('One of those accounts does not exist.');
  const branch = await trx.selectFrom('branches').select('id').where('org_id', '=', orgId).where('is_primary', '=', 1).executeTakeFirstOrThrow();
  return { from, to, branchId: branch.id };
}

/** A transfer's entry: into one account, out of the other, under the transfer's own id. */
export async function postTransferEntry(trx: Trx, orgId: number, userId: number | null, id: number, input: TransferInput) {
  const { from, to, branchId } = await transferSides(trx, orgId, input);
  return postEntry(trx, {
    orgId, branchId, date: input.date, memo: `Transfer ${from.name} to ${to.name}`, sourceType: 'transfer', sourceId: id, userId, module: 'banking',
    lines: [
      { accountId: to.ledger_account_id, debit: input.amountPaise, description: `From ${from.name}` },
      { accountId: from.ledger_account_id, credit: input.amountPaise, description: `To ${to.name}` },
    ],
  });
}

/**
 * Edit a transfer, as Zoho does: the entry it posted is reversed on its own
 * date and the corrected one posted, on the same transfer row.
 */
export async function editTransfer(trx: Trx, orgId: number, userId: number | null, id: number, input: TransferInput) {
  const t = await transferForChange(trx, orgId, id);
  await transferSides(trx, orgId, input);
  // Cash in hand going below nil, measured without the transfer as it was (guards.ts).
  const warnings: string[] = [];
  await checkCashBalance(trx, orgId, input.fromBankAccountId, input.date, input.amountPaise, warnings, { sourceTypes: ['transfer'], sourceId: id });
  await reverseForChange(trx, orgId, t.journal_entry_id, { memo: `Transfer edited: the entry as it was, reversed`, userId, module: 'banking' });
  const entry = await postTransferEntry(trx, orgId, userId, id, input);
  await trx.updateTable('bank_transfers').set({
    from_bank_account_id: input.fromBankAccountId, to_bank_account_id: input.toBankAccountId, transfer_date: input.date,
    amount: toSqlFromPaise(input.amountPaise), reference: input.reference?.trim() || null, journal_entry_id: entry.id,
  }).where('id', '=', id).execute();
  return { entryNo: entry.entryNo, before: plain(t), warnings };
}

/** Delete a transfer: its entry reversed on its own date, the record kept. */
export async function deleteTransfer(trx: Trx, orgId: number, userId: number | null, id: number, reason?: string | null) {
  const t = await transferForChange(trx, orgId, id);
  const reversal = await reverseForChange(trx, orgId, t.journal_entry_id, { memo: `Transfer deleted${reason ? `: ${reason}` : ''}`.slice(0, 500), userId, module: 'banking' });
  await unlinkDocument(trx, orgId, 'transfer', id);
  await trx.deleteFrom('bank_transfers').where('id', '=', id).execute();
  await recordDeletion(trx, {
    orgId, userId, docType: 'transfer', docId: id, number: t.reference, date: String(t.transfer_date).slice(0, 10),
    totalPaise: toPaiseFromSql(t.amount), journalEntryId: t.journal_entry_id, reversalEntryId: reversal, reason, snapshot: plain(t),
  });
  return { amountPaise: toPaiseFromSql(t.amount), date: String(t.transfer_date).slice(0, 10) };
}

// ── Cheques ─────────────────────────────────────────────────────────────────

export interface ChequeInput { kind: 'issued' | 'received'; contactId: number; chequeNo: string; bankName?: string | null; amountPaise: Paise; maturityDate: string; notes?: string | null }

/**
 * Correct a cheque in the register while it is still paper in the drawer (in
 * hand or deposited). Once it has cleared it is the record of a payment, and
 * once returned it has posted; those stay as they are.
 */
export async function editCheque(trx: Trx, orgId: number, id: number, input: ChequeInput, today = new Date().toISOString().slice(0, 10)) {
  const c = await trx.selectFrom('cheques').selectAll().where('id', '=', id).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!c) throw notFound('That cheque does not exist.');
  if (c.status !== 'in_hand' && c.status !== 'deposited') {
    throw conflict(`Cheque ${c.cheque_no} is ${c.status.replace('_', ' ')}; only a cheque in hand or deposited can be edited.`);
  }
  if (!input.chequeNo.trim()) throw badRequest('A cheque number is required.');
  if (!(input.amountPaise > 0)) throw badRequest('Enter an amount above zero.');
  const contact = await trx.selectFrom('contacts').select('id').where('id', '=', input.contactId).where('org_id', '=', orgId).executeTakeFirst();
  if (!contact) throw badRequest('That contact does not exist.');
  await trx.updateTable('cheques').set({
    kind: input.kind, contact_id: input.contactId, cheque_no: input.chequeNo.trim(), bank_name: input.bankName?.trim() || null,
    amount: toSqlFromPaise(input.amountPaise), maturity_date: input.maturityDate, is_pdc: input.maturityDate > today ? 1 : 0,
    notes: input.notes?.trim() || null,
  }).where('id', '=', id).execute();
  return { chequeNo: input.chequeNo.trim(), before: plain(c) };
}

/**
 * Delete a cheque entered by mistake. It posted nothing while in hand,
 * deposited or cancelled. A cleared cheque is the record of the payment it
 * paid, and a returned one posted its reversal and charges: both stay.
 */
export async function deleteCheque(trx: Trx, orgId: number, id: number) {
  const c = await trx.selectFrom('cheques').selectAll().where('id', '=', id).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!c) throw notFound('That cheque does not exist.');
  if (c.status === 'cleared') {
    throw conflict(`Cheque ${c.cheque_no} has cleared: it is the record of the payment it paid, and stays. Delete that payment instead if it was wrong.`);
  }
  if (c.status === 'bounced') {
    throw conflict(`Cheque ${c.cheque_no} came back: its return reversed the payment and posted the charges, so it stays as the record of that.`);
  }
  await trx.deleteFrom('cheques').where('id', '=', id).execute();
  return { chequeNo: c.cheque_no, amountPaise: toPaiseFromSql(c.amount) };
}

// ── Statement lines ─────────────────────────────────────────────────────────

export interface StatementLineInput { date: string; narration: string; reference?: string | null; depositPaise: Paise; withdrawalPaise: Paise }

async function freeLine(trx: Trx, orgId: number, id: number) {
  const l = await trx.selectFrom('bank_transactions').selectAll().where('id', '=', id).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!l) throw notFound('That statement line was not found.');
  if (l.status === 'matched' || l.status === 'manually_added') {
    throw new ApiError(409, 'This line is categorised or matched. Undo that first (Uncategorize); the line can then be changed or deleted.', 'locked_document');
  }
  return l;
}

/** Correct an uncategorised line: its date, narration, reference or amount, as the statement should have read. */
export async function editStatementLine(trx: Trx, orgId: number, id: number, input: StatementLineInput) {
  const l = await freeLine(trx, orgId, id);
  if (!input.narration.trim()) throw badRequest('Give the line its narration.');
  const dep = input.depositPaise > 0 ? input.depositPaise : 0;
  const wd = input.withdrawalPaise > 0 ? input.withdrawalPaise : 0;
  if ((dep > 0) === (wd > 0)) throw badRequest('A line is either money in (a deposit) or money out (a withdrawal), above zero.');
  await trx.updateTable('bank_transactions').set({
    txn_date: input.date, narration: input.narration.trim().slice(0, 500), reference: input.reference?.trim() || null,
    deposit: toSqlFromPaise(dep), withdrawal: toSqlFromPaise(wd),
  }).where('id', '=', id).execute();
  return { before: plain(l) };
}

/** Delete one uncategorised or excluded line (imported by mistake). */
export async function deleteStatementLine(trx: Trx, orgId: number, id: number) {
  const l = await freeLine(trx, orgId, id);
  await trx.deleteFrom('bank_transaction_links').where('org_id', '=', orgId).where('bank_transaction_id', '=', id).execute();
  await trx.deleteFrom('bank_transactions').where('id', '=', id).execute();
  // An import left with nothing is gone too; otherwise its count follows.
  if (l.import_batch_id) {
    const left = await trx.selectFrom('bank_transactions').select('id').where('import_batch_id', '=', l.import_batch_id).execute();
    if (!left.length) await trx.deleteFrom('bank_statement_imports').where('id', '=', l.import_batch_id).execute();
    else await trx.updateTable('bank_statement_imports').set({ rows_imported: left.length }).where('id', '=', l.import_batch_id).execute();
  }
  return { narration: l.narration, date: String(l.txn_date).slice(0, 10) };
}

// ── Cash counts ─────────────────────────────────────────────────────────────

/**
 * Delete a cash count: the short or excess it posted is reversed on its own
 * date, and the count is kept in deleted_documents. Counting again is how a
 * wrong count is corrected (reports/cash-book.ts recountCash).
 */
export async function deleteCashCount(trx: Trx, orgId: number, userId: number | null, id: number, reason?: string | null) {
  const c = await trx.selectFrom('cash_counts').selectAll().where('id', '=', id).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!c) throw notFound('That cash count was not found.');
  const reversal = await reverseForChange(trx, orgId, c.journal_entry_id, { memo: `Cash count of ${String(c.counted_on).slice(0, 10)} deleted`, userId, module: 'banking' });
  await trx.deleteFrom('cash_counts').where('id', '=', id).execute();
  await recordDeletion(trx, {
    orgId, userId, docType: 'cash_count', docId: id, number: null, date: String(c.counted_on).slice(0, 10), totalPaise: toPaiseFromSql(c.counted),
    journalEntryId: c.journal_entry_id, reversalEntryId: reversal, reason, snapshot: plain(c),
  });
  return { date: String(c.counted_on).slice(0, 10), bankAccountId: c.bank_account_id, reversed: !!reversal };
}
