// Sign-in from allowed addresses only, a limit on open sessions and a notice
// for a new browser; print and export as rights of their own; restricted
// voucher types; employee PAN and Aadhaar sealed; consent given and withdrawn.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/security-more.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db, type Trx } from '../../lib/server/db';
import { hasPermission, type CustomPermissions } from '../../lib/rbac';
import { runAs } from '../../lib/server/http';
import { ipAllowed, isAddressRule } from '../../lib/server/auth/ip-rules';
import { afterSignIn, assertSignInAllowed, knownDevice } from '../../lib/server/auth/sign-in-rules';
import { setPolicies } from '../../lib/server/services/org-settings';
import { saveVoucherType, seriesFor } from '../../lib/server/services/voucher-types';
import { createEmployee, listEmployees } from '../../lib/server/payroll/employees';
import { employeesWithoutConsent, listConsents, recordConsent, withdrawConsent } from '../../lib/server/services/privacy';

async function rolledBack(fn: (trx: Trx, orgId: number, branchId: number) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Secure Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1 }).executeTakeFirstOrThrow()).insertId);
      await fn(trx, orgId, branchId);
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

test('address rules: exact, ranges and wildcards', () => {
  const rules = ['203.0.113.7', '198.51.100.0/24', '192.168.1.*'];
  assert.equal(ipAllowed('203.0.113.7', rules), true);
  assert.equal(ipAllowed('::ffff:203.0.113.7', rules), true, 'an IPv4 address written as IPv6');
  assert.equal(ipAllowed('203.0.113.8', rules), false);
  assert.equal(ipAllowed('198.51.100.200', rules), true);
  assert.equal(ipAllowed('198.51.101.1', rules), false);
  assert.equal(ipAllowed('192.168.1.44', rules), true);
  assert.equal(ipAllowed('10.1.2.3', ['10.1.*']), true, 'a trailing wildcard covers the rest');
  assert.equal(ipAllowed('10.2.2.3', ['10.1.*']), false);
  assert.equal(ipAllowed(null, rules), false, 'no address, no entry');
  assert.equal(ipAllowed(null, []), true, 'no rules, no limit');
  assert.deepEqual(['10.0.0.0/8', '10.1.*', '2001:db8::1', '10.0.0.0/40', 'office', '300.1.1.1'].map(isAddressRule), [true, true, true, false, false, false]);
});

test('sign-in: refused from elsewhere, admins excepted; the oldest session beyond the limit ends; a new browser is reported', async () => {
  await rolledBack(async (trx, orgId) => {
    const user = (role: 'admin' | 'staff', email: string) => trx.insertInto('users').values({ org_id: orgId, name: role, email: `${email}-${orgId}@example.test`, role }).executeTakeFirstOrThrow();
    const staff = { id: Number((await user('staff', 's')).insertId), orgId, name: 'Staff', role: 'staff' };
    const admin = { id: Number((await user('admin', 'a')).insertId), orgId, name: 'Admin', role: 'admin' };
    await setPolicies(trx, orgId, null, { signIn: { allowedIps: ['203.0.113.0/24'], adminsAnywhere: true, maxSessions: 2, alertNewDevice: true } });
    await assert.rejects(assertSignInAllowed(trx, staff, '198.51.100.9', 'UA'), /only from your office network/);
    await assertSignInAllowed(trx, staff, '203.0.113.50', 'UA');
    await assertSignInAllowed(trx, admin, '198.51.100.9', 'UA');
    await assert.rejects(setPolicies(trx, orgId, null, { signIn: { allowedIps: ['the office'] } as never }), /not an address or range/);

    const chrome = 'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0.0.0';
    const session = (n: number, ua: string) => trx.insertInto('sessions').values({
      token_hash: `t${orgId}-${n}`, user_id: staff.id, org_id: orgId, ip: '203.0.113.5', user_agent: ua,
      expires_at: new Date(Date.now() + 86_400_000), created_at: new Date(Date.now() - (10 - n) * 60_000),
    } as never).execute();
    assert.deepEqual(await knownDevice(trx, staff.id, chrome), { known: false, first: true });
    await session(1, chrome);
    await session(2, chrome);
    const firefox = 'Mozilla/5.0 (X11; Linux x86_64) Firefox/131.0';
    const device = await knownDevice(trx, staff.id, firefox);
    assert.deepEqual(device, { known: false, first: false });
    await session(3, firefox);
    await afterSignIn(trx, staff, '203.0.113.6', firefox, device);
    const open = await trx.selectFrom('sessions').select(['token_hash', 'end_reason']).where('user_id', '=', staff.id).orderBy('created_at').execute();
    assert.deepEqual(open.map((s) => s.end_reason), ['session_limit', null, null], 'two may stay open: the oldest went');
    const bell = await trx.selectFrom('notifications').select(['user_id', 'kind', 'body']).where('org_id', '=', orgId).execute();
    assert.equal(bell.length, 1);
    assert.equal(bell[0].kind, 'security');
    assert.match(bell[0].body ?? '', /Firefox\/131\.0 on Linux, from 203\.0\.113\.6/);
  });
});

test('print and export: the built-in roles wherever they may see; a custom role exactly as ticked, old ones as before', () => {
  assert.equal(hasPermission('sales', 'sales', 'print', null), true);
  assert.equal(hasPermission('sales', 'purchases', 'export', null), false, 'what it cannot see, it cannot export');
  assert.equal(hasPermission('viewer', 'reports.financial', 'export', null), true);
  const old: CustomPermissions = { sales: ['view', 'create'] };
  assert.equal(hasPermission('staff', 'sales', 'print', old), true, 'saved before the change: seeing is printing');
  const now: CustomPermissions = { sales: ['view', 'create', 'export'], output: [] };
  assert.equal(hasPermission('staff', 'sales', 'print', now), false, 'not ticked, not allowed');
  assert.equal(hasPermission('staff', 'sales', 'export', now), true);
});

test('a restricted voucher type: admins, and roles given it by name', async () => {
  await rolledBack(async (trx, orgId) => {
    const id = await saveVoucherType(trx, orgId, { docType: 'INV', code: 'EXP', name: 'Export invoice', prefix: 'EXP', restricted: true });
    await assert.rejects(runAs('accountant', null, () => seriesFor(trx, orgId, 'INV', id)), /Only roles given the Export invoice/);
    assert.equal((await runAs('admin', null, () => seriesFor(trx, orgId, 'INV', id))).prefix, 'EXP');
    assert.equal((await runAs('staff', { sales: ['view', 'create'], 'voucher.EXP': ['create'], output: [] }, () => seriesFor(trx, orgId, 'INV', id))).prefix, 'EXP');
    assert.equal((await seriesFor(trx, orgId, 'INV', id)).prefix, 'EXP', 'outside a request: the scheduler goes ahead');
    await saveVoucherType(trx, orgId, { docType: 'INV', code: 'EXP', name: 'Export invoice', prefix: 'EXP', restricted: false }, id);
    assert.equal((await runAs('accountant', null, () => seriesFor(trx, orgId, 'INV', id))).prefix, 'EXP');
  });
});

test('employee PAN and Aadhaar sealed at rest, shown in clear and masked; consent recorded and withdrawn', async () => {
  const before = process.env.FIELD_ENCRYPTION_KEY;
  process.env.FIELD_ENCRYPTION_KEY = '11'.repeat(32);
  try {
    await rolledBack(async (trx, orgId, branchId) => {
      const id = await createEmployee(trx, orgId, { branchId, code: 'E1', name: 'Esha', dateOfJoining: '2025-01-01', pan: 'abcpe1234f', aadhaarNo: '1234 5678 9012' },
        { basic: 20_000_00, da: 0, hra: 0, special: 0, other: 0 });
      const raw = await trx.selectFrom('employees').select(['pan', 'aadhaar_no']).where('id', '=', id).executeTakeFirstOrThrow();
      assert.ok(raw.pan?.startsWith('enc:v1:') && raw.aadhaar_no?.startsWith('enc:v1:'), 'sealed in the table');
      const [e] = (await listEmployees(trx, orgId, '2026-06-30')) as { pan: string | null; aadhaarMasked?: string | null }[];
      assert.equal(e.pan, 'ABCPE1234F');
      assert.equal(e.aadhaarMasked, 'XXXX XXXX 9012');

      assert.deepEqual((await employeesWithoutConsent(trx, orgId)).map((m) => m.name), ['Esha']);
      const c = await recordConsent(trx, orgId, null, { subjectType: 'employee', subjectId: id, purpose: 'payroll', givenBy: 'Signed form' });
      await assert.rejects(recordConsent(trx, orgId, null, { subjectType: 'employee', subjectId: id, purpose: 'payroll' }), /already recorded/);
      assert.deepEqual(await employeesWithoutConsent(trx, orgId), []);
      await withdrawConsent(trx, orgId, c);
      await assert.rejects(withdrawConsent(trx, orgId, c), /no consent standing/);
      const list = await listConsents(trx, orgId, 'employee', id);
      assert.equal(list.length, 1);
      assert.ok(list[0].withdrawnAt, 'the record of it stays');
      assert.deepEqual((await employeesWithoutConsent(trx, orgId)).map((m) => m.name), ['Esha']);
    });
  } finally {
    if (before === undefined) delete process.env.FIELD_ENCRYPTION_KEY;
    else process.env.FIELD_ENCRYPTION_KEY = before;
  }
});

test.after(async () => {
  await db.destroy();
});
