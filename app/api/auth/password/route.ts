import { z } from 'zod';
import { db } from '@/lib/server/db';
import { route, body, badRequest } from '@/lib/server/http';
import { hashPassword, passwordProblems, verifyPassword } from '@/lib/server/auth/password';
import { logAudit, auditMeta } from '@/lib/server/audit';

// Change one's own password. The other sessions end; this one carries on.

const Input = z.object({ current: z.string().min(1, 'Enter your current password.'), next: z.string().min(1).max(200) });

export const POST = route(async ({ user, req }) => {
  const { current, next } = await body(req, Input);
  const u = await db.selectFrom('users').select('password_hash').where('id', '=', user.userId).executeTakeFirstOrThrow();
  if (!u.password_hash || !(await verifyPassword(u.password_hash, current))) throw badRequest('The current password is not right.');
  const problems = passwordProblems(next);
  if (problems.length) throw badRequest(problems.join(' '));
  if (next === current) throw badRequest('Choose a password different from the current one.');
  await db.updateTable('users').set({ password_hash: await hashPassword(next) }).where('id', '=', user.userId).execute();
  const others = await db.selectFrom('sessions').select('token_hash').where('user_id', '=', user.userId).where('revoked_at', 'is', null).execute();
  const mine = user.sessionId ?? '';
  for (const s of others) {
    if (s.token_hash.startsWith(mine) && mine) continue;
    await db.updateTable('sessions').set({ revoked_at: new Date(), end_reason: 'password_changed' }).where('token_hash', '=', s.token_hash).execute();
  }
  await logAudit({
    orgId: user.orgId, actorUserId: user.userId, actorName: user.name, action: 'update', targetType: 'user', targetId: user.userId,
    detail: 'Changed own password; signed out of other devices', ...auditMeta(req),
  });
  return { ok: true };
}, { duringMfaSetup: true });
