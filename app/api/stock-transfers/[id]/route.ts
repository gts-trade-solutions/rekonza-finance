import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, idParam, asId } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { deleteTransfer, transferForEdit, updateTransfer } from '@/lib/server/services/stock-changes';

// Edit and Delete on one stock transfer (services/stock-changes.ts).

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a yyyy-mm-dd date.');

export const GET = route(
  async ({ orgId, params }) => transferForEdit(db, orgId, idParam(params)),
  { permission: { module: 'inventory', action: 'view' } },
);

const EditInput = z.object({
  fromWarehouseId: z.coerce.number().int().positive(), toWarehouseId: z.coerce.number().int().positive(), date,
  /** A received transfer: the day it arrived. */
  receivedDate: date.nullish(),
  lines: z.array(z.object({ itemId: z.coerce.number().int().positive(), qty: z.number().positive() })).min(1, 'Add the items being moved.'),
  vehicleNo: z.string().trim().max(20).nullish(), ewayBillNo: z.string().trim().max(20).nullish(), notes: z.string().trim().max(300).nullish(),
});

/** Edit, in transit or received: the same number, written again over its own row. */
export const PUT = route(
  async ({ orgId, user, req, params }) => {
    const id = idParam(params);
    const input = await body(req, EditInput);
    return transaction(async (trx) => {
      const done = await updateTransfer(trx, orgId, id, input);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update', targetType: 'stock_transfer', targetId: id,
        targetLabel: done.number, detail: `Edited stock transfer ${done.number}`, payload: { before: done.before }, ...auditMeta(req),
      });
      return { id: asId(id), number: done.number, warnings: done.warnings };
    });
  },
  { permission: { module: 'inventory', action: 'edit' } },
);

/** Delete: the goods are where they were before it; the record of it is kept. */
export const DELETE = route(
  async ({ orgId, user, req, params }) => {
    const id = idParam(params);
    const reason = new URL(req.url).searchParams.get('reason');
    return transaction(async (trx) => {
      const gone = await deleteTransfer(trx, orgId, user.userId, id, reason);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'delete', targetType: 'stock_transfer', targetId: id,
        targetLabel: gone.number, detail: `Deleted stock transfer ${gone.number}${reason ? ` — ${reason}` : ''}`, ...auditMeta(req),
      });
      return { deleted: true, number: gone.number, warnings: gone.warnings };
    });
  },
  { permission: { module: 'inventory', action: 'edit' } },
);
