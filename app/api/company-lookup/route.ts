import { NextResponse } from 'next/server';
import { z } from 'zod';
import { route, query, forbidden, toResponse } from '@/lib/server/http';
import { hasPermission } from '@/lib/rbac';
import { cinFacts, lookupCompany } from '@/lib/server/integrations/party-lookup';
import { snapshotMode } from '@/lib/demo-snapshot';

// A company's details from its CIN (integrations/party-lookup.ts): what the
// number says (listed, state, year of incorporation, kind), and the exact
// incorporation date and name from the MCA record when a company lookup
// service is set up. Anyone who may add a customer or vendor may ask.

const Query = z.object({ cin: z.string().trim().min(21).max(21) });

const live = route(async ({ role, req }) => {
  const q = query(req, Query);
  if (!['sales', 'purchases'].some((m) => hasPermission(role, m, 'view'))) throw forbidden('Your role cannot look up companies.');
  return lookupCompany(q.cin);
});

// The online demo answers from the number alone, as the GSTIN lookup does there.
export const GET: typeof live = async (req, context) => {
  if (!snapshotMode()) return live(req, context);
  try {
    return NextResponse.json(cinFacts(query(req, Query).cin));
  } catch (err) {
    return toResponse(err);
  }
};
