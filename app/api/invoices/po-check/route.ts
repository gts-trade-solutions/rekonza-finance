import { z } from 'zod';
import { db } from '@/lib/server/db';
import { route, query } from '@/lib/server/http';
import { billNumberKey } from '@/lib/server/services/bill-duplicates';

// While an invoice is typed in: is this customer's purchase order already on
// another of their invoices? The form warns before saving (an order billed
// twice); the invoice is still allowed, as one order may be billed in parts.

export const GET = route(
  async ({ orgId, req }) => {
    const q = query(req, z.object({
      customerId: z.coerce.number().int().positive(),
      orderNumber: z.string().trim().min(1).max(60),
      excludeId: z.coerce.number().int().positive().optional(),
    }));
    const key = billNumberKey(q.orderNumber);
    const rows = await db.selectFrom('invoices').select(['id', 'number', 'order_number', 'invoice_date', 'total'])
      .where('org_id', '=', orgId).where('customer_id', '=', q.customerId).where('status', '<>', 'void').where('doc_kind', '=', 'invoice')
      .where('order_number', 'is not', null).$if(!!q.excludeId, (b) => b.where('id', '<>', q.excludeId!)).execute();
    return {
      invoices: rows.filter((r) => billNumberKey(r.order_number ?? '') === key).map((r) => ({
        id: String(r.id), number: r.number, orderNumber: r.order_number, date: String(r.invoice_date).slice(0, 10),
      })),
    };
  },
  { permission: { module: 'sales', action: 'view' } },
);
