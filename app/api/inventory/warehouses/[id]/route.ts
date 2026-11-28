import { z } from 'zod';
import { transaction } from '@/lib/server/db';
import { route, body, idParam, asId } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { deleteWarehouse, updateWarehouse } from '@/lib/server/services/stock-changes';

// One warehouse (godown): edited, made the default, marked inactive, or
// deleted while no document names it (services/stock-changes.ts).

const EditInput = z.object({
  name: z.string().trim().min(1, 'A warehouse needs a name.').max(150),
  code: z.string().trim().max(20).nullish(),
  address: z.string().trim().max(500).nullish(),
  branchId: z.union([z.string(), z.number()]).nullish(),
  isPrimary: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

export const PATCH = route(
  async ({ orgId, user, req, params }) => {
    const id = idParam(params);
    const input = await body(req, EditInput);
    return transaction(async (trx) => {
      const done = await updateWarehouse(trx, orgId, id, { ...input, branchId: input.branchId ? Number(input.branchId) : null });
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update', targetType: 'warehouse', targetId: id, targetLabel: done.name,
        detail: `Warehouse ${done.name}${input.isActive === false ? ' marked inactive' : input.isActive ? ' in use' : ''}${input.isPrimary ? ', made the default' : ''}`,
        payload: { before: done.before, after: done.after }, ...auditMeta(req),
      });
      return { id: asId(id), name: done.name };
    });
  },
  { permission: { module: 'inventory', action: 'edit' } },
);

export const DELETE = route(
  async ({ orgId, user, req, params }) => {
    const id = idParam(params);
    return transaction(async (trx) => {
      const gone = await deleteWarehouse(trx, orgId, id);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'delete', targetType: 'warehouse', targetId: id,
        targetLabel: gone.name, detail: `Deleted warehouse ${gone.name}, named on no document`, ...auditMeta(req),
      });
      return { deleted: true };
    });
  },
  { permission: { module: 'inventory', action: 'edit' } },
);
