import { z } from 'zod';
import { db } from '@/lib/server/db';
import { route, query, ApiError } from '@/lib/server/http';
import { clientIp } from '@/lib/server/client-ip';
import { bucket, count, overLimit } from '@/lib/server/auth/throttle';
import { lookupGstin } from '@/lib/server/integrations/gst/returns-service';

// The business's own GSTIN on the sign-up page, before anyone has an account:
// its registered name, state, PAN and address, to fill the form in. Public, so
// each address may ask a few times a quarter-hour — every answer can cost the
// business a lookup.
const LIMIT = 15;
export const GET = route(async ({ req }) => {
  const q = query(req, z.object({ gstin: z.string().trim().min(15).max(15) }));
  const ip = clientIp(req);
  const b = ip ? bucket('gstin-lookup', ip) : null;
  if (b && await overLimit(db, b, LIMIT, 15)) throw new ApiError(429, 'Too many lookups from here. Type the details, or try again in a quarter of an hour.', 'rate_limited');
  if (b) await count(db, b, 15);
  const d = await lookupGstin(q.gstin);
  return { gstin: d.gstin, pan: d.pan, legalName: d.legalName, tradeName: d.tradeName, status: d.status, address: d.address, fromPortal: d.fromPortal };
}, { public: true });
