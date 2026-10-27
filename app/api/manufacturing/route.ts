import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { listBoms, listProductions, recordProduction, saveBom, voidProduction } from '@/lib/server/services/manufacturing';

// Bills of materials and production. See services/manufacturing.ts.

export const GET = route(
  async ({ orgId }) => {
    const [boms, productions] = await Promise.all([listBoms(db, orgId), listProductions(db, orgId)]);
    return { boms, productions };
  },
  { permission: { module: 'inventory', action: 'view' } },
);

const Input = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('bom'), id: z.coerce.number().int().positive().optional(),
    itemId: z.coerce.number().int().positive(), name: z.string().trim().max(100), outputQty: z.number().positive(),
    isActive: z.boolean().optional(), notes: z.string().max(300).nullish(),
    lines: z.array(z.object({ itemId: z.coerce.number().int().positive(), qty: z.number().positive() })).min(1),
  }),
  z.object({
    action: z.literal('produce'), bomId: z.coerce.number().int().positive(), qty: z.number().positive(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), branchId: z.coerce.number().int().positive(), warehouseId: z.coerce.number().int().positive().nullish(),
    overheadPaise: z.number().int().min(0).optional(), notes: z.string().max(300).nullish(),
  }),
  z.object({ action: z.literal('void'), id: z.coerce.number().int().positive() }),
]);

export const POST = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, Input);
    return transaction(async (trx) => {
      const audit = (targetType: string, id: number, label: string, detail: string) => logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: input.action === 'void' ? 'void' : 'create',
        targetType, targetId: id, targetLabel: label, detail, ...auditMeta(req),
      });
      if (input.action === 'bom') {
        const id = await saveBom(trx, orgId, input, input.id);
        await audit('bom', id, input.name, `Bill of materials ${input.name} saved, ${input.lines.length} component(s)`);
        return { id: String(id) };
      }
      if (input.action === 'produce') {
        const r = await recordProduction(trx, orgId, user.userId, input);
        await audit('production', r.id, r.number, `${r.number}: ${input.qty} made at ₹${(r.costPaise / 100).toLocaleString('en-IN')}`);
        return { id: String(r.id), number: r.number, costPaise: r.costPaise, unitCostPaise: r.unitCostPaise, warnings: r.warnings };
      }
      await voidProduction(trx, orgId, input.id);
      await audit('production', input.id, String(input.id), 'Production voided');
      return { ok: true };
    });
  },
  { permission: { module: 'inventory', action: 'edit' } },
);
