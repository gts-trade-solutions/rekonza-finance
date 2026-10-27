import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/server/db';
import { createSession, cookieOptions, SESSION_COOKIE } from '@/lib/server/auth/session';
import { route, body, ApiError, asId } from '@/lib/server/http';
import { logAudit } from '@/lib/server/audit';

// ─────────────────────────────────────────────────────────────────────────────
// The demo door.
//
// One click into a fully worked set of books, with no password and no sign-up.
// A visitor evaluating accounting software wants to see a trial balance that
// ties, not an empty dashboard.
//
// The safety is that this can only ever open onto an organisation flagged
// is_demo — a flag no sign-up can set, only the seed script. If the demo book
// has not been seeded, this endpoint has nothing to open and says so. It cannot
// be pointed at a customer's ledger by any input, because it takes none that
// name an organisation.
//
// The demo book is shared and writable on purpose: an evaluator who cannot
// raise an invoice has not evaluated anything. It is rebuilt with
// `npm run db:seed -- --fresh`, which now touches demo organisations only.
// ─────────────────────────────────────────────────────────────────────────────

const DemoInput = z.object({
  /** Which seeded user to sign in as. Each role sees a different app. */
  role: z.enum(['admin', 'accountant', 'sales', 'viewer']).default('admin'),
});

export const POST = route(
  async ({ req }) => {
    const { role } = await body(req, DemoInput);
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
    const userAgent = req.headers.get('user-agent');

    const org = await db
      .selectFrom('organizations')
      .select(['id', 'name'])
      .where('is_demo', '=', 1)
      .orderBy('id')
      .executeTakeFirst();

    if (!org) {
      throw new ApiError(
        503,
        'The demo book is not available on this server. Create an account to start your own.',
        'no_demo',
      );
    }

    // Falls back to any active user in the demo org, so a seed that names its
    // roles differently still opens rather than 500-ing.
    const user =
      (await db
        .selectFrom('users')
        .select(['id', 'name', 'email', 'role', 'home_branch_id'])
        .where('org_id', '=', org.id)
        .where('is_active', '=', 1)
        .where('role', '=', role)
        .orderBy('id')
        .executeTakeFirst()) ??
      (await db
        .selectFrom('users')
        .select(['id', 'name', 'email', 'role', 'home_branch_id'])
        .where('org_id', '=', org.id)
        .where('is_active', '=', 1)
        .orderBy('id')
        .executeTakeFirst());

    if (!user) {
      throw new ApiError(503, 'The demo book has no users to sign in as.', 'no_demo_user');
    }

    const { token, expiresAt } = await createSession(user.id, org.id, {
      ip,
      userAgent,
      activeBranchId: user.home_branch_id,
    });

    await logAudit({
      orgId: org.id,
      actorUserId: user.id,
      actorName: user.name,
      action: 'login',
      targetType: 'session',
      targetId: String(user.id),
      detail: `Demo sign-in as ${user.role}`,
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
      org: { id: asId(org.id), name: org.name },
    });
    res.cookies.set(SESSION_COOKIE, token, cookieOptions(expiresAt));
    return res;
  },
  { public: true },
);
