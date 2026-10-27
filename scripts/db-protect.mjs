// Make the audit trail and the journal unchangeable at the database itself.
//   npm run db:protect
//
// Applies db/protect/tamper_proof_trail.sql: triggers that refuse any UPDATE of
// the audit log or a posted journal entry, and any DELETE outside the demo book.
//
// MySQL with binary logging on (the default) only lets an account create
// triggers when it has SUPER, or when the server allows it for everyone:
//
//   -- once, as root:
//   SET PERSIST log_bin_trust_function_creators = 1;
//
// Or run this script as an administrator by setting DB_PROTECT_USER and
// DB_PROTECT_PASSWORD; the app's own account is used otherwise. On a managed
// database (RDS, Cloud SQL) the setting lives in the parameter group.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import mysql from 'mysql2/promise';
import { config } from 'dotenv';

config({ path: '.env.local', quiet: true });
config({ path: '.env', quiet: true });

const conn = await mysql.createConnection({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_PROTECT_USER || process.env.DB_USER || 'finora_user',
  password: process.env.DB_PROTECT_PASSWORD ?? process.env.DB_PASSWORD ?? '',
  database: process.env.DB_NAME || 'rekonza',
  multipleStatements: true,
});

const file = path.join(process.cwd(), 'db', 'protect', 'tamper_proof_trail.sql');
try {
  await conn.query(readFileSync(file, 'utf8'));
  const [rows] = await conn.query(
    `SELECT TRIGGER_NAME AS name FROM information_schema.TRIGGERS
      WHERE TRIGGER_SCHEMA = DATABASE() AND TRIGGER_NAME LIKE 'trg\\_%\\_no\\_%'`,
  );
  console.log(`\n  Protected: ${rows.length} trigger(s) in place.`);
  for (const r of rows) console.log(`    ${r.name}`);
  console.log();
} catch (err) {
  console.error(`\n  Could not install the triggers: ${err.message}\n`);
  if (/SUPER privilege|log_bin_trust_function_creators/i.test(err.message)) {
    console.error(
      '  The server has binary logging on. As root, run once:\n' +
      '    SET PERSIST log_bin_trust_function_creators = 1;\n' +
      '  then run npm run db:protect again — or set DB_PROTECT_USER and\n' +
      '  DB_PROTECT_PASSWORD to an administrator account.\n',
    );
  }
  process.exitCode = 1;
} finally {
  await conn.end();
}
