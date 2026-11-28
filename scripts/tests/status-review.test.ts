// Home → Auditor Review (services/status-review.ts): every one of its queries
// runs against real tables, so a renamed column fails here rather than on the
// dashboard. A brand-new company (the auditors' case) reads every item as
// "Ready to test"; the seeded demo book has records for each.

import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { db, transaction } from '../../lib/server/db';
import { statusReview } from '../../lib/server/services/status-review';

test.after(() => db.destroy());

test('a brand-new company: fourteen items, each with where to go and how to test it', async () => {
  await transaction(async (trx) => {
    const r = await sql<{ id: number }>`INSERT INTO organizations (name, state_code, fiscal_year_start_month) VALUES ('Review Test Co', '33', 4)`.execute(trx)
      .catch(async () => sql`INSERT INTO organizations (name) VALUES ('Review Test Co')`.execute(trx));
    const orgId = Number(r.insertId);
    const items = await statusReview(trx, orgId);
    assert.equal(items.length, 14);
    assert.deepEqual(items.map((i) => i.n), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    for (const i of items) {
      assert.ok(i.where.length > 0 && i.where.every((w) => w.href.startsWith('/')), `${i.n} says where it is`);
      assert.ok(i.test.length >= 3, `${i.n} has its test`);
      assert.ok(i.evidence.length > 0, `${i.n} says what the books show`);
    }
    assert.ok(items.filter((i) => i.status === 'ready').length >= 12, 'an empty company is ready to test, not in use');
    throw new Error('rollback'); // nothing of this company is kept
  }).catch((e) => { if (String(e?.message) !== 'rollback') throw e; });
});

test('the demo book: the review reads its records', async () => {
  const demo = await db.selectFrom('organizations').select('id').where('is_demo', '=', 1).orderBy('id').executeTakeFirst();
  if (!demo) return; // no demo book in this database
  const items = await statusReview(db, Number(demo.id));
  assert.equal(items.length, 14);
  assert.ok(items.filter((i) => i.status === 'in_use').length >= 10, items.filter((i) => i.status !== 'in_use').map((i) => i.issue).join(', '));
});
