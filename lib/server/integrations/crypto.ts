import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Sealing secrets that are not ours.
//
// What goes through here is a customer's government portal API username and
// password, and the session tokens minted from them. Losing those is not "a
// data breach in our product" — it is somebody else's tax registration in a
// stranger's hands. So they are never stored in a readable form, and never in
// the plain `settings` table alongside preferences.
//
// AES-256-GCM, key held outside the database in INTEGRATION_KEY. GCM rather
// than CBC because it authenticates as well as encrypts: a blob that has been
// tampered with fails to open rather than decrypting to plausible rubbish.
//
// The row's own identity is bound in as additional authenticated data. That
// closes an attack the encryption alone does not: without it, anyone who can
// write to the database could copy connection A's sealed credentials onto
// connection B's row and have the app authenticate as A while believing it is
// acting as B.
// ─────────────────────────────────────────────────────────────────────────────

import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Bumped when the master key changes. Stored on every sealed row so a rotation
 * can re-seal gradually — old rows stay readable while new ones use the new
 * key, instead of every connection breaking the moment the key is replaced.
 */
export const CURRENT_KEY_VERSION = 1;

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12; // 96 bits, the size GCM is specified for
const KEY_BYTES = 32;

export class MissingKeyError extends Error {
  constructor() {
    super(
      'INTEGRATION_KEY is not set, so portal credentials cannot be stored or read. ' +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
    this.name = 'MissingKeyError';
  }
}

export class SealedDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SealedDataError';
  }
}

let cached: { raw: string; key: Buffer } | null = null;

/**
 * The master key, accepted as 64 hex characters or 44 base64 characters.
 *
 * Read on every call rather than at module load: a missing key must fail where
 * a credential is actually touched, not by refusing to start the whole app.
 * Every other screen works fine without one.
 */
function masterKey(): Buffer {
  const raw = process.env.INTEGRATION_KEY?.trim();
  if (!raw) throw new MissingKeyError();
  if (cached && cached.raw === raw) return cached.key;

  const key = /^[0-9a-fA-F]{64}$/.test(raw)
    ? Buffer.from(raw, 'hex')
    : Buffer.from(raw, 'base64');

  if (key.length !== KEY_BYTES) {
    throw new Error(
      `INTEGRATION_KEY must decode to ${KEY_BYTES} bytes; got ${key.length}. ` +
        'Use 64 hex characters or 32 bytes of base64.',
    );
  }

  cached = { raw, key };
  return key;
}

/** Whether credentials can be sealed at all. Lets the UI say so before asking. */
export function encryptionAvailable(): boolean {
  try {
    masterKey();
    return true;
  } catch {
    return false;
  }
}

export interface Sealed {
  keyVersion: number;
  iv: Buffer;
  authTag: Buffer;
  ciphertext: Buffer;
}

/**
 * Seal a secret. `aad` binds the result to where it is being stored — pass
 * something stable and specific, like `credentials:41`.
 */
export function seal(plaintext: string, aad: string): Sealed {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, masterKey(), iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { keyVersion: CURRENT_KEY_VERSION, iv, authTag: cipher.getAuthTag(), ciphertext };
}

/** Open a sealed secret. Throws if the key, the blob or the `aad` disagree. */
export function open(sealed: Sealed, aad: string): string {
  if (sealed.keyVersion !== CURRENT_KEY_VERSION) {
    throw new SealedDataError(
      `This credential was sealed with key version ${sealed.keyVersion} and the current key is ` +
        `version ${CURRENT_KEY_VERSION}. Re-enter the portal credentials to re-seal them.`,
    );
  }
  try {
    const decipher = createDecipheriv(ALGO, masterKey(), sealed.iv);
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(sealed.authTag);
    return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]).toString('utf8');
  } catch (err) {
    if (err instanceof MissingKeyError) throw err;
    // GCM authentication failure. Never say which of the three possible causes
    // it was — that distinction is only useful to somebody probing.
    throw new SealedDataError(
      'These stored credentials could not be read. Either INTEGRATION_KEY has changed or the row was ' +
        'altered. Re-enter the portal credentials for this registration.',
    );
  }
}

/** Seal an object as JSON. The common case — credentials are never one string. */
export function sealJson(value: unknown, aad: string): Sealed {
  return seal(JSON.stringify(value), aad);
}

export function openJson<T>(sealed: Sealed, aad: string): T {
  return JSON.parse(open(sealed, aad)) as T;
}

/**
 * SHA-256 of exactly what went over the wire.
 *
 * The call log keeps this instead of a second copy of the payload. It settles
 * "what did you send" in a dispute without doubling how many places a
 * customer's commercial data is stored.
 */
export function digest(payload: string): string {
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

/** Constant-time compare, for anywhere a digest is checked against an expected one. */
export function digestMatches(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
