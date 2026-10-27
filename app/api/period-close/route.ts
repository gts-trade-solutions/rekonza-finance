import { z } from 'zod';
import { db } from '@/lib/server/db';
import { route, query } from '@/lib/server/http';
import { closeChecks } from '@/lib/server/services/period-close';

// ─────────────────────────────────────────────────────────────────────────────
// Period-close readiness: lib/server/services/period-close.ts.
//
// The close itself is a transaction lock — this endpoint only reports whether
// it is safe to apply one. See /api/transaction-locks, and /api/year-end for
// closing a financial year.
// ─────────────────────────────────────────────────────────────────────────────

const Q = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export const GET = route(
  async ({ orgId, req }) => {
    const q = query(req, Q);
    return { from: q.from, to: q.to, ...(await closeChecks(db, orgId, q.from, q.to)) };
  },
  { permission: { module: 'accountant', action: 'view' } },
);
