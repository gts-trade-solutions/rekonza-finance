import 'server-only';

// In-app notifications, under the bell: a report ready, something waiting for
// approval, something the scheduler could not post. Each is for one person.

import type { Executor } from '../db';
import type { RoleName } from '../../types';
import { hasPermission, type Action, type CustomPermissions } from '../../rbac';

/**
 * The active users of a book whose role, or custom role, lets them do this:
 * only they are told about it. Narrowed to `among` when given.
 */
export async function usersWhoCan(ex: Executor, orgId: number, module: string, action: Action, among?: number[]): Promise<number[]> {
  if (among && !among.length) return [];
  const users = await ex.selectFrom('users as u').leftJoin('custom_roles as r', 'r.id', 'u.custom_role_id')
    .select(['u.id', 'u.role', 'r.permissions']).where('u.org_id', '=', orgId).where('u.is_active', '=', 1)
    .$if(!!among, (qb) => qb.where('u.id', 'in', among!)).execute();
  return users.filter((u) => hasPermission(u.role as RoleName, module, action,
    u.role !== 'admin' && u.permissions ? (typeof u.permissions === 'string' ? JSON.parse(u.permissions) : u.permissions) as CustomPermissions : null))
    .map((u) => u.id);
}

export async function notify(
  ex: Executor, orgId: number, userIds: number[],
  n: { kind: string; title: string; body?: string | null; href?: string | null },
) {
  const ids = [...new Set(userIds)];
  if (!ids.length) return 0;
  await ex.insertInto('notifications').values(ids.map((user_id) => ({
    org_id: orgId, user_id, kind: n.kind, title: n.title.slice(0, 200), body: n.body?.slice(0, 500) ?? null, href: n.href ?? null,
  }))).execute();
  return ids.length;
}

export async function listNotifications(ex: Executor, userId: number, limit = 30) {
  const [rows, unread] = await Promise.all([
    ex.selectFrom('notifications').selectAll().where('user_id', '=', userId).orderBy('id', 'desc').limit(limit).execute(),
    ex.selectFrom('notifications').select((eb) => eb.fn.countAll<string>().as('n')).where('user_id', '=', userId).where('read_at', 'is', null).executeTakeFirstOrThrow(),
  ]);
  return {
    unread: Number(unread.n),
    items: rows.map((r) => ({
      id: String(r.id), kind: r.kind, title: r.title, body: r.body, href: r.href,
      read: !!r.read_at, at: new Date(r.created_at).toISOString(),
    })),
  };
}

export async function markRead(ex: Executor, userId: number, ids: number[] | 'all') {
  let q = ex.updateTable('notifications').set({ read_at: new Date() }).where('user_id', '=', userId).where('read_at', 'is', null);
  if (ids !== 'all') {
    if (!ids.length) return;
    q = q.where('id', 'in', ids);
  }
  await q.execute();
}
