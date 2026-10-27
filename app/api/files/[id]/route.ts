import { NextResponse } from 'next/server';
import { db, transaction } from '@/lib/server/db';
import { route, idParam, forbidden } from '@/lib/server/http';
import { hasPermission } from '@/lib/rbac';
import { logAudit, auditMeta } from '@/lib/server/audit';
import {
  ATTACHABLE, attachmentPermission, attachmentRow, readAttachment, removeAttachment,
} from '@/lib/server/files/attachments';

// One attachment: its bytes, or taking it off its record.

/** Shown in the browser; anything else downloads. */
const INLINE = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp']);

export const GET = route(async ({ orgId, role, req, params }) => {
  const id = idParam(params);
  const { row, bytes } = await readAttachment(db, orgId, id);
  const { module, action } = attachmentPermission(row.type, 'read');
  if (!hasPermission(role, module, action)) throw forbidden('You cannot see this file.');

  const download = new URL(req.url).searchParams.has('download') || !INLINE.has(row.content_type);
  const name = encodeURIComponent(row.filename);
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      'Content-Type': row.content_type,
      'Content-Length': String(bytes.length),
      'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${name}`,
      'X-Content-Type-Options': 'nosniff',
      // Nothing in a stored file may run as part of this site.
      'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
      'Cache-Control': 'private, max-age=300',
    },
  });
});

export const DELETE = route(async ({ orgId, user, role, req, params }) => {
  const id = idParam(params);
  const existing = await attachmentRow(db, orgId, id);
  const { module, action } = attachmentPermission(existing.type, 'write');
  if (!hasPermission(role, module, action)) throw forbidden('You cannot remove this file.');

  await transaction(async (trx) => {
    const row = await removeAttachment(trx, orgId, user.userId, id);
    await logAudit({
      trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update',
      targetType: row.type, targetId: row.attached_to_id,
      detail: `Removed attachment ${row.filename} from the ${ATTACHABLE[row.type].label}. The file is kept.`,
      ...auditMeta(req),
    });
  });
  return { ok: true };
});
