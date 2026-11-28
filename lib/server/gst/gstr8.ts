import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// GSTR-8: the return of an e-commerce operator who collects tax at source
// (CGST Act s.52, Rule 67).
//
// An operator that collects the consideration for supplies other people make
// through its platform keeps back TCS on their net value — 1% until 9 July
// 2024, 0.5% from 10 July 2024 (lib/gst/withholding.ts) — pays it over by the
// 10th of the next month, and files GSTR-8 supplier by supplier, with the
// supplies to registered and to unregistered buyers, and what came back, kept
// apart. The suppliers see the TCS in their cash ledger and in GSTR-2X.
//
// A month's supplies by one seller are booked here as one record (they come
// from the platform's settlement report, not invoice by invoice: the sellers
// raise the invoices). A TCS record posts
//   Dr Accounts Payable (the seller)   Cr GST TCS Payable (2270)
// — the operator owes the seller what it collected for them, less the TCS.
//
// Supplies notified under s.9(5) (restaurant service, passenger transport,
// accommodation and housekeeping through an app) are booked the same way but
// are not TCS: the operator is the person liable for the GST itself, at the
// supply's own rate, so they post Dr the seller / Cr Output GST, are left out
// of GSTR-8, and are reported in GSTR-3B table 3.1.1(i) and GSTR-1 table 15.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor, Trx } from '../db';
import { toSqlFromPaise } from '../money-sql';
import { badRequest, conflict, notFound } from '../http';
import { postEntry, type DraftLine } from '../ledger/posting';
import { CODE, accountIds, requireAccount } from '../ledger/chart-of-accounts';
import { plain, recordDeletion, reverseForChange } from '../services/doc-delete';
import { GST_STATES, isValidGstin } from '../../tax/gst';
import { monthLabel } from '../../date-range';
import { NO_HEADS, ecoHeads, ecoNetValue, ecoTcsRatePct, headsTotal, withholdingDueDate, type WithholdingHeads } from '../../gst/withholding';
import {
  MONTH, amendmentDelta, amendmentsIn, amendmentsOf, assertNotFiled, day, filingOf, interestAndLateFee,
  ledgerBalanceTo, ledgerBySource, monthBounds, p, paymentFor, recordWithholdingPayment, roleProfile, roleState,
  saveAmendments, updateWithholdingPayment, deleteWithholdingPayment,
  type Amendment, type AmendmentValues, type InterestLateFee, type WithholdingPaymentInput, type WithholdingPaymentView,
} from './withholding-common';

const because = (reason?: string | null) => (reason?.trim() ? ` — ${reason.trim()}` : '');
const rupees = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const OFF = 'This company is not set up as an e-commerce operator. Turn it on in Settings → Statutory → E-commerce operator (GSTR-8) first.';

export type EcoSection = '52' | '9_5';

export interface EcoSupplyInput {
  supplierId: number;
  /** The day the month's supplies are booked (the settlement date); its month is the return's. */
  entryDate: string;
  section: EcoSection;
  /** Where the supplies were made; against the supplier's State it decides IGST or CGST + SGST. */
  placeOfSupply: string;
  grossRegisteredPaise: number;
  returnsRegisteredPaise: number;
  grossUnregisteredPaise: number;
  returnsUnregisteredPaise: number;
  /** Section 9(5) only: the GST rate of the supply (5% for restaurant service through an app, say). */
  gstRatePct?: number | null;
  notes?: string | null;
}

interface Working {
  branchId: number;
  supplier: { id: number; name: string; gstin: string };
  inter: boolean;
  netPaise: number;
  heads: WithholdingHeads & { ratePct: number };
}

async function working(ex: Executor, orgId: number, input: EcoSupplyInput): Promise<Working> {
  const role = await roleProfile(ex, orgId);
  if (!role.eco.on) throw badRequest(OFF);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.entryDate ?? '')) throw badRequest('Give the date the month\'s supplies are booked on.');
  if (input.section !== '52' && input.section !== '9_5') throw badRequest('Say whether TCS is collected (section 52) or the operator pays the tax (section 9(5)).');
  if (!(input.placeOfSupply in GST_STATES)) throw badRequest('Pick the place of supply.');
  const amounts = [input.grossRegisteredPaise, input.returnsRegisteredPaise, input.grossUnregisteredPaise, input.returnsUnregisteredPaise];
  if (amounts.some((a) => !Number.isInteger(a) || a < 0)) throw badRequest('Values are whole paise, none below zero: returns go in their own columns.');
  if (amounts.every((a) => a === 0)) throw badRequest('Enter the supplies made through the platform, or what came back.');
  const c = await ex.selectFrom('contacts').select(['id', 'display_name', 'business_legal_name', 'gstin', 'state_code'])
    .where('id', '=', input.supplierId).where('org_id', '=', orgId).executeTakeFirst();
  if (!c) throw notFound('That supplier was not found.');
  const gstin = (c.gstin ?? '').trim().toUpperCase();
  if (input.section === '52') {
    // Every seller on a platform that collects TCS must be registered (s.24(ix)); GSTR-8 is filed by their GSTIN.
    if (!gstin || !isValidGstin(gstin)) throw badRequest(`TCS is reported against the seller's GSTIN, and ${c.display_name} has no valid one. Add it on the contact first.`);
  } else {
    // Under s.9(5) the seller may be unregistered (a small restaurant on an app): the operator is the one liable.
    if (!(input.gstRatePct != null && input.gstRatePct > 0 && input.gstRatePct <= 40)) throw badRequest('Give the GST rate of the supply: the operator pays it under section 9(5).');
  }
  const supplierState = gstin ? gstin.slice(0, 2) : c.state_code;
  const inter = supplierState !== input.placeOfSupply;
  const net = ecoNetValue(input);
  const heads = ecoHeads({ section: input.section, netPaise: net, date: input.entryDate, inter, gstRatePct: input.gstRatePct ?? undefined });
  return { branchId: role.branch.id, supplier: { id: c.id, name: c.business_legal_name || c.display_name, gstin }, inter, netPaise: net, heads };
}

/** What a record would come to before it is saved. */
export async function previewEcoSupply(ex: Executor, orgId: number, input: EcoSupplyInput) {
  const w = await working(ex, orgId, input);
  return { supplierName: w.supplier.name, supplierGstin: w.supplier.gstin, inter: w.inter, netPaise: w.netPaise, ...w.heads, totalPaise: headsTotal(w.heads) };
}

/** A positive amount on one side, a negative one on the other: a month of net returns reverses the sides. */
function side(accountId: number, amount: number, debitWhenPositive: boolean, extra: Partial<DraftLine> = {}): DraftLine {
  const debit = debitWhenPositive ? amount > 0 : amount < 0;
  return { accountId, ...(debit ? { debit: Math.abs(amount) } : { credit: Math.abs(amount) }), ...extra };
}

async function postSupply(trx: Trx, orgId: number, userId: number | null, id: number, w: Working, input: EcoSupplyInput) {
  const acc = await accountIds(trx, orgId);
  const total = headsTotal(w.heads);
  if (total === 0) return null;
  const ap = requireAccount(acc, CODE.AP);
  const lines: DraftLine[] = [side(ap, total, true, { contactId: w.supplier.id, description: input.section === '52' ? 'TCS kept back (section 52)' : 'GST the operator pays (section 9(5))' })];
  if (input.section === '52') {
    lines.push(side(requireAccount(acc, CODE.GST_TCS_PAYABLE), total, false, { description: `${w.heads.ratePct}% on ${rupees(w.netPaise)}` }));
  } else {
    if (w.heads.igstPaise) lines.push(side(requireAccount(acc, CODE.GST_IGST), w.heads.igstPaise, false, { description: 'Section 9(5): IGST payable by the operator' }));
    if (w.heads.cgstPaise) lines.push(side(requireAccount(acc, CODE.GST_CGST), w.heads.cgstPaise, false, { description: 'Section 9(5): CGST payable by the operator' }));
    if (w.heads.sgstPaise) lines.push(side(requireAccount(acc, CODE.GST_SGST), w.heads.sgstPaise, false, { description: 'Section 9(5): SGST payable by the operator' }));
  }
  const entry = await postEntry(trx, {
    orgId, branchId: w.branchId, date: input.entryDate, userId, module: input.section === '52' ? 'purchases' : 'sales',
    memo: `${input.section === '52' ? 'E-commerce TCS' : 'Section 9(5) GST'} on ${w.supplier.name}'s supplies through the platform, ${monthLabel(input.entryDate.slice(0, 7))}`,
    sourceType: 'gst_eco_supply', sourceId: id, lines,
  });
  return entry.id;
}

/** Which return a record is filed in: GSTR-8 for TCS; GSTR-3B for a section 9(5) supply. */
async function assertOpen(ex: Executor, orgId: number, section: EcoSection, month: string, what: string) {
  if (section === '52') {
    await assertNotFiled(ex, orgId, 'GSTR8', month, what, 'use Amend: the correction is reported in table 4 of a later GSTR-8.');
    return;
  }
  const f = await ex.selectFrom('compliance_filings').select(['done_on', 'reference']).where('org_id', '=', orgId)
    .where('item_key', '=', 'gstr3b').where('period', '=', month).executeTakeFirst();
  if (f) {
    throw conflict(`GSTR-3B for ${monthLabel(month)} is marked filed with ${what} in table 3.1.1(i). Book the correction in an open month: what came back goes in the "returned" columns.`);
  }
}

const values = (w: Working, input: EcoSupplyInput) => ({
  supplier_id: w.supplier.id, supplier_gstin: w.supplier.gstin, section: input.section, period: input.entryDate.slice(0, 7), entry_date: input.entryDate,
  place_of_supply: input.placeOfSupply, inter: w.inter ? 1 : 0,
  gross_registered: toSqlFromPaise(input.grossRegisteredPaise), returns_registered: toSqlFromPaise(input.returnsRegisteredPaise),
  gross_unregistered: toSqlFromPaise(input.grossUnregisteredPaise), returns_unregistered: toSqlFromPaise(input.returnsUnregisteredPaise),
  net_value: toSqlFromPaise(w.netPaise), rate_pct: String(w.heads.ratePct),
  igst: toSqlFromPaise(w.heads.igstPaise), cgst: toSqlFromPaise(w.heads.cgstPaise), sgst: toSqlFromPaise(w.heads.sgstPaise),
  notes: input.notes?.trim() || null,
});

export async function recordEcoSupply(trx: Trx, orgId: number, userId: number | null, input: EcoSupplyInput) {
  const w = await working(trx, orgId, input);
  await assertOpen(trx, orgId, input.section, input.entryDate.slice(0, 7), 'its supplies');
  const id = Number((await trx.insertInto('gst_eco_supplies').values({
    org_id: orgId, branch_id: w.branchId, ...values(w, input), created_by_user_id: userId,
  }).executeTakeFirstOrThrow()).insertId);
  const entryId = await postSupply(trx, orgId, userId, id, w, input);
  if (entryId) await trx.updateTable('gst_eco_supplies').set({ journal_entry_id: entryId }).where('id', '=', id).execute();
  return { id, period: input.entryDate.slice(0, 7), supplierName: w.supplier.name, netPaise: w.netPaise, ...w.heads, totalPaise: headsTotal(w.heads), journalEntryId: entryId };
}

async function lockedSupply(trx: Trx, orgId: number, id: number) {
  const r = await trx.selectFrom('gst_eco_supplies').selectAll().where('id', '=', id).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!r) throw notFound('That record of supplies was not found.');
  return { ...r, section: r.section as EcoSection };
}

export async function updateEcoSupply(trx: Trx, orgId: number, userId: number | null, id: number, input: EcoSupplyInput) {
  const r = await lockedSupply(trx, orgId, id);
  await assertOpen(trx, orgId, r.section, r.period, 'this record');
  if (input.entryDate.slice(0, 7) !== r.period || input.section !== r.section) await assertOpen(trx, orgId, input.section, input.entryDate.slice(0, 7), 'its supplies');
  await reverseForChange(trx, orgId, r.journal_entry_id, { memo: `E-commerce supplies record ${id} changed`, userId, module: r.section === '52' ? 'purchases' : 'sales' });
  const w = await working(trx, orgId, input);
  const entryId = await postSupply(trx, orgId, userId, id, w, input);
  await trx.updateTable('gst_eco_supplies').set({ branch_id: w.branchId, ...values(w, input), journal_entry_id: entryId }).where('id', '=', id).execute();
  return { id, netPaise: w.netPaise, ...w.heads, totalPaise: headsTotal(w.heads) };
}

export async function deleteEcoSupply(trx: Trx, orgId: number, userId: number | null, id: number, reason?: string | null) {
  const r = await lockedSupply(trx, orgId, id);
  await assertOpen(trx, orgId, r.section, r.period, 'this record');
  const c = await trx.selectFrom('contacts').select('display_name').where('id', '=', r.supplier_id).executeTakeFirst();
  const label = `${c?.display_name ?? r.supplier_gstin}'s supplies of ${monthLabel(r.period)}`;
  const reversal = await reverseForChange(trx, orgId, r.journal_entry_id, { memo: `${label} deleted${because(reason)}`, userId, module: r.section === '52' ? 'purchases' : 'sales' });
  await recordDeletion(trx, {
    orgId, userId, docType: 'gst_eco_supply', docId: id, number: label.slice(0, 60), date: day(r.entry_date),
    totalPaise: p(r.igst) + p(r.cgst) + p(r.sgst), contactId: r.supplier_id, branchId: r.branch_id,
    journalEntryId: r.journal_entry_id, reversalEntryId: reversal, reason, snapshot: plain(r),
  });
  await saveAmendments(trx, orgId, userId, 'GSTR8', id, []);
  await trx.deleteFrom('gst_eco_supplies').where('id', '=', id).execute();
  return { label, period: r.period };
}

// ── Amending TCS reported in a filed GSTR-8 ──────────────────────────────────

export interface EcoAmendInput {
  date: string;
  supplierGstin?: string | null;
  grossRegisteredPaise: number;
  returnsRegisteredPaise: number;
  grossUnregisteredPaise: number;
  returnsUnregisteredPaise: number;
  notes?: string | null;
}

const valuesOf = (r: { supplier_gstin: string; gross_registered: string; returns_registered: string; gross_unregistered: string; returns_unregistered: string; net_value: string; igst: string; cgst: string; sgst: string }): AmendmentValues => ({
  gstin: r.supplier_gstin, valuePaise: p(r.net_value),
  supR: p(r.gross_registered), retsupR: p(r.returns_registered), supU: p(r.gross_unregistered), retsupU: p(r.returns_unregistered),
  igstPaise: p(r.igst), cgstPaise: p(r.cgst), sgstPaise: p(r.sgst),
});

/**
 * Correct TCS reported in a filed GSTR-8, in a later month's table 4: the
 * original month stays as filed; the difference in TCS posts on the day of
 * the correction, at the rate that applied to the original supplies.
 */
export async function amendEcoSupply(trx: Trx, orgId: number, userId: number | null, id: number, input: EcoAmendInput) {
  const r = await lockedSupply(trx, orgId, id);
  if (r.section !== '52') throw badRequest('Only TCS reported in GSTR-8 is amended there. A section 9(5) supply is corrected in an open month\'s GSTR-3B: book what came back as returns.');
  if (!(await filingOf(trx, orgId, 'GSTR8', r.period))) throw badRequest(`GSTR-8 for ${monthLabel(r.period)} is not filed yet, so the record can simply be edited.`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date ?? '')) throw badRequest('Give the date of the correction.');
  const month = input.date.slice(0, 7);
  if (month <= r.period) throw badRequest(`The correction goes in a later return than ${monthLabel(r.period)}'s: date it after that month.`);
  await assertNotFiled(trx, orgId, 'GSTR8', month, 'its amendments', 'date the correction in a month not yet filed.');
  const gstin = (input.supplierGstin ?? r.supplier_gstin).trim().toUpperCase();
  if (!isValidGstin(gstin)) throw badRequest('That is not a valid GSTIN for the seller.');
  const amounts = [input.grossRegisteredPaise, input.returnsRegisteredPaise, input.grossUnregisteredPaise, input.returnsUnregisteredPaise];
  if (amounts.some((a) => !Number.isInteger(a) || a < 0)) throw badRequest('Values are whole paise, none below zero.');
  const net = ecoNetValue(input);
  const inter = gstin.slice(0, 2) !== r.place_of_supply;
  // The rate of the original supplies, not of the day of the correction.
  const heads = ecoHeads({ section: '52', netPaise: net, date: day(r.entry_date), inter });
  const original = valuesOf(r);
  const amended: AmendmentValues = {
    gstin, valuePaise: net, supR: input.grossRegisteredPaise, retsupR: input.returnsRegisteredPaise,
    supU: input.grossUnregisteredPaise, retsupU: input.returnsUnregisteredPaise,
    igstPaise: heads.igstPaise, cgstPaise: heads.cgstPaise, sgstPaise: heads.sgstPaise,
  };
  if (JSON.stringify(original) === JSON.stringify(amended)) throw badRequest('That is what was filed; there is nothing to amend.');
  const delta = headsTotal(amended) - headsTotal(original);
  let entryId: number | null = null;
  if (delta !== 0) {
    const acc = await accountIds(trx, orgId);
    entryId = (await postEntry(trx, {
      orgId, branchId: r.branch_id, date: input.date, userId, module: 'purchases',
      memo: `E-commerce TCS of ${monthLabel(r.period)} amended in ${monthLabel(month)}${because(input.notes)}`,
      sourceType: 'gst_eco_amendment', sourceId: id,
      lines: [
        side(requireAccount(acc, CODE.AP), delta, true, { contactId: r.supplier_id, description: `TCS amended (supplies of ${monthLabel(r.period)})` }),
        side(requireAccount(acc, CODE.GST_TCS_PAYABLE), delta, false, { description: 'GSTR-8 table 4 amendment' }),
      ],
    })).id;
  }
  const list = await amendmentsOf(trx, orgId, 'GSTR8', id);
  const same = list.find((a) => a.month === month);
  if (same) {
    same.amended = amended;
    same.date = input.date;
    if (entryId) same.entryIds.push(entryId);
  } else {
    list.push({ month, date: input.date, originalMonth: r.period, original, amended, entryIds: entryId ? [entryId] : [], by: userId });
  }
  await saveAmendments(trx, orgId, userId, 'GSTR8', id, list);
  await trx.updateTable('gst_eco_supplies').set({
    supplier_gstin: gstin, inter: inter ? 1 : 0,
    gross_registered: toSqlFromPaise(input.grossRegisteredPaise), returns_registered: toSqlFromPaise(input.returnsRegisteredPaise),
    gross_unregistered: toSqlFromPaise(input.grossUnregisteredPaise), returns_unregistered: toSqlFromPaise(input.returnsUnregisteredPaise),
    net_value: toSqlFromPaise(net), igst: toSqlFromPaise(heads.igstPaise), cgst: toSqlFromPaise(heads.cgstPaise), sgst: toSqlFromPaise(heads.sgstPaise),
    notes: input.notes?.trim() || r.notes,
  }).where('id', '=', id).execute();
  return { id, month, deltaPaise: delta };
}

export async function undoEcoAmendment(trx: Trx, orgId: number, userId: number | null, id: number, month: string, reason?: string | null) {
  await lockedSupply(trx, orgId, id);
  await assertNotFiled(trx, orgId, 'GSTR8', month, 'this amendment', 'a correction to it goes in a later return.');
  const list = await amendmentsOf(trx, orgId, 'GSTR8', id);
  const a = list.find((x) => x.month === month);
  if (!a) throw notFound(`No amendment of this record is reported in ${monthLabel(month)}.`);
  if (list.some((x) => x.month > month)) throw conflict('It was amended again in a later month. Undo that amendment first.');
  for (const e of a.entryIds) await reverseForChange(trx, orgId, e, { memo: `E-commerce TCS amendment undone${because(reason)}`, userId, module: 'purchases' });
  const o = a.original;
  await trx.updateTable('gst_eco_supplies').set({
    supplier_gstin: o.gstin,
    gross_registered: toSqlFromPaise(o.supR ?? 0), returns_registered: toSqlFromPaise(o.retsupR ?? 0),
    gross_unregistered: toSqlFromPaise(o.supU ?? 0), returns_unregistered: toSqlFromPaise(o.retsupU ?? 0),
    net_value: toSqlFromPaise(o.valuePaise), igst: toSqlFromPaise(o.igstPaise), cgst: toSqlFromPaise(o.cgstPaise), sgst: toSqlFromPaise(o.sgstPaise),
  }).where('id', '=', id).execute();
  await saveAmendments(trx, orgId, userId, 'GSTR8', id, list.filter((x) => x !== a));
  return { id, month };
}

// ── The return ───────────────────────────────────────────────────────────────

export interface EcoSupplyRow {
  id: string; date: string; section: EcoSection; supplierId: string; supplierName: string; supplierGstin: string;
  placeOfSupply: string; inter: boolean;
  grossRegisteredPaise: number; returnsRegisteredPaise: number; grossUnregisteredPaise: number; returnsUnregisteredPaise: number;
  netPaise: number; ratePct: number; igstPaise: number; cgstPaise: number; sgstPaise: number; totalPaise: number;
  notes: string | null; amended: boolean;
}

export interface Gstr8Supplier {
  gstin: string; name: string;
  supRPaise: number; retsupRPaise: number; supUPaise: number; retsupUPaise: number; netPaise: number;
  igstPaise: number; cgstPaise: number; sgstPaise: number; totalPaise: number;
}

export interface Gstr8Amendment {
  supplyId: string; date: string; originalMonth: string; supplierName: string;
  original: AmendmentValues; amended: AmendmentValues; deltaPaise: number;
}

export interface Gstr8 {
  period: { month: string; from: string; to: string; label: string };
  role: { on: boolean; gstin: string | null; ownGstin: boolean; legalName: string; tradeName: string | null; stateCode: string };
  dueDate: string;
  /** The TCS rate for supplies booked in this month. */
  ratePct: number;
  filing: { on: string; reference: string | null; by: string | null } | null;
  supplies: EcoSupplyRow[];
  table3: Gstr8Supplier[];
  table4: Gstr8Amendment[];
  table5: { payable: WithholdingHeads; paid: WithholdingHeads; balance: WithholdingHeads };
  table6: InterestLateFee;
  payment: WithholdingPaymentView | null;
  /** Section 9(5) supplies of the month: not in GSTR-8, reported in GSTR-3B 3.1.1(i). */
  section95: { count: number; netPaise: number; igstPaise: number; cgstPaise: number; sgstPaise: number };
  tieOut: {
    ledgerCollectedPaise: number; returnCollectedPaise: number; differencePaise: number;
    otherPaise: number; paymentsPaise: number; closingBalancePaise: number;
  };
  totals: { netPaise: number; taxPaise: number; suppliers: number };
  notes: string[];
}

export async function gstr8Liability(ex: Executor, orgId: number, month: string): Promise<WithholdingHeads> {
  const r = await ex.selectFrom('gst_eco_supplies')
    .select([sql<string>`COALESCE(SUM(igst), 0)`.as('i'), sql<string>`COALESCE(SUM(cgst), 0)`.as('c'), sql<string>`COALESCE(SUM(sgst), 0)`.as('s')])
    .where('org_id', '=', orgId).where('period', '=', month).where('section', '=', '52').executeTakeFirst();
  const out = { igstPaise: p(r?.i), cgstPaise: p(r?.c), sgstPaise: p(r?.s) };
  for (const a of await amendmentsIn(ex, orgId, 'GSTR8', month)) {
    const d = amendmentDelta(a);
    out.igstPaise += d.igstPaise; out.cgstPaise += d.cgstPaise; out.sgstPaise += d.sgstPaise;
  }
  return out;
}

export async function ecoSupplies(ex: Executor, orgId: number, month: string, section?: EcoSection): Promise<EcoSupplyRow[]> {
  const rows = await ex.selectFrom('gst_eco_supplies as s').innerJoin('contacts as c', 'c.id', 's.supplier_id')
    .select(['s.id', 's.entry_date', 's.section', 's.supplier_id', 'c.display_name', 'c.business_legal_name', 's.supplier_gstin', 's.place_of_supply', 's.inter',
      's.gross_registered', 's.returns_registered', 's.gross_unregistered', 's.returns_unregistered', 's.net_value', 's.rate_pct', 's.igst', 's.cgst', 's.sgst', 's.notes'])
    .where('s.org_id', '=', orgId).where('s.period', '=', month)
    .$if(!!section, (q) => q.where('s.section', '=', section!))
    .orderBy('s.entry_date').orderBy('s.id').execute();
  const out: EcoSupplyRow[] = [];
  for (const r of rows) {
    const h = { igstPaise: p(r.igst), cgstPaise: p(r.cgst), sgstPaise: p(r.sgst) };
    out.push({
      id: String(r.id), date: day(r.entry_date), section: r.section as EcoSection, supplierId: String(r.supplier_id),
      supplierName: r.business_legal_name || r.display_name, supplierGstin: r.supplier_gstin, placeOfSupply: r.place_of_supply, inter: !!r.inter,
      grossRegisteredPaise: p(r.gross_registered), returnsRegisteredPaise: p(r.returns_registered),
      grossUnregisteredPaise: p(r.gross_unregistered), returnsUnregisteredPaise: p(r.returns_unregistered),
      netPaise: p(r.net_value), ratePct: Number(r.rate_pct), ...h, totalPaise: headsTotal(h), notes: r.notes,
      amended: (await amendmentsOf(ex, orgId, 'GSTR8', r.id)).length > 0,
    });
  }
  return out;
}

export async function gstr8(ex: Executor, orgId: number, month: string, today: string): Promise<Gstr8> {
  if (!MONTH.test(month)) throw badRequest('Give the month as yyyy-mm.');
  const { from, to } = monthBounds(month);
  const role = await roleProfile(ex, orgId);
  const [filing, payment, supplies, amendmentsRaw] = await Promise.all([
    filingOf(ex, orgId, 'GSTR8', month),
    paymentFor(ex, orgId, 'GSTR8', month),
    ecoSupplies(ex, orgId, month),
    amendmentsIn(ex, orgId, 'GSTR8', month),
  ]);

  // Table 3: one row per seller GSTIN, the four values kept apart.
  const bySeller = new Map<string, Gstr8Supplier>();
  for (const s of supplies.filter((x) => x.section === '52')) {
    const t = bySeller.get(s.supplierGstin) ?? {
      gstin: s.supplierGstin, name: s.supplierName, supRPaise: 0, retsupRPaise: 0, supUPaise: 0, retsupUPaise: 0, netPaise: 0,
      igstPaise: 0, cgstPaise: 0, sgstPaise: 0, totalPaise: 0,
    };
    t.supRPaise += s.grossRegisteredPaise; t.retsupRPaise += s.returnsRegisteredPaise; t.supUPaise += s.grossUnregisteredPaise; t.retsupUPaise += s.returnsUnregisteredPaise;
    t.netPaise += s.netPaise; t.igstPaise += s.igstPaise; t.cgstPaise += s.cgstPaise; t.sgstPaise += s.sgstPaise; t.totalPaise += s.totalPaise;
    bySeller.set(s.supplierGstin, t);
  }
  const table3 = [...bySeller.values()].sort((a, b) => a.gstin.localeCompare(b.gstin));

  const names = new Map<number, string>();
  if (amendmentsRaw.length) {
    const vs = await ex.selectFrom('gst_eco_supplies as s').innerJoin('contacts as c', 'c.id', 's.supplier_id')
      .select(['s.id', 'c.display_name']).where('s.id', 'in', amendmentsRaw.map((a) => a.docId)).execute();
    for (const v of vs) names.set(v.id, v.display_name);
  }
  const table4: Gstr8Amendment[] = amendmentsRaw.map((a: Amendment & { docId: number }) => ({
    supplyId: String(a.docId), date: a.date, originalMonth: a.originalMonth, supplierName: names.get(a.docId) ?? a.amended.gstin,
    original: a.original, amended: a.amended, deltaPaise: headsTotal(a.amended) - headsTotal(a.original),
  }));

  const payable = await gstr8Liability(ex, orgId, month);
  const paid = payment ? { igstPaise: payment.igstPaise, cgstPaise: payment.cgstPaise, sgstPaise: payment.sgstPaise } : NO_HEADS;
  const balance = { igstPaise: payable.igstPaise - paid.igstPaise, cgstPaise: payable.cgstPaise - paid.cgstPaise, sgstPaise: payable.sgstPaise - paid.sgstPaise };
  const table6 = interestAndLateFee('GSTR8', { month, today, filedOn: filing?.on ?? null, withheld: payable, paid, paidOn: payment?.paidOn ?? null });

  const bySource = await ledgerBySource(ex, orgId, CODE.GST_TCS_PAYABLE, month);
  const ledgerCollected = (bySource.gst_eco_supply ?? 0) + (bySource.gst_eco_amendment ?? 0);
  const otherPaise = Object.entries(bySource).filter(([k]) => !['gst_eco_supply', 'gst_eco_amendment', 'gst_tax_payment'].includes(k)).reduce((t, [, v]) => t + v, 0);

  const nine = supplies.filter((s) => s.section === '9_5');
  const notes: string[] = [];
  if (role.eco.on && !role.eco.own) notes.push('No TCS registration is set, so the primary branch GSTIN stands in. An operator files GSTR-8 under its own TCS registration (Rule 12): add it in Settings → Statutory.');
  if (nine.length) notes.push(`${nine.length} record(s) of supplies under section 9(5) are not in GSTR-8: the operator pays that tax itself, in GSTR-3B table 3.1.1(i).`);
  if (otherPaise !== 0) notes.push(`${rupees(otherPaise)} was posted to GST TCS Payable this month by something other than these records or a payment (a journal). It is the difference in the tie-out.`);
  const legal = role.legalName;
  return {
    period: { month, from, to, label: monthLabel(month) },
    role: { on: role.eco.on, gstin: role.eco.gstin, ownGstin: role.eco.own, legalName: legal, tradeName: legal !== role.name ? role.name : null, stateCode: roleState(role, 'eco') },
    dueDate: withholdingDueDate(month),
    ratePct: ecoTcsRatePct(to),
    filing,
    supplies,
    table3,
    table4,
    table5: { payable, paid, balance },
    table6,
    payment,
    section95: {
      count: nine.length, netPaise: nine.reduce((t, s) => t + s.netPaise, 0),
      igstPaise: nine.reduce((t, s) => t + s.igstPaise, 0), cgstPaise: nine.reduce((t, s) => t + s.cgstPaise, 0), sgstPaise: nine.reduce((t, s) => t + s.sgstPaise, 0),
    },
    tieOut: {
      ledgerCollectedPaise: ledgerCollected,
      returnCollectedPaise: headsTotal(payable),
      differencePaise: ledgerCollected - headsTotal(payable),
      otherPaise,
      paymentsPaise: -(bySource.gst_tax_payment ?? 0),
      closingBalancePaise: await ledgerBalanceTo(ex, orgId, CODE.GST_TCS_PAYABLE, to),
    },
    totals: { netPaise: table3.reduce((t, r) => t + r.netPaise, 0), taxPaise: table3.reduce((t, r) => t + r.totalPaise, 0), suppliers: table3.length },
    notes,
  };
}

// ── The portal's file ────────────────────────────────────────────────────────

const r2 = (paise: number) => Math.round(paise) / 100;
const fp = (month: string) => `${month.slice(5, 7)}${month.slice(0, 4)}`;

/** GSTR-8 in the GSTN schema: one tcs row per seller, one tcsa row per amended record. */
export function gstr8PortalJson(g: Gstr8) {
  const file: Record<string, unknown> = { gstin: g.role.gstin ?? '', fp: fp(g.period.month) };
  if (g.table3.length) {
    file.tcs = g.table3.map((t) => ({
      stin: t.gstin, supR: r2(t.supRPaise), retsupR: r2(t.retsupRPaise), supU: r2(t.supUPaise), retsupU: r2(t.retsupUPaise),
      amt: r2(t.netPaise), iamt: r2(t.igstPaise), camt: r2(t.cgstPaise), samt: r2(t.sgstPaise),
    }));
  }
  if (g.table4.length) {
    file.tcsa = g.table4.map((a) => ({
      ofp: fp(a.originalMonth), ostin: a.original.gstin, stin: a.amended.gstin,
      supR: r2(a.amended.supR ?? 0), retsupR: r2(a.amended.retsupR ?? 0), supU: r2(a.amended.supU ?? 0), retsupU: r2(a.amended.retsupU ?? 0),
      amt: r2(a.amended.valuePaise), iamt: r2(a.amended.igstPaise), camt: r2(a.amended.cgstPaise), samt: r2(a.amended.sgstPaise),
    }));
  }
  return file;
}

/** What GSTR-8 said when it was marked filed: its TCS records (tcs) and the amendments it reported (tcsa). */
export async function snapshotGstr8(trx: Trx, orgId: number, period: string): Promise<number> {
  await trx.deleteFrom('gst_filed_documents').where('org_id', '=', orgId).where('return_type', '=', 'GSTR8').where('period', '=', period).execute();
  const role = await roleProfile(trx, orgId);
  const own = await trx.selectFrom('gst_eco_supplies').selectAll().where('org_id', '=', orgId).where('period', '=', period).where('section', '=', '52').execute();
  const amended = await amendmentsIn(trx, orgId, 'GSTR8', period);
  const rows = [
    ...own.map((s) => ({
      org_id: orgId, return_type: 'GSTR8', period, gstin: role.eco.gstin, doc_type: 'eco_supply', doc_id: s.id,
      number: `Supplies ${s.id}`, doc_date: day(s.entry_date), section: 'tcs', ctin: s.supplier_gstin, pos: s.place_of_supply,
      value: s.net_value, taxable: s.net_value, igst: s.igst, cgst: s.cgst, sgst: s.sgst, cess: '0',
      detail: JSON.stringify(valuesOf(s)),
    })),
    ...amended.filter((a) => !own.some((s) => s.id === a.docId)).map((a) => ({
      org_id: orgId, return_type: 'GSTR8', period, gstin: role.eco.gstin, doc_type: 'eco_supply', doc_id: a.docId,
      number: `Supplies ${a.docId}`, doc_date: a.date, section: 'tcsa', ctin: a.amended.gstin, pos: null,
      value: toSqlFromPaise(a.amended.valuePaise), taxable: toSqlFromPaise(a.amended.valuePaise),
      igst: toSqlFromPaise(a.amended.igstPaise), cgst: toSqlFromPaise(a.amended.cgstPaise), sgst: toSqlFromPaise(a.amended.sgstPaise), cess: '0',
      detail: JSON.stringify({ originalMonth: a.originalMonth, original: a.original, amended: a.amended }),
    })),
  ];
  if (rows.length) await trx.insertInto('gst_filed_documents').values(rows).execute();
  return rows.length;
}

export type Gstr8PaymentInput = Omit<WithholdingPaymentInput, 'returnType'>;
export const recordGstr8Payment = (trx: Trx, orgId: number, userId: number | null, input: Gstr8PaymentInput) =>
  recordWithholdingPayment(trx, orgId, userId, { ...input, returnType: 'GSTR8' }, gstr8Liability);
export const updateGstr8Payment = (trx: Trx, orgId: number, userId: number | null, id: number, input: Gstr8PaymentInput) =>
  updateWithholdingPayment(trx, orgId, userId, id, { ...input, returnType: 'GSTR8' }, gstr8Liability);
export const deleteGstr8Payment = deleteWithholdingPayment;
