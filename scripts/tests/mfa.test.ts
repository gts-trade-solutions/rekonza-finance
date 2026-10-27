// Two-step sign-in: the RFC 6238 codes, setting it up, signing in, recovery, and the book's requirement.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/mfa.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../../lib/server/db';
import { base32Decode, base32Encode, codeAt, matchCode, stepAt } from '../../lib/server/auth/totp';
import {
  answerChallenge, checkCode, confirmEnrolment, createChallenge, disableMfa, mfaStatus, startEnrolment,
} from '../../lib/server/auth/mfa';
import { seal, unseal } from '../../lib/server/crypto/fields';

test('codes match RFC 6238 (SHA-1 test vectors, last six digits), with a step either side and no reuse', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(secret, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.equal(base32Decode(secret).toString(), '12345678901234567890');
  assert.equal(codeAt(secret, stepAt(59_000)), '287082');
  assert.equal(codeAt(secret, stepAt(1_111_111_109_000)), '081804');
  assert.equal(codeAt(secret, stepAt(2_000_000_000_000)), '279037');
  const now = 1_111_111_109_000;
  assert.equal(matchCode(secret, '081804', now + 30_000, null), stepAt(now), 'the step before still counts');
  assert.equal(matchCode(secret, '081804', now + 90_000, null), null, 'two steps late does not');
  assert.equal(matchCode(secret, '081804', now, stepAt(now)), null, 'a used code is refused');
});

test('field sealing round-trips with a key and leaves values alone without one', () => {
  const before = process.env.FIELD_ENCRYPTION_KEY;
  try {
    delete process.env.FIELD_ENCRYPTION_KEY;
    assert.equal(seal('50200012345678'), '50200012345678');
    process.env.FIELD_ENCRYPTION_KEY = 'a'.repeat(64);
    const sealed = seal('50200012345678')!;
    assert.match(sealed, /^enc:v1:/);
    assert.notEqual(sealed, seal('50200012345678'), 'a fresh IV each time');
    assert.equal(unseal(sealed), '50200012345678');
    assert.equal(unseal('plain written before the key'), 'plain written before the key');
  } finally {
    if (before === undefined) delete process.env.FIELD_ENCRYPTION_KEY; else process.env.FIELD_ENCRYPTION_KEY = before;
  }
});

test('set up, sign in with a code, a recovery code once, five wrong tries, and the book can forbid turning it off', async () => {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'MFA Co' }).executeTakeFirstOrThrow()).insertId);
      const userId = Number((await trx.insertInto('users').values({ org_id: orgId, name: 'Asha', email: `asha-${orgId}@example.test`, role: 'admin' }).executeTakeFirstOrThrow()).insertId);
      const t0 = Date.now();

      const { secret, uri } = await startEnrolment(trx, { userId, email: 'asha@example.test' }, 'Rekonza');
      assert.match(uri, /^otpauth:\/\/totp\/Rekonza%3Aasha%40example\.test\?secret=/);
      assert.equal((await mfaStatus(trx, userId)).pending, true);
      await assert.rejects(confirmEnrolment(trx, userId, '000000', t0), /not right/);
      const recovery = await confirmEnrolment(trx, userId, codeAt(secret, stepAt(t0)), t0);
      assert.equal(recovery.length, 10);
      assert.deepEqual(await mfaStatus(trx, userId).then((s) => [s.enabled, s.recoveryLeft]), [true, 10]);

      // The code used to confirm cannot sign in; the next one can, once.
      const t1 = t0 + 30_000;
      assert.equal(await checkCode(trx, userId, codeAt(secret, stepAt(t0)), t0), null);
      assert.equal(await checkCode(trx, userId, codeAt(secret, stepAt(t1)), t1), 'app');
      assert.equal(await checkCode(trx, userId, codeAt(secret, stepAt(t1)), t1), null, 'replayed');
      assert.equal(await checkCode(trx, userId, recovery[0].toUpperCase(), t1), 'recovery');
      assert.equal(await checkCode(trx, userId, recovery[0], t1), null, 'a recovery code works once');

      const challenge = await createChallenge(trx, { id: userId, orgId }, {});
      for (let i = 1; i <= 4; i++) await assert.rejects(answerChallenge(trx, challenge, '999999', t1), new RegExp(`${5 - i} tr`));
      await assert.rejects(answerChallenge(trx, challenge, '999999', t1), /password again/);
      const fresh = await createChallenge(trx, { id: userId, orgId }, {});
      const t2 = t1 + 30_000;
      assert.equal((await answerChallenge(trx, fresh, codeAt(secret, stepAt(t2)), t2)).userId, userId);
      await assert.rejects(answerChallenge(trx, fresh, codeAt(secret, stepAt(t2)), t2), /expired/, 'a challenge is spent once answered');

      await trx.insertInto('settings').values({ org_id: orgId, scope: 'policy', setting_key: 'requireMfa', value: JSON.stringify('admins') }).execute();
      await assert.rejects(disableMfa(trx, { userId, orgId, role: 'admin' }, recovery[1]), /requires two-step/);
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
});

test.after(async () => {
  await db.destroy();
});
