import { z } from 'zod';
import { transaction } from '@/lib/server/db';
import { route, body } from '@/lib/server/http';
import { switchToPerpetual, trueUpStock } from '@/lib/server/services/stock-ledger';
import { indiaToday } from '@/lib/server/services/held-journals';
import { logAudit, auditMeta } from '@/lib/server/audit';

// Perpetual inventory (services/stock-ledger.ts): switch a book onto it, or
// bring its Inventory account into line with the stock valuation now.

const Input = z.discriminatedUnion('action', [
  z.object({ action: z.literal('switch'), from: z.string().regex(/^\d{4}-\d{2}-01$/, 'Start on the first day of a month.') }),
  z.object({ action: z.literal('true_up'), asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }),
]);

export const POST = route(async ({ orgId, user, req }) => {
  const input = await body(req, Input);
  return transaction(async (trx) => {
    if (input.action === 'switch') {
      const r = await switchToPerpetual(trx, orgId, user.userId, input.from);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update', targetType: 'organization', targetId: orgId,
        targetLabel: 'Stock accounting', detail: `Switched to perpetual inventory from ${r.from}; ₹${(r.openingPaise / 100).toFixed(2)} of stock on hand taken into the ledger`,
        ...auditMeta(req),
      });
      return r;
    }
    const asOf = input.asOf ?? indiaToday();
    const moved = await trueUpStock(trx, orgId, user.userId, asOf);
    await logAudit({
      trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'create', targetType: 'journal',
      detail: `Inventory brought into line with the stock valuation at ${asOf}: ₹${(moved / 100).toFixed(2)}`, ...auditMeta(req),
    });
    return { asOf, movedPaise: moved };
  });
}, { permission: { module: 'accountant', action: 'approve' } });
