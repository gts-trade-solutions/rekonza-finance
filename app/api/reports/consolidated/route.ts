import { z } from 'zod';
import { db } from '@/lib/server/db';
import { route, query } from '@/lib/server/http';
import { consolidatedStatements } from '@/lib/server/reports/consolidated';

// The statements of the companies the signed-in person may see (all, or those chosen),
// side by side, with inter-company balances and trade eliminated. See consolidated.ts.

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const GET = route(
  async ({ user, req }) => {
    // orgIds: the companies chosen (a comma list); all those visible when none.
    const q = query(req, z.object({ from: DATE, to: DATE, orgIds: z.string().max(500).optional() }));
    return consolidatedStatements(db, user.email, q.from, q.to, q.orgIds ? q.orgIds.split(',').map((x) => x.trim()).filter(Boolean) : undefined);
  },
  { permission: { module: 'reports.financial', action: 'view' } },
);
