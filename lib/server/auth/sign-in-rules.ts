import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// A book's own limits on signing in, beyond the password, the lockout and the
// two-step code.
//
//   Where from    a list of addresses or ranges (the office's fixed IP, a
//                 VPN): anyone else is refused, admins too unless allowed
//                 from anywhere, so a wrong list cannot lock everyone out.
//   How many      open sessions one person may have; a new sign-in ends the
//                 oldest beyond the limit, so a shared login cannot spread.
//   New devices   a sign-in from a browser the person has not used before puts
//                 a notice under their bell.
// ─────────────────────────────────────────────────────────────────────────────

import type { Executor } from '../db';
import { ApiError } from '../http';
import { getPolicies } from '../services/org-settings';
import { notify } from '../services/notifications';
import { logAudit } from '../audit';
import { ipAllowed } from './ip-rules';

type Who = { id: number; orgId: number; name: string; role: string };

/** Refused when signing in from an address the book does not allow. */
export async function assertSignInAllowed(ex: Executor, user: Who, ip: string | null, userAgent: string | null) {
  const rule = (await getPolicies(ex, user.orgId)).signIn;
  if (!rule.allowedIps.length || (user.role === 'admin' && rule.adminsAnywhere)) return;
  if (ipAllowed(ip, rule.allowedIps)) return;
  await logAudit({
    orgId: user.orgId, actorUserId: user.id, actorName: user.name, action: 'login', targetType: 'session', targetId: String(user.id),
    detail: `Failed sign-in: ${ip ?? 'an unknown address'} is not on the allowed list`, ip, userAgent,
  });
  throw new ApiError(403, 'Signing in is allowed only from your office network. Ask an admin if you need to work from elsewhere.', 'ip_not_allowed');
}

/** Whether this person has signed in from this browser before. Asked before the new session exists. */
export async function knownDevice(ex: Executor, userId: number, userAgent: string | null): Promise<{ known: boolean; first: boolean }> {
  const any = await ex.selectFrom('sessions').select('user_agent').where('user_id', '=', userId).limit(200).execute();
  return { known: any.some((s) => s.user_agent === userAgent), first: any.length === 0 };
}

/** After the session is made: the oldest beyond the limit ended, and a new browser reported. */
export async function afterSignIn(ex: Executor, user: Who, ip: string | null, userAgent: string | null, device: { known: boolean; first: boolean }) {
  const rule = (await getPolicies(ex, user.orgId)).signIn;
  if (rule.maxSessions > 0) {
    const open = await ex.selectFrom('sessions').select(['token_hash'])
      .where('user_id', '=', user.id).where('revoked_at', 'is', null).where('expires_at', '>', new Date())
      .orderBy('created_at', 'desc').execute();
    const extra = open.slice(rule.maxSessions).map((s) => s.token_hash);
    if (extra.length) {
      await ex.updateTable('sessions').set({ revoked_at: new Date(), end_reason: 'session_limit' }).where('token_hash', 'in', extra).execute();
    }
  }
  if (rule.alertNewDevice && !device.known && !device.first) {
    const browser = (userAgent ?? '').match(/(Edg|OPR|Chrome|Firefox|Safari)\/[\d.]+/)?.[0]?.replace('Edg', 'Edge').replace('OPR', 'Opera') ?? 'a new browser';
    const system = (userAgent ?? '').match(/Windows|Android|iPhone|iPad|Mac OS X|Linux/)?.[0] ?? '';
    await notify(ex, user.orgId, [user.id], {
      kind: 'security',
      title: 'New sign-in to your account',
      body: `${browser}${system ? ` on ${system}` : ''}, from ${ip ?? 'an unknown address'}. If it was not you, change your password and end that session under Settings → Sign-ins.`,
      href: '/settings?tab=sign-ins',
    });
  }
}
