// Migration runner.
//   node scripts/migrate.mjs           apply everything outstanding
//   node scripts/migrate.mjs --status  list what is applied and what is not
//   node scripts/migrate.mjs --reset   drop every table and re-apply (dev only)
//
// Migrations are hand-numbered SQL files, applied once, in filename order, and
// never edited afterwards — the checksum is recorded so an edited file is
// caught rather than silently ignored. That is the same workflow the email-app
// uses, and it is deliberate: an ORM's auto-generated migration is exactly the
// thing you do not want standing between you and a ledger.

import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import mysql from 'mysql2/promise';
import { config } from 'dotenv';

config({ path: '.env.local', quiet: true });
config({ path: '.env', quiet: true });

const DIR = path.join(process.cwd(), 'db', 'migrations');

const conn = await mysql.createConnection({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'finora_user',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'rekonza',
  // A hosted database is reached over TLS: DB_SSL=true, with DB_SSL_CA (the
  // provider's certificate, as PEM text) when it is not one the system trusts.
  ...(process.env.DB_SSL === 'true'
    ? { ssl: process.env.DB_SSL_CA ? { ca: process.env.DB_SSL_CA.replace(/\\n/g, '\n'), rejectUnauthorized: true } : { rejectUnauthorized: true } }
    : {}),
  // Migration files hold many statements; the app pool never enables this.
  multipleStatements: true,
});

await conn.query(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    filename    VARCHAR(255) NOT NULL PRIMARY KEY,
    checksum    CHAR(64)     NOT NULL,
    applied_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    duration_ms INT          NOT NULL DEFAULT 0
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`);

const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
const [applied] = await conn.query('SELECT filename, checksum FROM schema_migrations');
const appliedMap = new Map(applied.map((r) => [r.filename, r.checksum]));

const sha = (s) => createHash('sha256').update(s).digest('hex');

if (process.argv.includes('--status')) {
  console.log(`\n  ${files.length} migration file(s) in db/migrations\n`);
  for (const f of files) {
    const sql = readFileSync(path.join(DIR, f), 'utf8');
    const known = appliedMap.get(f);
    const mark = !known ? 'PENDING' : known === sha(sql) ? 'applied' : 'CHANGED!';
    console.log(`  ${mark.padEnd(9)} ${f}`);
  }
  console.log();
  await conn.end();
  process.exit(0);
}

if (process.argv.includes('--reset')) {
  if (process.env.NODE_ENV === 'production') {
    console.error('Refusing to reset in production.');
    process.exit(1);
  }
  console.log('Dropping every table…');
  await conn.query('SET FOREIGN_KEY_CHECKS = 0');
  const [tables] = await conn.query(
    'SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE()',
  );
  for (const { t } of tables) await conn.query(`DROP TABLE IF EXISTS \`${t}\``);
  await conn.query('SET FOREIGN_KEY_CHECKS = 1');
  await conn.query(`
    CREATE TABLE schema_migrations (
      filename    VARCHAR(255) NOT NULL PRIMARY KEY,
      checksum    CHAR(64)     NOT NULL,
      applied_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
      duration_ms INT          NOT NULL DEFAULT 0
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);
  appliedMap.clear();
  console.log(`  dropped ${tables.length} table(s)\n`);
}

let ran = 0;
for (const f of files) {
  const sql = readFileSync(path.join(DIR, f), 'utf8');
  const checksum = sha(sql);
  const known = appliedMap.get(f);

  if (known === checksum) continue;
  if (known && known !== checksum) {
    console.error(
      `\n  ${f} has changed since it was applied.\n` +
      `  Applied migrations are immutable — add a new numbered file instead.\n`,
    );
    await conn.end();
    process.exit(1);
  }

  const started = Date.now();
  try {
    await conn.query(sql);
    const ms = Date.now() - started;
    await conn.query(
      'INSERT INTO schema_migrations (filename, checksum, duration_ms) VALUES (?, ?, ?)',
      [f, checksum, ms],
    );
    console.log(`  applied  ${f}  (${ms}ms)`);
    ran++;
  } catch (err) {
    console.error(`\n  FAILED   ${f}\n  ${err.message}\n`);
    await conn.end();
    process.exit(1);
  }
}

if (ran === 0) console.log('  Everything already applied.');
else console.log(`\n  ${ran} migration(s) applied.`);

const [[{ n }]] = await conn.query(
  'SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE()',
);
console.log(`  ${n} tables in ${process.env.DB_NAME || 'rekonza'}.\n`);

await conn.end();
