import { z } from 'zod';
import { db } from '@/lib/server/db';
import { route, body, idParam, notFound } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish().or(z.literal('').transform(() => null));
const Input = z.object({
  title: z.string().trim().min(2).max(200).optional(),
  category: z.enum(['contract', 'agreement', 'certificate', 'licence', 'policy', 'statutory', 'other']).optional(),
  contactId: z.coerce.number().int().positive().nullish(),
  reference: z.string().trim().max(100).nullish(),
  issuedOn: date,
  expiresOn: date,
  notes: z.string().trim().max(1000).nullish(),
  /** Archived documents leave the list but keep their files: nothing in the library is deleted. */
  archived: z.boolean().optional(),
});

export const PATCH = route(async ({ orgId, user, req, params }) => {
  const id = idParam(params);
  const input = await body(req, Input);
  const doc = await db.selectFrom('documents').select(['id', 'title']).where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
  if (!doc) throw notFound('That document was not found.');
  const patch: Record<string, unknown> = {};
  if (input.title !== undefined) patch.title = input.title;
  if (input.category !== undefined) patch.category = input.category;
  if (input.contactId !== undefined) patch.contact_id = input.contactId;
  if (input.reference !== undefined) patch.reference = input.reference;
  if (input.issuedOn !== undefined) patch.issued_on = input.issuedOn;
  if (input.expiresOn !== undefined) patch.expires_on = input.expiresOn;
  if (input.notes !== undefined) patch.notes = input.notes;
  if (input.archived !== undefined) patch.archived_at = input.archived ? new Date() : null;
  if (Object.keys(patch).length) await db.updateTable('documents').set(patch).where('id', '=', id).execute();
  await logAudit({
    orgId, actorUserId: user.userId, actorName: user.name, action: 'update', targetType: 'document', targetId: id, targetLabel: doc.title,
    detail: `${input.archived ? 'Archived' : input.archived === false ? 'Restored' : 'Updated'} "${doc.title}": ${Object.keys(patch).join(', ')}`,
    ...auditMeta(req),
  });
  return { ok: true };
}, { permission: { module: 'accountant', action: 'edit' } });
