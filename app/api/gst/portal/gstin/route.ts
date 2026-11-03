import { NextResponse } from 'next/server';
import { z } from 'zod';
import { route, query, forbidden, toResponse } from '@/lib/server/http';
import { hasPermission } from '@/lib/rbac';
import { auditMeta } from '@/lib/server/audit';
import { lookupGstin } from '@/lib/server/integrations/gst/returns-service';
import { gstinFacts } from '@/lib/server/integrations/party-lookup';
import { snapshotMode } from '@/lib/demo-snapshot';

// A GSTIN's registered details from the GST system — legal and trade name,
// address, status, taxpayer type — to fill in a customer or vendor, as Zoho's
// "prefill from GSTIN" does. Public information; anyone who may add a party
// may ask.

const Query = z.object({ gstin: z.string().trim().min(15).max(15) });

const live = route(async ({ role, req }) => {
  const q = query(req, Query);
  if (!['sales', 'purchases', 'gst'].some((m) => hasPermission(role, m, 'view'))) throw forbidden('Your role cannot look up GSTINs.');
  return lookupGstin(q.gstin, auditMeta(req).ip ?? undefined);
});

// The online demo has no book and is open to anyone, so it answers with what
// the number itself says and never spends a paid lookup.
export const GET: typeof live = async (req, context) => {
  if (!snapshotMode()) return live(req, context);
  try {
    return NextResponse.json(gstinFacts(query(req, Query).gstin));
  } catch (err) {
    return toResponse(err);
  }
};
