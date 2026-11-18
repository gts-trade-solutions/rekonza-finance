import { z } from 'zod';
import { db } from '@/lib/server/db';
import { route, idParam, query, notFound, forbidden } from '@/lib/server/http';
import { hasPermission } from '@/lib/rbac';
import { contactIncome, contactMails, contactTransactions } from '@/lib/server/services/contact-activity';
import { indiaToday } from '@/lib/server/services/held-journals';

/**
 * A customer's or vendor's record beyond the master (services/contact-activity.ts):
 * ?view=transactions (the Transactions tab), income (the Overview's chart:
 * months 6 or 12, basis accrual or cash) or mails (the Mails tab).
 */
const Q = z.object({
  view: z.enum(['transactions', 'income', 'mails']),
  side: z.enum(['customer', 'vendor']).default('customer'),
  months: z.coerce.number().int().refine((n) => n === 6 || n === 12).default(6),
  basis: z.enum(['accrual', 'cash']).default('accrual'),
});

export const GET = route(async ({ orgId, role, params, req }) => {
  const id = idParam(params);
  const q = query(req, Q);
  const sales = hasPermission(role, 'sales', 'view');
  const purchases = hasPermission(role, 'purchases', 'view');
  if (q.side === 'customer' ? !sales : !purchases) throw forbidden(`You cannot see ${q.side}s.`);
  const c = await db.selectFrom('contacts').select('id').where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
  if (!c) throw notFound('That contact does not exist.');
  if (q.view === 'transactions') {
    return { rows: await contactTransactions(db, orgId, id, { sales: q.side === 'customer' && sales, purchases: q.side === 'vendor' && purchases }) };
  }
  if (q.view === 'income') return { months: await contactIncome(db, orgId, id, q.side, q.months, q.basis, indiaToday()) };
  return { mails: await contactMails(db, orgId, id) };
});
