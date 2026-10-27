// Backups of the books: taken, checked, and restored.
//
//   npm run db:backup                         take one now (database and attachments)
//   npm run db:backup -- verify <file>        prove a backup is whole and readable
//   npm run db:backup -- restore <file> --into <database> [--files-into <dir>]
//   npm run db:backup -- drill                restore the newest backup into a
//                                             scratch database and prove it matches
//
// Rule 3(5) of the Companies (Accounts) Rules requires a backup of books kept
// electronically to be taken daily and kept on servers physically in India,
// and section 128(5) keeps books for eight years. This script takes the
// backup; scheduling it daily and choosing where BACKUP_DIR lives (an Indian
// region, a second machine) is the operator's part — see docs/backups.md.
//
// A backup is a mysqldump, gzipped, then encrypted with AES-256-GCM under
// BACKUP_KEY, so a copied file is useless without the key. The key is not in
// the file and must be kept somewhere other than next to the backups. The
// attachments — bill scans, contracts — are not in the database, so they go
// into a second file beside it, encrypted the same way.
//
// File layout: "RKBK1" | 12-byte IV | ciphertext | 16-byte auth tag. A manifest
// beside it records when it was taken, its size and its SHA-256. Every run is
// also written to the backup_runs table, which is what Settings → Backups reads.

import { spawn } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import {
  createReadStream, createWriteStream, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, unlinkSync,
  openSync, readSync, closeSync, existsSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip, createGunzip } from 'node:zlib';
import { Readable, Writable } from 'node:stream';
import mysql from 'mysql2/promise';
import { config } from 'dotenv';

config({ path: '.env.local', quiet: true });
config({ path: '.env', quiet: true });

const MAGIC = Buffer.from('RKBK1');
const DB = {
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
};
const DIR = path.resolve(process.env.BACKUP_DIR || 'backups');
const FILES_DIR = path.resolve(process.env.FILE_STORAGE_DIR || path.join('storage', 'files'));
const DRILL_DB = process.env.BACKUP_DRILL_DB || `${DB.database}_restore_check`;

function key() {
  const raw = process.env.BACKUP_KEY;
  const buf = raw ? Buffer.from(raw, 'base64') : null;
  if (!buf || buf.length !== 32) {
    console.error(
      '\n  BACKUP_KEY must be 32 random bytes, base64-encoded. Make one with:\n' +
      "    node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"\n" +
      '  and keep it somewhere other than the backups themselves.\n',
    );
    process.exit(1);
  }
  return buf;
}

/** Credentials go in a private temp file, not on the command line where `ps` shows them. */
function credentialsFile() {
  const file = path.join(tmpdir(), `rk-my-${process.pid}-${Date.now()}.cnf`);
  writeFileSync(file, `[client]\nuser=${DB.user}\npassword=${DB.password}\nhost=${DB.host}\nport=${DB.port}\n`, { mode: 0o600 });
  return file;
}

const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

const sha256Of = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/**
 * Write a run to backup_runs. A failure to record never fails the backup
 * itself — a missing table on an old database is reported and ignored.
 */
async function record(kind, startedAt, fields) {
  try {
    const conn = await mysql.createConnection(DB);
    await conn.query(
      `INSERT INTO backup_runs (kind, started_at, finished_at, ok, file, bytes, sha256, files_count, detail, host)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [kind, startedAt, new Date(), fields.ok ? 1 : 0, fields.file ?? null, fields.bytes ?? null,
        fields.sha256 ?? null, fields.filesCount ?? null, fields.detail?.slice(0, 1000) ?? null, hostname().slice(0, 120)],
    );
    await conn.end();
  } catch (err) {
    console.warn(`  (could not record the run in backup_runs: ${err.message})`);
  }
}

/** Encrypt a stream into `out` in the RKBK1 layout. */
async function writeEncrypted(source, out) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const file = createWriteStream(out);
  file.write(MAGIC);
  file.write(iv);
  try {
    await pipeline(source, createGzip({ level: 9 }), cipher, file, { end: false });
    await new Promise((resolve, reject) => file.end(cipher.getAuthTag(), (e) => (e ? reject(e) : resolve())));
  } catch (err) {
    file.destroy();
    try { unlinkSync(out); } catch { /* nothing written */ }
    throw err;
  }
}

// ── Attachments ──────────────────────────────────────────────────────────────
//
// Each file is a 4-byte big-endian header length, a JSON header {p, n} with
// its path under the store and its size, then its bytes. Simple enough to read
// back without a library, and it streams.

function* walk(dir, base = dir) {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full, base);
    else if (e.isFile() && !e.name.endsWith('.part')) yield path.relative(base, full).split(path.sep).join('/');
  }
}

async function* archive(dir, counter) {
  for (const rel of walk(dir)) {
    const bytes = readFileSync(path.join(dir, rel));
    const head = Buffer.from(JSON.stringify({ p: rel, n: bytes.length }));
    const len = Buffer.alloc(4);
    len.writeUInt32BE(head.length);
    counter.count += 1;
    counter.bytes += bytes.length;
    yield Buffer.concat([len, head]);
    yield bytes;
  }
}

/** Read an attachments archive back, calling `onFile(path, bytes)` for each entry. */
function unarchiver(onFile) {
  let buf = Buffer.alloc(0);
  let want = null; // { p, n } once a header is read
  return new Writable({
    write(chunk, _enc, done) {
      buf = Buffer.concat([buf, chunk]);
      try {
        for (;;) {
          if (!want) {
            if (buf.length < 4) break;
            const hl = buf.readUInt32BE(0);
            if (buf.length < 4 + hl) break;
            want = JSON.parse(buf.subarray(4, 4 + hl).toString('utf8'));
            buf = buf.subarray(4 + hl);
          }
          if (buf.length < want.n) break;
          onFile(want.p, buf.subarray(0, want.n));
          buf = buf.subarray(want.n);
          want = null;
        }
        done();
      } catch (err) {
        done(err);
      }
    },
    final(done) {
      done(buf.length || want ? new Error('The attachments archive is cut short.') : null);
    },
  });
}

// ── Backup ───────────────────────────────────────────────────────────────────

async function backup() {
  const startedAt = new Date();
  key();
  mkdirSync(DIR, { recursive: true });
  const at = stamp();
  const name = `${DB.database}-${at}.sql.gz.enc`;
  const out = path.join(DIR, name);
  const cnf = credentialsFile();

  try {
    const dump = spawn(process.env.MYSQLDUMP_PATH || 'mysqldump', [
      `--defaults-extra-file=${cnf}`,
      // A consistent snapshot without locking the books while it runs.
      '--single-transaction', '--quick',
      '--routines', '--triggers', '--hex-blob',
      '--no-tablespaces', '--set-gtid-purged=OFF',
      DB.database,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    dump.stderr.on('data', (c) => { stderr += c; });
    const exited = new Promise((resolve) => dump.on('close', resolve));
    await writeEncrypted(dump.stdout, out);
    const code = await exited;
    if (code !== 0) {
      try { unlinkSync(out); } catch { /* already gone */ }
      throw new Error(`mysqldump exited with ${code}: ${stderr.trim()}`);
    }

    // The attachments, beside it.
    const counter = { count: 0, bytes: 0 };
    const filesName = `${DB.database}-files-${at}.bin.gz.enc`;
    const filesOut = path.join(DIR, filesName);
    await writeEncrypted(Readable.from(archive(FILES_DIR, counter)), filesOut);

    const manifest = {
      file: name, database: DB.database, takenAt: new Date().toISOString(),
      bytes: statSync(out).size, sha256: sha256Of(out), format: 'mysqldump | gzip | aes-256-gcm (RKBK1)',
      files: {
        file: filesName, count: counter.count, bytes: statSync(filesOut).size, sha256: sha256Of(filesOut),
        source: FILES_DIR, format: 'u32be header length | {p,n} json | bytes, gzip, aes-256-gcm (RKBK1)',
      },
    };
    writeFileSync(`${out}.json`, JSON.stringify(manifest, null, 2));
    console.log(
      `\n  Backed up ${DB.database} to ${out}\n  ${manifest.bytes} bytes, sha256 ${manifest.sha256}` +
      `\n  ${counter.count} attachment(s) to ${filesOut}\n`,
    );
    await record('backup', startedAt, {
      ok: true, file: name, bytes: manifest.bytes, sha256: manifest.sha256, filesCount: counter.count,
      detail: `Written to ${DIR}`,
    });
    return out;
  } catch (err) {
    await record('backup', startedAt, { ok: false, file: name, detail: err.message });
    throw err;
  } finally {
    unlinkSync(cnf);
  }
}

/** Decrypt and decompress a backup into a stream. */
function readBackup(file) {
  const k = key();
  const size = statSync(file).size;
  const head = Buffer.alloc(MAGIC.length + 12);
  const tag = Buffer.alloc(16);
  const fd = openSync(file, 'r');
  readSync(fd, head, 0, head.length, 0);
  readSync(fd, tag, 0, 16, size - 16);
  closeSync(fd);
  if (!head.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error(`${file} is not a backup made by this script.`);
  const decipher = createDecipheriv('aes-256-gcm', k, head.subarray(MAGIC.length));
  decipher.setAuthTag(tag);
  const body = createReadStream(file, { start: head.length, end: size - 17 });
  return { body, decipher };
}

/**
 * GCM only proves the file is untouched once the last byte is read, and a
 * wrong key first shows up as gzip refusing garbage. Either way the honest
 * message is the same.
 */
function explain(err) {
  if (/unable to authenticate|incorrect header check|invalid stored block|unexpected end of file/i.test(err.message)) {
    return new Error('The backup could not be decrypted: BACKUP_KEY is not the key it was taken with, or the file is damaged.');
  }
  return err;
}

function manifestOf(file) {
  try {
    return JSON.parse(readFileSync(`${file}.json`, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    return null;
  }
}

async function verify(file, { quiet = false } = {}) {
  const startedAt = new Date();
  try {
    const r = await verifyContents(file, quiet);
    if (!quiet) await record('verify', startedAt, { ok: true, file: path.basename(file), filesCount: r.files, detail: r.detail });
    return r;
  } catch (err) {
    const e = explain(err);
    if (!quiet) await record('verify', startedAt, { ok: false, file: file ? path.basename(file) : null, detail: e.message });
    throw e;
  }
}

async function verifyContents(file, quiet) {
  if (!file) throw new Error('Name the backup file to verify.');
  const m = manifestOf(file);
  if (m) {
    if (sha256Of(file) !== m.sha256) throw new Error(`Checksum mismatch: the file has changed since it was taken (${file}.json).`);
  } else if (!quiet) {
    console.log('  (no manifest beside it; checking the contents only)');
  }

  const { body, decipher } = readBackup(file);
  const tables = new Set();
  let tail = '';
  let bytes = 0;
  await pipeline(body, decipher, createGunzip(), new Writable({
    write(chunk, _enc, done) {
      bytes += chunk.length;
      const text = tail + chunk.toString('utf8');
      for (const mm of text.matchAll(/CREATE TABLE `([^`]+)`/g)) tables.add(mm[1]);
      tail = text.slice(-200);
      done();
    },
  }));
  if (!/-- Dump completed/.test(tail)) throw new Error('The dump is cut short: it does not end with "Dump completed".');

  const conn = await mysql.createConnection(DB);
  const [rows] = await conn.query('SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE()');
  await conn.end();
  const missing = rows.map((r) => r.t).filter((t) => !tables.has(t));

  // The attachments, when this backup carries them.
  let files = null;
  if (m?.files) {
    const filesPath = path.join(path.dirname(file), m.files.file);
    if (!existsSync(filesPath)) throw new Error(`The attachments file ${m.files.file} is missing from beside the backup.`);
    if (sha256Of(filesPath) !== m.files.sha256) throw new Error(`Checksum mismatch on ${m.files.file}.`);
    files = 0;
    const r = readBackup(filesPath);
    await pipeline(r.body, r.decipher, createGunzip(), unarchiver(() => { files += 1; }));
    if (files !== m.files.count) throw new Error(`${m.files.file} holds ${files} attachment(s); its manifest says ${m.files.count}.`);
  }

  const detail = `${bytes} bytes of SQL, ${tables.size} tables, complete` + (files !== null ? `; ${files} attachment(s)` : '');
  if (!quiet) {
    console.log(`\n  ${file}\n  decrypts and decompresses cleanly: ${detail}.`);
    if (missing.length) console.log(`  Not in the backup but in the live database now: ${missing.join(', ')}`);
    console.log();
  }
  return { tables: tables.size, files, detail };
}

async function restore(file, into, filesInto) {
  if (!file || !into) throw new Error('Usage: restore <file> --into <database> [--files-into <dir>]');
  if (into === DB.database) {
    throw new Error(`Refusing to restore over the live database ${into}. Restore into another one and switch over deliberately.`);
  }
  // Prove the whole file first. Decryption hands out text before it can say
  // whether the file was tampered with, and a damaged backup must not get as
  // far as a database.
  await verify(file, { quiet: true });
  const { body, decipher } = readBackup(file);
  const cnf = credentialsFile();
  const client = spawn(process.env.MYSQL_PATH || 'mysql', [`--defaults-extra-file=${cnf}`, into], {
    stdio: ['pipe', 'inherit', 'pipe'],
  });
  let stderr = '';
  client.stderr.on('data', (c) => { stderr += c; });
  const exited = new Promise((resolve) => client.on('close', resolve));
  try {
    await pipeline(body, decipher, createGunzip(), client.stdin);
    const code = await exited;
    if (code !== 0) throw new Error(`mysql exited with ${code}: ${stderr.trim()}`);
  } finally {
    unlinkSync(cnf);
  }

  const m = manifestOf(file);
  if (filesInto && m?.files) {
    if (path.resolve(filesInto) === FILES_DIR) throw new Error('Refusing to restore attachments over the live store.');
    const r = readBackup(path.join(path.dirname(file), m.files.file));
    let n = 0;
    await pipeline(r.body, r.decipher, createGunzip(), unarchiver((rel, bytes) => {
      const target = path.resolve(filesInto, rel);
      if (!target.startsWith(path.resolve(filesInto) + path.sep)) throw new Error(`Bad path in archive: ${rel}`);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, bytes);
      n += 1;
    }));
    console.log(`  ${n} attachment(s) restored into ${filesInto}.`);
  }
  console.log(`\n  Restored ${file} into ${into}.\n`);
}

/**
 * The monthly proof that a backup can be restored.
 *
 * The newest backup goes into a scratch database, and its journal is compared
 * with the live one. Posted entries are never edited or deleted, so every
 * journal line in the copy must still be in the live books, unchanged: same
 * count, same debits, same credits, up to the last line the copy holds. Any
 * difference means either the backup or the live journal is wrong.
 */
async function drill() {
  const startedAt = new Date();
  try {
    if (DRILL_DB === DB.database) throw new Error('BACKUP_DRILL_DB must name a scratch database, not the live one.');
    const newest = readdirSync(DIR).filter((f) => /\.sql\.gz\.enc$/.test(f))
      .map((f) => ({ f, t: manifestOf(path.join(DIR, f))?.takenAt ?? '' }))
      .sort((a, b) => b.t.localeCompare(a.t) || b.f.localeCompare(a.f))[0];
    if (!newest) throw new Error(`No backups in ${DIR} to restore.`);
    const file = path.join(DIR, newest.f);

    // Start from nothing, so the drill proves the backup on its own.
    const admin = await mysql.createConnection({ ...DB, database: undefined, multipleStatements: true });
    try {
      await admin.query(`DROP DATABASE IF EXISTS \`${DRILL_DB}\`; CREATE DATABASE \`${DRILL_DB}\``);
    } catch (err) {
      throw new Error(
        `Could not recreate ${DRILL_DB}: ${err.message}. As root, once: CREATE DATABASE ${DRILL_DB}; ` +
          `GRANT ALL PRIVILEGES ON ${DRILL_DB}.* TO '${DB.user}'@'%';`,
      );
    } finally {
      await admin.end();
    }

    const t0 = Date.now();
    await restore(file, DRILL_DB);
    const seconds = Math.round((Date.now() - t0) / 1000);

    const q = `SELECT COUNT(*) AS n, COALESCE(SUM(debit),0) AS dr, COALESCE(SUM(credit),0) AS cr, COALESCE(MAX(id),0) AS top FROM journal_lines`;
    const copy = await mysql.createConnection({ ...DB, database: DRILL_DB });
    const [[c]] = await copy.query(q);
    await copy.end();
    const live = await mysql.createConnection(DB);
    const [[l]] = await live.query(`${q.replace('COALESCE(MAX(id),0) AS top', '0 AS top')} WHERE id <= ?`, [c.top]);
    await live.end();

    const same = Number(c.n) === Number(l.n) && String(c.dr) === String(l.dr) && String(c.cr) === String(l.cr);
    const detail = `${newest.f} restored into ${DRILL_DB} in ${seconds}s; ${c.n} journal line(s) ` +
      (same ? 'match the live books.' : `do not match the live books (live has ${l.n}, Dr ${l.dr} / Cr ${l.cr}; the copy ${c.n}, Dr ${c.dr} / Cr ${c.cr}).`);
    console.log(`\n  ${detail}\n`);
    await record('drill', startedAt, { ok: same, file: newest.f, detail });
    if (!same) process.exitCode = 1;
  } catch (err) {
    await record('drill', startedAt, { ok: false, detail: explain(err).message });
    throw err;
  }
}

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name) => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : undefined);
try {
  if (!cmd || cmd === 'backup') await backup();
  else if (cmd === 'verify') await verify(rest[0]);
  else if (cmd === 'restore') await restore(rest[0], flag('--into'), flag('--files-into'));
  else if (cmd === 'drill') await drill();
  else throw new Error(`Unknown command ${cmd}. Use backup, verify, restore or drill.`);
} catch (err) {
  console.error(`\n  ${explain(err).message}\n`);
  process.exitCode = 1;
}
