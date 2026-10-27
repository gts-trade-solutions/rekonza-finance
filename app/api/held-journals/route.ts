import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, asId } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { discardHeldJournal, listHeldJournals, releaseHeldJournal } from '@/lib/server/services/held-journals';

// Journals held out of the books: optional, post-dated, and awaiting approval.
// Approving and sending back go through /api/approvals with the other documents.

export const GET = route(
  async ({ orgId }) => ({ held: await listHeldJournals(db, orgId) }),
  { permission: { module: 'accountant', action: 'view' } },
);

const Input = z.object({
  action: z.enum(['post', 'discard']),
  id: z.union([z.string(), z.number()]),
  reason: z.string().max(500).nullish(),
});

export const POST = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, Input);
    const id = Number(input.id);
    return transaction(async (trx) => {
      if (input.action === 'discard') {
        await discardHeldJournal(trx, orgId, user.userId, id, input.reason);
        await logAudit({
          trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'void',
          targetType: 'held_journal', targetId: id, targetLabel: `Held entry H-${id}`,
          detail: `Discarded without posting${input.reason ? `: ${input.reason}` : ''}`, ...auditMeta(req),
        });
        return { id: asId(id), status: 'discarded' as const };
      }
      const r = await releaseHeldJournal(trx, orgId, user.userId, id);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'create',
        targetType: r.posted ? 'journal_entry' : 'held_journal', targetId: r.posted ? r.entry.id : id,
        detail: r.posted ? `Held entry H-${id} posted as JE #${r.entry.entryNo}` : `Held entry H-${id} sent for ${r.approverRole} approval`,
        ...auditMeta(req),
      });
      return r.posted
        ? { id: asId(id), status: 'posted' as const, entryNo: r.entry.entryNo }
        : { id: asId(id), status: 'approval' as const, approverRole: r.approverRole };
    });
  },
  { permission: { module: 'accountant', action: 'create' } },
);
