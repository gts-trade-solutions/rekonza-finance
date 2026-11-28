import { z } from 'zod';
import { db } from '@/lib/server/db';
import { route, query } from '@/lib/server/http';
import { costCentreSummary } from '@/lib/server/reports/budget-plans';

// Costing: each cost centre's budget against its actual income and expense
// for the year (lib/server/reports/budget-plans.ts costCentreSummary).

export const GET = route(
  async ({ orgId, req }) => {
    const q = query(req, z.object({ fy: z.string().regex(/^\d{4}-\d{2}$/), upto: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }));
    return costCentreSummary(db, orgId, q.fy, q.upto);
  },
  { permission: { module: 'accountant', action: 'view' } },
);
