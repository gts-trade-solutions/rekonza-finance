import { z } from 'zod';
import { db } from '@/lib/server/db';
import { route, query, notFound } from '@/lib/server/http';
import { section34Deadline } from '@/lib/server/services/sales-documents';

// While a credit note is typed in: the last day its GST can reduce output tax
// for the invoice it corrects (CGST Act s.34(2)), so the form warns in time.

export const GET = route(
  async ({ orgId, req }) => {
    const q = query(req, z.object({ invoiceId: z.coerce.number().int().positive(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }));
    const inv = await db.selectFrom('invoices').select(['number', 'invoice_date']).where('id', '=', q.invoiceId).where('org_id', '=', orgId).executeTakeFirst();
    if (!inv) throw notFound('That invoice does not exist.');
    const limit = await section34Deadline(db, orgId, String(inv.invoice_date).slice(0, 10));
    return { invoiceNumber: inv.number, invoiceDate: String(inv.invoice_date).slice(0, 10), ...limit, late: q.date > limit.deadline };
  },
  { permission: { module: 'sales', action: 'view' } },
);
