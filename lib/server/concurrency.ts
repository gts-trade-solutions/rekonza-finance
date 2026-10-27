import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Two people editing the same record.
//
// An edit says which version of the record it started from — its updated_at as
// it was read — and is refused if the record has changed since, with who
// changed it, rather than quietly writing over their change. Optimistic: no
// one is locked out while a form is merely open, and nothing has to be
// unlocked when someone closes a tab.
//
// An edit that does not say (an older client, an import) is let through as
// before.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor } from './db';
import { ApiError } from './http';

const TARGET: Record<'contacts' | 'items' | 'accounts', string> = { contacts: 'contact', items: 'item', accounts: 'account' };

export async function assertFresh(
  ex: Executor, table: keyof typeof TARGET, orgId: number, id: number, expected: string | null | undefined, label: string,
) {
  if (!expected) return;
  const { rows } = await sql<{ updated_at: Date }>`SELECT updated_at FROM ${sql.table(table)} WHERE id = ${id} AND org_id = ${orgId}`.execute(ex);
  if (!rows[0]) return;
  // TIMESTAMP keeps whole seconds.
  if (Math.floor(new Date(rows[0].updated_at).getTime() / 1000) === Math.floor(Date.parse(expected) / 1000)) return;
  const last = await ex.selectFrom('audit_log').select(['actor_name', 'created_at'])
    .where('org_id', '=', orgId).where('target_type', '=', TARGET[table]).where('target_id', '=', String(id))
    .orderBy('id', 'desc').limit(1).executeTakeFirst();
  const when = new Date(rows[0].updated_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
  throw new ApiError(
    409,
    `${label} was changed${last?.actor_name ? ` by ${last.actor_name}` : ''} at ${when}, after you opened it. ` +
      'Reload to see that change, then make yours again.',
    'stale',
  );
}
