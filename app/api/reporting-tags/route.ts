import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, query, asId, forbidden } from '@/lib/server/http';
import { hasPermission } from '@/lib/rbac';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { listTags, profitByTag, saveTag, setTags, tagsFor, TAGGABLE, type Taggable } from '@/lib/server/services/reporting-tags';

// Reporting tags (services/reporting-tags.ts): the tags, a document's tags,
// and the profit and loss cut by a tag.

const MODULE: Record<Taggable, string> = { invoice: 'sales', bill: 'purchases', expense: 'purchases', journal_entry: 'accountant' };
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const GET = route(async ({ orgId, role, req }) => {
  const q = query(req, z.object({
    entity: z.enum(TAGGABLE).optional(), id: z.coerce.number().int().positive().optional(),
    report: z.literal('profit').optional(), tagId: z.coerce.number().int().positive().optional(), from: DATE.optional(), to: DATE.optional(),
  }));
  if (q.report === 'profit' && q.tagId && q.from && q.to) {
    if (!hasPermission(role, 'reports.financial', 'view')) throw forbidden('You cannot see financial reports.');
    return profitByTag(db, orgId, q.tagId, q.from, q.to);
  }
  const tags = await listTags(db, orgId);
  if (q.entity && q.id) {
    if (!hasPermission(role, MODULE[q.entity], 'view')) throw forbidden('You cannot see that document.');
    return { tags, values: await tagsFor(db, orgId, q.entity, q.id) };
  }
  return { tags };
});

const Input = z.discriminatedUnion('action', [
  z.object({ action: z.literal('save'), id: z.union([z.string(), z.number()]).nullish(), name: z.string().trim().min(1).max(80), values: z.array(z.string().trim().max(80)).min(1).max(100), isActive: z.boolean().optional() }),
  z.object({ action: z.literal('assign'), entity: z.enum(TAGGABLE), id: z.union([z.string(), z.number()]), values: z.record(z.string(), z.string().nullable()) }),
]);

export const POST = route(async ({ orgId, user, role, req }) => {
  const input = await body(req, Input);
  if (input.action === 'save') {
    if (!hasPermission(role, 'settings', 'edit')) throw forbidden('Only an admin can change reporting tags.');
    const id = await transaction(async (trx) => {
      const tid = await saveTag(trx, orgId, { id: input.id ? Number(input.id) : null, name: input.name, values: input.values, isActive: input.isActive });
      await logAudit({ trx, orgId, actorUserId: user.userId, actorName: user.name, action: input.id ? 'update' : 'create', targetType: 'reporting_tag', targetId: tid, targetLabel: input.name, detail: `Values: ${input.values.join(', ')}`, ...auditMeta(req) });
      return tid;
    });
    return { id: asId(id) };
  }
  if (!hasPermission(role, MODULE[input.entity], 'edit')) throw forbidden('You cannot change that document.');
  await transaction(async (trx) => {
    await setTags(trx, orgId, input.entity, Number(input.id), input.values);
    await logAudit({ trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update', targetType: input.entity, targetId: Number(input.id), detail: 'Reporting tags changed', ...auditMeta(req) });
  });
  return { ok: true };
});
