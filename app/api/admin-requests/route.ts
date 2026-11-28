import { z } from 'zod';
import { route, body } from '@/lib/server/http';
import { decide, httpExecutor, listRequests, withdraw } from '@/lib/server/services/admin-requests';

// Requests to undo or change posted work that wait for an admin
// (services/admin-requests.ts): the list (an admin's: the whole book's; anyone
// else's: their own), an admin's Approve or Reject, and a person withdrawing
// their own while it waits.

export const GET = route(async ({ orgId, user }) => ({ requests: await listRequests(orgId, user), isAdmin: user.role === 'admin' }));

const Input = z.discriminatedUnion('action', [
  z.object({ action: z.literal('approve'), id: z.coerce.number().int().positive(), note: z.string().max(500).nullish() }),
  z.object({ action: z.literal('reject'), id: z.coerce.number().int().positive(), note: z.string().max(500).nullish() }),
  z.object({ action: z.literal('withdraw'), id: z.coerce.number().int().positive() }),
]);

/** Where this server answers, to carry out an approved request on itself. */
function selfOrigin(req: Request): string {
  if (process.env.APP_INTERNAL_URL) return process.env.APP_INTERNAL_URL.replace(/\/$/, '');
  const host = req.headers.get('host');
  const proto = req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() || new URL(req.url).protocol.replace(':', '');
  return host ? `${proto}://${host}` : new URL(req.url).origin;
}

export const POST = route(async ({ user, req }) => {
  const input = await body(req, Input);
  if (input.action === 'withdraw') { await withdraw(req, user, input.id); return { ok: true }; }
  return decide(req, user, input.id, input.action, input.note ?? null, httpExecutor(selfOrigin(req)));
});
