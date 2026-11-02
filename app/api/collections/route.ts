import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, query, asId } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { indiaToday } from '@/lib/server/services/held-journals';
import { collectionsWorkbench, followUpsFor, logFollowUp } from '@/lib/server/services/collections';

// Collections (services/collections.ts): who owes what overdue, the chase so
// far, and logging the next call.

export const GET = route(
  async ({ orgId, req }) => {
    const q = query(req, z.object({ contactId: z.coerce.number().int().positive().optional() }));
    if (q.contactId) return { followUps: await followUpsFor(db, orgId, q.contactId) };
    const today = indiaToday();
    return { today, rows: await collectionsWorkbench(db, orgId, today) };
  },
  { permission: { module: 'sales', action: 'view' } },
);

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Input = z.object({
  contactId: z.union([z.string(), z.number()]),
  invoiceId: z.union([z.string(), z.number()]).nullish(),
  kind: z.enum(['call', 'email', 'whatsapp', 'visit', 'note']),
  note: z.string().trim().min(1, 'Say what happened.').max(1000),
  promisedDate: DATE.nullish(),
  promisedPaise: z.number().int().positive().nullish(),
  nextFollowup: DATE.nullish(),
});

export const POST = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, Input);
    const id = await transaction(async (trx) => {
      const fid = await logFollowUp(trx, orgId, { id: user.userId, name: user.name }, {
        ...input, contactId: Number(input.contactId), invoiceId: input.invoiceId ? Number(input.invoiceId) : null,
      });
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'comment', targetType: 'contact', targetId: Number(input.contactId),
        detail: `Collection ${input.kind}: ${input.note}${input.promisedDate ? ` · promised ${input.promisedDate}` : ''}`.slice(0, 500), ...auditMeta(req),
      });
      return fid;
    });
    return { id: asId(id) };
  },
  { permission: { module: 'sales', action: 'create' } },
);
