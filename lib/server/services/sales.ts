import { editAfterSendingAllowed } from './doc-preferences';
import { reverseChargeProblem, withoutTax } from '../../tax/reverse-charge';
import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Sales services: invoices, and the journal entries behind them.
//
// The GST engine in lib/tax/gst.ts is reused as-is. It is pure logic — state
// codes, the supply-type resolver, per-line tax computation — with no browser
// dependency, and it was written during the MVP precisely so it would survive
// into this build. Reimplementing it here would give two places for the tax to
// be computed and one of them would drift.
//
// Every function takes a transaction. The document write and its posting are a
// single atomic unit: an invoice must never exist without its journal entry,
// and an entry must never exist without the document that explains it.
// ─────────────────────────────────────────────────────────────────────────────

import { sql, type Insertable, type Updateable } from 'kysely';
import type { DB } from '../db-types';
import type { Trx } from '../db';
import type { Paise, SupplyKind, SupplyType } from '../../types';
import { computeLineTax, exportTaxFor, isExportSupply, placeOfSupplyFor, resolveSupplyType, totalTaxPaise } from '../../tax/gst';
import { tradeProfile } from './trade-profile';
import { checkCreditHold, checkCreditLimit, checkMrp, checkStock } from './guards';
import { saleCostLines } from './stock-ledger';
import { checkSerials, recordSerials } from './serials';
import { checkGodown } from './godowns';
import { voidReason, voidStamp } from './void-reason';
import { releaseInvoiceQuantities } from './order-release';
import { einvoiceApplicability, irnRequired, registrationOn } from './statutory';
import { bestDiscount, discountsFor, pricesFor } from './price-lists';
import { batchesForSale } from './batches';
import { seriesFor } from './voucher-types';
import { costLines, type DocumentLineInput } from './lines';
import { roundToRupee } from '../../money';
import { toPaiseFromSql, toSqlFromPaise } from '../money-sql';
import { assertApproved, ruleFor, submitForApproval } from './approvals';
import { allocateNumber, assertGstDocNumber, postEntry, reverseEntry, type DraftLine } from '../ledger/posting';
import { CODE, accountIds, requireAccount } from '../ledger/chart-of-accounts';
import { ApiError, badRequest, notFound } from '../http';
import { tcsRateOn } from '../tax/rates';
import { itemSaleAccounts } from './item-accounts';
import { plain, recordDeletion, reverseForChange, unlinkDocument } from './doc-delete';

/** '26-27' for any date in the 2026-27 financial year. */
/** Whether every line is a service: by its item, or by a SAC (99…) code. */
async function servicesOnly(trx: Trx, orgId: number, lines: InvoiceLineInput[]): Promise<boolean> {
  const ids = lines.map((l) => l.itemId).filter((x): x is number => !!x);
  const kinds = ids.length
    ? new Map((await trx.selectFrom('items').select(['id', 'kind']).where('org_id', '=', orgId).where('id', 'in', ids).execute())
      .map((i) => [i.id, i.kind]))
    : new Map<number, string>();
  return lines.every((l) => (l.itemId ? kinds.get(l.itemId) === 'service' : (l.hsnSac ?? '').startsWith('99')));
}

/** Record an export's shipping bill, which usually follows the invoice by days. */
export async function setExportDetails(trx: Trx, orgId: number, invoiceId: number, d: ExportDetailsInput) {
  const inv = await trx.selectFrom('invoices').select(['id', 'supply_type', 'number'])
    .where('id', '=', invoiceId).where('org_id', '=', orgId).executeTakeFirst();
  if (!inv) throw notFound('Invoice not found.');
  if (!['export_lut', 'export_with_tax', 'sez'].includes(inv.supply_type)) {
    throw badRequest(`${inv.number} is not an export; it has no shipping bill.`);
  }
  if (d.shippingBillNo && !/^\d{1,20}$/.test(d.shippingBillNo)) throw badRequest('A shipping bill number is digits only.');
  if (d.portCode && !/^[A-Z0-9]{6}$/.test(d.portCode)) throw badRequest('A port code is six letters and digits, such as INMAA1.');
  await trx.updateTable('invoices').set({
    export_shipping_bill_no: d.shippingBillNo ?? null, export_shipping_bill_date: d.shippingBillDate ?? null,
    export_port_code: d.portCode ?? null, export_country: d.countryCode ?? null, export_currency: d.currency ?? null,
  }).where('id', '=', invoiceId).execute();
}

export function fyLabelFor(date: string): string {
  const [y, m] = date.split('-').map(Number);
  const start = m < 4 ? y - 1 : y;
  return `${String(start).slice(2)}-${String((start + 1) % 100).padStart(2, '0')}`;
}

export type InvoiceLineInput = DocumentLineInput;

export interface CreateInvoiceInput {
  branchId: number;
  /** The godown the goods leave or enter; none is the branch's main one. */
  warehouseId?: number | null;
  /** The cost centre its income or expense belongs to. */
  costCentreId?: number | null;
  customerId: number;
  date: string;
  dueDate: string;
  lines: InvoiceLineInput[];
  placeOfSupply?: string;
  supplyKind?: SupplyKind;
  status?: 'draft' | 'approved';
  number?: string;
  orderNumber?: string | null;
  subject?: string | null;
  paymentTerms?: string | null;
  salespersonId?: number | null;
  notes?: string | null;
  terms?: string | null;
  shippingChargePaise?: Paise;
  adjustmentPaise?: Paise;
  adjustmentLabel?: string | null;
  /**
   * Zoho's "This transaction is applicable for reverse charge": the buyer pays
   * the GST, so the invoice charges and posts none and GSTR-1 reports it with
   * rchrg Y (lib/tax/reverse-charge.ts). Only to a registered buyer.
   */
  reverseCharge?: boolean;
  /**
   * Zoho's "New Bill Of Supply": exempt, nil-rated or non-GST goods (or a
   * composition dealer's sale), with no tax on it at all — titled and printed
   * as a Bill of Supply (Rule 49).
   */
  billOfSupply?: boolean;
  /**
   * Round the total to the rupee (the default, as every invoice has been).
   * False keeps the paise: a recurring profile whose Rounding Off Preference
   * is Zoho's "No Rounding" (migration 126).
   */
  roundTotal?: boolean;
  /** The TCS head to collect under; the rate is the one in force on the invoice date. */
  tcsCode?: string | null;
  /** A TCS amount worked out elsewhere. Ignored when `tcsCode` is given. */
  tcsPaise?: Paise;
  /** An export, picked on the invoice: true pays IGST, false goes under the LUT (refused without one in force). */
  exportWithTax?: boolean;
  /**
   * An export's IGST from the order, estimate or challan it comes from: kept
   * where a LUT still allows it, IGST paid where none covers the invoice date.
   */
  exportFromSource?: boolean;
  /** An imported invoice's IGST, as it was billed: kept as it is. */
  exportAsBilled?: boolean;
  sourceDocType?: string | null;
  sourceDocId?: number | null;
  /** Index for index with `lines`: the order or challan line each one came from. */
  lineSources?: ({ type: 'sales_order' | 'challan'; id: number } | null)[];
  /**
   * When an approval rule catches the invoice, save it as a draft submitted
   * for approval instead of refusing. For conversions, where the person asked
   * for the next step and there is no form to go back to.
   */
  holdForApproval?: boolean;
  /** Where the goods go, when not to the customer's own address. */
  shipTo?: ShipToInput | null;
  /** An export's shipping bill, when it is known at the time. */
  exportDetails?: ExportDetailsInput | null;
  /** Someone with approval rights saving past a credit limit the book blocks at. */
  overrideLimits?: boolean;
  /**
   * Priced in another currency: every rate, shipping and adjustment is in its
   * minor unit (cents), and the invoice is booked in rupees at `exchangeRate`
   * (rupees for one unit) — the rate on the date of supply (CGST Rule 34).
   */
  currency?: string;
  exchangeRate?: number;
  /** A voucher type: numbered in its own series instead of the ordinary one. */
  voucherTypeId?: number | null;
  /**
   * A debit note (CGST Act s.34(3)): the invoice charged too little. Posted as
   * an invoice is, numbered in its own DN series, reported in GSTR-1 as a note.
   */
  docKind?: 'invoice' | 'debit_note';
  /** The invoice a debit note corrects (Rule 53(1A) wants it named). */
  againstInvoiceId?: number | null;
  /** Why the debit note was raised: a price revised upward, goods short-billed. */
  noteReason?: string | null;
}

export interface ForeignCurrency { currency: string; rate: number }

/** The currency of a document, or null for rupees. */
export function foreignOf(input: { currency?: string; exchangeRate?: number }): ForeignCurrency | null {
  const c = (input.currency ?? 'INR').trim().toUpperCase();
  if (c === 'INR') return null;
  if (!/^[A-Z]{3}$/.test(c)) throw badRequest('A currency is a three-letter code, such as USD.');
  if (!(input.exchangeRate && input.exchangeRate > 0)) throw badRequest(`Give the exchange rate: rupees for one ${c}.`);
  return { currency: c, rate: input.exchangeRate };
}

/** A foreign figure in rupees at a rate, to the paisa. */
export const atRate = (minor: Paise, rate: number): Paise => Math.round(minor * rate);

/** The document's own figures in its currency, before conversion. */
function foreignTotals(input: CreateInvoiceInput) {
  let subtotal = 0;
  for (const l of input.lines) {
    if (l.ratePaise === undefined) throw badRequest('Give every line a price in the invoice currency.');
    subtotal += computeLineTax({ ratePaise: l.ratePaise, qty: l.qty, discountPct: l.discountPct ?? 0, gstRatePct: 0, supplyType: 'nil_or_exempt' }).taxable;
  }
  return { subtotal, extras: (input.shippingChargePaise ?? 0) + (input.adjustmentPaise ?? 0) };
}

/** The same invoice priced in rupees: what the books carry. */
function inRupees(input: CreateInvoiceInput, rate: number): CreateInvoiceInput {
  return {
    ...input,
    lines: input.lines.map((l) => ({ ...l, ratePaise: atRate(l.ratePaise!, rate) })),
    shippingChargePaise: input.shippingChargePaise ? atRate(input.shippingChargePaise, rate) : input.shippingChargePaise,
    adjustmentPaise: input.adjustmentPaise ? atRate(input.adjustmentPaise, rate) : input.adjustmentPaise,
    tcsPaise: input.tcsPaise ? atRate(input.tcsPaise, rate) : input.tcsPaise,
  };
}

export interface ShipToInput {
  name?: string | null;
  gstin?: string | null;
  address?: string | null;
  city?: string | null;
  pincode?: string | null;
  stateCode: string;
  /** Delivered to someone other than the buyer, on the buyer's instruction. */
  thirdParty?: boolean;
}

export interface ExportDetailsInput {
  shippingBillNo?: string | null;
  shippingBillDate?: string | null;
  portCode?: string | null;
  countryCode?: string | null;
  currency?: string | null;
}

export interface CreatedInvoice {
  id: number;
  number: string;
  totalPaise: Paise;
  journalEntryId: number | null;
  /** Saved as a draft for approval because a rule caught it (see holdForApproval). */
  heldForApproval?: boolean;
  /** Policies that flagged the sale without stopping it: credit limit, stock. */
  warnings?: string[];
}

/**
 * Create an invoice, and post it if it is not a draft.
 *
 * A draft deliberately posts nothing. It is a document somebody is still
 * writing, not a sale that has happened, and putting it in the ledger would
 * overstate revenue and the GST liability that follows from it.
 */
export async function createInvoice(
  trx: Trx,
  orgId: number,
  userId: number | null,
  input: CreateInvoiceInput,
  /** Rewrite this invoice in place (updateInvoice): same row, same number, its payments kept. */
  opts: { replace?: { id: number; number: string } } = {},
): Promise<CreatedInvoice> {
  const replace = opts.replace ?? null;
  if (!input.lines.length) throw badRequest('An invoice needs at least one line.');
  // A customer on a price list is charged from it, on any line that names no price.
  if (!foreignOf(input) && input.lines.some((l) => l.itemId && l.ratePaise === undefined)) {
    const prices = await pricesFor(trx, orgId, input.customerId);
    if (prices) {
      input = { ...input, lines: input.lines.map((l) => (l.itemId && l.ratePaise === undefined && prices.has(l.itemId) ? { ...l, ratePaise: prices.get(l.itemId)! } : l)) };
    }
  }
  // And their discount rules, on any line that names no discount.
  if (input.lines.some((l) => l.itemId && l.discountPct === undefined)) {
    const rules = await discountsFor(trx, orgId, input.customerId);
    if (rules) {
      input = { ...input, lines: input.lines.map((l) => (l.itemId && l.discountPct === undefined ? { ...l, discountPct: bestDiscount(rules, l.itemId, l.qty) || undefined } : l)) };
    }
  }
  const fx = foreignOf(input);
  const foreign = fx ? foreignTotals(input) : null;
  if (fx) input = inRupees(input, fx.rate);

  const branch = await trx
    .selectFrom('branches')
    .select(['id', 'state_code', 'gstin'])
    .where('id', '=', input.branchId)
    .where('org_id', '=', orgId)
    .executeTakeFirst();
  if (!branch) throw notFound('That branch does not exist.');

  const customer = await trx
    .selectFrom('contacts')
    .select(['id', 'display_name', 'state_code', 'gst_treatment', 'pan', 'gstin'])
    .where('id', '=', input.customerId)
    .where('org_id', '=', orgId)
    .executeTakeFirst();
  if (!customer) throw notFound('That customer does not exist.');

  // Goods go to the ship-to; services to the customer (lib/tax/gst.ts).
  const ship = input.shipTo?.stateCode ? input.shipTo : null;
  if (ship && !/^\d{2}$/.test(ship.stateCode)) throw badRequest('The ship-to state is a two-digit state code.');
  if (ship?.pincode && !/^[1-9]\d{5}$/.test(ship.pincode)) throw badRequest('A ship-to PIN code is six digits.');
  const placeOfSupply = placeOfSupplyFor({
    billToState: customer.state_code,
    shipToState: ship?.stateCode,
    shipToThirdParty: !!ship?.thirdParty,
    servicesOnly: ship ? await servicesOnly(trx, orgId, input.lines) : true,
    override: input.placeOfSupply,
  });
  // A composition dealer, or a business not registered at all, issues a bill
  // of supply with no tax on it. A composition dealer may not supply across a
  // state border either, exports and SEZs included (CGST Act s.10(2)(d), (2A)(c)).
  const registration = await registrationOn(trx, orgId, input.date);

  // An export goes without IGST only under a Letter of Undertaking in force on
  // its date; otherwise IGST is paid on it and claimed back (lib/tax/gst.ts
  // exportTaxFor). A debit note is part of the supply it corrects, so it
  // always takes what that invoice took, and the LUT that invoice went under.
  const exporting = registration === 'regular' && isExportSupply(customer.gst_treatment, placeOfSupply);
  const trade = exporting ? await tradeProfile(trx, orgId) : null;
  let exportWithTax: boolean | undefined;
  let lutArn = trade?.lutArn ?? null;
  const exportNotes: string[] = [];
  if (exporting) {
    const against = input.docKind === 'debit_note' && input.againstInvoiceId
      ? await trx.selectFrom('invoices').select(['supply_type', 'export_lut_arn']).where('id', '=', input.againstInvoiceId).where('org_id', '=', orgId).executeTakeFirst()
      : null;
    if (against && (against.supply_type === 'export_lut' || against.supply_type === 'export_with_tax')) {
      exportWithTax = against.supply_type === 'export_with_tax';
      lutArn = against.export_lut_arn ?? lutArn;
    } else {
      const decided = exportTaxFor(trade, input.date, { asked: input.exportWithTax, source: input.exportFromSource, history: input.exportAsBilled });
      if (decided.refused) {
        throw badRequest(`${decided.refused}, so this export cannot go with IGST nil. Raise it with IGST paid, or record the LUT in Settings → Organisation.`);
      }
      if (decided.note) exportNotes.push(decided.note);
      exportWithTax = decided.withTax;
    }
  }
  let supplyType = resolveSupplyType({
    branchStateCode: branch.state_code,
    placeOfSupply,
    customerTreatment: customer.gst_treatment as never,
    exportWithTax,
  }) as SupplyType;

  if (registration === 'composition' && supplyType !== 'intra' && supplyType !== 'nil_or_exempt') {
    throw badRequest(
      'A composition dealer cannot make an inter-state supply, an export or a supply to an SEZ. ' +
        'Check the place of supply, or leave composition first (Settings → Statutory).',
    );
  }
  if (registration !== 'regular') supplyType = 'nil_or_exempt';

  let costed = await costLines(trx, orgId, supplyType, input.lines, 'sale_price', input.date);
  // A bill of supply carries no tax: a registered business raises one only for exempt, nil-rated or non-GST goods.
  if (input.billOfSupply && registration === 'regular' && costed.lines.some((c) => c.gstRatePct > 0)) {
    throw badRequest('A bill of supply carries no tax: every line must be exempt, nil-rated or non-GST (0%). Raise a tax invoice for taxable goods.');
  }
  if (input.reverseCharge) {
    if (input.billOfSupply) throw badRequest('A bill of supply carries no tax, so it cannot be under reverse charge.');
    const problem = reverseChargeProblem({ buyerGstin: customer.gstin, supplyType });
    if (problem) throw badRequest(problem);
    costed = withoutTax(costed);
  }
  const computed = costed.lines;

  // A line may credit its own income head, or Asset Disposal Clearing when it
  // sells an asset. Nothing else: an invoice line is never a liability or a cost.
  const ownAccounts = [...new Set(input.lines.map((l) => l.accountId).filter((x): x is number => !!x))];
  if (ownAccounts.length) {
    const found = await trx.selectFrom('accounts').select(['id', 'code', 'type'])
      .where('org_id', '=', orgId).where('id', 'in', ownAccounts).execute();
    for (const id of ownAccounts) {
      const a = found.find((f) => f.id === id);
      if (!a || (a.type !== 'income' && a.code !== CODE.ASSET_DISPOSAL)) {
        throw badRequest('An invoice line can be credited only to an income account, or to Asset Disposal Clearing.');
      }
    }
  }

  const tax = costed.tax;
  const shipping = input.shippingChargePaise ?? 0;
  const adjustment = input.adjustmentPaise ?? 0;

  // TCS is worked out here, at the rate in force on the invoice's own date,
  // on what the buyer pays before TCS. A head with a threshold (a car above
  // ₹10 lakh) collects on the whole amount once the sale exceeds it, and
  // nothing below it.
  let tcs = input.tcsPaise ?? 0;
  let tcsCode: string | null = null;
  if (input.tcsCode) {
    const rate = await tcsRateOn(trx, orgId, input.tcsCode, input.date);
    if (!rate) {
      throw badRequest(`There is no TCS rate for ${input.tcsCode} on ${input.date}. Check Settings → Tax rates.`);
    }
    const base = tax.taxablePaise + totalTaxPaise(tax) + shipping + adjustment;
    const applies = rate.thresholdPaise === null || base > rate.thresholdPaise;
    const pct = customer.pan?.trim() ? rate.ratePct : rate.rateNoPanPct;
    tcs = applies ? Math.round((base * pct) / 100) : 0;
    tcsCode = rate.code;
  }
  const gross = tax.taxablePaise + totalTaxPaise(tax) + shipping + adjustment + tcs;
  const { rounded, roundOff } = input.roundTotal === false ? { rounded: gross, roundOff: 0 } : roundToRupee(gross);

  // Goods, services, or a mix — inferred from the lines when the caller is
  // silent. It decides which GSTR-1 table the supply is reported in.
  const supplyKind: SupplyKind = input.supplyKind ?? costed.supplyKind;

  let status = input.status ?? 'draft';
  const held = !replace && status !== 'draft' && !!input.holdForApproval && !!(await ruleFor(trx, orgId, 'invoice', rounded));
  if (held) status = 'draft';

  // The book's own rules, as the sale is made: the customer's credit limit,
  // and stock that is not there to sell. A draft is not a sale yet.
  const warnings: string[] = [...exportNotes];
  if (status !== 'draft') {
    await checkCreditLimit(trx, orgId, input.customerId, rounded, warnings, input.overrideLimits);
    await checkCreditHold(trx, orgId, input.customerId, input.date, warnings, input.overrideLimits);
    await checkStock(trx, orgId, input.branchId, input.date, input.lines, warnings);
  }
  await checkMrp(trx, orgId, computed, warnings);
  // Which batch each batch-tracked line sells: named, or first expiry first out.
  const batchWarnings: string[] = [];
  const batchIds = await batchesForSale(trx, orgId, input.date, input.lines, batchWarnings);
  if (status !== 'draft') warnings.push(...batchWarnings);
  // A hand-typed number has to meet the same GST rules as an allocated one;
  // until now it was only checked when GSTR-1 was built, months too late.
  const typed = replace ? replace.number : input.number?.trim();
  if (typed && !replace) assertGstDocNumber(typed);
  const debitNote = input.docKind === 'debit_note';
  if (debitNote) {
    if (!input.noteReason?.trim()) throw badRequest('Say why the debit note is raised: a price revised upward, goods short-billed.');
    if (input.voucherTypeId) throw badRequest('A debit note has its own series; it does not take a voucher type.');
    if (input.againstInvoiceId) {
      const orig = await trx.selectFrom('invoices').select(['customer_id', 'status', 'doc_kind'])
        .where('id', '=', input.againstInvoiceId).where('org_id', '=', orgId).executeTakeFirst();
      if (!orig || orig.doc_kind !== 'invoice') throw notFound('The invoice the debit note corrects does not exist.');
      if (orig.customer_id !== input.customerId) throw badRequest('A debit note goes to the customer of the invoice it corrects.');
      if (orig.status === 'draft' || orig.status === 'void') throw badRequest('That invoice was never issued, or is void; there is nothing to correct.');
    } else if (status !== 'draft') {
      warnings.push('Rule 53(1A) wants the invoice a debit note corrects named on it. None was given.');
    }
  }
  // Rule 46(b): a consecutive series for each kind of document.
  const series = debitNote
    ? { docType: 'DN', prefix: 'DN', voucherTypeId: null }
    : await seriesFor(trx, orgId, 'INV', input.voucherTypeId);
  const number =
    typed ||
    (await allocateNumber(trx, orgId, input.branchId, series.docType, fyLabelFor(input.date), {
      prefix: series.prefix,
    }));

  const values: Insertable<DB['invoices']> = {
      org_id: orgId,
      branch_id: input.branchId,
      cost_centre_id: input.costCentreId ?? null,
      warehouse_id: await checkGodown(trx, orgId, input.branchId, input.warehouseId),
      number,
      doc_kind: debitNote ? 'debit_note' : 'invoice',
      against_invoice_id: debitNote ? input.againstInvoiceId ?? null : null,
      note_reason: debitNote ? input.noteReason!.trim().slice(0, 255) : null,
      customer_id: input.customerId,
      invoice_date: input.date,
      due_date: input.dueDate,
      place_of_supply: placeOfSupply,
      supply_type: supplyType,
      supply_kind: supplyKind,
      status,
      subtotal: toSqlFromPaise(tax.taxablePaise),
      doc_discount: toSqlFromPaise(0),
      cgst: toSqlFromPaise(tax.cgstPaise),
      sgst: toSqlFromPaise(tax.sgstPaise),
      igst: toSqlFromPaise(tax.igstPaise),
      cess: toSqlFromPaise(tax.cessPaise),
      tcs: toSqlFromPaise(tcs),
      tcs_code: tcsCode,
      shipping_charge: toSqlFromPaise(shipping),
      adjustment: toSqlFromPaise(adjustment),
      adjustment_label: input.adjustmentLabel ?? null,
      reverse_charge: input.reverseCharge ? 1 : 0,
      bill_of_supply: input.billOfSupply ? 1 : 0,
      round_off: toSqlFromPaise(roundOff),
      total: toSqlFromPaise(rounded),
      amount_paid: toSqlFromPaise(0),
      order_number: input.orderNumber ?? null,
      subject: input.subject ?? null,
      payment_terms: input.paymentTerms ?? null,
      salesperson_id: input.salespersonId ?? null,
      notes: input.notes ?? null,
      terms: input.terms ?? null,
      source_doc_type: input.sourceDocType ?? null,
      source_doc_id: input.sourceDocId ?? null,
      ship_to_name: ship?.name ?? null,
      ship_to_gstin: ship?.gstin ?? null,
      ship_to_address: ship?.address ?? null,
      ship_to_city: ship?.city ?? null,
      ship_to_pincode: ship?.pincode ?? null,
      ship_to_state_code: ship?.stateCode ?? null,
      ship_to_third_party: ship?.thirdParty ? 1 : 0,
      export_shipping_bill_no: input.exportDetails?.shippingBillNo ?? null,
      export_shipping_bill_date: input.exportDetails?.shippingBillDate ?? null,
      export_port_code: input.exportDetails?.portCode ?? null,
      export_country: input.exportDetails?.countryCode ?? null,
      export_currency: input.exportDetails?.currency ?? null,
      // The LUT it went under, kept with it: next year's never reprints on it.
      export_lut_arn: supplyType === 'export_lut' ? lutArn : null,
      created_by_user_id: userId,
    };
  let invoiceId: number;
  if (replace) {
    // An edit: the row keeps its id, number, creator and what has been paid on it.
    const { org_id: _o, number: _n, amount_paid: _a, created_by_user_id: _c, ...changed } = values;
    await trx.updateTable('invoices').set({
      ...changed,
      journal_entry_id: null,
      currency: 'INR', exchange_rate: '1', fc_subtotal: null, fc_total: null,
    } as Updateable<DB['invoices']>).where('id', '=', replace.id).where('org_id', '=', orgId).execute();
    invoiceId = replace.id;
  } else {
    const inserted = await trx.insertInto('invoices').values(values).executeTakeFirstOrThrow();
    invoiceId = Number(inserted.insertId);
  }
  if (series.voucherTypeId && !replace) {
    await trx.updateTable('invoices').set({ voucher_type_id: series.voucherTypeId }).where('id', '=', invoiceId).execute();
  }
  if (fx && foreign) {
    // The tax and any TCS are charged in rupees; in the invoice's currency they are their rupee value at the rate.
    const fcTotal = foreign.subtotal + foreign.extras + Math.round((totalTaxPaise(tax) + tcs) / fx.rate);
    await trx.updateTable('invoices').set({
      currency: fx.currency, exchange_rate: String(fx.rate),
      fc_subtotal: toSqlFromPaise(foreign.subtotal), fc_total: toSqlFromPaise(fcTotal),
    }).where('id', '=', invoiceId).execute();
  }

  // A line with no account of its own credits its item's sales account, as
  // Zoho's does (a service item's is Service Income); with neither, Sales.
  const itemAccounts = await itemSaleAccounts(trx, orgId, computed.map((c) => c.itemId));
  await trx
    .insertInto('invoice_lines')
    .values(
      computed.map((c, i) => ({
        org_id: orgId,
        invoice_id: invoiceId,
        source_line_type: input.lineSources?.[i]?.type ?? null,
        source_line_id: input.lineSources?.[i]?.id ?? null,
        line_no: i + 1,
        item_id: c.itemId,
        account_id: input.lines[i]?.accountId ?? (c.itemId ? itemAccounts.get(c.itemId) : undefined) ?? null,
        batch_id: batchIds[i] ?? null,
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
      })),
    )
    .execute();
  // The numbered pieces going out. A draft's are checked when it is issued.
  const lineIds = (await trx.selectFrom('invoice_lines').select('id').where('invoice_id', '=', invoiceId).orderBy('line_no').execute()).map((r) => r.id);
  await recordSerials(trx, orgId, { type: 'invoice', id: invoiceId }, -1,
    input.lines.map((l, i) => ({ lineId: lineIds[i] ?? null, itemId: l.itemId, qty: l.qty, serials: l.serials })),
    { check: false, warnings: status !== 'draft' ? warnings : undefined });

  // Where e-invoicing applies, an invoice to a registered buyer, an SEZ or
  // abroad needs an IRN before it is legally valid, so the register row is
  // created up front rather than when somebody remembers to submit it.
  const einvoicing = await einvoiceApplicability(trx, orgId);
  if (replace) await trx.deleteFrom('einvoices').where('invoice_id', '=', invoiceId).where('org_id', '=', orgId).execute();
  await trx
    .insertInto('einvoices')
    .values({
      org_id: orgId,
      invoice_id: invoiceId,
      // A draft is not an issued document, so it is not awaiting anything yet.
      // The status moves to pending when the invoice is actually posted.
      status: status !== 'draft' && irnRequired(einvoicing, branch.gstin, customer.gst_treatment, input.date) ? 'pending' : 'not_applicable',
    })
    .execute();

  let journalEntryId: number | null = null;
  if (status !== 'draft') {
    journalEntryId = await postInvoice(trx, orgId, userId, invoiceId);
  }
  if (held) await submitForApproval(trx, orgId, userId, 'invoice', invoiceId);

  return { id: invoiceId, number, totalPaise: rounded, journalEntryId, heldForApproval: held, warnings };
}

/**
 * Post an invoice to the ledger.
 *
 * The entry the accountant expects:
 *   Dr Accounts Receivable      what the customer owes, including tax
 *     Cr Sales                  the taxable value, which is the actual revenue
 *     Cr Output CGST/SGST/IGST  tax collected on the government's behalf
 *     Cr Output cess            likewise, on goods that attract it
 *     Cr Shipping income        billed separately from the goods
 *     Cr TCS payable            also collected for the government
 *     Cr/Dr Rounding            the paisa lost rounding the total to the rupee
 *
 * Tax is a liability, not income. Treating collected GST as revenue overstates
 * profit and understates what is owed at the end of the month.
 */
export async function postInvoice(
  trx: Trx,
  orgId: number,
  userId: number | null,
  invoiceId: number,
): Promise<number> {
  const inv = await trx
    .selectFrom('invoices')
    .selectAll()
    .where('id', '=', invoiceId)
    .where('org_id', '=', orgId)
    .executeTakeFirst();
  if (!inv) throw notFound('Invoice not found.');
  if (inv.journal_entry_id) return inv.journal_entry_id;
  // Maker and checker: a rule may want someone else to approve it first.
  await assertApproved(trx, orgId, 'invoice', inv);
  // Each numbered piece it sells has to be here to sell.
  await checkSerials(trx, orgId, { type: 'invoice', id: invoiceId });

  const acc = await accountIds(trx, orgId);
  const p = toPaiseFromSql;

  // Lines that name their own account credit it; the rest is Sales.
  const own = await trx.selectFrom('invoice_lines')
    .select(['account_id', sql<string>`SUM(taxable)`.as('taxable')])
    .where('invoice_id', '=', invoiceId).where('account_id', 'is not', null)
    .groupBy('account_id').execute();
  const elsewhere = own.reduce((t, r) => t + p(r.taxable), 0);

  // Typed up front so the conditional pushes below are not narrowed to the
  // shape of the first element.
  const lines: DraftLine[] = [
    { accountId: requireAccount(acc, CODE.AR), debit: p(inv.total), contactId: inv.customer_id },
    { accountId: requireAccount(acc, CODE.SALES), credit: p(inv.subtotal) - elsewhere },
    ...own.map((r) => ({ accountId: r.account_id!, credit: p(r.taxable) })),
    { accountId: requireAccount(acc, CODE.GST_CGST), credit: p(inv.cgst) },
    { accountId: requireAccount(acc, CODE.GST_SGST), credit: p(inv.sgst) },
    { accountId: requireAccount(acc, CODE.GST_IGST), credit: p(inv.igst) },
    { accountId: requireAccount(acc, CODE.GST_CESS), credit: p(inv.cess) },
    { accountId: requireAccount(acc, CODE.SHIPPING_INCOME), credit: p(inv.shipping_charge) },
    { accountId: requireAccount(acc, CODE.TCS_PAYABLE), credit: p(inv.tcs) },
  ];

  // Rounding is signed: a total rounded up is income, rounded down an expense.
  const roundOff = p(inv.round_off);
  if (roundOff > 0) lines.push({ accountId: requireAccount(acc, CODE.ROUNDING), credit: roundOff });
  else if (roundOff < 0) lines.push({ accountId: requireAccount(acc, CODE.ROUNDING), debit: -roundOff });

  const adjustment = p(inv.adjustment);
  if (adjustment > 0) lines.push({ accountId: requireAccount(acc, CODE.OTHER_INCOME), credit: adjustment });
  else if (adjustment < 0) lines.push({ accountId: requireAccount(acc, CODE.DISCOUNT_ALLOWED), debit: -adjustment });

  // On perpetual inventory, what the goods cost leaves Inventory for cost of
  // goods sold in this same entry, so a void takes it back too (stock-ledger.ts).
  lines.push(...await saleCostLines(trx, orgId, String(inv.invoice_date).slice(0, 10), invoiceId));

  const entry = await postEntry(trx, {
    orgId,
    branchId: inv.branch_id,
    date: inv.invoice_date,
    memo: `${inv.doc_kind === 'debit_note' ? 'Debit note' : 'Invoice'} ${inv.number}`,
    sourceType: 'invoice',
    sourceId: invoiceId,
    userId,
    module: 'sales',
    costCentreId: inv.cost_centre_id,
    lines,
  });

  await trx
    .updateTable('invoices')
    .set({ journal_entry_id: entry.id, status: inv.status === 'draft' ? 'approved' : inv.status })
    .where('id', '=', invoiceId)
    .execute();

  // Now that it is issued, it may need an IRN to be legally valid.
  const customer = await trx
    .selectFrom('contacts').select('gst_treatment')
    .where('id', '=', inv.customer_id).executeTakeFirst();
  const branchGstin = await trx
    .selectFrom('branches').select('gstin').where('id', '=', inv.branch_id).executeTakeFirst();

  if (irnRequired(await einvoiceApplicability(trx, orgId), branchGstin?.gstin, customer?.gst_treatment, String(inv.invoice_date).slice(0, 10))) {
    await trx
      .updateTable('einvoices')
      .set({ status: 'pending' })
      .where('invoice_id', '=', invoiceId)
      .where('status', '=', 'not_applicable')
      .execute();
  }

  return entry.id;
}

/**
 * Void an invoice.
 *
 * Never a delete. GST law requires the number to remain accounted for — a gap
 * in the series is a question at assessment — so the invoice stays, marked
 * void, and its journal entry is reversed rather than removed.
 */
export async function voidInvoice(
  trx: Trx,
  orgId: number,
  userId: number | null,
  invoiceId: number,
  reason?: string,
): Promise<void> {
  const inv = await trx
    .selectFrom('invoices')
    .select(['id', 'number', 'status', 'journal_entry_id', 'amount_paid'])
    .where('id', '=', invoiceId)
    .where('org_id', '=', orgId)
    // Held until the void is done: a second void at the same moment waits, then finds it void.
    .forUpdate()
    .executeTakeFirst();
  if (!inv) throw notFound('Invoice not found.');
  if (inv.status === 'void') throw new ApiError(409, 'That invoice is already void.', 'conflict');

  if (toPaiseFromSql(inv.amount_paid) > 0) {
    throw new ApiError(
      409,
      `Invoice ${inv.number} has payments against it. Remove them first, or raise a credit note instead — ` +
        'voiding it would leave the receipt pointing at nothing.',
      'has_payments',
    );
  }

  // A standing IRN means the government holds this invoice as issued. Voiding
  // it only here would leave the books and the portal disagreeing, so the IRN
  // is cancelled instead — which voids the invoice with it — and once 24 hours
  // have passed only a credit note can reverse the sale.
  const mark = await trx
    .selectFrom('einvoices')
    .select('status')
    .where('invoice_id', '=', invoiceId)
    .where('org_id', '=', orgId)
    .executeTakeFirst();
  if (mark?.status === 'submitted') {
    throw new ApiError(
      409,
      `Invoice ${inv.number} has a registered IRN. Cancel the e-invoice instead, which voids the invoice ` +
        'with it (possible for 24 hours after registration), or raise a credit note.',
      'irn_active',
    );
  }

  const why = voidReason(reason);
  if (inv.journal_entry_id) {
    await reverseEntry(trx, orgId, inv.journal_entry_id, {
      memo: `Void of invoice ${inv.number} — ${why}`,
      userId,
      module: 'sales',
    });
  }

  await trx
    .updateTable('invoices')
    .set({ status: 'void', ...voidStamp(why, userId) })
    .where('id', '=', invoiceId)
    .execute();

  // A voided invoice is no longer reportable. Leaving it pending would keep it
  // on the compliance queue for an IRN it must never be given.
  await trx
    .updateTable('einvoices')
    .set({ status: 'cancelled', cancelled_at: new Date(), cancel_reason: why.slice(0, 200) })
    .where('invoice_id', '=', invoiceId)
    .where('status', 'in', ['pending', 'failed'])
    .execute();

  // Hours and expenses it billed are unbilled again, for the invoice that replaces it.
  await trx.updateTable('time_entries').set({ invoice_id: null }).where('org_id', '=', orgId).where('invoice_id', '=', invoiceId).execute();
  await trx.updateTable('expenses').set({ billed_invoice_id: null }).where('org_id', '=', orgId).where('billed_invoice_id', '=', invoiceId).execute();
  // So are the order and challan quantities it invoiced.
  await releaseInvoiceQuantities(trx, orgId, invoiceId);
}

/** The invoice and its lines as they stand, for the audit trail and the deleted-documents record. */
async function invoiceSnapshot(trx: Trx, orgId: number, invoiceId: number) {
  const head = await trx.selectFrom('invoices').selectAll().where('id', '=', invoiceId).where('org_id', '=', orgId).executeTakeFirst();
  const lines = await trx.selectFrom('invoice_lines').selectAll().where('invoice_id', '=', invoiceId).orderBy('line_no').execute();
  return head ? { invoice: plain(head), lines: lines.map(plain) } : null;
}

/**
 * Why this invoice cannot be edited or deleted just now, Zoho's reasons and
 * the law's: void, a registered IRN, an e-way bill.
 */
async function changeBlocker(trx: Trx, orgId: number, inv: { id: number; number: string; status: string }, what: 'edit' | 'delete') {
  if (inv.status === 'void') {
    return what === 'edit' ? `${inv.number} is void. Clone it to raise it again.` : null;
  }
  const irn = await trx.selectFrom('einvoices').select('status').where('invoice_id', '=', inv.id).where('org_id', '=', orgId).executeTakeFirst();
  if (irn?.status === 'submitted') {
    return `${inv.number} has a registered IRN, so the government holds it as issued. Cancel the e-invoice first ` +
      '(possible for 24 hours after registration); after that only a credit note can change it.';
  }
  const ewb = await trx.selectFrom('eway_bills').select('status').where('invoice_id', '=', inv.id).where('org_id', '=', orgId)
    .where('status', 'in', ['pending', 'generated']).executeTakeFirst();
  if (ewb) return `${inv.number} has an e-way bill. Cancel the e-way bill first.`;
  // Invoice Preferences: "Allow editing of sent invoices", switched off.
  if (what === 'edit' && ['sent', 'partially_paid', 'overdue', 'paid'].includes(inv.status) && !(await editAfterSendingAllowed(trx, orgId, 'invoice'))) {
    return `${inv.number} has been sent, and Invoice Preferences do not allow editing sent invoices.`;
  }
  return null;
}

/**
 * Edit an invoice, as Zoho Books' Edit does, draft or issued.
 *
 * An issued invoice's entry is reversed (on its own date, so a closed period
 * refuses the edit) and the invoice is rewritten in place and posted again: the
 * same number, the same row, its payments, comments and attachments kept. The
 * audit trail gets both versions. Lines invoiced from a sales order or challan
 * keep that link and their quantity, so the order stays right.
 */
export async function updateInvoice(
  trx: Trx, orgId: number, userId: number | null, invoiceId: number, input: CreateInvoiceInput,
): Promise<CreatedInvoice & { before: unknown }> {
  const inv = await trx.selectFrom('invoices')
    .select(['id', 'number', 'status', 'doc_kind', 'against_invoice_id', 'journal_entry_id', 'amount_paid', 'source_doc_type', 'source_doc_id'])
    .where('id', '=', invoiceId).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!inv) throw notFound('Invoice not found.');
  const blocked = await changeBlocker(trx, orgId, inv, 'edit');
  if (blocked) throw new ApiError(409, blocked, 'locked_document');

  // Lines that came from an order or challan: the same lines must still be there, at the same quantity.
  const linked = await trx.selectFrom('invoice_lines').select(['source_line_type', 'source_line_id', 'qty', 'description'])
    .where('invoice_id', '=', invoiceId).where('source_line_id', 'is not', null).execute();
  for (const l of linked) {
    const kept = input.lines.filter((_, i) => input.lineSources?.[i]?.type === l.source_line_type && input.lineSources?.[i]?.id === Number(l.source_line_id));
    const qty = kept.reduce((t, k) => t + k.qty, 0);
    if (Math.abs(qty - Number(l.qty)) > 1e-6) {
      throw badRequest(`"${l.description ?? 'A line'}" was invoiced from ${l.source_line_type === 'challan' ? 'a delivery challan' : 'a sales order'}: ` +
        'keep it at its quantity. To invoice a different quantity, delete this invoice and invoice the order again.');
    }
  }
  const sources = new Set(linked.map((l) => `${l.source_line_type}|${l.source_line_id}`));
  for (const src of input.lineSources ?? []) {
    if (src && !sources.has(`${src.type}|${src.id}`)) throw badRequest('A line can only keep the order it was invoiced from.');
  }

  const before = await invoiceSnapshot(trx, orgId, invoiceId);
  const issued = inv.status !== 'draft';
  await reverseForChange(trx, orgId, inv.journal_entry_id, {
    memo: `Invoice ${inv.number} edited: the entry as it was, reversed`, userId, module: 'sales',
  });
  // Unposted for a moment, so every check sees the books without the old version.
  await trx.updateTable('invoices').set({ journal_entry_id: null, status: 'draft' }).where('id', '=', invoiceId).execute();
  await trx.deleteFrom('serial_moves').where('org_id', '=', orgId).where('doc_type', '=', 'invoice').where('doc_id', '=', invoiceId).execute();
  await trx.deleteFrom('invoice_lines').where('invoice_id', '=', invoiceId).execute();

  // Once issued it stays issued: Zoho saves an edited sent invoice as sent, never back to a draft.
  const status = issued ? 'approved' : input.status ?? 'draft';
  const made = await createInvoice(trx, orgId, userId, {
    ...input,
    status,
    docKind: inv.doc_kind === 'debit_note' ? 'debit_note' : 'invoice',
    againstInvoiceId: inv.against_invoice_id,
    sourceDocType: inv.source_doc_type as CreateInvoiceInput['sourceDocType'],
    sourceDocId: inv.source_doc_id,
    holdForApproval: false,
  }, { replace: { id: invoiceId, number: inv.number } });

  const paid = toPaiseFromSql(inv.amount_paid);
  if (paid > made.totalPaise) {
    throw new ApiError(409,
      `₹${(paid / 100).toLocaleString('en-IN')} has already been received against ${inv.number}; the new total cannot be less. ` +
      'Remove a payment or credit first.', 'has_payments');
  }
  if (issued) {
    const was = inv.status === 'approved' ? 'approved' : 'sent';
    await trx.updateTable('invoices')
      .set({ status: paid <= 0 ? was : paid >= made.totalPaise ? 'paid' : 'partially_paid' })
      .where('id', '=', invoiceId).execute();
  }
  return { ...made, before };
}

/**
 * Delete an invoice, as Zoho Books' Delete does: only while nothing has been
 * received against it and nothing else rests on it. Its entry is reversed, the
 * order quantities it took are released, and the record of it is kept in
 * deleted_documents so its number still counts in GSTR-1 table 13.
 */
export async function deleteInvoice(trx: Trx, orgId: number, userId: number | null, invoiceId: number, reason?: string | null): Promise<{ number: string }> {
  const inv = await trx.selectFrom('invoices')
    .select(['id', 'number', 'status', 'doc_kind', 'invoice_date', 'total', 'amount_paid', 'customer_id', 'branch_id', 'journal_entry_id'])
    .where('id', '=', invoiceId).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!inv) throw notFound('Invoice not found.');
  const blocked = await changeBlocker(trx, orgId, inv, 'delete');
  if (blocked) throw new ApiError(409, blocked, 'locked_document');
  if (toPaiseFromSql(inv.amount_paid) > 0) {
    throw new ApiError(409, `Payments or credits are recorded against ${inv.number}. Delete or unapply them first, then delete the invoice.`, 'has_payments');
  }
  const refuse = (why: string): never => { throw new ApiError(409, `${inv.number} cannot be deleted: ${why}`, 'in_use'); };
  const dn = await trx.selectFrom('invoices').select('number').where('org_id', '=', orgId).where('against_invoice_id', '=', invoiceId).where('status', '<>', 'void').executeTakeFirst();
  if (dn) refuse(`debit note ${dn.number} corrects it. Delete or void that first.`);
  const cn = await trx.selectFrom('credit_notes').select('number').where('org_id', '=', orgId).where('against_invoice_id', '=', invoiceId).where('status', '<>', 'void').executeTakeFirst();
  if (cn) refuse(`credit note ${cn.number} was raised against it. Delete or void that first.`);
  if (await trx.selectFrom('credit_note_applications').select('id').where('invoice_id', '=', invoiceId).executeTakeFirst()) refuse('a credit note was applied to it. Remove that credit first.');
  if (await trx.selectFrom('advance_tax_adjustments').select('id').where('invoice_id', '=', invoiceId).executeTakeFirst()) refuse('an advance was adjusted against it.');
  if (await trx.selectFrom('fixed_assets').select('id').where('disposal_invoice_id', '=', invoiceId).executeTakeFirst()) refuse('it sold a fixed asset. Undo the disposal first.');
  // Interest charged on this invoice is billed on another: that one goes first. An interest
  // invoice itself (Sales → Overdue interest) can go, and its days are unbilled again below.
  const charged = await trx.selectFrom('invoice_interest_charges as ic').innerJoin('invoices as ci', 'ci.id', 'ic.charge_invoice_id')
    .select('ci.number').where('ic.invoice_id', '=', invoiceId).where('ic.charge_invoice_id', '<>', invoiceId).executeTakeFirst();
  if (charged) refuse(`overdue interest on it was billed on ${charged.number}. Delete that interest invoice first.`);
  if (await trx.selectFrom('eway_bills').select('id').where('invoice_id', '=', invoiceId).executeTakeFirst()) refuse('an e-way bill is on record for it.');
  if (await trx.selectFrom('payment_allocations').select('id').where('org_id', '=', orgId).where('target_type', '=', 'invoice').where('target_id', '=', invoiceId).executeTakeFirst()) refuse('a payment is applied to it.');
  if (await trx.selectFrom('journal_allocations').select('id').where('org_id', '=', orgId).where('target_type', '=', 'invoice').where('target_id', '=', invoiceId).executeTakeFirst()) refuse('a journal entry is set against it.');

  const snapshot = await invoiceSnapshot(trx, orgId, invoiceId);
  const reversal = await reverseForChange(trx, orgId, inv.journal_entry_id, {
    memo: `${inv.doc_kind === 'debit_note' ? 'Debit note' : 'Invoice'} ${inv.number} deleted`, userId, module: 'sales',
  });
  // What void releases, delete releases: hours, re-charged expenses, order and challan quantities.
  await trx.updateTable('time_entries').set({ invoice_id: null }).where('org_id', '=', orgId).where('invoice_id', '=', invoiceId).execute();
  await trx.updateTable('expenses').set({ billed_invoice_id: null }).where('org_id', '=', orgId).where('billed_invoice_id', '=', invoiceId).execute();
  await releaseInvoiceQuantities(trx, orgId, invoiceId);
  await trx.updateTable('delivery_challans').set({ invoice_id: null }).where('org_id', '=', orgId).where('invoice_id', '=', invoiceId).execute();
  await trx.deleteFrom('serial_moves').where('org_id', '=', orgId).where('doc_type', '=', 'invoice').where('doc_id', '=', invoiceId).execute();
  await trx.deleteFrom('payment_reminders').where('invoice_id', '=', invoiceId).execute();
  await trx.deleteFrom('invoice_payment_links').where('invoice_id', '=', invoiceId).execute();
  // The interest it billed is owed again: Overdue interest works it out afresh.
  await trx.deleteFrom('invoice_interest_charges').where('org_id', '=', orgId).where('charge_invoice_id', '=', invoiceId).execute();
  await unlinkDocument(trx, orgId, 'invoice', invoiceId);
  await recordDeletion(trx, {
    orgId, userId, docType: inv.doc_kind === 'debit_note' ? 'debit_note' : 'invoice', docId: invoiceId, number: inv.number,
    date: String(inv.invoice_date).slice(0, 10), totalPaise: toPaiseFromSql(inv.total), contactId: inv.customer_id, branchId: inv.branch_id,
    journalEntryId: inv.journal_entry_id, reversalEntryId: reversal, reason, snapshot,
  });
  await trx.deleteFrom('invoices').where('id', '=', invoiceId).where('org_id', '=', orgId).execute();
  return { number: inv.number };
}

/** Mark an approved invoice as sent. Posts it first if it was still a draft. */
export async function markInvoiceSent(
  trx: Trx,
  orgId: number,
  userId: number | null,
  invoiceId: number,
): Promise<void> {
  const inv = await trx
    .selectFrom('invoices')
    .select(['id', 'status', 'journal_entry_id'])
    .where('id', '=', invoiceId)
    .where('org_id', '=', orgId)
    .executeTakeFirst();
  if (!inv) throw notFound('Invoice not found.');
  if (inv.status === 'void') throw badRequest('A void invoice cannot be sent.');

  if (!inv.journal_entry_id) await postInvoice(trx, orgId, userId, invoiceId);

  await trx.updateTable('invoices').set({ status: 'sent' }).where('id', '=', invoiceId).execute();
}
