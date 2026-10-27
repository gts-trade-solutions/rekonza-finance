// Leave (accrual, balances, unpaid days in the payroll, lapse) and the full and final settlement.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/leave-fnf.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../../lib/server/db';
import { installChartOfAccounts } from '../../lib/server/ledger/chart-of-accounts';
import { verifyLedgerBalances } from '../../lib/server/ledger/posting';
import { createEmployee } from '../../lib/server/payroll/employees';
import { prepareRun } from '../../lib/server/payroll/payroll';
import { accrueLeave, grantLeave, leaveBalances, listLeaveTypes, recordLeave } from '../../lib/server/payroll/leave';
import { fnfStatement, gratuityYears, postFnf } from '../../lib/server/payroll/fnf';

const R = (rupees: number) => rupees * 100;

test('gratuity years: completed years, and a last part-year of more than six months counts', () => {
  assert.deepEqual(gratuityYears('2019-01-10', '2026-07-09'), { completed: 7, counted: 7 }, 'six months less a day');
  assert.deepEqual(gratuityYears('2019-01-10', '2026-07-11'), { completed: 7, counted: 8 }, 'just over six months');
  assert.deepEqual(gratuityYears('2022-05-01', '2026-04-30'), { completed: 3, counted: 4 });
});

test('leave accrues with the payroll, cannot be overdrawn, lapses over the limit, and unpaid leave is the month\'s unpaid days; F&F settles it', async () => {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Leave Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1 }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const types = await listLeaveTypes(trx, orgId);
      const t = (code: string) => Number(types.find((x) => x.code === code)!.id);
      const emp = await createEmployee(trx, orgId, { branchId, code: 'E1', name: 'Kavya', dateOfJoining: '2019-01-10' },
        { basic: R(26_000), da: R(0), hra: R(10_000), special: R(4_000), other: 0, effectiveFrom: '2019-01-10' });

      // April: EL accrues 1.25, CL and SL their year at once.
      await accrueLeave(trx, orgId, '2026-04');
      await accrueLeave(trx, orgId, '2026-04');
      let bal = (await leaveBalances(trx, orgId, '2026-04-30')).get(emp)!;
      assert.deepEqual([bal.get(t('EL')), bal.get(t('CL')), bal.get(t('SL'))], [1.25, 12, 12], 'once each, however often run');

      await assert.rejects(recordLeave(trx, orgId, null, { employeeId: emp, leaveTypeId: t('EL'), from: '2026-05-04', to: '2026-05-06' }), /1\.25 day\(s\) of earned leave left/);
      await recordLeave(trx, orgId, null, { employeeId: emp, leaveTypeId: t('CL'), from: '2026-05-04', to: '2026-05-05' });
      await assert.rejects(recordLeave(trx, orgId, null, { employeeId: emp, leaveTypeId: t('SL'), from: '2026-05-05', to: '2026-05-05' }), /already has leave/);
      await recordLeave(trx, orgId, null, { employeeId: emp, leaveTypeId: t('LOP'), from: '2026-05-29', to: '2026-06-02' });

      const runId = await prepareRun(trx, orgId, null, '2026-05');
      const line = await trx.selectFrom('payroll_lines').select(['lop_days', 'paid_days']).where('run_id', '=', runId).where('employee_id', '=', emp).executeTakeFirstOrThrow();
      assert.deepEqual([Number(line.lop_days), Number(line.paid_days)], [3, 28], 'three of the five unpaid days fall in May');

      // The next April lapses EL over 45.
      await grantLeave(trx, orgId, null, { employeeId: emp, leaveTypeId: t('EL'), kind: 'adjustment', days: 50, date: '2027-03-01' });
      await accrueLeave(trx, orgId, '2027-04');
      bal = (await leaveBalances(trx, orgId, '2027-04-30')).get(emp)!;
      assert.equal(bal.get(t('EL')), 46.25, '45 carried, plus April\'s 1.25');

      const s = await fnfStatement(trx, orgId, { employeeId: emp, lastDay: '2027-04-30', noticeShortDays: 10, tdsPaise: R(1_000) });
      assert.deepEqual(s.years, { completed: 8, counted: 8 });
      assert.equal(s.gratuityPaise, Math.round((R(26_000) * 15 * 8) / 26), '15/26 × basic × 8');
      assert.equal(s.encashDays, 46.25);
      assert.equal(s.encashmentPaise, Math.round((R(26_000) * 46.25) / 26));
      assert.equal(s.noticeRecoveryPaise, Math.round((R(40_000) / 30) * 10));
      assert.equal(s.netPaise, s.gratuityPaise + s.encashmentPaise - s.noticeRecoveryPaise - R(1_000));

      await postFnf(trx, orgId, null, { employeeId: emp, lastDay: '2027-04-30', noticeShortDays: 10, tdsPaise: R(1_000) });
      assert.equal(String((await trx.selectFrom('employees').select('date_of_leaving').where('id', '=', emp).executeTakeFirstOrThrow()).date_of_leaving).slice(0, 10), '2027-04-30');
      assert.equal((await leaveBalances(trx, orgId, '2027-04-30')).get(emp)!.get(t('EL')), 0, 'encashed');
      await assert.rejects(postFnf(trx, orgId, null, { employeeId: emp, lastDay: '2027-04-30' }), /already has a settlement/);
      assert.ok((await verifyLedgerBalances(trx, orgId)).balanced);

      const young = await createEmployee(trx, orgId, { branchId, code: 'E2', name: 'Ravi', dateOfJoining: '2024-01-01' },
        { basic: R(20_000), da: 0, hra: 0, special: 0, other: 0, effectiveFrom: '2024-01-01' });
      assert.equal((await fnfStatement(trx, orgId, { employeeId: young, lastDay: '2027-04-30' })).gratuityPaise, 0, 'under five years');
      assert.ok((await fnfStatement(trx, orgId, { employeeId: young, lastDay: '2027-04-30', waiveFiveYears: true })).gratuityPaise > 0, 'unless on death or disablement');
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
});

test.after(async () => {
  await db.destroy();
});
