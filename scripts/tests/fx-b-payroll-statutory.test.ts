// Payroll statutory and the integration check, as the independent reviewer
// tested them (fixes after status review 7, items 10 and 14):
//
//   * Return Status shows October's PF and ESI paid, with the date, once paid
//     through Payroll → Statutory Reports → Dues & Payments; salary TDS
//     deposits and the 24Q receipt the same;
//   * EPS is off for a 2026 joiner on PF wages above ₹15,000 (EPS 1995, para
//     6A), on for an existing member, and the ECR and challan heads follow;
//   * reopening a posted run adds an employee who joined after it was prepared;
//   * a TDS challan dated after today is refused, and 24Q reports the day the
//     salary was really paid;
//   * the integration check at 28 November reads both sides as posted up to
//     that day: a November run dated 30 November is timing, not a difference;
//   * the TAN hint points to where the TAN field is.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/fx-b-payroll-statutory.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { createEmployee, updateEmployee } from '../../lib/server/payroll/employees';
import { postRun, prepareRun, reopenRun, runDetail } from '../../lib/server/payroll/payroll';
import { payStatutory, statutoryRegister } from '../../lib/server/payroll/statutory-dues';
import { pfReport } from '../../lib/server/payroll/statutory-reports';
import { form24Q, recordSalaryChallan, salaryTdsMonths, setReturnReceipt } from '../../lib/server/payroll/salary-tds';
import { paySalaries } from '../../lib/server/payroll/salary-payments';
import { setTodayForTests } from '../../lib/server/payroll/paid-dates';
import { complianceCalendar, ptDueDate } from '../../lib/server/tax/compliance-calendar';
import { payrollVsLedger } from '../../lib/server/services/integration-check';
import { epsEligible } from '../../lib/payroll/statutory';

const R = (rupees: number) => Math.round(rupees * 100);

interface Fixture { trx: Trx; orgId: number; branchId: number; bankId: number; emp: (code: string, doj: string, basic: number, extra?: Record<string, unknown>) => Promise<number> }

async function withFixture(fn: (f: Fixture) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Payroll Fix Co Pvt Ltd' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'Chennai', state_code: '33', is_primary: 1 }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const acc = await accountIds(trx, orgId);
      const bankId = Number((await trx.insertInto('bank_accounts').values({
        org_id: orgId, kind: 'bank', name: 'Salary account', ledger_account_id: acc[CODE.BANK_DEFAULT], opening_balance: '0.0000', account_number: '50200099887766',
      }).executeTakeFirstOrThrow()).insertId);
      let n = 0;
      const emp = (code: string, doj: string, basic: number, extra: Record<string, unknown> = {}) => createEmployee(trx, orgId, {
        branchId, code, name: `Employee ${code}`, dateOfJoining: doj, uan: `10090000${String(++n).padStart(4, '0')}`, pan: `ABCDE${1000 + n}F`, gender: 'male', ...extra,
      }, { basic: R(basic), da: 0, hra: R(basic * 0.4), special: R(basic * 0.6), other: 0 });
      await fn({ trx, orgId, branchId, bankId, emp });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

test.after(() => db.destroy());

test('EPS para 6A: off for a 2026 joiner above ₹15,000, on for an existing member, and the ECR follows', async () => {
  assert.equal(epsEligible({ dateOfJoining: '2026-06-01', pfWageAtJoining: R(40_000), memberBeforeSep2014: false }), false);
  assert.equal(epsEligible({ dateOfJoining: '2026-06-01', pfWageAtJoining: R(15_000), memberBeforeSep2014: false }), true, '₹15,000 is not above the ceiling');
  assert.equal(epsEligible({ dateOfJoining: '2026-06-01', pfWageAtJoining: R(40_000), memberBeforeSep2014: true }), true);
  assert.equal(epsEligible({ dateOfJoining: '2012-04-01', pfWageAtJoining: R(40_000), memberBeforeSep2014: false }), true);
  await withFixture(async (f) => {
    const e2 = await f.emp('E002', '2026-06-01', 20_000);
    const e3 = await f.emp('E003', '2026-06-01', 20_000, { epsBeforeSep2014: true });
    const e5 = await f.emp('E005', '2026-06-01', 12_000);
    const flag = async (id: number) => !!(await f.trx.selectFrom('employees').select('eps_member').where('id', '=', id).executeTakeFirstOrThrow()).eps_member;
    assert.equal(await flag(e2), false, 'EPS is off by default for a joiner above ₹15,000');
    assert.equal(await flag(e3), true);
    assert.equal(await flag(e5), true);
    // A record saved EPS-on before this fix (as E002 and E004 were): the run still applies the rule.
    await f.trx.updateTable('employees').set({ eps_member: 1 }).where('id', '=', e2).execute();
    const run = await prepareRun(f.trx, f.orgId, null, '2026-10');
    const lines = Object.fromEntries((await runDetail(f.trx, f.orgId, run)).lines.map((l) => [l.code, l]));
    assert.equal(lines.E002.pfEmployerEps, 0);
    assert.equal(lines.E002.pfEmployerEpf, R(1_800), 'the employer\'s whole 12% of ₹15,000 to EPF');
    assert.equal(lines.E002.epsWage, 0);
    assert.equal(lines.E003.pfEmployerEps, R(1_250), 'an existing member: 8.33% of ₹15,000');
    assert.ok(lines.E005.pfEmployerEps > 0);
    await postRun(f.trx, f.orgId, null, run);
    const ecr = (await pfReport(f.trx, f.orgId, '2026-10', '2026-10')).ecr[0].text.split('\n');
    const uan = (await f.trx.selectFrom('employees').select('uan').where('id', '=', e2).executeTakeFirstOrThrow()).uan!;
    const e2Line = ecr.find((l) => l.startsWith(uan))!.split('#~#');
    // UAN, name, gross, EPF wages, EPS wages, EDLI wages, EE, EPS, ER.
    assert.equal(e2Line[4], '0', 'no EPS wages');
    assert.equal(e2Line[7], '0', 'no EPS contribution');
    assert.equal(e2Line[8], '1800', 'the whole employer share to EPF');
    // Saving the employee again (EPS ticked by the form) keeps the rule.
    await updateEmployee(f.trx, f.orgId, e2, { branchId: f.branchId, code: 'E002', name: 'Employee E002', dateOfJoining: '2026-06-01', epsMember: true });
    assert.equal(await flag(e2), false);
  });
});

test('reopening a posted run adds the employee who joined after it was prepared', async () => {
  await withFixture(async (f) => {
    await f.emp('E001', '2025-01-01', 20_000);
    const run = await prepareRun(f.trx, f.orgId, null, '2026-11');
    await postRun(f.trx, f.orgId, null, run);
    await f.emp('E006', '2026-11-10', 18_000);
    const { added } = await reopenRun(f.trx, f.orgId, null, run, 'E006 joined on 10 November');
    assert.deepEqual(added, ['Employee E006 (E006)']);
    const d = await runDetail(f.trx, f.orgId, run);
    assert.deepEqual(d.lines.map((l) => l.code), ['E001', 'E006']);
    assert.equal(d.lines.find((l) => l.code === 'E006')!.paidDays, 21, 'from joining, 10 to 30 November');
    assert.deepEqual(d.missingEmployees, []);
    // One added to a draft later shows as missing, for the "Add new employees" button.
    await f.emp('E007', '2026-11-20', 18_000);
    assert.deepEqual((await runDetail(f.trx, f.orgId, run)).missingEmployees.map((m) => m.code), ['E007']);
  });
});

test('Return Status reads Payroll\'s payments: October PF and ESI paid on 14 November show paid, with the date', async () => {
  await withFixture(async (f) => {
    await f.emp('E001', '2025-01-01', 10_000); // covered by ESI too
    await f.emp('E004', '2025-01-01', 2_00_000, { taxRegime: 'new' });
    const run = await prepareRun(f.trx, f.orgId, null, '2026-10');
    await postRun(f.trx, f.orgId, null, run);
    const before = await complianceCalendar(f.trx, f.orgId, '2026-11-01', '2026-11-30', '2026-11-28');
    const row = (cal: typeof before, key: string, period: string) => cal.rows.find((r) => r.key === key && r.period === period);
    assert.equal(row(before, 'pf', '2026-10')?.status, 'overdue');
    assert.equal(row(before, 'esi', '2026-10')?.status, 'overdue');
    const { dues } = await statutoryRegister(f.trx, f.orgId, '2026-10', '2026-10');
    for (const d of dues.filter((x) => x.component === 'pf' || x.component === 'esi')) {
      await payStatutory(f.trx, f.orgId, null, { component: d.component, period: '2026-10', amountPaise: d.balancePaise, date: '2026-11-14', bankAccountId: f.bankId, reference: `${d.component.toUpperCase()}-OCT` });
    }
    const tds = (await salaryTdsMonths(f.trx, f.orgId, ['2026-10']))[0];
    assert.ok(tds.deductedPaise > 0);
    await recordSalaryChallan(f.trx, f.orgId, null, { forMonth: '2026-10', date: '2026-11-06', bsrCode: '0510308', serial: '11', taxPaise: tds.deductedPaise, bankAccountId: f.bankId });
    const after = await complianceCalendar(f.trx, f.orgId, '2026-11-01', '2026-11-30', '2026-11-28');
    for (const key of ['pf', 'esi']) {
      const r = row(after, key, '2026-10')!;
      assert.equal(r.status, 'done', `${key} for October is paid`);
      assert.equal(r.done?.on, '2026-11-14');
      assert.equal(r.done?.by, 'Payroll → Statutory Reports');
      assert.equal(r.paid?.paidPaise, r.paid?.duePaise);
    }
    const dep = row(after, 'salary-tds-deposit', '2026-10')!;
    assert.equal(dep.status, 'done');
    assert.equal(dep.done?.on, '2026-11-06');
    assert.equal(dep.done?.reference, '0510308/11');
    // PT deducted in October is a row of its own (Tamil Nadu: the state's date to confirm), not yet paid.
    const pt = row(await complianceCalendar(f.trx, f.orgId, '2026-11-01', '2026-12-31', '2026-11-28'), 'pt', '2026-10');
    assert.ok(pt && pt.status !== 'done');
    assert.equal(ptDueDate('29', '2026-10').date, '2026-11-20', 'Karnataka: the 20th of the next month');
    // The 24Q for the quarter, filed with its receipt number.
    await setReturnReceipt(f.trx, f.orgId, null, 2026, 2, 'QWERTYUI1234567', '2026-10-30');
    const q = row(await complianceCalendar(f.trx, f.orgId, '2026-10-01', '2026-10-31', '2026-11-28'), 'salary-tds-return', '2026-Q2');
    assert.equal(q?.status, 'done');
    assert.equal(q?.done?.reference, 'QWERTYUI1234567');
  });
});

test('a challan dated after today is refused; 24Q reports the day salary was really paid', async (t) => {
  t.after(() => setTodayForTests(null));
  await withFixture(async (f) => {
    await f.emp('E004', '2025-01-01', 2_00_000);
    const run = await prepareRun(f.trx, f.orgId, null, '2026-10');
    await postRun(f.trx, f.orgId, null, run);
    const tds = (await salaryTdsMonths(f.trx, f.orgId, ['2026-10']))[0];
    setTodayForTests('2026-11-28');
    await assert.rejects(
      recordSalaryChallan(f.trx, f.orgId, null, { forMonth: '2026-10', date: '2026-12-05', bsrCode: '0510308', serial: '12', taxPaise: tds.deductedPaise, bankAccountId: f.bankId }),
      /dated 2026-12-05, after today \(2026-11-28\)/,
    );
    await recordSalaryChallan(f.trx, f.orgId, null, { forMonth: '2026-10', date: '2026-11-05', bsrCode: '0510308', serial: '12', taxPaise: tds.deductedPaise, bankAccountId: f.bankId });
    let q = await form24Q(f.trx, f.orgId, 2026, 3);
    assert.equal(q.challans[0].deductees[0].paymentDate, null, 'not paid yet: no made-up month-end date');
    assert.ok(q.issues.some((i) => /no salary payment recorded/.test(i.message)));
    await paySalaries(f.trx, f.orgId, null, run, { bankAccountId: f.bankId, date: '2026-11-02', employeeIds: null });
    q = await form24Q(f.trx, f.orgId, 2026, 3);
    assert.equal(q.challans[0].deductees[0].paymentDate, '2026-11-02');
    assert.equal(q.challans[0].deductees[0].deductedOn, '2026-11-02');
    // The TAN is in Settings → Profile; the hint says so.
    await f.trx.updateTable('organizations').set({ tan: null }).where('id', '=', f.orgId).execute();
    const msg = (await form24Q(f.trx, f.orgId, 2026, 3)).issues.find((i) => /no TAN/.test(i.message))!.message;
    assert.match(msg, /Settings → Profile/);
    assert.doesNotMatch(msg, /Settings → Statutory/);
  });
});

test('integration check at 28 November: the November run (dated 30 November) is timing, not a difference', async (t) => {
  t.after(() => setTodayForTests(null));
  await withFixture(async (f) => {
    await f.emp('E001', '2025-01-01', 10_000);
    await f.emp('E004', '2025-01-01', 2_00_000);
    for (const m of ['2026-10', '2026-11']) await postRun(f.trx, f.orgId, null, await prepareRun(f.trx, f.orgId, null, m));
    const oct = (await f.trx.selectFrom('payroll_runs').select('id').where('org_id', '=', f.orgId).where('month', '=', '2026-10').executeTakeFirstOrThrow()).id;
    await paySalaries(f.trx, f.orgId, null, oct, { bankAccountId: f.bankId, date: '2026-11-01', employeeIds: null });
    const { dues } = await statutoryRegister(f.trx, f.orgId, '2026-10', '2026-10');
    for (const d of dues) await payStatutory(f.trx, f.orgId, null, { component: d.component, period: '2026-10', amountPaise: d.balancePaise, date: '2026-11-14', bankAccountId: f.bankId });
    // November's TDS deposited on 5 December (recorded as of that day).
    setTodayForTests('2026-12-05');
    const nov = (await salaryTdsMonths(f.trx, f.orgId, ['2026-11']))[0];
    await recordSalaryChallan(f.trx, f.orgId, null, { forMonth: '2026-11', date: '2026-12-05', bsrCode: '0510308', serial: '13', taxPaise: nov.deductedPaise, bankAccountId: f.bankId });

    const at28 = await payrollVsLedger(f.trx, f.orgId, '2026-04-01', '2026-11-28');
    assert.ok(at28.ok, JSON.stringify(at28.liabilities.filter((l) => !l.ok)));
    assert.equal(at28.postedThrough, '2026-10-31');
    assert.ok(at28.timing.some((x) => x.kind === 'run' && x.date === '2026-11-30'), 'the November run is listed with its date');
    assert.ok(at28.timing.some((x) => x.kind === 'tds_challan' && x.date === '2026-12-05'));
    const tdsLine = at28.liabilities.find((l) => l.code === CODE.TDS_PAYABLE)!;
    assert.equal(tdsLine.ledgerPaise, tdsLine.subledgerPaise);

    const at30 = await payrollVsLedger(f.trx, f.orgId, '2026-04-01', '2026-11-30');
    assert.ok(at30.ok);
    assert.equal(at30.postedThrough, '2026-11-30');
    assert.ok(at30.liabilities.find((l) => l.code === CODE.SALARIES_PAYABLE)!.ledgerPaise > 0, 'November net pay owed at 30 November');
    const at31Dec = await payrollVsLedger(f.trx, f.orgId, '2026-04-01', '2026-12-31');
    assert.ok(at31Dec.ok);
    assert.equal(at31Dec.timing.length, 0);
  });
});
