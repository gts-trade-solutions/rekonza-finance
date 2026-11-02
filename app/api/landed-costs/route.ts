import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, query, asId } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { allocateLandedCost, chargeLines, goodsLines, listLandedCosts, removeLandedCost } from '@/lib/server/services/landed-cost';

// Landed cost on a bill's goods (services/landed-cost.ts): what it carries,
// the charges with something left to spread, and spreading or taking one off.

export const GET = route(
  async ({ orgId, req }) => {
    const q = query(req, z.object({ billId: z.coerce.number().int().positive() }));
    const [goods, allocations, charges] = await Promise.all([goodsLines(db, orgId, q.billId), listLandedCosts(db, orgId, q.billId), chargeLines(db, orgId)]);
    return { goods, allocations, charges };
  },
  { permission: { module: 'purchases', action: 'view' } },
);

const paise = z.number().int().positive();
const Input = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('allocate'), goodsBillId: z.coerce.number().int().positive(), chargeLineId: z.coerce.number().int().positive(),
    method: z.enum(['quantity', 'value', 'manual']), amountPaise: paise.optional(),
    manual: z.array(z.object({ lineId: z.coerce.number().int().positive(), amountPaise: z.number().int().min(0) })).max(500).optional(),
  }),
  z.object({ action: z.literal('remove'), id: z.coerce.number().int().positive() }),
]);

export const POST = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, Input);
    return transaction(async (trx) => {
      if (input.action === 'remove') {
        const r = await removeLandedCost(trx, orgId, user.userId, input.id);
        await logAudit({
          trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update', targetType: 'bill', targetId: r.goodsBillId,
          detail: `Landed cost of ₹${(r.amountPaise / 100).toLocaleString('en-IN')} taken off its goods`, ...auditMeta(req),
        });
        return { removed: true };
      }
      const r = await allocateLandedCost(trx, orgId, user.userId, input);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update', targetType: 'bill', targetId: input.goodsBillId,
        detail: `Landed cost of ₹${(r.totalPaise / 100).toLocaleString('en-IN')} spread over its goods by ${input.method}`, ...auditMeta(req),
      });
      return { id: asId(r.id), totalPaise: r.totalPaise, posted: !!r.journalEntryId };
    });
  },
  { permission: { module: 'purchases', action: 'edit' } },
);
