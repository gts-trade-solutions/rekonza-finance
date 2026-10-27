import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// The encryption NIC's e-invoice API insists on.
//
// Two layers, and neither is a choice this app would make on its own:
//
//   1. Logging in. The credentials, as JSON, are base64-encoded and then
//      RSA-encrypted with NIC's public key. Inside them travels an "AppKey" —
//      32 random bytes of our choosing.
//   2. Everything after. NIC replies with a session key (the SEK), itself
//      AES-encrypted under that AppKey. Every document from then on is
//      AES-256 encrypted under the SEK, and every reply comes back the same way.
//
// The AES mode is ECB. ECB is weak — identical blocks encrypt identically — and
// no new design should use it. It is here because NIC specifies it
// (AES/ECB/PKCS7Padding), the traffic also runs inside TLS, and the portal will
// not decrypt anything else. It is confined to this file so that nothing else
// in the app ever reaches for it.
// ─────────────────────────────────────────────────────────────────────────────

import {
  X509Certificate, constants, createCipheriv, createDecipheriv, createPublicKey,
  publicEncrypt, randomBytes, type KeyObject,
} from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

/** 32 random bytes. Base64 of it is the 44 characters the portal expects. */
export function newAppKey(): Buffer {
  return randomBytes(32);
}

/**
 * NIC's public key, in whichever form it arrived.
 *
 * The sandbox portal offers it as a downloadable file, and it has been seen as
 * a PEM public key, a PEM certificate, and bare base64 pasted from the page.
 * All three are accepted, along with a path to any of them, because the person
 * setting this up should not have to learn openssl to convert one.
 *
 * The sandbox and production keys are different. Using the wrong one does not
 * fail here — it fails at the portal, as unreadable credentials.
 */
export function loadPublicKey(source: string): KeyObject {
  const s = source.trim();
  if (!s) throw new Error('The NIC public key is empty.');

  if (!s.includes('-----BEGIN') && s.length < 400 && existsSync(s)) {
    return loadPublicKey(readFileSync(s, 'utf8'));
  }
  if (s.includes('-----BEGIN CERTIFICATE-----')) return new X509Certificate(s).publicKey;
  if (s.includes('-----BEGIN')) return createPublicKey(s);

  const der = Buffer.from(s.replace(/\s+/g, ''), 'base64');
  try {
    return createPublicKey({ key: der, format: 'der', type: 'spki' });
  } catch {
    // Not a bare public key — try it as a DER certificate before giving up.
    return new X509Certificate(der).publicKey;
  }
}

/**
 * RSA with PKCS#1 v1.5 padding — "RSA/ECB/PKCS1Padding" in the Java terms
 * NIC's reference clients are written in.
 *
 * PKCS#1 v1.5 can carry at most the key size minus 11 bytes. The login payload
 * is small, but a very long username and password can push past it, and the
 * error OpenSSL gives for that is unreadable — so it is checked first.
 */
export function rsaEncryptBase64(key: KeyObject, plaintext: Buffer): string {
  const modulusBits = key.asymmetricKeyDetails?.modulusLength ?? 2048;
  const limit = modulusBits / 8 - 11;
  if (plaintext.length > limit) {
    throw new Error(
      `The login payload is ${plaintext.length} bytes and NIC's key can encrypt at most ${limit}. ` +
        'The portal username and password together are too long.',
    );
  }
  return publicEncrypt({ key, padding: constants.RSA_PKCS1_PADDING }, plaintext).toString('base64');
}

/** AES-256-ECB with PKCS#7 padding, which is Node's default for the mode. */
export function aesEncryptBase64(key: Buffer, plaintext: Buffer | string): string {
  const cipher = createCipheriv('aes-256-ecb', key, null); // ECB takes no IV
  return Buffer.concat([cipher.update(plaintext), cipher.final()]).toString('base64');
}

export function aesDecrypt(key: Buffer, base64: string): Buffer {
  const decipher = createDecipheriv('aes-256-ecb', key, null);
  return Buffer.concat([decipher.update(Buffer.from(base64, 'base64')), decipher.final()]);
}

export interface LoginCredentials {
  username: string;
  password: string;
  appKey: Buffer;
  /** Only honoured by the portal in the last ten minutes of a token's life. */
  forceRefresh?: boolean;
}

/**
 * The v1.04 login body: the credentials as JSON, base64-encoded, then
 * RSA-encrypted with NIC's key. The base64 step before encryption is NIC's,
 * and easy to miss — without it the portal cannot read the payload.
 */
export function sealLoginPayload(key: KeyObject, c: LoginCredentials): string {
  const json = JSON.stringify({
    UserName: c.username,
    Password: c.password,
    AppKey: c.appKey.toString('base64'),
    ForceRefreshAccessToken: c.forceRefresh ?? false,
  });
  return rsaEncryptBase64(key, Buffer.from(Buffer.from(json, 'utf8').toString('base64'), 'utf8'));
}

/**
 * The session key, out of its AppKey wrapping.
 *
 * NIC's reference code decrypts to the raw 32 bytes. A few integrations
 * describe getting the key back base64-encoded instead; both are accepted, and
 * anything else is refused rather than used — a wrong key would not fail here,
 * it would fail on the next document as gibberish from the portal.
 */
export function decryptSessionKey(appKey: Buffer, sekBase64: string): Buffer {
  const raw = aesDecrypt(appKey, sekBase64);
  if (raw.length === 32) return raw;

  const asText = raw.toString('utf8').trim();
  if (/^[A-Za-z0-9+/]{43}=$/.test(asText)) {
    const decoded = Buffer.from(asText, 'base64');
    if (decoded.length === 32) return decoded;
  }
  throw new Error(
    `The session key decrypted to ${raw.length} bytes, not 32. The AppKey and the portal disagree — ` +
      'most often because the public key is for the other environment.',
  );
}

/**
 * A reply's `Data`, decrypted and parsed.
 *
 * Decrypts to JSON. As with the session key, some descriptions of the API have
 * the JSON base64-encoded once more inside the ciphertext, so that is tried
 * before giving up. The reply is the portal's, and being strict about a shape
 * we cannot check against a live system yet would only turn a working
 * registration into a reported failure.
 */
export function decryptJson<T>(sek: Buffer, dataBase64: string): T {
  const text = aesDecrypt(sek, dataBase64).toString('utf8').trim();
  try {
    return JSON.parse(text) as T;
  } catch {
    return JSON.parse(Buffer.from(text, 'base64').toString('utf8')) as T;
  }
}
