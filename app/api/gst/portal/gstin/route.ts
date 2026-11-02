import { z } from 'zod';
import { route, query, forbidden } from '@/lib/server/http';
import { hasPermission } from '@/lib/rbac';
import { auditMeta } from '@/lib/server/audit';
import { lookupGstin } from '@/lib/server/integrations/gst/returns-service';

// A GSTIN's registered details from the GST system — legal and trade name,
// address, status, taxpayer type — to fill in a customer or vendor, as Zoho's
// "prefill from GSTIN" does. Public information; anyone who may add a party
// may ask.

export const GET = route(async ({ role, req }) => {
  const q = query(req, z.object({ gstin: z.string().trim().min(15).max(15) }));
  if (!['sales', 'purchases', 'gst'].some((m) => hasPermission(role, m, 'view'))) throw forbidden('Your role cannot look up GSTINs.');
  return lookupGstin(q.gstin, auditMeta(req).ip ?? undefined);
});
