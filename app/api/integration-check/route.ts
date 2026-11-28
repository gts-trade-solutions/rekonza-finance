import { z } from 'zod';
import { db } from '@/lib/server/db';
import { route, query } from '@/lib/server/http';
import { integrationCheck } from '@/lib/server/services/integration-check';

// The integration check: payroll and inventory against the general ledger for
// a period, with the external feeds (payroll imports, Tally) and when each last
// ran. Read only. See lib/server/services/integration-check.ts.

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const GET = route(
  async ({ orgId, req }) => {
    const q = query(req, z.object({ from: DATE, to: DATE }));
    return integrationCheck(db, orgId, q.from, q.to);
  },
  { permission: { module: 'accountant', action: 'view' } },
);
