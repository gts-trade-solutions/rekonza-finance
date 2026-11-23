import { z } from 'zod';
import { db } from '@/lib/server/db';
import { route, query, idParam, forbidden } from '@/lib/server/http';
import { accountsWithFigures, bookTransactions, canSeeAccount } from '@/lib/server/services/bank-overview';

// Zoho's "All Transactions — In Zoho Books" on a bank account: what the books
// hold for it, newest first, with the balance after each and whether a
// statement line claims it (services/bank-overview.ts bookTransactions).

const Query = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /** Zoho's All Transactions ▾: deposits only, or withdrawals only. */
  direction: z.enum(['in', 'out']).optional(),
});

export const GET = route(
  async ({ orgId, user, role, req, params }) => {
    const id = idParam(params);
    const q = query(req, Query);
    const acct = (await accountsWithFigures(db, orgId, { status: 'all' })).find((a) => a.id === id);
    if (acct && !canSeeAccount(acct, { userId: user.userId, role })) throw forbidden('This account is limited to some users, and you are not one of them.');
    return bookTransactions(db, orgId, id, { from: q.from ?? null, to: q.to ?? null, direction: q.direction ?? null });
  },
  { permission: { module: 'banking', action: 'view' } },
);
