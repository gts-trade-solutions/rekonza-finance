import 'server-only';

// Voucher types: named kinds of a document with their own number series. A
// type's series is kept in number_series under "<doc type>:<code>", per branch
// and financial year like every other, so it never shares a number with the
// ordinary series or another type.

import type { Executor, Trx } from '../db';
import { badRequest, conflict, currentRole, forbidden, notFound } from '../http';
import { hasPermission, voucherModule } from '../../rbac';

/** Document types that can have voucher types. */
export const VOUCHER_DOC_TYPES = {
  INV: 'Sales invoice', CN: 'Credit note', DC: 'Delivery challan', EST: 'Quote', SO: 'Sales order', PO: 'Purchase order',
} as const;
export type VoucherDocType = keyof typeof VOUCHER_DOC_TYPES;

export interface VoucherTypeInput {
  docType: VoucherDocType; code: string; name: string; prefix: string; isActive?: boolean;
  /** How its documents print: a heading under the statutory title, terms of its own, and what is shown. */
  printHeading?: string | null; printTerms?: string | null; printShowUpi?: boolean; printShowBank?: boolean;
  /** Only admins, and custom roles given it by name, may raise documents of this type. */
  restricted?: boolean;
}

export async function saveVoucherType(trx: Trx, orgId: number, input: VoucherTypeInput, id?: number): Promise<number> {
  const code = input.code.trim().toUpperCase();
  const prefix = input.prefix.trim().toUpperCase();
  if (!(input.docType in VOUCHER_DOC_TYPES)) throw badRequest('That kind of document cannot have voucher types.');
  if (!/^[A-Z0-9]{1,10}$/.test(code)) throw badRequest('A code is up to ten letters or digits.');
  // With "/26-27/" and four digits, a prefix of more than five would pass the 16 characters GST allows.
  if (!/^[A-Z0-9-]{1,5}$/.test(prefix)) throw badRequest('A prefix is one to five letters, digits or "-", so numbers stay within 16 characters.');
  if (prefix === input.docType) throw badRequest(`${prefix} is the ordinary series' own prefix; choose another.`);
  const clash = await trx.selectFrom('voucher_types').select(['id', 'name'])
    .where('org_id', '=', orgId).where((eb) => eb.or([eb('prefix', '=', prefix), eb.and([eb('doc_type', '=', input.docType), eb('code', '=', code)])]))
    .$if(!!id, (q) => q.where('id', '<>', id!)).executeTakeFirst();
  if (clash) throw conflict(`${clash.name} already uses that code or prefix.`);
  const values = { doc_type: input.docType, code, name: input.name.trim(), prefix, is_active: input.isActive === false ? 0 : 1 };
  const print = {
    ...(input.printHeading !== undefined ? { print_heading: input.printHeading?.trim().slice(0, 60) || null } : {}),
    ...(input.printTerms !== undefined ? { print_terms: input.printTerms?.trim().slice(0, 2000) || null } : {}),
    ...(input.printShowUpi !== undefined ? { print_show_upi: input.printShowUpi ? 1 : 0 } : {}),
    ...(input.printShowBank !== undefined ? { print_show_bank: input.printShowBank ? 1 : 0 } : {}),
    ...(input.restricted !== undefined ? { restricted: input.restricted ? 1 : 0 } : {}),
  };
  if (id) {
    const found = await trx.selectFrom('voucher_types').select('id').where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
    if (!found) throw notFound('That voucher type does not exist.');
    // The code names the series; changing it would start a new one mid-year.
    await trx.updateTable('voucher_types').set({ name: values.name, is_active: values.is_active, ...print }).where('id', '=', id).execute();
    return id;
  }
  return Number((await trx.insertInto('voucher_types').values({ org_id: orgId, ...values, ...print }).executeTakeFirstOrThrow()).insertId);
}

export async function listVoucherTypes(ex: Executor, orgId: number) {
  const rows = await ex.selectFrom('voucher_types').selectAll().where('org_id', '=', orgId).orderBy('doc_type').orderBy('name').execute();
  return rows.map((r) => ({
    id: String(r.id), docType: r.doc_type as VoucherDocType, code: r.code, name: r.name, prefix: r.prefix, isActive: !!r.is_active,
    printHeading: r.print_heading, printTerms: r.print_terms, printShowUpi: !!r.print_show_upi, printShowBank: !!r.print_show_bank,
    restricted: !!r.restricted,
  }));
}

/** The series a document of this type is numbered in. */
export async function seriesFor(ex: Executor, orgId: number, docType: VoucherDocType, voucherTypeId?: number | null) {
  if (!voucherTypeId) return { docType: docType as string, prefix: docType as string, voucherTypeId: null };
  const vt = await ex.selectFrom('voucher_types').select(['id', 'doc_type', 'code', 'prefix', 'is_active', 'name', 'restricted'])
    .where('id', '=', voucherTypeId).where('org_id', '=', orgId).executeTakeFirst();
  if (!vt || vt.doc_type !== docType) throw notFound('That voucher type does not exist for this kind of document.');
  if (!vt.is_active) throw conflict(`${vt.name} is no longer in use.`);
  // A restricted type: admins, and roles given it by name. Outside a request
  // (the scheduler, a script) there is nobody to ask, and it goes ahead.
  const role = currentRole();
  if (vt.restricted && role && !hasPermission(role, voucherModule(vt.code), 'create')) {
    throw forbidden(`Only roles given the ${vt.name} voucher type may raise it. Ask an admin.`);
  }
  return { docType: `${docType}:${vt.code}`, prefix: vt.prefix, voucherTypeId: vt.id };
}
