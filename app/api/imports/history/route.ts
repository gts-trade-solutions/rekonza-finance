import { z } from 'zod';
import { db } from '@/lib/server/db';
import { route, query } from '@/lib/server/http';
import { listImportBatches } from '@/lib/server/services/import-history';

// The import history (services/import-history.ts): every import that kept
// anything, newest first, for one list or all of them.

export const GET = route(
  async ({ orgId, req }) => {
    const q = query(req, z.object({ module: z.string().max(40).optional() }));
    return { batches: await listImportBatches(db, orgId, { module: q.module ?? null }) };
  },
  { permission: { module: 'accountant', action: 'view' } },
);
