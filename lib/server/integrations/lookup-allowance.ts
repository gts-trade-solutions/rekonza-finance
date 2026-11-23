import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// How many paid GSTIN lookups may be made in a day.
//
// Every lookup a service answers costs the business money (gstinapi.in and the
// like sell them in packs), and two doors reach it: the sign-up page, which
// anyone may use without an account, and the customer and vendor forms, which
// anyone may reach by signing up. A day's allowance per company, per sign-up
// address and for everyone together keeps a stranger from spending the whole
// pack. A GSTIN asked again within twelve hours is answered from the store in
// party-lookup.ts and is not counted here.
//
// Each limit can be changed in .env.local; 0 turns paid lookups off there.
//   GSTIN_LOOKUP_PER_COMPANY_DAY  one company, signed in (default 100)
//   GSTIN_LOOKUP_SIGNUP_PER_DAY   the sign-up page, all visitors (default 20)
//   GSTIN_LOOKUP_PER_DAY          everyone together (default 300)
// ─────────────────────────────────────────────────────────────────────────────

import { db } from '../db';
import { bucket, count, overLimit } from '../auth/throttle';
import type { PaidLookupCheck } from './party-lookup';

const DAY_MINUTES = 24 * 60;
/** A sign-up needs one lookup, two with a typo: more from one address is not a sign-up. */
const SIGNUP_PER_ADDRESS = 3;

function setting(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

interface Allowance { name: string; limit: number; refusal: string }

function check(allowances: Allowance[]): PaidLookupCheck {
  return async () => {
    for (const a of allowances) {
      if (await overLimit(db, a.name, a.limit, DAY_MINUTES)) return a.refusal;
    }
    for (const a of allowances) await count(db, a.name, DAY_MINUTES);
    return null;
  };
}

const everyone = (): Allowance => {
  const limit = setting('GSTIN_LOOKUP_PER_DAY', 300);
  return { name: 'gstin-paid:all', limit, refusal: `Today’s ${limit} GSTIN lookups are used up.` };
};

/** A signed-in company filling a customer, vendor or its own profile. */
export function companyLookups(orgId: number): PaidLookupCheck {
  const limit = setting('GSTIN_LOOKUP_PER_COMPANY_DAY', 100);
  return check([
    { name: `gstin-paid:org:${orgId}`, limit, refusal: `Today’s ${limit} GSTIN lookups for this company are used up.` },
    everyone(),
  ]);
}

/** The public sign-up page, by the visitor's address. */
export function signUpLookups(address: string): PaidLookupCheck {
  const limit = setting('GSTIN_LOOKUP_SIGNUP_PER_DAY', 20);
  const refusal = 'Today’s GSTIN lookups for new sign-ups are used up.';
  return check([
    { name: bucket('gstin-paid:ip', address), limit: SIGNUP_PER_ADDRESS, refusal },
    { name: 'gstin-paid:signup', limit, refusal },
    everyone(),
  ]);
}
