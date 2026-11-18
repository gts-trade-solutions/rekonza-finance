import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, idParam, asId, forbidden, notFound, badRequest } from '@/lib/server/http';
import { hasPermission } from '@/lib/rbac';
import { logAudit, auditMeta } from '@/lib/server/audit';

// The people at a customer or vendor: who orders, who pays, who gets the
// invoice. One is primary; documents go to those marked to receive them.

export const GET = route(async ({ orgId, role, params }) => {
  if (!hasPermission(role, 'sales', 'view') && !hasPermission(role, 'purchases', 'view')) throw forbidden('You cannot see contacts.');
  const contactId = idParam(params);
  const rows = await db.selectFrom('contact_persons').selectAll().where('org_id', '=', orgId).where('contact_id', '=', contactId)
    .orderBy('is_primary', 'desc').orderBy('name').execute();
  return {
    persons: rows.map((p) => ({
      id: asId(p.id), salutation: p.salutation, name: p.name, firstName: p.first_name, lastName: p.last_name, mobile: p.mobile,
      email: p.email, phone: p.phone, designation: p.designation,
      department: p.department, isPrimary: !!p.is_primary, receivesDocuments: !!p.receives_documents,
    })),
  };
});

const Person = z.object({
  id: z.union([z.string(), z.number()]).nullish(),
  salutation: z.string().trim().max(10).nullish(),
  // Zoho's first and last name; `name` is the whole of it, made from them when they come.
  firstName: z.string().trim().max(100).nullish(),
  lastName: z.string().trim().max(100).nullish(),
  name: z.string().trim().max(150).optional(),
  mobile: z.string().trim().max(30).nullish(),
  email: z.string().trim().email('That email address does not look right.').max(190).nullish().or(z.literal('')),
  phone: z.string().trim().max(30).nullish(),
  designation: z.string().trim().max(100).nullish(),
  department: z.string().trim().max(100).nullish(),
  isPrimary: z.boolean().optional(),
  receivesDocuments: z.boolean().optional(),
});

/** Replace the contact's people with this list: those left out are removed. */
export const PUT = route(async ({ orgId, user, role, params, req }) => {
  if (!hasPermission(role, 'sales', 'edit') && !hasPermission(role, 'purchases', 'edit')) throw forbidden('You cannot change contacts.');
  const contactId = idParam(params);
  const { persons } = await body(req, z.object({ persons: z.array(Person).max(50) }));
  if (persons.filter((p) => p.isPrimary).length > 1) throw badRequest('Only one person can be the primary contact.');
  const nameOf = (p: z.infer<typeof Person>) => [p.firstName, p.lastName].filter(Boolean).join(' ').trim() || (p.name ?? '').trim();
  if (persons.some((p) => !nameOf(p))) throw badRequest('Give each person a name.');
  const contact = await db.selectFrom('contacts').select(['id', 'display_name']).where('id', '=', contactId).where('org_id', '=', orgId).executeTakeFirst();
  if (!contact) throw notFound('That contact does not exist.');
  await transaction(async (trx) => {
    const keep = persons.filter((p) => p.id).map((p) => Number(p.id));
    let del = trx.deleteFrom('contact_persons').where('org_id', '=', orgId).where('contact_id', '=', contactId);
    if (keep.length) del = del.where('id', 'not in', keep);
    await del.execute();
    for (const p of persons) {
      const row = {
        salutation: p.salutation || null, name: nameOf(p), first_name: p.firstName || null, last_name: p.lastName || null, mobile: p.mobile || null,
        email: p.email || null, phone: p.phone || null, designation: p.designation || null,
        department: p.department || null, is_primary: p.isPrimary ? 1 : 0, receives_documents: p.receivesDocuments === false ? 0 : 1,
      };
      if (p.id) await trx.updateTable('contact_persons').set(row).where('id', '=', Number(p.id)).where('contact_id', '=', contactId).execute();
      else await trx.insertInto('contact_persons').values({ org_id: orgId, contact_id: contactId, ...row }).execute();
    }
    await logAudit({
      trx, orgId, actorUserId: user.userId, actorName: user.name, action: 'update', targetType: 'contact', targetId: contactId,
      targetLabel: contact.display_name, detail: `Contact persons: ${persons.map(nameOf).join(', ') || 'none'}`, ...auditMeta(req),
    });
  });
  return { ok: true };
});
