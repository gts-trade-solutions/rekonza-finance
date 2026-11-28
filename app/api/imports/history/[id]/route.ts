import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, idParam, forbidden } from '@/lib/server/http';
import { hasPermission } from '@/lib/rbac';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { importBatch, undoImport, updateImportNote } from '@/lib/server/services/import-history';

// One import in the history: its rows that failed or were skipped, and why
// (GET); its note (PATCH, Edit); and, for masters nothing has used, Delete,
// which undoes the import and keeps the entry, marked undone.

export const GET = route(
  async ({ orgId, params }) => importBatch(db, orgId, idParam(params)),
  { permission: { module: 'accountant', action: 'view' } },
);

export const PATCH = route(
  async ({ orgId, user, req, params }) => {
    const id = idParam(params);
    const input = await body(req, z.object({ note: z.string().max(500).nullish() }));
    await transaction(async (trx) => {
      await updateImportNote(trx, orgId, id, input.note ?? null);
      await logAudit({ trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update', targetType: 'import_batch', targetId: id, detail: `Import note: ${input.note ?? '(cleared)'}`, ...auditMeta(req) });
    });
    return { id: String(id) };
  },
  { permission: { module: 'accountant', action: 'edit' } },
);

export const DELETE = route(
  async ({ orgId, user, role, req, params }) => {
    const id = idParam(params);
    if (!hasPermission(role, 'sales', 'void') && !hasPermission(role, 'accountant', 'void')) throw forbidden('Your role cannot undo an import.');
    const done = await transaction(async (trx) => {
      const r = await undoImport(trx, orgId, user.userId, id);
      await logAudit({
        trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'void', targetType: 'import_batch', targetId: id,
        detail: `Import undone: ${Object.entries(r.deleted).map(([t, n]) => `${n} ${t}`).join(', ')} deleted`, ...auditMeta(req),
      });
      return r;
    });
    return { undone: true, deleted: done.deleted };
  },
  { permission: { module: 'accountant', action: 'view' } },
);
