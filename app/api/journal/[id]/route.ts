import { transaction } from '@/lib/server/db';
import { route, body, idParam, asId } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { deleteJournal, editJournal } from '@/lib/server/services/journals';
import { JournalInput, toJournalInput } from '@/lib/server/journal-input';

// Zoho Books' Edit and Delete on a manual journal. The entry itself is never
// changed: Edit reverses it on its own date and posts the corrected one;
// Delete reverses it (services/journals.ts).

export const PUT = route(
  async ({ orgId, user, branchId, req, params }) => {
    const id = idParam(params);
    const input = await body(req, JournalInput);
    const done = await transaction(async (trx) => {
      const made = await editJournal(trx, orgId, user.userId, id, toJournalInput(input, branchId));
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update',
        targetType: 'journal_entry', targetId: id, targetLabel: `#${made.replacedEntryNo}`,
        detail: `Edited journal #${made.replacedEntryNo}: now #${made.entry.entryNo}`, payload: { before: made.before }, ...auditMeta(req),
      });
      return made;
    });
    return { id: asId(done.entry.id), entryNo: done.entry.entryNo, replacedEntryNo: done.replacedEntryNo };
  },
  { permission: { module: 'accountant', action: 'edit' } },
);

export const DELETE = route(
  async ({ orgId, user, req, params }) => {
    const id = idParam(params);
    const reason = new URL(req.url).searchParams.get('reason');
    const done = await transaction(async (trx) => {
      const gone = await deleteJournal(trx, orgId, user.userId, id, reason);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'delete',
        targetType: 'journal_entry', targetId: id, targetLabel: `#${gone.entryNo}`,
        detail: `Deleted journal #${gone.entryNo} (reversed by #${gone.reversalNo})`, ...auditMeta(req),
      });
      return gone;
    });
    return { deleted: true, entryNo: done.entryNo };
  },
  { permission: { module: 'accountant', action: 'void' } },
);
