import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { listSeries, setSeriesStyle, BRANCH_SERIES } from '@/lib/server/services/numbering';

// Document number series: listed for anyone who can see settings, restyled
// (prefix and padding, never the counter) by those who can change them.

export const GET = route(
  async ({ orgId }) => ({ series: await listSeries(db, orgId) }),
  { permission: { module: 'settings', action: 'view' } },
);

const Input = z.object({
  branchId: z.union([z.string(), z.number()]),
  docType: z.enum(BRANCH_SERIES),
  prefix: z.string().trim().min(1, 'Give a prefix.').max(10),
  padding: z.number().int().min(1).max(6),
});

export const PUT = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, Input);
    const row = await transaction(async (trx) => {
      const r = await setSeriesStyle(trx, orgId, {
        branchId: Number(input.branchId), docType: input.docType, prefix: input.prefix, padding: input.padding,
      });
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update',
        targetType: 'number_series', targetId: Number(input.branchId), targetLabel: `${input.docType} ${r.branchName}`,
        detail: `${r.label} at ${r.branchName} now numbered like ${r.sample}`, payload: input, ...auditMeta(req),
      });
      return r;
    });
    return { series: row };
  },
  { permission: { module: 'settings', action: 'edit' } },
);
