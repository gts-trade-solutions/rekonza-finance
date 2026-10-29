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
import type { Paise } from '../../types';
import { toPaiseFromSql, toSqlFromPaise } from '../money-sql';
import { nextSequence, postEntry, reverseEntry, type DraftLine } from '../ledger/posting';
import { CODE, accountIds, requireAccount } from '../ledger/chart-of-accounts';
import { badRequest, conflict, notFound } from '../http';
import { booksStartDate } from './opening-balances';
import { createInvoice } from './sales';
import { getPolicies } from './org-settings';

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

async function lockAsset(trx: Trx, orgId: number, id: number) {
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

async function loadAssets(ex: Executor, orgId: number, f: { branchId?: number; ids?: number[] }): Promise<Loaded[]> {
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
    orgId, branchId, date: to, module: 'accountant', memo: `Depreciation, ${p.from} to ${to}`,
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
  if (run.journal_entry_id) {
    await reverseEntry(trx, orgId, run.journal_entry_id, { userId, module: 'accountant', memo: `Depreciation run of ${String(run.period_to).slice(0, 10)} undone` });
  }
  await trx.updateTable('depreciation_runs').set({ reversed: 1 }).where('id', '=', run.id).execute();
  await trx.updateTable('depreciation_lines').set({ reversed: 1 }).where('run_id', '=', run.id).execute();
  return { runId: run.id };
}

// ── Disposal ─────────────────────────────────────────────────────────────────

export interface DisposalInput {
  date: string;
  kind: 'sold' | 'scrapped';
  /** A sale: who bought it, for how much before GST, and at what rate. */
  customerId?: number;
  salePaise?: Paise;
  gstRatePct?: number;
}

export async function disposeAsset(trx: Trx, orgId: number, userId: number | null, assetId: number, input: DisposalInput) {
  const a = await lockAsset(trx, orgId, assetId);
  if (a.status === 'disposed') throw conflict(`${a.name} was already disposed of on ${String(a.disposed_on).slice(0, 10)}.`);
  const acquired = String(a.acquired_on).slice(0, 10);
  if (input.date < acquired) throw badRequest('It cannot leave before it arrived.');
  const acc = await accountIds(trx, orgId);
  const cls = await classOf(trx, orgId, a.class_id);
  const home = a.status === 'in_use' ? cls.account_id : requireAccount(acc, CODE.CWIP);
  const [loaded] = await loadAssets(trx, orgId, { ids: [assetId] });

  // Depreciation up to the day before it leaves, posted now.
  let catchUp = 0;
  if (a.status === 'in_use') {
    const start = await booksStartDate(trx, orgId);
    const from = loaded.lastTo ? addDays(loaded.lastTo, 1) : maxDate(loaded.basis.putToUseOn, start.date);
    const to = addDays(input.date, -1);
    const d = depreciationFor(loaded.basis, from, to, loaded.openingAccumulated + loaded.charged);
    if (d.amountPaise > 0) {
      await postEntry(trx, {
        orgId, branchId: a.branch_id, date: to, module: 'accountant',
        memo: `Depreciation on ${a.name} (${a.tag_no}) to the day it left`, sourceType: 'depreciation', userId,
        lines: [
          { accountId: requireAccount(acc, CODE.DEPRECIATION), debit: d.amountPaise },
          { accountId: requireAccount(acc, CODE.ACCUMULATED_DEPRECIATION), credit: d.amountPaise },
        ],
      });
      await trx.insertInto('depreciation_lines').values({
        run_id: null, org_id: orgId, asset_id: assetId, period_from: from, period_to: to, days: d.days,
        amount: toSqlFromPaise(d.amountPaise), disposal: 1,
      }).execute();
      catchUp = d.amountPaise;
    }
  }

  const cost = loaded.basis.costPaise;
  const accumulated = loaded.openingAccumulated + loaded.charged + catchUp;
  let sale = 0;
  let invoiceId: number | null = null;
  let invoiceNumber: string | null = null;
  let minimumTax = 0;
  let invoiceTax = 0;

  if (input.kind === 'sold') {
    if (!input.customerId) throw badRequest('Say who bought it.');
    if (!(input.salePaise && input.salePaise > 0)) throw badRequest('Give the sale value before GST. Nil is a scrapping.');
    if (input.gstRatePct === undefined) throw badRequest('Give the GST rate on the sale.');
    sale = input.salePaise;
    const inv = await createInvoice(trx, orgId, userId, {
      branchId: a.branch_id, customerId: input.customerId, date: input.date, dueDate: input.date, status: 'approved',
      lines: [{
        description: `Sale of ${a.name} (${a.tag_no})`, hsnSac: a.hsn_sac, qty: 1, ratePaise: sale,
        gstRatePct: input.gstRatePct, accountId: requireAccount(acc, CODE.ASSET_DISPOSAL),
      }],
      notes: `Sale of a used fixed asset, ${a.tag_no}.`,
    });
    invoiceId = inv.id;
    const row = await trx.selectFrom('invoices').select(['number', 'cgst', 'sgst', 'igst', 'cess']).where('id', '=', inv.id).executeTakeFirstOrThrow();
    invoiceNumber = row.number;
    invoiceTax = toPaiseFromSql(row.cgst) + toPaiseFromSql(row.sgst) + toPaiseFromSql(row.igst) + toPaiseFromSql(row.cess);
    minimumTax = minimumGstOnSale(toPaiseFromSql(a.itc_claimed), acquired, input.date);
  }

  const lines: DraftLine[] = [];
  if (sale > 0) lines.push({ accountId: requireAccount(acc, CODE.ASSET_DISPOSAL), debit: sale, description: invoiceNumber ?? undefined });
  if (accumulated > 0) lines.push({ accountId: requireAccount(acc, CODE.ACCUMULATED_DEPRECIATION), debit: accumulated });
  lines.push({ accountId: home, credit: cost });
  const gain = sale + accumulated - cost;
  if (gain > 0) lines.push({ accountId: requireAccount(acc, CODE.PROFIT_ON_ASSET_SALE), credit: gain });
  else if (gain < 0) lines.push({ accountId: requireAccount(acc, CODE.LOSS_ON_ASSET_SALE), debit: -gain });

  const entry = await postEntry(trx, {
    orgId, branchId: a.branch_id, date: input.date, module: 'accountant',
    memo: `${input.kind === 'sold' ? 'Sold' : 'Scrapped'}: ${a.name} (${a.tag_no})`,
    sourceType: 'asset_disposal', sourceId: assetId, userId, lines,
  });
  await trx.updateTable('fixed_assets').set({
    status: 'disposed', disposed_on: input.date, disposal_kind: input.kind, disposal_value: toSqlFromPaise(sale),
    disposal_invoice_id: invoiceId, disposal_entry_id: entry.id,
  }).where('id', '=', assetId).execute();

  return {
    entryId: entry.id, invoiceId, invoiceNumber, costPaise: cost, accumulatedPaise: accumulated, salePaise: sale,
    gainPaise: gain, minimumTaxPaise: minimumTax, invoiceTaxPaise: invoiceTax,
    shortTaxPaise: Math.max(0, minimumTax - invoiceTax),
  };
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
      if (r.status === 'in_use' && (!last || last < yearAgo)) flags.push('Not verified in a year');
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
        const purchased = costs.filter((c) => c.asset_id === a.id && c.kind !== 'opening').reduce((s, c) => s + toPaiseFromSql(c.v), 0);
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
