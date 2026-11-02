import { z } from 'zod';
import { transaction } from '@/lib/server/db';
import { route, body, asId, forbidden } from '@/lib/server/http';
import { hasPermission } from '@/lib/rbac';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { cloneDocument } from '@/lib/server/services/clone-document';
import { PRINT_KINDS, PRINT_NOUN, PRINT_SIDE, type PrintKind } from '@/lib/print-doc';

// Clone a quote, sales order or purchase order (services/clone-document.ts):
// a new one dated today with the same party and lines.

export const POST = route(async ({ orgId, user, role, req }) => {
  const input = await body(req, z.object({ kind: z.enum(PRINT_KINDS as [PrintKind, ...PrintKind[]]), id: z.coerce.number().int().positive() }));
  const area = PRINT_SIDE[input.kind] === 'customer' ? 'sales' : 'purchases';
  if (!hasPermission(role, area, 'create', user.permissions ?? null)) throw forbidden(`Your role (${role}) cannot create in ${area}.`);
  return transaction(async (trx) => {
    const made = await cloneDocument(trx, orgId, user.userId, input.kind, input.id);
    await logAudit({
      trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'create', targetType: input.kind, targetId: made.id,
      detail: `Cloned from ${PRINT_NOUN[input.kind]} ${input.id} as ${made.number}`, ...auditMeta(req),
    });
    return { id: asId(made.id), number: made.number };
  });
});
