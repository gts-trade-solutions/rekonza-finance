import { z } from 'zod';
import { db } from '@/lib/server/db';
import { route, query, asId } from '@/lib/server/http';
import { bankingOverview } from '@/lib/server/services/bank-overview';
import { accountJson } from '@/lib/server/bank-account-input';

// Zoho's Banking Overview in one reply: the four tiles, the uncategorised
// count, the balance chart for the period (Last 30 days / Last 12 months) and
// the accounts table (Active, Inactive or All Accounts). "All Accounts ▾"
// narrows the tiles and the chart to one account.

const Query = z.object({
  period: z.enum(['30d', '12m']).default('30d'),
  account: z.string().regex(/^\d+$/).optional(),
  status: z.enum(['active', 'inactive', 'all']).default('active'),
});

export const GET = route(
  async ({ orgId, user, role, req }) => {
    const q = query(req, Query);
    const o = await bankingOverview(db, orgId, {
      period: q.period, accountId: q.account ? Number(q.account) : null, status: q.status, viewer: { userId: user.userId, role },
    });
    return { ...o, accountId: o.accountId ? asId(o.accountId) : null, accounts: o.accounts.map(accountJson) };
  },
  { permission: { module: 'banking', action: 'view' } },
);
