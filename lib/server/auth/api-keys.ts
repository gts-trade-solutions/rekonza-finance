import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// API keys: how other software signs in.
//
//   Authorization: Bearer rk_live_…
//
// A key is 192 random bits, shown once and kept as its SHA-256. It acts with
// the role it was given (a custom role narrows it as it would a person) in
// the name of the admin who made it, in that admin's branches; if the admin is
// switched off, the key stops. Keys never reach the settings, users, keys or
// sign-in routes: a leaked key can read and write the books, not take them over.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash, randomBytes } from 'node:crypto';
import { db, type Executor, type Trx } from '../db';
import type { RoleName } from '../../types';
import type { CustomPermissions } from '../../rbac';
import { badRequest, notFound } from '../http';
import type { SessionUser } from './session';

const PREFIX = 'rk_live_';
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Routes a key may never call, whatever its role. */
export const KEY_FORBIDDEN = ['/api/settings', '/api/auth', '/api/api-keys', '/api/webhooks', '/api/privacy', '/api/companies'];

export async function createApiKey(
  trx: Trx, orgId: number, userId: number,
  input: { name: string; role: RoleName; customRoleId?: number | null; expiresOn?: string | null },
) {
  if (!input.name.trim()) throw badRequest('Name the key after what will use it.');
  if (input.customRoleId) {
    const r = await trx.selectFrom('custom_roles').select('base_role').where('id', '=', input.customRoleId).where('org_id', '=', orgId).executeTakeFirst();
    if (!r) throw badRequest('That custom role was not found.');
    input = { ...input, role: r.base_role as RoleName };
  }
  const key = PREFIX + randomBytes(24).toString('base64url');
  const id = Number((await trx.insertInto('api_keys').values({
    org_id: orgId, name: input.name.trim(), prefix: key.slice(0, 14), key_hash: sha256(key), role: input.role,
    custom_role_id: input.customRoleId ?? null, created_by_user_id: userId, expires_on: input.expiresOn ?? null,
  }).executeTakeFirstOrThrow()).insertId);
  return { id, key };
}

export async function revokeApiKey(trx: Trx, orgId: number, id: number) {
  const r = await trx.updateTable('api_keys').set({ revoked_at: new Date() }).where('id', '=', id).where('org_id', '=', orgId).where('revoked_at', 'is', null).executeTakeFirst();
  if (!Number(r.numUpdatedRows)) throw notFound('That key was not found, or is already revoked.');
}

export async function listApiKeys(ex: Executor, orgId: number) {
  const rows = await ex.selectFrom('api_keys as k').innerJoin('users as u', 'u.id', 'k.created_by_user_id').leftJoin('custom_roles as r', 'r.id', 'k.custom_role_id')
    .select(['k.id', 'k.name', 'k.prefix', 'k.role', 'r.name as custom_role', 'u.name as created_by', 'k.expires_on', 'k.last_used_at', 'k.revoked_at', 'k.created_at'])
    .where('k.org_id', '=', orgId).orderBy('k.revoked_at').orderBy('k.id', 'desc').execute();
  const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
  return rows.map((k) => ({
    id: String(k.id), name: k.name, prefix: k.prefix, role: k.role, customRoleName: k.custom_role, createdBy: k.created_by,
    expiresOn: k.expires_on ? String(k.expires_on).slice(0, 10) : null, lastUsedAt: iso(k.last_used_at), revokedAt: iso(k.revoked_at), createdAt: iso(k.created_at),
  }));
}

// ── Signing a request in ─────────────────────────────────────────────────────

const LIMIT_PER_MINUTE = Number(process.env.API_RATE_LIMIT) || 120;
const windows = new Map<number, { start: number; count: number }>();

/** Requests over the per-minute limit are refused; the window resets each minute. */
export function overLimit(keyId: number, now = Date.now()): boolean {
  const w = windows.get(keyId);
  if (!w || now - w.start >= 60_000) {
    windows.set(keyId, { start: now, count: 1 });
    return false;
  }
  w.count += 1;
  return w.count > LIMIT_PER_MINUTE;
}

/** The user an API key acts as, or null when the request carries none (or a bad one). */
export async function apiKeyUser(req: Request, ex: Executor = db): Promise<(SessionUser & { apiKeyId: number }) | null> {
  const auth = req.headers.get('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token.startsWith(PREFIX)) return null;
  const k = await ex.selectFrom('api_keys as k').innerJoin('users as u', 'u.id', 'k.created_by_user_id')
    .leftJoin('custom_roles as r', 'r.id', 'k.custom_role_id')
    .select(['k.id', 'k.org_id', 'k.name', 'k.role', 'k.expires_on', 'k.revoked_at', 'k.last_used_at', 'u.id as user_id', 'u.is_active', 'u.home_branch_id', 'r.permissions'])
    .where('k.key_hash', '=', sha256(token)).executeTakeFirst();
  if (!k || k.revoked_at || !k.is_active) return null;
  if (k.expires_on && String(k.expires_on).slice(0, 10) < new Date().toISOString().slice(0, 10)) return null;
  if (!k.last_used_at || Date.now() - new Date(k.last_used_at).getTime() > 60_000) {
    await ex.updateTable('api_keys').set({ last_used_at: new Date() }).where('id', '=', k.id).execute();
  }
  const branch = k.home_branch_id ?? (await ex.selectFrom('branches').select('id').where('org_id', '=', k.org_id).orderBy('is_primary', 'desc').limit(1).executeTakeFirst())?.id ?? null;
  return {
    userId: k.user_id, orgId: k.org_id, name: `API key: ${k.name}`, email: '', role: k.role as RoleName,
    homeBranchId: branch, activeBranchId: branch, apiKeyId: k.id,
    permissions: k.role !== 'admin' && k.permissions ? (typeof k.permissions === 'string' ? JSON.parse(k.permissions) : k.permissions) as CustomPermissions : null,
  };
}
