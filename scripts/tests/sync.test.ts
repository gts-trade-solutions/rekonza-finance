// Entries sent again after an offline spell: made once, whatever the network did.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/sync.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../../lib/server/db';
import { claimKey, releaseKey, settleKey } from '../../lib/server/idempotency';

// Keys are kept by company and user; a company number no book has keeps this test to itself.
const ORG = 900_000_000 + Math.floor(Math.random() * 1_000_000);

test('a key claimed once: the first run is told to go ahead, a repeat gets its reply, a failure frees it', async () => {
  try {
    assert.equal(await claimKey(ORG, 1, 'k-1', '/api/expenses'), null, 'first time: go ahead');
    assert.equal(await claimKey(ORG, 1, 'k-1', '/api/expenses'), 'running', 'still being saved');
    await settleKey(ORG, 1, 'k-1', 200, '{"id":"42"}');
    assert.deepEqual(await claimKey(ORG, 1, 'k-1', '/api/expenses'), { status: 200, body: '{"id":"42"}' }, 'sent again: the same reply, nothing made');
    assert.equal(await claimKey(ORG, 2, 'k-1', '/api/expenses'), null, 'another user\'s key is their own');

    assert.equal(await claimKey(ORG, 1, 'k-2', '/api/invoices'), null);
    await releaseKey(ORG, 1, 'k-2');
    assert.equal(await claimKey(ORG, 1, 'k-2', '/api/invoices'), null, 'a failed run gives its key up, to be tried again');
    await releaseKey(ORG, 1, 'k-1');
    assert.notEqual(await claimKey(ORG, 1, 'k-1', '/api/expenses'), null, 'a finished one is never given up');
  } finally {
    await db.deleteFrom('idempotency_keys').where('org_id', '=', ORG).execute();
  }
});

test.after(async () => {
  await db.destroy();
});
