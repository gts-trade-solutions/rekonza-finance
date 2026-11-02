import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Several companies, one person.
//
// A person is a user in each company they work in: the same email, with the
// role that company's admin gave them there. Signed in to one, they can move
// to another without signing in again — the session moves to their user in
// that company, and that company's own rules apply on the way in: its
// allowed addresses, and their two-step code there if they have one.
//
// A new company is made the way signing up makes one, with them as its admin
// and the password they already use.
// ─────────────────────────────────────────────────────────────────────────────

import { randomBytes } from 'node:crypto';
import type { Executor, Trx } from '../db';
import { ApiError, badRequest, forbidden, notFound } from '../http';
import { logAudit } from '../audit';
import { bootstrap } from '../seed/bootstrap';
import { checkCode, LOCKOUT_MINUTES, MAX_ATTEMPTS } from './mfa';
import { assertSignInAllowed } from './sign-in-rules';
import type { SessionUser } from './session';

/**
 * The demo book is open to anyone through its door, under a shared password
 * everyone knows. A session in it must lead nowhere else: no switching to
 * another company of that email, and no making one (which would be a real
 * book signed in with that public password).
 */
async function isDemo(ex: Executor, orgId: number) {
  const o = await ex.selectFrom('organizations').select('is_demo').where('id', '=', orgId).executeTakeFirst();
  return !!o?.is_demo;
}
const DEMO_STAYS = 'The demo book is shared with everyone, so it cannot open or create other companies. Create your own account to start a real book.';

/** Every company this person has an active user in; from the demo book, only the demo book. */
export async function myCompanies(ex: Executor, email: string, currentOrgId?: number) {
  if (currentOrgId && await isDemo(ex, currentOrgId)) {
    const o = await ex.selectFrom('organizations').select(['id', 'name', 'legal_name']).where('id', '=', currentOrgId).executeTakeFirstOrThrow();
    return [{ orgId: String(o.id), name: o.legal_name ?? o.name, isDemo: true, role: 'admin', needsCode: false }];
  }
  const rows = await ex.selectFrom('users as u').innerJoin('organizations as o', 'o.id', 'u.org_id')
    .select(['u.org_id', 'o.name', 'o.legal_name', 'o.is_demo', 'u.role', 'u.mfa_enabled_at'])
    .where('u.email', '=', email).where('u.is_active', '=', 1).orderBy('o.name').execute();
  return rows.map((r) => ({
    orgId: String(r.org_id), name: r.legal_name ?? r.name, isDemo: !!r.is_demo, role: r.role, needsCode: !!r.mfa_enabled_at,
  }));
}

/**
 * Move a session to the person's user in another company. The session's own
 * token stays; who it is and where it points change.
 */
export async function switchCompany(
  ex: Executor, me: SessionUser, sessionTokenHash: string, targetOrgId: number,
  meta: { code?: string | null; ip: string | null; userAgent: string | null },
) {
  if (targetOrgId === me.orgId) return { orgId: me.orgId };
  if (await isDemo(ex, me.orgId)) throw forbidden(DEMO_STAYS);
  const target = await ex.selectFrom('users').select(['id', 'org_id', 'name', 'role', 'is_active', 'locked_until', 'mfa_enabled_at', 'home_branch_id', 'failed_logins'])
    .where('email', '=', me.email).where('org_id', '=', targetOrgId).executeTakeFirst();
  if (!target || !target.is_active) throw forbidden('You do not have access to that company. Its admin can add you.');
  if (target.locked_until && new Date(target.locked_until) > new Date()) throw new ApiError(429, 'Your account in that company is locked for now. Try again later.', 'locked');
  const who = { id: target.id, orgId: target.org_id, name: target.name, role: target.role };
  await assertSignInAllowed(ex, who, meta.ip, meta.userAgent);
  // Their two-step code in that company, when they have one there.
  if (target.mfa_enabled_at) {
    if (!meta.code) throw new ApiError(401, 'Enter the code from your authenticator app for that company.', 'mfa_code_required');
    if (!(await checkCode(ex, target.id, meta.code))) {
      // Counted like a wrong code at sign-in: otherwise a session in one company
      // could guess the code for the next one without end.
      const attempts = target.failed_logins + 1;
      await ex.updateTable('users').set({
        failed_logins: attempts, locked_until: attempts >= MAX_ATTEMPTS ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000) : null,
      }).where('id', '=', target.id).execute();
      throw new ApiError(401, 'That code is not right.', 'mfa_code_wrong');
    }
    await ex.updateTable('users').set({ failed_logins: 0, locked_until: null }).where('id', '=', target.id).execute();
  }
  const branch = target.home_branch_id
    ?? (await ex.selectFrom('branches').select('id').where('org_id', '=', target.org_id).where('is_active', '=', 1).orderBy('is_primary', 'desc').executeTakeFirst())?.id
    ?? null;
  await ex.updateTable('sessions').set({ user_id: target.id, org_id: target.org_id, active_branch_id: branch })
    .where('token_hash', '=', sessionTokenHash).where('revoked_at', 'is', null).execute();
  await logAudit({
    orgId: me.orgId, actorUserId: me.userId, actorName: me.name, action: 'login', targetType: 'session', targetId: String(me.userId),
    detail: `Moved to company ${targetOrgId}`, ip: meta.ip, userAgent: meta.userAgent,
  });
  await logAudit({
    orgId: target.org_id, actorUserId: target.id, actorName: target.name, action: 'login', targetType: 'session', targetId: String(target.id),
    detail: `Came in from company ${me.orgId}`, ip: meta.ip, userAgent: meta.userAgent,
  });
  return { orgId: target.org_id };
}

/** A new company, with this person as its admin, signing in with the password they already use. */
export async function createCompany(trx: Trx, me: SessionUser, input: { name: string; stateCode: string; gstin?: string | null; pan?: string | null }) {
  const name = input.name.trim();
  if (name.length < 2) throw badRequest('Give the company its name.');
  if (!/^\d{2}$/.test(input.stateCode)) throw badRequest('Choose the state it is registered in.');
  if (await isDemo(trx, me.orgId)) throw forbidden(DEMO_STAYS);
  const gstin = input.gstin?.trim().toUpperCase() || null;
  if (gstin && gstin.slice(0, 2) !== input.stateCode) throw badRequest('That GSTIN belongs to another state.');
  const pan = (input.pan?.trim().toUpperCase() || (gstin ? gstin.slice(2, 12) : '')) || null;
  const mine = await trx.selectFrom('users').select(['password_hash']).where('id', '=', me.userId).executeTakeFirst();
  if (!mine?.password_hash) throw notFound('Your account was not found.');
  const created = await bootstrap(trx, {
    minimal: true,
    org: { name, pan, email: me.email, gstRegistrationType: gstin ? 'regular' : 'unregistered' },
    branch: { name: name.slice(0, 150), stateCode: input.stateCode, gstin, address: null },
    // Replaced at once by the password they already use.
    admin: { name: me.name, email: me.email, password: randomBytes(24).toString('base64url') },
  });
  const adminId = Object.values(created.users)[0];
  await trx.updateTable('users').set({ password_hash: mine.password_hash }).where('id', '=', adminId).execute();
  await logAudit({
    trx, orgId: created.orgId, actorUserId: adminId, actorName: me.name, action: 'create', targetType: 'organization',
    targetId: created.orgId, targetLabel: name, detail: `Company created by ${me.email} from company ${me.orgId}`,
  });
  return { orgId: created.orgId };
}

