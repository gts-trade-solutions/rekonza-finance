import { z } from 'zod';
import { db, transaction, type Trx } from '@/lib/server/db';
import { route, body, query, asId, badRequest } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { hsnRateOn } from '@/lib/tax/gst';

// ─────────────────────────────────────────────────────────────────────────────
// A code's GST and cess by date.
//
// When the rate on a code changes — as most did on 22 September 2025 — the
// change is recorded from its date, not typed over the old rate. Documents
// dated before it keep the old rate, documents after take the new one, and the
// code's own rate (the one forms default to) follows whatever is in force today.
// ─────────────────────────────────────────────────────────────────────────────

const localToday = (): string => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** Keep the code's own rate equal to the one in force today. */
async function syncCurrentRate(trx: Trx, orgId: number, hsnCodeId: number) {
  const code = await trx.selectFrom('hsn_codes').select(['gst_rate_pct', 'cess_rate_pct'])
    .where('id', '=', hsnCodeId).where('org_id', '=', orgId).executeTakeFirst();
  if (!code) return;
  const rows = await trx.selectFrom('hsn_rate_history')
    .select(['effective_from', 'gst_rate_pct', 'cess_rate_pct'])
    .where('hsn_code_id', '=', hsnCodeId).execute();
  if (!rows.length) return;
  const now = hsnRateOn({
    gstRatePct: Number(code.gst_rate_pct),
    cessRatePct: Number(code.cess_rate_pct),
    rates: rows.map((r) => ({
      effectiveFrom: String(r.effective_from).slice(0, 10),
      gstRatePct: Number(r.gst_rate_pct),
      cessRatePct: Number(r.cess_rate_pct),
    })),
  }, localToday());
  await trx.updateTable('hsn_codes')
    .set({ gst_rate_pct: String(now.gstRatePct), cess_rate_pct: String(now.cessRatePct) })
    .where('id', '=', hsnCodeId).execute();
}

const RateInput = z.object({
  hsnCodeId: z.string(),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a yyyy-mm-dd date.'),
  gstRatePct: z.number().min(0).max(50),
  cessRatePct: z.number().min(0).max(300).default(0),
  note: z.string().trim().max(300).nullish(),
});

export const POST = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, RateInput);
    const hsnCodeId = Number(input.hsnCodeId);

    const code = await db.selectFrom('hsn_codes').select(['id', 'code'])
      .where('id', '=', hsnCodeId).where('org_id', '=', orgId).executeTakeFirst();
    if (!code) throw badRequest('That code is not on the list.');

    await transaction(async (trx) => {
      const values = {
        gst_rate_pct: String(input.gstRatePct),
        cess_rate_pct: String(input.cessRatePct),
        note: input.note ?? null,
      };
      await trx.insertInto('hsn_rate_history')
        .values({
          org_id: orgId, hsn_code_id: hsnCodeId, effective_from: input.effectiveFrom,
          created_by_user_id: user.userId, ...values,
        })
        .onDuplicateKeyUpdate(values)
        .execute();
      await syncCurrentRate(trx, orgId, hsnCodeId);
    });

    await logAudit({
      orgId, actorUserId: user.userId, actorName: user.name, action: 'update',
      targetType: 'hsn_code', targetId: hsnCodeId, targetLabel: code.code,
      detail: `${code.code}: ${input.gstRatePct}% GST${input.cessRatePct ? ` + ${input.cessRatePct}% cess` : ''} from ${input.effectiveFrom}`,
      ...auditMeta(req),
    });
    return { hsnCodeId: asId(hsnCodeId) };
  },
  { permission: { module: 'settings', action: 'edit' } },
);

export const DELETE = route(
  async ({ orgId, user, req }) => {
    const input = query(req, z.object({
      hsnCodeId: z.string(),
      effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    }));
    const hsnCodeId = Number(input.hsnCodeId);

    const code = await db.selectFrom('hsn_codes').select(['id', 'code'])
      .where('id', '=', hsnCodeId).where('org_id', '=', orgId).executeTakeFirst();
    if (!code) throw badRequest('That code is not on the list.');

    await transaction(async (trx) => {
      await trx.deleteFrom('hsn_rate_history')
        .where('org_id', '=', orgId).where('hsn_code_id', '=', hsnCodeId)
        .where('effective_from', '=', input.effectiveFrom).execute();
      await syncCurrentRate(trx, orgId, hsnCodeId);
    });

    await logAudit({
      orgId, actorUserId: user.userId, actorName: user.name, action: 'void',
      targetType: 'hsn_code', targetId: hsnCodeId, targetLabel: code.code,
      detail: `Removed the ${code.code} rate from ${input.effectiveFrom}`,
      ...auditMeta(req),
    });
    return { hsnCodeId: asId(hsnCodeId) };
  },
  { permission: { module: 'settings', action: 'edit' } },
);
