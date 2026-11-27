import { z } from 'zod';
import { transaction, type Trx } from '@/lib/server/db';
import { route, body, idParam, asId, forbidden, notFound } from '@/lib/server/http';
import { hasPermission } from '@/lib/rbac';
import { logAudit, auditMeta } from '@/lib/server/audit';
import { deletePerson, updatePerson } from '@/lib/server/services/contact-persons';
import type { RoleName } from '@/lib/types';

// One contact person, changed or removed from the contact's Overview, as in
// Zoho (services/contact-persons.ts). Customers are sales', vendors are
// purchases': either side's right to edit contacts will do, as for the list.

const Person = z.object({
  salutation: z.string().trim().max(10).nullish(),
  firstName: z.string().trim().max(100).nullish(),
  lastName: z.string().trim().max(100).nullish(),
  name: z.string().trim().max(150).nullish(),
  email: z.string().trim().email('That email address does not look right.').max(190).nullish().or(z.literal('')),
  phone: z.string().trim().max(30).nullish(),
  mobile: z.string().trim().max(30).nullish(),
  designation: z.string().trim().max(100).nullish(),
  department: z.string().trim().max(100).nullish(),
  isPrimary: z.boolean().optional(),
  receivesDocuments: z.boolean().optional(),
});

const mayEdit = (role: RoleName) => hasPermission(role, 'sales', 'edit') || hasPermission(role, 'purchases', 'edit');

async function contactName(trx: Trx, orgId: number, contactId: number) {
  const contact = await trx.selectFrom('contacts').select('display_name').where('id', '=', contactId).where('org_id', '=', orgId).executeTakeFirst();
  if (!contact) throw notFound('That contact does not exist.');
  return contact.display_name;
}

export const PATCH = route(async ({ orgId, user, role, params, req }) => {
  if (!mayEdit(role)) throw forbidden('You cannot change contacts.');
  const contactId = idParam(params);
  const personId = idParam(params, 'personId');
  const input = await body(req, Person);
  const r = await transaction(async (trx) => {
    const label = await contactName(trx, orgId, contactId);
    const done = await updatePerson(trx, orgId, contactId, personId, { ...input, email: input.email || null });
    await logAudit({
      trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update', targetType: 'contact', targetId: contactId,
      targetLabel: label, detail: `Contact person ${done.name} changed${input.isPrimary ? ' (now the primary contact)' : ''}`,
      payload: { before: done.before }, ...auditMeta(req),
    });
    return done;
  });
  return { id: asId(r.id), name: r.name };
});

export const DELETE = route(async ({ orgId, user, role, params, req }) => {
  if (!mayEdit(role)) throw forbidden('You cannot change contacts.');
  const contactId = idParam(params);
  const personId = idParam(params, 'personId');
  const r = await transaction(async (trx) => {
    const label = await contactName(trx, orgId, contactId);
    const done = await deletePerson(trx, orgId, contactId, personId);
    await logAudit({
      trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update', targetType: 'contact', targetId: contactId,
      targetLabel: label, detail: `Contact person ${done.name} removed`, payload: { before: done.snapshot }, ...auditMeta(req),
    });
    return done;
  });
  return { deleted: true, name: r.name };
});
