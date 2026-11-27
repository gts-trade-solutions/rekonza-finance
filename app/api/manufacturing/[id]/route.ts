import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, idParam, asId } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { deleteProduction, productionForEdit, updateProduction } from '@/lib/server/services/stock-changes';

// Edit and Delete on one production run (services/stock-changes.ts).

export const GET = route(
  async ({ orgId, params }) => productionForEdit(db, orgId, idParam(params)),
  { permission: { module: 'inventory', action: 'view' } },
);

const EditInput = z.object({
  bomId: z.coerce.number().int().positive(), qty: z.number().positive(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), branchId: z.coerce.number().int().positive(), warehouseId: z.coerce.number().int().positive().nullish(),
  overheadPaise: z.number().int().min(0).optional(), notes: z.string().max(300).nullish(),
});

/** Edit: costed afresh as if recorded now, written over its own row and number. */
export const PUT = route(
  async ({ orgId, user, req, params }) => {
    const id = idParam(params);
    const input = await body(req, EditInput);
    return transaction(async (trx) => {
      const r = await updateProduction(trx, orgId, user.userId, id, input);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update', targetType: 'production', targetId: id, targetLabel: r.number,
        detail: `Edited ${r.number}: ${input.qty} made at ₹${(r.costPaise / 100).toLocaleString('en-IN')}`, payload: { before: r.before }, ...auditMeta(req),
      });
      return { id: asId(id), number: r.number, costPaise: r.costPaise, unitCostPaise: r.unitCostPaise, warnings: r.warnings };
    });
  },
  { permission: { module: 'inventory', action: 'edit' } },
);

/** Delete: its components back in stock, the goods it made gone; the record of it is kept. */
export const DELETE = route(
  async ({ orgId, user, req, params }) => {
    const id = idParam(params);
    const reason = new URL(req.url).searchParams.get('reason');
    return transaction(async (trx) => {
      const gone = await deleteProduction(trx, orgId, user.userId, id, reason);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'delete', targetType: 'production', targetId: id,
        targetLabel: gone.number, detail: `Deleted production run ${gone.number}${reason ? ` — ${reason}` : ''}`, ...auditMeta(req),
      });
      return { deleted: true, number: gone.number, warnings: gone.warnings };
    });
  },
  { permission: { module: 'inventory', action: 'edit' } },
);
