import { z } from 'zod';
import { db } from '@/lib/server/db';
import { route, query } from '@/lib/server/http';
import { actualsForPlan } from '@/lib/server/reports/budget-plans';

// "Fill from last year's actuals" for the budget grid: each account's actuals
// of the year before, period by period, raised or lowered by a percentage.
// It saves nothing, so it is a GET (the online demo replays GETs).

const FY = z.string().regex(/^\d{4}-\d{2}$/);
const optId = z.coerce.number().int().positive().optional();

export const GET = route(
  async ({ orgId, req }) => {
    const q = query(req, z.object({
      fyLabel: FY, period: z.enum(['monthly', 'quarterly', 'half_yearly', 'yearly']), accountIds: z.string().max(8000).default(''),
      adjustPct: z.coerce.number().min(-100).max(1000).default(0), branchId: optId, costCentreId: optId, projectId: optId, sourceFy: FY.optional(),
    }));
    return actualsForPlan(db, orgId, {
      fyLabel: q.fyLabel, period: q.period, accountIds: q.accountIds.split(',').map(Number).filter((n) => n > 0), adjustPct: q.adjustPct,
      branchId: q.branchId ?? null, costCentreId: q.costCentreId ?? null, projectId: q.projectId ?? null, sourceFy: q.sourceFy,
    });
  },
  { permission: { module: 'accountant', action: 'view' } },
);
