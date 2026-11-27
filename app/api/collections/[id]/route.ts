import { z } from 'zod';
import { transaction } from '@/lib/server/db';
import { route, body, idParam, asId } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { deleteFollowUp, updateFollowUp } from '@/lib/server/services/collections';

// Edit and Delete on one collection follow-up (services/collections.ts): a call,
// visit or note logged against a customer, with the promise to pay it recorded.

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Input = z.object({
  kind: z.enum(['call', 'email', 'whatsapp', 'visit', 'note']),
  note: z.string().trim().min(1, 'Say what happened.').max(1000),
  promisedDate: DATE.nullish(),
  promisedPaise: z.number().int().positive().nullish(),
  nextFollowup: DATE.nullish(),
});

export const PUT = route(
  async ({ orgId, user, req, params }) => {
    const id = idParam(params);
    const input = await body(req, Input);
    return transaction(async (trx) => {
      const r = await updateFollowUp(trx, orgId, id, input);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update', targetType: 'contact', targetId: r.contactId,
        detail: `Collection follow-up edited: ${input.note}`.slice(0, 500), payload: { followUpId: id, before: r.before }, ...auditMeta(req),
      });
      return { id: asId(id) };
    });
  },
  { permission: { module: 'sales', action: 'edit' } },
);

export const DELETE = route(
  async ({ orgId, user, req, params }) => {
    const id = idParam(params);
    return transaction(async (trx) => {
      const r = await deleteFollowUp(trx, orgId, id);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'delete', targetType: 'contact', targetId: r.contactId,
        detail: `Collection follow-up deleted: ${r.note}`.slice(0, 500), payload: { followUpId: id }, ...auditMeta(req),
      });
      return { deleted: true, id: asId(id) };
    });
  },
  { permission: { module: 'sales', action: 'edit' } },
);
