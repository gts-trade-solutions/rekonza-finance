import { z } from 'zod';
import { db } from '@/lib/server/db';
import { route, query } from '@/lib/server/http';
import { peekNumber } from '@/lib/server/ledger/posting';
import { fyLabelFor } from '@/lib/server/services/sales';

// The number a new quote, sales order, challan or credit note will be given,
// for its form (Zoho shows "EST-000123" before the quote is saved). Peeked,
// never allocated: an abandoned form must not leave a gap in the series.

const DOC_TYPE = { estimate: 'EST', 'sales-order': 'SO', challan: 'DC', 'credit-note': 'CN' } as const;

export const GET = route(
  async ({ orgId, branchId, req }) => {
    const q = query(req, z.object({
      kind: z.enum(['estimate', 'sales-order', 'challan', 'credit-note']),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      branchId: z.coerce.number().int().positive().optional(),
    }));
    const docType = DOC_TYPE[q.kind];
    const date = q.date ?? new Date().toISOString().slice(0, 10);
    const number = await db.transaction().execute((trx) =>
      peekNumber(trx, orgId, q.branchId ?? branchId, docType, fyLabelFor(date), docType));
    return { number };
  },
  { permission: { module: 'sales', action: 'view' } },
);
