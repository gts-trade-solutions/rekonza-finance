import { z } from 'zod';
import { db } from '@/lib/server/db';
import { route, query } from '@/lib/server/http';
import { anomalies, customerRisk } from '@/lib/server/analytics/risk';
import { indiaToday } from '@/lib/server/services/held-journals';

// Risk analytics (analytics/risk.ts): anomalies in the journal, each
// customer's risk score, and collections expected from their own record.

export const GET = route(async ({ orgId, req }) => {
  const today = indiaToday();
  const q = query(req, z.object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  }));
  const to = q.to ?? today;
  const from = q.from ?? `${Number(to.slice(0, 4)) - 1}${to.slice(4)}`;
  const [found, customers] = await Promise.all([anomalies(db, orgId, from, to), customerRisk(db, orgId, today)]);
  const expected = customers.reduce((t, c) => ({
    next30: t.next30 + c.expectedPaise.next30, next60: t.next60 + c.expectedPaise.next60,
    next90: t.next90 + c.expectedPaise.next90, later: t.later + c.expectedPaise.later,
  }), { next30: 0, next60: 0, next90: 0, later: 0 });
  return { from, to, anomalies: found, customers, expected };
}, { permission: { module: 'analytics', action: 'view' } });
