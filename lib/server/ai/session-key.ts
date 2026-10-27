import 'server-only';

import { createHash } from 'node:crypto';
import { cookies } from 'next/headers';
import { SESSION_COOKIE } from '../auth/session';

/**
 * The current sign-in session, hashed — the same value the sessions table
 * stores. On the shared demo book every visitor signs in as the same user, so
 * conversations there are kept apart by this instead of by user.
 */
export async function currentSessionKey(): Promise<string | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  return token ? createHash('sha256').update(token).digest('hex') : null;
}
