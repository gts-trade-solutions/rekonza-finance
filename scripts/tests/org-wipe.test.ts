// Deleting an organisation (`db:seed -- --fresh`): every table of the book is
// cleared, child tables through their parents, the stored bytes go too, and
// another organisation is left alone. Runs on two organisations of its own,
// never the demo book.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/org-wipe.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { db } from '../../lib/server/db';
import { setFileStore, type FileStore } from '../../lib/server/files/store';
import {
  CHILD_TABLES, GLOBAL_TABLES, orgTables, tablesWithoutOrgId, wipeOrganizations,
} from '../../lib/server/seed/wipe';

const bytes = new Map<string, Buffer>();
const memory: FileStore = {
  async put(k, b) { bytes.set(k, b); },
  async get(k) { const b = bytes.get(k); if (!b) throw new Error('missing'); return b; },
  async remove(k) { bytes.delete(k); },
};

/** A small book touching old and new tables, child tables included. */
async function book(tag: string) {
  const orgId = Number((await db.insertInto('organizations').values({ name: `Wipe Test ${tag} (temporary)` })
    .executeTakeFirstOrThrow()).insertId);
  const branchId = Number((await db.insertInto('branches').values({ org_id: orgId, name: 'Head office', state_code: '29' })
    .executeTakeFirstOrThrow()).insertId);
  const userId = Number((await db.insertInto('users').values({
    org_id: orgId, email: `wipe-${tag}-${orgId}@test.invalid`, name: 'Wipe Tester', role: 'staff',
  }).executeTakeFirstOrThrow()).insertId);
  await db.insertInto('user_branches').values({ user_id: userId, branch_id: branchId }).execute();
  await db.insertInto('password_history').values({ user_id: userId, password_hash: 'x' }).execute();
  const contactId = Number((await db.insertInto('contacts').values({ org_id: orgId, display_name: 'Acme', state_code: '29' })
    .executeTakeFirstOrThrow()).insertId);
  await db.insertInto('contact_addresses').values({
    org_id: orgId, contact_id: contactId, label: 'Site', address: '1 Road', state_code: '29',
  }).execute();
  const itemId = Number((await db.insertInto('items').values({ org_id: orgId, name: 'Widget' }).executeTakeFirstOrThrow()).insertId);
  const listId = Number((await db.insertInto('price_lists').values({ org_id: orgId, name: 'Trade' }).executeTakeFirstOrThrow()).insertId);
  await db.insertInto('price_list_items').values({ price_list_id: listId, item_id: itemId, rate: '10.00' as never }).execute();
  await db.insertInto('email_templates').values({ org_id: orgId, kind: 'invoice', subject: 's {link}', body: 'b {link}' }).execute();
  const key = `wipe-test/${orgId}/note.txt`;
  await memory.put(key, Buffer.from('hello'));
  await db.insertInto('files').values({ org_id: orgId, filename: 'note.txt', content_type: 'text/plain', storage_key: key }).execute();
  return { orgId, userId, listId, key };
}

async function rowsLeft(orgId: number) {
  const left: string[] = [];
  for (const t of await orgTables(db)) {
    const { rows } = await sql<{ n: number }>`SELECT COUNT(*) AS n FROM ${sql.table(t)} WHERE org_id = ${orgId}`.execute(db);
    if (Number(rows[0].n)) left.push(t);
  }
  return left;
}

test('every table is either the book\'s, a child of one of its tables, or the platform\'s', async () => {
  const withOrg = new Set(await orgTables(db));
  const children = new Set(CHILD_TABLES.map(([t]) => t));
  const unknown = (await tablesWithoutOrgId(db)).filter((t) => !children.has(t) && !GLOBAL_TABLES.has(t));
  assert.deepEqual(unknown, [], `new tables without org_id: say in lib/server/seed/wipe.ts how they are cleared`);
  for (const [t, column, parent] of CHILD_TABLES) {
    assert.ok(withOrg.has(parent), `${t} hangs off ${parent}, which carries org_id`);
    const { rows } = await sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${t} AND COLUMN_NAME = ${column}`.execute(db);
    assert.equal(Number(rows[0].n), 1, `${t}.${column} exists`);
  }
  assert.ok(withOrg.has('portal_activity') && withOrg.has('time_timers'), 'the newest migrations are seen');
});

test('a wiped organisation leaves nothing behind, and the next one is untouched', async () => {
  setFileStore(memory);
  const gone = await book('gone');
  const kept = await book('kept');

  const cleared = await wipeOrganizations(db, [gone.orgId]);
  assert.ok(cleared > 150, `cleared ${cleared} tables`);

  assert.deepEqual(await rowsLeft(gone.orgId), []);
  assert.equal(await db.selectFrom('organizations').select('id').where('id', '=', gone.orgId).executeTakeFirst(), undefined);
  assert.equal((await db.selectFrom('password_history').select('id').where('user_id', '=', gone.userId).execute()).length, 0);
  assert.equal((await db.selectFrom('user_branches').select('user_id').where('user_id', '=', gone.userId).execute()).length, 0);
  assert.equal((await db.selectFrom('price_list_items').select('id').where('price_list_id', '=', gone.listId).execute()).length, 0);
  assert.equal(bytes.has(gone.key), false, 'the stored bytes are removed');

  const keptLeft = await rowsLeft(kept.orgId);
  for (const t of ['users', 'branches', 'contacts', 'contact_addresses', 'items', 'price_lists', 'email_templates', 'files']) {
    assert.ok(keptLeft.includes(t), `the other organisation keeps its ${t}`);
  }
  assert.equal((await db.selectFrom('password_history').select('id').where('user_id', '=', kept.userId).execute()).length, 1);
  assert.equal((await db.selectFrom('price_list_items').select('id').where('price_list_id', '=', kept.listId).execute()).length, 1);
  assert.ok(bytes.has(kept.key));

  const { rows } = await sql<{ v: number }>`SELECT @@FOREIGN_KEY_CHECKS AS v`.execute(db);
  assert.equal(Number(rows[0].v), 1, 'foreign-key checks are back on');

  await wipeOrganizations(db, [kept.orgId]);
  assert.deepEqual(await rowsLeft(kept.orgId), []);
});

test('nothing is deleted without an organisation to delete', async () => {
  assert.equal(await wipeOrganizations(db, []), 0);
  assert.equal(await wipeOrganizations(db, [0, -1, Number.NaN]), 0);
});

test.after(async () => {
  await db.destroy();
});
