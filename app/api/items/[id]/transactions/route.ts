import { db } from '@/lib/server/db';
import { route, idParam, notFound } from '@/lib/server/http';
import { hasPermission } from '@/lib/rbac';
import { itemTransactions } from '@/lib/server/services/item-activity';

/**
 * The documents an item is on, for its Transactions tab: quotes, orders,
 * invoices, challans, credit notes and recurring profiles, and, for those who
 * may see purchases, purchase orders and bills.
 */
export const GET = route(
  async ({ orgId, role, params }) => {
    const id = idParam(params);
    const item = await db.selectFrom('items').select('id').where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
    if (!item) throw notFound('That item does not exist.');
    const purchases = hasPermission(role, 'purchases', 'view');
    return { purchases, rows: await itemTransactions(db, orgId, id, { sales: true, purchases }) };
  },
  { permission: { module: 'sales', action: 'view' } },
);
