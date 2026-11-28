import { z } from 'zod';
import { db } from '@/lib/server/db';
import { route, query } from '@/lib/server/http';
import { stockReconciliation } from '@/lib/server/reports/stock-reconciliation';
import { indiaToday } from '@/lib/server/services/held-journals';

// Stock valuation vs ledger, item by item and in total, at a date
// (lib/server/reports/stock-reconciliation.ts). "Bring into line" is the
// existing true-up, POST /api/settings/stock-accounting { action: 'true_up' }.

export const GET = route(
  async ({ orgId, req }) => {
    const q = query(req, z.object({ asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }));
    return stockReconciliation(db, orgId, q.asOf ?? indiaToday());
  },
  { permission: { module: 'accountant', action: 'view' } },
);
