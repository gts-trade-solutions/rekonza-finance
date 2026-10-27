import { z } from 'zod';
import { db } from '@/lib/server/db';
import { route, query } from '@/lib/server/http';
import { cashForecast } from '@/lib/server/reports/cash-forecast';
import { indiaToday } from '@/lib/server/services/held-journals';

// The next weeks of bank and cash, from what the books already know is coming.

export const GET = route(
  async ({ orgId, req }) => {
    const q = query(req, z.object({
      weeks: z.coerce.number().int().min(1).max(26).default(13),
      lateDays: z.coerce.number().int().min(0).max(180).default(0),
      overdue: z.enum(['0', '1']).default('0'),
    }));
    return cashForecast(db, orgId, { today: indiaToday(), weeks: q.weeks, lateDays: q.lateDays, countOverdueReceivables: q.overdue === '1' });
  },
  { permission: { module: 'reports.financial', action: 'view' } },
);
