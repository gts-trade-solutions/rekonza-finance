import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, query } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { listDuplicateReviews, reviewDuplicate, scanForDuplicates } from '@/lib/server/services/duplicate-reviews';

// The Possible duplicate bills register (services/duplicate-reviews.ts): read
// it, clear or confirm an entry with a note, or scan the bills already entered.

export const GET = route(
  async ({ orgId, req }) => {
    const q = query(req, z.object({ status: z.enum(['open', 'cleared', 'confirmed', 'all']).optional() }));
    return listDuplicateReviews(db, orgId, { status: q.status ?? 'all' });
  },
  { permission: { module: 'purchases', action: 'view' } },
);

const Input = z.discriminatedUnion('action', [
  z.object({ action: z.literal('scan') }),
  z.object({
    action: z.enum(['clear', 'confirm', 'reopen']),
    id: z.union([z.string(), z.number()]).transform(Number),
    note: z.string().trim().max(500).nullish(),
  }),
]);

export const POST = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, Input);
    return transaction(async (trx) => {
      if (input.action === 'scan') {
        const added = await scanForDuplicates(trx, orgId, user.userId);
        await logAudit({
          trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update', targetType: 'duplicate_review',
          detail: `Scanned the bills for possible duplicates: ${added} new on the register`, ...auditMeta(req),
        });
        return { added };
      }
      const r = await reviewDuplicate(trx, orgId, user.userId, input.id, input.action, input.note);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update', targetType: 'duplicate_review', targetId: input.id,
        detail: `Possible duplicate ${r.docType} #${r.docId}: ${r.status}${input.note ? ` — ${input.note}` : ''}`, ...auditMeta(req),
      });
      return r;
    });
  },
  { permission: { module: 'purchases', action: 'edit' } },
);
