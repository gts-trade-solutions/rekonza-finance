import { db } from '@/lib/server/db';
import { route, idParam, badRequest, forbidden } from '@/lib/server/http';
import { hasPermission } from '@/lib/rbac';
import { partyStatement, type StatementSide } from '@/lib/server/reports/party-statement';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A customer's or vendor's statement of account over a period.
 * `?side=customer|vendor&from=YYYY-MM-DD&to=YYYY-MM-DD`
 *
 * The side decides the permission as well as the ledger: a vendor's statement
 * is purchasing's, and a sales role that cannot see bills cannot read it here.
 */
export const GET = route(async ({ orgId, role, params, req }) => {
  const url = new URL(req.url);
  const side = (url.searchParams.get('side') ?? 'customer') as StatementSide;
  if (side !== 'customer' && side !== 'vendor') throw badRequest('side is customer or vendor.');
  if (!hasPermission(role, side === 'customer' ? 'sales' : 'purchases', 'view')) {
    throw forbidden(side === 'customer' ? 'You cannot see customer accounts.' : 'You cannot see vendor accounts.');
  }
  const from = url.searchParams.get('from') ?? '';
  const to = url.searchParams.get('to') ?? '';
  if (!DATE.test(from) || !DATE.test(to) || from > to) throw badRequest('Give a from and to date, from first.');
  return partyStatement(db, orgId, idParam(params), side, from, to);
});
