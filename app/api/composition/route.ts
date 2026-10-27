import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, query } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { bookCmp08, cmp08, gstr4 } from '@/lib/server/gst/composition';
import type { Quarter } from '@/lib/server/tax/tds-returns';

// The composition dealer's returns: CMP-08 each quarter, GSTR-4 for the year.
// See lib/server/gst/composition.ts.

const fy = z.coerce.number().int().min(2017).max(2100);
const quarter = z.coerce.number().int().min(1).max(4).transform((n) => n as Quarter);

export const GET = route(
  async ({ orgId, req }) => {
    const q = query(req, z.object({ view: z.enum(['cmp08', 'gstr4']), fy, quarter: quarter.optional() }));
    if (q.view === 'gstr4') return gstr4(db, orgId, q.fy);
    if (!q.quarter) return Promise.all(([1, 2, 3, 4] as Quarter[]).map((n) => cmp08(db, orgId, q.fy, n)));
    return cmp08(db, orgId, q.fy, q.quarter);
  },
  { permission: { module: 'gst', action: 'view' } },
);

export const POST = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, z.object({ action: z.literal('book'), fy, quarter }));
    return transaction(async (trx) => {
      const c = await bookCmp08(trx, orgId, user.userId, input.fy, input.quarter);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'create',
        targetType: 'composition', targetId: `${input.fy}-Q${input.quarter}`, targetLabel: `CMP-08 ${c.from} to ${c.to}`,
        detail: `Composition tax booked: ${c.ratePct}% of ₹${(c.turnoverPaise / 100).toLocaleString('en-IN')}`,
        ...auditMeta(req),
      });
      return c;
    });
  },
  { permission: { module: 'gst', action: 'edit' } },
);
