import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Bills of entry: the customs side of an import (migration 086).
//
// The overseas supplier's invoice is an ordinary bill with no GST on it. What
// customs charged — basic duty and surcharge as a cost, IGST and cess as tax —
// is recorded here, against the bill of entry, because that is the document
// the IGST credit is claimed on: GSTR-3B 4(A)(1), and GSTR-2B's IMPG section
// once ICEGATE passes it to the portal.
//
// Import IGST is always IGST, whatever the port and the branch: an import is
// an inter-state supply by law (IGST Act s.7(2)).
// ─────────────────────────────────────────────────────────────────────────────

import type { Trx } from '../db';
import type { Paise } from '../../types';
import { toSqlFromPaise, toPaiseFromSql } from '../money-sql';
import { postEntry, reverseEntry, type DraftLine } from '../ledger/posting';
import { CODE, accountIds, requireAccount } from '../ledger/chart-of-accounts';
import { badRequest, conflict, notFound } from '../http';
import { voidReason } from './void-reason';

export interface BillOfEntryInput {
  branchId: number;
  vendorId?: number | null;
  billId?: number | null;
  boeNo: string;
  boeDate: string;
  portCode: string;
  assessablePaise: Paise;
  customsDutyPaise: Paise;
  igstPaise: Paise;
  cessPaise?: Paise;
  itcEligibility?: 'eligible' | 'ineligible' | 'capital_goods';
  /** Where the duty is booked: Purchases, Inventory, or the asset bought. */
  dutyAccountId: number;
  paidThroughBankAccountId: number;
  notes?: string | null;
}

export async function recordBillOfEntry(trx: Trx, orgId: number, userId: number | null, input: BillOfEntryInput) {
  const boeNo = input.boeNo.trim();
  if (!/^\d{6,8}$/.test(boeNo)) throw badRequest('A bill of entry number is 6 to 8 digits.');
  const port = input.portCode.trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(port)) throw badRequest('A port code is six letters and digits, such as INMAA1.');
  const cess = input.cessPaise ?? 0;
  for (const [label, v] of [['assessable value', input.assessablePaise], ['customs duty', input.customsDutyPaise], ['IGST', input.igstPaise], ['cess', cess]] as const) {
    if (!Number.isInteger(v) || v < 0) throw badRequest(`The ${label} is a whole number of paise, not below zero.`);
  }
  const total = input.customsDutyPaise + input.igstPaise + cess;
  if (total <= 0) throw badRequest('Nothing was paid at customs.');

  const [bank, duty] = await Promise.all([
    trx.selectFrom('bank_accounts').select(['id', 'name', 'ledger_account_id']).where('id', '=', input.paidThroughBankAccountId).where('org_id', '=', orgId).executeTakeFirst(),
    trx.selectFrom('accounts').select(['id', 'type', 'name']).where('id', '=', input.dutyAccountId).where('org_id', '=', orgId).executeTakeFirst(),
  ]);
  if (!bank) throw notFound('That account to pay from does not exist.');
  if (!duty || (duty.type !== 'expense' && duty.type !== 'asset')) throw badRequest('Book the duty to a purchase, stock or asset account.');
  if (input.billId) {
    const bill = await trx.selectFrom('bills').select(['id', 'vendor_id', 'status']).where('id', '=', input.billId).where('org_id', '=', orgId).executeTakeFirst();
    if (!bill) throw notFound('That bill does not exist.');
    if (bill.status === 'void') throw badRequest('That bill is void.');
    if (input.vendorId && bill.vendor_id !== input.vendorId) throw badRequest('The bill is from a different supplier.');
  }
  const dupe = await trx.selectFrom('bills_of_entry').select('id').where('org_id', '=', orgId)
    .where('boe_no', '=', boeNo).where('boe_date', '=', input.boeDate).where('port_code', '=', port).where('status', '<>', 'void').executeTakeFirst();
  if (dupe) throw conflict(`Bill of entry ${boeNo} of ${input.boeDate} at ${port} is already recorded.`);

  const eligibility = input.itcEligibility ?? 'eligible';
  const claim = eligibility !== 'ineligible';
  const acc = await accountIds(trx, orgId);
  const lines: DraftLine[] = [];
  if (input.customsDutyPaise || !claim) {
    lines.push({ accountId: duty.id, debit: input.customsDutyPaise + (claim ? 0 : input.igstPaise + cess), description: `Customs duty, BE ${boeNo}` });
  }
  if (claim && input.igstPaise) lines.push({ accountId: requireAccount(acc, CODE.ITC_IGST), debit: input.igstPaise, description: `IGST on import, BE ${boeNo}` });
  if (claim && cess) lines.push({ accountId: requireAccount(acc, CODE.ITC_CESS), debit: cess, description: `Cess on import, BE ${boeNo}` });
  lines.push({ accountId: bank.ledger_account_id, credit: total, contactId: input.vendorId ?? null, description: `Paid at customs from ${bank.name}` });

  const inserted = await trx.insertInto('bills_of_entry').values({
    org_id: orgId, branch_id: input.branchId, vendor_id: input.vendorId ?? null, bill_id: input.billId ?? null,
    boe_no: boeNo, boe_date: input.boeDate, port_code: port,
    assessable_value: toSqlFromPaise(input.assessablePaise), customs_duty: toSqlFromPaise(input.customsDutyPaise),
    igst: toSqlFromPaise(input.igstPaise), cess: toSqlFromPaise(cess), itc_eligibility: eligibility,
    duty_account_id: duty.id, paid_through_bank_account_id: bank.id, notes: input.notes?.trim() || null, created_by_user_id: userId,
  }).executeTakeFirstOrThrow();
  const id = Number(inserted.insertId);
  const entry = await postEntry(trx, {
    orgId, branchId: input.branchId, date: input.boeDate, memo: `Bill of entry ${boeNo} — ${port}`,
    sourceType: 'bill_of_entry', sourceId: id, userId, module: 'purchases', lines,
  });
  await trx.updateTable('bills_of_entry').set({ journal_entry_id: entry.id }).where('id', '=', id).execute();
  return { id, totalPaise: total, journalEntryId: entry.id };
}

export async function voidBillOfEntry(trx: Trx, orgId: number, userId: number | null, id: number, reason: string) {
  const row = await trx.selectFrom('bills_of_entry').select(['id', 'status', 'journal_entry_id', 'boe_no', 'igst'])
    .where('id', '=', id).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!row) throw notFound('That bill of entry does not exist.');
  if (row.status === 'void') throw conflict('It is already void.');
  const why = voidReason(reason);
  if (row.journal_entry_id) await reverseEntry(trx, orgId, row.journal_entry_id, { memo: `Void of bill of entry ${row.boe_no} — ${why}`, userId, module: 'purchases' });
  await trx.updateTable('bills_of_entry').set({ status: 'void', void_reason: why }).where('id', '=', id).execute();
  return { igstPaise: toPaiseFromSql(row.igst) };
}
