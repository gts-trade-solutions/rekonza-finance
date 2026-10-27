import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, query, badRequest, notFound } from '@/lib/server/http';
import { toSqlFromPaise } from '@/lib/server/money-sql';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { adoptShippedRates, tcsRates, tdsRates } from '@/lib/server/tax/rates';
import { ratesOn } from '@/lib/tax/statutory-rates';

// ─────────────────────────────────────────────────────────────────────────────
// TDS and TCS rates, by the date they took effect.
//
// Reading is open to anyone who raises documents: the invoice form needs the
// TCS heads in force on its date, and the bill form the TDS ones. Changing a
// rate is a GST-and-compliance task, so it takes the GST edit right — which is
// where a CA working in the book sits.
//
// A book that has never changed a rate uses the shipped list. The first change
// copies the whole list in, so the book's rows are then complete on their own.
// ─────────────────────────────────────────────────────────────────────────────

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a yyyy-mm-dd date.');

export const GET = route(
  async ({ orgId, req }) => {
    const q = query(req, z.object({ date: Day.optional() }));
    const [tds, tcs] = await Promise.all([tdsRates(db, orgId), tcsRates(db, orgId)]);
    return {
      tds: tds.rows,
      tcs: tcs.rows,
      shipped: tds.shipped && tcs.shipped,
      // What applies on the date asked about, one row per code.
      ...(q.date ? { tdsOn: ratesOn(tds.rows, q.date), tcsOn: ratesOn(tcs.rows, q.date) } : {}),
    };
  },
  { permission: { module: 'sales', action: 'view' } },
);

const Pct = z.number().min(0).max(100);
const Paise = z.number().int().min(0).nullable();

const RowInput = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('tds'),
    code: z.string().trim().min(2).max(20),
    actRef: z.string().trim().max(60).nullish(),
    nature: z.string().trim().min(1).max(200),
    effectiveFrom: Day,
    rateIndividualPct: Pct,
    rateOtherPct: Pct,
    rateNoPanPct: Pct,
    thresholdSinglePaise: Paise,
    thresholdAnnualPaise: Paise,
    onExcessOnly: z.boolean().default(false),
    sourceUrl: z.string().trim().url().max(500).nullish(),
  }),
  z.object({
    kind: z.literal('tcs'),
    code: z.string().trim().min(2).max(20),
    actRef: z.string().trim().max(60).nullish(),
    nature: z.string().trim().min(1).max(200),
    effectiveFrom: Day,
    ratePct: Pct,
    rateNoPanPct: Pct,
    thresholdPaise: Paise,
    sourceUrl: z.string().trim().url().max(500).nullish(),
  }),
]);

/**
 * Add a rate, or correct one, keyed by code and the date it took effect. A
 * change of rate is a new row from a new date — never an edit of the old one,
 * because documents already raised were taxed at the old rate.
 */
export const PUT = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, RowInput);

    await transaction(async (trx) => {
      await adoptShippedRates(trx, orgId);
      if (input.kind === 'tds') {
        const values = {
          act_ref: input.actRef ?? null, nature: input.nature,
          rate_individual_pct: String(input.rateIndividualPct), rate_other_pct: String(input.rateOtherPct),
          rate_no_pan_pct: String(input.rateNoPanPct),
          threshold_single: input.thresholdSinglePaise === null ? null : toSqlFromPaise(input.thresholdSinglePaise),
          threshold_annual: input.thresholdAnnualPaise === null ? null : toSqlFromPaise(input.thresholdAnnualPaise),
          on_excess_only: input.onExcessOnly ? 1 : 0, source_url: input.sourceUrl ?? null,
          // A changed figure has not been checked by anyone yet.
          verified_by_user_id: null, verified_at: null,
        };
        await trx.insertInto('tds_rates')
          .values({ org_id: orgId, code: input.code, effective_from: input.effectiveFrom, ...values })
          .onDuplicateKeyUpdate(values)
          .execute();
      } else {
        const values = {
          act_ref: input.actRef ?? null, nature: input.nature,
          rate_pct: String(input.ratePct), rate_no_pan_pct: String(input.rateNoPanPct),
          threshold: input.thresholdPaise === null ? null : toSqlFromPaise(input.thresholdPaise),
          source_url: input.sourceUrl ?? null,
          verified_by_user_id: null, verified_at: null,
        };
        await trx.insertInto('tcs_rates')
          .values({ org_id: orgId, code: input.code, effective_from: input.effectiveFrom, ...values })
          .onDuplicateKeyUpdate(values)
          .execute();
      }
    });

    await logAudit({
      orgId, actorUserId: user.userId, actorName: user.name, action: 'update',
      targetType: `${input.kind}_rate`, targetLabel: `${input.code} from ${input.effectiveFrom}`,
      detail: input.kind === 'tds'
        ? `TDS ${input.code} from ${input.effectiveFrom}: ${input.rateIndividualPct}% / ${input.rateOtherPct}%`
        : `TCS ${input.code} from ${input.effectiveFrom}: ${input.ratePct}%`,
      ...auditMeta(req),
    });
    return { ok: true };
  },
  { permission: { module: 'gst', action: 'edit' } },
);

const KeyInput = z.object({
  kind: z.enum(['tds', 'tcs']),
  code: z.string().trim().min(2).max(20),
  effectiveFrom: Day,
});

/** Record that someone qualified has checked a rate against the law. */
export const POST = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, KeyInput);
    const updated = await transaction(async (trx) => {
      await adoptShippedRates(trx, orgId);
      const table = input.kind === 'tds' ? 'tds_rates' : 'tcs_rates';
      const res = await trx.updateTable(table)
        .set({ verified_by_user_id: user.userId, verified_at: new Date() })
        .where('org_id', '=', orgId).where('code', '=', input.code)
        .where('effective_from', '=', input.effectiveFrom)
        .executeTakeFirst();
      return Number(res.numUpdatedRows);
    });
    if (!updated) throw notFound('That rate is not in the table.');

    await logAudit({
      orgId, actorUserId: user.userId, actorName: user.name, action: 'approve',
      targetType: `${input.kind}_rate`, targetLabel: `${input.code} from ${input.effectiveFrom}`,
      detail: `Verified ${input.kind.toUpperCase()} ${input.code} from ${input.effectiveFrom}`,
      ...auditMeta(req),
    });
    return { ok: true };
  },
  { permission: { module: 'gst', action: 'edit' } },
);

/** Remove a dated row — a mistaken entry, not a rate that once applied. */
export const DELETE = route(
  async ({ orgId, user, req }) => {
    const input = query(req, KeyInput);
    await transaction(async (trx) => {
      await adoptShippedRates(trx, orgId);
      const table = input.kind === 'tds' ? 'tds_rates' : 'tcs_rates';
      const others = await trx.selectFrom(table).select('id')
        .where('org_id', '=', orgId).where('code', '=', input.code)
        .where('effective_from', '<>', input.effectiveFrom).execute();
      if (!others.length) {
        throw badRequest(`${input.code} would have no rate left. Change the rate instead of removing it.`);
      }
      await trx.deleteFrom(table)
        .where('org_id', '=', orgId).where('code', '=', input.code)
        .where('effective_from', '=', input.effectiveFrom).execute();
    });

    await logAudit({
      orgId, actorUserId: user.userId, actorName: user.name, action: 'void',
      targetType: `${input.kind}_rate`, targetLabel: `${input.code} from ${input.effectiveFrom}`,
      detail: `Removed ${input.kind.toUpperCase()} ${input.code} from ${input.effectiveFrom}`,
      ...auditMeta(req),
    });
    return { ok: true };
  },
  { permission: { module: 'gst', action: 'edit' } },
);
