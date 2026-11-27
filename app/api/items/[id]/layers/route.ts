import { z } from 'zod';
import { db } from '@/lib/server/db';
import { route, query, idParam, notFound } from '@/lib/server/http';
import { itemLayers } from '@/lib/server/reports/stock-reconciliation';
import { indiaToday } from '@/lib/server/services/held-journals';

// One item's FIFO layers at a date: each receipt, what is left of it on hand,
// its rate and value (the item page's Stock Layers tab).

export const GET = route(
  async ({ orgId, req, params }) => {
    const id = idParam(params);
    const q = query(req, z.object({ asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }));
    const item = await db.selectFrom('items').select('id').where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
    if (!item) throw notFound('That item does not exist.');
    return itemLayers(db, orgId, id, q.asOf ?? indiaToday());
  },
  { permission: { module: 'inventory', action: 'view' } },
);
