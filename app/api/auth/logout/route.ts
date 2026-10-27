import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { revokeSession, SESSION_COOKIE } from '@/lib/server/auth/session';
import { route } from '@/lib/server/http';
import { logAudit, auditMeta } from '@/lib/server/audit';

export const POST = route(async ({ user, req }) => {
  const jar = await cookies();
  // Revoke server-side first. Clearing the cookie alone would leave a working
  // session behind for anyone who copied it.
  await revokeSession(jar.get(SESSION_COOKIE)?.value);

  await logAudit({
    orgId: user.orgId,
    actorUserId: user.userId,
    actorName: user.name,
    action: 'login',
    targetType: 'session',
    targetId: String(user.userId),
    detail: 'Signed out',
    ...auditMeta(req),
  });

  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, '', { path: '/', maxAge: 0 });
  return res;
}, { duringMfaSetup: true });
