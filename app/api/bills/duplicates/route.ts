import { z } from 'zod';
import { db } from '@/lib/server/db';
import { route, query } from '@/lib/server/http';
import { findBillDuplicates } from '@/lib/server/services/bill-duplicates';

// While a bill is typed in: is this supplier's bill already in the books, or
// something that looks like it? The form shows the answer before saving.

export const GET = route(
  async ({ orgId, req }) => {
    const q = query(req, z.object({
      vendorId: z.coerce.number().int().positive(),
      number: z.string().trim().min(1).max(60),
      totalPaise: z.coerce.number().int().min(0).optional(),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      excludeId: z.coerce.number().int().positive().optional(),
    }));
    return findBillDuplicates(db, orgId, { vendorId: q.vendorId, vendorInvoiceNo: q.number, totalPaise: q.totalPaise ?? null, date: q.date ?? null, excludeId: q.excludeId ?? null });
  },
  { permission: { module: 'purchases', action: 'view' } },
);
