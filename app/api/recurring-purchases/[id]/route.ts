import { transaction } from '@/lib/server/db';
import { route, body, idParam, asId } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { RecurringPurchaseBody } from '@/lib/server/recurring-purchase-input';
import { deleteRecurringPurchase, updateRecurringPurchase } from '@/lib/server/services/recurring-purchases';

// Edit and Delete on one recurring bill or expense profile
// (services/recurring-purchases.ts). What it already raised stays as it is.

export const PUT = route(
  async ({ orgId, user, req, params }) => {
    const id = idParam(params);
    const input = await body(req, RecurringPurchaseBody);
    return transaction(async (trx) => {
      const r = await updateRecurringPurchase(trx, orgId, id, input);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update',
        targetType: 'recurring_purchase', targetId: id, targetLabel: r.name,
        detail: `Recurring ${input.kind} edited: ${input.frequency}, next run ${r.nextRun}`, payload: { before: r.before, after: r.after }, ...auditMeta(req),
      });
      return { id: asId(id), name: r.name, nextRun: r.nextRun };
    });
  },
  { permission: { module: 'purchases', action: 'edit' } },
);

export const DELETE = route(
  async ({ orgId, user, req, params }) => {
    const id = idParam(params);
    const reason = new URL(req.url).searchParams.get('reason');
    return transaction(async (trx) => {
      const r = await deleteRecurringPurchase(trx, orgId, id);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'delete',
        targetType: 'recurring_purchase', targetId: id, targetLabel: r.name,
        detail: `Recurring ${r.kind} profile deleted${reason ? ` — ${reason}` : ''}. The ${r.raised} it raised stay as they are.`, ...auditMeta(req),
      });
      return { deleted: true, name: r.name };
    });
  },
  { permission: { module: 'purchases', action: 'void' } },
);
