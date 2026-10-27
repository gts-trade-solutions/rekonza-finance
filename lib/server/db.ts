import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// The database connection.
//
// One mysql2 pool, wrapped in Kysely for typed queries. Kysely is a query
// builder, not an ORM: it compiles to the SQL you would have written, and there
// is no session, no lazy loading and no change tracking between the code and
// the ledger. For an accounting system that matters — an ORM deciding when to
// flush is an ORM deciding when a journal entry exists.
//
// The pool is cached on globalThis because Next.js re-evaluates modules on
// every hot reload in development, and a fresh 20-connection pool per reload
// exhausts MySQL's connection limit within a few minutes of editing.
// ─────────────────────────────────────────────────────────────────────────────

import { Kysely, MysqlDialect, sql, type Transaction } from 'kysely';
import mysql from 'mysql2';
import type { DB } from './db-types';

declare global {
  var __rekonzaPool: mysql.Pool | undefined;
  var __rekonzaDb: Kysely<DB> | undefined;
}

/**
 * Where the database is. One DATABASE_URL (mysql://user:password@host:port/name,
 * as a hosting provider's integration hands it over) wins over the separate
 * DB_* settings when it is set.
 */
export function connectionSettings() {
  const url = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL) : null;
  // A hosted database is reached over TLS: DB_SSL=true, or a URL that asks for
  // it; with DB_SSL_CA (the provider's certificate, as PEM text) when it is not
  // one the system trusts.
  const tls = process.env.DB_SSL === 'true' || (!!url && (/ssl/i.test(url.search) || /tidbcloud\.com$/i.test(url.hostname)));
  return {
    host: url ? url.hostname : process.env.DB_HOST || 'localhost',
    port: url ? Number(url.port) || 3306 : Number(process.env.DB_PORT) || 3306,
    user: url ? decodeURIComponent(url.username) : process.env.DB_USER || 'finora_user',
    password: url ? decodeURIComponent(url.password) : process.env.DB_PASSWORD || '',
    database: url ? decodeURIComponent(url.pathname.replace(/^\//, '')) || 'rekonza' : process.env.DB_NAME || 'rekonza',
    ...(tls
      ? { ssl: process.env.DB_SSL_CA ? { ca: process.env.DB_SSL_CA.replace(/\\n/g, '\n'), rejectUnauthorized: true } : { minVersion: 'TLSv1.2', rejectUnauthorized: true } }
      : {}),
  };
}

function createPool(): mysql.Pool {
  const pool = mysql.createPool({
    ...connectionSettings(),
    waitForConnections: true,
    // Serverless runs many copies at once, each with its own pool: keep each small.
    connectionLimit: Number(process.env.DB_CONNECTION_LIMIT) || (process.env.VERCEL ? 5 : 20),
    queueLimit: Number(process.env.DB_QUEUE_LIMIT) || 200,
    maxIdle: 10,
    idleTimeout: 60_000,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10_000,
    connectTimeout: 10_000,
    // Never on for the application pool. Multi-statement queries turn a single
    // injected semicolon into a second statement; only the migration runner
    // enables it, and only against files on disk.
    multipleStatements: false,
    timezone: 'local',
    // DECIMAL always arrives as a string — that is the whole point of storing
    // money as DECIMAL, and money-sql.ts converts it to integer paise without
    // ever going through a float.
    decimalNumbers: false,
    // BIGINT arrives as a number, falling back to a string only when the value
    // would actually lose precision past 2^53. Forcing every BIGINT to a string
    // makes row ids strings too, which silently breaks any Map keyed on an id
    // and contradicts the generated types, where they are numbers.
    supportBigNumbers: true,
    bigNumberStrings: false,
    dateStrings: ['DATE'],
  });

  // READ COMMITTED rather than MySQL's default REPEATABLE READ.
  //
  // REPEATABLE READ holds gap locks on every range a statement scans, so two
  // transactions touching neighbouring rows — not the same row, merely nearby
  // in an index — can deadlock on each other. For short write transactions
  // that take their own explicit row locks, which is what every posting here
  // does, the extra isolation buys nothing and the gap locks cost real
  // availability. It is also what PostgreSQL, Oracle and SQL Server default to.
  pool.on('connection', (conn) => {
    conn.query('SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED');
  });

  return pool;
}

export const pool: mysql.Pool = globalThis.__rekonzaPool ?? createPool();
if (process.env.NODE_ENV !== 'production') globalThis.__rekonzaPool = pool;

export const db: Kysely<DB> =
  globalThis.__rekonzaDb ??
  new Kysely<DB>({
    dialect: new MysqlDialect({ pool }),
    log:
      process.env.DB_LOG === 'query'
        ? (event) => {
            if (event.level === 'query') {
              console.log(`[sql ${event.queryDurationMillis.toFixed(1)}ms]`, event.query.sql);
            }
          }
        : undefined,
  });
if (process.env.NODE_ENV !== 'production') globalThis.__rekonzaDb = db;

export { sql };
export type { DB } from './db-types';
export type Db = Kysely<DB>;

/**
 * A transaction handle. Every function that writes to the ledger takes one of
 * these rather than reaching for the module-level `db`, so a caller can compose
 * several writes into one atomic unit — allocating an invoice number and
 * posting its journal entry have to succeed or fail together.
 *
 * `Transaction<DB>` extends `Kysely<DB>`, so a read helper can be typed against
 * `Executor` and work equally well inside or outside a transaction.
 */
export type Trx = Transaction<DB>;
export type Executor = Kysely<DB> | Trx;

/** MySQL's code for "chosen as the deadlock victim; try restarting transaction". */
const ER_LOCK_DEADLOCK = 1213;

/**
 * Run `fn` inside a transaction, rolling back on any thrown error.
 *
 * `retryDeadlocks` runs it again, up to three times in all, when MySQL picks
 * it as a deadlock victim. InnoDB has already rolled the whole transaction
 * back by then, so starting over is the only remedy. Only for work that
 * touches nothing but the database and is safe to repeat — bringing a wallet
 * up to date, say — never around a call to a payment gateway or a portal.
 */
export async function transaction<T>(
  fn: (trx: Trx) => Promise<T>,
  opts: { retryDeadlocks?: boolean } = {},
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await db.transaction().execute(fn);
    } catch (err) {
      const deadlock = (err as { errno?: number }).errno === ER_LOCK_DEADLOCK;
      if (!opts.retryDeadlocks || !deadlock || attempt >= 3) throw err;
      // A short pause with some jitter, so the two sides do not meet again.
      await new Promise((resolve) => setTimeout(resolve, 25 * attempt + Math.random() * 25));
    }
  }
}

/** Cheap liveness probe for the health endpoint and the smoke tests. */
export async function ping(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const started = Date.now();
  try {
    await sql`SELECT 1`.execute(db);
    return { ok: true, latencyMs: Date.now() - started };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - started, error: (err as Error).message };
  }
}
