import { z } from 'zod';
import { db } from '@/lib/server/db';
import { route, query } from '@/lib/server/http';
import { batchStock } from '@/lib/server/services/batches';

// Stock by batch, with expiry: for picking a batch on a sale, and the expiry report.

export const GET = route(
  async ({ orgId, req }) => {
    const q = query(req, z.object({ asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), all: z.coerce.boolean().optional() }));
    const d = new Date();
    const asOf = q.asOf ?? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const rows = await batchStock(db, orgId, asOf);
    return { asOf, batches: q.all ? rows : rows.filter((b) => b.qty > 0) };
  },
  { permission: { module: 'inventory', action: 'view' } },
);
