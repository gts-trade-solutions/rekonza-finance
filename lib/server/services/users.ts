import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// The people who use a book, and the custom roles they can be given.
//
// There is no mail transport, so a new user is given a temporary password that
// the admin passes on; they change it from Settings → Sign-ins. Resetting a
// password or two-step sign-in ends the user's sessions everywhere.
//
// A book always keeps one active admin: the last one cannot be demoted,
// switched off, or given a custom role.
// ─────────────────────────────────────────────────────────────────────────────

import { randomBytes, randomInt } from 'node:crypto';
import type { Executor, Trx } from '../db';
import type { RoleName } from '../../types';
import { PERMISSION_MODULES, type Action, type CustomPermissions } from '../../rbac';
import { badRequest, conflict, notFound } from '../http';
import { hashPassword } from '../auth/password';
import { recordPasswordSet } from '../auth/password-policy';
import { resetMfa } from '../auth/mfa';

const ROLES: RoleName[] = ['admin', 'accountant', 'sales', 'staff', 'viewer'];

/** Readable, and meeting the password rules: upper, lower, digit, twelve long. */
export function temporaryPassword(): string {
  const body = randomBytes(9).toString('base64url').replace(/[-_]/g, 'x');
  return `Rk${body.slice(0, 8)}${randomInt(10, 100)}a`;
}

const parse = (v: unknown): CustomPermissions => (typeof v === 'string' ? JSON.parse(v) : v) as CustomPermissions;

export async function listCustomRoles(ex: Executor, orgId: number) {
  const rows = await ex.selectFrom('custom_roles as r')
    .select((eb) => ['r.id', 'r.name', 'r.base_role', 'r.permissions', 'r.description',
      eb.selectFrom('users as u').select((e) => e.fn.countAll<string>().as('n')).whereRef('u.custom_role_id', '=', 'r.id').as('users')])
    .where('r.org_id', '=', orgId).orderBy('r.name').execute();
  return rows.map((r) => ({
    id: String(r.id), name: r.name, baseRole: r.base_role, permissions: parse(r.permissions), description: r.description, userCount: Number(r.users ?? 0),
  }));
}

/** Keep only modules and actions the app knows, so a role cannot claim what nothing checks. */
function clean(permissions: CustomPermissions): CustomPermissions {
  const out: CustomPermissions = {};
  // Restricted voucher types, given by name: raising them is all there is.
  for (const [k, a] of Object.entries(permissions)) {
    if (/^voucher\.[A-Z0-9]{1,10}$/.test(k) && a.includes('create')) out[k] = ['create'];
  }
  for (const m of PERMISSION_MODULES) {
    const asked = permissions[m.key] ?? [];
    const kept = m.actions.filter((a) => asked.includes(a));
    // Anything beyond viewing needs viewing too.
    if (kept.length && !kept.includes('view')) kept.unshift('view');
    if (kept.length) out[m.key] = kept as Action[];
  }
  // Saved here, printing and exporting are exactly as ticked (rbac.ts).
  out.output = [];
  return out;
}

export async function saveCustomRole(
  trx: Trx, orgId: number,
  input: { id?: number | null; name: string; baseRole: Exclude<RoleName, 'admin'>; permissions: CustomPermissions; description?: string | null },
) {
  const name = input.name.trim();
  if (!name) throw badRequest('Give the role a name.');
  if (ROLES.includes(name.toLowerCase() as RoleName)) throw badRequest(`${name} is a standard role's name; choose another.`);
  if (!['accountant', 'sales', 'staff', 'viewer'].includes(input.baseRole)) throw badRequest('Build a custom role on accountant, sales, staff or viewer.');
  const permissions = clean(input.permissions);
  if (!Object.keys(permissions).some((k) => k !== 'output' && !k.startsWith('voucher.'))) throw badRequest('A role that can see nothing is not much use. Tick something it may do.');
  const clash = await trx.selectFrom('custom_roles').select('id').where('org_id', '=', orgId).where('name', '=', name)
    .$if(!!input.id, (q) => q.where('id', '!=', input.id!)).executeTakeFirst();
  if (clash) throw conflict(`There is already a role called ${name}.`);
  const values = { name, base_role: input.baseRole, permissions: JSON.stringify(permissions), description: input.description?.trim() || null };
  if (input.id) {
    const r = await trx.updateTable('custom_roles').set(values).where('id', '=', input.id).where('org_id', '=', orgId).executeTakeFirst();
    if (!Number(r.numUpdatedRows)) throw notFound('That role was not found.');
    // The users on it take the base role with it, for the questions a role name answers.
    await trx.updateTable('users').set({ role: input.baseRole }).where('custom_role_id', '=', input.id).execute();
    return input.id;
  }
  return Number((await trx.insertInto('custom_roles').values({ org_id: orgId, ...values }).executeTakeFirstOrThrow()).insertId);
}

export async function deleteCustomRole(trx: Trx, orgId: number, id: number) {
  const used = await trx.selectFrom('users').select('name').where('org_id', '=', orgId).where('custom_role_id', '=', id).execute();
  if (used.length) throw conflict(`${used.map((u) => u.name).join(', ')} ${used.length === 1 ? 'has' : 'have'} this role. Move them to another first.`);
  await trx.deleteFrom('custom_roles').where('id', '=', id).where('org_id', '=', orgId).execute();
}

export async function listUsers(ex: Executor, orgId: number) {
  const rows = await ex.selectFrom('users as u').leftJoin('branches as b', 'b.id', 'u.home_branch_id').leftJoin('custom_roles as r', 'r.id', 'u.custom_role_id')
    .select(['u.id', 'u.name', 'u.email', 'u.phone', 'u.role', 'u.custom_role_id', 'r.name as custom_role', 'u.home_branch_id', 'b.name as branch',
      'u.is_active', 'u.last_login_at', 'u.mfa_enabled_at', 'u.locked_until'])
    .where('u.org_id', '=', orgId).orderBy('u.is_active', 'desc').orderBy('u.name').execute();
  return rows.map((u) => ({
    id: String(u.id), name: u.name, email: u.email, phone: u.phone, role: u.role as RoleName,
    customRoleId: u.custom_role_id ? String(u.custom_role_id) : null, customRoleName: u.custom_role,
    homeBranchId: u.home_branch_id ? String(u.home_branch_id) : null, branchName: u.branch,
    isActive: !!u.is_active, lastLoginAt: u.last_login_at ? new Date(u.last_login_at).toISOString() : null,
    mfaOn: !!u.mfa_enabled_at, locked: !!u.locked_until && new Date(u.locked_until) > new Date(),
  }));
}

async function roleFor(trx: Trx, orgId: number, role: RoleName, customRoleId: number | null | undefined) {
  if (!customRoleId) return { role, custom_role_id: null };
  if (role === 'admin') throw badRequest('An admin can do everything; a custom role would only narrow it. Choose another role.');
  const r = await trx.selectFrom('custom_roles').select(['base_role']).where('id', '=', customRoleId).where('org_id', '=', orgId).executeTakeFirst();
  if (!r) throw badRequest('That custom role was not found.');
  return { role: r.base_role as RoleName, custom_role_id: customRoleId };
}

async function branchOk(trx: Trx, orgId: number, branchId: number | null | undefined) {
  if (!branchId) return null;
  const b = await trx.selectFrom('branches').select('id').where('id', '=', branchId).where('org_id', '=', orgId).executeTakeFirst();
  if (!b) throw badRequest('That branch was not found.');
  return branchId;
}

export async function addUser(
  trx: Trx, orgId: number,
  input: { name: string; email: string; phone?: string | null; role: RoleName; customRoleId?: number | null; homeBranchId?: number | null },
) {
  const email = input.email.trim().toLowerCase();
  // Sign-in finds a user by email alone, so an email belongs to one account anywhere.
  const taken = await trx.selectFrom('users').select('id').where('email', '=', email).executeTakeFirst();
  if (taken) throw conflict(`${email} already has an account. Use another email address.`);
  if (!ROLES.includes(input.role)) throw badRequest('Choose a role.');
  const temporary = temporaryPassword();
  const id = Number((await trx.insertInto('users').values({
    org_id: orgId, name: input.name.trim(), email, phone: input.phone?.trim() || null,
    ...(await roleFor(trx, orgId, input.role, input.customRoleId)),
    home_branch_id: await branchOk(trx, orgId, input.homeBranchId), password_hash: await hashPassword(temporary),
  }).executeTakeFirstOrThrow()).insertId);
  // Theirs to replace at the first sign-in: an admin knows this one.
  await recordPasswordSet(trx, id, '', { temporary: true });
  return { id, temporaryPassword: temporary };
}

async function otherActiveAdmins(trx: Trx, orgId: number, id: number) {
  const r = await trx.selectFrom('users').select((eb) => eb.fn.countAll<string>().as('n'))
    .where('org_id', '=', orgId).where('role', '=', 'admin').where('is_active', '=', 1).where('id', '!=', id).executeTakeFirstOrThrow();
  return Number(r.n);
}

export async function updateUser(
  trx: Trx, orgId: number, id: number,
  patch: { name?: string; role?: RoleName; customRoleId?: number | null; homeBranchId?: number | null; isActive?: boolean },
) {
  const u = await trx.selectFrom('users').select(['id', 'name', 'role', 'is_active', 'custom_role_id']).where('id', '=', id).where('org_id', '=', orgId).forUpdate().executeTakeFirst();
  if (!u) throw notFound('That user was not found.');
  const role = patch.role ?? (u.role as RoleName);
  const custom = patch.customRoleId === undefined ? u.custom_role_id : patch.customRoleId;
  const next = await roleFor(trx, orgId, role, custom);
  const leavesAdmin = u.role === 'admin' && u.is_active && (next.role !== 'admin' || patch.isActive === false);
  if (leavesAdmin && (await otherActiveAdmins(trx, orgId, id)) === 0) {
    throw conflict(`${u.name} is the only active admin. Make someone else an admin first.`);
  }
  await trx.updateTable('users').set({
    ...next,
    ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
    ...(patch.homeBranchId !== undefined ? { home_branch_id: await branchOk(trx, orgId, patch.homeBranchId) } : {}),
    ...(patch.isActive !== undefined ? { is_active: patch.isActive ? 1 : 0 } : {}),
  }).where('id', '=', id).execute();
  // Switched off: out of every device at once.
  if (patch.isActive === false) await endSessions(trx, id, 'disabled');
  return { name: u.name, before: { role: u.role, customRoleId: u.custom_role_id, isActive: !!u.is_active }, after: next };
}

async function endSessions(trx: Trx, userId: number, reason: string) {
  await trx.updateTable('sessions').set({ revoked_at: new Date(), end_reason: reason })
    .where('user_id', '=', userId).where('revoked_at', 'is', null).execute();
}

/** A new temporary password, the lock lifted, and every session ended. */
export async function resetPassword(trx: Trx, orgId: number, id: number) {
  const u = await trx.selectFrom('users').select('id').where('id', '=', id).where('org_id', '=', orgId).executeTakeFirst();
  if (!u) throw notFound('That user was not found.');
  const temporary = temporaryPassword();
  await trx.updateTable('users').set({ password_hash: await hashPassword(temporary), failed_logins: 0, locked_until: null }).where('id', '=', id).execute();
  await recordPasswordSet(trx, id, '', { temporary: true });
  await endSessions(trx, id, 'password_reset');
  return temporary;
}

export async function resetUserMfa(trx: Trx, orgId: number, id: number) {
  await resetMfa(trx, orgId, id);
  await endSessions(trx, id, 'mfa_reset');
}
