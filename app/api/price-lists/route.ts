import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, query } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { discountsFor, listPriceLists, pricesFor, savePriceList } from '@/lib/server/services/price-lists';

// Price lists, and what a given customer is charged for each item.

export const GET = route(
  async ({ orgId, req }) => {
    const q = query(req, z.object({ contactId: z.coerce.number().int().positive().optional() }));
    if (q.contactId) {
      const prices = await pricesFor(db, orgId, q.contactId);
      const discounts = await discountsFor(db, orgId, q.contactId);
      return {
        prices: prices ? Object.fromEntries([...prices].map(([k, v]) => [String(k), v])) : null,
        discounts: discounts?.map((d) => ({ ...d, itemId: d.itemId === null ? null : String(d.itemId) })) ?? null,
      };
    }
    return { lists: await listPriceLists(db, orgId) };
  },
  { permission: { module: 'sales', action: 'view' } },
);

const Input = z.object({
  id: z.coerce.number().int().positive().optional(),
  name: z.string().trim().min(1).max(100),
  basis: z.enum(['percent', 'per_item']),
  percent: z.number().optional(),
  isActive: z.boolean().optional(),
  items: z.array(z.object({ itemId: z.coerce.number().int().positive(), ratePaise: z.number().int().min(0) })).optional(),
  discounts: z.array(z.object({
    itemId: z.coerce.number().int().positive().nullable(), minQty: z.number().min(0), discountPct: z.number().gt(0).max(100),
  })).max(200).optional(),
});

export const POST = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, Input);
    return transaction(async (trx) => {
      const id = await savePriceList(trx, orgId, input, input.id);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: input.id ? 'update' : 'create',
        targetType: 'price_list', targetId: id, targetLabel: input.name,
        detail: input.basis === 'percent' ? `Price list ${input.name}: ${input.percent ?? 0}% on item prices` : `Price list ${input.name}: ${input.items?.length ?? 0} item rate(s)`,
        ...auditMeta(req),
      });
      return { id: String(id) };
    });
  },
  { permission: { module: 'sales', action: 'edit' } },
);
