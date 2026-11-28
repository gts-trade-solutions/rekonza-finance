import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// One contact person at a customer or vendor, changed or removed on its own —
// Zoho's Edit and Delete beside each person on the contact's Overview. The
// whole list is still saved at once from the contact's Edit page (PUT
// /api/contacts/[id]/persons); these are the same rules for one person.
//
// A person is one of the addresses documents are emailed to (receives
// documents, mail/mailer.ts documentRecipients) and one the portal sign-in
// accepts (portal-login.ts). Nothing else points at a person, so removing one
// takes them off those two and nothing more: invoices already sent keep who
// they went to in the mail log.
// ─────────────────────────────────────────────────────────────────────────────

import type { Trx } from '../db';
import { badRequest, notFound } from '../http';
import { plain } from './doc-delete';

export interface PersonInput {
  salutation?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  /** The whole name, when it is not given in parts. */
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  mobile?: string | null;
  designation?: string | null;
  department?: string | null;
  isPrimary?: boolean;
  receivesDocuments?: boolean;
}

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

async function findPerson(trx: Trx, orgId: number, contactId: number, personId: number) {
  const p = await trx.selectFrom('contact_persons').selectAll()
    .where('id', '=', personId).where('contact_id', '=', contactId).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!p) throw notFound('That contact person does not exist.');
  return p;
}

/**
 * Change one person. Made primary, they are the only primary: whoever was
 * before is not any more (a contact has one primary person, as in Zoho).
 */
export async function updatePerson(trx: Trx, orgId: number, contactId: number, personId: number, input: PersonInput) {
  const before = await findPerson(trx, orgId, contactId, personId);
  const name = [input.firstName, input.lastName].map((x) => x?.trim()).filter(Boolean).join(' ') || (input.name ?? '').trim();
  if (!name) throw badRequest('Give the person a name.');
  const email = input.email?.trim() || null;
  if (email && !EMAIL.test(email)) throw badRequest('That email address does not look right.');
  const cut = (v: string | null | undefined, n: number) => v?.trim().slice(0, n) || null;
  if (input.isPrimary) {
    await trx.updateTable('contact_persons').set({ is_primary: 0 })
      .where('org_id', '=', orgId).where('contact_id', '=', contactId).where('id', '<>', personId).execute();
  }
  await trx.updateTable('contact_persons').set({
    salutation: cut(input.salutation, 10), name: name.slice(0, 150), first_name: cut(input.firstName, 100), last_name: cut(input.lastName, 100),
    email: email?.slice(0, 190) ?? null, phone: cut(input.phone, 30), mobile: cut(input.mobile, 30),
    designation: cut(input.designation, 100), department: cut(input.department, 100),
    is_primary: input.isPrimary ? 1 : 0, receives_documents: input.receivesDocuments === false ? 0 : 1,
  }).where('id', '=', personId).execute();
  return { id: personId, name, before: plain(before), after: plain(await findPerson(trx, orgId, contactId, personId)) };
}

/** Remove one person: they no longer get documents or sign in to the portal by their own address. */
export async function deletePerson(trx: Trx, orgId: number, contactId: number, personId: number) {
  const p = await findPerson(trx, orgId, contactId, personId);
  await trx.deleteFrom('contact_persons').where('id', '=', personId).execute();
  return { name: p.name, snapshot: plain(p) };
}
