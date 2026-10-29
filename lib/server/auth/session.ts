import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Sessions.
//
// Server-side, in a table, rather than a self-contained JWT. The difference
// that matters for a finance system: when an admin disables a user or someone
// signs out, access has to stop *now*. A JWT cannot be recalled — it stays
// valid until it expires, and the usual workaround is a revocation list, which
// is a sessions table with extra steps.
//
// The cookie carries a random token. What is stored is its SHA-256, so a
// database leak does not hand over live sessions — the same reason you store
// password hashes rather than passwords.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import type { RoleName } from '../../types';
import type { CustomPermissions } from '../../rbac';
import { db } from '../db';
import { passwordExpired } from './password';

// Not 'rekonza_session': the original finance app runs on localhost too, and
// cookies are shared across ports, so the two would sign each other out.
export const SESSION_COOKIE = 'rekonza_mvp_session';

const TTL_HOURS = Number(process.env.SESSION_TTL_HOURS) || 168; // one week

export interface SessionUser {
  userId: number;
  orgId: number;
  name: string;
  email: string;
  role: RoleName;
  homeBranchId: number | null;
  activeBranchId: number | null;
  /** The first 16 hex of the token's hash: names this session in the sign-in list without revealing it. */
  sessionId?: string;
  /** The book requires two-step sign-in of this user and they have not set it up: nothing else is allowed until they do. */
  mfaSetupRequired?: boolean;
  /** Their password has expired, or is a temporary one an admin gave: nothing else until it is changed. */
  passwordChangeRequired?: boolean;
  /** A custom role's grants, which replace the built-in role's matrix. Null for the built-in roles. */
  permissions?: CustomPermissions | null;
  customRoleName?: string | null;
}

/** How often last_seen_at is written. Idle sign-out is measured in minutes, so a write per request buys nothing. */
const TOUCH_MS = 60_000;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** 256 bits of randomness, url-safe. Long enough that guessing is not a threat. */
function newToken(): string {
  return randomBytes(32).toString('base64url');
}

function expiryFromNow(): Date {
  return new Date(Date.now() + TTL_HOURS * 3600_000);
}

export async function createSession(
  userId: number,
  orgId: number,
  meta: { ip?: string | null; userAgent?: string | null; activeBranchId?: number | null } = {},
): Promise<{ token: string; expiresAt: Date }> {
  const token = newToken();
  const expiresAt = expiryFromNow();

  await db
    .insertInto('sessions')
    .values({
      token_hash: sha256(token),
      user_id: userId,
      org_id: orgId,
      active_branch_id: meta.activeBranchId ?? null,
      ip: meta.ip ?? null,
      user_agent: meta.userAgent?.slice(0, 500) ?? null,
      expires_at: expiresAt,
      last_seen_at: new Date(),
    })
    .execute();

  return { token, expiresAt };
}

/**
 * Resolve a raw cookie token to the user behind it.
 *
 * Joins users so a disabled account fails here rather than three layers up,
 * and re-reads the role every request — a demotion must take effect on the
 * next click, not on the next sign-in.
 */
export async function resolveSession(token: string | undefined): Promise<SessionUser | null> {
  if (!token) return null;

  const row = await db
    .selectFrom('sessions')
    .innerJoin('users', 'users.id', 'sessions.user_id')
    .leftJoin('custom_roles', 'custom_roles.id', 'users.custom_role_id')
    .select([
      'sessions.token_hash',
      'sessions.org_id',
      'sessions.active_branch_id',
      'sessions.expires_at',
      'sessions.revoked_at',
      'sessions.last_seen_at',
      'sessions.created_at',
      'users.id as user_id',
      'users.name',
      'users.email',
      'users.role',
      'users.home_branch_id',
      'users.is_active',
      'users.mfa_enabled_at',
      'users.password_changed_at',
      'custom_roles.name as custom_role_name',
      'custom_roles.permissions as custom_permissions',
    ])
    .where('sessions.token_hash', '=', sha256(token))
    .executeTakeFirst();

  if (!row) return null;
  if (row.revoked_at) return null;
  if (!row.is_active) return null;
  if (new Date(row.expires_at) < new Date()) return null;

  // The book's idle sign-out (Settings → Policies). Read here rather than through
  // org-settings so the session layer does not depend on the services above it.
  const now = Date.now();
  const seen = new Date(row.last_seen_at ?? row.created_at).getTime();
  const policy = await sessionPolicy(row.org_id);
  const idle = policy.idleMinutes;
  if (idle > 0 && now - seen > idle * 60_000) {
    await db.updateTable('sessions').set({ revoked_at: new Date(), end_reason: 'idle' })
      .where('token_hash', '=', row.token_hash).where('revoked_at', 'is', null).execute();
    return null;
  }
  if (now - seen > TOUCH_MS) {
    await db.updateTable('sessions').set({ last_seen_at: new Date(now) }).where('token_hash', '=', row.token_hash).execute();
  }

  return {
    userId: row.user_id,
    orgId: row.org_id,
    name: row.name,
    email: row.email,
    role: row.role as RoleName,
    homeBranchId: row.home_branch_id,
    activeBranchId: row.active_branch_id ?? row.home_branch_id,
    sessionId: row.token_hash.slice(0, 16),
    // Re-read every request, like the role: a changed grant applies on the next click.
    permissions: row.role !== 'admin' && row.custom_permissions
      ? (typeof row.custom_permissions === 'string' ? JSON.parse(row.custom_permissions) : row.custom_permissions) as CustomPermissions
      : null,
    customRoleName: row.role !== 'admin' ? row.custom_role_name : null,
    mfaSetupRequired: !row.mfa_enabled_at && (policy.requireMfa === 'everyone' || (policy.requireMfa === 'admins' && row.role === 'admin')),
    passwordChangeRequired: passwordExpired(row.password_changed_at, policy.passwordExpiryDays),
  };
}

/** Idle sign-out and the two-step requirement, in one read. */
async function sessionPolicy(orgId: number): Promise<{ idleMinutes: number; requireMfa: string; passwordExpiryDays: number }> {
  const rows = await db.selectFrom('settings').select(['setting_key', 'value'])
    .where('org_id', '=', orgId).where('scope', '=', 'policy').where('setting_key', 'in', ['sessionIdleMinutes', 'requireMfa', 'password']).execute();
  const get = (k: string) => {
    const v = rows.find((r) => r.setting_key === k)?.value;
    if (typeof v !== 'string') return v;
    try { return JSON.parse(v); } catch { return v; }
  };
  return {
    idleMinutes: Number(get('sessionIdleMinutes') ?? 0) || 0,
    requireMfa: String(get('requireMfa') ?? 'off'),
    passwordExpiryDays: Number((get('password') as { expiryDays?: number } | undefined)?.expiryDays ?? 0) || 0,
  };
}

/** The current request's session, by its hash: what moving it to another company changes. */
export async function currentSessionHash(): Promise<string | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return token ? sha256(token) : null;
}

/** The signed-in user for the current request, or null. */
export async function currentUser(): Promise<SessionUser | null> {
  const jar = await cookies();
  return resolveSession(jar.get(SESSION_COOKIE)?.value);
}

export async function revokeSession(token: string | undefined): Promise<void> {
  if (!token) return;
  await db
    .updateTable('sessions')
    .set({ revoked_at: new Date(), end_reason: 'signed_out' })
    .where('token_hash', '=', sha256(token))
    .execute();
}

/** Sign a user out everywhere — used when a password changes or an account is disabled. */
export async function revokeAllSessions(userId: number): Promise<void> {
  await db
    .updateTable('sessions')
    .set({ revoked_at: new Date(), end_reason: 'revoked' })
    .where('user_id', '=', userId)
    .where('revoked_at', 'is', null)
    .execute();
}

/** Which branch this session is acting in. Persisted so it survives a reload. */
export async function setActiveBranch(token: string | undefined, branchId: number): Promise<void> {
  if (!token) return;
  await db
    .updateTable('sessions')
    .set({ active_branch_id: branchId })
    .where('token_hash', '=', sha256(token))
    .execute();
}

/** Housekeeping: drop sessions that expired more than a week ago. */
export async function pruneSessions(): Promise<number> {
  const cutoff = new Date(Date.now() - 7 * 24 * 3600_000);
  const res = await db.deleteFrom('sessions').where('expires_at', '<', cutoff).executeTakeFirst();
  return Number(res.numDeletedRows ?? 0);
}

export const cookieOptions = (expiresAt: Date) =>
  ({
    httpOnly: true, // JavaScript cannot read it, so XSS cannot steal it
    sameSite: 'lax' as const, // blocks cross-site form posts riding the session
    secure: process.env.NODE_ENV === 'production', // plain HTTP in local dev only
    path: '/',
    expires: expiresAt,
  });

/**
 * Constant-time string comparison, for anything compared against a secret.
 *
 * `===` returns as soon as two bytes differ, and that timing difference is
 * measurable across a network for a long enough secret.
 */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
