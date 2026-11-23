import { z } from 'zod';
import { db } from '@/lib/server/db';
import { route, query, idParam } from '@/lib/server/http';
import { recordedCandidates } from '@/lib/server/services/bank-match';

// Zoho's Multi-Select & Match on an account: the transactions already in the
// books, through this account, that no statement line has claimed — what
// several chosen lines could together be.

export const GET = route(
  async ({ orgId, req, params }) => {
    const q = query(req, z.object({ direction: z.enum(['in', 'out']) }));
    return { candidates: await recordedCandidates(db, orgId, idParam(params), q.direction) };
  },
  { permission: { module: 'banking', action: 'view' } },
);
