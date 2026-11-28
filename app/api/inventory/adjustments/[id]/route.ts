import { db, transaction } from '@/lib/server/db';
import { route, body, idParam, asId } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { AdjustInput, toAdjustment } from '@/lib/server/adjustment-input';
import { adjustmentForEdit, deleteAdjustment, updateAdjustment } from '@/lib/server/services/stock-changes';

// Edit and Delete on one stock adjustment (services/stock-changes.ts).
// Inventory has no "void" right of its own (lib/rbac.ts): whoever may adjust
// stock may correct or remove an adjustment.

/** The adjustment as entered: what its Edit window opens with. */
export const GET = route(
  async ({ orgId, params }) => adjustmentForEdit(db, orgId, idParam(params)),
  { permission: { module: 'inventory', action: 'view' } },
);

/** Edit: written again over its own row; refused while a piece it named has moved since. */
export const PUT = route(
  async ({ orgId, user, req, params }) => {
    const id = idParam(params);
    const input = await body(req, AdjustInput);
    return transaction(async (trx) => {
      const done = await updateAdjustment(trx, orgId, user.userId, id, toAdjustment(input));
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update',
        targetType: 'stock_adjustment', targetId: id, targetLabel: done.itemName,
        detail: `Edited stock adjustment: ${input.qtyDelta > 0 ? '+' : ''}${input.qtyDelta} ${done.itemName} (${input.reason}) on ${input.date}`,
        payload: { before: done.before, after: done.after }, ...auditMeta(req),
      });
      return { id: asId(id), valuePaise: done.valuePaise, warnings: done.warnings };
    });
  },
  { permission: { module: 'inventory', action: 'edit' } },
);

/** Delete: its quantity leaves the stock figures; the record of it is kept. */
export const DELETE = route(
  async ({ orgId, user, req, params }) => {
    const id = idParam(params);
    const reason = new URL(req.url).searchParams.get('reason');
    return transaction(async (trx) => {
      const gone = await deleteAdjustment(trx, orgId, user.userId, id, reason);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'delete',
        targetType: 'stock_adjustment', targetId: id, targetLabel: gone.itemName,
        detail: `Deleted stock adjustment of ${gone.qtyDelta > 0 ? '+' : ''}${gone.qtyDelta} ${gone.itemName}${reason ? ` — ${reason}` : ''}`,
        ...auditMeta(req),
      });
      return { deleted: true, warnings: gone.warnings };
    });
  },
  { permission: { module: 'inventory', action: 'edit' } },
);
