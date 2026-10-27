import 'server-only';

// The godown a document's goods leave or enter. It has to be one of the
// book's, in use, and either shared or the document's own branch's: goods
// cannot be sold under one GST registration out of a godown registered under
// another without a transfer between them first.

import type { Executor } from '../db';
import { badRequest, notFound } from '../http';

export async function checkGodown(ex: Executor, orgId: number, branchId: number, warehouseId: number | null | undefined): Promise<number | null> {
  if (!warehouseId) return null;
  const w = await ex.selectFrom('warehouses').select(['id', 'name', 'branch_id', 'is_active'])
    .where('id', '=', warehouseId).where('org_id', '=', orgId).executeTakeFirst();
  if (!w) throw notFound('That godown does not exist.');
  if (!w.is_active) throw badRequest(`${w.name} is no longer in use.`);
  if (w.branch_id && w.branch_id !== branchId) throw badRequest(`${w.name} belongs to another branch. Transfer the goods first, or choose a godown of this branch.`);
  return w.id;
}
