// Sessions under the book's idle sign-out, and last-seen kept fresh enough to
// measure it. resolveSession reads through the shared pool, not a caller's
// transaction, so these rows are committed and removed at the end.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/sessions.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { db } from '../../lib/server/db';
import { createSession, resolveSession } from '../../lib/server/auth/session';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
let orgId = 0;
let userId = 0;

test.before(async () => {
  orgId = Number((await db.insertInto('organizations').values({ name: 'Sessions Test Co' }).executeTakeFirstOrThrow()).insertId);
  userId = Number((await db.insertInto('users').values({
    org_id: orgId, email: `sessions-${orgId}@test.invalid`, name: 'Idle Tester', role: 'staff',
  }).executeTakeFirstOrThrow()).insertId);
});

const idle = (minutes: number) => db.insertInto('settings').values({
  org_id: orgId, scope: 'policy', setting_key: 'sessionIdleMinutes', value: JSON.stringify(minutes), updated_by_user_id: null,
}).onDuplicateKeyUpdate({ value: JSON.stringify(minutes) }).execute();
const lastSeen = (token: string, minutesAgo: number) => db.updateTable('sessions')
  .set({ last_seen_at: new Date(Date.now() - minutesAgo * 60_000) }).where('token_hash', '=', sha256(token)).execute();
const row = (token: string) => db.selectFrom('sessions').selectAll().where('token_hash', '=', sha256(token)).executeTakeFirstOrThrow();

test('with no idle limit a session lasts its lifetime, and last-seen moves at most once a minute', async () => {
  const { token } = await createSession(userId, orgId);
  await lastSeen(token, 600);
  const u = await resolveSession(token);
  assert.equal(u?.userId, userId);
  assert.equal(u?.sessionId, sha256(token).slice(0, 16));
  const seen = new Date((await row(token)).last_seen_at!).getTime();
  assert.ok(Date.now() - seen < 5_000, 'a stale last-seen is brought up to now');

  await resolveSession(token);
  assert.equal(new Date((await row(token)).last_seen_at!).getTime(), seen, 'not written again within the minute');
});

test('past the idle limit the session ends, says why, and stays ended', async () => {
  await idle(30);
  const fresh = await createSession(userId, orgId);
  await lastSeen(fresh.token, 29);
  assert.ok(await resolveSession(fresh.token), 'inside the limit it carries on');

  const stale = await createSession(userId, orgId);
  await lastSeen(stale.token, 31);
  assert.equal(await resolveSession(stale.token), null);
  const r = await row(stale.token);
  assert.ok(r.revoked_at);
  assert.equal(r.end_reason, 'idle');

  await lastSeen(stale.token, 0);
  assert.equal(await resolveSession(stale.token), null, 'activity after the fact does not bring it back');
});

test.after(async () => {
  await db.deleteFrom('sessions').where('org_id', '=', orgId).execute();
  await db.deleteFrom('settings').where('org_id', '=', orgId).execute();
  await db.deleteFrom('users').where('id', '=', userId).execute();
  await db.deleteFrom('organizations').where('id', '=', orgId).execute();
  await db.destroy();
});
