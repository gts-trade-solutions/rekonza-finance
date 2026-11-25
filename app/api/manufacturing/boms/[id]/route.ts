import { z } from 'zod';
import { transaction } from '@/lib/server/db';
import { route, body, idParam, asId } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { deleteBom, setBomActive } from '@/lib/server/services/stock-changes';

// A bill of materials: marked in or out of use, or deleted while nothing was
// made from it (services/stock-changes.ts). Its Edit is the POST 'bom' action.

export const PATCH = route(
  async ({ orgId, user, req, params }) => {
    const id = idParam(params);
    const input = await body(req, z.object({ isActive: z.boolean() }));
    return transaction(async (trx) => {
      await setBomActive(trx, orgId, id, input.isActive);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update', targetType: 'bom', targetId: id,
        detail: input.isActive ? 'Bill of materials back in use' : 'Bill of materials marked not in use', ...auditMeta(req),
      });
      return { id: asId(id), isActive: input.isActive };
    });
  },
  { permission: { module: 'inventory', action: 'edit' } },
);

export const DELETE = route(
  async ({ orgId, user, req, params }) => {
    const id = idParam(params);
    return transaction(async (trx) => {
      const gone = await deleteBom(trx, orgId, id);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'delete', targetType: 'bom', targetId: id,
        targetLabel: gone.label, detail: `Deleted bill of materials ${gone.label}`, ...auditMeta(req),
      });
      return { deleted: true };
    });
  },
  { permission: { module: 'inventory', action: 'edit' } },
);
