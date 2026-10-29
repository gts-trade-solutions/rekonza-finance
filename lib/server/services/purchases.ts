import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Purchase services: bills and expenses.
//
// The buy side carries three obligations the sell side does not, and each one
// changes the journal entry rather than just a field on the document:
//
//   * Input tax credit. GST paid on a purchase is normally an asset — money the
//     government owes back. But credit on some things is blocked outright under
//     Section 17(5), and on those the tax is not an asset at all; it becomes
//     part of what the thing cost. Claiming it anyway is an assessment finding.
//
//   * Reverse charge. On certain supplies the buyer owes the GST instead of the
//     seller. The bill then posts both sides — a liability for the tax we owe,
//     and the credit we can claim against it — so both appear in the return,
//     which is what the law wants. The liability goes to its own ledger, not to
//     output GST: reverse-charge tax must be paid in cash (Section 49(4)), so
//     input credit sitting in the same ledger would make it look settled.
//
//   * TDS. Tax deducted at source is withheld from the vendor and paid to the
//     government under a section code. The vendor is credited the full amount
//     and paid less; the difference is a liability, not a discount.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Trx } from '../db';
import type { Paise, SupplyType } from '../../types';
import { computeLineTax, hsnRateOn, sumTax, totalTaxPaise } from '../../tax/gst';
import { computeTds } from '../../tax/tds';
import { hsnRateHistory, tdsRateOn } from '../tax/rates';
import { certificateRate } from '../tax/tds-certificates';
import { checkCashPayment } from './guards';
import { stockPurchaseAccount } from './stock-ledger';
import { voidReason, voidStamp } from './void-reason';
import { registrationOn } from './statutory';
import { findOrCreateBatch, type BatchInput } from './batches';
import { checkSerials, recordSerials } from './serials';
import { checkGodown } from './godowns';
import { toPaiseFromSql, toSqlFromPaise } from '../money-sql';
import { assertApproved, ruleFor, submitForApproval } from './approvals';
import { allocateOrgNumber, postEntry, reverseEntry, type DraftLine } from '../ledger/posting';
import { CODE, accountIds, requireAccount } from '../ledger/chart-of-accounts';
import { ApiError, badRequest, notFound } from '../http';
import { atRate, foreignOf, fyLabelFor } from './sales';

export interface BillLineInput {
  itemId?: number | null;
  accountId?: number | null;
  description?: string | null;
  hsnSac?: string | null;
  qty: number;
  uqc?: string | null;
  /** Omit to use the item's purchase price. Required when there is no item. */
  ratePaise?: Paise;
  discountPct?: number;
  gstRatePct?: number;
  /** Omit to use the cess rate on the line's HSN code. */
  cessRatePct?: number;
  itcEligibility?: 'eligible' | 'ineligible' | 'capital_goods';
  /** A batch-tracked item: the batch bought, with the dates on the pack. */
  batch?: BatchInput | null;
  /** A serial-tracked item: the number of each piece, one per unit. */
  serials?: string[] | null;
}

export interface CreateBillInput {
  branchId: number;
  /** The godown the goods leave or enter; none is the branch's main one. */
  warehouseId?: number | null;
  /** The cost centre its income or expense belongs to. */
  costCentreId?: number | null;
  vendorId: number;
  vendorInvoiceNo: string;
  date: string;
  dueDate: string;
  lines: BillLineInput[];
  isRcm?: boolean;
  tdsSectionOverride?: string | null;
  notes?: string | null;
  sourcePoId?: number | null;
  sourceGrnId?: number | null;
  /** Index for index with `lines`: the order or receipt line each one came from. */
  lineSources?: ({ type: 'purchase_order' | 'goods_receipt'; id: number } | null)[];
  /** Priced in another currency (minor units), booked in rupees at `exchangeRate`. */
  currency?: string;
  exchangeRate?: number;
  /** Set by whoever raised the bill from an order or receipt; see three-way match. */
  match?: { status: 'matched' | 'exception'; note: string | null } | null;
  /** As on an invoice: a bill an approval rule catches is saved as a draft submitted for approval. */
  holdForApproval?: boolean;
  status?: 'draft' | 'open';
}

/**
 * What this vendor has been billed so far this financial year.
 *
 * TDS sections have annual thresholds — 194C is ₹1,00,000 across the year, not
 * per bill — so the deduction on today's bill depends on everything already
 * billed. Computing it from one invoice in isolation under-deducts, and the
 * shortfall is recovered from us with interest, not from the vendor.
 */
export async function vendorFyTaxable(
  trx: Trx,
  orgId: number,
  vendorId: number,
  onDate: string,
): Promise<Paise> {
  const fyStartYear = Number(onDate.slice(0, 4)) - (Number(onDate.slice(5, 7)) < 4 ? 1 : 0);
  const from = `${fyStartYear}-04-01`;
  const to = `${fyStartYear + 1}-03-31`;

  const { rows } = await sql<{ total: string }>`
    SELECT COALESCE(SUM(subtotal), 0) AS total
    FROM bills
    WHERE org_id = ${orgId} AND vendor_id = ${vendorId}
      AND status <> 'void' AND bill_date BETWEEN ${from} AND ${to}
  `.execute(trx);

  return toPaiseFromSql(rows[0]?.total ?? '0');
}

export async function createBill(
  trx: Trx,
  orgId: number,
  userId: number | null,
  input: CreateBillInput,
): Promise<{ id: number; internalNo: string; totalPaise: Paise; journalEntryId: number | null; heldForApproval: boolean; warnings: string[] }> {
  if (!input.lines.length) throw badRequest('A bill needs at least one line.');
  const fx = foreignOf(input);
  let fcSubtotal = 0;
  if (fx) {
    for (const l of input.lines) {
      if (l.ratePaise === undefined) throw badRequest('Give every line a price in the bill currency.');
      fcSubtotal += computeLineTax({ ratePaise: l.ratePaise, qty: l.qty, discountPct: l.discountPct ?? 0, gstRatePct: 0, supplyType: 'nil_or_exempt' }).taxable;
    }
    input = { ...input, lines: input.lines.map((l) => ({ ...l, ratePaise: atRate(l.ratePaise!, fx.rate) })) };
  }

  const branch = await trx
    .selectFrom('branches').select(['id', 'state_code'])
    .where('id', '=', input.branchId).where('org_id', '=', orgId).executeTakeFirst();
  if (!branch) throw notFound('That branch does not exist.');

  const vendor = await trx
    .selectFrom('contacts')
    .select(['id', 'display_name', 'state_code', 'gst_treatment', 'gstin', 'pan', 'pan_status', 'tds_section'])
    .where('id', '=', input.vendorId).where('org_id', '=', orgId).executeTakeFirst();
  if (!vendor) throw notFound('That vendor does not exist.');

  // A composition dealer cannot charge GST, so there is no tax on the bill and
  // nothing to claim — treating it as taxable would invent a credit.
  const isComposition = vendor.gst_treatment === 'registered_composition';
  const supplyType: SupplyType = isComposition
    ? 'nil_or_exempt'
    : vendor.state_code === branch.state_code
      ? 'intra'
      : 'inter';

  const itemIds = input.lines.map((l) => l.itemId).filter((x): x is number => !!x);
  const items = itemIds.length
    ? await trx
        .selectFrom('items')
        .select(['id', 'name', 'hsn_sac', 'uqc', 'gst_rate_pct', 'purchase_price', 'purchase_account_id'])
        .where('org_id', '=', orgId).where('id', 'in', itemIds).execute()
    : [];
  const itemById = new Map(items.map((i) => [i.id, i]));

  // A supplier's bill can carry any code, approved by us or not — it is their
  // document — so the cess rate is looked up rather than validated.
  const lineCodes = input.lines
    .map((l) => l.hsnSac ?? (l.itemId ? itemById.get(l.itemId)?.hsn_sac : null))
    .filter((c): c is string => !!c);
  const [codeRows, history] = await Promise.all([
    lineCodes.length
      ? trx
          .selectFrom('hsn_codes').select(['code', 'gst_rate_pct', 'cess_rate_pct'])
          .where('org_id', '=', orgId).where('code', 'in', lineCodes).execute()
      : Promise.resolve([]),
    hsnRateHistory(trx, orgId),
  ]);
  const codeBy = new Map(codeRows.map((h) => [h.code, {
    gstRatePct: Number(h.gst_rate_pct),
    cessRatePct: Number(h.cess_rate_pct),
    rates: history.get(h.code),
  }]));

  // Only a regular registration takes input credit. A composition dealer, or a
  // business not registered, carries the tax as part of what it paid.
  const creditable = (await registrationOn(trx, orgId, input.date)) === 'regular';

  const computed = input.lines.map((l, idx) => {
    const item = l.itemId ? itemById.get(l.itemId) : undefined;
    if (l.itemId && !item) throw badRequest(`Line ${idx + 1} refers to an item that does not exist.`);
    if (l.qty <= 0) throw badRequest(`Line ${idx + 1} needs a quantity above zero.`);

    const ratePaise = l.ratePaise ?? (item ? toPaiseFromSql(item.purchase_price) : undefined);
    if (ratePaise === undefined) {
      throw badRequest(`Line ${idx + 1} needs a rate — there is no item to take one from.`);
    }

    const hsnSac = l.hsnSac ?? item?.hsn_sac ?? null;
    // An unstated rate is the one in force on the bill's date for its code,
    // when the code has dated rates, and the item's own rate otherwise.
    const code = hsnSac ? codeBy.get(hsnSac) : undefined;
    const dated = code?.rates?.length ? hsnRateOn(code, input.date) : null;
    const gstRatePct = isComposition ? 0 : (l.gstRatePct ?? dated?.gstRatePct
      ?? (item ? Number(item.gst_rate_pct) : code?.gstRatePct ?? 18));
    const cessRatePct = isComposition ? 0 : (l.cessRatePct ?? (code ? hsnRateOn(code, input.date).cessRatePct : 0));
    const { taxable, tax, total } = computeLineTax({
      ratePaise,
      qty: l.qty,
      discountPct: l.discountPct ?? 0,
      gstRatePct,
      cessRatePct,
      supplyType,
    });

    return {
      itemId: l.itemId ?? null,
      accountId: l.accountId ?? item?.purchase_account_id ?? null,
      description: l.description ?? item?.name ?? 'Purchase',
      hsnSac,
      qty: l.qty,
      uqc: l.uqc ?? item?.uqc ?? 'NOS',
      ratePaise,
      discountPct: l.discountPct ?? 0,
      gstRatePct,
      cessRatePct,
      taxable,
      tax,
      total,
      itcEligibility: creditable ? l.itcEligibility ?? 'eligible' : 'ineligible',
    };
  });

  const tax = sumTax(computed.map((c) => c.tax));
  const subtotal = tax.taxablePaise;

  const sectionCode = input.tdsSectionOverride ?? vendor.tds_section ?? undefined;
  // A lower-deduction certificate covering this bill sets the rate, while its
  // amount lasts.
  const lower = await certificateRate(trx, orgId, input.vendorId, sectionCode, input.date, subtotal);
  // The rate in force on the bill's own date, from the book's rate table.
  const tds = computeTds({
    rate: sectionCode ? await tdsRateOn(trx, orgId, sectionCode, input.date) : null,
    // No PAN means the higher no-PAN rate; the PAN's fourth letter decides
    // whether an individual's lower contractor rate applies. A PAN found
    // inoperative (not linked to Aadhaar) counts as no PAN.
    pan: vendor.pan_status === 'inoperative' ? null : vendor.pan,
    billTaxable: subtotal,
    fyPaidSoFar: await vendorFyTaxable(trx, orgId, input.vendorId, input.date),
    lowerRatePct: lower.ratePct,
  });

  // Under reverse charge the supplier does not charge tax, so the payable is
  // the taxable value alone; we account for the GST separately.
  const grossPayable = subtotal + (input.isRcm ? 0 : totalTaxPaise(tax));
  const totalPayable = grossPayable - tds.tdsPaise;

  // Our own reference for the vendor's bill, unique across the organisation
  // (uq_bill_internal). The vendor's own number is theirs and may repeat.
  const held = (input.status ?? 'open') !== 'draft' && !!input.holdForApproval
    && !!(await ruleFor(trx, orgId, 'bill', totalPayable));
  const status = held ? 'draft' : (input.status ?? 'open');
  const internalNo = await allocateOrgNumber(trx, orgId, 'BILL', fyLabelFor(input.date), 'BILL');
  // Reverse charge on a supply from someone without a GSTIN (unregistered, or
  // abroad) needs the buyer's own invoice for it: s.31(3)(f), Rule 47A.
  const selfInvoiceNo = input.isRcm && !vendor.gstin
    ? await allocateOrgNumber(trx, orgId, 'RCM', fyLabelFor(input.date), 'RCM')
    : null;

  const inserted = await trx
    .insertInto('bills')
    .values({
      org_id: orgId,
      branch_id: input.branchId,
      cost_centre_id: input.costCentreId ?? null,
      warehouse_id: await checkGodown(trx, orgId, input.branchId, input.warehouseId),
      internal_no: internalNo,
      vendor_invoice_no: input.vendorInvoiceNo,
      vendor_id: input.vendorId,
      bill_date: input.date,
      due_date: input.dueDate,
      place_of_supply: branch.state_code,
      supply_type: supplyType,
      status,
      is_rcm: input.isRcm ? 1 : 0,
      self_invoice_no: selfInvoiceNo,
      subtotal: toSqlFromPaise(subtotal),
      cgst: toSqlFromPaise(tax.cgstPaise),
      sgst: toSqlFromPaise(tax.sgstPaise),
      igst: toSqlFromPaise(tax.igstPaise),
      cess: toSqlFromPaise(tax.cessPaise),
      tds_amount: toSqlFromPaise(tds.tdsPaise),
      tds_section: tds.applies ? (sectionCode ?? null) : null,
      tds_rate_pct: tds.applies ? String(tds.ratePct) : null,
      tds_lower_cert_id: tds.applies && lower.ratePct !== undefined ? lower.cert!.id : null,
      round_off: toSqlFromPaise(0),
      total: toSqlFromPaise(totalPayable),
      amount_paid: toSqlFromPaise(0),
      notes: input.notes ?? null,
      source_po_id: input.sourcePoId ?? null,
      source_grn_id: input.sourceGrnId ?? null,
      match_status: input.match?.status ?? 'not_required',
      match_note: input.match?.note ?? null,
      created_by_user_id: userId,
    })
    .executeTakeFirstOrThrow();
  const billId = Number(inserted.insertId);
  // A batch-tracked item names its batch on every purchase.
  const trackedBatches = new Set((await trx.selectFrom('items').select('id').where('org_id', '=', orgId)
    .where('track_batches', '=', 1).where('id', 'in', [0, ...input.lines.map((l) => l.itemId ?? 0)]).execute()).map((r) => r.id));
  const batchIds: (number | null)[] = [];
  for (const l of input.lines) {
    if (!l.itemId || !trackedBatches.has(l.itemId)) { batchIds.push(null); continue; }
    if (!l.batch?.batchNo?.trim()) throw badRequest('Give the batch number for each batch-tracked item.');
    batchIds.push(await findOrCreateBatch(trx, orgId, l.itemId, l.batch));
  }
  if (fx) {
    await trx.updateTable('bills').set({
      currency: fx.currency, exchange_rate: String(fx.rate), fc_subtotal: toSqlFromPaise(fcSubtotal),
      fc_total: toSqlFromPaise(fcSubtotal + Math.round((totalPayable - subtotal) / fx.rate)),
    }).where('id', '=', billId).execute();
  }

  await trx
    .insertInto('bill_lines')
    .values(
      computed.map((c, i) => ({
        org_id: orgId,
        bill_id: billId,
        source_line_type: input.lineSources?.[i]?.type ?? null,
        source_line_id: input.lineSources?.[i]?.id ?? null,
        line_no: i + 1,
        item_id: c.itemId,
        account_id: c.accountId,
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
        itc_eligibility: c.itcEligibility,
      })),
    )
    .execute();

  // The numbered pieces coming in. Goods that came on a receipt note were
  // numbered there; the bill only pays for them.
  const warnings: string[] = [];
  const lineIds = (await trx.selectFrom('bill_lines').select('id').where('bill_id', '=', billId).orderBy('line_no').execute()).map((r) => r.id);
  await recordSerials(trx, orgId, { type: 'bill', id: billId }, 1,
    input.lines.flatMap((l, i) => (input.lineSources?.[i]?.type === 'goods_receipt' ? [] : [{ lineId: lineIds[i] ?? null, itemId: l.itemId, qty: l.qty, serials: l.serials }])),
    { check: false, warnings: status !== 'draft' ? warnings : undefined });

  let journalEntryId: number | null = null;
  if (status !== 'draft') {
    journalEntryId = await postBill(trx, orgId, userId, billId);
  }
  if (held) await submitForApproval(trx, orgId, userId, 'bill', billId);

  return { id: billId, internalNo, totalPaise: totalPayable, journalEntryId, heldForApproval: held, warnings };
}

/** Build and post the bill's journal entry. */
export async function postBill(
  trx: Trx,
  orgId: number,
  userId: number | null,
  billId: number,
): Promise<number> {
  const bill = await trx
    .selectFrom('bills').selectAll()
    .where('id', '=', billId).where('org_id', '=', orgId).executeTakeFirst();
  if (!bill) throw notFound('Bill not found.');
  if (bill.journal_entry_id) return bill.journal_entry_id;
  // Maker and checker: a rule may want someone else to approve it first.
  await assertApproved(trx, orgId, 'bill', { ...bill, number: bill.internal_no });
  // A numbered piece cannot arrive twice.
  await checkSerials(trx, orgId, { type: 'bill', id: billId });

  const lines = await trx
    .selectFrom('bill_lines').selectAll().where('bill_id', '=', billId).orderBy('line_no').execute();

  const acc = await accountIds(trx, orgId);
  const p = toPaiseFromSql;
  const isRcm = !!bill.is_rcm;
  const draft: DraftLine[] = [];

  // Credit on capital goods is as claimable as on inputs (tracked under Rule 43);
  // only blocked (s.17(5)) and composition purchases carry their tax as cost.
  const claimable = (l: { itc_eligibility: string }) => l.itc_eligibility === 'eligible' || l.itc_eligibility === 'capital_goods';

  // On perpetual inventory a stock line goes to Inventory, not to an expense (stock-ledger.ts).
  const stock = await stockPurchaseAccount(trx, orgId, String(bill.bill_date).slice(0, 10), lines.map((l) => l.item_id));
  for (const l of lines) {
    const expenseAccount = stock && l.item_id && stock.items.has(l.item_id)
      ? stock.accountId
      : l.account_id ?? requireAccount(acc, CODE.PURCHASES);
    const lineTax = p(l.cgst) + p(l.sgst) + p(l.igst) + p(l.cess);

    if (claimable(l) && lineTax > 0 && !isRcm) {
      // Tax is recoverable, so it is an asset and stays out of the cost.
      draft.push({ accountId: expenseAccount, debit: p(l.taxable), description: l.description });
      if (p(l.cgst)) draft.push({ accountId: requireAccount(acc, CODE.ITC_CGST), debit: p(l.cgst) });
      if (p(l.sgst)) draft.push({ accountId: requireAccount(acc, CODE.ITC_SGST), debit: p(l.sgst) });
      if (p(l.igst)) draft.push({ accountId: requireAccount(acc, CODE.ITC_IGST), debit: p(l.igst) });
      if (p(l.cess)) draft.push({ accountId: requireAccount(acc, CODE.ITC_CESS), debit: p(l.cess) });
    } else {
      // Blocked credit, composition purchase, or reverse charge: the tax is not
      // recoverable here, so it is part of what the purchase cost. Reverse
      // charge on an eligible line is the exception: its credit is taken below.
      draft.push({
        accountId: expenseAccount,
        debit: p(l.taxable) + (isRcm && claimable(l) ? 0 : lineTax),
        description: l.description,
      });
    }
  }

  const tdsPaise = p(bill.tds_amount);
  if (tdsPaise > 0) {
    draft.push({
      accountId: requireAccount(acc, CODE.TDS_PAYABLE),
      credit: tdsPaise,
      description: `TDS ${bill.tds_section ?? ''} withheld`.trim(),
    });
  }

  draft.push({
    accountId: requireAccount(acc, CODE.AP),
    credit: p(bill.total),
    contactId: bill.vendor_id,
    description: `${bill.internal_no} — ${bill.vendor_invoice_no}`,
  });

  // Reverse charge posts both halves: the liability we now owe, and the credit
  // we may claim against it. Both appear in the return. The liability is kept
  // apart from output GST because it has to be paid in cash: netting it against
  // input credit in one ledger would show tax as settled that is still due.
  // Credit is taken only on lines that are eligible for it: blocked items, and
  // every line of a composition dealer, carry the tax as cost instead (above).
  if (isRcm) {
    const eligible = lines.filter(claimable);
    const sum = (k: 'cgst' | 'sgst' | 'igst' | 'cess') => eligible.reduce((t, l) => t + p(l[k]), 0);
    const heads: [string, Paise][] = [
      [CODE.ITC_CGST, sum('cgst')],
      [CODE.ITC_SGST, sum('sgst')],
      [CODE.ITC_IGST, sum('igst')],
      [CODE.ITC_CESS, sum('cess')],
    ];
    for (const [itcCode, amount] of heads) {
      if (amount <= 0) continue;
      draft.push({ accountId: requireAccount(acc, itcCode), debit: amount, description: 'Reverse charge — input credit' });
    }
    const owed = lines.reduce((t, l) => t + p(l.cgst) + p(l.sgst) + p(l.igst) + p(l.cess), 0);
    if (owed > 0) {
      draft.push({ accountId: requireAccount(acc, CODE.RCM_PAYABLE), credit: owed, description: 'Reverse charge — tax payable' });
    }
  }

  const entry = await postEntry(trx, {
    orgId,
    branchId: bill.branch_id,
    date: bill.bill_date,
    memo: `Bill ${bill.internal_no} (${bill.vendor_invoice_no})`,
    sourceType: 'bill',
    sourceId: billId,
    userId,
    module: 'purchases',
    costCentreId: bill.cost_centre_id,
    lines: draft,
  });

  await trx
    .updateTable('bills')
    .set({ journal_entry_id: entry.id, status: bill.status === 'draft' ? 'open' : bill.status })
    .where('id', '=', billId)
    .execute();

  return entry.id;
}

export async function voidBill(
  trx: Trx,
  orgId: number,
  userId: number | null,
  billId: number,
  reason?: string,
): Promise<void> {
  const bill = await trx
    .selectFrom('bills').select(['id', 'internal_no', 'status', 'journal_entry_id', 'amount_paid'])
    .where('id', '=', billId).where('org_id', '=', orgId).executeTakeFirst();
  if (!bill) throw notFound('Bill not found.');
  if (bill.status === 'void') throw new ApiError(409, 'That bill is already void.', 'conflict');
  if (toPaiseFromSql(bill.amount_paid) > 0) {
    throw new ApiError(
      409,
      `Bill ${bill.internal_no} has payments against it. Remove them first, or raise a vendor credit — ` +
        'voiding it would leave the payment pointing at nothing.',
      'has_payments',
    );
  }

  const why = voidReason(reason);
  if (bill.journal_entry_id) {
    await reverseEntry(trx, orgId, bill.journal_entry_id, {
      memo: `Void of bill ${bill.internal_no} — ${why}`,
      userId,
      module: 'purchases',
    });
  }

  await trx
    .updateTable('bills').set({ status: 'void', ...voidStamp(why, userId) })
    .where('id', '=', billId).execute();
}

// ── Expenses ─────────────────────────────────────────────────────────────────

export interface CreateExpenseInput {
  branchId: number;
  /** The cost centre its income or expense belongs to. */
  costCentreId?: number | null;
  date: string;
  accountId: number;
  paidThroughBankAccountId: number;
  amountPaise: Paise;
  gstRatePct?: number;
  vendorId?: number | null;
  itcEligibility?: 'eligible' | 'ineligible' | 'capital_goods';
  isBillable?: boolean;
  billableCustomerId?: number | null;
  reference?: string | null;
  notes?: string | null;
}

/**
 * An expense is money already spent, with no vendor bill to settle later.
 *
 *   Dr Expense account   what it cost
 *   Dr Input GST         if the credit is claimable
 *     Cr Bank or card    the money that left
 *
 * There is no payable in between, which is the whole difference from a bill.
 */
export async function createExpense(
  trx: Trx,
  orgId: number,
  userId: number | null,
  input: CreateExpenseInput,
): Promise<{ id: number; number: string; totalPaise: Paise; journalEntryId: number; warnings?: string[] }> {
  if (input.amountPaise <= 0) throw badRequest('An expense needs an amount above zero.');

  const bank = await trx
    .selectFrom('bank_accounts').select(['id', 'name', 'ledger_account_id', 'kind'])
    .where('id', '=', input.paidThroughBankAccountId).where('org_id', '=', orgId).executeTakeFirst();
  if (!bank) throw notFound('That account does not exist.');

  // Section 40A(3): an expense paid in cash above the day's limit is not deductible.
  const warnings: string[] = [];
  if (bank.kind === 'cash') {
    await checkCashPayment(trx, orgId, input.vendorId ?? null, input.date, input.amountPaise, warnings);
  }

  const expenseAccount = await trx
    .selectFrom('accounts').select(['id', 'name'])
    .where('id', '=', input.accountId).where('org_id', '=', orgId).executeTakeFirst();
  if (!expenseAccount) throw notFound('That expense account does not exist.');

  const rate = input.gstRatePct ?? 0;
  // The amount entered is what was actually paid, so any GST inside it is
  // extracted rather than added — a ₹1,180 fuel bill at 18% is ₹1,000 of fuel.
  const taxable = rate > 0 ? Math.round((input.amountPaise * 100) / (100 + rate)) : input.amountPaise;
  const taxTotal = input.amountPaise - taxable;

  const branch = await trx
    .selectFrom('branches').select(['state_code'])
    .where('id', '=', input.branchId).where('org_id', '=', orgId).executeTakeFirst();
  if (!branch) throw notFound('That branch does not exist.');

  // Expenses are paid where we are, so the tax splits between centre and state.
  const half = Math.round(taxTotal / 2);
  const cgst = half;
  const sgst = taxTotal - half;

  const number = await allocateOrgNumber(trx, orgId, 'EXP', fyLabelFor(input.date), 'EXP');

  const itcEligibility = (await registrationOn(trx, orgId, input.date)) === 'regular' ? input.itcEligibility ?? 'eligible' : 'ineligible';
  const eligible = itcEligibility === 'eligible' || itcEligibility === 'capital_goods';

  const inserted = await trx
    .insertInto('expenses')
    .values({
      org_id: orgId,
      branch_id: input.branchId,
      cost_centre_id: input.costCentreId ?? null,
      number,
      expense_date: input.date,
      account_id: input.accountId,
      vendor_id: input.vendorId ?? null,
      paid_through_bank_account_id: input.paidThroughBankAccountId,
      amount: toSqlFromPaise(taxable),
      gst_rate_pct: rate,
      cgst: toSqlFromPaise(eligible ? cgst : 0),
      sgst: toSqlFromPaise(eligible ? sgst : 0),
      igst: toSqlFromPaise(0),
      total: toSqlFromPaise(input.amountPaise),
      itc_eligibility: itcEligibility,
      is_billable: input.isBillable ? 1 : 0,
      billable_customer_id: input.billableCustomerId ?? null,
      reference: input.reference ?? null,
      notes: input.notes ?? null,
      status: 'recorded',
      created_by_user_id: userId,
    })
    .executeTakeFirstOrThrow();
  const expenseId = Number(inserted.insertId);

  const acc = await accountIds(trx, orgId);
  const draft: DraftLine[] = [];

  if (eligible && taxTotal > 0) {
    draft.push({ accountId: input.accountId, debit: taxable, description: input.notes ?? expenseAccount.name });
    if (cgst) draft.push({ accountId: requireAccount(acc, CODE.ITC_CGST), debit: cgst });
    if (sgst) draft.push({ accountId: requireAccount(acc, CODE.ITC_SGST), debit: sgst });
  } else {
    // Credit not claimable, so the tax is part of the cost.
    draft.push({
      accountId: input.accountId,
      debit: input.amountPaise,
      description: input.notes ?? expenseAccount.name,
    });
  }

  draft.push({
    accountId: bank.ledger_account_id,
    credit: input.amountPaise,
    contactId: input.vendorId ?? null,
    description: `Paid from ${bank.name}`,
  });

  const entry = await postEntry(trx, {
    orgId,
    branchId: input.branchId,
    date: input.date,
    memo: `Expense ${number} — ${expenseAccount.name}`,
    sourceType: 'expense',
    sourceId: expenseId,
    costCentreId: input.costCentreId ?? null,
    userId,
    module: 'purchases',
    lines: draft,
  });

  await trx
    .updateTable('expenses').set({ journal_entry_id: entry.id })
    .where('id', '=', expenseId).execute();

  return { id: expenseId, number, totalPaise: input.amountPaise, journalEntryId: entry.id, warnings };
}
