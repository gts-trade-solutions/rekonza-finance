// Seal the personal and secret values written before FIELD_ENCRYPTION_KEY was
// set. Safe to run again: values already sealed are left alone.
//
//   npm run fields:seal

import { sql } from 'kysely';
import { db } from '../lib/server/db';
import { encryptionConfigured, seal } from '../lib/server/crypto/fields';

const COLUMNS = [
  ['contacts', 'bank_account_no'],
  ['employees', 'bank_account_no'],
  ['employees', 'pan'],
  ['employees', 'aadhaar_no'],
  ['payment_batch_lines', 'account_no'],
  ['users', 'mfa_secret'],
  ['users', 'mfa_pending_secret'],
] as const;

async function main() {
  if (!encryptionConfigured()) {
    console.error('FIELD_ENCRYPTION_KEY is not set. Generate one with:\n  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
    process.exitCode = 1;
    return;
  }
  for (const [table, column] of COLUMNS) {
    const { rows } = await sql<{ id: number; v: string }>`
      SELECT id, ${sql.ref(column)} AS v FROM ${sql.table(table)}
       WHERE ${sql.ref(column)} IS NOT NULL AND ${sql.ref(column)} NOT LIKE 'enc:v1:%'`.execute(db);
    for (const r of rows) {
      await sql`UPDATE ${sql.table(table)} SET ${sql.ref(column)} = ${seal(r.v)} WHERE id = ${r.id}`.execute(db);
    }
    console.log(`${table}.${column}: sealed ${rows.length}`);
  }
}

main().finally(() => db.destroy());
