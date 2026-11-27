import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, asId } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { discardHeldJournal, indiaToday, listHeldJournals, releaseHeldJournal } from '@/lib/server/services/held-journals';

// Journals held out of the books: optional, post-dated, and awaiting approval.
// Approving and sending back go through /api/approvals with the other documents.

export const GET = route(
  async ({ orgId }) => ({ held: await listHeldJournals(db, orgId) }),
  { permission: { module: 'accountant', action: 'view' } },
);

const Input = z.object({
  // post-due: everything due today or earlier, now — the scheduler's run, by hand, for a server that runs none.
  action: z.enum(['post', 'discard', 'post-due']),
  id: z.union([z.string(), z.number()]).optional(),
  reason: z.string().max(500).nullish(),
});

export const POST = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, Input);
    if (input.action === 'post-due') {
      // Post-dated entries and auto-reversals whose date has come: what the
      // scheduler posts, done by hand where no scheduler runs. Each in its own
      // transaction, so one that cannot post (a locked period) leaves the rest.
      const due = await db.selectFrom('held_journals').select(['id', 'memo']).where('org_id', '=', orgId)
        .where('status', '=', 'held').where('kind', '=', 'post_dated').where('entry_date', '<=', indiaToday()).orderBy('entry_date').orderBy('id').execute();
      const r = { posted: 0, held: 0, failed: 0, errors: [] as string[] };
      for (const h of due) {
        try {
          await transaction(async (trx) => {
            const out = await releaseHeldJournal(trx, orgId, user.userId, h.id);
            await logAudit({
              trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'create',
              targetType: out.posted ? 'journal_entry' : 'held_journal', targetId: out.posted ? out.entry.id : h.id,
              detail: out.posted ? `Due entry H-${h.id} posted as JE #${out.entry.entryNo}: ${h.memo}` : `Due entry H-${h.id} sent for ${out.approverRole} approval`,
              ...auditMeta(req),
            });
            if (out.posted) r.posted++; else r.held++;
          });
        } catch (err) {
          r.failed++;
          r.errors.push(`H-${h.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return r;
    }
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
