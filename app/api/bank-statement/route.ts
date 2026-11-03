import { z } from 'zod';
import { db } from '@/lib/server/db';
import { route, query } from '@/lib/server/http';
import { bankStatementAsOn } from '@/lib/server/reports/bank-statement';

// A bank account's statement as on a date: the book balance reconciled to the
// bank's (reports/bank-statement.ts).
export const GET = route(
  async ({ orgId, req }) => {
    const q = query(req, z.object({
      bankAccountId: z.coerce.number().int().positive(),
      asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    }));
    return bankStatementAsOn(db, orgId, q.bankAccountId, q.asOf);
  },
  { permission: { module: 'banking', action: 'view' } },
);
