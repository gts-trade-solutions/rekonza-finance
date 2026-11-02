import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, ApiError } from '@/lib/server/http';
import { auditMeta } from '@/lib/server/audit';
import { requestPortalCode, verifyPortalCode } from '@/lib/server/services/portal-login';
import { bucket, count, overLimit } from '@/lib/server/auth/throttle';

// Signing in to the customer or vendor portal by email (services/portal-login.ts):
// ask for a code, then give it back for the portal (or portals) it opens.
//
// Each email allows a few tries of its own code; one address is also limited
// across every email it asks about, so codes cannot be guessed by spreading
// the guesses over many addresses, and codes cannot be sent to a list of them.

const Input = z.discriminatedUnion('action', [
  z.object({ action: z.literal('request'), email: z.string().trim().min(3).max(190) }),
  z.object({ action: z.literal('verify'), email: z.string().trim().min(3).max(190), code: z.string().trim().min(6).max(6) }),
]);

/** Requests and wrong codes from one address in a quarter of an hour. */
const IP_LIMIT = 20;
const WINDOW_MINUTES = 15;

export const POST = route(
  async ({ req }) => {
    const input = await body(req, Input);
    const ip = auditMeta(req).ip;
    const ipBucket = ip ? bucket('portal-ip', ip) : null;
    if (ipBucket && await overLimit(db, ipBucket, IP_LIMIT, WINDOW_MINUTES)) {
      throw new ApiError(429, 'Too many attempts from here. Try again in a quarter of an hour.', 'rate_limited');
    }
    if (input.action === 'request') {
      if (ipBucket) await count(db, ipBucket, WINDOW_MINUTES);
      return requestPortalCode(db, input.email, ip);
    }
    try {
      return await transaction((trx) => verifyPortalCode(trx, input.email, input.code, ip));
    } catch (err) {
      if (ipBucket) await count(db, ipBucket, WINDOW_MINUTES);
      throw err;
    }
  },
  { public: true },
);
