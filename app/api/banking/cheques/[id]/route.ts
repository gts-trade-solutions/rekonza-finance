import { z } from 'zod';
import { transaction } from '@/lib/server/db';
import { route, body, idParam, asId } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { deleteCheque, editCheque } from '@/lib/server/services/banking-changes';

// Edit and Delete on a cheque in the register (services/banking-changes.ts):
// edited while it is in hand or deposited; deleted unless it has cleared (the
// record of its payment) or come back (its return posted).

const Input = z.object({
  kind: z.enum(['issued', 'received']),
  contactId: z.union([z.string(), z.number()]).transform(Number),
  chequeNo: z.string().trim().min(1, 'A cheque number is required.').max(20),
  bankName: z.string().trim().max(120).nullish(),
  amountPaise: z.number().int().positive('Enter an amount above zero.'),
  maturityDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a yyyy-mm-dd date.'),
  notes: z.string().trim().max(500).nullish(),
});

export const PUT = route(
  async ({ orgId, user, req, params }) => {
    const id = idParam(params);
    const input = await body(req, Input);
    await transaction(async (trx) => {
      const r = await editCheque(trx, orgId, id, input);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update', targetType: 'cheque', targetId: id, targetLabel: r.chequeNo,
        detail: `Cheque ${r.chequeNo} edited: ${(input.amountPaise / 100).toFixed(2)}, matures ${input.maturityDate}`, payload: { before: r.before, after: r.after }, ...auditMeta(req),
      });
    });
    return { id: asId(id) };
  },
  { permission: { module: 'banking', action: 'edit' } },
);

export const DELETE = route(
  async ({ orgId, user, req, params }) => {
    const id = idParam(params);
    const reason = new URL(req.url).searchParams.get('reason');
    await transaction(async (trx) => {
      const gone = await deleteCheque(trx, orgId, id);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'delete', targetType: 'cheque', targetId: id, targetLabel: gone.chequeNo,
        detail: `Deleted cheque ${gone.chequeNo} of ${(gone.amountPaise / 100).toFixed(2)}${reason ? ` — ${reason}` : ''}`, ...auditMeta(req),
      });
    });
    return { deleted: true };
  },
  { permission: { module: 'banking', action: 'void' } },
);
