// The tamper-proof triggers (npm run db:protect) must survive a backup and
// restore. A one-statement trigger body is stored with its own semicolon, and
// mysqldump then writes it as "…'; */;;", which stops the restore at "*/": so
// every trigger body is a BEGIN…END block.
//
//   npx tsx --test scripts/tests/protect-sql.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const sqlText = readFileSync(path.join(process.cwd(), 'db', 'protect', 'tamper_proof_trail.sql'), 'utf8');

test('every tamper-proof trigger body is a BEGIN…END block, so backups of a protected database restore', () => {
  const triggers = [...sqlText.matchAll(/CREATE TRIGGER\s+(\w+)[\s\S]*?FOR EACH ROW\s*\n(\S+)/g)];
  assert.equal(triggers.length, 6, 'the audit trail, journal entries and journal lines, each refused update and delete');
  for (const [, name, first] of triggers) assert.equal(first, 'BEGIN', `${name} opens a BEGIN…END block`);
});
