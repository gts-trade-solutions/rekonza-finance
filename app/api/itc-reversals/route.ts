import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, query } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import {
  commonCredit, commonCreditYear, postCommonCredit, postCommonCreditYear, postRule37, reclaimRule37, rule37,
} from '@/lib/server/gst/itc-reversals';

// Input tax credit taken back under Rules 37, 42 and 43. See itc-reversals.ts.

const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export const GET = route(
  async ({ orgId, req }) => {
    const q = query(req, z.object({
      view: z.enum(['rule37', 'common', 'year']),
      asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      month: month.optional(),
      fy: z.coerce.number().int().optional(),
    }));
    if (q.view === 'rule37') return { rows: await rule37(db, orgId, q.asOf ?? localToday()) };
    if (q.view === 'common') return commonCredit(db, orgId, q.month ?? localToday().slice(0, 7));
    return commonCreditYear(db, orgId, q.fy ?? Number(localToday().slice(0, 4)) - 1);
  },
  { permission: { module: 'gst', action: 'view' } },
);

const Input = z.discriminatedUnion('action', [
  z.object({ action: z.literal('reverse-37'), month }),
  z.object({ action: z.literal('reclaim-37'), month }),
  z.object({ action: z.literal('post-42'), month }),
  z.object({ action: z.literal('post-42-year'), fy: z.number().int() }),
]);

export const POST = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, Input);
    return transaction(async (trx) => {
      let detail: string;
      let result: unknown;
      if (input.action === 'reverse-37') {
        const r = await postRule37(trx, orgId, user.userId, input.month);
        detail = `Rule 37: credit of ₹${(r.totalPaise / 100).toLocaleString('en-IN')} reversed on ${r.bills} bill(s) for ${input.month}`;
        result = r;
      } else if (input.action === 'reclaim-37') {
        const r = await reclaimRule37(trx, orgId, user.userId, input.month);
        detail = `Rule 37: credit of ₹${(r.totalPaise / 100).toLocaleString('en-IN')} taken again on ${r.bills} bill(s) in ${input.month}`;
        result = r;
      } else if (input.action === 'post-42') {
        result = await postCommonCredit(trx, orgId, user.userId, input.month);
        detail = `Rules 42/43: exempt share of common credit reversed for ${input.month}`;
      } else {
        result = await postCommonCreditYear(trx, orgId, user.userId, input.fy);
        detail = `Rule 42(2): annual true-up posted for FY ${input.fy}`;
      }
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'create',
        targetType: 'itc_reversal', targetId: 'month' in input ? input.month : String(input.fy), targetLabel: input.action, detail, ...auditMeta(req),
      });
      return result;
    });
  },
  { permission: { module: 'gst', action: 'edit' } },
);
