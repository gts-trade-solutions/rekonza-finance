import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/server/db';
import { verifyPassword, fakeVerify } from '@/lib/server/auth/password';
import { createSession, cookieOptions, SESSION_COOKIE } from '@/lib/server/auth/session';
import { route, body, ApiError, asId } from '@/lib/server/http';
import { logAudit } from '@/lib/server/audit';
import { createChallenge, LOCKOUT_MINUTES, MAX_ATTEMPTS } from '@/lib/server/auth/mfa';
import { afterSignIn, assertSignInAllowed, knownDevice } from '@/lib/server/auth/sign-in-rules';

const LoginInput = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address.'),
  password: z.string().min(1, 'Enter your password.'),
});

export const POST = route(
  async ({ req }) => {
    const { email, password } = await body(req, LoginInput);
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
    const userAgent = req.headers.get('user-agent');

    // One person may be a user in several companies, each with the same email.
    // The one whose password matches is signed in, the most recently used
    // first; failures count against that one.
    const candidates = await db
      .selectFrom('users')
      .select([
        'id', 'org_id', 'name', 'email', 'password_hash', 'role',
        'home_branch_id', 'is_active', 'failed_logins', 'locked_until', 'mfa_enabled_at',
      ])
      .where('email', '=', email)
      .orderBy('last_login_at', 'desc')
      .orderBy('id')
      .execute();
    let user = candidates[0];

    // One message for every failure below, and a matching amount of work when
    // the account does not exist. Telling the caller whether an email is
    // registered turns the login form into a customer list.
    const reject = () => new ApiError(401, 'Email or password is incorrect.', 'invalid_credentials');

    if (!user) {
      await fakeVerify();
      throw reject();
    }

    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      const mins = Math.ceil((new Date(user.locked_until).getTime() - Date.now()) / 60_000);
      throw new ApiError(
        429,
        `Too many failed attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`,
        'locked',
      );
    }

    if (!user.password_hash) {
      await fakeVerify();
      throw new ApiError(
        403,
        'This account has not been set up yet. Ask an admin to send an invitation.',
        'no_password',
      );
    }

    let ok = await verifyPassword(user.password_hash, password);
    for (const other of candidates.slice(1)) {
      if (ok) break;
      if (other.password_hash && (await verifyPassword(other.password_hash, password))) {
        user = other;
        ok = true;
      }
    }

    if (!ok) {
      const attempts = user.failed_logins + 1;
      await db
        .updateTable('users')
        .set({
          failed_logins: attempts,
          locked_until:
            attempts >= MAX_ATTEMPTS ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000) : null,
        })
        .where('id', '=', user.id)
        .execute();

      await logAudit({
        orgId: user.org_id,
        actorUserId: user.id,
        actorName: user.name,
        action: 'login',
        targetType: 'session',
        targetId: String(user.id),
        detail: `Failed sign-in (attempt ${attempts})`,
        ip,
        userAgent,
      });

      throw reject();
    }

    if (!user.is_active) {
      throw new ApiError(403, 'This account has been disabled.', 'disabled');
    }
    // The book's own limits: where from.
    const who = { id: user.id, orgId: user.org_id, name: user.name, role: user.role };
    await assertSignInAllowed(db, who, ip, userAgent);

    // Two-step sign-in: the password earns a challenge, not a session. The
    // failure counter is cleared only when the code is right too.
    if (user.mfa_enabled_at) {
      const challenge = await createChallenge(db, { id: user.id, orgId: user.org_id }, { ip, userAgent });
      await logAudit({
        orgId: user.org_id, actorUserId: user.id, actorName: user.name, action: 'login', targetType: 'session',
        targetId: String(user.id), detail: 'Password accepted; waiting for the authenticator code', ip, userAgent,
      });
      return { mfaRequired: true, challenge };
    }

    // A clean sign-in clears the counter, so a user who mistypes twice and then
    // succeeds does not carry those failures towards a future lockout.
    await db
      .updateTable('users')
      .set({ failed_logins: 0, locked_until: null, last_login_at: new Date() })
      .where('id', '=', user.id)
      .execute();

    const device = await knownDevice(db, user.id, userAgent);
    const { token, expiresAt } = await createSession(user.id, user.org_id, {
      ip,
      userAgent,
      activeBranchId: user.home_branch_id,
    });
    await afterSignIn(db, who, ip, userAgent, device);

    await logAudit({
      orgId: user.org_id,
      actorUserId: user.id,
      actorName: user.name,
      action: 'login',
      targetType: 'session',
      targetId: String(user.id),
      detail: 'Signed in',
      ip,
      userAgent,
    });

    const res = NextResponse.json({
      user: {
        id: asId(user.id),
        name: user.name,
        email: user.email,
        role: user.role,
        branchId: user.home_branch_id ? asId(user.home_branch_id) : null,
      },
    });
    res.cookies.set(SESSION_COOKIE, token, cookieOptions(expiresAt));
    return res;
  },
  { public: true },
);
