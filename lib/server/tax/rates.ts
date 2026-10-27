import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// A book's tax rates, by date.
//
// A book that has never edited its rates has no rows, and uses the shipped
// list. The first edit copies the whole shipped list in (adoptShippedRates),
// so from then on the book's rows are the complete truth for it — a partial
// copy would leave the rest silently falling back to rates nobody checked.
// ─────────────────────────────────────────────────────────────────────────────

import type { Executor, Trx } from '../db';
import {
  DEFAULT_TCS_RATES, DEFAULT_TDS_RATES, rateOn, ratesOn, type TcsRate, type TdsRate,
} from '../../tax/statutory-rates';
import { toPaiseFromSql, toSqlFromPaise } from '../money-sql';

export interface BookTdsRate extends TdsRate { id: string | null; verifiedAt: string | null }
export interface BookTcsRate extends TcsRate { id: string | null; verifiedAt: string | null }

const paiseOrNull = (v: string | null) => (v === null ? null : toPaiseFromSql(v));

export async function tdsRates(ex: Executor, orgId: number): Promise<{ rows: BookTdsRate[]; shipped: boolean }> {
  const rows = await ex.selectFrom('tds_rates').selectAll().where('org_id', '=', orgId)
    .orderBy('code').orderBy('effective_from').execute();
  if (!rows.length) {
    return { rows: DEFAULT_TDS_RATES.map((r) => ({ ...r, id: null, verifiedAt: null })), shipped: true };
  }
  return {
    shipped: false,
    rows: rows.map((r) => ({
      id: String(r.id),
      code: r.code,
      actRef: r.act_ref,
      nature: r.nature,
      effectiveFrom: String(r.effective_from).slice(0, 10),
      rateIndividualPct: Number(r.rate_individual_pct),
      rateOtherPct: Number(r.rate_other_pct),
      rateNoPanPct: Number(r.rate_no_pan_pct),
      thresholdSinglePaise: paiseOrNull(r.threshold_single),
      thresholdAnnualPaise: paiseOrNull(r.threshold_annual),
      onExcessOnly: !!r.on_excess_only,
      sourceUrl: r.source_url,
      verified: r.verified_at !== null,
      verifiedAt: r.verified_at ? new Date(r.verified_at).toISOString() : null,
    })),
  };
}

export async function tcsRates(ex: Executor, orgId: number): Promise<{ rows: BookTcsRate[]; shipped: boolean }> {
  const rows = await ex.selectFrom('tcs_rates').selectAll().where('org_id', '=', orgId)
    .orderBy('code').orderBy('effective_from').execute();
  if (!rows.length) {
    return { rows: DEFAULT_TCS_RATES.map((r) => ({ ...r, id: null, verifiedAt: null })), shipped: true };
  }
  return {
    shipped: false,
    rows: rows.map((r) => ({
      id: String(r.id),
      code: r.code,
      actRef: r.act_ref,
      nature: r.nature,
      effectiveFrom: String(r.effective_from).slice(0, 10),
      ratePct: Number(r.rate_pct),
      rateNoPanPct: Number(r.rate_no_pan_pct),
      thresholdPaise: paiseOrNull(r.threshold),
      sourceUrl: r.source_url,
      verified: r.verified_at !== null,
      verifiedAt: r.verified_at ? new Date(r.verified_at).toISOString() : null,
    })),
  };
}

/** The TDS row for a section on a date, or null when none had started. */
export async function tdsRateOn(ex: Executor, orgId: number, code: string, date: string): Promise<TdsRate | null> {
  return rateOn((await tdsRates(ex, orgId)).rows, code, date);
}

export async function tcsRateOn(ex: Executor, orgId: number, code: string, date: string): Promise<TcsRate | null> {
  return rateOn((await tcsRates(ex, orgId)).rows, code, date);
}

export async function tcsRatesOn(ex: Executor, orgId: number, date: string): Promise<TcsRate[]> {
  return ratesOn((await tcsRates(ex, orgId)).rows, date);
}

/** Copy the shipped rates into a book, once, before its first edit. */
export async function adoptShippedRates(trx: Trx, orgId: number): Promise<void> {
  const [tds, tcs] = await Promise.all([
    trx.selectFrom('tds_rates').select('id').where('org_id', '=', orgId).limit(1).execute(),
    trx.selectFrom('tcs_rates').select('id').where('org_id', '=', orgId).limit(1).execute(),
  ]);
  if (!tds.length) {
    await trx.insertInto('tds_rates').values(DEFAULT_TDS_RATES.map((r) => ({
      org_id: orgId, code: r.code, act_ref: r.actRef, nature: r.nature, effective_from: r.effectiveFrom,
      rate_individual_pct: r.rateIndividualPct, rate_other_pct: r.rateOtherPct, rate_no_pan_pct: r.rateNoPanPct,
      threshold_single: r.thresholdSinglePaise === null ? null : toSqlFromPaise(r.thresholdSinglePaise),
      threshold_annual: r.thresholdAnnualPaise === null ? null : toSqlFromPaise(r.thresholdAnnualPaise),
      on_excess_only: r.onExcessOnly ? 1 : 0, source_url: r.sourceUrl,
    }))).execute();
  }
  if (!tcs.length) {
    await trx.insertInto('tcs_rates').values(DEFAULT_TCS_RATES.map((r) => ({
      org_id: orgId, code: r.code, act_ref: r.actRef, nature: r.nature, effective_from: r.effectiveFrom,
      rate_pct: r.ratePct, rate_no_pan_pct: r.rateNoPanPct,
      threshold: r.thresholdPaise === null ? null : toSqlFromPaise(r.thresholdPaise),
      source_url: r.sourceUrl,
    }))).execute();
  }
}

/**
 * GST and cess on HSN codes, by date: code → rows oldest first. A code with no
 * rows has no dated history, and its own current rate is all there is.
 */
export async function hsnRateHistory(
  ex: Executor,
  orgId: number,
): Promise<Map<string, { effectiveFrom: string; gstRatePct: number; cessRatePct: number; note: string | null }[]>> {
  const rows = await ex
    .selectFrom('hsn_rate_history as h')
    .innerJoin('hsn_codes as c', 'c.id', 'h.hsn_code_id')
    .select(['c.code', 'h.effective_from', 'h.gst_rate_pct', 'h.cess_rate_pct', 'h.note'])
    .where('h.org_id', '=', orgId)
    .orderBy('c.code').orderBy('h.effective_from')
    .execute();
  const out = new Map<string, { effectiveFrom: string; gstRatePct: number; cessRatePct: number; note: string | null }[]>();
  for (const r of rows) {
    const list = out.get(r.code) ?? [];
    list.push({
      effectiveFrom: String(r.effective_from).slice(0, 10),
      gstRatePct: Number(r.gst_rate_pct),
      cessRatePct: Number(r.cess_rate_pct),
      note: r.note,
    });
    out.set(r.code, list);
  }
  return out;
}
