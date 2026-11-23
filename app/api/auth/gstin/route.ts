import { z } from 'zod';
import { db } from '@/lib/server/db';
import { route, query, ApiError } from '@/lib/server/http';
import { clientIp } from '@/lib/server/client-ip';
import { bucket, count, overLimit } from '@/lib/server/auth/throttle';
import { lookupGstin } from '@/lib/server/integrations/gst/returns-service';
import { signUpLookups } from '@/lib/server/integrations/lookup-allowance';

// The business's own GSTIN on the sign-up page, before anyone has an account:
// its registered name, state, PAN and address, to fill the form in. Public, so
// each address may ask a few times a quarter-hour — every answer can cost the
// business a lookup.
const LIMIT = 15;
export const GET = route(async ({ req }) => {
  const q = query(req, z.object({ gstin: z.string().trim().min(15).max(15) }));
  // Callers whose address cannot be told share one allowance, rather than having none.
  const ip = clientIp(req) ?? 'unknown';
  const b = bucket('gstin-lookup', ip);
  if (await overLimit(db, b, LIMIT, 15)) throw new ApiError(429, 'Too many lookups from here. Type the details, or try again in a quarter of an hour.', 'rate_limited');
  await count(db, b, 15);
  // Paid lookups have a day's allowance of their own, per address and for all
  // sign-ups (integrations/lookup-allowance.ts); past it the number still fills
  // the state and PAN.
  const d = await lookupGstin(q.gstin, undefined, signUpLookups(ip));
  return { gstin: d.gstin, pan: d.pan, legalName: d.legalName, tradeName: d.tradeName, status: d.status, address: d.address, fromPortal: d.fromPortal };
}, { public: true });
