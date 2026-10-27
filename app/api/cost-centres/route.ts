import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, query, asId, forbidden } from '@/lib/server/http';
import { hasPermission } from '@/lib/rbac';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { costCentrePnl, listCostCentres, saveCostCentre } from '@/lib/server/services/cost-centres';

// Cost centres: the list (for the pickers on documents, so open to anyone
// signed in), and the profit and loss by centre (a financial report).

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const GET = route(async ({ orgId, role, req }) => {
  const q = query(req, z.object({ from: DATE.optional(), to: DATE.optional() }));
  const centres = await listCostCentres(db, orgId);
  if (!q.from || !q.to) return { centres };
  if (!hasPermission(role, 'reports.financial', 'view')) throw forbidden('Your role does not include the financial statements.');
  return { centres, columns: await costCentrePnl(db, orgId, q.from, q.to) };
});

const Input = z.object({
  id: z.union([z.string(), z.number()]).transform(Number).nullish(),
  code: z.string().max(20), name: z.string().max(100), category: z.string().max(60).nullish(), isActive: z.boolean().optional(),
});

export const POST = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, Input);
    return transaction(async (trx) => {
      const id = await saveCostCentre(trx, orgId, input);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: input.id ? 'update' : 'create',
        targetType: 'cost_centre', targetId: id, targetLabel: input.name, detail: `${input.code} ${input.name}${input.category ? ` (${input.category})` : ''}`, ...auditMeta(req),
      });
      return { id: asId(id) };
    });
  },
  { permission: { module: 'accountant', action: 'edit' } },
);
