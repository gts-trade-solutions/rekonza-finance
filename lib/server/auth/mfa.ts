import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Two-step sign-in.
//
// Setting up: a new secret is held as pending until the first code from the
// app proves the phone has it; only then is it switched on, and ten recovery
// codes are shown, once. Signing in: the password earns a challenge, good for
// five minutes and five tries, and the code turns it into a session.
//
// A book can require it (Settings → Policies) of admins or of everyone. A user
// it applies to who has not set it up gets a session that can do nothing but
// set it up — route() refuses everything else until they have.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash, randomBytes } from 'node:crypto';
import type { Executor } from '../db';
import type { RoleName } from '../../types';
import { badRequest, conflict, forbidden } from '../http';
import { seal, unseal } from '../crypto/fields';
import { hashRecovery, matchCode, newRecoveryCodes, newSecret, otpauthUri } from './totp';

export type MfaRequirement = 'off' | 'admins' | 'everyone';
const CHALLENGE_MINUTES = 5;
const MAX_TRIES = 5;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const list = (v: unknown): string[] => {
  const x = typeof v === 'string' ? JSON.parse(v) : v;
  return Array.isArray(x) ? x.map(String) : [];
};

export async function mfaRequirement(ex: Executor, orgId: number): Promise<MfaRequirement> {
  const r = await ex.selectFrom('settings').select('value')
    .where('org_id', '=', orgId).where('scope', '=', 'policy').where('setting_key', '=', 'requireMfa').executeTakeFirst();
  const v = typeof r?.value === 'string' ? (() => { try { return JSON.parse(r.value as string); } catch { return r.value; } })() : r?.value;
  return v === 'admins' || v === 'everyone' ? v : 'off';
}

export const requiredFor = (req: MfaRequirement, role: RoleName) => req === 'everyone' || (req === 'admins' && role === 'admin');

export async function mfaStatus(ex: Executor, userId: number) {
  const u = await ex.selectFrom('users').select(['mfa_enabled_at', 'mfa_pending_secret', 'mfa_recovery_codes']).where('id', '=', userId).executeTakeFirstOrThrow();
  return {
    enabled: !!u.mfa_enabled_at,
    enabledAt: u.mfa_enabled_at ? new Date(u.mfa_enabled_at).toISOString() : null,
    pending: !u.mfa_enabled_at && !!u.mfa_pending_secret,
    recoveryLeft: u.mfa_enabled_at ? list(u.mfa_recovery_codes).length : 0,
  };
}

/** A new secret for the app to scan. Held as pending until a code confirms it. */
export async function startEnrolment(ex: Executor, user: { userId: number; email: string }, issuer: string) {
  const u = await ex.selectFrom('users').select('mfa_enabled_at').where('id', '=', user.userId).executeTakeFirstOrThrow();
  if (u.mfa_enabled_at) throw conflict('Two-step sign-in is already on. Turn it off first to move it to another phone.');
  const secret = newSecret();
  await ex.updateTable('users').set({ mfa_pending_secret: seal(secret) }).where('id', '=', user.userId).execute();
  return { secret, uri: otpauthUri(issuer, user.email, secret) };
}

/** The first code proves the phone has the secret: switch it on and hand out recovery codes. */
export async function confirmEnrolment(ex: Executor, userId: number, code: string, now = Date.now()) {
  const u = await ex.selectFrom('users').select(['mfa_pending_secret', 'mfa_enabled_at']).where('id', '=', userId).executeTakeFirstOrThrow();
  if (u.mfa_enabled_at) throw conflict('Two-step sign-in is already on.');
  if (!u.mfa_pending_secret) throw badRequest('Start setting it up first.');
  const step = matchCode(unseal(u.mfa_pending_secret)!, code, now, null);
  if (step === null) throw badRequest('That code is not right. Use the newest code, and check the phone sets its clock automatically.');
  const { plain, hashes } = newRecoveryCodes();
  await ex.updateTable('users').set({
    mfa_secret: u.mfa_pending_secret, mfa_pending_secret: null, mfa_enabled_at: new Date(now),
    mfa_last_step: step, mfa_recovery_codes: JSON.stringify(hashes),
  }).where('id', '=', userId).execute();
  return plain;
}

/**
 * Check a code: the app's code first, never the same one twice, then a
 * recovery code, which is used up.
 */
export async function checkCode(ex: Executor, userId: number, code: string, now = Date.now()): Promise<'app' | 'recovery' | null> {
  const u = await ex.selectFrom('users').select(['mfa_secret', 'mfa_last_step', 'mfa_recovery_codes', 'mfa_enabled_at'])
    .where('id', '=', userId).executeTakeFirst();
  if (!u?.mfa_enabled_at || !u.mfa_secret) return null;
  const last = u.mfa_last_step === null ? null : Number(u.mfa_last_step);
  const step = matchCode(unseal(u.mfa_secret)!, code, now, last);
  if (step !== null) {
    // Conditional, so two requests racing with one code cannot both pass.
    const r = await ex.updateTable('users').set({ mfa_last_step: step }).where('id', '=', userId)
      .where((eb) => eb.or([eb('mfa_last_step', 'is', null), eb('mfa_last_step', '<', step)])).executeTakeFirst();
    return Number(r.numUpdatedRows) ? 'app' : null;
  }
  const hashes = list(u.mfa_recovery_codes);
  const h = hashRecovery(code);
  if (code.trim().length >= 8 && hashes.includes(h)) {
    await ex.updateTable('users').set({ mfa_recovery_codes: JSON.stringify(hashes.filter((x) => x !== h)) }).where('id', '=', userId).execute();
    return 'recovery';
  }
  return null;
}

const clear = { mfa_secret: null, mfa_pending_secret: null, mfa_enabled_at: null, mfa_last_step: null, mfa_recovery_codes: null };

export async function disableMfa(ex: Executor, user: { userId: number; orgId: number; role: RoleName }, code: string) {
  if (requiredFor(await mfaRequirement(ex, user.orgId), user.role)) {
    throw forbidden('This book requires two-step sign-in for your role, so it cannot be turned off.');
  }
  if (!(await checkCode(ex, user.userId, code))) throw badRequest('That code is not right.');
  await ex.updateTable('users').set(clear).where('id', '=', user.userId).execute();
}

export async function regenerateRecoveryCodes(ex: Executor, userId: number, code: string) {
  if (!(await checkCode(ex, userId, code))) throw badRequest('That code is not right.');
  const { plain, hashes } = newRecoveryCodes();
  await ex.updateTable('users').set({ mfa_recovery_codes: JSON.stringify(hashes) }).where('id', '=', userId).execute();
  return plain;
}

/** An admin clears it for someone who has lost their phone; they set it up again at next sign-in. */
export async function resetMfa(ex: Executor, orgId: number, targetUserId: number) {
  const r = await ex.updateTable('users').set(clear).where('id', '=', targetUserId).where('org_id', '=', orgId).executeTakeFirst();
  if (!Number(r.numUpdatedRows)) throw badRequest('That user was not found.');
  await ex.deleteFrom('mfa_challenges').where('user_id', '=', targetUserId).execute();
}

// ── Between password and code ────────────────────────────────────────────────

export async function createChallenge(ex: Executor, user: { id: number; orgId: number }, meta: { ip?: string | null; userAgent?: string | null }) {
  const token = randomBytes(32).toString('base64url');
  await ex.deleteFrom('mfa_challenges').where('user_id', '=', user.id).execute();
  await ex.insertInto('mfa_challenges').values({
    token_hash: sha256(token), user_id: user.id, org_id: user.orgId, ip: meta.ip ?? null,
    user_agent: meta.userAgent?.slice(0, 500) ?? null, expires_at: new Date(Date.now() + CHALLENGE_MINUTES * 60_000),
  }).execute();
  return token;
}

/**
 * Answer a challenge with a code. Returns the user it signs in, or throws
 * with what to do next: a wrong code costs one of the five tries, and the
 * last one sends them back to the password.
 */
export async function answerChallenge(ex: Executor, token: string, code: string, now = Date.now()) {
  const hash = sha256(token);
  const c = await ex.selectFrom('mfa_challenges').selectAll().where('token_hash', '=', hash).executeTakeFirst();
  if (!c || new Date(c.expires_at).getTime() < now) {
    if (c) await ex.deleteFrom('mfa_challenges').where('token_hash', '=', hash).execute();
    throw forbidden('That sign-in has expired. Enter your password again.');
  }
  const how = await checkCode(ex, c.user_id, code, now);
  if (!how) {
    const tries = c.attempts + 1;
    if (tries >= MAX_TRIES) {
      await ex.deleteFrom('mfa_challenges').where('token_hash', '=', hash).execute();
      throw forbidden('Too many wrong codes. Enter your password again.');
    }
    await ex.updateTable('mfa_challenges').set({ attempts: tries }).where('token_hash', '=', hash).execute();
    throw badRequest(`That code is not right. ${MAX_TRIES - tries} tr${MAX_TRIES - tries === 1 ? 'y' : 'ies'} left.`);
  }
  await ex.deleteFrom('mfa_challenges').where('token_hash', '=', hash).execute();
  return { userId: c.user_id, orgId: c.org_id, how, ip: c.ip, userAgent: c.user_agent };
}

/** An account locks after this many wrong passwords or codes in a row, for this long. */
export const MAX_ATTEMPTS = 8;
export const LOCKOUT_MINUTES = 15;
