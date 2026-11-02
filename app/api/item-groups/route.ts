import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, asId } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { createItemGroup, listItemGroups } from '@/lib/server/services/item-groups';

// Item groups (services/item-groups.ts): a product in variants, each variant an item.

export const GET = route(
  async ({ orgId }) => ({ groups: await listItemGroups(db, orgId) }),
  { permission: { module: 'sales', action: 'view' } },
);

const Input = z.object({
  name: z.string().trim().min(1).max(150),
  attributes: z.array(z.object({ name: z.string().trim().min(1).max(40), values: z.array(z.string().trim().max(40)).min(1).max(30) })).min(1).max(3),
  hsnSac: z.string().trim().max(10).nullish(),
  uqc: z.string().trim().max(10).optional(),
  gstRatePct: z.number().min(0).max(28).optional(),
  salePricePaise: z.number().int().nonnegative().optional(),
  purchasePricePaise: z.number().int().nonnegative().optional(),
  trackInventory: z.boolean().optional(),
  skuPrefix: z.string().trim().max(12).nullish(),
});

export const POST = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, Input);
    const r = await transaction(async (trx) => {
      const made = await createItemGroup(trx, orgId, input);
      await logAudit({ trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'create', targetType: 'item_group', targetId: made.groupId, targetLabel: input.name, detail: `${made.itemIds.length} variants made`, ...auditMeta(req) });
      return made;
    });
    return { id: asId(r.groupId), variants: r.itemIds.length };
  },
  { permission: { module: 'sales', action: 'create' } },
);
