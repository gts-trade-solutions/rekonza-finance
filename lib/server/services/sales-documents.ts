import { editAfterSendingAllowed } from './doc-preferences';
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

import type { Insertable, Updateable } from 'kysely';
import type { DB } from '../db-types';
import type { Trx } from '../db';
import type { Paise, SupplyType } from '../../types';
import { exportTaxFor, exportTaxOf, isExportSupply, resolveSupplyType, totalTaxPaise } from '../../tax/gst';
import { tradeProfile } from './trade-profile';
import { indiaToday } from './held-journals';
import { roundToRupee } from '../../money';
import { toPaiseFromSql, toSqlFromPaise } from '../money-sql';
import { allocateNumber, allocateOrgNumber, assertGstDocNumber, postEntry, reverseEntry, type DraftLine } from '../ledger/posting';
import { seriesFor } from './voucher-types';
import { registrationOn } from './statutory';
import { returnCostLines } from './stock-ledger';
import { CODE, accountIds, requireAccount } from '../ledger/chart-of-accounts';
import { costLines, type DocumentLineInput } from './lines';
import { fyLabelFor, createInvoice } from './sales';
import { ApiError, badRequest, conflict, notFound } from '../http';
import { voidReason, voidStamp } from './void-reason';
import { reverseChargeProblem, withoutTax } from '../../tax/reverse-charge';
import { recordSerials } from './serials';
import { checkGodown } from './godowns';
import { itemSaleAccounts } from './item-accounts';
import { plain, recordDeletion, reverseForChange, unlinkDocument } from './doc-delete';

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
  /** The document's date: priced as the business was registered then, as an invoice is. */
  date?: string,
  export_?: {
    /** The invoice a credit note corrects: an export's note takes the IGST the invoice took. */
    againstInvoiceId?: number | null;
    /** The estimate an order comes from: its IGST, kept where a LUT still allows it. */
    fromSource?: boolean;
  },
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
  // A composition dealer, or a business not registered at all, charges no GST (services/sales.ts).
  const unregistered = date ? (await registrationOn(trx, orgId, date)) !== 'regular' : false;
  // An export pays IGST unless a LUT covers its date and exports go under it
  // (Settings → Organisation), as the invoice raised from it will.
  let exportWithTax: boolean | undefined;
  if (!unregistered && isExportSupply(customer.gst_treatment, placeOfSupply)) {
    const against = export_?.againstInvoiceId
      ? await trx.selectFrom('invoices').select('supply_type').where('id', '=', export_.againstInvoiceId).where('org_id', '=', orgId).executeTakeFirst()
      : null;
    exportWithTax = against && (against.supply_type === 'export_lut' || against.supply_type === 'export_with_tax')
      ? against.supply_type === 'export_with_tax'
      : exportTaxFor(await tradeProfile(trx, orgId), date ?? indiaToday(), { source: export_?.fromSource }).withTax;
  }
  return {
    branchStateCode: branch.state_code,
    branchGstin: branch.gstin,
    customerName: customer.display_name,
    placeOfSupply,
    supplyType: unregistered ? 'nil_or_exempt' : resolveSupplyType({
      branchStateCode: branch.state_code,
      placeOfSupply,
      customerTreatment: customer.gst_treatment as never,
      exportWithTax,
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
  /** Zoho's Reference#: the customer's PO number or anything else to quote back. */
  referenceNumber?: string | null;
  salespersonId?: number | null;
  /** Zoho's Terms & Conditions, printed under the notes. */
  terms?: string | null;
  /** Zoho's Shipping Charges and Adjustment at the foot of the document (migration 124). */
  shippingChargePaise?: Paise;
  adjustmentPaise?: Paise;
  adjustmentLabel?: string | null;
}

/**
 * Shipping and the adjustment as stored, and what they add to the total. Both
 * sit outside the GST, as on an invoice: shipping is income of its own and the
 * adjustment rounds a figure the customer agreed.
 */
function extrasOf(input: { shippingChargePaise?: Paise; adjustmentPaise?: Paise; adjustmentLabel?: string | null }) {
  const shipping = input.shippingChargePaise ?? 0;
  const adjustment = input.adjustmentPaise ?? 0;
  if (shipping < 0) throw badRequest('Shipping charges cannot be negative.');
  return {
    shipping: shipping as Paise,
    adjustment: adjustment as Paise,
    values: {
      shipping_charge: toSqlFromPaise(shipping as Paise),
      adjustment: toSqlFromPaise(adjustment as Paise),
      adjustment_label: adjustment ? (input.adjustmentLabel?.trim() || 'Adjustment').slice(0, 60) : null,
    },
  };
}

/** Reverse charge on a quote or order (Zoho's checkbox): the buyer must be registered, and the GST comes off. */
async function reverseCharged<D extends Awaited<ReturnType<typeof costLines>>>(
  trx: Trx, orgId: number, customerId: number, supplyType: SupplyType, costed: D, on: boolean | undefined,
): Promise<D> {
  if (!on) return costed;
  const c = await trx.selectFrom('contacts').select('gstin').where('id', '=', customerId).where('org_id', '=', orgId).executeTakeFirst();
  const problem = reverseChargeProblem({ buyerGstin: c?.gstin, supplyType });
  if (problem) throw badRequest(problem);
  return withoutTax(costed);
}

/** A salesperson and a project named on a document must be this business's own. */
async function checkPeople(trx: Trx, orgId: number, input: { salespersonId?: number | null; projectId?: number | null }) {
  if (input.salespersonId) {
    const u = await trx.selectFrom('users').select('id').where('id', '=', input.salespersonId).where('org_id', '=', orgId).executeTakeFirst();
    if (!u) throw badRequest('That salesperson is not one of this business’s users.');
  }
  if (input.projectId) {
    const p = await trx.selectFrom('projects').select('id').where('id', '=', input.projectId).where('org_id', '=', orgId).executeTakeFirst();
    if (!p) throw badRequest('That project does not exist.');
  }
}

/** The fields every one of these documents shares with Zoho's form, as stored. */
function zohoFields(input: { referenceNumber?: string | null; terms?: string | null }) {
  return {
    reference_number: input.referenceNumber?.trim() || null,
    terms: input.terms?.trim() || null,
  };
}

export interface CreatedDocument {
  id: number;
  number: string;
  totalPaise: Paise;
  journalEntryId: number | null;
  /** Saved as a draft for approval because a rule caught it. */
  heldForApproval?: boolean;
}

type DocTable = 'estimates' | 'sales_orders' | 'delivery_challans';
type LineTable = 'estimate_lines' | 'sales_order_lines' | 'challan_lines';

/**
 * Insert a document's header, or, for an edit, write the new figures over the
 * one it replaces (keeping its number, creator, status and what has happened
 * to it) and clear its lines for the new ones.
 */
async function writeDocument(
  trx: Trx, orgId: number, table: DocTable, lines: LineTable, parent: 'estimate_id' | 'sales_order_id' | 'challan_id',
  values: Record<string, unknown>, replace: { id: number; number: string } | undefined, keep: string[] = [],
): Promise<number> {
  if (!replace) {
    const inserted = await trx.insertInto(table).values(values as never).executeTakeFirstOrThrow();
    return Number(inserted.insertId);
  }
  const changed = Object.fromEntries(Object.entries(values)
    .filter(([k]) => !['org_id', 'number', 'created_by_user_id', 'status', ...keep].includes(k)));
  await trx.updateTable(table).set(changed as never).where('id', '=', replace.id).where('org_id', '=', orgId).execute();
  await trx.deleteFrom(lines).where(parent as never, '=', replace.id as never).execute();
  return replace.id;
}

// ── Estimates ────────────────────────────────────────────────────────────────

export interface CreateEstimateInput extends BaseDocInput {
  expiryDate: string;
  status?: 'draft' | 'sent';
  /** Zoho's Project Name: the project the quote is for. */
  projectId?: number | null;
  /** "This transaction is applicable for reverse charge": the buyer pays the GST. */
  reverseCharge?: boolean;
  /** "Create a retainer invoice for this quote automatically", for this per cent of the quote. */
  retainerPct?: number | null;
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
  /** Rewrite this document in place (updateSalesDocument): same row, same number. */
  opts: { replace?: { id: number; number: string } } = {},
): Promise<CreatedDocument> {
  await checkPeople(trx, orgId, input);
  const ctx = await partyContext(trx, orgId, input.branchId, input.customerId, input.placeOfSupply, input.date);
  const costed = await reverseCharged(trx, orgId, input.customerId, ctx.supplyType,
    await costLines(trx, orgId, ctx.supplyType, input.lines, 'sale_price', input.date), input.reverseCharge);
  const extras = extrasOf(input);
  const { rounded } = roundToRupee(costed.tax.taxablePaise + totalTaxPaise(costed.tax) + extras.shipping + extras.adjustment);
  if (input.retainerPct != null && !(input.retainerPct > 0 && input.retainerPct <= 100)) {
    throw badRequest('The retainer is a per cent of the quote, above 0 and up to 100.');
  }

  const series = await seriesFor(trx, orgId, 'EST', input.voucherTypeId);
  const number = opts.replace?.number ??
    (input.number?.trim() ||
    (await allocateNumber(trx, orgId, input.branchId, series.docType, fyLabelFor(input.date), { prefix: series.prefix })));

  const values: Insertable<DB['estimates']> = {
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
      ...zohoFields(input),
      ...extras.values,
      reverse_charge: input.reverseCharge ? 1 : 0,
      retainer_pct: input.retainerPct != null ? String(input.retainerPct) : null,
      salesperson_id: input.salespersonId ?? null,
      project_id: input.projectId ?? null,
      created_by_user_id: userId,
    };
  const id = await writeDocument(trx, orgId, 'estimates', 'estimate_lines', 'estimate_id', values, opts.replace);

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
  /** An export: the IGST of the estimate it comes from (true paid, false under the LUT). */
  exportFromSource?: boolean;
  /** Zoho's Payment Terms (net_30 …) and Delivery Method (by road, courier …). */
  paymentTerms?: string | null;
  deliveryMethod?: string | null;
  /** Zoho's Save as Draft; otherwise the order is confirmed (open). An edit keeps its status. */
  status?: 'draft' | 'open';
  /** "This transaction is applicable for reverse charge": the buyer pays the GST. */
  reverseCharge?: boolean;
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
  /** Rewrite this document in place (updateSalesDocument): same row, same number. */
  opts: { replace?: { id: number; number: string } } = {},
): Promise<CreatedDocument> {
  await checkPeople(trx, orgId, input);
  const ctx = await partyContext(trx, orgId, input.branchId, input.customerId, input.placeOfSupply, input.date, { fromSource: input.exportFromSource });
  const costed = await reverseCharged(trx, orgId, input.customerId, ctx.supplyType,
    await costLines(trx, orgId, ctx.supplyType, input.lines, 'sale_price', input.date), input.reverseCharge);
  const extras = extrasOf(input);
  const { rounded } = roundToRupee(costed.tax.taxablePaise + totalTaxPaise(costed.tax) + extras.shipping + extras.adjustment);

  const series = await seriesFor(trx, orgId, 'SO', input.voucherTypeId);
  const number = opts.replace?.number ??
    (input.number?.trim() ||
    (await allocateNumber(trx, orgId, input.branchId, series.docType, fyLabelFor(input.date), { prefix: series.prefix })));

  const values: Insertable<DB['sales_orders']> = {
      org_id: orgId,
      branch_id: input.branchId,
      number,
      customer_id: input.customerId,
      order_date: input.date,
      expected_ship_date: input.expectedShipDate ?? null,
      place_of_supply: ctx.placeOfSupply,
      supply_type: ctx.supplyType,
      status: input.status ?? 'open',
      subtotal: toSqlFromPaise(costed.tax.taxablePaise),
      cgst: toSqlFromPaise(costed.tax.cgstPaise),
      sgst: toSqlFromPaise(costed.tax.sgstPaise),
      igst: toSqlFromPaise(costed.tax.igstPaise),
      cess: toSqlFromPaise(costed.tax.cessPaise),
      total: toSqlFromPaise(rounded),
      invoiced_amount: toSqlFromPaise(0),
      source_estimate_id: input.sourceEstimateId ?? null,
      notes: input.notes ?? null,
      ...zohoFields(input),
      ...extras.values,
      reverse_charge: input.reverseCharge ? 1 : 0,
      salesperson_id: input.salespersonId ?? null,
      payment_terms: input.paymentTerms ?? null,
      delivery_method: input.deliveryMethod?.trim() || null,
      created_by_user_id: userId,
    };
  const id = await writeDocument(trx, orgId, 'sales_orders', 'sales_order_lines', 'sales_order_id', values, opts.replace, ['invoiced_amount', 'source_estimate_id']);

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
  referenceNumber?: string | null;
  terms?: string | null;
  /** Zoho's Save as Draft; otherwise open. An edit keeps its status. */
  status?: 'draft' | 'open';
  lines: { itemId?: number | null; description?: string | null; hsnSac?: string | null; qty: number; uqc?: string | null; ratePaise?: Paise }[];
  shippingChargePaise?: Paise;
  adjustmentPaise?: Paise;
  adjustmentLabel?: string | null;
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
  /** Rewrite this document in place (updateSalesDocument): same row, same number. */
  opts: { replace?: { id: number; number: string } } = {},
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
  const extras = extrasOf(input);
  // The goods' value, then Zoho's shipping and adjustment beneath it.
  const total = priced.reduce((t, l) => t + l.lineTotal, 0) + extras.shipping + extras.adjustment;

  // A hand-typed number has to meet the same GST rules as an allocated one.
  const typed = opts.replace ? null : input.number?.trim();
  if (typed) assertGstDocNumber(typed, 'A delivery challan number');
  const series = await seriesFor(trx, orgId, 'DC', input.voucherTypeId);
  const number = opts.replace?.number ??
    (typed ||
    (await allocateNumber(trx, orgId, input.branchId, series.docType, fyLabelFor(input.date), { prefix: series.prefix })));

  const values: Insertable<DB['delivery_challans']> = {
      org_id: orgId,
      branch_id: input.branchId,
      number,
      customer_id: input.customerId,
      challan_date: input.date,
      challan_type: input.challanType ?? 'other',
      place_of_supply: ctx.placeOfSupply,
      status: input.status ?? 'open',
      total: toSqlFromPaise(total as Paise),
      notes: input.notes ?? null,
      ...zohoFields(input),
      ...extras.values,
      created_by_user_id: userId,
    };
  const id = await writeDocument(trx, orgId, 'delivery_challans', 'challan_lines', 'challan_id', values, opts.replace);

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

  return { id, number, totalPaise: total as Paise, journalEntryId: null };
}

// ── Credit notes ─────────────────────────────────────────────────────────────

export interface CreateCreditNoteInput extends BaseDocInput {
  reason: string;
  againstInvoiceId?: number | null;
  /** Apply it against the invoice immediately, up to that invoice's balance. */
  applyImmediately?: boolean;
  /**
   * Zoho's Save as Draft: the note is kept, numbered, and posts nothing — no
   * entry, no GSTR-1, no stock back, nothing applied or refunded — until it is
   * converted to open. Otherwise (and by default) it is open and posted.
   */
  status?: 'draft' | 'open';
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
  /** Rewrite this credit note in place (updateSalesDocument): same row, same number. */
  opts: { replace?: { id: number; number: string } } = {},
): Promise<CreatedDocument> {
  if (!input.reason?.trim()) {
    // GST requires a reason on every credit note; it is reported in GSTR-1.
    throw badRequest('A credit note needs a reason — it is reported in GSTR-1.');
  }

  await checkPeople(trx, orgId, input);
  const draft = input.status === 'draft';
  const ctx = await partyContext(trx, orgId, input.branchId, input.customerId, input.placeOfSupply, input.date, { againstInvoiceId: input.againstInvoiceId });
  const costed = await costLines(trx, orgId, ctx.supplyType, input.lines, 'sale_price', input.date);
  const extras = extrasOf(input);
  const { rounded } = roundToRupee(costed.tax.taxablePaise + totalTaxPaise(costed.tax) + extras.shipping + extras.adjustment);

  // Zoho's ACCOUNT column: a line may come back out of another income head (as an invoice line may go to one).
  const namedAccounts = [...new Set(input.lines.map((l) => l.accountId).filter((x): x is number => !!x))];
  if (namedAccounts.length) {
    const found = await trx.selectFrom('accounts').select(['id', 'type']).where('org_id', '=', orgId).where('id', 'in', namedAccounts).execute();
    for (const a of namedAccounts) {
      if (found.find((f) => f.id === a)?.type !== 'income') throw badRequest('A credit note line can come back only out of an income account.');
    }
  }

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

  const typed = opts.replace ? null : input.number?.trim();
  if (typed) assertGstDocNumber(typed, 'A credit note number');
  const series = await seriesFor(trx, orgId, 'CN', input.voucherTypeId);
  const number = opts.replace?.number ??
    (typed ||
    (await allocateNumber(trx, orgId, input.branchId, series.docType, fyLabelFor(input.date), { prefix: series.prefix })));

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

  const cnValues: Insertable<DB['credit_notes']> = {
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
      status: draft ? 'draft' : 'open',
      subtotal: toSqlFromPaise(costed.tax.taxablePaise),
      cgst: toSqlFromPaise(costed.tax.cgstPaise),
      sgst: toSqlFromPaise(costed.tax.sgstPaise),
      igst: toSqlFromPaise(costed.tax.igstPaise),
      cess: toSqlFromPaise(costed.tax.cessPaise),
      total: toSqlFromPaise(rounded),
      applied_amount: toSqlFromPaise(0),
      notes: input.notes ?? null,
      ...zohoFields(input),
      ...extras.values,
      salesperson_id: input.salespersonId ?? null,
      created_by_user_id: userId,
    };
  let id: number;
  if (opts.replace) {
    // Its applications were taken back before the edit; it is open again until applied anew.
    const { org_id: _o, number: _n, created_by_user_id: _c, ...changed } = cnValues;
    await trx.updateTable('credit_notes').set({ ...changed, journal_entry_id: null } as Updateable<DB['credit_notes']>)
      .where('id', '=', opts.replace.id).where('org_id', '=', orgId).execute();
    await trx.deleteFrom('credit_note_lines').where('credit_note_id', '=', opts.replace.id).execute();
    id = opts.replace.id;
  } else {
    id = Number((await trx.insertInto('credit_notes').values(cnValues).executeTakeFirstOrThrow()).insertId);
  }

  // Each line comes back out of the income head its item's sale went to (the
  // item's sales account, as on the invoice), the rest out of Sales.
  const itemAccounts = await itemSaleAccounts(trx, orgId, costed.lines.map((c) => c.itemId));
  const accountOf = (c: { itemId: number | null }, i: number) => input.lines[i]?.accountId ?? (c.itemId ? itemAccounts.get(c.itemId) ?? null : null);
  await trx
    .insertInto('credit_note_lines')
    .values(
      costed.lines.map((c, i) => ({
        org_id: orgId,
        credit_note_id: id,
        line_no: i + 1,
        item_id: c.itemId,
        account_id: accountOf(c, i),
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
  // A draft stops here: nothing is posted, returned to stock or applied until it is open.
  if (draft) return { id, number, totalPaise: rounded, journalEntryId: null };

  // Numbered pieces coming back: each has to have gone out.
  const cnLineIds = (await trx.selectFrom('credit_note_lines').select('id').where('credit_note_id', '=', id).orderBy('line_no').execute()).map((r) => r.id);
  await recordSerials(trx, orgId, { type: 'credit_note', id }, 1,
    input.lines.map((l, i) => ({ lineId: cnLineIds[i] ?? null, itemId: l.itemId, qty: l.qty, serials: l.serials })), { check: true });

  const acc = await accountIds(trx, orgId);
  const own = new Map<number, number>();
  for (const [i, c] of costed.lines.entries()) {
    const a = accountOf(c, i);
    if (a) own.set(a, (own.get(a) ?? 0) + c.taxable);
  }
  const elsewhere = [...own.values()].reduce((t, v) => t + v, 0);
  const lines: DraftLine[] = [
    { accountId: requireAccount(acc, CODE.SALES), debit: costed.tax.taxablePaise - elsewhere },
    ...[...own].map(([accountId, debit]) => ({ accountId, debit })),
    { accountId: requireAccount(acc, CODE.GST_CGST), debit: costed.tax.cgstPaise },
    { accountId: requireAccount(acc, CODE.GST_SGST), debit: costed.tax.sgstPaise },
    { accountId: requireAccount(acc, CODE.GST_IGST), debit: costed.tax.igstPaise },
    { accountId: requireAccount(acc, CODE.GST_CESS), debit: costed.tax.cessPaise },
    { accountId: requireAccount(acc, CODE.AR), credit: rounded, contactId: input.customerId },
  ];
  // Shipping charged on the invoice comes back out of Shipping Income; the
  // adjustment out of where an invoice's went (other income, or discount allowed).
  if (extras.shipping > 0) lines.push({ accountId: requireAccount(acc, CODE.SHIPPING_INCOME), debit: extras.shipping });
  if (extras.adjustment > 0) lines.push({ accountId: requireAccount(acc, CODE.OTHER_INCOME), debit: extras.adjustment });
  else if (extras.adjustment < 0) lines.push({ accountId: requireAccount(acc, CODE.DISCOUNT_ALLOWED), credit: -extras.adjustment });

  // Rounding the credit to the rupee leaves the same paisa remainder an invoice
  // does, and it goes to the same place.
  const rawTotal = costed.tax.taxablePaise + totalTaxPaise(costed.tax) + extras.shipping + extras.adjustment;
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
    await trx.insertInto('credit_note_applications').values({
      org_id: orgId, credit_note_id: id, invoice_id: invoice.id, amount: toSqlFromPaise(rounded), applied_on: input.date, created_by_user_id: userId,
    }).execute();
    await settleIfPaid(trx, orgId, invoice.id);
  }

  return { id, number, totalPaise: rounded, journalEntryId: entry.id };
}

/**
 * Zoho's "Apply to Invoices": set what is left on a credit note against one or
 * more of the customer's open invoices, any time after it was raised. An
 * allocation, not a posting (the credit note's entry already reduced
 * receivables): each invoice's balance falls, and the application is kept.
 */
export async function applyCreditNote(
  trx: Trx, orgId: number, userId: number | null, creditNoteId: number,
  input: { date: string; allocations: { invoiceId: number; amountPaise: number }[] },
): Promise<{ appliedPaise: Paise; status: string }> {
  const cn = await trx.selectFrom('credit_notes').select(['id', 'number', 'customer_id', 'status', 'total', 'applied_amount', 'note_date'])
    .where('id', '=', creditNoteId).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!cn) throw notFound('That credit note does not exist.');
  if (cn.status === 'void') throw conflict('That credit note has been voided.');
  if (cn.status === 'draft') throw conflict(`${cn.number} is a draft. Convert it to open before applying it.`);
  const left = toPaiseFromSql(cn.total) - toPaiseFromSql(cn.applied_amount);
  const wanted = input.allocations.filter((a) => a.amountPaise > 0);
  if (!wanted.length) throw badRequest('Give an amount against at least one invoice.');
  const total = wanted.reduce((t, a) => t + a.amountPaise, 0);
  if (total > left) throw badRequest(`Only ₹${(left / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })} is left on ${cn.number} to apply.`);
  if (input.date < String(cn.note_date).slice(0, 10)) throw badRequest('A credit cannot be applied before the credit note was raised.');
  for (const a of wanted) {
    const inv = await trx.selectFrom('invoices').select(['id', 'number', 'customer_id', 'status', 'total', 'amount_paid'])
      .where('id', '=', a.invoiceId).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
    if (!inv || inv.customer_id !== cn.customer_id) throw badRequest('Apply a credit note only to its own customer\'s invoices.');
    if (inv.status === 'void' || inv.status === 'draft') throw badRequest(`Invoice ${inv.number} is ${inv.status}, so no credit can be set against it.`);
    const open = toPaiseFromSql(inv.total) - toPaiseFromSql(inv.amount_paid);
    if (a.amountPaise > open) throw badRequest(`Invoice ${inv.number} has only ₹${(open / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })} left to pay.`);
    await trx.updateTable('invoices').set((eb) => ({ amount_paid: eb('amount_paid', '+', toSqlFromPaise(a.amountPaise as Paise)) })).where('id', '=', inv.id).execute();
    await trx.insertInto('credit_note_applications').values({
      org_id: orgId, credit_note_id: creditNoteId, invoice_id: inv.id, amount: toSqlFromPaise(a.amountPaise as Paise), applied_on: input.date, created_by_user_id: userId,
    }).execute();
    await settleIfPaid(trx, orgId, inv.id);
  }
  const status = total === left ? 'applied' : 'open';
  await trx.updateTable('credit_notes')
    .set({ applied_amount: toSqlFromPaise((toPaiseFromSql(cn.applied_amount) + total) as Paise), status })
    .where('id', '=', creditNoteId).execute();
  return { appliedPaise: total as Paise, status };
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
  // Settled, partly settled, or (a credit taken back) owed in full again.
  const status = balance <= 0 ? 'paid' : toPaiseFromSql(inv.amount_paid) > 0 ? 'partially_paid' : 'sent';
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
  if (cn.status === 'draft') throw conflict(`${cn.number} is a draft. Convert it to open before refunding it.`);

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

  // A part refund leaves the rest open, to apply or refund later.
  const after = toPaiseFromSql(cn.applied_amount) + amount;
  await trx
    .updateTable('credit_notes')
    .set({
      status: after >= toPaiseFromSql(cn.total) ? 'refunded' : 'open',
      applied_amount: toSqlFromPaise(after),
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
    .select(['id', 'number', 'branch_id', 'customer_id', 'place_of_supply', 'supply_type', 'status'])
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
    sourceEstimateId: est.id, exportFromSource: exportTaxOf(est.supply_type),
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
      .select(['id', 'number', 'branch_id', 'customer_id', 'place_of_supply', 'supply_type', 'status', 'notes', 'terms', 'shipping_charge', 'adjustment', 'adjustment_label', 'reverse_charge', 'salesperson_id', 'project_id', 'reference_number'])
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
      exportFromSource: exportTaxOf(est.supply_type),
      status: input.status ?? 'approved',
      notes: est.notes,
      terms: est.terms,
      orderNumber: est.reference_number,
      salespersonId: est.salesperson_id,
      // Zoho's shipping, adjustment and reverse charge go on to the invoice the quote becomes.
      shippingChargePaise: toPaiseFromSql(est.shipping_charge),
      adjustmentPaise: toPaiseFromSql(est.adjustment),
      adjustmentLabel: est.adjustment_label,
      reverseCharge: Number(est.reverse_charge) === 1,
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
  const refunded = await trx.selectFrom('journal_entries').select('id')
    .where('org_id', '=', orgId).where('source_type', '=', 'credit_note_refund').where('source_id', '=', creditNoteId)
    .where('reversal_of_entry_id', 'is', null).executeTakeFirst();
  if (cn.status === 'refunded' || refunded) {
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

  // Give every invoice its balance back: each application kept, or, for a
  // credit note applied before applications were kept, its own invoice.
  const apps = await trx.selectFrom('credit_note_applications').select(['invoice_id', 'amount'])
    .where('org_id', '=', orgId).where('credit_note_id', '=', creditNoteId).execute();
  const applied = toPaiseFromSql(cn.applied_amount);
  const back = apps.length
    ? apps.map((a) => ({ invoiceId: a.invoice_id, paise: toPaiseFromSql(a.amount) }))
    : cn.against_invoice_id && applied > 0 ? [{ invoiceId: cn.against_invoice_id, paise: applied }] : [];
  for (const b of back) {
    await trx
      .updateTable('invoices')
      .set((eb) => ({ amount_paid: eb('amount_paid', '-', toSqlFromPaise(b.paise)) }))
      .where('id', '=', b.invoiceId)
      .execute();
    await settleIfPaid(trx, orgId, b.invoiceId);
  }

  await trx
    .updateTable('credit_notes')
    .set({ status: 'void', applied_amount: toSqlFromPaise(0), ...voidStamp(why, userId) })
    .where('id', '=', creditNoteId)
    .execute();
}


// ── Edit and delete, as Zoho Books has them ──────────────────────────────────

export type EditableSalesDoc = 'estimate' | 'sales-order' | 'challan' | 'credit-note';

const DOC = {
  estimate: { table: 'estimates', lines: 'estimate_lines', parent: 'estimate_id', date: 'estimate_date', type: 'estimate', noun: 'Quote' },
  'sales-order': { table: 'sales_orders', lines: 'sales_order_lines', parent: 'sales_order_id', date: 'order_date', type: 'sales_order', noun: 'Sales order' },
  challan: { table: 'delivery_challans', lines: 'challan_lines', parent: 'challan_id', date: 'challan_date', type: 'challan', noun: 'Delivery challan' },
  'credit-note': { table: 'credit_notes', lines: 'credit_note_lines', parent: 'credit_note_id', date: 'note_date', type: 'credit_note', noun: 'Credit note' },
} as const;

async function docSnapshot(trx: Trx, orgId: number, kind: EditableSalesDoc, id: number) {
  const d = DOC[kind];
  const head = await trx.selectFrom(d.table).selectAll().where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
  const lines = await trx.selectFrom(d.lines).selectAll().where(d.parent as never, '=', id as never).execute();
  return head ? { document: plain(head as Record<string, unknown>), lines: (lines as Record<string, unknown>[]).map(plain) } : null;
}

/** Why this document cannot be edited (or deleted) now: what has happened to it since. */
async function salesDocBlocker(trx: Trx, orgId: number, kind: EditableSalesDoc, id: number, what: 'edit' | 'delete'): Promise<string | null> {
  if (kind === 'estimate') {
    const e = await trx.selectFrom('estimates').select(['number', 'status']).where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
    if (!e) throw notFound('That quote does not exist.');
    if (what === 'edit' && e.status === 'converted') return `${e.number} has been converted. Change the order or invoice it became.`;
    // Quote Preferences: "Allow editing of sent and accepted quotes", switched off.
    if (what === 'edit' && (e.status === 'sent' || e.status === 'accepted') && !(await editAfterSendingAllowed(trx, orgId, 'estimate'))) {
      return `${e.number} has been ${e.status}, and Quote Preferences do not allow editing it now.`;
    }
    return null;
  }
  if (kind === 'sales-order') {
    const so = await trx.selectFrom('sales_orders').select(['number', 'status', 'invoiced_amount']).where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
    if (!so) throw notFound('That sales order does not exist.');
    const moved = await trx.selectFrom('sales_order_lines').select('id').where('sales_order_id', '=', id)
      .where((eb) => eb.or([eb('qty_invoiced', '>', '0'), eb('qty_delivered', '>', '0')])).executeTakeFirst();
    const challaned = await trx.selectFrom('challan_lines').innerJoin('sales_order_lines as sol', 'sol.id', 'challan_lines.so_line_id')
      .select('challan_lines.id').where('sol.sales_order_id', '=', id).executeTakeFirst();
    if (toPaiseFromSql(so.invoiced_amount) > 0 || moved || challaned) {
      return `${so.number} has been invoiced or delivered in part. Delete those invoices and challans first.`;
    }
    if (what === 'edit' && so.status === 'open' && !(await editAfterSendingAllowed(trx, orgId, 'sales_order'))) {
      return `${so.number} is confirmed, and Sales Order Preferences do not allow editing confirmed orders.`;
    }
    return null;
  }
  if (kind === 'challan') {
    const dc = await trx.selectFrom('delivery_challans').select(['number', 'status', 'invoice_id']).where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
    if (!dc) throw notFound('That delivery challan does not exist.');
    const billed = await trx.selectFrom('challan_lines').select('id').where('challan_id', '=', id).where('qty_invoiced', '>', '0').executeTakeFirst();
    if (dc.invoice_id || billed || dc.status === 'invoiced') return `${dc.number} has been invoiced. Delete the invoice first.`;
    if (await trx.selectFrom('eway_bills').select('id').where('challan_id', '=', id).executeTakeFirst()) return `${dc.number} has an e-way bill on record.`;
    if (await trx.selectFrom('job_work_receipts').select('id').where('challan_id', '=', id).executeTakeFirst()) return `Goods have come back against ${dc.number} from the job worker.`;
    if (what === 'edit' && await trx.selectFrom('challan_lines').select('id').where('challan_id', '=', id).where('so_line_id', 'is not', null).executeTakeFirst()) {
      return `${dc.number} was made from a sales order. Delete it and make it from the order again.`;
    }
    return null;
  }
  const cn = await trx.selectFrom('credit_notes').select(['number', 'status']).where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
  if (!cn) throw notFound('That credit note does not exist.');
  if (what === 'edit' && cn.status === 'void') return `${cn.number} is void.`;
  if (what === 'edit' && (cn.status === 'open' || cn.status === 'applied') && !(await editAfterSendingAllowed(trx, orgId, 'credit_note'))) {
    return `${cn.number} is open, and Credit Note Preferences do not allow editing open credit notes.`;
  }
  const refunded = await trx.selectFrom('journal_entries').select('id').where('org_id', '=', orgId)
    .where('source_type', '=', 'credit_note_refund').where('source_id', '=', id).where('reversal_of_entry_id', 'is', null).executeTakeFirst();
  if (cn.status === 'refunded' || refunded) return `${cn.number} has been refunded in cash. Delete the refund first.`;
  return null;
}

/** Take a credit note's credit back off every invoice it was set against. Returns whether its own invoice had it. */
async function takeBackCredit(trx: Trx, orgId: number, id: number): Promise<boolean> {
  const cn = await trx.selectFrom('credit_notes').select(['against_invoice_id', 'applied_amount']).where('id', '=', id).executeTakeFirstOrThrow();
  const apps = await trx.selectFrom('credit_note_applications').select(['invoice_id', 'amount']).where('org_id', '=', orgId).where('credit_note_id', '=', id).execute();
  const applied = toPaiseFromSql(cn.applied_amount);
  const back = apps.length
    ? apps.map((a) => ({ invoiceId: a.invoice_id, paise: toPaiseFromSql(a.amount) }))
    : cn.against_invoice_id && applied > 0 ? [{ invoiceId: cn.against_invoice_id, paise: applied }] : [];
  for (const b of back) {
    await trx.updateTable('invoices').set((eb) => ({ amount_paid: eb('amount_paid', '-', toSqlFromPaise(b.paise)) })).where('id', '=', b.invoiceId).execute();
    await settleIfPaid(trx, orgId, b.invoiceId);
  }
  await trx.deleteFrom('credit_note_applications').where('org_id', '=', orgId).where('credit_note_id', '=', id).execute();
  await trx.updateTable('credit_notes').set({ applied_amount: toSqlFromPaise(0), status: 'open' }).where('id', '=', id).execute();
  return back.some((b) => b.invoiceId === cn.against_invoice_id);
}

export type SalesDocInput =
  | { kind: 'estimate'; input: CreateEstimateInput }
  | { kind: 'sales-order'; input: CreateSalesOrderInput }
  | { kind: 'challan'; input: CreateChallanInput }
  | { kind: 'credit-note'; input: CreateCreditNoteInput };

/**
 * Edit a quote, sales order, delivery challan or credit note, as Zoho Books'
 * Edit: rewritten in place with the same number. A credit note's entry is
 * reversed and posted again, and its credit set again on its own invoice.
 */
export async function updateSalesDocument(trx: Trx, orgId: number, userId: number | null, id: number, doc: SalesDocInput) {
  const d = DOC[doc.kind];
  const row = await trx.selectFrom(d.table).select(['id', 'number']).where('id', '=', id).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!row) throw notFound(`That ${d.noun.toLowerCase()} does not exist.`);
  const blocked = await salesDocBlocker(trx, orgId, doc.kind, id, 'edit');
  if (blocked) throw new ApiError(409, blocked, 'locked_document');
  const before = await docSnapshot(trx, orgId, doc.kind, id);
  const replace = { id, number: row.number };
  let made: CreatedDocument;
  if (doc.kind === 'estimate') made = await createEstimate(trx, orgId, userId, doc.input, { replace });
  else if (doc.kind === 'sales-order') made = await createSalesOrder(trx, orgId, userId, { ...doc.input, sourceEstimateId: undefined }, { replace });
  else if (doc.kind === 'challan') made = await createChallan(trx, orgId, userId, doc.input, { replace });
  else {
    const cn = await trx.selectFrom('credit_notes').select(['journal_entry_id', 'status']).where('id', '=', id).executeTakeFirstOrThrow();
    if (cn.status === 'draft') {
      // A draft has nothing posted to undo: it is rewritten, and stays a draft unless asked to open.
      made = await createCreditNote(trx, orgId, userId, { ...doc.input, status: doc.input.status ?? 'draft' }, { replace });
    } else {
      await reverseForChange(trx, orgId, cn.journal_entry_id, { memo: `Credit note ${row.number} edited: the entry as it was, reversed`, userId, module: 'sales' });
      const hadOwn = await takeBackCredit(trx, orgId, id);
      await trx.deleteFrom('serial_moves').where('org_id', '=', orgId).where('doc_type', '=', 'credit_note').where('doc_id', '=', id).execute();
      made = await createCreditNote(trx, orgId, userId, { ...doc.input, status: 'open', applyImmediately: hadOwn }, { replace });
    }
  }
  return { ...made, before };
}

/**
 * Delete a quote, sales order, delivery challan or credit note, as Zoho Books'
 * Delete. A credit note's credit comes off its invoices and its entry is
 * reversed; its number is kept as cancelled for GSTR-1 (migration 118).
 */
export async function deleteSalesDocument(trx: Trx, orgId: number, userId: number | null, kind: EditableSalesDoc, id: number, reason?: string | null) {
  const d = DOC[kind];
  const row = await trx.selectFrom(d.table).selectAll().where('id', '=', id).where('org_id', '=', orgId).forUpdate().executeTakeFirst() as
    { id: number; number: string; branch_id: number; customer_id: number; total: string; status: string; journal_entry_id?: number | null } & Record<string, unknown> | undefined;
  if (!row) throw notFound(`That ${d.noun.toLowerCase()} does not exist.`);
  const blocked = await salesDocBlocker(trx, orgId, kind, id, 'delete');
  if (blocked) throw new ApiError(409, blocked, 'locked_document');
  const snapshot = await docSnapshot(trx, orgId, kind, id);
  let reversal: number | null = null;

  if (kind === 'estimate') {
    await trx.updateTable('sales_orders').set({ source_estimate_id: null }).where('org_id', '=', orgId).where('source_estimate_id', '=', id).execute();
    await trx.updateTable('invoices').set({ source_doc_type: null, source_doc_id: null })
      .where('org_id', '=', orgId).where('source_doc_type', '=', 'estimate').where('source_doc_id', '=', id).execute();
  } else if (kind === 'sales-order') {
    // A quote turned into this order is a quote again.
    await trx.updateTable('estimates').set({ status: 'accepted', converted_to_type: null, converted_to_id: null })
      .where('org_id', '=', orgId).where('converted_to_type', '=', 'sales_order').where('converted_to_id', '=', id).execute();
  } else if (kind === 'challan') {
    // What it delivered against an order is owed to the customer again.
    const fromOrder = await trx.selectFrom('challan_lines').select(['so_line_id', 'qty']).where('challan_id', '=', id).where('so_line_id', 'is not', null).execute();
    for (const l of fromOrder) {
      await trx.updateTable('sales_order_lines').set((eb) => ({ qty_delivered: eb('qty_delivered', '-', String(l.qty)) })).where('id', '=', Number(l.so_line_id)).execute();
    }
  } else {
    if (row.status !== 'void') {
      reversal = await reverseForChange(trx, orgId, row.journal_entry_id ?? null, { memo: `Credit note ${row.number} deleted`, userId, module: 'sales' });
      await takeBackCredit(trx, orgId, id);
    } else {
      await trx.deleteFrom('credit_note_applications').where('org_id', '=', orgId).where('credit_note_id', '=', id).execute();
    }
    await trx.deleteFrom('serial_moves').where('org_id', '=', orgId).where('doc_type', '=', 'credit_note').where('doc_id', '=', id).execute();
  }

  await unlinkDocument(trx, orgId, d.type, id);
  await unlinkDocument(trx, orgId, kind, id);
  await recordDeletion(trx, {
    orgId, userId, docType: d.type, docId: id, number: row.number, date: String(row[d.date]).slice(0, 10),
    totalPaise: toPaiseFromSql(row.total), contactId: row.customer_id, branchId: row.branch_id,
    journalEntryId: row.journal_entry_id ?? null, reversalEntryId: reversal, reason, snapshot,
  });
  await trx.deleteFrom(d.table).where('id', '=', id).where('org_id', '=', orgId).execute();
  return { number: row.number };
}
