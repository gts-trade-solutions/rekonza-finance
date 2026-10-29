import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// The documents around an invoice: estimates, sales orders, delivery challans,
// credit notes and retainers.
//
// The dividing line that matters here is which of these touch the ledger.
//
//   An estimate is an offer. A sales order is a promise. A delivery challan is
//   a movement of goods. None of them is a sale, so none of them posts a single
//   rupee. Recording an estimate as revenue would book money you may never see,
//   and inflate the GST you appear to owe on it.
//
//   A credit note and a retainer *are* transactions, and both post. A credit
//   note reverses part of a sale — revenue down, output tax down, and the
//   customer owes less. A retainer is money taken before the work is done, so
//   it is a liability until it is earned, never income on receipt.
//
// Everything here takes a transaction: the document and its posting are one
// atomic unit or they are nothing.
// ─────────────────────────────────────────────────────────────────────────────

import type { Trx } from '../db';
import type { Paise, SupplyType } from '../../types';
import { resolveSupplyType, totalTaxPaise } from '../../tax/gst';
import { roundToRupee } from '../../money';
import { toPaiseFromSql, toSqlFromPaise } from '../money-sql';
import { allocateNumber, allocateOrgNumber, assertGstDocNumber, postEntry, reverseEntry, type DraftLine } from '../ledger/posting';
import { seriesFor } from './voucher-types';
import { returnCostLines } from './stock-ledger';
import { CODE, accountIds, requireAccount } from '../ledger/chart-of-accounts';
import { costLines, type DocumentLineInput } from './lines';
import { fyLabelFor, createInvoice } from './sales';
import { ApiError, badRequest, conflict, notFound } from '../http';
import { voidReason, voidStamp } from './void-reason';
import { recordSerials } from './serials';
import { checkGodown } from './godowns';

// ── Shared preamble ──────────────────────────────────────────────────────────

interface PartyContext {
  branchStateCode: string;
  branchGstin: string | null;
  customerName: string;
  placeOfSupply: string;
  supplyType: SupplyType;
}

/**
 * Resolve the branch and customer, and work out how the supply is taxed.
 *
 * Where the supply lands decides everything downstream: same state as the
 * branch means CGST+SGST, a different one means IGST, and an overseas customer
 * means an export with its own rules. Every sales document needs this and they
 * all need it computed the same way.
 */
async function partyContext(
  trx: Trx,
  orgId: number,
  branchId: number,
  customerId: number,
  placeOfSupplyOverride?: string,
): Promise<PartyContext> {
  const branch = await trx
    .selectFrom('branches')
    .select(['id', 'state_code', 'gstin'])
    .where('id', '=', branchId)
    .where('org_id', '=', orgId)
    .executeTakeFirst();
  if (!branch) throw notFound('That branch does not exist.');

  const customer = await trx
    .selectFrom('contacts')
    .select(['id', 'display_name', 'state_code', 'gst_treatment'])
    .where('id', '=', customerId)
    .where('org_id', '=', orgId)
    .executeTakeFirst();
  if (!customer) throw notFound('That customer does not exist.');

  const placeOfSupply = placeOfSupplyOverride || customer.state_code;
  return {
    branchStateCode: branch.state_code,
    branchGstin: branch.gstin,
    customerName: customer.display_name,
    placeOfSupply,
    supplyType: resolveSupplyType({
      branchStateCode: branch.state_code,
      placeOfSupply,
      customerTreatment: customer.gst_treatment as never,
    }) as SupplyType,
  };
}

interface BaseDocInput {
  branchId: number;
  /** The godown the goods leave or enter; none is the branch's main one. */
  warehouseId?: number | null;
  customerId: number;
  date: string;
  lines: DocumentLineInput[];
  placeOfSupply?: string;
  notes?: string | null;
  number?: string;
  /** Numbered in a voucher type's own series. */
  voucherTypeId?: number | null;
}

export interface CreatedDocument {
  id: number;
  number: string;
  totalPaise: Paise;
  journalEntryId: number | null;
  /** Saved as a draft for approval because a rule caught it. */
  heldForApproval?: boolean;
}

// ── Estimates ────────────────────────────────────────────────────────────────

export interface CreateEstimateInput extends BaseDocInput {
  expiryDate: string;
  status?: 'draft' | 'sent';
}

/**
 * Create an estimate.
 *
 * Posts nothing. An estimate is a price somebody has been quoted; whether they
 * accept it is entirely their decision, and until they do no sale exists.
 */
export async function createEstimate(
  trx: Trx,
  orgId: number,
  userId: number | null,
  input: CreateEstimateInput,
): Promise<CreatedDocument> {
  const ctx = await partyContext(trx, orgId, input.branchId, input.customerId, input.placeOfSupply);
  const costed = await costLines(trx, orgId, ctx.supplyType, input.lines, 'sale_price', input.date);
  const { rounded } = roundToRupee(costed.tax.taxablePaise + totalTaxPaise(costed.tax));

  const series = await seriesFor(trx, orgId, 'EST', input.voucherTypeId);
  const number =
    input.number?.trim() ||
    (await allocateNumber(trx, orgId, input.branchId, series.docType, fyLabelFor(input.date), { prefix: series.prefix }));

  const inserted = await trx
    .insertInto('estimates')
    .values({
      org_id: orgId,
      branch_id: input.branchId,
      number,
      customer_id: input.customerId,
      estimate_date: input.date,
      expiry_date: input.expiryDate,
      place_of_supply: ctx.placeOfSupply,
      supply_type: ctx.supplyType,
      status: input.status ?? 'draft',
      subtotal: toSqlFromPaise(costed.tax.taxablePaise),
      cgst: toSqlFromPaise(costed.tax.cgstPaise),
      sgst: toSqlFromPaise(costed.tax.sgstPaise),
      igst: toSqlFromPaise(costed.tax.igstPaise),
      cess: toSqlFromPaise(costed.tax.cessPaise),
      total: toSqlFromPaise(rounded),
      notes: input.notes ?? null,
      created_by_user_id: userId,
    })
    .executeTakeFirstOrThrow();
  const id = Number(inserted.insertId);

  await trx
    .insertInto('estimate_lines')
    .values(
      costed.lines.map((c, i) => ({
        org_id: orgId,
        estimate_id: id,
        line_no: i + 1,
        item_id: c.itemId,
        description: c.description,
        hsn_sac: c.hsnSac,
        qty: c.qty,
        uqc: c.uqc,
        rate: toSqlFromPaise(c.ratePaise),
        discount_pct: c.discountPct,
        gst_rate_pct: c.gstRatePct,
        taxable: toSqlFromPaise(c.taxable),
        cgst: toSqlFromPaise(c.tax.cgstPaise),
        sgst: toSqlFromPaise(c.tax.sgstPaise),
        igst: toSqlFromPaise(c.tax.igstPaise),
        cess: toSqlFromPaise(c.tax.cessPaise),
        line_total: toSqlFromPaise(c.total),
      })),
    )
    .execute();

  return { id, number, totalPaise: rounded, journalEntryId: null };
}

// ── Sales orders ─────────────────────────────────────────────────────────────

export interface CreateSalesOrderInput extends BaseDocInput {
  expectedShipDate?: string | null;
  sourceEstimateId?: number | null;
}

/**
 * Create a sales order.
 *
 * Also posts nothing. An order is a commitment to supply, and the value of it
 * is real information — but it is not revenue and it is not a receivable until
 * something is actually delivered and invoiced. The gap between the order value
 * and what has been invoiced is the backlog, which the list screen shows.
 */
export async function createSalesOrder(
  trx: Trx,
  orgId: number,
  userId: number | null,
  input: CreateSalesOrderInput,
): Promise<CreatedDocument> {
  const ctx = await partyContext(trx, orgId, input.branchId, input.customerId, input.placeOfSupply);
  const costed = await costLines(trx, orgId, ctx.supplyType, input.lines, 'sale_price', input.date);
  const { rounded } = roundToRupee(costed.tax.taxablePaise + totalTaxPaise(costed.tax));

  const series = await seriesFor(trx, orgId, 'SO', input.voucherTypeId);
  const number =
    input.number?.trim() ||
    (await allocateNumber(trx, orgId, input.branchId, series.docType, fyLabelFor(input.date), { prefix: series.prefix }));

  const inserted = await trx
    .insertInto('sales_orders')
    .values({
      org_id: orgId,
      branch_id: input.branchId,
      number,
      customer_id: input.customerId,
      order_date: input.date,
      expected_ship_date: input.expectedShipDate ?? null,
      place_of_supply: ctx.placeOfSupply,
      supply_type: ctx.supplyType,
      status: 'open',
      subtotal: toSqlFromPaise(costed.tax.taxablePaise),
      cgst: toSqlFromPaise(costed.tax.cgstPaise),
      sgst: toSqlFromPaise(costed.tax.sgstPaise),
      igst: toSqlFromPaise(costed.tax.igstPaise),
      cess: toSqlFromPaise(costed.tax.cessPaise),
      total: toSqlFromPaise(rounded),
      invoiced_amount: toSqlFromPaise(0),
      source_estimate_id: input.sourceEstimateId ?? null,
      created_by_user_id: userId,
    })
    .executeTakeFirstOrThrow();
  const id = Number(inserted.insertId);

  await trx
    .insertInto('sales_order_lines')
    .values(
      costed.lines.map((c, i) => ({
        org_id: orgId,
        sales_order_id: id,
        line_no: i + 1,
        item_id: c.itemId,
        description: c.description,
        hsn_sac: c.hsnSac,
        qty: c.qty,
        uqc: c.uqc,
        rate: toSqlFromPaise(c.ratePaise),
        discount_pct: c.discountPct,
        gst_rate_pct: c.gstRatePct,
        taxable: toSqlFromPaise(c.taxable),
        cgst: toSqlFromPaise(c.tax.cgstPaise),
        sgst: toSqlFromPaise(c.tax.sgstPaise),
        igst: toSqlFromPaise(c.tax.igstPaise),
        cess: toSqlFromPaise(c.tax.cessPaise),
        line_total: toSqlFromPaise(c.total),
      })),
    )
    .execute();

  if (input.sourceEstimateId) {
    await trx
      .updateTable('estimates')
      .set({ status: 'converted', converted_to_type: 'sales_order', converted_to_id: id })
      .where('id', '=', input.sourceEstimateId)
      .where('org_id', '=', orgId)
      .execute();
  }

  return { id, number, totalPaise: rounded, journalEntryId: null };
}

// ── Delivery challans ────────────────────────────────────────────────────────

export interface CreateChallanInput {
  branchId: number;
  customerId: number;
  date: string;
  challanType?: 'job_work' | 'supply_on_approval' | 'liquid_gas' | 'other';
  placeOfSupply?: string;
  notes?: string | null;
  number?: string;
  voucherTypeId?: number | null;
  lines: { itemId?: number | null; description?: string | null; hsnSac?: string | null; qty: number; uqc?: string | null; ratePaise?: Paise }[];
}

/**
 * Create a delivery challan.
 *
 * A challan moves goods without selling them — to a job worker, or on approval.
 * It carries a value so the goods can be insured and so an e-way bill can be
 * raised against it, but that value is not a sale and never reaches the ledger.
 * Ownership has not changed hands.
 */
export async function createChallan(
  trx: Trx,
  orgId: number,
  userId: number | null,
  input: CreateChallanInput,
): Promise<CreatedDocument> {
  if (!input.lines.length) throw badRequest('A challan needs at least one line.');
  const ctx = await partyContext(trx, orgId, input.branchId, input.customerId, input.placeOfSupply);

  const itemIds = input.lines.map((l) => l.itemId).filter((x): x is number => !!x);
  const items = itemIds.length
    ? await trx
        .selectFrom('items')
        .select(['id', 'name', 'hsn_sac', 'uqc', 'sale_price'])
        .where('org_id', '=', orgId)
        .where('id', 'in', itemIds)
        .execute()
    : [];
  const itemById = new Map(items.map((i) => [i.id, i]));

  const priced = input.lines.map((l, idx) => {
    const item = l.itemId ? itemById.get(l.itemId) : undefined;
    if (l.itemId && !item) throw badRequest(`Line ${idx + 1} refers to an item that does not exist.`);
    if (l.qty <= 0) throw badRequest(`Line ${idx + 1} needs a quantity above zero.`);
    const rate = l.ratePaise ?? (item ? toPaiseFromSql(item.sale_price) : 0);
    return {
      itemId: l.itemId ?? null,
      description: l.description ?? item?.name ?? null,
      hsnSac: l.hsnSac ?? item?.hsn_sac ?? null,
      qty: l.qty,
      uqc: l.uqc ?? item?.uqc ?? 'NOS',
      rate,
      lineTotal: Math.round(rate * l.qty),
    };
  });
  const total = priced.reduce((t, l) => t + l.lineTotal, 0);

  // A hand-typed number has to meet the same GST rules as an allocated one.
  const typed = input.number?.trim();
  if (typed) assertGstDocNumber(typed, 'A delivery challan number');
  const series = await seriesFor(trx, orgId, 'DC', input.voucherTypeId);
  const number =
    typed ||
    (await allocateNumber(trx, orgId, input.branchId, series.docType, fyLabelFor(input.date), { prefix: series.prefix }));

  const inserted = await trx
    .insertInto('delivery_challans')
    .values({
      org_id: orgId,
      branch_id: input.branchId,
      number,
      customer_id: input.customerId,
      challan_date: input.date,
      challan_type: input.challanType ?? 'other',
      place_of_supply: ctx.placeOfSupply,
      status: 'open',
      total: toSqlFromPaise(total),
      notes: input.notes ?? null,
      created_by_user_id: userId,
    })
    .executeTakeFirstOrThrow();
  const id = Number(inserted.insertId);

  await trx
    .insertInto('challan_lines')
    .values(
      priced.map((l, i) => ({
        org_id: orgId,
        challan_id: id,
        line_no: i + 1,
        item_id: l.itemId,
        description: l.description,
        hsn_sac: l.hsnSac,
        qty: l.qty,
        uqc: l.uqc,
        rate: toSqlFromPaise(l.rate),
        line_total: toSqlFromPaise(l.lineTotal),
      })),
    )
    .execute();

  return { id, number, totalPaise: total, journalEntryId: null };
}

// ── Credit notes ─────────────────────────────────────────────────────────────

export interface CreateCreditNoteInput extends BaseDocInput {
  reason: string;
  againstInvoiceId?: number | null;
  /** Apply it against the invoice immediately, up to that invoice's balance. */
  applyImmediately?: boolean;
}

/**
 * Create a credit note, and post it.
 *
 * The entry is the invoice's, reversed for the part being credited:
 *
 *   Dr Sales                   revenue that turned out not to be earned
 *   Dr Output CGST/SGST/IGST   tax no longer collectible on it
 *     Cr Accounts Receivable   the customer owes that much less
 *
 * Note what this is not: it is not a refund. No money moves. Most credit notes
 * are set against the customer's next invoice and cash never changes hands —
 * which is exactly why the refund report is a separate thing.
 */
export async function createCreditNote(
  trx: Trx,
  orgId: number,
  userId: number | null,
  input: CreateCreditNoteInput,
): Promise<CreatedDocument> {
  if (!input.reason?.trim()) {
    // GST requires a reason on every credit note; it is reported in GSTR-1.
    throw badRequest('A credit note needs a reason — it is reported in GSTR-1.');
  }

  const ctx = await partyContext(trx, orgId, input.branchId, input.customerId, input.placeOfSupply);
  const costed = await costLines(trx, orgId, ctx.supplyType, input.lines, 'sale_price', input.date);
  const { rounded } = roundToRupee(costed.tax.taxablePaise + totalTaxPaise(costed.tax));

  let invoice: { id: number; number: string; total: string; amount_paid: string } | undefined;
  if (input.againstInvoiceId) {
    invoice = await trx
      .selectFrom('invoices')
      .select(['id', 'number', 'total', 'amount_paid'])
      .where('id', '=', input.againstInvoiceId)
      .where('org_id', '=', orgId)
      .where('customer_id', '=', input.customerId)
      .executeTakeFirst();
    if (!invoice) {
      throw badRequest('That invoice does not exist, or belongs to a different customer.');
    }
    const balance = toPaiseFromSql(invoice.total) - toPaiseFromSql(invoice.amount_paid);
    if (rounded > balance) {
      throw badRequest(
        `The credit is larger than what is still owed on ${invoice.number}. ` +
          'Credit only the outstanding amount, or raise it without linking an invoice.',
      );
    }
  }

  const typed = input.number?.trim();
  if (typed) assertGstDocNumber(typed, 'A credit note number');
  const series = await seriesFor(trx, orgId, 'CN', input.voucherTypeId);
  const number =
    typed ||
    (await allocateNumber(trx, orgId, input.branchId, series.docType, fyLabelFor(input.date), { prefix: series.prefix }));

  // Goods coming back go into the batch they went out in: the one named on
  // the line, or failing that the one the invoice sold.
  const itemIds = [...new Set(costed.lines.map((c) => c.itemId).filter((x): x is number => !!x))];
  const tracked = itemIds.length
    ? new Set((await trx.selectFrom('items').select('id').where('org_id', '=', orgId).where('track_batches', '=', 1).where('id', 'in', itemIds).execute()).map((r) => r.id))
    : new Set<number>();
  const sold = new Map<number, number>();
  if (tracked.size && input.againstInvoiceId) {
    for (const r of await trx.selectFrom('invoice_lines').select(['item_id', 'batch_id']).where('invoice_id', '=', input.againstInvoiceId).where('batch_id', 'is not', null).execute()) {
      if (r.item_id && r.batch_id && !sold.has(r.item_id)) sold.set(r.item_id, r.batch_id);
    }
  }
  const lineBatch: (number | null)[] = [];
  for (const [i, c] of costed.lines.entries()) {
    if (!c.itemId || !tracked.has(c.itemId)) { lineBatch.push(null); continue; }
    const named = input.lines[i]?.batchId ?? null;
    if (named) {
      const ok = await trx.selectFrom('batches').select('id').where('id', '=', named).where('org_id', '=', orgId).where('item_id', '=', c.itemId).executeTakeFirst();
      if (!ok) throw badRequest(`Line ${i + 1}: that batch is not one of this item's.`);
    }
    lineBatch.push(named ?? sold.get(c.itemId) ?? null);
  }

  const inserted = await trx
    .insertInto('credit_notes')
    .values({
      org_id: orgId,
      branch_id: input.branchId,
      warehouse_id: await checkGodown(trx, orgId, input.branchId, input.warehouseId),
      number,
      customer_id: input.customerId,
      note_date: input.date,
      reason: input.reason.trim(),
      against_invoice_id: input.againstInvoiceId ?? null,
      place_of_supply: ctx.placeOfSupply,
      supply_type: ctx.supplyType,
      status: 'open',
      subtotal: toSqlFromPaise(costed.tax.taxablePaise),
      cgst: toSqlFromPaise(costed.tax.cgstPaise),
      sgst: toSqlFromPaise(costed.tax.sgstPaise),
      igst: toSqlFromPaise(costed.tax.igstPaise),
      cess: toSqlFromPaise(costed.tax.cessPaise),
      total: toSqlFromPaise(rounded),
      applied_amount: toSqlFromPaise(0),
      created_by_user_id: userId,
    })
    .executeTakeFirstOrThrow();
  const id = Number(inserted.insertId);

  await trx
    .insertInto('credit_note_lines')
    .values(
      costed.lines.map((c, i) => ({
        org_id: orgId,
        credit_note_id: id,
        line_no: i + 1,
        item_id: c.itemId,
        description: c.description,
        hsn_sac: c.hsnSac,
        qty: c.qty,
        uqc: c.uqc,
        rate: toSqlFromPaise(c.ratePaise),
        discount_pct: c.discountPct,
        gst_rate_pct: c.gstRatePct,
        cess_rate_pct: c.cessRatePct,
        taxable: toSqlFromPaise(c.taxable),
        cgst: toSqlFromPaise(c.tax.cgstPaise),
        sgst: toSqlFromPaise(c.tax.sgstPaise),
        igst: toSqlFromPaise(c.tax.igstPaise),
        cess: toSqlFromPaise(c.tax.cessPaise),
        line_total: toSqlFromPaise(c.total),
        batch_id: lineBatch[i] ?? null,
      })),
    )
    .execute();
  // Numbered pieces coming back: each has to have gone out.
  const cnLineIds = (await trx.selectFrom('credit_note_lines').select('id').where('credit_note_id', '=', id).orderBy('line_no').execute()).map((r) => r.id);
  await recordSerials(trx, orgId, { type: 'credit_note', id }, 1,
    input.lines.map((l, i) => ({ lineId: cnLineIds[i] ?? null, itemId: l.itemId, qty: l.qty, serials: l.serials })), { check: true });

  const acc = await accountIds(trx, orgId);
  const lines: DraftLine[] = [
    { accountId: requireAccount(acc, CODE.SALES), debit: costed.tax.taxablePaise },
    { accountId: requireAccount(acc, CODE.GST_CGST), debit: costed.tax.cgstPaise },
    { accountId: requireAccount(acc, CODE.GST_SGST), debit: costed.tax.sgstPaise },
    { accountId: requireAccount(acc, CODE.GST_IGST), debit: costed.tax.igstPaise },
    { accountId: requireAccount(acc, CODE.GST_CESS), debit: costed.tax.cessPaise },
    { accountId: requireAccount(acc, CODE.AR), credit: rounded, contactId: input.customerId },
  ];

  // Rounding the credit to the rupee leaves the same paisa remainder an invoice
  // does, and it goes to the same place.
  const rawTotal = costed.tax.taxablePaise + totalTaxPaise(costed.tax);
  const roundOff = rounded - rawTotal;
  if (roundOff > 0) lines.push({ accountId: requireAccount(acc, CODE.ROUNDING), debit: roundOff });
  else if (roundOff < 0) lines.push({ accountId: requireAccount(acc, CODE.ROUNDING), credit: -roundOff });

  // Goods coming back go back into Inventory at their cost, on a perpetual book.
  lines.push(...await returnCostLines(trx, orgId, input.date,
    input.lines.map((l) => ({ itemId: l.itemId ? Number(l.itemId) : null, qty: Number(l.qty) }))));

  const entry = await postEntry(trx, {
    orgId,
    branchId: input.branchId,
    date: input.date,
    memo: `Credit note ${number}${invoice ? ` against ${invoice.number}` : ''}`,
    sourceType: 'credit_note',
    sourceId: id,
    userId,
    module: 'sales',
    lines,
  });

  await trx.updateTable('credit_notes').set({ journal_entry_id: entry.id }).where('id', '=', id).execute();

  // Setting it against the invoice is an allocation, not a second posting. The
  // journal entry above already reduced receivables; this records *which*
  // invoice the reduction belongs to, so the ageing report and the control
  // account keep saying the same thing.
  if (invoice && input.applyImmediately !== false) {
    await trx
      .updateTable('invoices')
      .set((eb) => ({ amount_paid: eb('amount_paid', '+', toSqlFromPaise(rounded)) }))
      .where('id', '=', invoice.id)
      .execute();
    await trx
      .updateTable('credit_notes')
      .set({ applied_amount: toSqlFromPaise(rounded), status: 'applied' })
      .where('id', '=', id)
      .execute();
    await settleIfPaid(trx, orgId, invoice.id);
  }

  return { id, number, totalPaise: rounded, journalEntryId: entry.id };
}

/** Move an invoice to 'paid' once nothing is left owing on it. */
async function settleIfPaid(trx: Trx, orgId: number, invoiceId: number): Promise<void> {
  const inv = await trx
    .selectFrom('invoices')
    .select(['id', 'status', 'total', 'amount_paid'])
    .where('id', '=', invoiceId)
    .where('org_id', '=', orgId)
    .executeTakeFirst();
  if (!inv || inv.status === 'void' || inv.status === 'draft') return;

  const balance = toPaiseFromSql(inv.total) - toPaiseFromSql(inv.amount_paid);
  const status = balance <= 0 ? 'paid' : 'partially_paid';
  if (inv.status !== status) {
    await trx.updateTable('invoices').set({ status }).where('id', '=', invoiceId).execute();
  }
}

/**
 * Refund a credit note in cash.
 *
 * This is the case where money really does leave:
 *
 *   Dr Accounts Receivable   the customer no longer holds a credit with us
 *     Cr Bank                the cash that went back to them
 *
 * The credit note itself already reduced receivables when it was raised. This
 * puts that reduction back and takes the money out of the bank instead.
 */
export async function refundCreditNote(
  trx: Trx,
  orgId: number,
  userId: number | null,
  creditNoteId: number,
  input: { bankAccountId: number; date: string; amountPaise?: Paise; reference?: string | null },
): Promise<{ journalEntryId: number; refundedPaise: Paise }> {
  const cn = await trx
    .selectFrom('credit_notes')
    .select(['id', 'number', 'branch_id', 'customer_id', 'status', 'total', 'applied_amount'])
    .where('id', '=', creditNoteId)
    .where('org_id', '=', orgId)
    .executeTakeFirst();
  if (!cn) throw notFound('That credit note does not exist.');
  if (cn.status === 'void') throw conflict('That credit note has been voided.');

  const unapplied = toPaiseFromSql(cn.total) - toPaiseFromSql(cn.applied_amount);
  const amount = input.amountPaise ?? unapplied;
  if (amount <= 0) throw badRequest('There is nothing left on this credit note to refund.');
  if (amount > unapplied) {
    throw badRequest(
      `Only ${(unapplied / 100).toFixed(2)} is unapplied on ${cn.number}. ` +
        'The rest has already been set against invoices.',
    );
  }

  const bank = await trx
    .selectFrom('bank_accounts')
    .select(['id', 'name', 'ledger_account_id'])
    .where('id', '=', input.bankAccountId)
    .where('org_id', '=', orgId)
    .executeTakeFirst();
  if (!bank) throw notFound('That bank account does not exist.');

  const acc = await accountIds(trx, orgId);
  const entry = await postEntry(trx, {
    orgId,
    branchId: cn.branch_id,
    date: input.date,
    memo: `Refund of credit note ${cn.number}${input.reference ? ` — ${input.reference}` : ''}`,
    sourceType: 'credit_note_refund',
    sourceId: creditNoteId,
    userId,
    module: 'sales',
    lines: [
      { accountId: requireAccount(acc, CODE.AR), debit: amount, contactId: cn.customer_id },
      { accountId: bank.ledger_account_id, credit: amount },
    ],
  });

  await trx
    .updateTable('credit_notes')
    .set({
      status: 'refunded',
      applied_amount: toSqlFromPaise(toPaiseFromSql(cn.applied_amount) + amount),
    })
    .where('id', '=', creditNoteId)
    .execute();

  return { journalEntryId: entry.id, refundedPaise: amount };
}

// ── Retainers ────────────────────────────────────────────────────────────────

export interface CreateRetainerInput {
  branchId: number;
  customerId: number;
  date: string;
  description: string;
  amountPaise: Paise;
  number?: string;
  status?: 'draft' | 'sent';
}

/**
 * Raise a retainer invoice, and post it.
 *
 *   Dr Accounts Receivable    the customer owes the advance
 *     Cr Unearned revenue     we owe them the work
 *
 * The credit side is the point. Money taken before the work is done is a
 * liability, not income: if the engagement ends tomorrow it has to be given
 * back. It becomes revenue only when a real invoice is raised and the retainer
 * is applied against it.
 */
export async function createRetainer(
  trx: Trx,
  orgId: number,
  userId: number | null,
  input: CreateRetainerInput,
): Promise<CreatedDocument> {
  if (input.amountPaise <= 0) throw badRequest('A retainer needs an amount above zero.');
  await partyContext(trx, orgId, input.branchId, input.customerId);

  const number =
    input.number?.trim() ||
    (await allocateOrgNumber(trx, orgId, 'RET', fyLabelFor(input.date), 'RET'));

  const inserted = await trx
    .insertInto('retainer_invoices')
    .values({
      org_id: orgId,
      branch_id: input.branchId,
      number,
      customer_id: input.customerId,
      retainer_date: input.date,
      status: input.status ?? 'sent',
      description: input.description,
      amount: toSqlFromPaise(input.amountPaise),
      applied_amount: toSqlFromPaise(0),
      created_by_user_id: userId,
    })
    .executeTakeFirstOrThrow();
  const id = Number(inserted.insertId);

  const acc = await accountIds(trx, orgId);
  const entry = await postEntry(trx, {
    orgId,
    branchId: input.branchId,
    date: input.date,
    memo: `Retainer ${number} — ${input.description}`,
    sourceType: 'retainer',
    sourceId: id,
    userId,
    module: 'sales',
    lines: [
      { accountId: requireAccount(acc, CODE.AR), debit: input.amountPaise, contactId: input.customerId },
      { accountId: requireAccount(acc, CODE.UNEARNED), credit: input.amountPaise },
    ],
  });

  await trx.updateTable('retainer_invoices').set({ journal_entry_id: entry.id }).where('id', '=', id).execute();

  return { id, number, totalPaise: input.amountPaise, journalEntryId: entry.id };
}

/**
 * Apply a retainer against an invoice — the moment the advance is earned.
 *
 *   Dr Unearned revenue        we no longer owe the work; it has been done
 *     Cr Accounts Receivable   and this invoice is settled by that much
 */
export async function applyRetainer(
  trx: Trx,
  orgId: number,
  userId: number | null,
  retainerId: number,
  invoiceId: number,
  amountPaise?: Paise,
): Promise<{ journalEntryId: number; appliedPaise: Paise }> {
  const r = await trx
    .selectFrom('retainer_invoices')
    .select(['id', 'number', 'branch_id', 'customer_id', 'status', 'amount', 'amount_paid', 'applied_amount'])
    .where('id', '=', retainerId)
    .where('org_id', '=', orgId)
    .executeTakeFirst();
  if (!r) throw notFound('That retainer does not exist.');
  if (r.status === 'void') throw conflict('That retainer has been voided.');

  const inv = await trx
    .selectFrom('invoices')
    .select(['id', 'number', 'customer_id', 'status', 'total', 'amount_paid'])
    .where('id', '=', invoiceId)
    .where('org_id', '=', orgId)
    .executeTakeFirst();
  if (!inv) throw notFound('That invoice does not exist.');
  if (inv.customer_id !== r.customer_id) {
    throw badRequest('A retainer can only settle invoices for the customer who paid it.');
  }
  if (inv.status === 'draft' || inv.status === 'void') {
    throw badRequest('Only an issued invoice can be settled.');
  }

  // Only money that has actually arrived can be spent. Applying an advance the
  // customer has not paid would release a liability that was never funded.
  const paid = toPaiseFromSql(r.amount_paid);
  if (paid <= 0) {
    throw badRequest(
      `Retainer ${r.number} has not been paid yet. Record the receipt first — an unpaid advance ` +
        'is money the customer owes us, not money we are holding.',
    );
  }
  const available = paid - toPaiseFromSql(r.applied_amount);
  const owing = toPaiseFromSql(inv.total) - toPaiseFromSql(inv.amount_paid);
  const amount = amountPaise ?? Math.min(available, owing);

  if (amount <= 0) throw badRequest('There is nothing left on this retainer to apply.');
  if (amount > available) throw badRequest(`Only ${(available / 100).toFixed(2)} is left on ${r.number}.`);
  if (amount > owing) throw badRequest(`Only ${(owing / 100).toFixed(2)} is still owed on ${inv.number}.`);

  const acc = await accountIds(trx, orgId);
  const entry = await postEntry(trx, {
    orgId,
    branchId: r.branch_id,
    date: new Date().toISOString().slice(0, 10),
    memo: `Retainer ${r.number} applied to invoice ${inv.number}`,
    sourceType: 'retainer_application',
    sourceId: retainerId,
    userId,
    module: 'sales',
    lines: [
      { accountId: requireAccount(acc, CODE.UNEARNED), debit: amount },
      { accountId: requireAccount(acc, CODE.AR), credit: amount, contactId: r.customer_id },
    ],
  });

  const newApplied = toPaiseFromSql(r.applied_amount) + amount;
  await trx
    .updateTable('retainer_invoices')
    .set({
      applied_amount: toSqlFromPaise(newApplied),
      status: newApplied >= toPaiseFromSql(r.amount) ? 'applied' : 'partially_applied',
    })
    .where('id', '=', retainerId)
    .execute();

  await trx
    .updateTable('invoices')
    .set((eb) => ({ amount_paid: eb('amount_paid', '+', toSqlFromPaise(amount)) }))
    .where('id', '=', invoiceId)
    .execute();
  await settleIfPaid(trx, orgId, invoiceId);

  return { journalEntryId: entry.id, appliedPaise: amount };
}

// ── Conversion ───────────────────────────────────────────────────────────────

/**
 * An accepted quote becomes a sales order: Quotation → Sales Order, the first
 * step of the order flow. Lines are copied and re-costed at the order's date;
 * the order then delivers and invoices like any other.
 */
export async function salesOrderFromEstimate(
  trx: Trx, orgId: number, userId: number | null, estimateId: number,
  input: { date: string; expectedShipDate?: string | null },
): Promise<CreatedDocument> {
  const est = await trx.selectFrom('estimates')
    .select(['id', 'number', 'branch_id', 'customer_id', 'place_of_supply', 'status'])
    .where('id', '=', estimateId).where('org_id', '=', orgId).executeTakeFirst();
  if (!est) throw notFound('That estimate does not exist.');
  if (est.status === 'converted') throw conflict(`Estimate ${est.number} has already been converted.`);
  if (est.status === 'declined') throw conflict(`Estimate ${est.number} was declined by the customer.`);
  const lines = await trx.selectFrom('estimate_lines')
    .select(['item_id', 'description', 'hsn_sac', 'qty', 'uqc', 'rate', 'discount_pct', 'gst_rate_pct'])
    .where('estimate_id', '=', estimateId).orderBy('line_no').execute();
  return createSalesOrder(trx, orgId, userId, {
    branchId: est.branch_id, customerId: est.customer_id, date: input.date,
    expectedShipDate: input.expectedShipDate ?? null, placeOfSupply: est.place_of_supply,
    sourceEstimateId: est.id,
    lines: lines.map((l) => ({
      itemId: l.item_id, description: l.description, hsnSac: l.hsn_sac, qty: Number(l.qty), uqc: l.uqc,
      ratePaise: toPaiseFromSql(l.rate), discountPct: Number(l.discount_pct), gstRatePct: Number(l.gst_rate_pct),
    })),
  });
}

/**
 * Turn an estimate or a sales order into an invoice.
 *
 * This is where a promise becomes a receivable — the first point in the chain
 * that touches the ledger at all. The lines are copied and re-costed rather
 * than trusted, because the tax on the quote was worked out under whatever
 * rates applied then, and the invoice must carry today's.
 */
export async function convertToInvoice(
  trx: Trx,
  orgId: number,
  userId: number | null,
  source: { type: 'estimate' | 'sales_order'; id: number },
  input: { date: string; dueDate: string; status?: 'draft' | 'approved' },
): Promise<CreatedDocument> {
  if (source.type === 'estimate') {
    const est = await trx
      .selectFrom('estimates')
      .select(['id', 'number', 'branch_id', 'customer_id', 'place_of_supply', 'status', 'notes'])
      .where('id', '=', source.id)
      .where('org_id', '=', orgId)
      .executeTakeFirst();
    if (!est) throw notFound('That estimate does not exist.');
    if (est.status === 'converted') throw conflict(`Estimate ${est.number} has already been converted.`);
    if (est.status === 'declined') throw conflict(`Estimate ${est.number} was declined by the customer.`);

    const lines = await trx
      .selectFrom('estimate_lines')
      .select(['item_id', 'description', 'hsn_sac', 'qty', 'uqc', 'rate', 'discount_pct', 'gst_rate_pct'])
      .where('estimate_id', '=', source.id)
      .orderBy('line_no')
      .execute();

    const created = await createInvoice(trx, orgId, userId, {
      branchId: est.branch_id,
      customerId: est.customer_id,
      date: input.date,
      dueDate: input.dueDate,
      placeOfSupply: est.place_of_supply,
      status: input.status ?? 'approved',
      notes: est.notes,
      sourceDocType: 'estimate',
      sourceDocId: est.id,
      lines: lines.map((l) => ({
        itemId: l.item_id,
        description: l.description,
        hsnSac: l.hsn_sac,
        qty: Number(l.qty),
        uqc: l.uqc,
        ratePaise: toPaiseFromSql(l.rate),
        discountPct: Number(l.discount_pct),
        gstRatePct: Number(l.gst_rate_pct),
      })),
    });

    await trx
      .updateTable('estimates')
      .set({ status: 'converted', converted_to_type: 'invoice', converted_to_id: created.id })
      .where('id', '=', source.id)
      .execute();

    return created;
  }

  // A sales order is invoiced line by line, so part of it can go now and the
  // rest later; the order flow keeps count.
  const { invoiceFromSalesOrder } = await import('./order-flow');
  return invoiceFromSalesOrder(trx, orgId, userId, source.id, input);
}

/** Void a credit note: reverse its entry and put the receivable back. */
export async function voidCreditNote(
  trx: Trx,
  orgId: number,
  userId: number | null,
  creditNoteId: number,
  reason?: string,
): Promise<void> {
  const cn = await trx
    .selectFrom('credit_notes')
    .select(['id', 'number', 'status', 'journal_entry_id', 'against_invoice_id', 'applied_amount', 'total'])
    .where('id', '=', creditNoteId)
    .where('org_id', '=', orgId)
    .executeTakeFirst();
  if (!cn) throw notFound('That credit note does not exist.');
  if (cn.status === 'void') throw new ApiError(409, 'That credit note is already void.', 'conflict');
  if (cn.status === 'refunded') {
    throw conflict(
      `${cn.number} has been refunded in cash. Voiding it would leave the payment pointing at nothing — ` +
        'record a receipt from the customer instead.',
    );
  }

  const why = voidReason(reason);
  if (cn.journal_entry_id) {
    await reverseEntry(trx, orgId, cn.journal_entry_id, {
      memo: `Void of credit note ${cn.number} — ${why}`,
      userId,
      module: 'sales',
    });
  }

  // Give the invoice its balance back if the credit had been set against it.
  const applied = toPaiseFromSql(cn.applied_amount);
  if (cn.against_invoice_id && applied > 0) {
    await trx
      .updateTable('invoices')
      .set((eb) => ({ amount_paid: eb('amount_paid', '-', toSqlFromPaise(applied)) }))
      .where('id', '=', cn.against_invoice_id)
      .execute();
    await settleIfPaid(trx, orgId, cn.against_invoice_id);
  }

  await trx
    .updateTable('credit_notes')
    .set({ status: 'void', applied_amount: toSqlFromPaise(0), ...voidStamp(why, userId) })
    .where('id', '=', creditNoteId)
    .execute();
}
