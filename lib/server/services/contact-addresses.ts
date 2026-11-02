import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// A contact's other addresses (migration 098): the sites a customer takes
// delivery at, or a vendor ships from, each with its state — the place of
// supply for goods delivered there — and its own GSTIN when it has one. The
// invoice form offers them as the ship-to; one may be the default.
// ─────────────────────────────────────────────────────────────────────────────

import type { Executor, Trx } from '../db';
import { badRequest, notFound } from '../http';
import { GST_STATES, isValidGstin } from '../../tax/gst';

export interface AddressInput {
  id?: number | null; label: string; name?: string | null; address: string; city?: string | null; pincode?: string | null;
  stateCode: string; gstin?: string | null; phone?: string | null; isDefault?: boolean;
}

export async function listAddresses(ex: Executor, orgId: number, contactId: number) {
  const rows = await ex.selectFrom('contact_addresses').selectAll().where('org_id', '=', orgId).where('contact_id', '=', contactId)
    .orderBy('is_default', 'desc').orderBy('label').execute();
  return rows.map((r) => ({
    id: String(r.id), label: r.label, name: r.name, address: r.address, city: r.city, pincode: r.pincode,
    stateCode: r.state_code, gstin: r.gstin, phone: r.phone, isDefault: !!r.is_default,
  }));
}

export async function saveAddress(trx: Trx, orgId: number, contactId: number, input: AddressInput): Promise<number> {
  const contact = await trx.selectFrom('contacts').select('id').where('id', '=', contactId).where('org_id', '=', orgId).executeTakeFirst();
  if (!contact) throw notFound('That contact does not exist.');
  const label = input.label.trim().slice(0, 80);
  const address = input.address.trim().slice(0, 500);
  if (!label) throw badRequest('Give the address a name, such as “Hosur godown”.');
  if (!address) throw badRequest('Write the address.');
  const state = input.stateCode.trim();
  if (!(GST_STATES as Record<string, unknown>)[state]) throw badRequest('Pick the state: it is the place of supply for goods delivered there.');
  const pincode = input.pincode?.trim() || null;
  if (pincode && !/^[1-9]\d{5}$/.test(pincode)) throw badRequest('A PIN code is six digits.');
  const gstin = input.gstin?.trim().toUpperCase() || null;
  if (gstin && !isValidGstin(gstin)) throw badRequest(`GSTIN ${gstin} fails its checksum, so it is mistyped somewhere.`);
  if (gstin && gstin.slice(0, 2) !== state) throw badRequest(`GSTIN ${gstin} is registered in state ${gstin.slice(0, 2)}, not ${state}.`);
  const values = {
    label, name: input.name?.trim().slice(0, 150) || null, address, city: input.city?.trim().slice(0, 60) || null, pincode,
    state_code: state, gstin, phone: input.phone?.trim().slice(0, 30) || null, is_default: input.isDefault ? 1 : 0,
  };
  // One default at a time.
  if (input.isDefault) await trx.updateTable('contact_addresses').set({ is_default: 0 }).where('org_id', '=', orgId).where('contact_id', '=', contactId).execute();
  if (input.id) {
    const r = await trx.updateTable('contact_addresses').set(values).where('id', '=', input.id).where('org_id', '=', orgId).where('contact_id', '=', contactId).executeTakeFirst();
    if (!Number(r.numUpdatedRows)) throw notFound('That address was not found.');
    return input.id;
  }
  const count = await trx.selectFrom('contact_addresses').select((eb) => eb.fn.countAll<number>().as('n')).where('org_id', '=', orgId).where('contact_id', '=', contactId).executeTakeFirstOrThrow();
  if (Number(count.n) >= 50) throw badRequest('A contact can have up to 50 addresses.');
  return Number((await trx.insertInto('contact_addresses').values({ org_id: orgId, contact_id: contactId, ...values }).executeTakeFirstOrThrow()).insertId);
}

export async function deleteAddress(trx: Trx, orgId: number, contactId: number, id: number) {
  const row = await trx.selectFrom('contact_addresses').select('label').where('id', '=', id).where('org_id', '=', orgId).where('contact_id', '=', contactId).executeTakeFirst();
  if (!row) throw notFound('That address was not found.');
  await trx.deleteFrom('contact_addresses').where('id', '=', id).execute();
  return row.label;
}
