import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// A book's own policies.
//
// Some rules are the law and apply to everyone. Others are a business's own
// choice: whether a sale that takes a customer past their credit limit is
// stopped or only flagged, whether stock may go below zero, whether a cash
// receipt over the section 269ST limit is refused or warned about, and which
// parts of the app it uses at all. Those live here, in the settings table,
// with defaults that are safe for a business that has not chosen.
// ─────────────────────────────────────────────────────────────────────────────

import type { Executor, Trx } from '../db';
import { badRequest } from '../http';
import { isAddressRule } from '../auth/ip-rules';

export type Enforcement = 'off' | 'warn' | 'block';

export interface OrgPolicies {
  /** Parts of the app this book uses. Switched off, they leave the menus. */
  features: {
    inventory: boolean;
    fixedAssets: boolean;
    tdsTcs: boolean;
    ewayBills: boolean;
    approvals: boolean;
    tally: boolean;
    analytics: boolean;
    payroll: boolean;
    /** GST returns, e-invoices and e-way bills: off for a business not registered under GST. */
    gst: boolean;
    multiCurrency: boolean;
    costCentres: boolean;
  };
  /** An invoice taking a customer past their credit limit. */
  creditLimit: Enforcement;
  /** An issue that would take an item's stock below zero. */
  negativeStock: Enforcement;
  /** Cash over the limits of sections 269ST and 40A(3). */
  cashLimits: Enforcement;
  /** Sign a user out after this many minutes without a request. 0 keeps the session's own lifetime. */
  sessionIdleMinutes: number;
  /** Who must sign in with a code from an authenticator app as well as the password. */
  requireMfa: 'off' | 'admins' | 'everyone';
  /** The RBI bank rate: interest to MSME suppliers paid late is three times it (MSMED Act s.16). */
  msmeBankRatePct: number;
  /** Interest charged to customers on overdue invoices, a year, and the days allowed before it starts. */
  overdueInterestPct: number;
  overdueGraceDays: number;
  /** How closing stock is valued: weighted average for the year, or first in, first out (AS 2 allows either). */
  stockValuation: 'average' | 'fifo';
  /** Where from and how many: see auth/sign-in-rules.ts. */
  signIn: { allowedIps: string[]; adminsAnywhere: boolean; maxSessions: number; alertNewDevice: boolean };
  /** Payment reminders: on or off, on which days from the due date, and how they go. See services/reminders.ts. */
  reminders: { enabled: boolean; stages: number[]; channel: 'whatsapp' | 'email' | 'sms' };
  /**
   * Disaster recovery: the most work a disaster may cost (hours since the last
   * backup) and the longest a restore may take (minutes). Measured against the
   * backups and restore drills under Settings → Backups.
   */
  recovery: { rpoHours: number; rtoMinutes: number };
}

export const DEFAULT_POLICIES: OrgPolicies = {
  features: { inventory: true, fixedAssets: true, tdsTcs: true, ewayBills: true, approvals: true, tally: true, analytics: true, payroll: true, gst: true, multiCurrency: true, costCentres: true },
  creditLimit: 'warn',
  negativeStock: 'warn',
  cashLimits: 'warn',
  sessionIdleMinutes: 0,
  requireMfa: 'off',
  msmeBankRatePct: 5.5,
  overdueInterestPct: 18,
  overdueGraceDays: 0,
  stockValuation: 'average',
  signIn: { allowedIps: [], adminsAnywhere: true, maxSessions: 0, alertNewDevice: true },
  reminders: { enabled: false, stages: [-3, 0, 7, 15, 30], channel: 'whatsapp' },
  recovery: { rpoHours: 24, rtoMinutes: 240 },
};

// The driver hands JSON columns back already parsed, so a stored "block" arrives
// as the bare string block; a driver that does not parse them sends the text.
function parsed(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

const SCOPE = 'policy';
const KEYS = ['features', 'creditLimit', 'negativeStock', 'cashLimits', 'sessionIdleMinutes', 'requireMfa', 'msmeBankRatePct', 'overdueInterestPct', 'overdueGraceDays', 'stockValuation', 'signIn', 'reminders', 'recovery'] as const;

export async function getPolicies(ex: Executor, orgId: number): Promise<OrgPolicies> {
  const rows = await ex.selectFrom('settings').select(['setting_key', 'value'])
    .where('org_id', '=', orgId).where('scope', '=', SCOPE).execute();
  const out: OrgPolicies = structuredClone(DEFAULT_POLICIES);
  for (const r of rows) {
    const v = parsed(r.value);
    switch (r.setting_key) {
      case 'features': out.features = { ...out.features, ...(v as Partial<OrgPolicies['features']>) }; break;
      case 'creditLimit': case 'negativeStock': case 'cashLimits':
        if (['off', 'warn', 'block'].includes(v as string)) out[r.setting_key] = v as Enforcement;
        break;
      case 'sessionIdleMinutes': out.sessionIdleMinutes = Number(v) || 0; break;
      case 'requireMfa': if (v === 'admins' || v === 'everyone' || v === 'off') out.requireMfa = v; break;
      case 'msmeBankRatePct': out.msmeBankRatePct = Number(v) || DEFAULT_POLICIES.msmeBankRatePct; break;
      case 'overdueInterestPct': out.overdueInterestPct = Number(v) || 0; break;
      case 'overdueGraceDays': out.overdueGraceDays = Number(v) || 0; break;
      case 'stockValuation': if (v === 'fifo' || v === 'average') out.stockValuation = v; break;
      case 'signIn': out.signIn = { ...out.signIn, ...(v as Partial<OrgPolicies['signIn']>) }; break;
      case 'reminders': out.reminders = { ...out.reminders, ...(v as Partial<OrgPolicies['reminders']>) }; break;
      case 'recovery': out.recovery = { ...out.recovery, ...(v as Partial<OrgPolicies['recovery']>) }; break;
    }
  }
  return out;
}

export async function setPolicies(trx: Trx, orgId: number, userId: number | null, patch: Partial<OrgPolicies>): Promise<OrgPolicies> {
  const current = await getPolicies(trx, orgId);
  for (const key of KEYS) {
    if (patch[key] === undefined) continue;
    let value: unknown = patch[key];
    if (key === 'features') value = { ...current.features, ...(patch.features ?? {}) };
    if (key === 'recovery') {
      const r = { ...current.recovery, ...(patch.recovery ?? {}) };
      if (!(Number.isInteger(r.rpoHours) && r.rpoHours >= 1 && r.rpoHours <= 168)) throw badRequest('The recovery point is 1 to 168 hours.');
      if (!(Number.isInteger(r.rtoMinutes) && r.rtoMinutes >= 5 && r.rtoMinutes <= 7 * 24 * 60)) throw badRequest('The recovery time is 5 minutes to 7 days.');
      value = r;
    }
    if (key === 'reminders') {
      const r = { ...current.reminders, ...(patch.reminders ?? {}) };
      r.stages = [...new Set(r.stages.map(Number))].sort((a, b) => a - b);
      if (r.stages.some((s) => !Number.isInteger(s) || s < -30 || s > 180) || r.stages.length > 8) {
        throw badRequest('Reminder days are whole days from the due date, -30 to 180, at most eight of them.');
      }
      if (!['whatsapp', 'email', 'sms'].includes(r.channel)) throw badRequest('Reminders go by WhatsApp, email or SMS.');
      value = r;
    }
    if (key === 'signIn') {
      const s = { ...current.signIn, ...(patch.signIn ?? {}) };
      s.allowedIps = s.allowedIps.map((r) => r.trim()).filter(Boolean);
      const bad = s.allowedIps.find((r) => !isAddressRule(r));
      if (bad) throw badRequest(`${bad} is not an address or range. Use 203.0.113.7, 203.0.113.0/24 or 192.168.1.*.`);
      if (s.allowedIps.length > 50) throw badRequest('At most fifty addresses or ranges.');
      if (!(Number.isInteger(s.maxSessions) && s.maxSessions >= 0 && s.maxSessions <= 20)) throw badRequest('Sessions a person may keep open: 0 (no limit) to 20.');
      value = s;
    }
    if (key === 'sessionIdleMinutes') {
      const n = Number(value);
      if (!(Number.isInteger(n) && n >= 0 && n <= 24 * 60)) throw badRequest('Idle sign-out is between 0 (off) and 1440 minutes.');
    }
    if (key === 'requireMfa' && !['off', 'admins', 'everyone'].includes(String(value))) throw badRequest('Require two-step sign-in of nobody, admins or everyone.');
    if (key === 'overdueInterestPct' && !(Number(value) >= 0 && Number(value) <= 60)) throw badRequest('Interest is a yearly percentage between 0 and 60.');
    if (key === 'overdueGraceDays' && !(Number.isInteger(Number(value)) && Number(value) >= 0 && Number(value) <= 365)) throw badRequest('Grace days are between 0 and 365.');
    if (key === 'msmeBankRatePct') {
      const n = Number(value);
      if (!(n > 0 && n < 20)) throw badRequest('The bank rate is a percentage, such as 5.5.');
    }
    await trx.insertInto('settings').values({
      org_id: orgId, scope: SCOPE, setting_key: key, value: JSON.stringify(value), updated_by_user_id: userId,
    }).onDuplicateKeyUpdate({ value: JSON.stringify(value), updated_by_user_id: userId }).execute();
  }
  return getPolicies(trx, orgId);
}

/**
 * Apply a policy to a problem: nothing when it is off, a warning to show the
 * user when it warns, and a refusal when it blocks.
 */
export function enforce(policy: Enforcement, message: string, warnings: string[], refuse: (m: string) => Error) {
  if (policy === 'off') return;
  if (policy === 'block') throw refuse(message);
  warnings.push(message);
}
