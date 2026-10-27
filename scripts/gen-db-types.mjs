// Regenerate lib/server/db-types.ts from the live schema.
//   node scripts/gen-db-types.mjs
//
// kysely-codegen types every MySQL DATE column as `Date`, but the pool is
// configured with `dateStrings: ['DATE']`, so those columns actually arrive as
// 'yyyy-mm-dd' strings — deliberately, because turning a date-only value into a
// Date object and back is how an Indian invoice dated the 1st becomes the 31st
// of the month before.
//
// Rather than hand-maintaining that list, this reads information_schema for
// every DATE column and feeds kysely-codegen the matching overrides. Add a
// column, rerun, and it is covered.

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import mysql from 'mysql2/promise';
import { config } from 'dotenv';

config({ path: '.env.local', quiet: true });
config({ path: '.env', quiet: true });

const dbName = process.env.DB_NAME || 'rekonza';

const conn = await mysql.createConnection({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'finora_user',
  password: process.env.DB_PASSWORD || '',
  database: dbName,
});

const [rows] = await conn.query(
  `SELECT table_name AS t, column_name AS c, is_nullable AS nullable
     FROM information_schema.columns
    WHERE table_schema = ? AND data_type = 'date'
    ORDER BY table_name, column_name`,
  [dbName],
);
await conn.end();

// ColumnType<select, insert, update> — a string in all three directions.
//
// Nullability has to be carried through. Overriding a NULL-able column with a
// bare `string` makes Kysely treat it as required on insert, so every insert
// that legitimately omits an optional date stops compiling.
const columns = Object.fromEntries(
  rows.map(({ t, c, nullable }) => {
    const type = nullable === 'YES' ? 'string | null' : 'string';
    return [`${t}.${c}`, `ColumnType<${type}, ${type}, ${type}>`];
  }),
);

console.log(`  ${rows.length} DATE column(s) overridden to string`);

const url = `mysql://${process.env.DB_USER}:${encodeURIComponent(process.env.DB_PASSWORD || '')}@${
  process.env.DB_HOST || 'localhost'
}:${process.env.DB_PORT || 3306}/${dbName}`;

// Resolve the CLI's entry point and run it with this Node binary. Shelling out
// to `npx` is not portable here: on Windows execFileSync cannot launch a .cmd
// shim without a shell, and enabling the shell would put a JSON argument
// containing quotes and braces through cmd.exe's parser.
const require_ = createRequire(import.meta.url);
const cliPath = require_.resolve('kysely-codegen/dist/cli/bin.js');

execFileSync(
  process.execPath,
  [
    cliPath,
    '--dialect', 'mysql',
    '--url', url,
    '--out-file', 'lib/server/db-types.ts',
    '--overrides', JSON.stringify({ columns }),
  ],
  { stdio: 'inherit' },
);
