import { z } from 'zod';
import { db } from '@/lib/server/db';
import { route, query, idParam } from '@/lib/server/http';
import { budgetVsActuals } from '@/lib/server/reports/budget-plans';

// Budget vs Actuals for one budget: per account and per column (month,
// quarter, half year or year) the budget, the actual from the journal, the
// variance in rupees and per cent, and whether it is favourable; the group
// totals; and the lines beyond the threshold flagged.

export const GET = route(
  async ({ orgId, req, params }) => {
    const q = query(req, z.object({
      columns: z.enum(['month', 'quarter', 'half', 'year']).optional(),
      upto: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      threshold: z.coerce.number().min(0).max(1000).optional(),
    }));
    return budgetVsActuals(db, orgId, idParam(params), {
      columns: q.columns, upto: q.upto, thresholdPct: q.threshold,
      today: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date()),
    });
  },
  { permission: { module: 'accountant', action: 'view' } },
);
