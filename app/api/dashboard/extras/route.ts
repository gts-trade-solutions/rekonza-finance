import { z } from 'zod';
import { sql } from 'kysely';
import { db } from '@/lib/server/db';
import { route, body, badRequest } from '@/lib/server/http';
import { hasPermission } from '@/lib/rbac';
import { toPaiseFromSql } from '@/lib/server/money-sql';
import { projectFigures } from '@/lib/server/services/projects';

// The dashboard's two Zoho widgets that are each person's own: the Account
// Watchlist (accounts they chose, with balance and this month's movement) and
// active projects with what is waiting to be billed.

const SCOPE = 'user_watchlist';
const today = () => new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);

async function chosen(orgId: number, userId: number): Promise<number[]> {
  const r = await db.selectFrom('settings').select('value').where('org_id', '=', orgId).where('scope', '=', SCOPE).where('setting_key', '=', String(userId)).executeTakeFirst();
  const v = typeof r?.value === 'string' ? JSON.parse(r.value) : r?.value;
  return Array.isArray(v) ? v.map(Number).filter(Number.isFinite) : [];
}

export const GET = route(
  async ({ orgId, user, role }) => {
    const ids = await chosen(orgId, user.userId);
    const t = today();
    const monthStart = `${t.slice(0, 7)}-01`;
    let watchlist: { id: string; code: string; name: string; type: string; balancePaise: number; monthPaise: number }[] = [];
    if (ids.length) {
      const { rows } = await sql<{ id: number; code: string; name: string; type: string; dr: string | null; cr: string | null; mdr: string | null; mcr: string | null }>`
        SELECT a.id, a.code, a.name, a.type,
               SUM(l.debit) AS dr, SUM(l.credit) AS cr,
               SUM(CASE WHEN l.entry_date >= ${monthStart} THEN l.debit ELSE 0 END) AS mdr,
               SUM(CASE WHEN l.entry_date >= ${monthStart} THEN l.credit ELSE 0 END) AS mcr
          FROM accounts a LEFT JOIN journal_lines l ON l.account_id = a.id AND l.org_id = a.org_id AND l.entry_date <= ${t}
         WHERE a.org_id = ${orgId} AND a.id IN (${sql.join(ids)})
         GROUP BY a.id, a.code, a.name, a.type`.execute(db);
      // Shown in each account's own direction: an expense or asset is positive when debited, the rest when credited.
      const sign = (type: string) => (type === 'asset' || type === 'expense' ? 1 : -1);
      const byId = new Map(rows.map((r) => [r.id, r]));
      watchlist = ids.map((id) => byId.get(id)).filter((r): r is NonNullable<typeof r> => !!r).map((r) => ({
        id: String(r.id), code: r.code, name: r.name, type: r.type,
        balancePaise: sign(r.type) * (toPaiseFromSql(r.dr ?? '0') - toPaiseFromSql(r.cr ?? '0')),
        monthPaise: sign(r.type) * (toPaiseFromSql(r.mdr ?? '0') - toPaiseFromSql(r.mcr ?? '0')),
      }));
    }

    let projects: { id: string; name: string; customer: string; unbilledHours: number; loggedHours: number; profitPaise: number }[] = [];
    if (hasPermission(role, 'projects', 'view')) {
      const active = await db.selectFrom('projects as p').innerJoin('contacts as c', 'c.id', 'p.customer_id').select(['p.id', 'p.name', 'c.display_name'])
        .where('p.org_id', '=', orgId).where('p.status', '=', 'active').orderBy('p.updated_at', 'desc').limit(20).execute();
      const figures = await projectFigures(db, orgId, active.map((p) => p.id));
      projects = active.map((p) => {
        const f = figures.get(p.id);
        return { id: String(p.id), name: p.name, customer: p.display_name, unbilledHours: (f?.unbilledMinutes ?? 0) / 60, loggedHours: (f?.loggedMinutes ?? 0) / 60, profitPaise: f?.profitPaise ?? 0 };
      }).sort((a, b) => b.unbilledHours - a.unbilledHours).slice(0, 5);
    }
    return { watchlist, chosenIds: ids.map(String), projects };
  },
  { permission: { module: 'reports', action: 'view' } },
);

export const PUT = route(
  async ({ orgId, user, req }) => {
    const { accountIds } = await body(req, z.object({ accountIds: z.array(z.union([z.string(), z.number()]).transform(Number)).max(10, 'Watch up to ten accounts.') }));
    const ids = [...new Set(accountIds)];
    if (ids.length) {
      const found = await db.selectFrom('accounts').select('id').where('org_id', '=', orgId).where('id', 'in', ids).execute();
      if (found.length !== ids.length) throw badRequest('One of those accounts is not in this book.');
    }
    const value = JSON.stringify(ids);
    const existing = await db.selectFrom('settings').select('setting_key').where('org_id', '=', orgId).where('scope', '=', SCOPE).where('setting_key', '=', String(user.userId)).executeTakeFirst();
    if (existing) await db.updateTable('settings').set({ value, updated_by_user_id: user.userId }).where('org_id', '=', orgId).where('scope', '=', SCOPE).where('setting_key', '=', String(user.userId)).execute();
    else await db.insertInto('settings').values({ org_id: orgId, scope: SCOPE, setting_key: String(user.userId), value, updated_by_user_id: user.userId }).execute();
    return { chosenIds: ids.map(String) };
  },
  { permission: { module: 'reports', action: 'view' } },
);
