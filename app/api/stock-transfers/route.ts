import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { cancelTransfer, createTransfer, listTransfers, receiveTransfer } from '@/lib/server/services/stock-transfers';

// Stock moved between godowns and branches. See services/stock-transfers.ts.

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const GET = route(
  async ({ orgId }) => {
    const [transfers, warehouses] = await Promise.all([
      listTransfers(db, orgId),
      db.selectFrom('warehouses').select(['id', 'name']).where('org_id', '=', orgId).where('is_active', '=', 1).orderBy('name').execute(),
    ]);
    return { transfers, warehouses: warehouses.map((w) => ({ id: String(w.id), name: w.name })) };
  },
  { permission: { module: 'inventory', action: 'view' } },
);

const Input = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('create'),
    fromWarehouseId: z.coerce.number().int().positive(), toWarehouseId: z.coerce.number().int().positive(), date,
    lines: z.array(z.object({ itemId: z.coerce.number().int().positive(), qty: z.number().positive() })).min(1),
    vehicleNo: z.string().trim().max(20).nullish(), ewayBillNo: z.string().trim().max(20).nullish(), notes: z.string().trim().max(300).nullish(),
  }),
  z.object({ action: z.literal('receive'), id: z.coerce.number().int().positive(), date }),
  z.object({ action: z.literal('cancel'), id: z.coerce.number().int().positive() }),
]);

export const POST = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, Input);
    return transaction(async (trx) => {
      if (input.action === 'create') {
        const t = await createTransfer(trx, orgId, user.userId, input);
        await logAudit({
          trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'create', targetType: 'stock_transfer',
          targetId: t.id, targetLabel: t.number, detail: `Stock transfer ${t.number} dispatched on ${input.date}`, ...auditMeta(req),
        });
        return { id: String(t.id), number: t.number, warnings: t.warnings };
      }
      if (input.action === 'receive') await receiveTransfer(trx, orgId, input.id, input.date);
      else await cancelTransfer(trx, orgId, input.id);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: input.action === 'cancel' ? 'void' : 'update',
        targetType: 'stock_transfer', targetId: input.id, targetLabel: String(input.id),
        detail: input.action === 'receive' ? `Stock transfer received on ${input.date}` : 'Stock transfer cancelled', ...auditMeta(req),
      });
      return { ok: true };
    });
  },
  { permission: { module: 'inventory', action: 'edit' } },
);
