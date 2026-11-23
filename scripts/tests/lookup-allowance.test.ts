// A day's allowance of paid GSTIN lookups (lib/server/integrations/lookup-allowance.ts):
// per company, per sign-up address, for all sign-ups and for everyone together,
// so a stranger cannot spend the business's whole pack of lookups.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/lookup-allowance.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { db } from '../../lib/server/db';
import { companyLookups, signUpLookups } from '../../lib/server/integrations/lookup-allowance';

const ENV = ['GSTIN_LOOKUP_PER_COMPANY_DAY', 'GSTIN_LOOKUP_SIGNUP_PER_DAY', 'GSTIN_LOOKUP_PER_DAY'];
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
// Companies that do not exist, so no real book's count is touched.
const ORG_A = 990_001;
const ORG_B = 990_002;

/** The global buckets are shared with anything else running: keep what was there and put it back. */
let kept: { bucket: string; hits: number; window_start: Date }[] = [];
const SHARED = ['gstin-paid:all', 'gstin-paid:signup'];

async function forget() {
  await sql`DELETE FROM auth_throttle WHERE bucket IN (${sql.join(SHARED)}) OR bucket LIKE 'gstin-paid:org:99000%' OR bucket LIKE 'gstin-paid:ip:%'`.execute(db);
}

test.before(async () => {
  const { rows } = await sql<{ bucket: string; hits: number; window_start: Date }>`
    SELECT bucket, hits, window_start FROM auth_throttle WHERE bucket IN (${sql.join(SHARED)})`.execute(db);
  kept = rows;
  await forget();
});
test.afterEach(async () => {
  for (const k of ENV) delete process.env[k];
  await forget();
});
test.after(async () => {
  for (const r of kept) {
    await sql`INSERT INTO auth_throttle (bucket, hits, window_start) VALUES (${r.bucket}, ${r.hits}, ${r.window_start})`.execute(db);
  }
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  await db.destroy();
});

test('a company may make its day’s paid lookups, and no more; another company is not held up', async () => {
  process.env.GSTIN_LOOKUP_PER_COMPANY_DAY = '2';
  const a = companyLookups(ORG_A);
  assert.equal(await a(), null);
  assert.equal(await a(), null);
  assert.equal(await a(), 'Today’s 2 GSTIN lookups for this company are used up.');
  assert.equal(await companyLookups(ORG_B)(), null, 'each company has its own day');
});

test('everyone together has a day’s limit too', async () => {
  process.env.GSTIN_LOOKUP_PER_DAY = '3';
  assert.equal(await companyLookups(ORG_A)(), null);
  assert.equal(await companyLookups(ORG_B)(), null);
  assert.equal(await signUpLookups('203.0.113.7')(), null);
  assert.equal(await companyLookups(ORG_A)(), 'Today’s 3 GSTIN lookups are used up.');
});

test('the sign-up page: three from one address, and a limit for all visitors', async () => {
  const one = signUpLookups('203.0.113.8');
  for (let i = 0; i < 3; i += 1) assert.equal(await one(), null);
  assert.equal(await one(), 'Today’s GSTIN lookups for new sign-ups are used up.');
  process.env.GSTIN_LOOKUP_SIGNUP_PER_DAY = '4';
  assert.equal(await signUpLookups('203.0.113.9')(), null, 'a fourth visitor-lookup in all is still under 4');
  assert.equal(await signUpLookups('203.0.113.10')(), 'Today’s GSTIN lookups for new sign-ups are used up.');
  assert.equal(await companyLookups(ORG_A)(), null, 'a signed-in company is not held up by the sign-up limit');
});

test('a refused lookup is not counted, and 0 turns paid lookups off', async () => {
  process.env.GSTIN_LOOKUP_PER_COMPANY_DAY = '1';
  const a = companyLookups(ORG_A);
  assert.equal(await a(), null);
  for (let i = 0; i < 3; i += 1) assert.notEqual(await a(), null);
  const { rows } = await sql<{ hits: number }>`SELECT hits FROM auth_throttle WHERE bucket = 'gstin-paid:all'`.execute(db);
  assert.equal(Number(rows[0]?.hits), 1, 'only the lookup that went ahead counts towards everyone’s day');
  process.env.GSTIN_LOOKUP_PER_COMPANY_DAY = '0';
  assert.match(await companyLookups(ORG_B)() ?? '', /Today’s 0 GSTIN lookups/);
  process.env.GSTIN_LOOKUP_PER_COMPANY_DAY = 'lots';
  assert.equal(await companyLookups(ORG_B)(), null, 'a setting that is not a number keeps the default');
});
