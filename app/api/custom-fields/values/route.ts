import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, query, forbidden, notFound } from '@/lib/server/http';
import { hasPermission } from '@/lib/rbac';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { CUSTOM_FIELD_ENTITIES, getValues, setValues, type CustomFieldEntity } from '@/lib/server/services/custom-fields';
import type { RoleName } from '@/lib/types';

// A record's custom field values. Reading or changing them needs the rights
// on the record itself: a customer's are sales', a bill's purchasing's.

const TABLE: Record<CustomFieldEntity, 'contacts' | 'items' | 'invoices' | 'estimates' | 'sales_orders' | 'bills' | 'purchase_orders' | 'expenses' | 'projects'> = {
  contact: 'contacts', item: 'items', invoice: 'invoices', estimate: 'estimates', sales_order: 'sales_orders',
  bill: 'bills', purchase_order: 'purchase_orders', expense: 'expenses', project: 'projects',
};
const MODULES: Record<CustomFieldEntity, string[]> = {
  contact: ['sales', 'purchases'], item: ['sales', 'inventory'], invoice: ['sales'], estimate: ['sales'], sales_order: ['sales'],
  bill: ['purchases'], purchase_order: ['purchases'], expense: ['purchases'], project: ['projects'],
};

async function check(orgId: number, role: RoleName, entity: CustomFieldEntity, id: number, action: 'view' | 'edit') {
  if (!MODULES[entity].some((m) => hasPermission(role, m, action))) throw forbidden(action === 'view' ? 'You cannot see that record.' : 'You cannot change that record.');
  const found = await db.selectFrom(TABLE[entity]).select('id').where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
  if (!found) throw notFound('That record does not exist.');
}

export const GET = route(async ({ orgId, role, req }) => {
  const q = query(req, z.object({ entity: z.enum(CUSTOM_FIELD_ENTITIES), id: z.coerce.number().int().positive() }));
  await check(orgId, role, q.entity, q.id, 'view');
  const values = await getValues(db, orgId, q.entity, q.id);
  return { values: values.map((v) => ({ ...v, fieldId: String(v.fieldId) })) };
});

const PutInput = z.object({
  entity: z.enum(CUSTOM_FIELD_ENTITIES),
  id: z.union([z.string(), z.number()]),
  values: z.record(z.string(), z.union([z.string().max(1000), z.number(), z.boolean(), z.null()])),
});

export const PUT = route(async ({ orgId, user, role, req }) => {
  const input = await body(req, PutInput);
  const id = Number(input.id);
  await check(orgId, role, input.entity, id, 'edit');
  await transaction(async (trx) => {
    await setValues(trx, orgId, input.entity, id, input.values);
    await logAudit({
      trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update', targetType: input.entity, targetId: id,
      detail: `Custom fields: ${Object.entries(input.values).map(([k, v]) => `${k} = ${v ?? '—'}`).join(', ')}`.slice(0, 1000), ...auditMeta(req),
    });
  });
  return { ok: true };
});
