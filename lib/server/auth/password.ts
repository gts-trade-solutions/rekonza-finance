import 'server-only';

// Password hashing.
//
// argon2id, which is what the Password Hashing Competition settled on and what
// OWASP recommends today. It is deliberately slow and deliberately
// memory-hungry: bcrypt's small fixed memory makes it cheap to attack on a GPU,
// where thousands of guesses run in parallel. Argon2's memory cost is what
// takes that parallelism away.
//
// The parameters below are OWASP's minimum for argon2id — 19 MiB, two
// iterations, one lane. Raising them later is safe: the cost is encoded in the
// hash itself, so old hashes keep verifying and only new ones get the new cost.

import { hash, verify } from '@node-rs/argon2';

// Algorithm.Argon2id is an ambient const enum, which Next's isolatedModules
// build cannot read across a module boundary. Its value is 2.
const ARGON2ID = 2;

const OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19_456, // KiB
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(plain: string): Promise<string> {
  if (plain.length < 8) {
    throw new Error('A password must be at least 8 characters.');
  }
  return hash(plain, OPTIONS);
}

/**
 * Verify a password, returning false rather than throwing on a malformed hash.
 *
 * A stored hash that will not parse — truncated by a bad migration, say —
 * should read as "wrong password", not as a 500. The alternative hands an
 * attacker a way to distinguish real accounts from broken ones.
 */
export async function verifyPassword(storedHash: string, plain: string): Promise<boolean> {
  try {
    return await verify(storedHash, plain, OPTIONS);
  } catch {
    return false;
  }
}

/**
 * Burn roughly the same time as a real verification.
 *
 * Called when the email does not exist. Without it, a missing account returns
 * in a millisecond and a real one takes ~50ms, which is enough to enumerate
 * every address in the organisation from the outside.
 */
export async function fakeVerify(): Promise<void> {
  await verify(
    // A pre-computed hash of a value nothing can match.
    '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHR2YWx1ZQ$Yn7jVGZ0YlZ0aGlzaXNub3RhcmVhbGhhc2g',
    'not-a-real-password',
    OPTIONS,
  ).catch(() => false);
}

/** Complaints a user can act on, rather than a single "invalid password". */
export function passwordProblems(plain: string): string[] {
  const problems: string[] = [];
  if (plain.length < 8) problems.push('Use at least 8 characters.');
  if (!/[a-z]/.test(plain)) problems.push('Include a lower-case letter.');
  if (!/[A-Z]/.test(plain)) problems.push('Include an upper-case letter.');
  if (!/[0-9]/.test(plain)) problems.push('Include a digit.');
  return problems;
}
