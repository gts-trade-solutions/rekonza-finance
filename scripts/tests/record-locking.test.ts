// Two people editing one record: the second save is refused, naming who changed it.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/record-locking.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { db } from '../../lib/server/db';
import { logAudit } from '../../lib/server/audit';
import { assertFresh } from '../../lib/server/concurrency';

test('an edit from the version read passes; one from before somebody else\'s save is refused', async () => {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Lock Co' }).executeTakeFirstOrThrow()).insertId);
      const id = Number((await trx.insertInto('contacts').values({ org_id: orgId, kind: 'customer', display_name: 'Apex Motors', state_code: '33', gst_treatment: 'unregistered' } as never).executeTakeFirstOrThrow()).insertId);
      const read = (await trx.selectFrom('contacts').select('updated_at').where('id', '=', id).executeTakeFirstOrThrow()).updated_at;
      const opened = new Date(read).toISOString();

      await assertFresh(trx, 'contacts', orgId, id, opened, 'Apex Motors');
      await assertFresh(trx, 'contacts', orgId, id, undefined, 'Apex Motors');

      // Priya saves first.
      await sql`UPDATE contacts SET phone = '9000000000', updated_at = DATE_ADD(updated_at, INTERVAL 5 SECOND) WHERE id = ${id}`.execute(trx);
      await logAudit({ trx, orgId, actorName: 'Priya Raman', action: 'update', targetType: 'contact', targetId: id, detail: 'Phone changed' });
      await assert.rejects(assertFresh(trx, 'contacts', orgId, id, opened, 'Apex Motors'), (e: Error & { status?: number; code?: string }) => {
        assert.match(e.message, /^Apex Motors was changed by Priya Raman at .+, after you opened it\. Reload/);
        assert.equal(e.status, 409);
        assert.equal(e.code, 'stale');
        return true;
      });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
});

test.after(async () => {
  await db.destroy();
});
