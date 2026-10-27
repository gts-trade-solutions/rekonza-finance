import { z } from 'zod';
import { db } from '@/lib/server/db';
import { route, query } from '@/lib/server/http';
import { consolidatedStatements } from '@/lib/server/reports/consolidated';

// The statements of every company the signed-in person may see, side by side and summed.

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const GET = route(
  async ({ user, req }) => {
    const q = query(req, z.object({ from: DATE, to: DATE }));
    return consolidatedStatements(db, user.email, q.from, q.to);
  },
  { permission: { module: 'reports.financial', action: 'view' } },
);
