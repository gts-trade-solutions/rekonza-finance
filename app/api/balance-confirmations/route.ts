import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, asId, forbidden } from '@/lib/server/http';
import { hasPermission } from '@/lib/rbac';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { listConfirmations, recordReply, requestConfirmation } from '@/lib/server/services/balance-confirmations';

// Balance confirmations (services/balance-confirmations.ts): the requests, and
// each party's answer against our ledger figure.

export const GET = route(
  async ({ orgId, role }) => {
    const all = await listConfirmations(db, orgId);
    return { confirmations: all.filter((c) => hasPermission(role, c.side === 'customer' ? 'sales' : 'purchases', 'view')) };
  },
  { permission: { module: 'accountant', action: 'view' } },
);

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Input = z.discriminatedUnion('action', [
  z.object({ action: z.literal('request'), contactId: z.union([z.string(), z.number()]), side: z.enum(['customer', 'vendor']), asOf: DATE, notes: z.string().max(1000).nullish() }),
  z.object({ action: z.literal('reply'), id: z.union([z.string(), z.number()]), theirBalancePaise: z.number().int(), notes: z.string().max(1000).nullish() }),
]);

export const POST = route(
  async ({ orgId, user, role, req }) => {
    const input = await body(req, Input);
    if (input.action === 'request') {
      if (!hasPermission(role, input.side === 'customer' ? 'sales' : 'purchases', 'view')) throw forbidden('You cannot see that account.');
      const r = await transaction(async (trx) => {
        const made = await requestConfirmation(trx, orgId, user.userId, { contactId: Number(input.contactId), side: input.side, asOf: input.asOf, notes: input.notes });
        await logAudit({ trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'create', targetType: 'contact', targetId: Number(input.contactId), detail: `Balance confirmation as of ${input.asOf}: ours ₹${(made.ourBalancePaise / 100).toFixed(2)}`, ...auditMeta(req) });
        return made;
      });
      return { id: asId(r.id), ourBalancePaise: r.ourBalancePaise };
    }
    const r = await transaction(async (trx) => {
      const out = await recordReply(trx, orgId, Number(input.id), { theirBalancePaise: input.theirBalancePaise, notes: input.notes });
      await logAudit({ trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update', targetType: 'balance_confirmation', targetId: Number(input.id), detail: out.agreed ? 'Agreed' : `Disputed: difference ₹${(out.differencePaise / 100).toFixed(2)}`, ...auditMeta(req) });
      return out;
    });
    return r;
  },
  { permission: { module: 'accountant', action: 'edit' } },
);
