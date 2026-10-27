// Where the database is, for the scripts: the same rule as lib/server/db.ts.
// One DATABASE_URL (mysql://user:password@host:port/name, as a hosting
// provider's integration hands it over) wins over the separate DB_* settings.

export function connectionSettings() {
  const url = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL) : null;
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
