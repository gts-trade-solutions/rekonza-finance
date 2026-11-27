import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, query } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { filingStatus, markFiled, unmarkFiled } from '@/lib/server/gst/filing';
import { FILING_RETURNS, RETURN_META, periodLabel, type FilingReturn } from '@/lib/gst/filing';

// ─────────────────────────────────────────────────────────────────────────────
// The filing mark on a return (lib/server/gst/filing.ts): GET says whether it
// is filed, when it was due, what lateness costs, whether a GSP is set up on
// this server and how to upload it by hand; POST marks it filed with the date
// and ARN (and the lock after filing), corrects that mark, or takes it off.
// ─────────────────────────────────────────────────────────────────────────────

const TYPE = z.enum(FILING_RETURNS as [FilingReturn, ...FilingReturn[]]);
const PERIOD = z.string().regex(/^\d{4}(-(\d{2}|Q[1-4]))?$/, 'Give the period as yyyy-mm, yyyy-Qn, or the year a financial year starts in.');
const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export const GET = route(
  async ({ orgId, req }) => {
    const q = query(req, z.object({ returnType: TYPE, period: PERIOD }));
    return filingStatus(db, orgId, q.returnType, q.period, localToday());
  },
  { permission: { module: 'gst', action: 'view' } },
);

const Input = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('file'),
    returnType: TYPE,
    period: PERIOD,
    filedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Give the date of filing.'),
    arn: z.string().trim().min(1, 'Give the ARN the portal showed.').max(20),
    note: z.string().trim().max(300).nullish(),
    lock: z.array(z.enum(['sales', 'purchases'])).max(2).optional(),
  }),
  z.object({
    action: z.literal('unfile'),
    returnType: TYPE,
    period: PERIOD,
    reason: z.string().trim().max(300).nullish(),
  }),
]);

export const POST = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, Input);
    const title = `${RETURN_META[input.returnType].title} for ${periodLabel(input.period)}`;
    return transaction(async (trx) => {
      if (input.action === 'file') {
        const before = await trx.selectFrom('compliance_filings').select(['done_on', 'reference'])
          .where('org_id', '=', orgId).where('item_key', '=', input.returnType).where('period', '=', input.period).executeTakeFirst();
        const r = await markFiled(trx, orgId, user.userId, input, localToday());
        await logAudit({
          trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update',
          targetType: 'compliance', targetId: `${input.returnType}:${input.period}`, targetLabel: title,
          detail: `${before ? 'Changed the filed mark on' : 'Marked filed:'} ${title} on ${input.filedOn}, ARN ${r.arn}` +
            (r.kept ? `; ${r.kept} document(s) kept as filed` : '') +
            (r.locked.length ? `; locked ${r.locked.map((l) => `${l.module} up to ${l.lockedUpto}`).join(' and ')}` : ''),
          payload: before ? { changes: { before: { doneOn: String(before.done_on).slice(0, 10), arn: before.reference }, after: { doneOn: input.filedOn, arn: r.arn } } } : undefined,
          ...auditMeta(req),
        });
        return r;
      }
      await unmarkFiled(trx, orgId, input.returnType, input.period);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'void',
        targetType: 'compliance', targetId: `${input.returnType}:${input.period}`, targetLabel: title,
        detail: `Took the filed mark off ${title}${input.reason ? ` — ${input.reason}` : ''}. Any lock set with it stays (Settings → Transaction locking).`,
        ...auditMeta(req),
      });
      return { ok: true };
    });
  },
  { permission: { module: 'gst', action: 'edit' } },
);
