import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// GSTR-3B table 6.1 in the books: the set-off and the cash.
//
// When a GSTR-3B is filed the portal debits the electronic credit ledger for
// the credit used — IGST first, then CGST and SGST each against its own head
// and IGST, never across (s.49(5), Rule 88A) — and the electronic cash ledger
// for the rest, with interest (s.50) and late fee (s.47). Reverse-charge tax
// and an operator's s.9(5) tax are paid in cash only (s.49(4), and the
// operator may not use credit against s.9(5) tax).
//
// Recording it here posts the same thing: Dr the output-tax ledgers for the
// liability, Dr GST Payable under Reverse Charge, Dr interest and late fee;
// Cr the input-tax ledgers for the credit used, Cr the bank for the cash. The
// GST ledgers then come back to nil for the period, and GSTR-9 table 9 reads
// what was actually paid (gst_tax_payments, return_type GSTR3B).
//
// Edit and Delete work as everywhere in the books: the entry is reversed and,
// for an edit, posted again as the return now stands.
// ─────────────────────────────────────────────────────────────────────────────

import type { Executor, Trx } from '../db';
import type { Paise } from '../../types';
import { toPaiseFromSql, toSqlFromPaise } from '../money-sql';
import { badRequest, conflict, notFound } from '../http';
import { postEntry } from '../ledger/posting';
import { CODE, accountIds, requireAccount } from '../ledger/chart-of-accounts';
import { bankLineMatched, plain, recordDeletion, reverseForChange } from '../services/doc-delete';
import { gstr3bForm } from './gstr3b-form';
import { TAX_HEADS, type TaxHead } from './set-off';

const p = toPaiseFromSql;
const day = (v: unknown) => String(v instanceof Date ? new Date(v.getTime() - v.getTimezoneOffset() * 60_000).toISOString() : v).slice(0, 10);

export interface Gstr3bPaymentInput {
  period: string;
  paidOn: string;
  cpin?: string | null;
  bankAccountId?: number | null;
  notes?: string | null;
}

export interface Gstr3bPaymentView {
  id: string;
  period: string;
  paidOn: string;
  cpin: string | null;
  bankAccountId: string | null;
  bankName: string | null;
  cash: Record<TaxHead, Paise>;
  interestPaise: Paise;
  lateFeePaise: Paise;
  /** setoff[credit head][liability head], in paise. */
  setoff: Record<TaxHead, Record<TaxHead, Paise>>;
  creditUsedPaise: Paise;
  cashTotalPaise: Paise;
  journalEntryId: string | null;
  notes: string | null;
  /** The return has changed since this was recorded: Edit posts it again as it now stands. */
  stale: boolean;
}

const OUTPUT: Record<TaxHead, string> = { IGST: CODE.GST_IGST, CGST: CODE.GST_CGST, SGST: CODE.GST_SGST, CESS: CODE.GST_CESS };
const INPUT: Record<TaxHead, string> = { IGST: CODE.ITC_IGST, CGST: CODE.ITC_CGST, SGST: CODE.ITC_SGST, CESS: CODE.ITC_CESS };
const zeroHeads = (): Record<TaxHead, number> => ({ IGST: 0, CGST: 0, SGST: 0, CESS: 0 });

/** What 6.1 says is to be paid: by head, the credit used and the cash, as the form works it out. */
async function settlementOf(ex: Executor, orgId: number, period: string, today: string) {
  const form = await gstr3bForm(ex, orgId, period, { today });
  const setoff: Record<TaxHead, Record<TaxHead, number>> = { IGST: zeroHeads(), CGST: zeroHeads(), SGST: zeroHeads(), CESS: zeroHeads() };
  const cash = zeroHeads();
  const forwardOwed = zeroHeads();
  const cashOnly = zeroHeads();
  for (const row of form.payment) {
    cash[row.head] += row.cashPaise;
    if (row.kind === 'forward') {
      forwardOwed[row.head] += row.payablePaise;
      // row.itc is by the head of the credit used against this liability.
      for (const credit of TAX_HEADS) setoff[credit][row.head] += row.itc[credit];
    } else {
      cashOnly[row.head] += row.payablePaise;
    }
  }
  // Of the cash-only liability, what is reverse charge (GST Payable under RC)
  // and what is the operator's s.9(5) tax (posted to the output ledgers).
  const rcm: Record<TaxHead, number> = {
    IGST: form.rows['3.1d'].igstPaise, CGST: form.rows['3.1d'].cgstPaise, SGST: form.rows['3.1d'].sgstPaise, CESS: form.rows['3.1d'].cessPaise,
  };
  const s95: Record<TaxHead, number> = {
    IGST: form.rows['3.1.1i'].igstPaise, CGST: form.rows['3.1.1i'].cgstPaise, SGST: form.rows['3.1.1i'].sgstPaise, CESS: form.rows['3.1.1i'].cessPaise,
  };
  return { form, setoff, cash, forwardOwed, cashOnly, rcm, s95, interest: form.totals.interestPaise, lateFee: form.totals.lateFeePaise };
}

type Settlement = Awaited<ReturnType<typeof settlementOf>>;

/** What recording the payment would post, before it is recorded. */
export async function gstr3bSettlement(ex: Executor, orgId: number, period: string, today: string) {
  const s = await settlementOf(ex, orgId, period, today);
  const creditUsedPaise = TAX_HEADS.reduce((t, c) => t + TAX_HEADS.reduce((u, l) => u + s.setoff[c][l], 0), 0);
  const cashTaxPaise = TAX_HEADS.reduce((t, h) => t + s.cash[h], 0);
  return {
    label: s.form.period.label, setoff: s.setoff, cash: s.cash, interestPaise: s.interest, lateFeePaise: s.lateFee,
    creditUsedPaise, cashTaxPaise, cashTotalPaise: cashTaxPaise + s.interest + s.lateFee,
    nothingToPay: creditUsedPaise + cashTaxPaise + s.interest + s.lateFee <= 0,
  };
}

function checkInput(input: Gstr3bPaymentInput, s: Settlement) {
  if (!/^\d{4}-(\d{2}|Q[1-4])$/.test(input.period)) throw badRequest('Say which return period this is, as yyyy-mm or yyyy-Qn.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.paidOn)) throw badRequest('Give the date the tax was paid and set off.');
  if (input.paidOn < s.form.period.from) throw badRequest('Tax for a period cannot be paid before the period began.');
  if (input.cpin && !/^[0-9A-Z]{8,20}$/.test(input.cpin.trim().toUpperCase())) throw badRequest('Give the CPIN (14 digits) or the CIN as the challan shows it.');
  const cashTotal = TAX_HEADS.reduce((t, h) => t + s.cash[h], 0) + s.interest + s.lateFee;
  const creditTotal = TAX_HEADS.reduce((t, c) => t + TAX_HEADS.reduce((u, l) => u + s.setoff[c][l], 0), 0);
  if (cashTotal + creditTotal <= 0) throw badRequest('This return has nothing to pay or set off: a nil return needs no payment entry.');
  if (cashTotal > 0 && !input.bankAccountId) throw badRequest('Pick the bank account the cash was paid from.');
  return { cashTotal, creditTotal };
}

async function post(trx: Trx, orgId: number, userId: number | null, id: number, branchId: number, input: Gstr3bPaymentInput, s: Settlement) {
  const acc = await accountIds(trx, orgId);
  const lines: { accountId: number; debit?: number; credit?: number; description?: string }[] = [];
  for (const h of TAX_HEADS) {
    const out = s.forwardOwed[h] + s.s95[h];
    if (out > 0) lines.push({ accountId: requireAccount(acc, OUTPUT[h]), debit: out, description: `${h} payable, ${s.form.period.label}` });
  }
  const rcmTotal = TAX_HEADS.reduce((t, h) => t + Math.max(0, s.rcm[h]), 0);
  if (rcmTotal > 0) lines.push({ accountId: requireAccount(acc, CODE.RCM_PAYABLE), debit: rcmTotal, description: 'Reverse-charge tax paid in cash' });
  if (s.interest + s.lateFee > 0) lines.push({ accountId: requireAccount(acc, CODE.TAX_INTEREST), debit: s.interest + s.lateFee, description: 'Interest and late fee' });
  for (const c of TAX_HEADS) {
    const used = TAX_HEADS.reduce((t, l) => t + s.setoff[c][l], 0);
    if (used > 0) lines.push({ accountId: requireAccount(acc, INPUT[c]), credit: used, description: `${c} credit set off` });
  }
  const cash = TAX_HEADS.reduce((t, h) => t + s.cash[h], 0) + s.interest + s.lateFee;
  if (cash > 0) {
    const bank = await trx.selectFrom('bank_accounts').select(['ledger_account_id', 'name']).where('id', '=', input.bankAccountId!).where('org_id', '=', orgId).executeTakeFirst();
    if (!bank) throw badRequest('That bank account is not in this book.');
    lines.push({ accountId: bank.ledger_account_id, credit: cash, description: `Paid from ${bank.name}` });
  }
  const entry = await postEntry(trx, {
    orgId, branchId, date: input.paidOn, userId, module: 'accountant',
    memo: `GSTR-3B ${s.form.period.label}: tax set off and paid${input.cpin ? ` — CPIN ${input.cpin.trim().toUpperCase()}` : ''}`,
    sourceType: 'gst_tax_payment', sourceId: id, lines,
  });
  return entry.id;
}

const values = (input: Gstr3bPaymentInput, s: Settlement) => ({
  period: input.period, paid_on: input.paidOn, cpin: input.cpin?.trim().toUpperCase() || null, bank_account_id: input.bankAccountId ?? null,
  cash_igst: toSqlFromPaise(s.cash.IGST), cash_cgst: toSqlFromPaise(s.cash.CGST), cash_sgst: toSqlFromPaise(s.cash.SGST), cash_cess: toSqlFromPaise(s.cash.CESS),
  interest: toSqlFromPaise(s.interest), late_fee: toSqlFromPaise(s.lateFee), setoff: JSON.stringify(s.setoff), notes: input.notes?.trim() || null,
});

async function primaryBranch(ex: Executor, orgId: number) {
  return (await ex.selectFrom('branches').select('id').where('org_id', '=', orgId).orderBy('is_primary', 'desc').orderBy('id').executeTakeFirstOrThrow()).id;
}

export async function gstr3bPaymentFor(ex: Executor, orgId: number, period: string, today: string): Promise<Gstr3bPaymentView | null> {
  const r = await ex.selectFrom('gst_tax_payments as t').leftJoin('bank_accounts as b', 'b.id', 't.bank_account_id')
    .select(['t.id', 't.period', 't.paid_on', 't.cpin', 't.bank_account_id', 'b.name as bank_name', 't.cash_igst', 't.cash_cgst', 't.cash_sgst', 't.cash_cess',
      't.interest', 't.late_fee', 't.setoff', 't.journal_entry_id', 't.notes'])
    .where('t.org_id', '=', orgId).where('t.return_type', '=', 'GSTR3B').where('t.period', '=', period).executeTakeFirst();
  if (!r) return null;
  const so = (typeof r.setoff === 'string' ? JSON.parse(r.setoff) : r.setoff) as Record<TaxHead, Record<TaxHead, number>> | null;
  const setoff: Record<TaxHead, Record<TaxHead, number>> = { IGST: zeroHeads(), CGST: zeroHeads(), SGST: zeroHeads(), CESS: zeroHeads() };
  for (const c of TAX_HEADS) for (const l of TAX_HEADS) setoff[c][l] = Number(so?.[c]?.[l] ?? 0);
  const cash = { IGST: p(r.cash_igst), CGST: p(r.cash_cgst), SGST: p(r.cash_sgst), CESS: p(r.cash_cess) };
  const now = await settlementOf(ex, orgId, period, today);
  const stale = TAX_HEADS.some((h) => now.cash[h] !== cash[h]) || TAX_HEADS.some((c) => TAX_HEADS.some((l) => now.setoff[c][l] !== setoff[c][l]));
  return {
    id: String(r.id), period: r.period, paidOn: day(r.paid_on), cpin: r.cpin, bankAccountId: r.bank_account_id ? String(r.bank_account_id) : null,
    bankName: r.bank_name ?? null, cash, interestPaise: p(r.interest), lateFeePaise: p(r.late_fee), setoff,
    creditUsedPaise: TAX_HEADS.reduce((t, c) => t + TAX_HEADS.reduce((u, l) => u + setoff[c][l], 0), 0),
    cashTotalPaise: TAX_HEADS.reduce((t, h) => t + cash[h], 0) + p(r.interest) + p(r.late_fee),
    journalEntryId: r.journal_entry_id ? String(r.journal_entry_id) : null, notes: r.notes, stale,
  };
}

/** Record the set-off and the cash paid with a GSTR-3B, as table 6.1 works them out. */
export async function recordGstr3bPayment(trx: Trx, orgId: number, userId: number | null, input: Gstr3bPaymentInput, today: string) {
  const s = await settlementOf(trx, orgId, input.period, today);
  const { cashTotal, creditTotal } = checkInput(input, s);
  const have = await trx.selectFrom('gst_tax_payments').select(['id', 'paid_on']).where('org_id', '=', orgId).where('return_type', '=', 'GSTR3B').where('period', '=', input.period).executeTakeFirst();
  if (have) throw conflict(`The tax for GSTR-3B ${s.form.period.label} is already recorded as paid on ${day(have.paid_on)}. Edit that entry instead.`);
  const branchId = await primaryBranch(trx, orgId);
  const id = Number((await trx.insertInto('gst_tax_payments').values({
    org_id: orgId, branch_id: branchId, return_type: 'GSTR3B', ...values(input, s), created_by_user_id: userId,
  }).executeTakeFirstOrThrow()).insertId);
  const entryId = await post(trx, orgId, userId, id, branchId, input, s);
  await trx.updateTable('gst_tax_payments').set({ journal_entry_id: entryId }).where('id', '=', id).execute();
  return { id, journalEntryId: entryId, cashPaise: cashTotal, creditUsedPaise: creditTotal };
}

async function locked(trx: Trx, orgId: number, id: number) {
  const r = await trx.selectFrom('gst_tax_payments').selectAll().where('id', '=', id).where('org_id', '=', orgId).where('return_type', '=', 'GSTR3B').forUpdate().executeTakeFirst();
  if (!r) throw notFound('That GSTR-3B payment was not found.');
  if (r.journal_entry_id && await bankLineMatched(trx, orgId, 'journal_entry', r.journal_entry_id)) {
    throw conflict('This payment is matched to a line of the bank statement. Undo that match in Banking first, then change it here.');
  }
  return r;
}

/** Correct it (date, challan, bank) or bring it up to date with the return: reversed, and posted again. */
export async function updateGstr3bPayment(trx: Trx, orgId: number, userId: number | null, id: number, input: Gstr3bPaymentInput, today: string) {
  const r = await locked(trx, orgId, id);
  if (input.period !== r.period) throw badRequest('A payment stays with the return period it was made for. Delete it and record it against the other period.');
  const s = await settlementOf(trx, orgId, input.period, today);
  checkInput(input, s);
  await reverseForChange(trx, orgId, r.journal_entry_id, { memo: `GSTR-3B ${s.form.period.label} payment changed`, userId, module: 'accountant' });
  const entryId = await post(trx, orgId, userId, id, r.branch_id, input, s);
  await trx.updateTable('gst_tax_payments').set({ ...values(input, s), journal_entry_id: entryId }).where('id', '=', id).execute();
  return { id, journalEntryId: entryId };
}

/** Delete one entered in error: the entry is reversed and the record kept in deleted_documents. */
export async function deleteGstr3bPayment(trx: Trx, orgId: number, userId: number | null, id: number, reason?: string | null) {
  const r = await locked(trx, orgId, id);
  const label = `GSTR-3B payment for ${r.period}`;
  const reversal = await reverseForChange(trx, orgId, r.journal_entry_id, { memo: `${label} deleted${reason?.trim() ? ` — ${reason.trim()}` : ''}`, userId, module: 'accountant' });
  await recordDeletion(trx, {
    orgId, userId, docType: 'gst_tax_payment', docId: id, number: r.cpin ?? label, date: day(r.paid_on), branchId: r.branch_id,
    totalPaise: p(r.cash_igst) + p(r.cash_cgst) + p(r.cash_sgst) + p(r.cash_cess) + p(r.interest) + p(r.late_fee),
    journalEntryId: r.journal_entry_id, reversalEntryId: reversal, reason, snapshot: plain(r),
  });
  await trx.deleteFrom('gst_tax_payments').where('id', '=', id).execute();
  return { label };
}
