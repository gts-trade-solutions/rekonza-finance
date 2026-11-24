import { z } from 'zod';
import { db } from '@/lib/server/db';
import { route, query } from '@/lib/server/http';
import { inboundOverview } from '@/lib/server/services/inbound-statements';

// Zoho's "Auto-upload bank statements from email" window and the account
// page's "Bank Statements From Inbox" strip: each account's address (made the
// first time it is asked for), whether the server can receive mail, who may
// send, and what has arrived.
export const GET = route(
  async ({ orgId, req }) => {
    const q = query(req, z.object({ accountId: z.coerce.number().int().positive().optional() }));
    return inboundOverview(db, orgId, q.accountId);
  },
  { permission: { module: 'banking', action: 'view' } },
);
