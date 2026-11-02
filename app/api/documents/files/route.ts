import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, query, body, badRequest, forbidden } from '@/lib/server/http';
import { hasPermission } from '@/lib/rbac';
import { logAudit, auditMeta } from '@/lib/server/audit';
import {
  ATTACHABLE, ATTACHABLE_TYPES, attachFile, attachmentPermission, attachmentRow, MAX_FILE_BYTES, moveAttachment,
  type AttachableType,
} from '@/lib/server/files/attachments';
import { listLibrary } from '@/lib/server/files/library';

// The Documents workspace (lib/server/files/library.ts): every file listed,
// uploads into the inbox, and files moved to the transaction they belong to
// or into a folder. Each file is still checked against the record it is
// attached to, as its attachments are everywhere else.

const ListQuery = z.object({
  view: z.enum(['inbox', 'all', 'statements', 'folder']).default('all'),
  folder: z.string().max(100).optional(),
  q: z.string().max(100).optional(),
});

export const GET = route(async ({ orgId, role, req }) => {
  const q = query(req, ListQuery);
  return listLibrary(db, orgId, role, q);
});

/** Up to ten files at a time into the inbox (or a folder of it), as Zoho takes them. */
export const POST = route(async ({ orgId, user, role, req }) => {
  if (!hasPermission(role, 'accountant', 'edit') && !hasPermission(role, 'purchases', 'create')) {
    throw forbidden('Your role cannot upload to Documents.');
  }
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw badRequest('Send the files as a form upload.');
  }
  const picked = form.getAll('file').filter((f): f is File => f instanceof File);
  if (!picked.length) throw badRequest('Choose at least one file.');
  if (picked.length > 10) throw badRequest('Upload up to ten files at a time.');
  const folder = String(form.get('folder') ?? '').trim() || null;
  const uploaded: { id: string; filename: string }[] = [];
  const failed: { filename: string; message: string }[] = [];
  for (const file of picked) {
    if (file.size > MAX_FILE_BYTES) {
      failed.push({ filename: file.name, message: `larger than ${MAX_FILE_BYTES / 1024 / 1024} MB` });
      continue;
    }
    try {
      const bytes = Buffer.from(await file.arrayBuffer());
      const a = await transaction((trx) => attachFile(trx, orgId, user.userId, { type: 'inbox', targetId: orgId, filename: file.name, bytes, folder }));
      uploaded.push({ id: a.id, filename: a.filename });
    } catch (e) {
      failed.push({ filename: file.name, message: e instanceof Error ? e.message : 'could not be stored' });
    }
  }
  if (uploaded.length) {
    await logAudit({
      orgId, actorUserId: user.userId, actorName: user.name, action: 'create', targetType: 'documents', targetId: orgId,
      detail: `Uploaded ${uploaded.length} file(s) to Documents${folder ? ` (folder ${folder})` : ''}: ${uploaded.map((u) => u.filename).join(', ')}`,
      ...auditMeta(req),
    });
  }
  return { uploaded, failed };
});

const Patch = z.discriminatedUnion('action', [
  // To the transaction it belongs to: from the inbox, or from one record to another.
  z.object({
    action: z.literal('attach'),
    fileIds: z.array(z.union([z.string(), z.number()])).min(1).max(50),
    targetType: z.enum(ATTACHABLE_TYPES),
    targetId: z.coerce.number().int().positive(),
  }),
  // Back to the inbox, off the record it was attached to.
  z.object({ action: z.literal('to_inbox'), fileIds: z.array(z.union([z.string(), z.number()])).min(1).max(50) }),
  z.object({ action: z.literal('folder'), fileIds: z.array(z.union([z.string(), z.number()])).min(1).max(200), folder: z.string().trim().max(100).nullable() }),
  z.object({ action: z.literal('rename'), fileId: z.union([z.string(), z.number()]), filename: z.string().trim().min(1).max(255) }),
]);

export const PATCH = route(async ({ orgId, user, role, req }) => {
  const input = await body(req, Patch);
  const may = (type: AttachableType, intent: 'read' | 'write') => {
    const { module, action } = attachmentPermission(type, intent);
    return hasPermission(role, module, action);
  };

  if (input.action === 'rename') {
    const row = await attachmentRow(db, orgId, Number(input.fileId));
    if (!may(row.type, 'write')) throw forbidden('You cannot rename this file.');
    const filename = input.filename.replace(/[\\/\r\n"]/g, '_');
    await db.updateTable('files').set({ filename }).where('id', '=', row.id).where('org_id', '=', orgId).execute();
    return { ok: true };
  }

  const ids = input.fileIds.map(Number);
  return transaction(async (trx) => {
    let changed = 0;
    for (const id of ids) {
      const row = await attachmentRow(trx, orgId, id);
      if (!may(row.type, input.action === 'folder' ? 'write' : 'read')) throw forbidden(`You cannot move ${row.filename}.`);
      if (input.action === 'folder') {
        await trx.updateTable('files').set({ folder: input.folder || null }).where('id', '=', id).where('org_id', '=', orgId).execute();
      } else if (input.action === 'to_inbox') {
        if (!may(row.type, 'write')) throw forbidden(`You cannot take ${row.filename} off its ${ATTACHABLE[row.type].label}.`);
        await moveAttachment(trx, orgId, id, { type: 'inbox', targetId: orgId });
      } else {
        if (!may(input.targetType, 'write')) throw forbidden(`Your role cannot attach files to a ${ATTACHABLE[input.targetType].label}.`);
        await moveAttachment(trx, orgId, id, { type: input.targetType, targetId: input.targetId });
      }
      changed++;
    }
    await logAudit({
      trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update',
      targetType: input.action === 'attach' ? input.targetType : 'documents',
      targetId: input.action === 'attach' ? input.targetId : orgId,
      detail: input.action === 'attach'
        ? `Attached ${changed} file(s) from Documents to the ${ATTACHABLE[input.targetType].label}`
        : input.action === 'to_inbox' ? `Moved ${changed} file(s) back to the Documents inbox`
          : `Moved ${changed} file(s) ${input.folder ? `to the folder ${input.folder}` : 'out of their folder'}`,
      ...auditMeta(req),
    });
    return { changed };
  });
});
