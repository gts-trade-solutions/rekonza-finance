import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, idParam, asId } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { deleteVendorCredit, updateVendorCredit, vendorCreditForEdit } from '@/lib/server/services/purchase-changes';

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a yyyy-mm-dd date.');
const toNum = (v: string | number | null | undefined) => (v === null || v === undefined || v === '' ? null : Number(v));

/** One vendor credit as it was entered: what its Edit window opens with. */
export const GET = route(
  async ({ orgId, params }) => vendorCreditForEdit(db, orgId, idParam(params)),
  { permission: { module: 'purchases', action: 'view' } },
);

const EditInput = z.object({
  branchId: z.union([z.string(), z.number()]),
  vendorId: z.union([z.string(), z.number()]),
  date: DATE,
  reason: z.string().trim().min(1, 'Say why the supplier is crediting you.').max(200),
  againstBillId: z.union([z.string(), z.number()]).nullish(),
  amountPaise: z.number().int().positive(),
  gstRatePct: z.number().min(0).max(50).optional(),
  itcClaimed: z.boolean().optional(),
  applyImmediately: z.boolean().optional(),
});

/**
 * Edit, as Zoho Books' Edit: the credit's entry is reversed, it is taken off
 * its bill, and it is written again in place under the same number (and set
 * against the bill again). Refused once refunded.
 */
export const PUT = route(
  async ({ orgId, user, req, params }) => {
    const id = idParam(params);
    const input = await body(req, EditInput);
    const done = await transaction(async (trx) => {
      const made = await updateVendorCredit(trx, orgId, user.userId, id, {
        branchId: Number(input.branchId), vendorId: Number(input.vendorId), date: input.date, reason: input.reason,
        againstBillId: toNum(input.againstBillId), amountPaise: input.amountPaise, gstRatePct: input.gstRatePct,
        itcClaimed: input.itcClaimed, applyImmediately: input.applyImmediately,
      });
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update',
        targetType: 'vendor-credit', targetId: id, targetLabel: made.number,
        detail: `Edited vendor credit ${made.number}`, payload: { before: made.before }, ...auditMeta(req),
      });
      return made;
    });
    return {
      id: asId(done.id), number: done.number, totalPaise: done.totalPaise,
      journalEntryId: done.journalEntryId === null ? null : asId(done.journalEntryId),
    };
  },
  { permission: { module: 'purchases', action: 'edit' } },
);

/** Delete, as Zoho Books' Delete: the entry reversed, the credit taken off its bill, the record kept. */
export const DELETE = route(
  async ({ orgId, user, req, params }) => {
    const id = idParam(params);
    const reason = new URL(req.url).searchParams.get('reason');
    const done = await transaction(async (trx) => {
      const gone = await deleteVendorCredit(trx, orgId, user.userId, id, reason);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'delete',
        targetType: 'vendor-credit', targetId: id, targetLabel: gone.number,
        detail: `Deleted vendor credit ${gone.number}${reason ? ` — ${reason}` : ''}`, ...auditMeta(req),
      });
      return gone;
    });
    return { deleted: true, number: done.number };
  },
  { permission: { module: 'purchases', action: 'void' } },
);
