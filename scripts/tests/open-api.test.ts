// API keys and webhooks.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/open-api.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { db } from '../../lib/server/db';
import { logAudit } from '../../lib/server/audit';
import { apiKeyUser, createApiKey, overLimit, revokeApiKey } from '../../lib/server/auth/api-keys';
import { deliverDueWebhooks, eventFor, isPrivateAddress, saveWebhook, sign } from '../../lib/server/integrations/webhooks';

const bearer = (key: string) => new Request('http://x/api/invoices', { headers: { authorization: `Bearer ${key}` } });

test('events come from audit actions on records worth reporting; private addresses are refused', () => {
  assert.equal(eventFor('create', 'invoice'), 'invoice.created');
  assert.equal(eventFor('void', 'payment'), 'payment.voided');
  assert.equal(eventFor('login', 'session'), null);
  assert.equal(eventFor('update', 'user'), null, 'nothing about people or settings');
  for (const ip of ['10.0.0.5', '127.0.0.1', '172.20.1.1', '192.168.1.9', '169.254.169.254', '::1', '::ffff:10.1.2.3', 'fd00::1']) assert.ok(isPrivateAddress(ip), ip);
  for (const ip of ['8.8.8.8', '172.32.0.1', '2606:4700::1111']) assert.ok(!isPrivateAddress(ip), ip);
  const now = 1_000_000;
  for (let i = 0; i < 120; i++) assert.equal(overLimit(-1, now), false);
  assert.equal(overLimit(-1, now), true, 'the 121st in a minute');
  assert.equal(overLimit(-1, now + 60_000), false, 'and a new minute starts afresh');
});

test('a key signs in as its role in its maker\'s name until revoked, expired or the maker is switched off; webhooks queue and deliver', async () => {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'API Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1 }).executeTakeFirstOrThrow()).insertId);
      const admin = Number((await trx.insertInto('users').values({ org_id: orgId, name: 'Owner', email: `o-${orgId}@example.test`, role: 'admin' }).executeTakeFirstOrThrow()).insertId);

      const { id, key } = await createApiKey(trx, orgId, admin, { name: 'Shop site', role: 'sales' });
      assert.match(key, /^rk_live_[A-Za-z0-9_-]{32}$/);
      const stored = await trx.selectFrom('api_keys').select(['key_hash', 'prefix']).where('id', '=', id).executeTakeFirstOrThrow();
      assert.notEqual(stored.key_hash, key, 'only the hash is kept');
      const who = await apiKeyUser(bearer(key), trx);
      assert.deepEqual([who?.orgId, who?.role, who?.userId, who?.homeBranchId, who?.name], [orgId, 'sales', admin, branchId, 'API key: Shop site']);
      assert.equal(await apiKeyUser(bearer(`${key}x`), trx), null);

      await trx.updateTable('users').set({ is_active: 0 }).where('id', '=', admin).execute();
      assert.equal(await apiKeyUser(bearer(key), trx), null, 'the maker switched off');
      await trx.updateTable('users').set({ is_active: 1 }).where('id', '=', admin).execute();
      const old = await createApiKey(trx, orgId, admin, { name: 'Old', role: 'viewer', expiresOn: '2020-01-01' });
      assert.equal(await apiKeyUser(bearer(old.key), trx), null, 'expired');
      await revokeApiKey(trx, orgId, id);
      assert.equal(await apiKeyUser(bearer(key), trx), null, 'revoked');

      await assert.rejects(saveWebhook(trx, orgId, admin, { url: 'http://example.com/x', events: ['*'] }), /https/);
      await assert.rejects(saveWebhook(trx, orgId, admin, { url: 'https://10.0.0.1/x', events: ['*'] }), /public internet/);
      const hook = await saveWebhook(trx, orgId, admin, { url: 'https://hooks.example.com/rekonza', events: ['invoice.created'] });
      assert.match(hook.secret!, /^whsec_/);

      await logAudit({ trx, orgId, action: 'create', targetType: 'invoice', targetId: 42, targetLabel: 'INV/26-27/0042', actorName: 'Owner' });
      await logAudit({ trx, orgId, action: 'void', targetType: 'invoice', targetId: 42 });
      const queued = await trx.selectFrom('webhook_deliveries').select(['id', 'event', 'payload']).where('org_id', '=', orgId).execute();
      assert.deepEqual(queued.map((q) => q.event), ['invoice.created'], 'only what the hook asked for');

      const seen: { body: string; secret: string }[] = [];
      await deliverDueWebhooks(10, async (_url, secret, _id, _event, body) => { seen.push({ body, secret }); return 500; }, trx);
      let d = await trx.selectFrom('webhook_deliveries').select(['status', 'attempts', 'response_code', 'next_attempt_at']).where('id', '=', queued[0].id).executeTakeFirstOrThrow();
      assert.deepEqual([d.status, d.attempts, d.response_code], ['pending', 1, 500]);
      assert.ok(new Date(d.next_attempt_at).getTime() > Date.now() + 50_000, 'tried again in a minute');

      await trx.updateTable('webhook_deliveries').set({ next_attempt_at: new Date(Date.now() - 1000) }).where('id', '=', queued[0].id).execute();
      await deliverDueWebhooks(10, async () => 204, trx);
      d = await trx.selectFrom('webhook_deliveries').select(['status', 'attempts', 'response_code', 'next_attempt_at']).where('id', '=', queued[0].id).executeTakeFirstOrThrow();
      assert.deepEqual([d.status, d.attempts], ['delivered', 2]);

      const body = seen[0].body;
      assert.deepEqual(JSON.parse(body).data, { type: 'invoice', id: '42', label: 'INV/26-27/0042', detail: null, actor: 'Owner' });
      const sig = sign(seen[0].secret, 1700000000, body);
      assert.equal(sig, `t=1700000000,v1=${createHmac('sha256', hook.secret!).update(`1700000000.${body}`).digest('hex')}`);
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
});

test.after(async () => {
  await db.destroy();
});
