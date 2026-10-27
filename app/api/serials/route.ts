import { z } from 'zod';
import { db } from '@/lib/server/db';
import { route, query } from '@/lib/server/http';
import { serialHistory, serialStock } from '@/lib/server/services/serials';

// Serial numbers: the pieces on hand, for picking on a sale, or one number's
// whole history, for a warranty or service question.

export const GET = route(
  async ({ orgId, req }) => {
    const q = query(req, z.object({
      q: z.string().trim().max(80).optional(),
      itemId: z.string().optional(),
      inStock: z.coerce.boolean().optional(),
    }));
    if (q.q) return { matches: await serialHistory(db, orgId, q.q) };
    return { serials: await serialStock(db, orgId, q.itemId ? Number(q.itemId) : undefined) };
  },
  { permission: { module: 'inventory', action: 'view' } },
);
