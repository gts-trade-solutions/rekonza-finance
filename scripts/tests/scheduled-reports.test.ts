// Scheduled reports: the period a run covers, the workbook, and who is told.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/scheduled-reports.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { db } from '../../lib/server/db';
import { installChartOfAccounts } from '../../lib/server/ledger/chart-of-accounts';
import { DiskStore, setFileStore } from '../../lib/server/files/store';
import { periodRange, readReportFile, runSchedule, saveSchedule } from '../../lib/server/services/report-schedules';
import { listNotifications } from '../../lib/server/services/notifications';
import { saveCustomRole } from '../../lib/server/services/users';

const dir = mkdtempSync(path.join(tmpdir(), 'rekonza-reports-'));
setFileStore(new DiskStore(dir));

test('a run covers the period its day implies', () => {
  assert.deepEqual(periodRange('last_month', '2026-01-15'), { from: '2025-12-01', to: '2025-12-31' });
  assert.deepEqual(periodRange('last_week', '2026-10-28'), { from: '2026-10-19', to: '2026-10-25' }, 'Monday to Sunday before');
  assert.deepEqual(periodRange('last_week', '2026-10-26'), { from: '2026-10-19', to: '2026-10-25' }, 'run on a Monday');
  assert.deepEqual(periodRange('last_quarter', '2026-10-26'), { from: '2026-07-01', to: '2026-09-30' });
  assert.deepEqual(periodRange('last_quarter', '2026-02-10'), { from: '2025-10-01', to: '2025-12-31' });
  assert.deepEqual(periodRange('fy_to_date', '2027-02-10'), { from: '2026-04-01', to: '2027-02-10' });
  assert.deepEqual(periodRange('month_to_date', '2026-10-26'), { from: '2026-10-01', to: '2026-10-26' });
});

test('the workbook is made and kept; only recipients whose role includes the report are told; the next run moves on', async () => {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Reports Co' }).executeTakeFirstOrThrow()).insertId);
      await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1 }).execute();
      await installChartOfAccounts(trx, orgId);
      const admin = Number((await trx.insertInto('users').values({ org_id: orgId, name: 'Owner', email: `o-${orgId}@example.test`, role: 'admin' }).executeTakeFirstOrThrow()).insertId);
      const clerkRole = await saveCustomRole(trx, orgId, { name: 'Sales clerk', baseRole: 'sales', permissions: { sales: ['view'], 'reports.sales': ['view'] } });
      const clerk = Number((await trx.insertInto('users').values({ org_id: orgId, name: 'Clerk', email: `c-${orgId}@example.test`, role: 'sales', custom_role_id: clerkRole }).executeTakeFirstOrThrow()).insertId);

      const id = await saveSchedule(trx, orgId, admin, {
        name: 'Monthly P&L', report: 'profit-and-loss', period: 'last_month', frequency: 'monthly', firstRun: '2026-11-01', recipients: [admin, clerk],
      });
      const run = await runSchedule(trx, orgId, id, '2026-11-01');
      assert.equal(run.recipients, 1, 'the clerk does not see financial statements');
      assert.equal(run.nextRun, '2026-12-01');

      const file = await trx.selectFrom('report_files').selectAll().where('id', '=', run.fileId).executeTakeFirstOrThrow();
      assert.equal(String(file.period_from).slice(0, 10), '2026-10-01');
      assert.equal(String(file.period_to).slice(0, 10), '2026-10-31');
      const read = await readReportFile(trx, orgId, run.fileId);
      assert.equal(read.bytes.subarray(0, 2).toString('latin1'), 'PK', 'an xlsx is a zip');

      assert.equal((await listNotifications(trx, admin)).unread, 1);
      assert.equal((await listNotifications(trx, clerk)).unread, 0);

      // Late: made once for the day, then the next run is after it.
      const late = await runSchedule(trx, orgId, id, '2027-02-15');
      assert.equal(late.nextRun, '2027-03-01');
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
});

test.after(async () => {
  await db.destroy();
  rmSync(dir, { recursive: true, force: true });
});
