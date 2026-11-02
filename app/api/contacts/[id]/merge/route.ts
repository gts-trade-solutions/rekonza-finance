import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, query, idParam, forbidden, notFound } from '@/lib/server/http';
import { hasPermission } from '@/lib/rbac';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { mergeContacts, mergePreview } from '@/lib/server/services/contact-merge';

// Merge this contact into another (services/contact-merge.ts): GET says what
// would move and whether it may; POST does it. A customer needs the right to
// edit in sales, a vendor in purchases, a contact that is both, both rights.

async function mayMerge(orgId: number, id: number, role: string, permissions: Parameters<typeof hasPermission>[3]) {
  const c = await db.selectFrom('contacts').select('kind').where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
  if (!c) throw notFound('That contact does not exist.');
  const need = c.kind === 'both' ? ['sales', 'purchases'] : [c.kind === 'customer' ? 'sales' : 'purchases'];
  if (!need.every((m) => hasPermission(role as never, m, 'edit', permissions))) throw forbidden(`Your role (${role}) cannot merge this contact.`);
}

export const GET = route(async ({ orgId, role, user, params, req }) => {
  const id = idParam(params);
  await mayMerge(orgId, id, role, user.permissions ?? null);
  const q = query(req, z.object({ into: z.coerce.number().int().positive() }));
  return mergePreview(db, orgId, id, q.into);
});

export const POST = route(async ({ orgId, role, user, params, req }) => {
  const id = idParam(params);
  await mayMerge(orgId, id, role, user.permissions ?? null);
  const input = await body(req, z.object({ intoId: z.coerce.number().int().positive() }));
  return transaction(async (trx) => {
    const r = await mergeContacts(trx, orgId, id, input.intoId);
    const total = Object.values(r.moved).reduce((t, n) => t + n, 0);
    await logAudit({
      trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update', targetType: 'contact', targetId: input.intoId,
      detail: `${r.from} merged into ${r.into}: ${total} record${total === 1 ? '' : 's'} moved`, ...auditMeta(req),
    });
    return { ...r, intoId: String(input.intoId) };
  });
});
