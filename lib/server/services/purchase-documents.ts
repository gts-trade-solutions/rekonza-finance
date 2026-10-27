import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// The buy-side mirrors: purchase orders and vendor credits.
//
// Same dividing line as the sell side. A purchase order is a commitment to buy;
// nothing has been supplied, nothing is owed, and it posts nothing. Recording
// it as a payable would show a debt on the balance sheet for goods that have
// not arrived.
//
// A vendor credit does post. It is a supplier's credit note to us, so it works
// the other way round from ours: what we owe goes down, the cost that was
// booked comes back out, and the input credit claimed on that cost has to be
// given back — because if the supplier reverses the supply, the tax was never
// really paid to the government on our behalf.
// ─────────────────────────────────────────────────────────────────────────────

import type { Trx } from '../db';
import type { Paise, SupplyType } from '../../types';
import { computeLineTax, resolveSupplyType, sumTax, totalTaxPaise } from '../../tax/gst';
import { roundToRupee } from '../../money';
import { toPaiseFromSql, toSqlFromPaise } from '../money-sql';
import { allocateNumber, postEntry, reverseEntry, type DraftLine } from '../ledger/posting';
import { seriesFor } from './voucher-types';
import { CODE, accountIds, requireAccount } from '../ledger/chart-of-accounts';
import { costLines, type DocumentLineInput } from './lines';
import { fyLabelFor } from './sales';
import { ApiError, badRequest, conflict, notFound } from '../http';
import { voidReason, voidStamp } from './void-reason';

interface VendorContext {
  vendorName: string;
  placeOfSupply: string;
  supplyType: SupplyType;
  isComposition: boolean;
}

/**
 * Resolve the branch and vendor, and work out how the purchase is taxed.
 *
 * The supply type is computed from the *vendor's* state against ours, because
 * an inbound supply from another state carries IGST that only IGST credit can
 * offset. Getting this backwards puts the credit in the wrong pot.
 */
async function vendorContext(
  trx: Trx,
  orgId: number,
  branchId: number,
  vendorId: number,
): Promise<VendorContext> {
  const branch = await trx
    .selectFrom('branches').select(['id', 'state_code'])
    .where('id', '=', branchId).where('org_id', '=', orgId).executeTakeFirst();
  if (!branch) throw notFound('That branch does not exist.');

  const vendor = await trx
    .selectFrom('contacts').select(['id', 'display_name', 'state_code', 'gst_treatment'])
    .where('id', '=', vendorId).where('org_id', '=', orgId).executeTakeFirst();
  if (!vendor) throw notFound('That vendor does not exist.');

  return {
    vendorName: vendor.display_name,
    placeOfSupply: branch.state_code,
    supplyType: resolveSupplyType({
      branchStateCode: branch.state_code,
      placeOfSupply: vendor.state_code,
      customerTreatment: vendor.gst_treatment as never,
    }) as SupplyType,
    isComposition: vendor.gst_treatment === 'registered_composition',
  };
}

export interface CreatedPurchaseDoc {
  id: number;
  number: string;
  totalPaise: Paise;
  journalEntryId: number | null;
}

// ── Purchase orders ──────────────────────────────────────────────────────────

export interface CreatePurchaseOrderInput {
  branchId: number;
  vendorId: number;
  date: string;
  expectedDate?: string | null;
  lines: DocumentLineInput[];
  notes?: string | null;
  number?: string;
  status?: 'draft' | 'open';
  voucherTypeId?: number | null;
}

/**
 * Raise a purchase order.
 *
 * Posts nothing. Committing to buy is not the same as owing — the payable
 * appears when the goods and the supplier's bill do.
 */
export async function createPurchaseOrder(
  trx: Trx,
  orgId: number,
  userId: number | null,
  input: CreatePurchaseOrderInput,
): Promise<CreatedPurchaseDoc> {
  const ctx = await vendorContext(trx, orgId, input.branchId, input.vendorId);
  // Purchase prices, not sale prices — an unpriced line takes what we pay.
  const costed = await costLines(trx, orgId, ctx.supplyType, input.lines, 'purchase_price', input.date);
  const { rounded } = roundToRupee(costed.tax.taxablePaise + totalTaxPaise(costed.tax));

  const series = await seriesFor(trx, orgId, 'PO', input.voucherTypeId);
  const number =
    input.number?.trim() ||
    (await allocateNumber(trx, orgId, input.branchId, series.docType, fyLabelFor(input.date), { prefix: series.prefix }));

  const inserted = await trx
    .insertInto('purchase_orders')
    .values({
      org_id: orgId,
      branch_id: input.branchId,
      number,
      vendor_id: input.vendorId,
      order_date: input.date,
      expected_date: input.expectedDate ?? null,
      place_of_supply: ctx.placeOfSupply,
      supply_type: ctx.supplyType,
      status: input.status ?? 'open',
      subtotal: toSqlFromPaise(costed.tax.taxablePaise),
      cgst: toSqlFromPaise(costed.tax.cgstPaise),
      sgst: toSqlFromPaise(costed.tax.sgstPaise),
      igst: toSqlFromPaise(costed.tax.igstPaise),
      cess: toSqlFromPaise(costed.tax.cessPaise),
      total: toSqlFromPaise(rounded),
      billed_amount: toSqlFromPaise(0),
      notes: input.notes ?? null,
      created_by_user_id: userId,
    })
    .executeTakeFirstOrThrow();
  const id = Number(inserted.insertId);

  await trx
    .insertInto('purchase_order_lines')
    .values(
      costed.lines.map((c, i) => ({
        org_id: orgId,
        purchase_order_id: id,
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

/**
 * Turn a purchase order into a bill — the moment the payable becomes real.
 *
 * The supplier's own invoice number is required. Ours identifies the document
 * internally; theirs is what GSTR-2B is matched against, and a bill without it
 * cannot be reconciled against what the supplier filed.
 */
export async function convertPoToBill(
  trx: Trx,
  orgId: number,
  userId: number | null,
  poId: number,
  input: { vendorInvoiceNo: string; date: string; dueDate: string },
): Promise<{ id: number; internalNo: string; totalPaise: Paise }> {
  // Billed line by line, so a part-billed order offers only what is left.
  const { billFromPurchaseOrder } = await import('./order-flow');
  const bill = await billFromPurchaseOrder(trx, orgId, userId, poId, input);
  return { id: bill.id, internalNo: bill.internalNo, totalPaise: bill.totalPaise };
}

// ── Vendor credits ───────────────────────────────────────────────────────────

export interface CreateVendorCreditInput {
  branchId: number;
  vendorId: number;
  date: string;
  reason: string;
  againstBillId?: number | null;
  amountPaise: Paise;
  gstRatePct?: number;
  /** Whether input credit was claimed on the cost being reversed. */
  itcClaimed?: boolean;
  applyImmediately?: boolean;
  number?: string;
}

/**
 * Record a vendor credit, and post it.
 *
 *   Dr Accounts Payable        we owe the supplier that much less
 *     Cr Purchases             the cost that turned out not to be incurred
 *     Cr Input CGST/SGST/IGST  the credit we claimed and must now give back
 *
 * That last line is the one people forget. If the supplier reverses part of the
 * supply, they will reverse it in their GSTR-1 too, and the credit will vanish
 * from our GSTR-2B. Holding on to it produces a mismatch the department asks
 * about — with interest.
 */
export async function createVendorCredit(
  trx: Trx,
  orgId: number,
  userId: number | null,
  input: CreateVendorCreditInput,
): Promise<CreatedPurchaseDoc> {
  if (!input.reason?.trim()) throw badRequest('A vendor credit needs a reason.');
  if (input.amountPaise <= 0) throw badRequest('A vendor credit needs an amount above zero.');

  const ctx = await vendorContext(trx, orgId, input.branchId, input.vendorId);

  // A composition dealer charges no GST, so there is none to reverse.
  const gstRatePct = ctx.isComposition ? 0 : (input.gstRatePct ?? 0);
  const { tax } = computeLineTax({
    ratePaise: input.amountPaise,
    qty: 1,
    discountPct: 0,
    gstRatePct,
    supplyType: ctx.supplyType,
  });
  const totals = sumTax([tax]);
  const raw = input.amountPaise + totalTaxPaise(totals);
  const { rounded, roundOff } = roundToRupee(raw);

  let bill: { id: number; internal_no: string; total: string; amount_paid: string } | undefined;
  if (input.againstBillId) {
    bill = await trx
      .selectFrom('bills')
      .select(['id', 'internal_no', 'total', 'amount_paid'])
      .where('id', '=', input.againstBillId)
      .where('org_id', '=', orgId)
      .where('vendor_id', '=', input.vendorId)
      .executeTakeFirst();
    if (!bill) throw badRequest('That bill does not exist, or belongs to a different vendor.');

    const balance = toPaiseFromSql(bill.total) - toPaiseFromSql(bill.amount_paid);
    if (rounded > balance) {
      throw badRequest(
        `The credit is larger than what is still owed on ${bill.internal_no}. ` +
          'Credit only the outstanding amount, or record it without linking a bill.',
      );
    }
  }

  const number =
    input.number?.trim() ||
    (await allocateNumber(trx, orgId, input.branchId, 'VC', fyLabelFor(input.date), { prefix: 'VC' }));

  const inserted = await trx
    .insertInto('vendor_credits')
    .values({
      org_id: orgId,
      branch_id: input.branchId,
      number,
      vendor_id: input.vendorId,
      credit_date: input.date,
      reason: input.reason.trim(),
      against_bill_id: input.againstBillId ?? null,
      status: 'open',
      total: toSqlFromPaise(rounded),
      applied_amount: toSqlFromPaise(0),
      created_by_user_id: userId,
    })
    .executeTakeFirstOrThrow();
  const id = Number(inserted.insertId);

  const acc = await accountIds(trx, orgId);
  const lines: DraftLine[] = [
    { accountId: requireAccount(acc, CODE.AP), debit: rounded, contactId: input.vendorId },
    { accountId: requireAccount(acc, CODE.PURCHASES), credit: input.amountPaise },
  ];

  // Only reverse credit that was actually claimed. On a blocked or reverse-
  // charge purchase the tax never went into the ITC pot, so taking it out would
  // create a credit balance from nothing.
  if (input.itcClaimed !== false) {
    if (totals.cgstPaise) lines.push({ accountId: requireAccount(acc, CODE.ITC_CGST), credit: totals.cgstPaise });
    if (totals.sgstPaise) lines.push({ accountId: requireAccount(acc, CODE.ITC_SGST), credit: totals.sgstPaise });
    if (totals.igstPaise) lines.push({ accountId: requireAccount(acc, CODE.ITC_IGST), credit: totals.igstPaise });
    if (totals.cessPaise) lines.push({ accountId: requireAccount(acc, CODE.ITC_CESS), credit: totals.cessPaise });
  } else if (totalTaxPaise(totals) > 0) {
    // Credit that was never claimed had been absorbed into the cost, so it
    // comes back out of the cost.
    lines.push({ accountId: requireAccount(acc, CODE.PURCHASES), credit: totalTaxPaise(totals) });
  }

  if (roundOff > 0) lines.push({ accountId: requireAccount(acc, CODE.ROUNDING), credit: roundOff });
  else if (roundOff < 0) lines.push({ accountId: requireAccount(acc, CODE.ROUNDING), debit: -roundOff });

  const entry = await postEntry(trx, {
    orgId,
    branchId: input.branchId,
    date: input.date,
    memo: `Vendor credit ${number}${bill ? ` against ${bill.internal_no}` : ''}`,
    sourceType: 'vendor_credit',
    sourceId: id,
    userId,
    module: 'purchases',
    lines,
  });

  await trx.updateTable('vendor_credits').set({ journal_entry_id: entry.id }).where('id', '=', id).execute();

  // Setting it against the bill is an allocation, not a second posting: the
  // entry above already reduced payables. This records which bill the reduction
  // belongs to, so the AP ageing and the control account keep agreeing.
  if (bill && input.applyImmediately !== false) {
    await trx
      .updateTable('bills')
      .set((eb) => ({ amount_paid: eb('amount_paid', '+', toSqlFromPaise(rounded)) }))
      .where('id', '=', bill.id)
      .execute();
    await trx
      .updateTable('vendor_credits')
      .set({ applied_amount: toSqlFromPaise(rounded), status: 'applied' })
      .where('id', '=', id)
      .execute();
    await settleBillIfPaid(trx, orgId, bill.id);
  }

  return { id, number, totalPaise: rounded, journalEntryId: entry.id };
}

/** Move a bill to 'paid' once nothing is left owing on it. */
async function settleBillIfPaid(trx: Trx, orgId: number, billId: number): Promise<void> {
  const b = await trx
    .selectFrom('bills').select(['id', 'status', 'total', 'amount_paid'])
    .where('id', '=', billId).where('org_id', '=', orgId).executeTakeFirst();
  if (!b || b.status === 'void' || b.status === 'draft') return;

  const balance = toPaiseFromSql(b.total) - toPaiseFromSql(b.amount_paid);
  const status = balance <= 0 ? 'paid' : 'partially_paid';
  if (b.status !== status) {
    await trx.updateTable('bills').set({ status }).where('id', '=', billId).execute();
  }
}

/**
 * A supplier returns money against a credit rather than setting it off.
 *
 *   Dr Bank                  the cash that came back
 *     Cr Accounts Payable    we no longer hold a credit with them
 */
export async function refundVendorCredit(
  trx: Trx,
  orgId: number,
  userId: number | null,
  creditId: number,
  input: { bankAccountId: number; date: string; amountPaise?: Paise; reference?: string | null },
): Promise<{ journalEntryId: number; refundedPaise: Paise }> {
  const vc = await trx
    .selectFrom('vendor_credits')
    .select(['id', 'number', 'branch_id', 'vendor_id', 'status', 'total', 'applied_amount'])
    .where('id', '=', creditId).where('org_id', '=', orgId).executeTakeFirst();
  if (!vc) throw notFound('That vendor credit does not exist.');
  if (vc.status === 'void') throw conflict('That vendor credit has been voided.');

  const unapplied = toPaiseFromSql(vc.total) - toPaiseFromSql(vc.applied_amount);
  const amount = input.amountPaise ?? unapplied;
  if (amount <= 0) throw badRequest('There is nothing left on this credit to refund.');
  if (amount > unapplied) {
    throw badRequest(
      `Only ${(unapplied / 100).toFixed(2)} is unapplied on ${vc.number}. ` +
        'The rest has already been set against bills.',
    );
  }

  const bank = await trx
    .selectFrom('bank_accounts').select(['id', 'name', 'ledger_account_id'])
    .where('id', '=', input.bankAccountId).where('org_id', '=', orgId).executeTakeFirst();
  if (!bank) throw notFound('That bank account does not exist.');

  const acc = await accountIds(trx, orgId);
  const entry = await postEntry(trx, {
    orgId,
    branchId: vc.branch_id,
    date: input.date,
    memo: `Refund received on vendor credit ${vc.number}${input.reference ? ` — ${input.reference}` : ''}`,
    sourceType: 'vendor_credit_refund',
    sourceId: creditId,
    userId,
    module: 'purchases',
    lines: [
      { accountId: bank.ledger_account_id, debit: amount },
      { accountId: requireAccount(acc, CODE.AP), credit: amount, contactId: vc.vendor_id },
    ],
  });

  await trx
    .updateTable('vendor_credits')
    .set({
      status: 'refunded',
      applied_amount: toSqlFromPaise(toPaiseFromSql(vc.applied_amount) + amount),
    })
    .where('id', '=', creditId)
    .execute();

  return { journalEntryId: entry.id, refundedPaise: amount };
}

/** Void a vendor credit: reverse its entry and put the payable back. */
export async function voidVendorCredit(
  trx: Trx,
  orgId: number,
  userId: number | null,
  creditId: number,
  reason?: string,
): Promise<void> {
  const vc = await trx
    .selectFrom('vendor_credits')
    .select(['id', 'number', 'status', 'journal_entry_id', 'against_bill_id', 'applied_amount'])
    .where('id', '=', creditId).where('org_id', '=', orgId).executeTakeFirst();
  if (!vc) throw notFound('That vendor credit does not exist.');
  if (vc.status === 'void') throw new ApiError(409, 'That vendor credit is already void.', 'conflict');
  if (vc.status === 'refunded') {
    throw conflict(
      `${vc.number} was refunded in cash. Voiding it would leave the receipt pointing at nothing.`,
    );
  }

  const why = voidReason(reason);
  if (vc.journal_entry_id) {
    await reverseEntry(trx, orgId, vc.journal_entry_id, {
      memo: `Void of vendor credit ${vc.number} — ${why}`,
      userId,
      module: 'purchases',
    });
  }

  const applied = toPaiseFromSql(vc.applied_amount);
  if (vc.against_bill_id && applied > 0) {
    await trx
      .updateTable('bills')
      .set((eb) => ({ amount_paid: eb('amount_paid', '-', toSqlFromPaise(applied)) }))
      .where('id', '=', vc.against_bill_id)
      .execute();
    await settleBillIfPaid(trx, orgId, vc.against_bill_id);
  }

  await trx
    .updateTable('vendor_credits')
    .set({ status: 'void', applied_amount: toSqlFromPaise(0), ...voidStamp(why, userId) })
    .where('id', '=', creditId)
    .execute();
}
