import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/server/db';
import { createSession, cookieOptions, SESSION_COOKIE } from '@/lib/server/auth/session';
import { answerChallenge, LOCKOUT_MINUTES, MAX_ATTEMPTS, mfaStatus } from '@/lib/server/auth/mfa';
import { route, body, ApiError, asId } from '@/lib/server/http';
import { logAudit } from '@/lib/server/audit';
import { afterSignIn, assertSignInAllowed, knownDevice } from '@/lib/server/auth/sign-in-rules';

// The second step of signing in: the code from the authenticator app (or a
// recovery code) against the challenge the password earned.

const Input = z.object({
  challenge: z.string().min(20).max(100),
  code: z.string().trim().min(6, 'Enter the six-digit code.').max(20),
});

export const POST = route(
  async ({ req }) => {
    const { challenge, code } = await body(req, Input);
    // Read first: the last wrong try deletes the challenge.
    const row = await db.selectFrom('mfa_challenges').select('user_id')
      .where('token_hash', '=', createHash('sha256').update(challenge).digest('hex')).executeTakeFirst();
    let ok;
    try {
      ok = await answerChallenge(db, challenge, code);
    } catch (err) {
      // A wrong code counts against the account like a wrong password does, so
      // a stolen password cannot buy unlimited guesses at the code.
      if (row && !/expired/.test(err instanceof Error ? err.message : '')) {
        const u = await db.selectFrom('users').select(['failed_logins', 'org_id', 'name']).where('id', '=', row.user_id).executeTakeFirstOrThrow();
        const attempts = u.failed_logins + 1;
        await db.updateTable('users').set({
          failed_logins: attempts, locked_until: attempts >= MAX_ATTEMPTS ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000) : null,
        }).where('id', '=', row.user_id).execute();
        await logAudit({
          orgId: u.org_id, actorUserId: row.user_id, actorName: u.name, action: 'login', targetType: 'session',
          targetId: String(row.user_id), detail: `Failed two-step code (attempt ${attempts})`,
        });
      }
      throw err;
    }

    const user = await db.selectFrom('users')
      .select(['id', 'org_id', 'name', 'email', 'role', 'home_branch_id', 'is_active', 'locked_until'])
      .where('id', '=', ok.userId).executeTakeFirstOrThrow();
    if (!user.is_active) throw new ApiError(403, 'This account has been disabled.', 'disabled');
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      throw new ApiError(429, 'Too many failed attempts. Try again later.', 'locked');
    }

    const who = { id: user.id, orgId: user.org_id, name: user.name, role: user.role };
    await assertSignInAllowed(db, who, ok.ip, ok.userAgent);
    await db.updateTable('users').set({ failed_logins: 0, locked_until: null, last_login_at: new Date() }).where('id', '=', user.id).execute();
    const device = await knownDevice(db, user.id, ok.userAgent);
    const { token, expiresAt } = await createSession(user.id, user.org_id, {
      ip: ok.ip, userAgent: ok.userAgent, activeBranchId: user.home_branch_id,
    });
    await afterSignIn(db, who, ok.ip, ok.userAgent, device);
    const status = await mfaStatus(db, user.id);
    await logAudit({
      orgId: user.org_id, actorUserId: user.id, actorName: user.name, action: 'login', targetType: 'session', targetId: String(user.id),
      detail: ok.how === 'recovery' ? `Signed in with a recovery code (${status.recoveryLeft} left)` : 'Signed in with an authenticator code',
      ip: ok.ip, userAgent: ok.userAgent,
    });

    const res = NextResponse.json({
      user: {
        id: asId(user.id), name: user.name, email: user.email, role: user.role,
        branchId: user.home_branch_id ? asId(user.home_branch_id) : null,
      },
      usedRecoveryCode: ok.how === 'recovery',
      recoveryLeft: status.recoveryLeft,
    });
    res.cookies.set(SESSION_COOKIE, token, cookieOptions(expiresAt));
    return res;
  },
  { public: true },
);
