import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, query, asId } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { CUSTOM_FIELD_ENTITIES, listFields, saveField } from '@/lib/server/services/custom-fields';

// Custom field definitions (services/custom-fields.ts). Anyone signed in reads
// them, since every form draws its boxes from them; Settings changes them.

export const GET = route(async ({ orgId, req }) => {
  const q = query(req, z.object({ entity: z.enum(CUSTOM_FIELD_ENTITIES).optional(), active: z.coerce.boolean().optional() }));
  const fields = await listFields(db, orgId, q.entity, q.active);
  return { fields: fields.map((f) => ({ ...f, id: asId(f.id) })) };
});

const SaveInput = z.object({
  id: z.union([z.string(), z.number()]).nullish(),
  entity: z.enum(CUSTOM_FIELD_ENTITIES),
  label: z.string().trim().min(1).max(100),
  type: z.enum(['text', 'number', 'date', 'select', 'checkbox']),
  options: z.array(z.string().trim().max(100)).max(50).optional(),
  required: z.boolean().optional(),
  showOnPdf: z.boolean().optional(),
  order: z.number().int().min(0).max(999).optional(),
  isActive: z.boolean().optional(),
});

export const POST = route(
  async ({ orgId, user, req }) => {
    const input = await body(req, SaveInput);
    const fid = await transaction(async (trx) => {
      const saved = await saveField(trx, orgId, { ...input, id: input.id ? Number(input.id) : null });
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: input.id ? 'update' : 'create',
        targetType: 'custom_field', targetId: saved, targetLabel: input.label,
        detail: `${input.entity} field, ${input.type}${input.required ? ', required' : ''}${input.isActive === false ? ', switched off' : ''}`, ...auditMeta(req),
      });
      return saved;
    });
    return { id: asId(fid) };
  },
  { permission: { module: 'settings', action: 'edit' } },
);
