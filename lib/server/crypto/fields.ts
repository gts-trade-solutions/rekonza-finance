import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Field encryption: personal and secret values sealed at rest.
//
// AES-256-GCM with the key in FIELD_ENCRYPTION_KEY (32 bytes, as 64 hex
// characters or base64). A sealed value is stored as "enc:v1:" and the IV, tag
// and ciphertext in base64, so it is recognisable on sight, and a value that
// was written before the key was set — plain text — still reads as it is.
// Sealing is therefore safe to switch on for a book that already has data;
// `npm run fields:seal` seals what was written before.
//
// Without a key, seal() leaves values as they are: the app still runs, and
// Settings says plainly that encryption at rest is off.
// ─────────────────────────────────────────────────────────────────────────────

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const PREFIX = 'enc:v1:';

function key(): Buffer | null {
  const raw = process.env.FIELD_ENCRYPTION_KEY?.trim();
  if (!raw) return null;
  const buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (buf.length !== 32) throw new Error('FIELD_ENCRYPTION_KEY must be 32 bytes: 64 hex characters or base64.');
  return buf;
}

export const encryptionConfigured = () => key() !== null;
export const isSealed = (v: string | null | undefined) => !!v && v.startsWith(PREFIX);

/** Seal a value for storage. Null stays null; without a key the value is stored as given. */
export function seal(plain: string | null | undefined): string | null {
  if (plain === null || plain === undefined || plain === '') return plain ?? null;
  if (isSealed(plain)) return plain;
  const k = key();
  if (!k) return plain;
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', k, iv);
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return PREFIX + Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
}

/** Read a stored value: sealed ones are opened, plain ones returned as they are. */
export function unseal(stored: string | null | undefined): string | null {
  if (stored === null || stored === undefined) return null;
  if (!isSealed(stored)) return stored;
  const k = key();
  if (!k) throw new Error('A sealed value was read but FIELD_ENCRYPTION_KEY is not set on this server.');
  const raw = Buffer.from(stored.slice(PREFIX.length), 'base64');
  const d = createDecipheriv('aes-256-gcm', k, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}

/** The last few characters, for showing a sealed account number without opening all of it. */
export const masked = (plain: string | null | undefined, keep = 4) =>
  plain ? `${'•'.repeat(Math.max(0, Math.min(8, plain.length - keep)))}${plain.slice(-keep)}` : null;
