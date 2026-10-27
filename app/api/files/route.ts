import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, query, badRequest, forbidden } from '@/lib/server/http';
import { hasPermission } from '@/lib/rbac';
import { logAudit, auditMeta } from '@/lib/server/audit';
import {
  ATTACHABLE, ATTACHABLE_TYPES, attachFile, attachmentPermission, listAttachments, MAX_FILE_BYTES,
  type AttachableType,
} from '@/lib/server/files/attachments';

// Attachments on a record. The permission depends on what the file is attached
// to, so it is checked inside rather than declared on the route.

const Target = z.object({
  targetType: z.enum(ATTACHABLE_TYPES),
  targetId: z.coerce.number().int().positive(),
});

function allow(role: Parameters<typeof hasPermission>[0], type: AttachableType, intent: 'read' | 'write') {
  const { module, action } = attachmentPermission(type, intent);
  if (!hasPermission(role, module, action)) {
    throw forbidden(`Your role (${role}) cannot ${intent === 'read' ? 'see' : 'change'} attachments on a ${ATTACHABLE[type].label}.`);
  }
}

export const GET = route(async ({ orgId, role, req }) => {
  const q = query(req, Target);
  allow(role, q.targetType, 'read');
  return { attachments: await listAttachments(db, orgId, q.targetType, q.targetId) };
});

export const POST = route(async ({ orgId, user, role, req }) => {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw badRequest('Send the file as a form upload.');
  }
  const q = Target.parse({ targetType: form.get('targetType'), targetId: form.get('targetId') });
  allow(role, q.targetType, 'write');

  const file = form.get('file');
  if (!(file instanceof File)) throw badRequest('Choose a file to attach.');
  if (file.size > MAX_FILE_BYTES) throw badRequest(`Files can be up to ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
  const bytes = Buffer.from(await file.arrayBuffer());

  const attachment = await transaction(async (trx) => {
    const a = await attachFile(trx, orgId, user.userId, {
      type: q.targetType, targetId: q.targetId, filename: file.name, bytes,
    });
    // The company logo is a single file; a new one replaces the old.
    if (q.targetType === 'organization') {
      await trx.updateTable('organizations').set({ logo_file_id: Number(a.id) }).where('id', '=', orgId).execute();
    }
    await logAudit({
      trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update',
      targetType: q.targetType, targetId: q.targetId,
      detail: `Attached ${a.filename} (${Math.ceil(a.sizeBytes / 1024)} KB) to the ${ATTACHABLE[q.targetType].label}`,
      ...auditMeta(req),
    });
    return a;
  });
  return { attachment };
});
