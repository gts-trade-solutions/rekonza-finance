import { z } from 'zod';
import { transaction } from '@/lib/server/db';
import { route, body, idParam, asId } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { deleteTransfer, editTransfer } from '@/lib/server/services/banking-changes';

// Edit and Delete on a transfer between two of the business's own accounts
// (services/banking-changes.ts). The entry is never changed: Edit reverses it
// on its own date and posts the corrected one; Delete reverses it. Refused
// while a bank statement line is matched to the transfer.

const Input = z.object({
  fromBankAccountId: z.union([z.string(), z.number()]).transform(Number),
  toBankAccountId: z.union([z.string(), z.number()]).transform(Number),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a yyyy-mm-dd date.'),
  amountPaise: z.number().int().positive('Enter an amount above zero.'),
  reference: z.string().max(100).nullish(),
});

export const PUT = route(
  async ({ orgId, user, req, params }) => {
    const id = idParam(params);
    const input = await body(req, Input);
    const done = await transaction(async (trx) => {
      const r = await editTransfer(trx, orgId, user.userId, id, input);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update', targetType: 'bank_transfer', targetId: id,
        detail: `Transfer edited: ${(input.amountPaise / 100).toFixed(2)} on ${input.date} (now entry #${r.entryNo}; the old one reversed)`,
        payload: { before: r.before, after: r.after }, ...auditMeta(req),
      });
      return r;
    });
    return { id: asId(id), entryNo: done.entryNo, warnings: done.warnings };
  },
  { permission: { module: 'banking', action: 'edit' } },
);

export const DELETE = route(
  async ({ orgId, user, req, params }) => {
    const id = idParam(params);
    const reason = new URL(req.url).searchParams.get('reason');
    await transaction(async (trx) => {
      const gone = await deleteTransfer(trx, orgId, user.userId, id, reason);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'delete', targetType: 'bank_transfer', targetId: id,
        detail: `Deleted the transfer of ${(gone.amountPaise / 100).toFixed(2)} on ${gone.date}; its entry reversed${reason ? ` — ${reason}` : ''}`, ...auditMeta(req),
      });
    });
    return { deleted: true };
  },
  { permission: { module: 'banking', action: 'void' } },
);
