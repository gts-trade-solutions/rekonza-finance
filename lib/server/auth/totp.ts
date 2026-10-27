import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Time-based one-time passwords (RFC 6238), as every authenticator app makes
// them: HMAC-SHA1 over the 30-second step, six digits. A code is accepted for
// the step before and after its own, to allow for a phone's clock drifting.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const STEP_SECONDS = 30;

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error('Not a base32 secret.');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

/** A new secret: 160 bits, as RFC 4226 recommends. */
export const newSecret = () => base32Encode(randomBytes(20));

export const stepAt = (ms: number) => Math.floor(ms / 1000 / STEP_SECONDS);

export function codeAt(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = mac[mac.length - 1] & 15;
  const n = ((mac[offset] & 127) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(n % 1_000_000).padStart(6, '0');
}

/**
 * The step a code belongs to, if it is right now (give or take one step) and
 * later than the last one used. Null otherwise.
 */
export function matchCode(secret: string, code: string, nowMs: number, lastStep: number | null): number | null {
  const given = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(given)) return null;
  const now = stepAt(nowMs);
  for (const step of [now, now - 1, now + 1]) {
    if (lastStep !== null && step <= lastStep) continue;
    if (timingSafeEqual(Buffer.from(codeAt(secret, step)), Buffer.from(given))) return step;
  }
  return null;
}

/** What an authenticator app scans to add the account. */
export const otpauthUri = (issuer: string, account: string, secret: string) =>
  `otpauth://totp/${encodeURIComponent(`${issuer}:${account}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP_SECONDS}`;

// ── Recovery codes ──────────────────────────────────────────────────────────

const normalise = (code: string) => code.toLowerCase().replace(/[^a-z0-9]/g, '');
export const hashRecovery = (code: string) => createHash('sha256').update(normalise(code)).digest('hex');

/** Ten one-time codes, xxxx-xxxx, for when the phone is lost. Shown once; stored as hashes. */
export function newRecoveryCodes(n = 10): { plain: string[]; hashes: string[] } {
  const plain = Array.from({ length: n }, () => {
    const s = randomBytes(5).toString('hex');
    return `${s.slice(0, 5)}-${s.slice(5)}`;
  });
  return { plain, hashes: plain.map(hashRecovery) };
}
