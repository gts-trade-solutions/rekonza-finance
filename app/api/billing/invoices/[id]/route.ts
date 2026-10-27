import { route, idParam } from '@/lib/server/http';
import { invoiceFor } from '@/lib/server/billing/service';

/** One of the platform's invoices to this organisation, for printing. */
export const GET = route(async ({ orgId, params }) => invoiceFor(orgId, idParam(params)), {
  permission: { module: 'billing', action: 'view' },
});
