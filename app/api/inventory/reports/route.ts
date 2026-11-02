import { z } from 'zod';
import { db } from '@/lib/server/db';
import { route, query, notFound } from '@/lib/server/http';
import { stockAgeing, stockLedger } from '@/lib/server/reports/stock-movement';

// Inventory reports (lib/server/reports/stock-movement.ts): an item's stock
// ledger over a period, and the age of the stock on hand on a date.

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Query = z.discriminatedUnion('report', [
  z.object({ report: z.literal('stock-ledger'), itemId: z.coerce.number().int().positive(), from: DATE, to: DATE }),
  z.object({ report: z.literal('stock-ageing'), asOf: DATE }),
]);

export const GET = route(
  async ({ orgId, req }) => {
    const q = query(req, Query);
    if (q.report === 'stock-ageing') return stockAgeing(db, orgId, q.asOf);
    const ledger = await stockLedger(db, orgId, q.itemId, q.from, q.to);
    if (!ledger) throw notFound('That item does not exist or is not kept in stock.');
    return ledger;
  },
  { permission: { module: 'inventory', action: 'view' } },
);
