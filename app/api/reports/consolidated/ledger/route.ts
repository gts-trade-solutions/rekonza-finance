import { z } from 'zod';
import { db } from '@/lib/server/db';
import { route, query } from '@/lib/server/http';
import { companyLedger } from '@/lib/server/reports/consolidated';

// The drill-down from a consolidated figure: one account's ledger in one of
// the group's companies, read without moving the session into that company.
// Only a company whose statements this person may see.

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const GET = route(
  async ({ user, req }) => {
    const q = query(req, z.object({ orgId: z.string().regex(/^\d+$/), code: z.string().max(20), from: DATE, to: DATE }));
    return companyLedger(db, user.email, q.orgId, q.code, q.from, q.to);
  },
  { permission: { module: 'reports.financial', action: 'view' } },
);
