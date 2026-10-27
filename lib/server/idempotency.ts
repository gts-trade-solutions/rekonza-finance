import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// A request sent twice, made once.
//
// A request that carries an Idempotency-Key header (an entry made offline and
// sent when the connection came back, say) claims the key before it runs and
// keeps its reply under it after. The same key again gets that reply back
// instead of a second invoice. While the first is still running, the second is
// told to wait. A request that fails gives its key up, so it can be tried again.
// ─────────────────────────────────────────────────────────────────────────────

import { db } from './db';

type Prior = { status: number; body: string } | 'running' | null;

/** Claim the key; what was already done under it, if anything. */
export async function claimKey(orgId: number, userId: number, key: string, path: string): Promise<Prior> {
  try {
    await db.insertInto('idempotency_keys').values({ org_id: orgId, user_id: userId, idem_key: key, path }).execute();
    return null;
  } catch (err) {
    if ((err as { errno?: number }).errno !== 1062) throw err;
  }
  const row = await db.selectFrom('idempotency_keys').select(['status', 'response', 'path'])
    .where('org_id', '=', orgId).where('user_id', '=', userId).where('idem_key', '=', key).executeTakeFirst();
  if (!row) return claimKey(orgId, userId, key, path);
  if (row.status === null) return 'running';
  return { status: row.status, body: row.response ?? '{}' };
}

export async function settleKey(orgId: number, userId: number, key: string, status: number, body: string) {
  await db.updateTable('idempotency_keys').set({ status, response: body })
    .where('org_id', '=', orgId).where('user_id', '=', userId).where('idem_key', '=', key).execute();
}

export async function releaseKey(orgId: number, userId: number, key: string) {
  await db.deleteFrom('idempotency_keys')
    .where('org_id', '=', orgId).where('user_id', '=', userId).where('idem_key', '=', key).where('status', 'is', null).execute();
}
