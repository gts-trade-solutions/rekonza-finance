import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body } from '@/lib/server/http';
import { auditMeta } from '@/lib/server/audit';
import { requestPortalCode, verifyPortalCode } from '@/lib/server/services/portal-login';

// Signing in to the customer or vendor portal by email (services/portal-login.ts):
// ask for a code, then give it back for the portal (or portals) it opens.

const Input = z.discriminatedUnion('action', [
  z.object({ action: z.literal('request'), email: z.string().trim().min(3).max(190) }),
  z.object({ action: z.literal('verify'), email: z.string().trim().min(3).max(190), code: z.string().trim().min(6).max(6) }),
]);

export const POST = route(
  async ({ req }) => {
    const input = await body(req, Input);
    const ip = auditMeta(req).ip;
    if (input.action === 'request') return requestPortalCode(db, input.email, ip);
    return transaction((trx) => verifyPortalCode(trx, input.email, input.code, ip));
  },
  { public: true },
);
