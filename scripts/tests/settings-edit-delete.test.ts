// Delete for the lists people make in Settings (services/settings-changes.ts),
// against real MySQL inside rolled-back transactions.
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/settings-edit-delete.test.ts
//
// What has to hold: a record nobody used goes; one in use is refused with the
// way out (switch the user off, mark the field, tag, division or voucher type
// inactive); you cannot delete yourself or the last admin.

import test from 'node:test';
import assert from 'node:assert/strict';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { postEntry } from '../../lib/server/ledger/posting';
import { addUser } from '../../lib/server/services/users';
import { saveField } from '../../lib/server/services/custom-fields';
import { saveTag } from '../../lib/server/services/reporting-tags';
import { saveCostCentre } from '../../lib/server/services/cost-centres';
import { saveVoucherType } from '../../lib/server/services/voucher-types';
import { saveRule } from '../../lib/server/services/workflows';
import { logAudit } from '../../lib/server/audit';
import { closeRequest, deleteBreach, deleteRequest, logBreach, logRequest, markBreach, updateBreach, updateRequest } from '../../lib/server/services/privacy';
import {
  deleteCostCentre, deleteCustomField, deleteReportingTag, deleteUser, deleteVoucherType, deleteWorkflowRule,
} from '../../lib/server/services/settings-changes';

interface Fixture { trx: Trx; orgId: number; branchId: number; admin: number }

async function withFixture(fn: (f: Fixture) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Settings Changes Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1 }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const admin = (await addUser(trx, orgId, { name: 'Owner', email: `owner-${orgId}@example.test`, role: 'admin' })).id;
      await fn({ trx, orgId, branchId, admin });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

test.after(() => db.destroy());

test('users: never yourself or the last admin; one who made entries is switched off instead; an unused one goes', async () => {
  await withFixture(async (f) => {
    await assert.rejects(deleteUser(f.trx, f.orgId, f.admin, f.admin), /cannot delete yourself/);
    const second = (await addUser(f.trx, f.orgId, { name: 'Second admin', email: `second-${f.orgId}@example.test`, role: 'admin' })).id;
    // Deleting the owner as the second admin would leave the second as the only admin: allowed.
    const clerk = (await addUser(f.trx, f.orgId, { name: 'Clerk', email: `clerk-${f.orgId}@example.test`, role: 'staff' })).id;
    await logAudit({ trx: f.trx, orgId: f.orgId, actorUserId: clerk, actorName: 'Clerk', action: 'login', targetType: 'user', targetId: clerk });
    await deleteUser(f.trx, f.orgId, f.admin, clerk);
    assert.equal(await f.trx.selectFrom('users').select('id').where('id', '=', clerk).executeTakeFirst(), undefined, 'signing in is not an entry');

    const busy = (await addUser(f.trx, f.orgId, { name: 'Busy', email: `busy-${f.orgId}@example.test`, role: 'accountant' })).id;
    await logAudit({ trx: f.trx, orgId: f.orgId, actorUserId: busy, actorName: 'Busy', action: 'create', targetType: 'invoice', targetId: 1 });
    await assert.rejects(deleteUser(f.trx, f.orgId, f.admin, busy), /Switch them off instead/);

    await f.trx.updateTable('users').set({ is_active: 0 }).where('id', '=', f.admin).execute();
    await assert.rejects(deleteUser(f.trx, f.orgId, busy, second), /only active admin/);
  });
});

test('custom fields, reporting tags, divisions, voucher types and workflow rules: gone when unused, refused when used', async () => {
  await withFixture(async (f) => {
    const used = await saveField(f.trx, f.orgId, { entity: 'invoice', label: 'Vehicle number', type: 'text' });
    const spare = await saveField(f.trx, f.orgId, { entity: 'invoice', label: 'Spare', type: 'text' });
    await f.trx.insertInto('custom_field_values').values({ org_id: f.orgId, field_id: used, entity_id: 1, value: 'TN01' }).execute();
    await assert.rejects(deleteCustomField(f.trx, f.orgId, used), /Mark it as inactive/);
    await deleteCustomField(f.trx, f.orgId, spare);

    const region = await saveTag(f.trx, f.orgId, { name: 'Region', values: ['North', 'South'] });
    const channel = await saveTag(f.trx, f.orgId, { name: 'Channel', values: ['Online'] });
    const north = await f.trx.selectFrom('reporting_tag_options').select('id').where('tag_id', '=', region).where('value', '=', 'North').executeTakeFirstOrThrow();
    await f.trx.insertInto('reporting_tag_links').values({ org_id: f.orgId, tag_id: region, option_id: north.id, entity: 'invoice', entity_id: 1 }).execute();
    await assert.rejects(deleteReportingTag(f.trx, f.orgId, region), /Mark it as inactive/);
    await deleteReportingTag(f.trx, f.orgId, channel);
    assert.equal((await f.trx.selectFrom('reporting_tag_options').select('id').where('tag_id', '=', channel).execute()).length, 0, 'its values go with it');

    const service = await saveCostCentre(f.trx, f.orgId, { code: 'SVC', name: 'Service', category: 'Division' });
    const spares = await saveCostCentre(f.trx, f.orgId, { code: 'SPR', name: 'Spares', category: 'Division' });
    const acc = await accountIds(f.trx, f.orgId);
    await postEntry(f.trx, {
      orgId: f.orgId, branchId: f.branchId, date: '2026-06-01', memo: 'Service wages', sourceType: 'manual', userId: null,
      lines: [{ accountId: acc[CODE.SALARIES], debit: 1_000_00, costCentreId: service }, { accountId: acc[CODE.BANK_DEFAULT], credit: 1_000_00 }],
    });
    await assert.rejects(deleteCostCentre(f.trx, f.orgId, service), /Mark it as inactive/);
    await deleteCostCentre(f.trx, f.orgId, spares);

    const vt = await saveVoucherType(f.trx, f.orgId, { docType: 'INV', code: 'EXP', name: 'Export invoice', prefix: 'EXP' });
    await deleteVoucherType(f.trx, f.orgId, vt);
    const vt2 = await saveVoucherType(f.trx, f.orgId, { docType: 'INV', code: 'SRV', name: 'Service invoice', prefix: 'SRV' });
    await f.trx.insertInto('number_series').values({ org_id: f.orgId, branch_id: f.branchId, doc_type: 'INV:SRV', fy_label: '26-27', prefix: 'SRV', next_number: 4 }).execute();
    await assert.rejects(deleteVoucherType(f.trx, f.orgId, vt2), /series has to stay unbroken/);

    const rule = await saveRule(f.trx, f.orgId, { name: 'Big invoices', event: 'invoice.created', conditions: [], actions: [{ type: 'notify', to: 'admins' }] });
    await f.trx.insertInto('workflow_runs').values({ org_id: f.orgId, rule_id: rule, event: 'invoice.created', target_type: 'invoice', target_id: 1 }).execute();
    await deleteWorkflowRule(f.trx, f.orgId, rule);
    assert.equal((await f.trx.selectFrom('workflow_runs').select('id').where('rule_id', '=', rule).execute()).length, 0);
  });
});

test('privacy: an open request and an untold breach can be corrected or deleted; a closed one, or one the Board knows of, stays', async () => {
  await withFixture(async (f) => {
    const r = await logRequest(f.trx, f.orgId, f.admin, { subjectType: 'other', subjectName: 'Walk-in', kind: 'access', receivedOn: '2026-11-01' });
    await updateRequest(f.trx, f.orgId, r.id, { subjectName: 'Walk-in customer', kind: 'correction', receivedOn: '2026-11-02' });
    const row = await f.trx.selectFrom('privacy_requests').select(['subject_name', 'kind', 'due_on']).where('id', '=', r.id).executeTakeFirstOrThrow();
    assert.deepEqual([row.subject_name, row.kind], ['Walk-in customer', 'correction']);
    assert.notEqual(String(row.due_on).slice(0, 10), r.dueOn, 'the due date moves with the date received');
    await closeRequest(f.trx, f.orgId, f.admin, r.id, { status: 'done', response: 'Corrected the address' });
    await assert.rejects(deleteRequest(f.trx, f.orgId, r.id), /closed/);
    const open = await logRequest(f.trx, f.orgId, f.admin, { subjectType: 'other', subjectName: 'Duplicate', kind: 'access', receivedOn: '2026-11-03' });
    await deleteRequest(f.trx, f.orgId, open.id);

    const b = await logBreach(f.trx, f.orgId, f.admin, { discoveredAt: '2026-11-04T10:00:00Z', description: 'Laptop lost' });
    await updateBreach(f.trx, f.orgId, b, { discoveredAt: '2026-11-04T09:00:00Z', description: 'Laptop lost on the train', peopleAffected: 40 });
    await markBreach(f.trx, f.orgId, b, 'board_informed');
    await assert.rejects(updateBreach(f.trx, f.orgId, b, { discoveredAt: '2026-11-05T09:00:00Z', description: 'x' }), /stays as reported/);
    await assert.rejects(deleteBreach(f.trx, f.orgId, b), /record stays/);
    const mistake = await logBreach(f.trx, f.orgId, f.admin, { discoveredAt: '2026-11-04T10:00:00Z', description: 'Logged twice' });
    await deleteBreach(f.trx, f.orgId, mistake);
  });
});
