import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Attempts counted per window (migration 103), for sign-in and portal codes.
//
// An account lockout alone stops guessing one person's password but not one
// common password tried across every account, and it answers differently for
// accounts that exist. Counting per address and per email as well closes both:
// many tries from one place are slowed whatever accounts they aim at, and an
// email that does not exist slows down exactly as one that does.
//
// Kept in the database rather than in memory: on serverless hosting each
// request may land on a different instance, and a counter in memory would
// start again at zero on every one of them.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import type { Executor } from '../db';

/** A bucket name that never stores the email or address itself. */
export const bucket = (kind: string, key: string) => `${kind}:${createHash('sha256').update(key.trim().toLowerCase()).digest('hex').slice(0, 40)}`;

/** Whether a bucket is over its limit in the current window, without counting this attempt. */
export async function overLimit(ex: Executor, name: string, limit: number, windowMinutes: number): Promise<boolean> {
  const { rows } = await sql<{ hits: number }>`
    SELECT hits FROM auth_throttle
     WHERE bucket = ${name} AND window_start > NOW() - INTERVAL ${windowMinutes} MINUTE`.execute(ex);
  return Number(rows[0]?.hits ?? 0) >= limit;
}

/** Count one attempt against a bucket; a window that has run out starts again. */
export async function count(ex: Executor, name: string, windowMinutes: number): Promise<void> {
  // hits is set before window_start, so both read the window as it was.
  await sql`
    INSERT INTO auth_throttle (bucket, hits, window_start) VALUES (${name}, 1, NOW())
    ON DUPLICATE KEY UPDATE
      hits = IF(window_start <= NOW() - INTERVAL ${windowMinutes} MINUTE, 1, hits + 1),
      window_start = IF(window_start <= NOW() - INTERVAL ${windowMinutes} MINUTE, NOW(), window_start)`.execute(ex);
}

/** Forget a bucket, after a success. */
export async function clear(ex: Executor, name: string): Promise<void> {
  await sql`DELETE FROM auth_throttle WHERE bucket = ${name}`.execute(ex);
}
