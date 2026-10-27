// Custom roles and report-level rights; adding, changing and resetting users.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/custom-roles.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../../lib/server/db';
import { hasPermission, matrixOf, setCustomPermissionSource } from '../../lib/rbac';
import { reportModule } from '../../lib/report-groups';
import { passwordProblems } from '../../lib/server/auth/password';
import {
  addUser, deleteCustomRole, listUsers, resetPassword, saveCustomRole, temporaryPassword, updateUser,
} from '../../lib/server/services/users';

test('a custom role replaces the matrix; naming a report group narrows reports to it', () => {
  const clerk = { sales: ['view', 'create'] as const, 'reports.sales': ['view'] as const };
  const c = clerk as unknown as Record<string, ('view' | 'create')[]>;
  assert.equal(hasPermission('staff', 'sales', 'create', c), true);
  assert.equal(hasPermission('staff', 'purchases', 'view', c), false, 'staff could; this role cannot');
  assert.equal(hasPermission('staff', reportModule('sales-by-customer'), 'view', c), true);
  assert.equal(hasPermission('staff', reportModule('profit-and-loss'), 'view', c), false);
  assert.equal(hasPermission('staff', 'reports', 'view', c), true, 'the reports area opens if any group does');
  assert.equal(hasPermission('staff', 'reports.financial', 'view', { reports: ['view'] }), true, 'reports as a whole grants every group');
  assert.equal(hasPermission('admin', 'settings', 'edit', c), true, 'an admin is never narrowed');
  assert.equal(hasPermission('viewer', 'reports.financial', 'view', null), true, 'built-in roles fall back to reports');
  assert.equal(hasPermission('staff', 'reports.financial', 'view', null), false);
  assert.deepEqual(matrixOf('sales')['reports.sales'], ['view', 'print', 'export'], 'built-in roles print and export what they see');

  setCustomPermissionSource(() => c);
  try {
    assert.equal(hasPermission('staff', 'purchases', 'view'), false, 'the ambient role applies when none is passed');
  } finally {
    setCustomPermissionSource(() => undefined);
  }
});

test('users: a temporary password, one account per email, the last admin kept, custom roles carry their base', async () => {
  assert.deepEqual(passwordProblems(temporaryPassword()), []);
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Roles Co' }).executeTakeFirstOrThrow()).insertId);
      const admin = Number((await trx.insertInto('users').values({ org_id: orgId, name: 'Owner', email: `owner-${orgId}@example.test`, role: 'admin' }).executeTakeFirstOrThrow()).insertId);

      const roleId = await saveCustomRole(trx, orgId, {
        name: 'Billing clerk', baseRole: 'sales',
        permissions: { sales: ['create'], 'reports.sales': ['view'], nonsense: ['view'] } as never,
      });
      const clerk = await addUser(trx, orgId, { name: 'Ravi', email: `RAVI-${orgId}@Example.test`, role: 'staff', customRoleId: roleId });
      await assert.rejects(addUser(trx, orgId, { name: 'Again', email: `ravi-${orgId}@example.test`, role: 'viewer' }), /already has an account/);
      const users = await listUsers(trx, orgId);
      const ravi = users.find((u) => u.id === String(clerk.id))!;
      assert.deepEqual([ravi.role, ravi.customRoleName], ['sales', 'Billing clerk'], 'the role takes the custom role\'s base');
      const stored = await trx.selectFrom('custom_roles').select('permissions').where('id', '=', roleId).executeTakeFirstOrThrow();
      assert.deepEqual(typeof stored.permissions === 'string' ? JSON.parse(stored.permissions) : stored.permissions,
        { sales: ['view', 'create'], 'reports.sales': ['view'], output: [] }, 'unknown parts dropped; creating needs viewing; printing and exporting exactly as ticked');

      await assert.rejects(deleteCustomRole(trx, orgId, roleId), /Move them/);
      await assert.rejects(updateUser(trx, orgId, admin, { role: 'accountant' }), /only active admin/);
      await assert.rejects(updateUser(trx, orgId, admin, { isActive: false }), /only active admin/);
      await assert.rejects(updateUser(trx, orgId, clerk.id, { role: 'admin', customRoleId: roleId }), /custom role would only narrow/);
      await updateUser(trx, orgId, clerk.id, { role: 'admin', customRoleId: null });
      await updateUser(trx, orgId, admin, { role: 'accountant' });

      await trx.insertInto('sessions').values({ token_hash: 'x'.repeat(64), user_id: clerk.id, org_id: orgId, expires_at: new Date(Date.now() + 3600_000) } as never).execute();
      const fresh = await resetPassword(trx, orgId, clerk.id);
      assert.deepEqual(passwordProblems(fresh), []);
      const s = await trx.selectFrom('sessions').select(['revoked_at', 'end_reason']).where('user_id', '=', clerk.id).executeTakeFirstOrThrow();
      assert.ok(s.revoked_at);
      assert.equal(s.end_reason, 'password_reset');
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
});

test.after(async () => {
  await db.destroy();
});
