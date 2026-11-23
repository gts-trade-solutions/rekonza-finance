import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Zoho Books' "Add Bank or Credit Card", Edit, Mark as Inactive and Delete.
//
// A bank or card account is always a pair: the bank account row and the
// ledger account the books post to (banking.ts createBankAccount). Renaming
// one renames the other, so the chart and the banking screens never disagree
// on what an account is called.
//
// Delete is only for an account nothing has touched: once money has been
// posted through it, or a statement line or a document names it, it is part
// of the books' history and can only be marked inactive (Zoho says the same).
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Trx } from '../db';
import { badRequest, notFound } from '../http';
import { createBankAccount } from './banking';

export const BANK_CURRENCIES = ['AED', 'AUD', 'CAD', 'CNY', 'EUR', 'GBP', 'INR', 'SAR', 'USD', 'ZAR', 'JPY'] as const;

export interface BankAccountInput {
  kind: 'bank' | 'card' | 'cash' | 'wallet';
  name: string;
  accountCode?: string | null;
  currency?: string | null;
  accountNumber?: string | null;
  bankName?: string | null;
  ifsc?: string | null;
  description?: string | null;
  /** Who may see the account; empty means everyone with the banking right. */
  userIds?: number[] | null;
  isPrimary?: boolean;
  openingBalancePaise?: number;
  openingDate?: string | null;
}

function clean(input: BankAccountInput) {
  const name = input.name.trim();
  // Zoho's own words for an empty name.
  if (!name) throw badRequest('Please enter a valid account name.');
  const currency = (input.currency || 'INR').toUpperCase();
  if (!(BANK_CURRENCIES as readonly string[]).includes(currency)) throw badRequest(`${currency} is not a currency an account can be held in here.`);
  const card = input.kind === 'card';
  // A card has neither an account number nor an IFSC on Zoho's form.
  const number = card ? null : (input.accountNumber ?? '').replace(/\s+/g, '') || null;
  if (number && !/^[0-9A-Za-z-]{4,34}$/.test(number)) throw badRequest('The account number has 4 to 34 letters and digits.');
  const ifsc = card ? null : (input.ifsc ?? '').trim().toUpperCase() || null;
  if (ifsc && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) throw badRequest('An IFSC is 11 characters: four letters, a zero, then six letters or digits.');
  return {
    name, currency, number, ifsc, card,
    code: input.accountCode?.trim() || null,
    bankName: input.bankName?.trim() || null,
    description: input.description?.trim().slice(0, 500) || null,
    userIds: input.userIds?.length ? [...new Set(input.userIds.map(Number))] : null,
  };
}

async function assertUniqueName(trx: Trx, orgId: number, name: string, except?: number) {
  let q = trx.selectFrom('bank_accounts').select('id').where('org_id', '=', orgId).where('name', '=', name);
  if (except) q = q.where('id', '<>', except);
  if (await q.executeTakeFirst()) throw badRequest(`An account named ${name} already exists.`);
}

async function primaryOnly(trx: Trx, orgId: number, id: number) {
  await trx.updateTable('bank_accounts').set({ is_primary: 0 }).where('org_id', '=', orgId).where('id', '<>', id).execute();
  await trx.updateTable('bank_accounts').set({ is_primary: 1 }).where('id', '=', id).execute();
}

/** Zoho's Add Bank or Credit Card: the account and its ledger account. */
export async function addBankAccount(trx: Trx, orgId: number, userId: number | null, input: BankAccountInput) {
  const c = clean(input);
  await assertUniqueName(trx, orgId, c.name);
  const created = await createBankAccount(trx, orgId, userId, {
    kind: input.kind, name: c.name, bankName: c.bankName, accountLast4: c.number ? c.number.slice(-4) : null, ifsc: c.ifsc,
    openingBalancePaise: input.openingBalancePaise, openingDate: input.openingDate,
  });
  await trx.updateTable('bank_accounts').set({
    account_code: c.code, currency: c.currency, account_number: c.number, description: c.description,
    user_ids: c.userIds ? JSON.stringify(c.userIds) : null,
  }).where('id', '=', created.id).execute();
  if (input.isPrimary) await primaryOnly(trx, orgId, created.id);
  return created;
}

/** Zoho's Edit on an account. The kind stays: a bank cannot become a card after money went through it. */
export async function updateBankAccount(trx: Trx, orgId: number, id: number, input: Omit<BankAccountInput, 'kind' | 'openingBalancePaise' | 'openingDate'>) {
  const row = await trx.selectFrom('bank_accounts').select(['id', 'kind', 'ledger_account_id'])
    .where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
  if (!row) throw notFound('That account does not exist.');
  const c = clean({ ...input, kind: row.kind === 'card' ? 'card' : 'bank' });
  await assertUniqueName(trx, orgId, c.name, id);
  await trx.updateTable('bank_accounts').set({
    name: c.name, account_code: c.code, currency: c.currency, account_number: c.number,
    account_last4: c.number ? c.number.slice(-4) : null, bank_name: c.bankName, ifsc: c.ifsc, description: c.description,
    user_ids: c.userIds ? JSON.stringify(c.userIds) : null,
  }).where('id', '=', id).execute();
  // The ledger account carries the same name, so the chart and the reports agree.
  await trx.updateTable('accounts').set({ name: c.name }).where('id', '=', row.ledger_account_id).where('org_id', '=', orgId).execute();
  if (input.isPrimary) await primaryOnly(trx, orgId, id);
  else await trx.updateTable('bank_accounts').set({ is_primary: 0 }).where('id', '=', id).execute();
  return { id };
}

/** Mark as Inactive / Mark as Active. An inactive account leaves the lists but keeps its history. */
export async function setBankAccountActive(trx: Trx, orgId: number, id: number, active: boolean) {
  const row = await trx.selectFrom('bank_accounts').select(['id', 'name', 'ledger_account_id', 'is_primary'])
    .where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
  if (!row) throw notFound('That account does not exist.');
  if (!active) {
    const { rows } = await sql<{ n: number }>`SELECT COUNT(*) AS n FROM bank_transactions WHERE bank_account_id = ${id} AND status = 'unmatched'`.execute(trx);
    if (Number(rows[0]?.n ?? 0) > 0) throw badRequest(`${row.name} still has uncategorized statement lines. Categorize or exclude them first.`);
  }
  await trx.updateTable('bank_accounts').set({ is_active: active ? 1 : 0, ...(active ? {} : { is_primary: 0 }) }).where('id', '=', id).execute();
  await trx.updateTable('accounts').set({ is_active: active ? 1 : 0 }).where('id', '=', row.ledger_account_id).execute();
  return { id, name: row.name, isActive: active };
}

/** Delete, for an account nothing has touched. */
export async function deleteBankAccount(trx: Trx, orgId: number, id: number) {
  const row = await trx.selectFrom('bank_accounts').select(['id', 'name', 'ledger_account_id'])
    .where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
  if (!row) throw notFound('That account does not exist.');
  const { rows } = await sql<{ posted: number; stmt_lines: number }>`
    SELECT (SELECT COUNT(*) FROM journal_lines WHERE account_id = ${row.ledger_account_id}) AS posted,
           (SELECT COUNT(*) FROM bank_transactions WHERE bank_account_id = ${id}) AS stmt_lines`.execute(trx);
  const used = Number(rows[0]?.posted ?? 0) + Number(rows[0]?.stmt_lines ?? 0);
  if (used > 0) throw badRequest(`${row.name} has transactions, so it cannot be deleted. Mark it as inactive instead.`);
  await trx.deleteFrom('bank_rules').where('org_id', '=', orgId).where('bank_account_id', '=', id).execute();
  try {
    await trx.deleteFrom('bank_accounts').where('id', '=', id).execute();
    await trx.deleteFrom('accounts').where('id', '=', row.ledger_account_id).where('org_id', '=', orgId).execute();
  } catch (e) {
    // A document still names it (a cheque, a payment batch, a recurring expense …): that is history too.
    if ((e as { code?: string }).code === 'ER_ROW_IS_REFERENCED_2') throw badRequest(`${row.name} is used on a document, so it cannot be deleted. Mark it as inactive instead.`);
    throw e;
  }
  return { id, name: row.name };
}
