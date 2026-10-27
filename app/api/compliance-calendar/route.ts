import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, query, notFound } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { complianceCalendar } from '@/lib/server/tax/compliance-calendar';

// What the book owes the government, and when: worked out from its profile,
// marked done as each return is filed or tax paid. See compliance-calendar.ts.

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const shift = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

export const GET = route(
  async ({ orgId, req }) => {
    const q = query(req, z.object({ from: date.optional(), to: date.optional() }));
    const today = localToday();
    return complianceCalendar(db, orgId, q.from ?? shift(today, -60), q.to ?? shift(today, 120), today);
  },
  { permission: { module: 'gst', action: 'view' } },
);

const Input = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('done'),
    key: z.string().regex(/^[a-z0-9-]{2,40}$/), period: z.string().regex(/^\d{4}(-(\d{2}|Q[1-4]|H[12]|I[1-4]))?$/),
    doneOn: date, reference: z.string().trim().max(100).nullish(), note: z.string().trim().max(300).nullish(),
  }),
  z.object({ action: z.literal('undo'), key: z.string().max(40), period: z.string().max(10) }),
]);

export const POST = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, Input);
    return transaction(async (trx) => {
      if (input.action === 'done') {
        const values = { done_on: input.doneOn, reference: input.reference || null, note: input.note || null, created_by_user_id: user.userId };
        await trx.insertInto('compliance_filings').values({ org_id: orgId, item_key: input.key, period: input.period, ...values })
          .onDuplicateKeyUpdate(values).execute();
      } else {
        const r = await trx.deleteFrom('compliance_filings')
          .where('org_id', '=', orgId).where('item_key', '=', input.key).where('period', '=', input.period).executeTakeFirst();
        if (!Number(r.numDeletedRows)) throw notFound('That was not marked done.');
      }
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update',
        targetType: 'compliance', targetId: `${input.key}:${input.period}`, targetLabel: `${input.key} ${input.period}`,
        detail: input.action === 'done'
          ? `Marked ${input.key} for ${input.period} done on ${input.doneOn}${input.reference ? ` (${input.reference})` : ''}`
          : `Unmarked ${input.key} for ${input.period}`,
        ...auditMeta(req),
      });
      return { ok: true };
    });
  },
  { permission: { module: 'gst', action: 'edit' } },
);
