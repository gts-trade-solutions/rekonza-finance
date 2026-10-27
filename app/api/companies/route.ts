import { z } from 'zod';
import { db, transaction } from '@/lib/server/db';
import { route, body, unauthorized } from '@/lib/server/http';
import { currentSessionHash } from '@/lib/server/auth/session';
import { createCompany, myCompanies, switchCompany } from '@/lib/server/auth/companies';

// The companies the signed-in person works in: listing them, moving between
// them, and making a new one.

export const GET = route(async ({ user }) => ({ current: String(user.orgId), companies: await myCompanies(db, user.email) }));

const Input = z.discriminatedUnion('action', [
  z.object({ action: z.literal('switch'), orgId: z.coerce.number().int().positive(), code: z.string().trim().max(20).nullish() }),
  z.object({
    action: z.literal('create'), name: z.string().trim().min(2).max(150), stateCode: z.string().regex(/^\d{2}$/),
    gstin: z.string().trim().max(15).nullish(), pan: z.string().trim().max(10).nullish(),
  }),
]);

export const POST = route(async ({ user, req }) => {
  const input = await body(req, Input);
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  const userAgent = req.headers.get('user-agent');
  if (input.action === 'create') return transaction((trx) => createCompany(trx, user, input));
  const hash = await currentSessionHash();
  if (!hash) throw unauthorized();
  return switchCompany(db, user, hash, input.orgId, { code: input.code, ip, userAgent });
});
