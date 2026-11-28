import { z } from 'zod';
import { transaction } from '@/lib/server/db';
import { route, body, idParam, asId } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { deleteBatch, updateBatch } from '@/lib/server/services/stock-changes';

// One batch: its number and the dates on the pack corrected, or deleted once
// no document names it (services/stock-changes.ts).

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a yyyy-mm-dd date.');

export const PUT = route(
  async ({ orgId, user, req, params }) => {
    const id = idParam(params);
    const input = await body(req, z.object({
      batchNo: z.string().trim().min(1, 'Give the batch number.').max(40), mfgDate: DATE.nullish(), expiryDate: DATE.nullish(),
    }));
    return transaction(async (trx) => {
      const done = await updateBatch(trx, orgId, id, input);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update', targetType: 'batch', targetId: id, targetLabel: done.batchNo,
        detail: `Batch ${done.batchNo}: made ${input.mfgDate ?? '—'}, expires ${input.expiryDate ?? '—'}`, payload: { before: done.before, after: done.after }, ...auditMeta(req),
      });
      return { id: asId(id) };
    });
  },
  { permission: { module: 'inventory', action: 'edit' } },
);

export const DELETE = route(
  async ({ orgId, user, req, params }) => {
    const id = idParam(params);
    return transaction(async (trx) => {
      const gone = await deleteBatch(trx, orgId, id);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'delete', targetType: 'batch', targetId: id,
        targetLabel: gone.batchNo, detail: `Deleted batch ${gone.batchNo}, named on no document`, ...auditMeta(req),
      });
      return { deleted: true };
    });
  },
  { permission: { module: 'inventory', action: 'edit' } },
);
