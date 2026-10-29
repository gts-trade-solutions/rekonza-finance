import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// A book's own password rules, on top of the floor every password meets
// (password.ts): a longer minimum, an age after which it must be changed, and
// how many earlier ones may not come back.
//
// A temporary password an admin hands out — a new user's, or a reset — is
// marked as changed at the very start of 1970, so it has always expired: the
// person must choose their own before anything else opens, whatever the book's
// expiry rule is.
// ─────────────────────────────────────────────────────────────────────────────

import type { Executor } from '../db';
import { getPolicies } from '../services/org-settings';
import { MUST_CHANGE, passwordProblems, verifyPassword } from './password';

export { MUST_CHANGE, passwordExpired } from './password';
const MAX_KEPT = 24;

/** What is wrong with a new password under this book's rules; empty when it is fine. */
export async function newPasswordProblems(ex: Executor, orgId: number, userId: number | null, plain: string): Promise<string[]> {
  const rules = (await getPolicies(ex, orgId)).password;
  const problems = passwordProblems(plain);
  if (plain.length < rules.minLength && !problems.some((p) => p.includes('characters'))) {
    problems.unshift(`Use at least ${rules.minLength} characters.`);
  } else if (plain.length < rules.minLength) {
    problems[problems.findIndex((p) => p.includes('characters'))] = `Use at least ${rules.minLength} characters.`;
  }
  if (userId && rules.history > 0 && !problems.length) {
    const old = await ex.selectFrom('password_history').select('password_hash')
      .where('user_id', '=', userId).orderBy('id', 'desc').limit(rules.history).execute();
    for (const o of old) {
      if (await verifyPassword(o.password_hash, plain)) {
        problems.push(`Choose a password you have not used in your last ${rules.history}.`);
        break;
      }
    }
  }
  return problems;
}

/** Keep a newly set password: in the history, and as the moment it was changed. */
export async function recordPasswordSet(ex: Executor, userId: number, hash: string, opts: { temporary?: boolean } = {}) {
  await ex.updateTable('users').set({ password_changed_at: opts.temporary ? MUST_CHANGE : new Date() }).where('id', '=', userId).execute();
  if (opts.temporary) return;
  await ex.insertInto('password_history').values({ user_id: userId, password_hash: hash }).execute();
  const keep = await ex.selectFrom('password_history').select('id').where('user_id', '=', userId)
    .orderBy('id', 'desc').limit(1).offset(MAX_KEPT - 1).executeTakeFirst();
  if (keep) await ex.deleteFrom('password_history').where('user_id', '=', userId).where('id', '<', keep.id).execute();
}

