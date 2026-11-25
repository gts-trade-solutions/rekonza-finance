import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, query, asId, forbidden } from '@/lib/server/http';
import { hasPermission } from '@/lib/rbac';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { listConfirmations, recordReply, requestConfirmation } from '@/lib/server/services/balance-confirmations';
import { deleteConfirmation, updateConfirmation } from '@/lib/server/services/accountant-changes';

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

/**
 * Edit a confirmation's reply (their figure and the note; no figure puts it
 * back to awaited). Our figure was fixed when it was asked for.
 */
export const PATCH = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, z.object({
      id: z.union([z.string(), z.number()]).transform(Number),
      theirBalancePaise: z.number().int().nullable(),
      notes: z.string().max(1000).nullish(),
    }));
    return transaction(async (trx) => {
      const r = await updateConfirmation(trx, orgId, input.id, { theirBalancePaise: input.theirBalancePaise, notes: input.notes });
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update', targetType: 'balance_confirmation', targetId: input.id,
        detail: `Reply edited: ${r.status}`, ...auditMeta(req),
      });
      return r;
    });
  },
  { permission: { module: 'accountant', action: 'edit' } },
);

/** Delete a confirmation asked for by mistake. It posted nothing. */
export const DELETE = route(
  async ({ orgId, user, req }) => {
    const q = query(req, z.object({ id: z.coerce.number().int().positive(), reason: z.string().max(300).optional() }));
    return transaction(async (trx) => {
      const gone = await deleteConfirmation(trx, orgId, q.id);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'delete', targetType: 'balance_confirmation', targetId: q.id,
        targetLabel: gone.party, detail: `Deleted the balance confirmation of ${gone.party} as on ${gone.asOf}${q.reason ? ` — ${q.reason}` : ''}`, ...auditMeta(req),
      });
      return { ok: true };
    });
  },
  { permission: { module: 'accountant', action: 'void' } },
);
