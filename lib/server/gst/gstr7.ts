import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// GSTR-7: the return of a GST TDS deductor (CGST Act s.51, Rule 66).
//
// A government department, a local authority, a governmental agency or a
// notified body deducts 2% from what it pays a registered supplier under a
// contract worth more than ₹2.5 lakh (lib/gst/withholding.ts has the rule and
// its two provisos), pays it over by the 10th of the next month, and files
// GSTR-7 deductee by deductee. The supplier sees the deduction in their
// electronic cash ledger once they accept it, and the deductor issues each of
// them a GSTR-7A certificate (s.51(3)).
//
// Here a deduction is a document of its own, made against the supplier's bill
// (or against a payment under a contract not yet billed). It posts
//   Dr Accounts Payable (the supplier)   Cr GST TDS Payable (2260)
// and settles the bill by the amount deducted, as a part payment does: the
// supplier is owed the bill less the TDS, and the TDS is owed to the
// government. The return is read from these rows and nothing else, and the
// tie-out at the foot of the screen sets it against the ledger.
//
// The tables, as the form numbers them:
//   3  Details of the tax deducted, one row per deductee GSTIN
//   4  Amendments to deductions reported in earlier, filed months
//   5  Tax deducted at source and paid (from the electronic cash ledger)
//   6  Interest, late fee payable and paid
//   7  Refund claimed from the cash ledger (claimed on the portal, RFD-01)
//   8  Debit entries in the electronic cash ledger: the payment itself
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor, Trx } from '../db';
import { toSqlFromPaise } from '../money-sql';
import { badRequest, conflict, notFound } from '../http';
import { postEntry } from '../ledger/posting';
import { CODE, accountIds, requireAccount } from '../ledger/chart-of-accounts';
import { plain, recordDeletion, reverseForChange } from '../services/doc-delete';
import { isValidGstin } from '../../tax/gst';
import { monthLabel } from '../../date-range';
import {
  GST_TDS_THRESHOLD_PAISE, NO_HEADS, gstTdsHeads, headsTotal, withholdingDueDate, type WithholdingHeads,
} from '../../gst/withholding';
import {
  MONTH, amendmentDelta, amendmentsIn, amendmentsOf, assertNotFiled, day, filingOf, interestAndLateFee,
  ledgerBalanceTo, ledgerBySource, monthBounds, p, paymentFor, recordWithholdingPayment, roleProfile, roleState,
  saveAmendments, updateWithholdingPayment, deleteWithholdingPayment,
  type Amendment, type InterestLateFee, type RoleProfile, type WithholdingPaymentInput, type WithholdingPaymentView,
} from './withholding-common';

const because = (reason?: string | null) => (reason?.trim() ? ` — ${reason.trim()}` : '');
const rupees = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const OFF = 'This company is not set up as a GST TDS deductor. Turn it on in Settings → Statutory → GST TDS deductor (GSTR-7) first.';

// ── Recording a deduction ────────────────────────────────────────────────────

export interface GstTdsInput {
  /** The supplier's bill the payment is against; leave out for a payment under a contract not yet billed. */
  billId?: number | null;
  /** Needed only without a bill. */
  vendorId?: number | null;
  deductionDate: string;
  contractRef?: string | null;
  /** The total value of supply under the contract, excluding tax: decides whether s.51 applies. Defaults to the bill's taxable value. */
  contractValuePaise?: number | null;
  /** What is paid or credited, excluding GST: the base of the 2%. Defaults to the bill's taxable value. */
  taxablePaise?: number | null;
  /** Where the supply is made. Defaults to the bill's place of supply, or the deductor's State. */
  placeOfSupply?: string | null;
  notes?: string | null;
}

interface Working {
  role: RoleProfile;
  branchId: number;
  bill: { id: number; internal_no: string; vendor_invoice_no: string; bill_date: string; subtotal: string; total: string; amount_paid: string; place_of_supply: string; branch_id: number } | null;
  vendor: { id: number; name: string; gstin: string };
  taxablePaise: number;
  contractValuePaise: number;
  placeOfSupply: string;
  heads: WithholdingHeads & { inter: boolean; reason: string };
}

/** Work out a deduction, refusing what s.51 does not allow. `excludeId` leaves a deduction being edited out of the bill's sum. */
async function working(ex: Executor, orgId: number, input: GstTdsInput, excludeId?: number): Promise<Working> {
  const role = await roleProfile(ex, orgId);
  if (!role.tds.on) throw badRequest(OFF);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.deductionDate ?? '')) throw badRequest('Give the date the tax was deducted: the day the payment was made or credited.');

  let bill: Working['bill'] = null;
  let vendorId = input.vendorId ?? null;
  if (input.billId) {
    const b = await ex.selectFrom('bills').select(['id', 'internal_no', 'vendor_invoice_no', 'bill_date', 'subtotal', 'total', 'amount_paid', 'place_of_supply', 'status', 'is_rcm', 'vendor_id', 'branch_id', 'cgst', 'sgst', 'igst'])
      .where('id', '=', input.billId).where('org_id', '=', orgId).executeTakeFirst();
    if (!b) throw notFound('That bill was not found.');
    if (b.status === 'draft' || b.status === 'void') throw badRequest(`Bill ${b.internal_no} is ${b.status === 'draft' ? 'still a draft' : 'void'}; nothing is paid under it.`);
    if (b.is_rcm) throw badRequest('Under reverse charge you pay the GST on this supply yourself, so no TDS is deducted from it under section 51.');
    if (p(b.cgst) + p(b.sgst) + p(b.igst) === 0) throw badRequest('GST TDS is deducted on taxable supplies only; this bill charges no GST (an exempt or nil-rated supply).');
    if (input.vendorId && input.vendorId !== b.vendor_id) throw badRequest('The deduction is from the supplier who raised the bill.');
    vendorId = b.vendor_id;
    bill = { ...b, bill_date: day(b.bill_date) };
    if (input.deductionDate < bill.bill_date) throw badRequest(`Tax is deducted when the bill is paid or credited, not before its date (${bill.bill_date}).`);
  }
  if (!vendorId) throw badRequest('Pick the supplier the tax is deducted from.');
  const v = await ex.selectFrom('contacts').select(['id', 'display_name', 'business_legal_name', 'legal_name', 'gstin', 'kind'])
    .where('id', '=', vendorId).where('org_id', '=', orgId).executeTakeFirst();
  if (!v) throw notFound('That supplier was not found.');
  const gstin = (v.gstin ?? '').trim().toUpperCase();
  if (!gstin || !isValidGstin(gstin)) {
    throw badRequest(`GST TDS is deducted only from a registered supplier, and ${v.display_name} has no valid GSTIN. Add it on the vendor first.`);
  }

  const taxablePaise = input.taxablePaise ?? (bill ? p(bill.subtotal) : 0);
  if (!Number.isInteger(taxablePaise) || taxablePaise <= 0) throw badRequest('Give the amount paid or credited, excluding GST.');
  const contractValuePaise = input.contractValuePaise ?? (bill ? p(bill.subtotal) : taxablePaise);
  if (!Number.isInteger(contractValuePaise) || contractValuePaise < taxablePaise) {
    throw badRequest('The contract is worth at least what is paid under it.');
  }
  if (bill) {
    const taken = await ex.selectFrom('gst_tds_deductions').select(sql<string>`COALESCE(SUM(taxable), 0)`.as('t'))
      .where('org_id', '=', orgId).where('bill_id', '=', bill.id)
      .$if(!!excludeId, (q) => q.where('id', '<>', excludeId!)).executeTakeFirst();
    const left = p(bill.subtotal) - p(taken?.t);
    if (taxablePaise > left) {
      throw badRequest(`Only ${rupees(left)} of bill ${bill.internal_no}'s taxable value is left to deduct from.`);
    }
  }
  const placeOfSupply = (input.placeOfSupply ?? bill?.place_of_supply ?? roleState(role, 'tds')).trim();
  if (!/^\d{2}$/.test(placeOfSupply)) throw badRequest('Pick the place of supply.');
  const h = gstTdsHeads({
    taxablePaise, contractValuePaise, supplierState: gstin.slice(0, 2), placeOfSupply, recipientState: roleState(role, 'tds'),
  });
  if (!h.applies) throw badRequest(h.reason);
  return {
    role, branchId: bill?.branch_id ?? role.branch.id,
    bill, vendor: { id: v.id, name: v.business_legal_name || v.legal_name || v.display_name, gstin },
    taxablePaise, contractValuePaise, placeOfSupply, heads: h,
  };
}

/** What a deduction would come to, without posting: the "Deduct GST TDS" window shows it first. */
export async function previewGstTds(ex: Executor, orgId: number, input: GstTdsInput) {
  const w = await working(ex, orgId, input);
  return {
    vendorName: w.vendor.name, deducteeGstin: w.vendor.gstin, taxablePaise: w.taxablePaise, contractValuePaise: w.contractValuePaise,
    placeOfSupply: w.placeOfSupply, ...w.heads, totalPaise: headsTotal(w.heads),
    billOutstandingPaise: w.bill ? p(w.bill.total) - p(w.bill.amount_paid) : null,
  };
}

/** Take a deduction onto, or back off, the bill it settles (as a part payment does). */
async function settleBill(trx: Trx, orgId: number, billId: number | null, deltaPaise: number) {
  if (!billId || deltaPaise === 0) return;
  const b = await trx.selectFrom('bills').select(['internal_no', 'total', 'amount_paid', 'status'])
    .where('id', '=', billId).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!b) return;
  const paid = p(b.amount_paid) + deltaPaise;
  const total = p(b.total);
  if (paid > total) {
    throw badRequest(`Bill ${b.internal_no} has only ${rupees(total - p(b.amount_paid))} left to settle, less than the TDS. Record the TDS before the payment that clears the bill, or pay less.`);
  }
  await trx.updateTable('bills').set({
    amount_paid: toSqlFromPaise(Math.max(0, paid)),
    ...(b.status === 'void' || b.status === 'draft' ? {} : { status: paid >= total ? 'paid' : paid > 0 ? 'partially_paid' : 'open' }),
  }).where('id', '=', billId).execute();
}

async function postDeduction(trx: Trx, orgId: number, userId: number | null, id: number, w: Working, date: string) {
  const acc = await accountIds(trx, orgId);
  const total = headsTotal(w.heads);
  const what = w.bill ? `bill ${w.bill.internal_no} (${w.bill.vendor_invoice_no})` : 'a payment under the contract';
  const entry = await postEntry(trx, {
    orgId, branchId: w.branchId, date, userId, module: 'purchases',
    memo: `GST TDS deducted from ${w.vendor.name} on ${what}`,
    sourceType: 'gst_tds', sourceId: id,
    lines: [
      { accountId: requireAccount(acc, CODE.AP), debit: total, contactId: w.vendor.id, description: `GST TDS on ${rupees(w.taxablePaise)} (section 51)` },
      { accountId: requireAccount(acc, CODE.GST_TDS_PAYABLE), credit: total, description: w.heads.inter ? 'IGST 2%' : 'CGST 1% + SGST 1%' },
    ],
  });
  return entry.id;
}

/** Record a deduction: it posts, and settles the bill by what was deducted. */
export async function recordGstTds(trx: Trx, orgId: number, userId: number | null, input: GstTdsInput) {
  const w = await working(trx, orgId, input);
  const period = input.deductionDate.slice(0, 7);
  await assertNotFiled(trx, orgId, 'GSTR7', period, 'its deductions', 'date the deduction in a month not yet filed, or amend the filed one.');
  const id = Number((await trx.insertInto('gst_tds_deductions').values({
    org_id: orgId, branch_id: w.branchId, vendor_id: w.vendor.id, deductee_gstin: w.vendor.gstin, bill_id: w.bill?.id ?? null,
    contract_ref: input.contractRef?.trim() || null, contract_value: toSqlFromPaise(w.contractValuePaise),
    deduction_date: input.deductionDate, period, taxable: toSqlFromPaise(w.taxablePaise), rate_pct: '2.00',
    igst: toSqlFromPaise(w.heads.igstPaise), cgst: toSqlFromPaise(w.heads.cgstPaise), sgst: toSqlFromPaise(w.heads.sgstPaise),
    notes: input.notes?.trim() || null, created_by_user_id: userId,
  }).executeTakeFirstOrThrow()).insertId);
  const entryId = await postDeduction(trx, orgId, userId, id, w, input.deductionDate);
  await trx.updateTable('gst_tds_deductions').set({ journal_entry_id: entryId }).where('id', '=', id).execute();
  await settleBill(trx, orgId, w.bill?.id ?? null, headsTotal(w.heads));
  return { id, period, vendorName: w.vendor.name, deducteeGstin: w.vendor.gstin, ...w.heads, totalPaise: headsTotal(w.heads), journalEntryId: entryId };
}

async function lockedDeduction(trx: Trx, orgId: number, id: number) {
  const r = await trx.selectFrom('gst_tds_deductions').selectAll().where('id', '=', id).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!r) throw notFound('That deduction was not found.');
  return r;
}
const rowTotal = (r: { igst: string; cgst: string; sgst: string }) => p(r.igst) + p(r.cgst) + p(r.sgst);

/** Correct a deduction of a month not yet filed: its entry reversed, posted again, the bill settled again. */
export async function updateGstTds(trx: Trx, orgId: number, userId: number | null, id: number, input: GstTdsInput) {
  const r = await lockedDeduction(trx, orgId, id);
  await assertNotFiled(trx, orgId, 'GSTR7', r.period, 'this deduction', 'use Amend: the correction is reported in table 4 of a later GSTR-7.');
  const period = input.deductionDate.slice(0, 7);
  if (period !== r.period) await assertNotFiled(trx, orgId, 'GSTR7', period, 'its deductions', 'pick a month not yet filed.');
  await reverseForChange(trx, orgId, r.journal_entry_id, { memo: `GST TDS deduction ${id} changed`, userId, module: 'purchases' });
  await settleBill(trx, orgId, r.bill_id, -rowTotal(r));
  const w = await working(trx, orgId, { ...input, billId: input.billId === undefined ? r.bill_id : input.billId }, id);
  const entryId = await postDeduction(trx, orgId, userId, id, w, input.deductionDate);
  await settleBill(trx, orgId, w.bill?.id ?? null, headsTotal(w.heads));
  await trx.updateTable('gst_tds_deductions').set({
    branch_id: w.branchId, vendor_id: w.vendor.id, deductee_gstin: w.vendor.gstin, bill_id: w.bill?.id ?? null,
    contract_ref: input.contractRef?.trim() || null, contract_value: toSqlFromPaise(w.contractValuePaise),
    deduction_date: input.deductionDate, period, taxable: toSqlFromPaise(w.taxablePaise),
    igst: toSqlFromPaise(w.heads.igstPaise), cgst: toSqlFromPaise(w.heads.cgstPaise), sgst: toSqlFromPaise(w.heads.sgstPaise),
    notes: input.notes?.trim() || null, journal_entry_id: entryId,
  }).where('id', '=', id).execute();
  return { id, period, ...w.heads, totalPaise: headsTotal(w.heads) };
}

/** Delete a deduction entered in error: its entry reversed, the bill owed again, the record kept. */
export async function deleteGstTds(trx: Trx, orgId: number, userId: number | null, id: number, reason?: string | null) {
  const r = await lockedDeduction(trx, orgId, id);
  await assertNotFiled(trx, orgId, 'GSTR7', r.period, 'this deduction', 'use Amend to report the correction in a later GSTR-7 (an amount of nil if it should never have been deducted).');
  const v = await trx.selectFrom('contacts').select('display_name').where('id', '=', r.vendor_id).executeTakeFirst();
  const label = `GST TDS ${rupees(rowTotal(r))} from ${v?.display_name ?? r.deductee_gstin}`;
  const reversal = await reverseForChange(trx, orgId, r.journal_entry_id, { memo: `${label} deleted${because(reason)}`, userId, module: 'purchases' });
  await settleBill(trx, orgId, r.bill_id, -rowTotal(r));
  await recordDeletion(trx, {
    orgId, userId, docType: 'gst_tds', docId: id, number: r.contract_ref ?? `GST TDS ${id}`, date: day(r.deduction_date),
    totalPaise: rowTotal(r), contactId: r.vendor_id, branchId: r.branch_id,
    journalEntryId: r.journal_entry_id, reversalEntryId: reversal, reason, snapshot: plain(r),
  });
  await saveAmendments(trx, orgId, userId, 'GSTR7', id, []);
  await trx.deleteFrom('gst_tds_deductions').where('id', '=', id).execute();
  return { label, period: r.period };
}

// ── Amending a deduction of a filed month ────────────────────────────────────

export interface GstTdsAmendInput {
  /** The day the correction is made: its month's GSTR-7 reports it. */
  date: string;
  /** The deductee's GSTIN as it should have been. */
  deducteeGstin?: string | null;
  /** The amount paid as it should have been (nil if nothing should have been deducted). */
  taxablePaise: number;
  placeOfSupply?: string | null;
  notes?: string | null;
}

/**
 * Correct a deduction reported in a filed GSTR-7, in a later month's table 4.
 * The original month is not touched (it is filed, and often locked); the
 * difference in tax is posted on the day of the correction, and the bill is
 * settled by it.
 */
export async function amendGstTds(trx: Trx, orgId: number, userId: number | null, id: number, input: GstTdsAmendInput) {
  const r = await lockedDeduction(trx, orgId, id);
  const filed = await filingOf(trx, orgId, 'GSTR7', r.period);
  if (!filed) throw badRequest(`GSTR-7 for ${monthLabel(r.period)} is not filed yet, so the deduction can simply be edited.`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date ?? '')) throw badRequest('Give the date of the correction.');
  const month = input.date.slice(0, 7);
  if (month <= r.period) throw badRequest(`The correction goes in a later return than ${monthLabel(r.period)}'s: date it after that month.`);
  await assertNotFiled(trx, orgId, 'GSTR7', month, 'its amendments', 'date the correction in a month not yet filed.');
  const role = await roleProfile(trx, orgId);
  const gstin = (input.deducteeGstin ?? r.deductee_gstin).trim().toUpperCase();
  if (!isValidGstin(gstin)) throw badRequest('That is not a valid GSTIN for the deductee.');
  if (!Number.isInteger(input.taxablePaise) || input.taxablePaise < 0) throw badRequest('Give the amount paid, excluding GST (nil if nothing should have been deducted).');
  const bill = r.bill_id ? await trx.selectFrom('bills').select(['place_of_supply', 'subtotal']).where('id', '=', r.bill_id).executeTakeFirst() : null;
  if (bill && input.taxablePaise > p(bill.subtotal)) throw badRequest(`The bill's taxable value is ${rupees(p(bill.subtotal))}; no more can have been paid under it.`);
  const pos = (input.placeOfSupply ?? bill?.place_of_supply ?? roleState(role, 'tds')).trim();
  let heads: WithholdingHeads = NO_HEADS;
  if (input.taxablePaise > 0) {
    const h = gstTdsHeads({ taxablePaise: input.taxablePaise, contractValuePaise: Math.max(p(r.contract_value), input.taxablePaise), supplierState: gstin.slice(0, 2), placeOfSupply: pos, recipientState: roleState(role, 'tds') });
    if (!h.applies) throw badRequest(`${h.reason} Amend the amount to nil instead.`);
    heads = h;
  }
  const original = { gstin: r.deductee_gstin, valuePaise: p(r.taxable), igstPaise: p(r.igst), cgstPaise: p(r.cgst), sgstPaise: p(r.sgst) };
  const amended = { gstin, valuePaise: input.taxablePaise, ...heads };
  if (original.gstin === amended.gstin && original.valuePaise === amended.valuePaise && headsTotal(original) === headsTotal(amended)) {
    throw badRequest('That is what was filed; there is nothing to amend.');
  }
  const delta = headsTotal(amended) - headsTotal(original);
  let entryId: number | null = null;
  if (delta !== 0) {
    const acc = await accountIds(trx, orgId);
    const ap = { accountId: requireAccount(acc, CODE.AP), contactId: r.vendor_id, description: `GST TDS amended (deduction of ${monthLabel(r.period)})` };
    const tds = { accountId: requireAccount(acc, CODE.GST_TDS_PAYABLE), description: 'GSTR-7 table 4 amendment' };
    entryId = (await postEntry(trx, {
      orgId, branchId: r.branch_id, date: input.date, userId, module: 'purchases',
      memo: `GST TDS deducted in ${monthLabel(r.period)} amended in ${monthLabel(month)}${because(input.notes)}`,
      sourceType: 'gst_tds_amendment', sourceId: id,
      lines: delta > 0 ? [{ ...ap, debit: delta }, { ...tds, credit: delta }] : [{ ...tds, debit: -delta }, { ...ap, credit: -delta }],
    })).id;
    await settleBill(trx, orgId, r.bill_id, delta);
  }
  const list = await amendmentsOf(trx, orgId, 'GSTR7', id);
  const same = list.find((a) => a.month === month);
  if (same) {
    same.amended = amended;
    same.date = input.date;
    if (entryId) same.entryIds.push(entryId);
  } else {
    list.push({ month, date: input.date, originalMonth: r.period, original, amended, entryIds: entryId ? [entryId] : [], by: userId });
  }
  await saveAmendments(trx, orgId, userId, 'GSTR7', id, list);
  await trx.updateTable('gst_tds_deductions').set({
    deductee_gstin: gstin, taxable: toSqlFromPaise(input.taxablePaise),
    igst: toSqlFromPaise(heads.igstPaise), cgst: toSqlFromPaise(heads.cgstPaise), sgst: toSqlFromPaise(heads.sgstPaise),
    notes: input.notes?.trim() || r.notes,
  }).where('id', '=', id).execute();
  return { id, month, deltaPaise: delta };
}

/** Take back an amendment made in a month not yet filed: its entries reversed, the filed figures restored. */
export async function undoGstTdsAmendment(trx: Trx, orgId: number, userId: number | null, id: number, month: string, reason?: string | null) {
  const r = await lockedDeduction(trx, orgId, id);
  await assertNotFiled(trx, orgId, 'GSTR7', month, 'this amendment', 'a correction to it goes in a later return.');
  const list = await amendmentsOf(trx, orgId, 'GSTR7', id);
  const a = list.find((x) => x.month === month);
  if (!a) throw notFound(`No amendment of this deduction is reported in ${monthLabel(month)}.`);
  if (list.some((x) => x.month > month)) throw conflict('It was amended again in a later month. Undo that amendment first.');
  for (const e of a.entryIds) await reverseForChange(trx, orgId, e, { memo: `GST TDS amendment undone${because(reason)}`, userId, module: 'purchases' });
  await settleBill(trx, orgId, r.bill_id, headsTotal(a.original) - headsTotal(a.amended));
  await trx.updateTable('gst_tds_deductions').set({
    deductee_gstin: a.original.gstin, taxable: toSqlFromPaise(a.original.valuePaise),
    igst: toSqlFromPaise(a.original.igstPaise), cgst: toSqlFromPaise(a.original.cgstPaise), sgst: toSqlFromPaise(a.original.sgstPaise),
  }).where('id', '=', id).execute();
  await saveAmendments(trx, orgId, userId, 'GSTR7', id, list.filter((x) => x !== a));
  return { id, month };
}

/** Put the GSTR-7A certificate number the portal issued on a deductee's deductions of a month. */
export async function setGstr7aNumber(trx: Trx, orgId: number, month: string, deducteeGstin: string, certificateNo: string | null) {
  if (!MONTH.test(month)) throw badRequest('Give the month as yyyy-mm.');
  const no = certificateNo?.trim().toUpperCase() || null;
  if (no && !/^[A-Z0-9/-]{4,30}$/.test(no)) throw badRequest('Give the certificate number as the portal shows it.');
  const r = await trx.updateTable('gst_tds_deductions').set({ certificate_no: no })
    .where('org_id', '=', orgId).where('period', '=', month).where('deductee_gstin', '=', deducteeGstin.trim().toUpperCase()).executeTakeFirst();
  if (!Number(r.numUpdatedRows)) throw notFound('No deduction from that deductee in that month.');
  return { certificateNo: no, rows: Number(r.numUpdatedRows) };
}

// ── The return ───────────────────────────────────────────────────────────────

export interface Gstr7Deduction {
  id: string; date: string; vendorId: string; vendorName: string; deducteeGstin: string;
  billId: string | null; billNo: string | null; vendorInvoiceNo: string | null;
  contractRef: string | null; contractValuePaise: number; taxablePaise: number;
  igstPaise: number; cgstPaise: number; sgstPaise: number; totalPaise: number;
  certificateNo: string | null; notes: string | null; amended: boolean;
}

export interface Gstr7Deductee {
  gstin: string; name: string; count: number; taxablePaise: number;
  igstPaise: number; cgstPaise: number; sgstPaise: number; totalPaise: number; certificateNo: string | null;
}

export interface Gstr7Amendment {
  deductionId: string; date: string; originalMonth: string; vendorName: string;
  originalGstin: string; originalTaxablePaise: number; originalTaxPaise: number;
  gstin: string; taxablePaise: number; igstPaise: number; cgstPaise: number; sgstPaise: number; deltaPaise: number;
}

export interface PendingTdsBill {
  billId: string; billNo: string; vendorInvoiceNo: string; billDate: string; vendorId: string; vendorName: string; gstin: string;
  placeOfSupply: string; taxablePaise: number; taxPaise: number; totalPaise: number; outstandingPaise: number;
  /** What the deduction would be, by the same rule as posting. */
  preview: { applies: boolean; reason: string; igstPaise: number; cgstPaise: number; sgstPaise: number; totalPaise: number };
}

export interface Gstr7 {
  period: { month: string; from: string; to: string; label: string };
  role: { on: boolean; gstin: string | null; ownGstin: boolean; legalName: string; tradeName: string | null; stateCode: string };
  dueDate: string;
  filing: { on: string; reference: string | null; by: string | null } | null;
  deductions: Gstr7Deduction[];
  table3: Gstr7Deductee[];
  table4: Gstr7Amendment[];
  table5: { payable: WithholdingHeads; paid: WithholdingHeads; balance: WithholdingHeads };
  table6: InterestLateFee;
  payment: WithholdingPaymentView | null;
  pending: PendingTdsBill[];
  tieOut: {
    /** Credit less debit on GST TDS Payable from deductions and amendments dated in the month. */
    ledgerWithheldPaise: number;
    returnWithheldPaise: number;
    differencePaise: number;
    /** Anything else posted to the account in the month (a manual journal): it explains a difference. */
    otherPaise: number;
    paymentsPaise: number;
    closingBalancePaise: number;
  };
  totals: { taxablePaise: number; taxPaise: number; deductees: number };
  notes: string[];
}

/** What the month withheld, by head: its deductions plus the amendments it reports. */
export async function gstr7Liability(ex: Executor, orgId: number, month: string): Promise<WithholdingHeads> {
  const r = await ex.selectFrom('gst_tds_deductions')
    .select([sql<string>`COALESCE(SUM(igst), 0)`.as('i'), sql<string>`COALESCE(SUM(cgst), 0)`.as('c'), sql<string>`COALESCE(SUM(sgst), 0)`.as('s')])
    .where('org_id', '=', orgId).where('period', '=', month).executeTakeFirst();
  const out = { igstPaise: p(r?.i), cgstPaise: p(r?.c), sgstPaise: p(r?.s) };
  for (const a of await amendmentsIn(ex, orgId, 'GSTR7', month)) {
    const d = amendmentDelta(a);
    out.igstPaise += d.igstPaise; out.cgstPaise += d.cgstPaise; out.sgstPaise += d.sgstPaise;
  }
  return out;
}

/** Bills from registered suppliers that are over the threshold and have no GST TDS against them yet. */
export async function pendingGstTds(ex: Executor, orgId: number, role?: RoleProfile): Promise<PendingTdsBill[]> {
  const r = role ?? await roleProfile(ex, orgId);
  const { rows } = await sql<{
    id: number; internal_no: string; vendor_invoice_no: string; bill_date: string; place_of_supply: string;
    subtotal: string; tax: string; total: string; amount_paid: string; vendor_id: number; name: string; gstin: string;
  }>`
    SELECT b.id, b.internal_no, b.vendor_invoice_no, b.bill_date, b.place_of_supply, b.subtotal,
           (b.cgst + b.sgst + b.igst) AS tax, b.total, b.amount_paid, c.id AS vendor_id,
           COALESCE(NULLIF(c.business_legal_name, ''), c.display_name) AS name, c.gstin
      FROM bills b JOIN contacts c ON c.id = b.vendor_id
     WHERE b.org_id = ${orgId} AND b.status NOT IN ('draft', 'void') AND b.is_rcm = 0
       AND NULLIF(c.gstin, '') IS NOT NULL
       AND b.subtotal > ${GST_TDS_THRESHOLD_PAISE / 100}
       AND (b.cgst + b.sgst + b.igst) > 0
       AND b.total > b.amount_paid
       AND NOT EXISTS (SELECT 1 FROM gst_tds_deductions d WHERE d.org_id = b.org_id AND d.bill_id = b.id)
     ORDER BY b.bill_date, b.id
     LIMIT 200
  `.execute(ex);
  return rows.map((b) => {
    const h = gstTdsHeads({
      taxablePaise: p(b.subtotal), contractValuePaise: p(b.subtotal), supplierState: b.gstin.slice(0, 2),
      placeOfSupply: b.place_of_supply, recipientState: roleState(r, 'tds'),
    });
    return {
      billId: String(b.id), billNo: b.internal_no, vendorInvoiceNo: b.vendor_invoice_no, billDate: day(b.bill_date),
      vendorId: String(b.vendor_id), vendorName: b.name, gstin: b.gstin, placeOfSupply: b.place_of_supply,
      taxablePaise: p(b.subtotal), taxPaise: p(b.tax), totalPaise: p(b.total), outstandingPaise: p(b.total) - p(b.amount_paid),
      preview: { applies: h.applies, reason: h.reason, igstPaise: h.igstPaise, cgstPaise: h.cgstPaise, sgstPaise: h.sgstPaise, totalPaise: headsTotal(h) },
    };
  });
}

export async function gstr7(ex: Executor, orgId: number, month: string, today: string): Promise<Gstr7> {
  if (!MONTH.test(month)) throw badRequest('Give the month as yyyy-mm.');
  const { from, to } = monthBounds(month);
  const role = await roleProfile(ex, orgId);
  const [filing, payment, amendmentsRaw] = await Promise.all([
    filingOf(ex, orgId, 'GSTR7', month),
    paymentFor(ex, orgId, 'GSTR7', month),
    amendmentsIn(ex, orgId, 'GSTR7', month),
  ]);

  const { rows } = await sql<{
    id: number; deduction_date: string; vendor_id: number; vendor_name: string; deductee_gstin: string; bill_id: number | null;
    internal_no: string | null; vendor_invoice_no: string | null; contract_ref: string | null; contract_value: string;
    taxable: string; igst: string; cgst: string; sgst: string; certificate_no: string | null; notes: string | null;
  }>`
    SELECT d.id, d.deduction_date, d.vendor_id, COALESCE(NULLIF(c.business_legal_name, ''), NULLIF(c.legal_name, ''), c.display_name) AS vendor_name,
           d.deductee_gstin, d.bill_id, b.internal_no, b.vendor_invoice_no, d.contract_ref, d.contract_value,
           d.taxable, d.igst, d.cgst, d.sgst, d.certificate_no, d.notes
      FROM gst_tds_deductions d
      JOIN contacts c ON c.id = d.vendor_id
      LEFT JOIN bills b ON b.id = d.bill_id
     WHERE d.org_id = ${orgId} AND d.period = ${month}
     ORDER BY d.deduction_date, d.id
  `.execute(ex);
  const amendedIds = new Set<number>();
  for (const r of rows) if ((await amendmentsOf(ex, orgId, 'GSTR7', r.id)).length) amendedIds.add(r.id);
  const deductions: Gstr7Deduction[] = rows.map((r) => {
    const h = { igstPaise: p(r.igst), cgstPaise: p(r.cgst), sgstPaise: p(r.sgst) };
    return {
      id: String(r.id), date: day(r.deduction_date), vendorId: String(r.vendor_id), vendorName: r.vendor_name, deducteeGstin: r.deductee_gstin,
      billId: r.bill_id ? String(r.bill_id) : null, billNo: r.internal_no, vendorInvoiceNo: r.vendor_invoice_no,
      contractRef: r.contract_ref, contractValuePaise: p(r.contract_value), taxablePaise: p(r.taxable),
      ...h, totalPaise: headsTotal(h), certificateNo: r.certificate_no, notes: r.notes, amended: amendedIds.has(r.id),
    };
  });

  // Table 3: one row per deductee, as the form and the portal file want it.
  const byGstin = new Map<string, Gstr7Deductee>();
  for (const d of deductions) {
    const t = byGstin.get(d.deducteeGstin) ?? {
      gstin: d.deducteeGstin, name: d.vendorName, count: 0, taxablePaise: 0, igstPaise: 0, cgstPaise: 0, sgstPaise: 0, totalPaise: 0, certificateNo: null,
    };
    t.count += 1; t.taxablePaise += d.taxablePaise; t.igstPaise += d.igstPaise; t.cgstPaise += d.cgstPaise; t.sgstPaise += d.sgstPaise; t.totalPaise += d.totalPaise;
    t.certificateNo = t.certificateNo ?? d.certificateNo;
    byGstin.set(d.deducteeGstin, t);
  }
  const table3 = [...byGstin.values()].sort((a, b) => a.gstin.localeCompare(b.gstin));

  // Table 4: corrections reported this month to deductions of earlier, filed months.
  const names = new Map<number, string>();
  if (amendmentsRaw.length) {
    const vs = await ex.selectFrom('gst_tds_deductions as d').innerJoin('contacts as c', 'c.id', 'd.vendor_id')
      .select(['d.id', 'c.display_name']).where('d.id', 'in', amendmentsRaw.map((a) => a.docId)).execute();
    for (const v of vs) names.set(v.id, v.display_name);
  }
  const table4: Gstr7Amendment[] = amendmentsRaw.map((a) => ({
    deductionId: String(a.docId), date: a.date, originalMonth: a.originalMonth, vendorName: names.get(a.docId) ?? a.amended.gstin,
    originalGstin: a.original.gstin, originalTaxablePaise: a.original.valuePaise, originalTaxPaise: headsTotal(a.original),
    gstin: a.amended.gstin, taxablePaise: a.amended.valuePaise, igstPaise: a.amended.igstPaise, cgstPaise: a.amended.cgstPaise, sgstPaise: a.amended.sgstPaise,
    deltaPaise: headsTotal(a.amended) - headsTotal(a.original),
  }));

  const payable = await gstr7Liability(ex, orgId, month);
  const paid = payment ? { igstPaise: payment.igstPaise, cgstPaise: payment.cgstPaise, sgstPaise: payment.sgstPaise } : NO_HEADS;
  const balance = { igstPaise: payable.igstPaise - paid.igstPaise, cgstPaise: payable.cgstPaise - paid.cgstPaise, sgstPaise: payable.sgstPaise - paid.sgstPaise };
  const table6 = interestAndLateFee('GSTR7', { month, today, filedOn: filing?.on ?? null, withheld: payable, paid, paidOn: payment?.paidOn ?? null });

  // The tie-out: GST TDS Payable's movement in the month, by what posted it.
  const bySource = await ledgerBySource(ex, orgId, CODE.GST_TDS_PAYABLE, month);
  const ledgerWithheld = (bySource.gst_tds ?? 0) + (bySource.gst_tds_amendment ?? 0);
  const paymentsPaise = -(bySource.gst_tax_payment ?? 0);
  const otherPaise = Object.entries(bySource).filter(([k]) => !['gst_tds', 'gst_tds_amendment', 'gst_tax_payment'].includes(k)).reduce((t, [, v]) => t + v, 0);
  const returnWithheld = headsTotal(payable);

  const notes: string[] = [];
  if (role.tds.on && !role.tds.own) notes.push('No GST TDS registration is set, so the primary branch GSTIN stands in. A deductor files GSTR-7 under its own registration (Rule 12): add it in Settings → Statutory.');
  if (deductions.some((d) => !d.certificateNo) && filing) notes.push('Once the return is filed, the portal issues each deductee a GSTR-7A certificate. Enter its number on each deductee\'s certificate.');
  if (otherPaise !== 0) notes.push(`${rupees(otherPaise)} was posted to GST TDS Payable this month by something other than a deduction or a payment (a journal). It is the difference in the tie-out.`);

  const legal = role.legalName;
  return {
    period: { month, from, to, label: monthLabel(month) },
    role: { on: role.tds.on, gstin: role.tds.gstin, ownGstin: role.tds.own, legalName: legal, tradeName: legal !== role.name ? role.name : null, stateCode: roleState(role, 'tds') },
    dueDate: withholdingDueDate(month),
    filing,
    deductions,
    table3,
    table4,
    table5: { payable, paid, balance },
    table6,
    payment,
    pending: role.tds.on ? await pendingGstTds(ex, orgId, role) : [],
    tieOut: {
      ledgerWithheldPaise: ledgerWithheld,
      returnWithheldPaise: returnWithheld,
      differencePaise: ledgerWithheld - returnWithheld,
      otherPaise,
      paymentsPaise,
      closingBalancePaise: await ledgerBalanceTo(ex, orgId, CODE.GST_TDS_PAYABLE, to),
    },
    totals: { taxablePaise: table3.reduce((t, r) => t + r.taxablePaise, 0), taxPaise: table3.reduce((t, r) => t + r.totalPaise, 0), deductees: table3.length },
    notes,
  };
}

// ── The portal's file ────────────────────────────────────────────────────────

const r2 = (paise: number) => Math.round(paise) / 100;

/**
 * GSTR-7 in the GSTN schema the offline tool and the portal take: the
 * deductor's GSTIN, fp as MMYYYY, one tds row per deductee and one tdsa row
 * per amended deduction, amounts in rupees to two places. Empty tables are
 * left out, as the portal's own files leave them.
 */
export function gstr7PortalJson(g: Gstr7) {
  const file: Record<string, unknown> = {
    gstin: g.role.gstin ?? '',
    fp: `${g.period.month.slice(5, 7)}${g.period.month.slice(0, 4)}`,
  };
  if (g.table3.length) {
    file.tds = g.table3.map((t) => ({ gstin_ded: t.gstin, amt_ded: r2(t.taxablePaise), iamt: r2(t.igstPaise), camt: r2(t.cgstPaise), samt: r2(t.sgstPaise) }));
  }
  if (g.table4.length) {
    file.tdsa = g.table4.map((a) => ({
      ogstin_ded: a.originalGstin, omonth: `${a.originalMonth.slice(5, 7)}${a.originalMonth.slice(0, 4)}`, oamt_ded: r2(a.originalTaxablePaise),
      gstin_ded: a.gstin, amt_ded: r2(a.taxablePaise), iamt: r2(a.igstPaise), camt: r2(a.cgstPaise), samt: r2(a.sgstPaise),
    }));
  }
  return file;
}

// ── GSTR-7A, the certificate to each deductee ────────────────────────────────

export async function gstr7aCertificate(ex: Executor, orgId: number, month: string, deducteeGstin: string) {
  if (!MONTH.test(month)) throw badRequest('Give the month as yyyy-mm.');
  const gstin = deducteeGstin.trim().toUpperCase();
  const role = await roleProfile(ex, orgId);
  const { rows } = await sql<{
    id: number; deduction_date: string; contract_ref: string | null; contract_value: string; taxable: string;
    igst: string; cgst: string; sgst: string; certificate_no: string | null; internal_no: string | null; vendor_invoice_no: string | null;
    bill_date: string | null; display_name: string; business_legal_name: string | null; business_trade_name: string | null; billing_address: string | null; state_code: string;
  }>`
    SELECT d.id, d.deduction_date, d.contract_ref, d.contract_value, d.taxable, d.igst, d.cgst, d.sgst, d.certificate_no,
           b.internal_no, b.vendor_invoice_no, b.bill_date, c.display_name, c.business_legal_name, c.business_trade_name, c.billing_address, c.state_code
      FROM gst_tds_deductions d JOIN contacts c ON c.id = d.vendor_id LEFT JOIN bills b ON b.id = d.bill_id
     WHERE d.org_id = ${orgId} AND d.period = ${month} AND d.deductee_gstin = ${gstin}
     ORDER BY d.deduction_date, d.id
  `.execute(ex);
  if (!rows.length) throw notFound('No GST TDS was deducted from that deductee in that month.');
  const [payment, filing, org] = await Promise.all([
    paymentFor(ex, orgId, 'GSTR7', month),
    filingOf(ex, orgId, 'GSTR7', month),
    ex.selectFrom('organizations').select(['address', 'email', 'phone']).where('id', '=', orgId).executeTakeFirstOrThrow(),
  ]);
  const first = rows[0];
  const lines = rows.map((r) => ({
    id: String(r.id), date: day(r.deduction_date), contractRef: r.contract_ref,
    contractValuePaise: p(r.contract_value), billNo: r.internal_no, vendorInvoiceNo: r.vendor_invoice_no, billDate: r.bill_date ? day(r.bill_date) : null,
    taxablePaise: p(r.taxable), igstPaise: p(r.igst), cgstPaise: p(r.cgst), sgstPaise: p(r.sgst),
  }));
  const sum = (k: 'taxablePaise' | 'igstPaise' | 'cgstPaise' | 'sgstPaise') => lines.reduce((t, l) => t + l[k], 0);
  return {
    certificateNo: rows.find((r) => r.certificate_no)?.certificate_no ?? null,
    month, monthLabel: monthLabel(month),
    deductor: { gstin: role.tds.gstin, legalName: role.legalName, tradeName: role.legalName !== role.name ? role.name : null, address: org.address, email: org.email, phone: org.phone },
    deductee: { gstin, legalName: first.business_legal_name || first.display_name, tradeName: first.business_trade_name, address: first.billing_address, stateCode: first.state_code },
    lines,
    totals: { taxablePaise: sum('taxablePaise'), igstPaise: sum('igstPaise'), cgstPaise: sum('cgstPaise'), sgstPaise: sum('sgstPaise'), taxPaise: sum('igstPaise') + sum('cgstPaise') + sum('sgstPaise') },
    paid: payment ? { on: payment.paidOn, cpin: payment.cpin } : null,
    filed: filing,
  };
}

// ── What the filing bar keeps when the month is marked filed ─────────────────

/**
 * What GSTR-7 said, document by document, kept when the month is marked
 * filed (gst_filed_documents): its own deductions (tds) and the amendments it
 * reported (tdsa). Written afresh each time, so marking it filed again after a
 * correction keeps the corrected return.
 */
export async function snapshotGstr7(trx: Trx, orgId: number, period: string): Promise<number> {
  await trx.deleteFrom('gst_filed_documents').where('org_id', '=', orgId).where('return_type', '=', 'GSTR7').where('period', '=', period).execute();
  const role = await roleProfile(trx, orgId);
  const own = await trx.selectFrom('gst_tds_deductions').selectAll().where('org_id', '=', orgId).where('period', '=', period).execute();
  const amended = await amendmentsIn(trx, orgId, 'GSTR7', period);
  const values = [
    ...own.map((d) => ({
      org_id: orgId, return_type: 'GSTR7', period, gstin: role.tds.gstin, doc_type: 'gst_tds', doc_id: d.id,
      number: d.contract_ref ?? `GST TDS ${d.id}`, doc_date: day(d.deduction_date), section: 'tds', ctin: d.deductee_gstin, pos: null,
      value: d.taxable, taxable: d.taxable, igst: d.igst, cgst: d.cgst, sgst: d.sgst, cess: '0', detail: null,
    })),
    ...amended.filter((a) => !own.some((d) => d.id === a.docId)).map((a: Amendment & { docId: number }) => ({
      org_id: orgId, return_type: 'GSTR7', period, gstin: role.tds.gstin, doc_type: 'gst_tds', doc_id: a.docId,
      number: `GST TDS ${a.docId}`, doc_date: a.date, section: 'tdsa', ctin: a.amended.gstin, pos: null,
      value: toSqlFromPaise(a.amended.valuePaise), taxable: toSqlFromPaise(a.amended.valuePaise),
      igst: toSqlFromPaise(a.amended.igstPaise), cgst: toSqlFromPaise(a.amended.cgstPaise), sgst: toSqlFromPaise(a.amended.sgstPaise), cess: '0',
      detail: JSON.stringify({ originalMonth: a.originalMonth, original: a.original }),
    })),
  ];
  if (values.length) await trx.insertInto('gst_filed_documents').values(values).execute();
  return values.length;
}

// ── Payments, through the shared code ────────────────────────────────────────

export type Gstr7PaymentInput = Omit<WithholdingPaymentInput, 'returnType'>;

export const recordGstr7Payment = (trx: Trx, orgId: number, userId: number | null, input: Gstr7PaymentInput) =>
  recordWithholdingPayment(trx, orgId, userId, { ...input, returnType: 'GSTR7' }, gstr7Liability);
export const updateGstr7Payment = (trx: Trx, orgId: number, userId: number | null, id: number, input: Gstr7PaymentInput) =>
  updateWithholdingPayment(trx, orgId, userId, id, { ...input, returnType: 'GSTR7' }, gstr7Liability);
export const deleteGstr7Payment = deleteWithholdingPayment;
