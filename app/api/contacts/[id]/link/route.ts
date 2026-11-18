import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, idParam, asId, forbidden, notFound, badRequest, conflict } from '@/lib/server/http';
import { hasPermission } from '@/lib/rbac';
import { logAudit, auditMeta } from '@/lib/server/audit';

/**
 * Zoho's "Link to Vendor" (and, from a vendor, "Link to Customer"): a customer
 * and a vendor that are the same business, kept as two contacts but shown
 * together, each pointing at the other. POST { otherId } links; DELETE unlinks.
 */
async function pair(orgId: number, id: number) {
  const c = await db.selectFrom('contacts').select(['id', 'display_name', 'kind', 'linked_contact_id'])
    .where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
  if (!c) throw notFound('That contact does not exist.');
  return c;
}

function mayEdit(role: Parameters<typeof hasPermission>[0]) {
  if (!hasPermission(role, 'sales', 'edit') && !hasPermission(role, 'purchases', 'edit')) throw forbidden('You cannot change customers or vendors.');
}

export const POST = route(async ({ orgId, user, role, params, req }) => {
  mayEdit(role);
  const id = idParam(params);
  const { otherId } = await body(req, z.object({ otherId: z.string().regex(/^\d+$/, 'Choose the contact to link.') }));
  const [me, other] = await Promise.all([pair(orgId, id), pair(orgId, Number(otherId))]);
  if (me.id === other.id) throw badRequest('A contact cannot be linked to itself.');
  // One a customer, the other a vendor.
  const sides = new Set([me.kind, other.kind]);
  if (!(sides.has('customer') && sides.has('vendor'))) throw badRequest('Link a customer to a vendor.');
  if (me.linked_contact_id || other.linked_contact_id) throw conflict('One of them is linked already. Unlink it first.');
  await transaction(async (trx) => {
    await trx.updateTable('contacts').set({ linked_contact_id: other.id }).where('id', '=', me.id).execute();
    await trx.updateTable('contacts').set({ linked_contact_id: me.id }).where('id', '=', other.id).execute();
    await logAudit({
      trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update', targetType: 'contact', targetId: me.id,
      targetLabel: me.display_name, detail: `Linked ${me.display_name} (${me.kind}) to ${other.display_name} (${other.kind})`, ...auditMeta(req),
    });
  });
  return { id: asId(me.id), linkedContactId: asId(other.id) };
});

export const DELETE = route(async ({ orgId, user, role, params, req }) => {
  mayEdit(role);
  const id = idParam(params);
  const me = await pair(orgId, id);
  if (!me.linked_contact_id) return { id: asId(me.id) };
  const otherId = me.linked_contact_id;
  await transaction(async (trx) => {
    await trx.updateTable('contacts').set({ linked_contact_id: null }).where('org_id', '=', orgId).where('id', 'in', [me.id, otherId]).execute();
    await logAudit({
      trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update', targetType: 'contact', targetId: me.id,
      targetLabel: me.display_name, detail: `Unlinked ${me.display_name} from contact ${otherId}`, ...auditMeta(req),
    });
  });
  return { id: asId(me.id) };
});
