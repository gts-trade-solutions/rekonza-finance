import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Fixed assets.
//
// The register says what the business owns, where it is and who has it. Two
// books of depreciation run over it:
//
//   * The Companies Act book (Schedule II) is posted. Each asset is written
//     down over its useful life, by straight line or written-down value, day
//     by day from the day it was put to use until the day before it leaves.
//     Runs are made for a period at a time and post one entry per branch:
//       Dr Depreciation  Cr Accumulated Depreciation
//
//   * The Income-tax book is calculated, never posted: blocks of assets at
//     prescribed rates, half the rate for an asset put to use for less than
//     180 days in the year, sale proceeds out of the block (sections 32, 43(6)
//     and 50 of the 1961 Act, carried into the 2025 Act).
//
// An asset being built or installed sits in Capital Work-in-Progress and is
// not depreciated until it is put to use; then its cost moves to its class's
// ledger. A sale is a real invoice, so it reaches GSTR-1 and the e-invoice
// register like any supply — but its value is credited to Asset Disposal
// Clearing, not Sales, and the disposal clears that against the asset's cost
// and the depreciation charged on it, the difference being the gain or loss.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import { db, transaction, type Executor, type Trx } from '../db';
import type { Paise, RoleName } from '../../types';
import { toPaiseFromSql, toSqlFromPaise } from '../money-sql';
import { nextSequence, postEntry, reverseEntry, type DraftLine } from '../ledger/posting';
import { CODE, accountIds, requireAccount } from '../ledger/chart-of-accounts';
import { badRequest, conflict, forbidden, notFound } from '../http';
import { booksStartDate } from './opening-balances';
import { createInvoice, voidInvoice } from './sales';
import { bankLineMatched } from './doc-delete';
import { getPolicies } from './org-settings';
import { dayLabel } from '../../date-range';

// ── Dates ────────────────────────────────────────────────────────────────────

const DAY = 86_400_000;
const t = (d: string) => Date.parse(`${d}T00:00:00Z`);
export const addDays = (d: string, n: number) => new Date(t(d) + n * DAY).toISOString().slice(0, 10);
/** Days from a to b, both included. */
export const daysBetween = (a: string, b: string) => Math.round((t(b) - t(a)) / DAY) + 1;
const fyStartYear = (d: string) => Number(d.slice(0, 4)) - (Number(d.slice(5, 7)) < 4 ? 1 : 0);
const maxDate = (...ds: (string | null | undefined)[]) => ds.filter(Boolean).sort().pop()!;

// ── The arithmetic ───────────────────────────────────────────────────────────

export interface AssetBasis {
  costPaise: Paise;
  residualPaise: Paise;
  lifeYears: number;
  method: 'slm' | 'wdv';
  putToUseOn: string;
}

/**
 * Schedule II depreciation on one asset for the days from `from` to `to`.
 *
 * Straight line spreads cost less residual value evenly over the useful life.
 * Written-down value applies the rate that brings cost down to the residual
 * value at the end of the life — 1 − (residual ÷ cost)^(1 ÷ life) — to what is
 * left of the cost. Both are pro-rated by days, and neither ever takes the
 * asset below its residual value.
 */
export function depreciationFor(a: AssetBasis, from: string, to: string, accumulatedBefore: Paise): { days: number; amountPaise: Paise } {
  const start = maxDate(from, a.putToUseOn);
  if (to < start) return { days: 0, amountPaise: 0 };
  const days = daysBetween(start, to);
  const depreciable = a.costPaise - a.residualPaise;
  const remaining = depreciable - accumulatedBefore;
  if (remaining <= 0 || a.lifeYears <= 0) return { days, amountPaise: 0 };
  let amount: number;
  if (a.method === 'slm') {
    amount = (depreciable / a.lifeYears) * (days / 365);
  } else {
    const rate = 1 - Math.pow(Math.max(a.residualPaise, 1) / a.costPaise, 1 / a.lifeYears);
    amount = (a.costPaise - accumulatedBefore) * rate * (days / 365);
  }
  return { days, amountPaise: Math.min(Math.round(amount), remaining) };
}

/**
 * GST on selling a capital good on which credit was taken (section 18(6),
 * rule 44(6)): the higher of the tax on the sale value, and the credit taken
 * reduced by five percentage points for every quarter, or part of one, since
 * the purchase invoice.
 */
export function minimumGstOnSale(itcClaimedPaise: Paise, boughtOn: string, soldOn: string): Paise {
  if (itcClaimedPaise <= 0) return 0;
  const [y1, m1, d1] = boughtOn.split('-').map(Number);
  const [y2, m2, d2] = soldOn.split('-').map(Number);
  // Whole months between the two dates, a part month counting as one…
  const months = (y2 - y1) * 12 + (m2 - m1) + (d2 > d1 ? 1 : 0);
  // …and a part quarter counting as a quarter, the first one included.
  const quarters = Math.max(1, Math.ceil(months / 3));
  return Math.max(0, Math.round(itcClaimedPaise * (1 - 0.05 * quarters)));
}

// ── Classes ──────────────────────────────────────────────────────────────────

const DEFAULT_CLASSES = [
  { name: 'Plant & Machinery', code: CODE.PLANT_MACHINERY, life: 15, block: 'Plant & machinery (general)', rate: 15 },
  { name: 'Computers & Peripherals', code: CODE.COMPUTERS, life: 3, block: 'Computers and software', rate: 40 },
  { name: 'Vehicles', code: CODE.VEHICLES, life: 8, block: 'Motor cars (non-commercial)', rate: 15 },
  { name: 'Buildings', code: CODE.BUILDINGS, life: 30, block: 'Buildings (non-residential)', rate: 10 },
  { name: 'Furniture & Fittings', code: CODE.FIXED_ASSETS, life: 10, block: 'Furniture and fittings', rate: 10 },
];

/** A book made after the classes were introduced gets the usual ones on first use. */
export async function ensureAssetClasses(trx: Executor, orgId: number) {
  const have = await trx.selectFrom('asset_classes').select('id').where('org_id', '=', orgId).limit(1).executeTakeFirst();
  if (have) return;
  const acc = await accountIds(trx, orgId);
  const rows = DEFAULT_CLASSES.filter((c) => acc[c.code]).map((c) => ({
    org_id: orgId, name: c.name, account_id: acc[c.code], method: 'slm' as const,
    useful_life_years: String(c.life), residual_pct: '5', it_block: c.block, it_rate_pct: String(c.rate),
  }));
  if (rows.length) await trx.insertInto('asset_classes').values(rows).execute();
}

export interface AssetClass {
  id: string; name: string; accountId: string; accountName: string; method: 'slm' | 'wdv';
  usefulLifeYears: number; residualPct: number; itBlock: string; itRatePct: number; isIntangible: boolean;
}

export async function listAssetClasses(ex: Executor, orgId: number): Promise<AssetClass[]> {
  const rows = await ex.selectFrom('asset_classes as c').innerJoin('accounts as a', 'a.id', 'c.account_id')
    .select(['c.id', 'c.name', 'c.account_id', 'a.name as account_name', 'c.method', 'c.useful_life_years',
      'c.residual_pct', 'c.it_block', 'c.it_rate_pct', 'c.is_intangible'])
    .where('c.org_id', '=', orgId).orderBy('c.name').execute();
  return rows.map((r) => ({
    id: String(r.id), name: r.name, accountId: String(r.account_id), accountName: r.account_name, method: r.method,
    usefulLifeYears: Number(r.useful_life_years), residualPct: Number(r.residual_pct), itBlock: r.it_block,
    itRatePct: Number(r.it_rate_pct), isIntangible: !!r.is_intangible,
  }));
}

export interface AssetClassInput {
  id?: number;
  name: string;
  accountId: number;
  method: 'slm' | 'wdv';
  usefulLifeYears: number;
  residualPct: number;
  itBlock: string;
  itRatePct: number;
  isIntangible?: boolean;
}

export async function saveAssetClass(trx: Trx, orgId: number, input: AssetClassInput) {
  const account = await trx.selectFrom('accounts').select(['id', 'subtype', 'type'])
    .where('id', '=', input.accountId).where('org_id', '=', orgId).executeTakeFirst();
  if (!account || account.type !== 'asset' || !['fixed_asset', 'intangible'].includes(account.subtype ?? '')) {
    throw badRequest('A class of assets is kept in a fixed-asset ledger. Pick one, or add it in the chart of accounts first.');
  }
  if (!(input.usefulLifeYears > 0 && input.usefulLifeYears <= 100)) throw badRequest('Give a useful life between a month and 100 years.');
  if (!(input.residualPct >= 0 && input.residualPct < 100)) throw badRequest('Residual value is a percentage of cost below 100.');
  if (!(input.itRatePct >= 0 && input.itRatePct <= 100)) throw badRequest('Give the Income-tax rate for the block.');
  const values = {
    name: input.name.trim(), account_id: input.accountId, method: input.method,
    useful_life_years: String(input.usefulLifeYears), residual_pct: String(input.residualPct),
    it_block: input.itBlock.trim(), it_rate_pct: String(input.itRatePct), is_intangible: input.isIntangible ? 1 : 0,
  };
  if (input.id) {
    const r = await trx.updateTable('asset_classes').set(values).where('id', '=', input.id).where('org_id', '=', orgId).executeTakeFirst();
    if (!Number(r.numUpdatedRows)) throw notFound('That class does not exist.');
    return input.id;
  }
  return Number((await trx.insertInto('asset_classes').values({ org_id: orgId, ...values }).executeTakeFirstOrThrow()).insertId);
}

// ── Adding an asset ──────────────────────────────────────────────────────────

export type CostSource =
  /** Bought on a bill already entered: its cost is in the ledger that bill line used. */
  | { kind: 'bill'; billId: number; fromAccountId?: number | null }
  /** Paid for directly, from a bank or cash account, or owed to someone. */
  | { kind: 'paid'; fromAccountId: number }
  /** Owned before the books start, with what had been written off it by then. */
  | { kind: 'opening'; accumulatedPaise?: Paise };

export interface NewAssetInput {
  branchId: number;
  classId: number;
  tagNo?: string | null;
  name: string;
  description?: string | null;
  serialNo?: string | null;
  location?: string | null;
  custodian?: string | null;
  hsnSac?: string | null;
  acquiredOn: string;
  /** Leave out while it is still being built or installed. */
  putToUseOn?: string | null;
  costPaise: Paise;
  source: CostSource;
  itcClaimedPaise?: Paise;
  residualValuePaise?: Paise | null;
  usefulLifeYears?: number | null;
  insurancePolicyNo?: string | null;
  insuranceExpiry?: string | null;
  amcVendor?: string | null;
  amcExpiry?: string | null;
  notes?: string | null;
}

async function classOf(ex: Executor, orgId: number, id: number) {
  const c = await ex.selectFrom('asset_classes').selectAll().where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
  if (!c) throw notFound('That class of asset does not exist.');
  return c;
}

export async function addAsset(trx: Trx, orgId: number, userId: number | null, input: NewAssetInput): Promise<{ id: number; tagNo: string; entryId: number | null }> {
  if (!(input.costPaise > 0)) throw badRequest('An asset needs a cost above zero.');
  if (input.putToUseOn && input.putToUseOn < input.acquiredOn) throw badRequest('It cannot be put to use before it was acquired.');
  const cls = await classOf(trx, orgId, input.classId);
  const branch = await trx.selectFrom('branches').select('id').where('id', '=', input.branchId).where('org_id', '=', orgId).executeTakeFirst();
  if (!branch) throw notFound('That branch does not exist.');

  const acc = await accountIds(trx, orgId);
  const home = input.putToUseOn ? cls.account_id : requireAccount(acc, CODE.CWIP);
  const tagNo = input.tagNo?.trim() || `FA-${String(await nextSequence(trx, orgId, 'asset_tag')).padStart(4, '0')}`;

  let vendorId: number | null = null;
  let billId: number | null = null;
  let itc = input.itcClaimedPaise ?? 0;
  let entryId: number | null = null;
  let opening = 0;
  const memo = `${input.name} (${tagNo})`;

  if (input.source.kind === 'bill') {
    const bill = await trx.selectFrom('bills').select(['id', 'vendor_id', 'bill_date', 'status', 'subtotal', 'internal_no'])
      .where('id', '=', input.source.billId).where('org_id', '=', orgId).executeTakeFirst();
    if (!bill || bill.status === 'void' || bill.status === 'draft') throw badRequest('That bill is not posted, so it carries no cost to capitalise.');
    if (input.costPaise > toPaiseFromSql(bill.subtotal)) throw badRequest(`Bill ${bill.internal_no} is for less than that.`);
    vendorId = bill.vendor_id;
    billId = bill.id;
    // Where the cost sits now: the account named, or the one fixed-asset or
    // CWIP ledger the bill's lines used.
    const used = await trx.selectFrom('bill_lines as l').innerJoin('accounts as a', 'a.id', 'l.account_id')
      .select(['l.account_id', 'a.subtype', sql<string>`SUM(l.taxable)`.as('taxable'),
        sql<string>`SUM(IF(l.itc_eligibility IN ('eligible','capital_goods'), l.cgst + l.sgst + l.igst + l.cess, 0))`.as('itc')])
      .where('l.bill_id', '=', bill.id).groupBy(['l.account_id', 'a.subtype']).execute();
    const candidates = used.filter((u) => u.subtype === 'fixed_asset' || u.subtype === 'cwip');
    const wanted = input.source.fromAccountId;
    const from = wanted ? used.find((u) => u.account_id === wanted) : candidates.length === 1 ? candidates[0] : null;
    if (!from) {
      throw badRequest(
        candidates.length > 1
          ? 'The bill puts cost in more than one asset ledger. Say which one this asset came from.'
          : 'None of the bill’s lines went to a fixed-asset or CWIP ledger. Say which line’s account holds the cost.',
      );
    }
    if (input.itcClaimedPaise === undefined && toPaiseFromSql(from.taxable) > 0) {
      itc = Math.round(toPaiseFromSql(from.itc) * (input.costPaise / toPaiseFromSql(from.taxable)));
    }
    if (from.account_id !== home) {
      entryId = (await postEntry(trx, {
        orgId, branchId: input.branchId, date: String(bill.bill_date).slice(0, 10), module: 'accountant',
        memo: `Capitalised from bill ${bill.internal_no}: ${memo}`, sourceType: 'asset_capitalisation', userId,
        lines: [{ accountId: home, debit: input.costPaise }, { accountId: from.account_id!, credit: input.costPaise }],
      })).id;
    }
  } else if (input.source.kind === 'paid') {
    const from = await trx.selectFrom('accounts').select(['id', 'type']).where('id', '=', input.source.fromAccountId)
      .where('org_id', '=', orgId).executeTakeFirst();
    if (!from || !['asset', 'liability', 'equity'].includes(from.type)) throw badRequest('Pay for it from a bank, cash, payable or capital account.');
    entryId = (await postEntry(trx, {
      orgId, branchId: input.branchId, date: input.acquiredOn, module: 'accountant',
      memo: `Bought ${memo}`, sourceType: 'asset_purchase', userId,
      lines: [{ accountId: home, debit: input.costPaise }, { accountId: from.id, credit: input.costPaise }],
    })).id;
  } else {
    const start = await booksStartDate(trx, orgId);
    if (input.acquiredOn >= start.date) {
      throw badRequest(`An opening asset is one owned before the books start on ${start.date}. Add this one from its bill instead.`);
    }
    opening = input.source.accumulatedPaise ?? 0;
    if (opening < 0 || opening >= input.costPaise) throw badRequest('Depreciation written off before the books start must be less than the cost.');
    if (opening > 0 && !input.putToUseOn) throw badRequest('An asset not yet put to use has had no depreciation.');
    const lines: DraftLine[] = [{ accountId: home, debit: input.costPaise, description: memo }];
    if (opening > 0) lines.push({ accountId: requireAccount(acc, CODE.ACCUMULATED_DEPRECIATION), credit: opening, description: memo });
    lines.push({ accountId: requireAccount(acc, CODE.OPENING_BALANCE_EQUITY), credit: input.costPaise - opening });
    entryId = (await postEntry(trx, {
      orgId, branchId: input.branchId, date: start.date, memo: `Opening asset: ${memo}`, sourceType: 'opening', userId, lines,
    })).id;
    if (!start.isSet) await trx.updateTable('organizations').set({ books_start_date: start.date }).where('id', '=', orgId).execute();
  }

  const id = Number((await trx.insertInto('fixed_assets').values({
    org_id: orgId, branch_id: input.branchId, class_id: input.classId, tag_no: tagNo, name: input.name.trim(),
    description: input.description ?? null, serial_no: input.serialNo ?? null, location: input.location ?? null,
    custodian: input.custodian ?? null, vendor_id: vendorId, bill_id: billId, acquired_on: input.acquiredOn,
    put_to_use_on: input.putToUseOn ?? null, status: input.putToUseOn ? 'in_use' : 'cwip',
    useful_life_years: input.usefulLifeYears ? String(input.usefulLifeYears) : null,
    residual_value: input.residualValuePaise != null ? toSqlFromPaise(input.residualValuePaise) : null,
    opening_accumulated: toSqlFromPaise(opening), itc_claimed: toSqlFromPaise(itc), hsn_sac: input.hsnSac ?? null,
    insurance_policy_no: input.insurancePolicyNo ?? null, insurance_expiry: input.insuranceExpiry ?? null,
    amc_vendor: input.amcVendor ?? null, amc_expiry: input.amcExpiry ?? null, notes: input.notes ?? null,
    created_by_user_id: userId,
  }).executeTakeFirstOrThrow()).insertId);

  await trx.insertInto('asset_costs').values({
    org_id: orgId, asset_id: id, cost_date: input.source.kind === 'opening' ? input.acquiredOn : input.acquiredOn,
    amount: toSqlFromPaise(input.costPaise), kind: input.source.kind === 'opening' ? 'opening' : 'purchase',
    description: input.source.kind === 'bill' ? 'From bill' : input.source.kind === 'paid' ? 'Paid directly' : 'Opening',
    bill_id: billId, journal_entry_id: entryId,
  }).execute();
  return { id, tagNo, entryId };
}

/** More cost on an asset still being built or installed: freight, erection, a second instalment. */
export async function addCost(
  trx: Trx, orgId: number, userId: number | null, assetId: number,
  input: { date: string; amountPaise: Paise; fromAccountId: number; description?: string | null },
) {
  const a = await lockAsset(trx, orgId, assetId);
  if (a.status !== 'cwip') {
    throw conflict(`${a.name} is already in use. A later addition is an asset of its own, depreciated from its own date.`);
  }
  if (!(input.amountPaise > 0)) throw badRequest('Give an amount above zero.');
  const acc = await accountIds(trx, orgId);
  const entry = await postEntry(trx, {
    orgId, branchId: a.branch_id, date: input.date, module: 'accountant',
    memo: `Cost of ${a.name} (${a.tag_no})${input.description ? `: ${input.description}` : ''}`,
    sourceType: 'asset_purchase', sourceId: assetId, userId,
    lines: [{ accountId: requireAccount(acc, CODE.CWIP), debit: input.amountPaise }, { accountId: input.fromAccountId, credit: input.amountPaise }],
  });
  await trx.insertInto('asset_costs').values({
    org_id: orgId, asset_id: assetId, cost_date: input.date, amount: toSqlFromPaise(input.amountPaise), kind: 'addition',
    description: input.description ?? null, journal_entry_id: entry.id,
  }).execute();
  return { entryId: entry.id };
}

export async function lockAsset(trx: Trx, orgId: number, id: number) {
  const a = await trx.selectFrom('fixed_assets').selectAll().where('id', '=', id).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!a) throw notFound('That asset is not in the register.');
  return a;
}

async function costOf(ex: Executor, assetId: number): Promise<Paise> {
  const r = await ex.selectFrom('asset_costs').select(sql<string>`COALESCE(SUM(amount), 0)`.as('c')).where('asset_id', '=', assetId).executeTakeFirst();
  return toPaiseFromSql(r?.c ?? '0');
}

/** CWIP becomes an asset: its whole cost moves to its class's ledger, and depreciation starts. */
export async function putToUse(trx: Trx, orgId: number, userId: number | null, assetId: number, date: string) {
  const a = await lockAsset(trx, orgId, assetId);
  if (a.status !== 'cwip') throw conflict(`${a.name} is already ${a.status === 'in_use' ? 'in use' : 'disposed of'}.`);
  const last = await trx.selectFrom('asset_costs').select(sql<string>`MAX(cost_date)`.as('d')).where('asset_id', '=', assetId).executeTakeFirst();
  if (last?.d && date < String(last.d).slice(0, 10)) throw badRequest(`Its last cost is dated ${String(last.d).slice(0, 10)}; it cannot be in use before then.`);
  const cls = await classOf(trx, orgId, a.class_id);
  const acc = await accountIds(trx, orgId);
  const cost = await costOf(trx, assetId);
  const entry = await postEntry(trx, {
    orgId, branchId: a.branch_id, date, module: 'accountant', memo: `${a.name} (${a.tag_no}) put to use`,
    sourceType: 'asset_capitalisation', sourceId: assetId, userId,
    lines: [{ accountId: cls.account_id, debit: cost }, { accountId: requireAccount(acc, CODE.CWIP), credit: cost }],
  });
  await trx.updateTable('fixed_assets').set({ status: 'in_use', put_to_use_on: date }).where('id', '=', assetId).execute();
  return { entryId: entry.id, costPaise: cost };
}

// ── Depreciation runs ────────────────────────────────────────────────────────

interface Loaded {
  id: number; tag: string; name: string; branchId: number; status: string;
  basis: AssetBasis; openingAccumulated: Paise; charged: Paise; lastTo: string | null;
}

export async function loadAssets(ex: Executor, orgId: number, f: { branchId?: number; ids?: number[] }): Promise<Loaded[]> {
  const rows = await ex.selectFrom('fixed_assets as a').innerJoin('asset_classes as c', 'c.id', 'a.class_id')
    .select(['a.id', 'a.tag_no', 'a.name', 'a.branch_id', 'a.status', 'a.put_to_use_on', 'a.useful_life_years',
      'a.residual_value', 'a.opening_accumulated', 'c.method', 'c.useful_life_years as class_life', 'c.residual_pct'])
    .where('a.org_id', '=', orgId)
    .$if(!!f.branchId, (q) => q.where('a.branch_id', '=', f.branchId!))
    .$if(!!f.ids?.length, (q) => q.where('a.id', 'in', f.ids!))
    .execute();
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const [costs, lines] = await Promise.all([
    ex.selectFrom('asset_costs').select(['asset_id', sql<string>`SUM(amount)`.as('cost')]).where('asset_id', 'in', ids).groupBy('asset_id').execute(),
    ex.selectFrom('depreciation_lines').select(['asset_id', sql<string>`SUM(amount)`.as('charged'), sql<string>`MAX(period_to)`.as('last_to')])
      .where('asset_id', 'in', ids).where('reversed', '=', 0).groupBy('asset_id').execute(),
  ]);
  return rows.map((r) => {
    const cost = toPaiseFromSql(costs.find((c) => c.asset_id === r.id)?.cost ?? '0');
    const l = lines.find((x) => x.asset_id === r.id);
    return {
      id: r.id, tag: r.tag_no, name: r.name, branchId: r.branch_id, status: r.status,
      basis: {
        costPaise: cost,
        residualPaise: r.residual_value !== null ? toPaiseFromSql(r.residual_value) : Math.round((cost * Number(r.residual_pct)) / 100),
        lifeYears: Number(r.useful_life_years ?? r.class_life),
        method: r.method,
        putToUseOn: r.put_to_use_on ? String(r.put_to_use_on).slice(0, 10) : '9999-12-31',
      },
      openingAccumulated: toPaiseFromSql(r.opening_accumulated),
      charged: toPaiseFromSql(l?.charged ?? '0'),
      lastTo: l?.last_to ? String(l.last_to).slice(0, 10) : null,
    };
  });
}

/** Where the next run for a branch starts: the day after the last one, or when depreciation first became due. */
export async function nextRunFrom(ex: Executor, orgId: number, branchId: number): Promise<string | null> {
  const last = await ex.selectFrom('depreciation_runs').select('period_to')
    .where('org_id', '=', orgId).where('branch_id', '=', branchId).where('reversed', '=', 0)
    .orderBy('period_to', 'desc').limit(1).executeTakeFirst();
  if (last) return addDays(String(last.period_to).slice(0, 10), 1);
  const first = await ex.selectFrom('fixed_assets').select(sql<string>`MIN(put_to_use_on)`.as('d'))
    .where('org_id', '=', orgId).where('branch_id', '=', branchId).where('status', '=', 'in_use').executeTakeFirst();
  if (!first?.d) return null;
  const start = await booksStartDate(ex, orgId);
  return maxDate(String(first.d).slice(0, 10), start.date);
}

export interface RunPreview {
  branchId: number;
  from: string;
  to: string;
  lines: { assetId: number; tag: string; name: string; from: string; days: number; amountPaise: Paise }[];
  totalPaise: Paise;
}

export async function previewDepreciation(ex: Executor, orgId: number, branchId: number, to: string): Promise<RunPreview> {
  const from = await nextRunFrom(ex, orgId, branchId);
  if (!from) return { branchId, from: to, to, lines: [], totalPaise: 0 };
  if (to < from) throw conflict(`Depreciation at this branch is already charged up to ${addDays(from, -1)}.`);
  const assets = (await loadAssets(ex, orgId, { branchId })).filter((a) => a.status === 'in_use' && a.basis.putToUseOn <= to);
  const lines = assets.map((a) => {
    const start = maxDate(a.lastTo ? maxDate(from, addDays(a.lastTo, 1)) : from, a.basis.putToUseOn);
    const d = depreciationFor(a.basis, start, to, a.openingAccumulated + a.charged);
    return { assetId: a.id, tag: a.tag, name: a.name, from: start, days: d.days, amountPaise: d.amountPaise };
  }).filter((l) => l.amountPaise > 0);
  return { branchId, from, to, lines, totalPaise: lines.reduce((s, l) => s + l.amountPaise, 0) };
}

/** Charge depreciation for a branch up to `to`, from where the last run ended. */
export async function runDepreciation(trx: Trx, orgId: number, userId: number | null, branchId: number, to: string) {
  const p = await previewDepreciation(trx, orgId, branchId, to);
  if (p.totalPaise === 0) return { runId: null, entryId: null, totalPaise: 0, from: p.from, to };
  const acc = await accountIds(trx, orgId);
  const runId = Number((await trx.insertInto('depreciation_runs').values({
    org_id: orgId, branch_id: branchId, period_from: p.from, period_to: to, total: toSqlFromPaise(p.totalPaise),
    created_by_user_id: userId,
  }).executeTakeFirstOrThrow()).insertId);
  const entry = await postEntry(trx, {
    orgId, branchId, date: to, module: 'accountant', memo: `Depreciation, ${dayLabel(p.from)} to ${dayLabel(to)}`,
    sourceType: 'depreciation', sourceId: runId, userId,
    lines: [
      { accountId: requireAccount(acc, CODE.DEPRECIATION), debit: p.totalPaise },
      { accountId: requireAccount(acc, CODE.ACCUMULATED_DEPRECIATION), credit: p.totalPaise },
    ],
  });
  await trx.updateTable('depreciation_runs').set({ journal_entry_id: entry.id }).where('id', '=', runId).execute();
  await trx.insertInto('depreciation_lines').values(p.lines.map((l) => ({
    run_id: runId, org_id: orgId, asset_id: l.assetId, period_from: l.from, period_to: to,
    days: l.days, amount: toSqlFromPaise(l.amountPaise),
  }))).execute();
  return { runId, entryId: entry.id, totalPaise: p.totalPaise, from: p.from, to };
}

/** Undo the branch's latest run — to correct a class's life, say — by reversing its entry. */
export async function reverseLatestRun(trx: Trx, orgId: number, userId: number | null, branchId: number) {
  const run = await trx.selectFrom('depreciation_runs').selectAll()
    .where('org_id', '=', orgId).where('branch_id', '=', branchId).where('reversed', '=', 0)
    .orderBy('period_to', 'desc').limit(1).forUpdate().executeTakeFirst();
  if (!run) throw notFound('No depreciation run to undo at this branch.');
  const disposedSince = await trx.selectFrom('fixed_assets').select('name')
    .where('org_id', '=', orgId).where('branch_id', '=', branchId).where('status', '=', 'disposed')
    .where('disposed_on', '>', run.period_from).executeTakeFirst();
  if (disposedSince) {
    throw conflict(`${disposedSince.name} was disposed of after this run began; its depreciation to that day was settled at disposal.`);
  }
  // A split shares out the depreciation charged so far; a run before it stays.
  const splitSince = await trx.selectFrom('depreciation_lines as l').innerJoin('fixed_assets as a', 'a.id', 'l.asset_id')
    .select('a.name').where('l.org_id', '=', orgId).where('a.branch_id', '=', branchId).where('l.split', '=', 1)
    .where('l.reversed', '=', 0).where('l.period_to', '>=', run.period_from).executeTakeFirst();
  if (splitSince) {
    throw conflict(`${splitSince.name} was split after this run; the depreciation it carried was shared out between the parts, so the run stays.`);
  }
  if (run.journal_entry_id) {
    await reverseEntry(trx, orgId, run.journal_entry_id, { userId, module: 'accountant', memo: `Depreciation run to ${dayLabel(String(run.period_to))} undone` });
  }
  await trx.updateTable('depreciation_runs').set({ reversed: 1 }).where('id', '=', run.id).execute();
  await trx.updateTable('depreciation_lines').set({ reversed: 1 }).where('run_id', '=', run.id).execute();
  return { runId: run.id };
}

// ── Disposal ─────────────────────────────────────────────────────────────────
//
// An asset leaves the register in one of three ways:
//
//   * sold by a tax invoice to a buyer — GST is charged on the sale of a used
//     asset like on any supply (section 7 of the CGST Act; at least the credit
//     taken less five percentage points a quarter, section 18(6) and rule
//     44(6)), and the invoice reaches GSTR-1 like any other;
//   * sold for money received straight into a bank, with no invoice — for a
//     business not registered for GST, or a receipt GST does not reach (an
//     insurer settling a claim for an asset destroyed, say);
//   * scrapped, with nothing received.
//
// Either way two entries post, in this order:
//
//   1. Depreciation from the day after the last run to the day before it left,
//      pro rata by days (Schedule II: depreciation is charged to the date of
//      disposal, and not after):  Dr Depreciation  Cr Accumulated Depreciation
//   2. The disposal itself, one entry:
//        Dr Accumulated Depreciation       all of it, to the day it left
//        Dr Asset Disposal Clearing        the invoiced sale value, which the
//           (or Dr the bank)               invoice credited there; or the bank
//        Cr the asset's ledger             its whole cost
//        Cr Profit on Sale of Fixed Assets / Dr Loss on Sale or Discard
//
// Part of an asset (one machine of a line, a component replaced) is disposed of
// by splitting it first: the part's cost and its share of the depreciation move
// to an asset of its own (Ind AS 16 paragraph 43 / AS 10: each significant part
// depreciated, and derecognised, separately), and that one is disposed of.
//
// A disposal can be undone, with a reason: both entries are reversed on their
// own dates, the sale invoice voided, and the asset goes back into use — with
// the depreciation it missed in the meantime charged, so it is exactly where it
// would have been. The disposal stays on record, marked undone.
//
// A book can require a second person to approve disposals above an amount
// (Fixed Assets → Classes → Disposal approval): such a disposal waits, with
// nothing posted, until someone other than the person who asked approves it.

export interface DisposalInput {
  date: string;
  kind: 'sold' | 'scrapped';
  /** A sale: by tax invoice to a buyer (the default), or received straight into a bank. */
  proceedsVia?: 'invoice' | 'bank';
  /** An invoiced sale: who bought it, for how much before GST, and at what rate. */
  customerId?: number;
  salePaise?: Paise;
  gstRatePct?: number;
  /** A sale received into a bank: which account. */
  bankAccountId?: number;
  /** Dispose of only this much of the cost: the asset is split first and the part disposed of. */
  partCostPaise?: Paise;
  reason?: string | null;
}

export interface DisposalResult {
  disposalId: number;
  /** Waiting for a second person: nothing is posted yet. */
  pending: boolean;
  assetId: number;
  entryId: number | null;
  depreciationEntryId: number | null;
  invoiceId: number | null;
  invoiceNumber: string | null;
  costPaise: Paise;
  accumulatedPaise: Paise;
  catchUpPaise: Paise;
  salePaise: Paise;
  gainPaise: Paise;
  minimumTaxPaise: Paise;
  invoiceTaxPaise: Paise;
  shortTaxPaise: Paise;
  approverRole?: string | null;
}

/** Who must approve a disposal, if anyone. */
export interface DisposalApproval { isActive: boolean; thresholdPaise: Paise; approverRole: RoleName }

export async function getDisposalApproval(ex: Executor, orgId: number): Promise<DisposalApproval> {
  const r = await ex.selectFrom('asset_disposal_approval').selectAll().where('org_id', '=', orgId).executeTakeFirst();
  return r
    ? { isActive: !!r.is_active, thresholdPaise: toPaiseFromSql(r.threshold), approverRole: r.approver_role as RoleName }
    : { isActive: false, thresholdPaise: 0, approverRole: 'admin' };
}

export async function setDisposalApproval(trx: Trx, orgId: number, userId: number | null, input: DisposalApproval) {
  if (input.thresholdPaise < 0) throw badRequest('The amount cannot be negative.');
  if (input.approverRole === 'viewer') throw badRequest('A viewer cannot approve anything; choose another role.');
  const values = { is_active: input.isActive ? 1 : 0, threshold: toSqlFromPaise(input.thresholdPaise), approver_role: input.approverRole, updated_by_user_id: userId };
  await trx.insertInto('asset_disposal_approval').values({ org_id: orgId, ...values }).onDuplicateKeyUpdate(values).execute();
}

const ymdOf = (v: unknown) => (v ? String(v instanceof Date ? v.toISOString() : v).slice(0, 10) : null);

/** Checks that need nothing posted: the asset can leave on that date, and the sale is complete. */
async function checkDisposal(trx: Trx, orgId: number, a: Awaited<ReturnType<typeof lockAsset>>, input: DisposalInput) {
  if (a.status === 'disposed') throw conflict(`${a.name} was already disposed of on ${ymdOf(a.disposed_on)}.`);
  const acquired = ymdOf(a.acquired_on)!;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw badRequest('Give the date it left as yyyy-mm-dd.');
  if (input.date < acquired) throw badRequest('It cannot leave before it arrived.');
  const [loaded] = await loadAssets(trx, orgId, { ids: [a.id] });
  // Depreciation already charged past the disposal date would stay in the
  // books for days the asset was gone: date the disposal after the last run,
  // or reverse that run first.
  if (a.status === 'in_use' && loaded.lastTo && input.date <= loaded.lastTo) {
    throw badRequest(`Depreciation on ${a.name} has been charged up to ${loaded.lastTo}. Date the disposal after that, or reverse that depreciation run first.`);
  }
  if (input.kind === 'sold') {
    if (!(input.salePaise && input.salePaise > 0)) throw badRequest('Give the sale value before GST. Nil is a scrapping.');
    if ((input.proceedsVia ?? 'invoice') === 'invoice') {
      if (!input.customerId) throw badRequest('Say who bought it.');
      if (input.gstRatePct === undefined || input.gstRatePct === null) throw badRequest('Give the GST rate on the sale.');
    } else {
      if (!input.bankAccountId) throw badRequest('Say which bank account the money came into.');
      const bank = await trx.selectFrom('bank_accounts').select('id').where('id', '=', input.bankAccountId).where('org_id', '=', orgId).executeTakeFirst();
      if (!bank) throw notFound('That bank account does not exist.');
    }
  }
  if (input.partCostPaise !== undefined && input.partCostPaise !== null) {
    if (a.status !== 'in_use') throw badRequest('Only an asset in use can be disposed of in part.');
    if (!(input.partCostPaise > 0 && input.partCostPaise < loaded.basis.costPaise)) {
      throw badRequest(`The part's cost must be above nil and below the asset's cost of ₹${(loaded.basis.costPaise / 100).toLocaleString('en-IN')}. All of it is a whole disposal.`);
    }
  }
  return loaded;
}

/**
 * Dispose of an asset, or ask for its disposal to be approved when a rule
 * catches it. What it would carry out of the books — its written-down value,
 * or the proceeds if higher — is what the rule's threshold is set against.
 */
export async function disposeAsset(trx: Trx, orgId: number, userId: number | null, assetId: number, input: DisposalInput): Promise<DisposalResult> {
  const a = await lockAsset(trx, orgId, assetId);
  const loaded = await checkDisposal(trx, orgId, a, input);
  const rule = await getDisposalApproval(trx, orgId);
  const share = input.partCostPaise ? input.partCostPaise / loaded.basis.costPaise : 1;
  const wdv = Math.round((loaded.basis.costPaise - loaded.openingAccumulated - loaded.charged) * share);
  const stake = Math.max(wdv, input.salePaise ?? 0);
  const values = {
    org_id: orgId, asset_id: assetId, disposed_on: input.date, kind: input.kind,
    proceeds_via: input.kind === 'scrapped' ? 'none' as const : input.proceedsVia ?? 'invoice' as const,
    customer_id: input.kind === 'sold' && (input.proceedsVia ?? 'invoice') === 'invoice' ? input.customerId ?? null : null,
    bank_account_id: input.kind === 'sold' && input.proceedsVia === 'bank' ? input.bankAccountId ?? null : null,
    sale_value: toSqlFromPaise(input.kind === 'sold' ? input.salePaise ?? 0 : 0),
    gst_rate_pct: input.kind === 'sold' && (input.proceedsVia ?? 'invoice') === 'invoice' ? String(input.gstRatePct ?? 0) : null,
    part_pct: input.partCostPaise ? String(Math.round(share * 1_000_000) / 10_000) : null,
    reason: input.reason?.trim() || null, requested_by_user_id: userId,
  };
  const open = await trx.selectFrom('asset_disposals').select('id').where('asset_id', '=', assetId).where('status', '=', 'pending').executeTakeFirst();
  if (open) throw conflict(`A disposal of ${a.name} is already waiting for approval. Approve or send it back first.`);
  if (rule.isActive && stake >= rule.thresholdPaise) {
    // The part's cost is kept until it is approved; the split happens then.
    const id = Number((await trx.insertInto('asset_disposals').values({
      ...values, status: 'pending', cost: toSqlFromPaise(input.partCostPaise ?? loaded.basis.costPaise),
    }).executeTakeFirstOrThrow()).insertId);
    return {
      disposalId: id, pending: true, assetId, entryId: null, depreciationEntryId: null, invoiceId: null, invoiceNumber: null,
      costPaise: input.partCostPaise ?? loaded.basis.costPaise, accumulatedPaise: 0, catchUpPaise: 0, salePaise: input.salePaise ?? 0,
      gainPaise: 0, minimumTaxPaise: 0, invoiceTaxPaise: 0, shortTaxPaise: 0, approverRole: rule.approverRole,
    };
  }
  const id = Number((await trx.insertInto('asset_disposals').values({ ...values, status: 'pending' }).executeTakeFirstOrThrow()).insertId);
  return postDisposal(trx, orgId, userId, id, input);
}

/** Post a disposal on record (just asked for, or just approved). */
async function postDisposal(trx: Trx, orgId: number, userId: number | null, disposalId: number, input: DisposalInput): Promise<DisposalResult> {
  const d = await trx.selectFrom('asset_disposals').selectAll().where('id', '=', disposalId).where('org_id', '=', orgId).forUpdate().executeTakeFirstOrThrow();
  let assetId = d.asset_id;
  let partOf: number | null = null;
  if (input.partCostPaise) {
    const split = await splitAsset(trx, orgId, userId, d.asset_id, { partCostPaise: input.partCostPaise, reason: `Part disposed of on ${input.date}` }, { forDisposal: true });
    partOf = d.asset_id;
    assetId = split.id;
  }
  const a = await lockAsset(trx, orgId, assetId);
  const loaded = await checkDisposal(trx, orgId, a, { ...input, partCostPaise: undefined });
  const acquired = ymdOf(a.acquired_on)!;
  const acc = await accountIds(trx, orgId);
  const cls = await classOf(trx, orgId, a.class_id);
  const home = a.status === 'in_use' ? cls.account_id : requireAccount(acc, CODE.CWIP);

  // 1. Depreciation up to the day before it leaves, posted first.
  let catchUp = 0;
  let depEntryId: number | null = null;
  if (a.status === 'in_use') {
    const start = await booksStartDate(trx, orgId);
    const from = loaded.lastTo ? addDays(loaded.lastTo, 1) : maxDate(loaded.basis.putToUseOn, start.date);
    const to = addDays(input.date, -1);
    const dep = depreciationFor(loaded.basis, from, to, loaded.openingAccumulated + loaded.charged);
    if (dep.amountPaise > 0) {
      depEntryId = (await postEntry(trx, {
        orgId, branchId: a.branch_id, date: to, module: 'accountant',
        memo: `Depreciation on ${a.name} (${a.tag_no}) to the day it left`, sourceType: 'depreciation', sourceId: assetId, userId,
        lines: [
          { accountId: requireAccount(acc, CODE.DEPRECIATION), debit: dep.amountPaise },
          { accountId: requireAccount(acc, CODE.ACCUMULATED_DEPRECIATION), credit: dep.amountPaise },
        ],
      })).id;
      await trx.insertInto('depreciation_lines').values({
        run_id: null, org_id: orgId, asset_id: assetId, period_from: from, period_to: to, days: dep.days,
        amount: toSqlFromPaise(dep.amountPaise), disposal: 1, journal_entry_id: depEntryId,
      }).execute();
      catchUp = dep.amountPaise;
    }
  }

  const cost = loaded.basis.costPaise;
  const accumulated = loaded.openingAccumulated + loaded.charged + catchUp;
  const via = input.kind === 'scrapped' ? 'none' : input.proceedsVia ?? 'invoice';
  let sale = 0;
  let invoiceId: number | null = null;
  let invoiceNumber: string | null = null;
  let minimumTax = 0;
  let invoiceTax = 0;
  let bankLedger: number | null = null;

  if (input.kind === 'sold') {
    sale = input.salePaise!;
    if (via === 'invoice') {
      const inv = await createInvoice(trx, orgId, userId, {
        branchId: a.branch_id, customerId: input.customerId!, date: input.date, dueDate: input.date, status: 'approved',
        lines: [{
          description: `Sale of ${a.name} (${a.tag_no})`, hsnSac: a.hsn_sac, qty: 1, ratePaise: sale,
          gstRatePct: input.gstRatePct!, accountId: requireAccount(acc, CODE.ASSET_DISPOSAL),
        }],
        notes: `Sale of a used fixed asset, ${a.tag_no}.`,
      });
      invoiceId = inv.id;
      const row = await trx.selectFrom('invoices').select(['number', 'cgst', 'sgst', 'igst', 'cess']).where('id', '=', inv.id).executeTakeFirstOrThrow();
      invoiceNumber = row.number;
      invoiceTax = toPaiseFromSql(row.cgst) + toPaiseFromSql(row.sgst) + toPaiseFromSql(row.igst) + toPaiseFromSql(row.cess);
      minimumTax = minimumGstOnSale(toPaiseFromSql(a.itc_claimed), acquired, input.date);
    } else {
      const bank = await trx.selectFrom('bank_accounts').select(['ledger_account_id']).where('id', '=', input.bankAccountId!).where('org_id', '=', orgId).executeTakeFirstOrThrow();
      bankLedger = bank.ledger_account_id;
    }
  }

  // 2. The disposal: one entry.
  const lines: DraftLine[] = [];
  if (accumulated > 0) lines.push({ accountId: requireAccount(acc, CODE.ACCUMULATED_DEPRECIATION), debit: accumulated, description: `Depreciation on ${a.tag_no} to the day it left` });
  if (sale > 0 && via === 'invoice') lines.push({ accountId: requireAccount(acc, CODE.ASSET_DISPOSAL), debit: sale, description: `Invoice ${invoiceNumber}` });
  if (sale > 0 && via === 'bank') lines.push({ accountId: bankLedger!, debit: sale, description: `Sale proceeds of ${a.tag_no}` });
  lines.push({ accountId: home, credit: cost, description: `Cost of ${a.tag_no}` });
  const gain = sale + accumulated - cost;
  if (gain > 0) lines.push({ accountId: requireAccount(acc, CODE.PROFIT_ON_ASSET_SALE), credit: gain });
  else if (gain < 0) lines.push({ accountId: requireAccount(acc, CODE.LOSS_ON_ASSET_SALE), debit: -gain });

  const entry = await postEntry(trx, {
    orgId, branchId: a.branch_id, date: input.date, module: via === 'bank' ? 'banking' : 'accountant',
    memo: `${input.kind === 'sold' ? 'Sold' : 'Scrapped'}: ${a.name} (${a.tag_no})${invoiceNumber ? ` by ${invoiceNumber}` : via === 'bank' ? ', proceeds into the bank' : ''}`,
    sourceType: 'asset_disposal', sourceId: assetId, userId, lines,
  });
  await trx.updateTable('fixed_assets').set({
    status: 'disposed', disposed_on: input.date, disposal_kind: input.kind, disposal_value: toSqlFromPaise(sale),
    disposal_invoice_id: invoiceId, disposal_entry_id: entry.id, disposal_id: disposalId,
  }).where('id', '=', assetId).execute();
  await trx.updateTable('asset_disposals').set({
    status: 'posted', asset_id: assetId, part_of_asset_id: partOf, invoice_id: invoiceId,
    gst_amount: toSqlFromPaise(invoiceTax), cost: toSqlFromPaise(cost), accumulated: toSqlFromPaise(accumulated),
    catch_up: toSqlFromPaise(catchUp), gain: toSqlFromPaise(gain), depreciation_entry_id: depEntryId, disposal_entry_id: entry.id,
  }).where('id', '=', disposalId).execute();

  return {
    disposalId, pending: false, assetId, entryId: entry.id, depreciationEntryId: depEntryId, invoiceId, invoiceNumber,
    costPaise: cost, accumulatedPaise: accumulated, catchUpPaise: catchUp, salePaise: sale, gainPaise: gain,
    minimumTaxPaise: minimumTax, invoiceTaxPaise: invoiceTax, shortTaxPaise: Math.max(0, minimumTax - invoiceTax),
  };
}

const inputOf = (d: { disposed_on: unknown; kind: 'sold' | 'scrapped'; proceeds_via: string; customer_id: number | null; bank_account_id: number | null; sale_value: string; gst_rate_pct: string | null; part_pct: string | null; reason: string | null; cost: string }, fullCost: Paise): DisposalInput => ({
  date: ymdOf(d.disposed_on)!, kind: d.kind,
  proceedsVia: d.proceeds_via === 'bank' ? 'bank' : 'invoice',
  customerId: d.customer_id ?? undefined, bankAccountId: d.bank_account_id ?? undefined,
  salePaise: toPaiseFromSql(d.sale_value) || undefined, gstRatePct: d.gst_rate_pct !== null ? Number(d.gst_rate_pct) : undefined,
  partCostPaise: d.part_pct !== null && toPaiseFromSql(d.cost) < fullCost ? toPaiseFromSql(d.cost) : undefined,
  reason: d.reason,
});

/** Approve a disposal waiting for it, and post it. Never by the person who asked. */
export async function approveDisposal(trx: Trx, orgId: number, user: { userId: number; role: RoleName }, disposalId: number) {
  const d = await trx.selectFrom('asset_disposals').selectAll().where('id', '=', disposalId).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!d) throw notFound('That disposal is not on record.');
  if (d.status !== 'pending') throw conflict('That disposal is not waiting for approval.');
  if (d.requested_by_user_id === user.userId) throw forbidden('You asked for this disposal. Someone else has to approve it.');
  const rule = await getDisposalApproval(trx, orgId);
  if (rule.isActive && user.role !== 'admin' && user.role !== rule.approverRole) {
    throw forbidden(`Disposals need approval by ${rule.approverRole === 'admin' ? 'an admin' : `an ${rule.approverRole}`}.`);
  }
  const [loaded] = await loadAssets(trx, orgId, { ids: [d.asset_id] });
  await trx.updateTable('asset_disposals').set({ approved_by_user_id: user.userId, approved_at: new Date() }).where('id', '=', disposalId).execute();
  return postDisposal(trx, orgId, user.userId, disposalId, inputOf(d, loaded.basis.costPaise));
}

/** Send a disposal back: nothing was posted, and the asset stays in use. */
export async function rejectDisposal(trx: Trx, orgId: number, userId: number | null, disposalId: number, reason: string) {
  if (reason.trim().length < 3) throw badRequest('Say why the disposal is sent back.');
  const d = await trx.selectFrom('asset_disposals').select(['id', 'status']).where('id', '=', disposalId).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!d) throw notFound('That disposal is not on record.');
  if (d.status !== 'pending') throw conflict('That disposal is not waiting for approval.');
  await trx.updateTable('asset_disposals').set({ status: 'rejected', rejected_reason: reason.trim(), approved_by_user_id: userId, approved_at: new Date() })
    .where('id', '=', disposalId).execute();
}

/**
 * Undo a disposal, with a reason: its depreciation and its disposal entry are
 * reversed on their own dates, an invoiced sale's invoice is voided (refused
 * while money is received against it: take the receipt off first), and the
 * asset goes back into use. The days of depreciation it missed while it was
 * out of the register, up to the branch's last run, are charged at once.
 */
export async function undoDisposal(trx: Trx, orgId: number, userId: number | null, assetId: number, reason: string) {
  if (!reason || reason.trim().length < 4) throw badRequest('Give the reason for undoing the disposal.');
  const why = reason.trim();
  const a = await lockAsset(trx, orgId, assetId);
  if (a.status !== 'disposed') throw conflict(`${a.name} has not been disposed of.`);
  const d = a.disposal_id
    ? await trx.selectFrom('asset_disposals').selectAll().where('id', '=', a.disposal_id).forUpdate().executeTakeFirst()
    : null;
  const entryId = d?.disposal_entry_id ?? a.disposal_entry_id;
  if (entryId && await bankLineMatched(trx, orgId, 'journal_entry', entryId)) {
    throw conflict(`The money received for ${a.name} is matched to a line of the bank statement. Undo that match in Banking first.`);
  }
  // The sale invoice goes first: voidInvoice refuses one with money received or a live IRN, and says why.
  const invoiceId = d?.invoice_id ?? a.disposal_invoice_id;
  if (invoiceId) {
    const inv = await trx.selectFrom('invoices').select(['status']).where('id', '=', invoiceId).executeTakeFirst();
    if (inv && inv.status !== 'void') await voidInvoice(trx, orgId, userId, invoiceId, `Disposal of ${a.tag_no} undone: ${why}`);
  }
  if (entryId) await reverseEntry(trx, orgId, entryId, { memo: `Disposal of ${a.name} (${a.tag_no}) undone — ${why}`, userId, module: 'accountant' });
  const depEntry = d?.depreciation_entry_id ?? null;
  if (depEntry) {
    await reverseEntry(trx, orgId, depEntry, { memo: `Depreciation to the disposal of ${a.tag_no} undone — ${why}`, userId, module: 'accountant' });
    await trx.updateTable('depreciation_lines').set({ reversed: 1 }).where('asset_id', '=', assetId).where('journal_entry_id', '=', depEntry).execute();
  }
  await trx.updateTable('fixed_assets').set({
    status: 'in_use', disposed_on: null, disposal_kind: null, disposal_value: null, disposal_invoice_id: null,
    disposal_entry_id: null, disposal_id: null,
  }).where('id', '=', assetId).execute();
  if (d) {
    await trx.updateTable('asset_disposals').set({ status: 'undone', undone_by_user_id: userId, undone_at: new Date(), undo_reason: why })
      .where('id', '=', d.id).execute();
  }

  // The days it missed: runs at its branch after the day it was taken out.
  let missedPaise = 0;
  const lastRun = await trx.selectFrom('depreciation_runs').select('period_to')
    .where('org_id', '=', orgId).where('branch_id', '=', a.branch_id).where('reversed', '=', 0)
    .orderBy('period_to', 'desc').limit(1).executeTakeFirst();
  const [loaded] = await loadAssets(trx, orgId, { ids: [assetId] });
  const runTo = lastRun ? ymdOf(lastRun.period_to)! : null;
  if (runTo && loaded.basis.putToUseOn <= runTo) {
    const start = await booksStartDate(trx, orgId);
    const from = loaded.lastTo ? addDays(loaded.lastTo, 1) : maxDate(loaded.basis.putToUseOn, start.date);
    if (from <= runTo) {
      const dep = depreciationFor(loaded.basis, from, runTo, loaded.openingAccumulated + loaded.charged);
      if (dep.amountPaise > 0) {
        const acc = await accountIds(trx, orgId);
        const e = await postEntry(trx, {
          orgId, branchId: a.branch_id, date: runTo, module: 'accountant',
          memo: `Depreciation on ${a.name} (${a.tag_no}) for ${dayLabel(from)} to ${dayLabel(runTo)}, missed while its disposal stood`,
          sourceType: 'depreciation', sourceId: assetId, userId,
          lines: [
            { accountId: requireAccount(acc, CODE.DEPRECIATION), debit: dep.amountPaise },
            { accountId: requireAccount(acc, CODE.ACCUMULATED_DEPRECIATION), credit: dep.amountPaise },
          ],
        });
        await trx.insertInto('depreciation_lines').values({
          run_id: null, org_id: orgId, asset_id: assetId, period_from: from, period_to: runTo, days: dep.days,
          amount: toSqlFromPaise(dep.amountPaise), disposal: 0, journal_entry_id: e.id,
        }).execute();
        missedPaise = dep.amountPaise;
      }
    }
  }
  return { name: a.name, tagNo: a.tag_no, invoiceVoided: !!invoiceId, missedDepreciationPaise: missedPaise };
}

/**
 * Split part of an asset off into an asset of its own: the part's cost, and the
 * same share of the depreciation charged on it (and of the credit taken on it,
 * and of its residual value), move across. Nothing posts: both stay in the same
 * class and ledger. The part keeps the original's dates, life and method.
 */
export async function splitAsset(
  trx: Trx, orgId: number, userId: number | null, assetId: number,
  input: { partCostPaise: Paise; name?: string | null; tagNo?: string | null; reason?: string | null },
  opts: { forDisposal?: boolean } = {},
): Promise<{ id: number; tagNo: string; partCostPaise: Paise; partDepreciationPaise: Paise }> {
  const a = await lockAsset(trx, orgId, assetId);
  if (a.status !== 'in_use') throw conflict(`${a.name} is ${a.status === 'cwip' ? 'still being built' : 'disposed of'}; only an asset in use is split.`);
  const pending = await trx.selectFrom('asset_disposals').select('id').where('asset_id', '=', assetId).where('status', '=', 'pending').executeTakeFirst();
  if (pending && !opts.forDisposal) throw conflict(`A disposal of ${a.name} is waiting for approval; decide it first.`);
  const [loaded] = await loadAssets(trx, orgId, { ids: [assetId] });
  const cost = loaded.basis.costPaise;
  if (!(input.partCostPaise > 0 && input.partCostPaise < cost)) {
    throw badRequest(`The part's cost must be above nil and below ${a.name}'s cost of ₹${(cost / 100).toLocaleString('en-IN')}.`);
  }
  const share = input.partCostPaise / cost;
  const partDep = Math.round(loaded.charged * share);
  const partOpening = Math.round(toPaiseFromSql(a.opening_accumulated) * share);
  const partItc = Math.round(toPaiseFromSql(a.itc_claimed) * share);
  const partResidual = a.residual_value !== null ? Math.round(toPaiseFromSql(a.residual_value) * share) : null;
  const siblings = await trx.selectFrom('fixed_assets').select(sql<string>`COUNT(*)`.as('n')).where('split_from_asset_id', '=', assetId).executeTakeFirst();
  const tagNo = input.tagNo?.trim() || `${a.tag_no}-${Number(siblings?.n ?? 0) + 1}`.slice(0, 30);
  const taken = await trx.selectFrom('fixed_assets').select('id').where('org_id', '=', orgId).where('tag_no', '=', tagNo).executeTakeFirst();
  if (taken) throw conflict(`Tag ${tagNo} is already in the register. Give the part another tag.`);
  const acquired = ymdOf(a.acquired_on)!;

  const id = Number((await trx.insertInto('fixed_assets').values({
    org_id: orgId, branch_id: a.branch_id, class_id: a.class_id, tag_no: tagNo, name: (input.name?.trim() || `${a.name} (part)`).slice(0, 200),
    description: a.description, serial_no: null, location: a.location, custodian: a.custodian, vendor_id: a.vendor_id, bill_id: a.bill_id,
    acquired_on: acquired, put_to_use_on: ymdOf(a.put_to_use_on), status: 'in_use', useful_life_years: a.useful_life_years,
    residual_value: partResidual !== null ? toSqlFromPaise(partResidual) : null, opening_accumulated: toSqlFromPaise(partOpening),
    itc_claimed: toSqlFromPaise(partItc), hsn_sac: a.hsn_sac, notes: input.reason ?? `Split from ${a.tag_no}`,
    split_from_asset_id: assetId, created_by_user_id: userId,
  }).executeTakeFirstOrThrow()).insertId);
  await trx.updateTable('fixed_assets').set({
    opening_accumulated: toSqlFromPaise(toPaiseFromSql(a.opening_accumulated) - partOpening),
    itc_claimed: toSqlFromPaise(toPaiseFromSql(a.itc_claimed) - partItc),
    ...(partResidual !== null ? { residual_value: toSqlFromPaise(toPaiseFromSql(a.residual_value!) - partResidual) } : {}),
  }).where('id', '=', assetId).execute();
  // Dated on the day it was bought: componentisation reads as if it had always been two assets.
  await trx.insertInto('asset_costs').values([
    { org_id: orgId, asset_id: assetId, cost_date: acquired, amount: toSqlFromPaise(-input.partCostPaise), kind: 'split', description: `Split off to ${tagNo}` },
    { org_id: orgId, asset_id: id, cost_date: acquired, amount: toSqlFromPaise(input.partCostPaise), kind: 'split', description: `Split from ${a.tag_no}` },
  ]).execute();
  if (partDep !== 0 && loaded.lastTo) {
    await trx.insertInto('depreciation_lines').values([
      { run_id: null, org_id: orgId, asset_id: assetId, period_from: loaded.lastTo, period_to: loaded.lastTo, days: 0, amount: toSqlFromPaise(-partDep), split: 1 },
      { run_id: null, org_id: orgId, asset_id: id, period_from: loaded.lastTo, period_to: loaded.lastTo, days: 0, amount: toSqlFromPaise(partDep), split: 1 },
    ]).execute();
  }
  return { id, tagNo, partCostPaise: input.partCostPaise, partDepreciationPaise: partDep + partOpening };
}

/** Disposals waiting for approval, for the Disposals tab. */
export async function pendingDisposals(ex: Executor, orgId: number) {
  const rows = await ex.selectFrom('asset_disposals as d').innerJoin('fixed_assets as a', 'a.id', 'd.asset_id')
    .leftJoin('users as u', 'u.id', 'd.requested_by_user_id').leftJoin('contacts as c', 'c.id', 'd.customer_id')
    .select(['d.id', 'd.asset_id', 'a.tag_no', 'a.name', 'd.disposed_on', 'd.kind', 'd.proceeds_via', 'd.sale_value', 'd.gst_rate_pct',
      'd.cost', 'd.part_pct', 'd.reason', 'd.requested_at', 'd.requested_by_user_id', 'u.name as requested_by', 'c.display_name as buyer'])
    .where('d.org_id', '=', orgId).where('d.status', '=', 'pending').orderBy('d.requested_at').execute();
  return rows.map((r) => ({
    id: String(r.id), assetId: String(r.asset_id), tagNo: r.tag_no, name: r.name, date: ymdOf(r.disposed_on)!, kind: r.kind,
    proceedsVia: r.proceeds_via, salePaise: toPaiseFromSql(r.sale_value), gstRatePct: r.gst_rate_pct !== null ? Number(r.gst_rate_pct) : null,
    partCostPaise: r.part_pct !== null ? toPaiseFromSql(r.cost) : null, reason: r.reason, buyer: r.buyer,
    requestedBy: r.requested_by, requestedById: r.requested_by_user_id ? String(r.requested_by_user_id) : null,
    requestedAt: new Date(r.requested_at).toISOString(),
  }));
}

// ── The register ─────────────────────────────────────────────────────────────

export interface RegisterRow {
  id: string; tagNo: string; name: string; classId: string; className: string; branchId: string;
  status: 'cwip' | 'in_use' | 'disposed'; acquiredOn: string; putToUseOn: string | null; disposedOn: string | null;
  location: string | null; custodian: string | null; serialNo: string | null;
  costPaise: Paise; accumulatedPaise: Paise; netPaise: Paise; itcClaimedPaise: Paise;
  insuranceExpiry: string | null; amcExpiry: string | null; lastVerifiedOn: string | null;
  /** Things to look at: insurance or AMC lapsing within 30 days, not verified in a year. */
  flags: string[];
}

export interface DisposalRow {
  id: string; disposalId: string; tagNo: string; name: string; className: string; acquiredOn: string; disposedOn: string;
  kind: 'sold' | 'scrapped' | null; via: 'invoice' | 'bank' | 'none';
  costPaise: number; accumulatedPaise: number; catchUpPaise: number; writtenDownPaise: number; proceedsPaise: number; gstPaise: number; gainPaise: number;
  invoiceId: string | null; invoiceNumber: string | null; buyer: string | null; bankName: string | null;
  entryId: string | null; depreciationEntryId: string | null; partOf: string | null; reason: string | null;
}

/**
 * The assets that left between two dates: what each cost, the depreciation
 * charged to the day it left, the written-down value, what it fetched, and the
 * gain or loss — the disposals column of the Schedule III movement schedule.
 * Read from the disposal records, so a disposal later undone is not in it.
 */
export async function assetDisposals(ex: Executor, orgId: number, from: string, to: string): Promise<DisposalRow[]> {
  const rows = await ex.selectFrom('asset_disposals as d').innerJoin('fixed_assets as a', 'a.id', 'd.asset_id')
    .innerJoin('asset_classes as c', 'c.id', 'a.class_id')
    .leftJoin('invoices as i', 'i.id', 'd.invoice_id').leftJoin('contacts as k', 'k.id', 'd.customer_id')
    .leftJoin('bank_accounts as b', 'b.id', 'd.bank_account_id').leftJoin('fixed_assets as p', 'p.id', 'd.part_of_asset_id')
    .select(['d.id as disposal_id', 'a.id', 'a.tag_no', 'a.name', 'c.name as class_name', 'a.acquired_on', 'd.disposed_on', 'd.kind',
      'd.proceeds_via', 'd.cost', 'd.accumulated', 'd.catch_up', 'd.sale_value', 'd.gst_amount', 'd.gain', 'd.invoice_id',
      'i.number as invoice_number', 'k.display_name as buyer', 'b.name as bank_name', 'd.disposal_entry_id', 'd.depreciation_entry_id',
      'p.tag_no as part_of', 'd.reason'])
    .where('d.org_id', '=', orgId).where('d.status', '=', 'posted')
    .where('d.disposed_on', '>=', from).where('d.disposed_on', '<=', to).orderBy('d.disposed_on').orderBy('d.id').execute();
  return rows.map((r) => {
    const cost = toPaiseFromSql(r.cost);
    const acc = toPaiseFromSql(r.accumulated);
    return {
      id: String(r.id), disposalId: String(r.disposal_id), tagNo: r.tag_no, name: r.name, className: r.class_name,
      acquiredOn: ymdOf(r.acquired_on)!, disposedOn: ymdOf(r.disposed_on)!, kind: r.kind, via: r.proceeds_via,
      costPaise: cost, accumulatedPaise: acc, catchUpPaise: toPaiseFromSql(r.catch_up), writtenDownPaise: cost - acc,
      proceedsPaise: toPaiseFromSql(r.sale_value), gstPaise: toPaiseFromSql(r.gst_amount), gainPaise: toPaiseFromSql(r.gain),
      invoiceId: r.invoice_id ? String(r.invoice_id) : null, invoiceNumber: r.invoice_number, buyer: r.buyer, bankName: r.bank_name,
      entryId: r.disposal_entry_id ? String(r.disposal_entry_id) : null,
      depreciationEntryId: r.depreciation_entry_id ? String(r.depreciation_entry_id) : null, partOf: r.part_of, reason: r.reason,
    };
  });
}

/** A ledger's movement between two dates, debit less credit. */
async function movement(ex: Executor, orgId: number, accountIds_: number[], from: string | null, to: string) {
  if (!accountIds_.length) return 0;
  const r = await ex.selectFrom('journal_lines').select(sql<string>`COALESCE(SUM(debit - credit), 0)`.as('v'))
    .where('org_id', '=', orgId).where('account_id', 'in', accountIds_)
    .$if(!!from, (q) => q.where('entry_date', '>=', from!)).where('entry_date', '<=', to).executeTakeFirst();
  return toPaiseFromSql(r?.v ?? '0');
}

export interface DisposalsReport {
  from: string; to: string;
  rows: DisposalRow[];
  totals: { costPaise: Paise; accumulatedPaise: Paise; writtenDownPaise: Paise; proceedsPaise: Paise; gstPaise: Paise; gainPaise: Paise };
  /**
   * The same figures from the general ledger: the disposal entries' movement in
   * Profit on Sale and Loss on Sale (and in all postings to them, to show what
   * else, a manual journal say, sits there).
   */
  ledger: {
    profitPaise: Paise; lossPaise: Paise; netGainPaise: Paise; fromDisposalsPaise: Paise; otherPaise: Paise;
    other: { entryId: string; entryNo: number; date: string; memo: string | null; amountPaise: Paise }[];
  };
  ties: boolean;
  differencePaise: Paise;
  undone: { disposalId: string; assetId: string; tagNo: string; name: string; disposedOn: string; undoneAt: string; by: string | null; reason: string | null }[];
  pending: Awaited<ReturnType<typeof pendingDisposals>>;
}

/** The Disposals report, with its tie to the ledger. */
export async function disposalsReport(ex: Executor, orgId: number, from: string, to: string): Promise<DisposalsReport> {
  const rows = await assetDisposals(ex, orgId, from, to);
  const sum = (k: keyof DisposalRow) => rows.reduce((t, r) => t + Number(r[k]), 0);
  const acc = await accountIds(ex, orgId);
  const profit = acc[CODE.PROFIT_ON_ASSET_SALE];
  const loss = acc[CODE.LOSS_ON_ASSET_SALE];
  const lines = await ex.selectFrom('journal_lines as l').innerJoin('journal_entries as e', 'e.id', 'l.entry_id')
    .select(['e.id', 'e.entry_no', 'e.entry_date', 'e.memo', 'e.source_type', 'l.account_id', 'l.debit', 'l.credit'])
    .where('l.org_id', '=', orgId).where('l.account_id', 'in', [profit, loss].filter(Boolean))
    .where('l.entry_date', '>=', from).where('l.entry_date', '<=', to).execute();
  let profitPaise = 0;
  let lossPaise = 0;
  let fromDisposals = 0;
  const other = new Map<number, { entryId: string; entryNo: number; date: string; memo: string | null; amountPaise: Paise }>();
  for (const l of lines) {
    const gain = toPaiseFromSql(l.credit) - toPaiseFromSql(l.debit);
    if (l.account_id === profit) profitPaise += gain; else lossPaise -= gain;
    if (l.source_type === 'asset_disposal') fromDisposals += gain;
    else {
      const o = other.get(l.id) ?? { entryId: String(l.id), entryNo: l.entry_no, date: ymdOf(l.entry_date)!, memo: l.memo, amountPaise: 0 };
      o.amountPaise += gain;
      other.set(l.id, o);
    }
  }
  const undone = await ex.selectFrom('asset_disposals as d').innerJoin('fixed_assets as a', 'a.id', 'd.asset_id')
    .leftJoin('users as u', 'u.id', 'd.undone_by_user_id')
    .select(['d.id', 'd.asset_id', 'a.tag_no', 'a.name', 'd.disposed_on', 'd.undone_at', 'u.name as by', 'd.undo_reason'])
    .where('d.org_id', '=', orgId).where('d.status', '=', 'undone')
    .where('d.disposed_on', '>=', from).where('d.disposed_on', '<=', to).orderBy('d.undone_at', 'desc').execute();
  const totalGain = sum('gainPaise');
  return {
    from, to, rows,
    totals: {
      costPaise: sum('costPaise'), accumulatedPaise: sum('accumulatedPaise'), writtenDownPaise: sum('writtenDownPaise'),
      proceedsPaise: sum('proceedsPaise'), gstPaise: sum('gstPaise'), gainPaise: totalGain,
    },
    ledger: {
      profitPaise, lossPaise, netGainPaise: profitPaise - lossPaise, fromDisposalsPaise: fromDisposals,
      otherPaise: [...other.values()].reduce((t, o) => t + o.amountPaise, 0), other: [...other.values()].filter((o) => o.amountPaise !== 0),
    },
    // The disposals' own entries in the gain and loss ledgers equal the register's gain, to the paisa.
    ties: fromDisposals === totalGain,
    differencePaise: fromDisposals - totalGain,
    undone: undone.map((u) => ({
      disposalId: String(u.id), assetId: String(u.asset_id), tagNo: u.tag_no, name: u.name, disposedOn: ymdOf(u.disposed_on)!,
      undoneAt: u.undone_at ? new Date(u.undone_at).toISOString() : '', by: u.by, reason: u.undo_reason,
    })),
    pending: await pendingDisposals(ex, orgId),
  };
}

// ── The fixed asset schedule (Schedule III note) ────────────────────────────

export interface ScheduleRow {
  key: string; label: string; accountId: string | null; accountName: string | null;
  grossOpeningPaise: Paise; additionsPaise: Paise; disposalsPaise: Paise; grossClosingPaise: Paise;
  depOpeningPaise: Paise; depForYearPaise: Paise; depOnDisposalsPaise: Paise; depClosingPaise: Paise;
  netOpeningPaise: Paise; netClosingPaise: Paise;
}

export interface AssetSchedule {
  from: string; to: string;
  rows: ScheduleRow[];
  total: ScheduleRow;
  /** Capital work-in-progress: opening, spent in the year, put to use (capitalised), closing. */
  cwip: { openingPaise: Paise; additionsPaise: Paise; capitalisedPaise: Paise; closingPaise: Paise };
  /** Each figure against the ledger at the end of the period. */
  ties: { label: string; registerPaise: Paise; ledgerPaise: Paise; differencePaise: Paise; accountId: string | null }[];
}

/**
 * Property, plant and equipment for the year, class by class, as the notes to
 * the accounts set it out (Schedule III to the Companies Act, Part I, note on
 * tangible assets): gross block at the start, additions, disposals, gross
 * block at the end; depreciation at the start, for the year, on disposals, at
 * the end; net block at the start and the end. Each closing figure is checked
 * against its ledger.
 */
export async function assetSchedule(ex: Executor, orgId: number, from: string, to: string): Promise<AssetSchedule> {
  const [classes, assets] = await Promise.all([
    listAssetClasses(ex, orgId),
    ex.selectFrom('fixed_assets').select(['id', 'class_id', 'status', 'put_to_use_on', 'disposed_on', 'opening_accumulated'])
      .where('org_id', '=', orgId).execute(),
  ]);
  const ids = assets.map((a) => a.id);
  const [costs, lines] = ids.length
    ? await Promise.all([
      ex.selectFrom('asset_costs').select(['asset_id', 'cost_date', 'amount']).where('asset_id', 'in', ids).execute(),
      ex.selectFrom('depreciation_lines').select(['asset_id', 'period_to', 'amount']).where('asset_id', 'in', ids).where('reversed', '=', 0).execute(),
    ])
    : [[], []];
  const blank = (key: string, label: string, accountId: string | null, accountName: string | null): ScheduleRow => ({
    key, label, accountId, accountName, grossOpeningPaise: 0, additionsPaise: 0, disposalsPaise: 0, grossClosingPaise: 0,
    depOpeningPaise: 0, depForYearPaise: 0, depOnDisposalsPaise: 0, depClosingPaise: 0, netOpeningPaise: 0, netClosingPaise: 0,
  });
  const byClass = new Map(classes.map((c) => [Number(c.id), blank(c.id, c.name, c.accountId, c.accountName)]));
  const cwip = { openingPaise: 0, additionsPaise: 0, capitalisedPaise: 0, closingPaise: 0 };
  for (const a of assets) {
    const row = byClass.get(a.class_id);
    if (!row) continue;
    const used = ymdOf(a.put_to_use_on);
    const gone = a.status === 'disposed' ? ymdOf(a.disposed_on) : null;
    if (gone && gone < from) continue; // left before the year: in no column
    const mine = costs.filter((c) => c.asset_id === a.id);
    const costBefore = mine.filter((c) => ymdOf(c.cost_date)! < from).reduce((t, c) => t + toPaiseFromSql(c.amount), 0);
    const costTo = mine.filter((c) => ymdOf(c.cost_date)! <= to).reduce((t, c) => t + toPaiseFromSql(c.amount), 0);
    const dep = lines.filter((l) => l.asset_id === a.id);
    const depBefore = toPaiseFromSql(a.opening_accumulated) + dep.filter((l) => ymdOf(l.period_to)! < from).reduce((t, l) => t + toPaiseFromSql(l.amount), 0);
    const depYear = dep.filter((l) => ymdOf(l.period_to)! >= from && ymdOf(l.period_to)! <= to).reduce((t, l) => t + toPaiseFromSql(l.amount), 0);
    const inUseAtStart = !!used && used < from;
    const inUseByEnd = !!used && used <= to;
    // Capital work in progress: cost spent while it was being built.
    if (!inUseAtStart) {
      cwip.openingPaise += costBefore;
      cwip.additionsPaise += costTo - costBefore;
      if (inUseByEnd) cwip.capitalisedPaise += costTo;
    }
    if (inUseAtStart) {
      row.grossOpeningPaise += costBefore;
      row.additionsPaise += costTo - costBefore;
      row.depOpeningPaise += depBefore;
    } else if (inUseByEnd) {
      row.additionsPaise += costTo;
      row.depOpeningPaise += depBefore; // nil for an asset put to use in the year
    }
    if (inUseAtStart || inUseByEnd) row.depForYearPaise += depYear;
    if (gone && gone <= to) {
      if (used && used <= to) {
        row.disposalsPaise += costTo;
        row.depOnDisposalsPaise += depBefore + depYear;
      } else {
        cwip.capitalisedPaise += costTo; // a CWIP asset scrapped: out of CWIP, not into a class
      }
    }
  }
  cwip.closingPaise = cwip.openingPaise + cwip.additionsPaise - cwip.capitalisedPaise;
  const rows = [...byClass.values()].map((r) => {
    r.grossClosingPaise = r.grossOpeningPaise + r.additionsPaise - r.disposalsPaise;
    r.depClosingPaise = r.depOpeningPaise + r.depForYearPaise - r.depOnDisposalsPaise;
    r.netOpeningPaise = r.grossOpeningPaise - r.depOpeningPaise;
    r.netClosingPaise = r.grossClosingPaise - r.depClosingPaise;
    return r;
  }).filter((r) => r.grossOpeningPaise || r.additionsPaise || r.disposalsPaise || r.depOpeningPaise || r.depForYearPaise);
  const total = blank('total', 'Total', null, null);
  for (const r of rows) {
    for (const k of Object.keys(total) as (keyof ScheduleRow)[]) {
      if (typeof total[k] === 'number') (total[k] as number) += r[k] as number;
    }
  }

  // The ties: each ledger's closing balance, accumulated depreciation, the
  // year's charge, and CWIP.
  const acc = await accountIds(ex, orgId);
  const ties: AssetSchedule['ties'] = [];
  const ledgers = new Map<string, { name: string; register: Paise }>();
  for (const r of rows) {
    if (!r.accountId) continue;
    const l = ledgers.get(r.accountId) ?? { name: r.accountName ?? '', register: 0 };
    l.register += r.grossClosingPaise;
    ledgers.set(r.accountId, l);
  }
  for (const [accountId, l] of ledgers) {
    const ledger = await movement(ex, orgId, [Number(accountId)], null, to);
    ties.push({ label: `Gross block — ${l.name}`, registerPaise: l.register, ledgerPaise: ledger, differencePaise: ledger - l.register, accountId });
  }
  const accDep = -(await movement(ex, orgId, [acc[CODE.ACCUMULATED_DEPRECIATION]].filter(Boolean), null, to));
  ties.push({ label: 'Accumulated depreciation', registerPaise: total.depClosingPaise, ledgerPaise: accDep, differencePaise: accDep - total.depClosingPaise, accountId: acc[CODE.ACCUMULATED_DEPRECIATION] ? String(acc[CODE.ACCUMULATED_DEPRECIATION]) : null });
  const charge = await movement(ex, orgId, [acc[CODE.DEPRECIATION]].filter(Boolean), from, to);
  ties.push({ label: 'Depreciation for the period (P&L)', registerPaise: total.depForYearPaise, ledgerPaise: charge, differencePaise: charge - total.depForYearPaise, accountId: acc[CODE.DEPRECIATION] ? String(acc[CODE.DEPRECIATION]) : null });
  const cwipLedger = await movement(ex, orgId, [acc[CODE.CWIP]].filter(Boolean), null, to);
  ties.push({ label: 'Capital work-in-progress', registerPaise: cwip.closingPaise, ledgerPaise: cwipLedger, differencePaise: cwipLedger - cwip.closingPaise, accountId: acc[CODE.CWIP] ? String(acc[CODE.CWIP]) : null });
  return { from, to, rows, total, cwip, ties };
}

export async function assetRegister(ex: Executor, orgId: number, asOf = new Date().toISOString().slice(0, 10)): Promise<RegisterRow[]> {
  const rows = await ex.selectFrom('fixed_assets as a').innerJoin('asset_classes as c', 'c.id', 'a.class_id')
    .select(['a.id', 'a.tag_no', 'a.name', 'a.class_id', 'c.name as class_name', 'a.branch_id', 'a.status', 'a.acquired_on',
      'a.put_to_use_on', 'a.disposed_on', 'a.location', 'a.custodian', 'a.serial_no', 'a.opening_accumulated',
      'a.itc_claimed', 'a.insurance_expiry', 'a.amc_expiry'])
    .where('a.org_id', '=', orgId).orderBy('a.tag_no').execute();
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const [costs, charged, verified] = await Promise.all([
    ex.selectFrom('asset_costs').select(['asset_id', sql<string>`SUM(amount)`.as('v')]).where('asset_id', 'in', ids)
      .where('cost_date', '<=', asOf).groupBy('asset_id').execute(),
    ex.selectFrom('depreciation_lines').select(['asset_id', sql<string>`SUM(amount)`.as('v')]).where('asset_id', 'in', ids)
      .where('reversed', '=', 0).where('period_to', '<=', asOf).groupBy('asset_id').execute(),
    ex.selectFrom('asset_verifications').select(['asset_id', sql<string>`MAX(verified_on)`.as('v')]).where('asset_id', 'in', ids)
      .groupBy('asset_id').execute(),
  ]);
  const soon = addDays(asOf, 30);
  const yearAgo = addDays(asOf, -365);
  return rows.map((r) => {
    const d = (v: unknown) => (v ? String(v).slice(0, 10) : null);
    const cost = toPaiseFromSql(costs.find((c) => c.asset_id === r.id)?.v ?? '0');
    const disposed = r.status === 'disposed' && d(r.disposed_on)! <= asOf;
    const acc = toPaiseFromSql(r.opening_accumulated) + toPaiseFromSql(charged.find((c) => c.asset_id === r.id)?.v ?? '0');
    const last = d(verified.find((v) => v.asset_id === r.id)?.v);
    const flags: string[] = [];
    if (!disposed) {
      const ins = d(r.insurance_expiry);
      const amc = d(r.amc_expiry);
      if (ins && ins <= soon) flags.push(ins < asOf ? 'Insurance lapsed' : 'Insurance due');
      if (amc && amc <= soon) flags.push(amc < asOf ? 'AMC lapsed' : 'AMC due');
      // Due a physical check once a year from its last one, or from the day it was put to use:
      // an asset bought four months ago is not overdue for one.
      const since = last ?? d(r.put_to_use_on) ?? d(r.acquired_on);
      if (r.status === 'in_use' && (!since || since < yearAgo)) flags.push(last ? 'Not verified in a year' : 'Never verified');
    }
    return {
      id: String(r.id), tagNo: r.tag_no, name: r.name, classId: String(r.class_id), className: r.class_name,
      branchId: String(r.branch_id), status: r.status, acquiredOn: d(r.acquired_on)!, putToUseOn: d(r.put_to_use_on),
      disposedOn: d(r.disposed_on), location: r.location, custodian: r.custodian, serialNo: r.serial_no,
      costPaise: disposed ? 0 : cost, accumulatedPaise: disposed ? 0 : acc, netPaise: disposed ? 0 : cost - acc,
      itcClaimedPaise: toPaiseFromSql(r.itc_claimed), insuranceExpiry: d(r.insurance_expiry), amcExpiry: d(r.amc_expiry),
      lastVerifiedOn: last, flags,
    };
  });
}

export async function recordVerification(
  trx: Trx, orgId: number, userId: number | null, assetId: number,
  input: { date: string; found: boolean; condition?: 'good' | 'needs_repair' | 'unusable' | null; location?: string | null; notes?: string | null },
) {
  const a = await lockAsset(trx, orgId, assetId);
  if (a.status === 'disposed') throw conflict(`${a.name} has been disposed of.`);
  await trx.insertInto('asset_verifications').values({
    org_id: orgId, asset_id: assetId, verified_on: input.date, found: input.found ? 1 : 0,
    condition: input.condition ?? null, location: input.location ?? null, notes: input.notes ?? null, verified_by_user_id: userId,
  }).execute();
  // Found somewhere else: the register follows the asset.
  if (input.found && input.location && input.location !== a.location) {
    await trx.updateTable('fixed_assets').set({ location: input.location }).where('id', '=', assetId).execute();
  }
}

// ── The Income-tax book ──────────────────────────────────────────────────────

export interface ItBlockRow {
  block: string;
  ratePct: number;
  openingPaise: Paise;
  /** Put to use 180 days or more before the year ends: full rate. */
  additionsFullPaise: Paise;
  /** Put to use for less than 180 days in the year: half the rate. */
  additionsHalfPaise: Paise;
  salesPaise: Paise;
  depreciationPaise: Paise;
  closingPaise: Paise;
  /** Sale proceeds beyond the block's value, or a block emptied with value left (section 50). */
  shortTermGainPaise: Paise;
}

/**
 * The Income-tax depreciation schedule for the year beginning 1 April
 * `fyStart`. Each year's closing is the next one's opening, worked forward
 * from the first year an opening was entered or an asset was added.
 */
export async function itDepreciation(ex: Executor, orgId: number, fyStart: number): Promise<ItBlockRow[]> {
  const [classes, assets, openings] = await Promise.all([
    ex.selectFrom('asset_classes').select(['id', 'it_block', 'it_rate_pct']).where('org_id', '=', orgId).execute(),
    ex.selectFrom('fixed_assets').select(['id', 'class_id', 'put_to_use_on', 'acquired_on', 'status', 'disposed_on', 'disposal_value', 'opening_accumulated'])
      .where('org_id', '=', orgId).where('put_to_use_on', 'is not', null).execute(),
    ex.selectFrom('it_block_openings').selectAll().where('org_id', '=', orgId).execute(),
  ]);
  const costs = assets.length
    ? await ex.selectFrom('asset_costs').select(['asset_id', 'kind', sql<string>`SUM(amount)`.as('v')])
      .where('asset_id', 'in', assets.map((a) => a.id)).groupBy(['asset_id', 'kind']).execute()
    : [];
  const blockOf = new Map(classes.map((c) => [c.id, { block: c.it_block, rate: Number(c.it_rate_pct) }]));
  const blocks = new Map<string, number>();
  for (const c of classes) blocks.set(c.it_block, Number(c.it_rate_pct));
  for (const o of openings) blocks.set(o.it_block, Number(o.it_rate_pct));

  const years = [
    ...openings.map((o) => o.fy_start),
    ...assets.map((a) => fyStartYear(String(a.put_to_use_on).slice(0, 10))),
  ];
  if (!years.length) return [];
  const first = Math.min(...years);

  let carried = new Map<string, Paise>();
  let out: ItBlockRow[] = [];
  for (let y = first; y <= fyStart; y++) {
    const from = `${y}-04-01`;
    const to = `${y + 1}-03-31`;
    out = [];
    for (const [block, rate] of blocks) {
      const entered = openings.find((o) => o.fy_start === y && o.it_block === block);
      const opening = entered ? toPaiseFromSql(entered.opening_wdv) : carried.get(block) ?? 0;
      let full = 0;
      let half = 0;
      let sales = 0;
      let left = 0; // assets of the block still held at the year's end
      for (const a of assets) {
        if (blockOf.get(a.class_id)?.block !== block) continue;
        const used = String(a.put_to_use_on).slice(0, 10);
        const gone = a.status === 'disposed' ? String(a.disposed_on).slice(0, 10) : null;
        // Assets brought in at the books' start are already in the entered opening.
        // A split moves cost between two assets of the same block on the same
        // dates; the block's additions are the original purchase, once.
        const purchased = costs.filter((c) => c.asset_id === a.id && c.kind !== 'opening' && c.kind !== 'split').reduce((s, c) => s + toPaiseFromSql(c.v), 0);
        if (used >= from && used <= to && purchased > 0) {
          if (daysBetween(used, to) >= 180) full += purchased;
          else half += purchased;
        }
        if (gone && gone >= from && gone <= to) sales += toPaiseFromSql(a.disposal_value ?? '0');
        if (used <= to && (!gone || gone > to)) left += 1;
      }
      // Sale proceeds come out of the full-rate part first.
      let base = opening + full - sales;
      let halfBase = half;
      if (base < 0) {
        halfBase += base;
        base = 0;
      }
      let gain = 0;
      if (halfBase < 0) {
        gain = -halfBase;
        halfBase = 0;
      }
      let dep = Math.round((base * rate) / 100 + (halfBase * rate) / 200);
      let closing = base + halfBase - dep;
      // A block with nothing left in it has no depreciation; what value remains
      // is a short-term capital loss.
      if (left === 0 && opening + full + half > 0) {
        gain = gain - (base + halfBase);
        dep = 0;
        closing = 0;
      }
      if (opening || full || half || sales || dep || closing) {
        out.push({
          block, ratePct: rate, openingPaise: opening, additionsFullPaise: full, additionsHalfPaise: half,
          salesPaise: sales, depreciationPaise: dep, closingPaise: closing, shortTermGainPaise: gain,
        });
      }
    }
    carried = new Map(out.map((r) => [r.block, r.closingPaise]));
  }
  return out;
}

export async function setItOpening(trx: Trx, orgId: number, input: { fyStart: number; block: string; ratePct: number; openingPaise: Paise }) {
  if (input.openingPaise < 0) throw badRequest('An opening written-down value cannot be negative.');
  await sql`
    INSERT INTO it_block_openings (org_id, fy_start, it_block, it_rate_pct, opening_wdv)
    VALUES (${orgId}, ${input.fyStart}, ${input.block}, ${String(input.ratePct)}, ${toSqlFromPaise(input.openingPaise)})
    ON DUPLICATE KEY UPDATE it_rate_pct = VALUES(it_rate_pct), opening_wdv = VALUES(opening_wdv)
  `.execute(trx);
}

/** Every run, newest first, for the screen. */
export async function listRuns(ex: Executor, orgId: number) {
  const rows = await ex.selectFrom('depreciation_runs as r').leftJoin('branches as b', 'b.id', 'r.branch_id')
    .select(['r.id', 'r.branch_id', 'b.name as branch_name', 'r.period_from', 'r.period_to', 'r.total', 'r.reversed', 'r.journal_entry_id', 'r.created_at'])
    .where('r.org_id', '=', orgId).orderBy('r.period_to', 'desc').limit(100).execute();
  return rows.map((r) => ({
    id: String(r.id), branchId: r.branch_id ? String(r.branch_id) : null, branchName: r.branch_name,
    from: String(r.period_from).slice(0, 10), to: String(r.period_to).slice(0, 10), totalPaise: toPaiseFromSql(r.total),
    reversed: !!r.reversed, entryId: r.journal_entry_id ? String(r.journal_entry_id) : null,
  }));
}

/**
 * Month-end depreciation without anyone running it (Settings → Controls):
 * each branch is charged up to the last day of the month just ended, once.
 * A branch already charged that far, or a month that is locked, is left alone
 * — the run would be refused for a person too, and the exceptions register is
 * where a stuck book shows.
 */
export async function runAutoDepreciation(now = new Date()): Promise<number> {
  const today = new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10);
  const monthEnd = addDays(`${today.slice(0, 7)}-01`, -1);
  const orgs = await db.selectFrom('organizations').select('id').execute();
  let runs = 0;
  for (const o of orgs) {
    const orgId = Number(o.id);
    try {
      if (!(await getPolicies(db, orgId)).controls.autoDepreciation) continue;
      const branches = await db.selectFrom('fixed_assets').select('branch_id').distinct()
        .where('org_id', '=', orgId).where('status', '=', 'in_use').execute();
      for (const b of branches) {
        const from = await nextRunFrom(db, orgId, Number(b.branch_id));
        if (!from || from > monthEnd) continue;
        const done = await transaction((trx) => runDepreciation(trx, orgId, null, Number(b.branch_id), monthEnd));
        if (done.runId) runs++;
      }
    } catch (err) {
      console.error(`[depreciation] org ${o.id}`, err instanceof Error ? err.message : err);
    }
  }
  return runs;
}
