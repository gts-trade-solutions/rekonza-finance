import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, query, idParam } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { deletePlan, getPlan } from '@/lib/server/reports/budget-plans';

// One budget: its settings and every amount (GET), or Delete it — the plan
// only; the ledger does not move.

export const GET = route(
  async ({ orgId, params }) => getPlan(db, orgId, idParam(params)),
  { permission: { module: 'accountant', action: 'view' } },
);

export const DELETE = route(
  async ({ orgId, user, req, params }) => {
    const id = idParam(params);
    const q = query(req, z.object({ reason: z.string().max(300).optional() }));
    return transaction(async (trx) => {
      const gone = await deletePlan(trx, orgId, id);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'delete', targetType: 'budget_plan', targetId: id,
        targetLabel: `${gone.name} (FY ${gone.fyLabel})`, detail: `Deleted the budget "${gone.name}" for FY ${gone.fyLabel}`, reason: q.reason ?? null,
        ...auditMeta(req),
      });
      return { deleted: true };
    });
  },
  { permission: { module: 'accountant', action: 'void' } },
);
