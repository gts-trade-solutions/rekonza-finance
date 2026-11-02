// Workflow rules: queued with the event's audit row, run against the record,
// done when the conditions hold and skipped when they do not.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/workflows.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../../lib/server/db';
import { installChartOfAccounts } from '../../lib/server/ledger/chart-of-accounts';
import { createInvoice } from '../../lib/server/services/sales';
import { logAudit } from '../../lib/server/audit';
import { meets, runWorkflows, saveRule } from '../../lib/server/services/workflows';

test('a rule on large invoices tells the admins; a small invoice is skipped', async () => {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Rules Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1 }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const admin = Number((await trx.insertInto('users').values({ org_id: orgId, name: 'Owner', email: 'owner@rules.test', password_hash: 'x', role: 'admin' } as never).executeTakeFirstOrThrow()).insertId);
      const customer = Number((await trx.insertInto('contacts').values({ org_id: orgId, kind: 'customer', display_name: 'Big Buyer', state_code: '29', gst_treatment: 'unregistered' } as never).executeTakeFirstOrThrow()).insertId);

      await assert.rejects(saveRule(trx, orgId, { name: 'x', event: 'invoice.created', conditions: [{ field: 'weight', op: 'gt', value: '1' }], actions: [{ type: 'notify', to: 'admins' }] }), /not something a invoice has/);
      await saveRule(trx, orgId, {
        name: 'Large sale', event: 'invoice.created',
        conditions: [{ field: 'total', op: 'gte', value: '100000' }, { field: 'state', op: 'eq', value: '29' }],
        actions: [{ type: 'notify', to: 'admins', message: '{record} for ₹{total}' }],
      });
      const sell = async (rupees: number) => {
        const inv = await createInvoice(trx, orgId, null, { branchId, customerId: customer, date: '2026-10-01', dueDate: '2026-10-01', status: 'approved', lines: [{ description: 'Goods', qty: 1, ratePaise: rupees * 100, gstRatePct: 0 }] });
        await logAudit({ trx, orgId, actorUserId: admin, actorName: 'Owner', action: 'create', targetType: 'invoice', targetId: inv.id, targetLabel: inv.number });
        return inv;
      };
      await sell(1_50_000);
      await sell(5_000);
      assert.equal(await runWorkflows(50, trx), 1, 'one run met its conditions');
      const runs = await trx.selectFrom('workflow_runs').select(['status', 'detail']).where('org_id', '=', orgId).orderBy('id').execute();
      assert.deepEqual(runs.map((r) => r.status), ['done', 'skipped']);
      assert.match(runs[0].detail ?? '', /told 1 person/);
      const n = await trx.selectFrom('notifications').select(['title', 'body', 'user_id']).where('org_id', '=', orgId).execute();
      assert.equal(n.length, 1);
      assert.equal(n[0].user_id, admin);
      assert.match(n[0].body ?? '', /for ₹150000/);
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
});

test('conditions compare numbers as numbers and text without case', () => {
  assert.equal(meets({ total: 500, customer: 'Apex Motors' }, [{ field: 'total', op: 'gt', value: '499.5' }, { field: 'customer', op: 'contains', value: 'apex' }]), true);
  assert.equal(meets({ total: 500 }, [{ field: 'total', op: 'lt', value: '100' }]), false);
  assert.equal(meets({ total: 500 }, [{ field: 'missing', op: 'eq', value: '1' }]), false, 'a field the record lacks never matches');
});

test.after(() => db.destroy());
