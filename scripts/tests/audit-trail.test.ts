// The edit log: a master edit records each field it changed, from what, to what.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/audit-trail.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../../lib/server/db';
import { changesBetween, describeChanges, snapshot } from '../../lib/server/audit';

test('a snapshot and a patch give exactly the fields that moved', async () => {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Edit Log Co' }).executeTakeFirstOrThrow()).insertId);
      const id = Number((await trx.insertInto('contacts').values({
        org_id: orgId, kind: 'customer', display_name: 'Sharma Traders', state_code: '33',
        gst_treatment: 'registered', gstin: '33AAAAA0000A1Z5', credit_limit: '50000.0000',
      } as never).executeTakeFirstOrThrow()).insertId);

      const patch = {
        display_name: 'Sharma Traders', // unchanged
        gstin: '33AAAAA0000A1Z6',
        credit_limit: '75000', // the same column, written without the decimals
        notes: null,
      };
      const before = await snapshot(trx, 'contacts', orgId, id, Object.keys(patch));
      const changes = changesBetween(before, patch);
      assert.deepEqual(Object.keys(changes).sort(), ['credit_limit', 'gstin']);
      assert.equal(changes.gstin.from, '33AAAAA0000A1Z5');
      assert.equal(changes.gstin.to, '33AAAAA0000A1Z6');
      assert.equal(describeChanges(changes), 'gstin and credit_limit');

      // Another organisation's row is invisible to the snapshot.
      assert.deepEqual(await snapshot(trx, 'contacts', orgId + 1_000_000, id, ['gstin']), {});
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
});

test('saving a form unchanged is not an edit', () => {
  assert.deepEqual(changesBetween({ credit_limit: '100.0000', is_msme: 1 }, { credit_limit: '100', is_msme: 1 }), {});
  assert.equal(describeChanges({}), 'no change');
});

test.after(async () => {
  await db.destroy();
});
