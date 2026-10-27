// Payroll: the statutory rules to the rupee, and a month run end to end.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/payroll.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { toPaiseFromSql } from '../../lib/server/money-sql';
import {
  annualTax, esi, labourWelfare, monthlyTds, monthsLeftInFy, pf, professionalTax,
} from '../../lib/payroll/statutory';
import { createEmployee, setSalary } from '../../lib/server/payroll/employees';
import { payRun, postRun, prepareRun, reopenRun, runDetail, salaryTdsQuarter } from '../../lib/server/payroll/payroll';
import { bankTransfers, ecr, esiContributions } from '../../lib/payroll/files';

const R = (rupees: number) => Math.round(rupees * 100);

test('provident fund: the ₹15,000 ceiling, the pension split, and contributing on actual', () => {
  assert.deepEqual(pf({ pfWage: R(20_000), member: true, epsMember: true, onActual: false }), {
    pfWage: R(20_000), contributionWage: R(15_000), epsWage: R(15_000),
    employee: R(1_800), employerEpf: R(550), employerEps: R(1_250), admin: R(75), edli: R(75),
  });
  const actual = pf({ pfWage: R(20_000), member: true, epsMember: true, onActual: true });
  assert.equal(actual.employee, R(2_400));
  assert.equal(actual.employerEps, R(1_250), 'pension is never on more than the ceiling');
  assert.equal(actual.employerEpf, R(1_150));
  assert.equal(pf({ pfWage: R(20_000), member: true, epsMember: false, onActual: false }).employerEpf, R(1_800), 'no pension: all of it to EPF');
  assert.equal(pf({ pfWage: R(20_000), member: false, epsMember: true, onActual: false }).employee, 0);
});

test('ESI: the ceiling, coverage for the period, rounding up, and the low-wage waiver', () => {
  assert.deepEqual(esi({ esiWage: R(18_000), rateWage: R(18_000), paidDays: 30, disabled: false, coveredThisPeriod: false }), { covered: true, employee: R(135), employer: R(585) });
  assert.equal(esi({ esiWage: R(25_000), rateWage: R(25_000), paidDays: 30, disabled: false, coveredThisPeriod: false }).covered, false);
  assert.deepEqual(esi({ esiWage: R(25_000), rateWage: R(25_000), paidDays: 30, disabled: false, coveredThisPeriod: true }), { covered: true, employee: R(188), employer: R(813) });
  assert.equal(esi({ esiWage: R(24_000), rateWage: R(24_000), paidDays: 30, disabled: true, coveredThisPeriod: false }).covered, true, '₹25,000 for a person with a disability');
  assert.deepEqual(esi({ esiWage: R(4_000), rateWage: R(4_000), paidDays: 30, disabled: false, coveredThisPeriod: false }), { covered: true, employee: 0, employer: R(130) });
});

test('professional tax and labour welfare, by state', () => {
  assert.equal(professionalTax({ stateCode: '27', month: '2026-06', gross: R(12_000), gender: 'male' }), R(200));
  assert.equal(professionalTax({ stateCode: '27', month: '2027-02', gross: R(12_000), gender: 'male' }), R(300), 'February makes up the year');
  assert.equal(professionalTax({ stateCode: '27', month: '2026-06', gross: R(20_000), gender: 'female' }), 0);
  assert.equal(professionalTax({ stateCode: '29', month: '2026-06', gross: R(30_000), gender: null }), R(200));
  assert.equal(professionalTax({ stateCode: '29', month: '2026-06', gross: R(24_000), gender: null }), 0);
  assert.equal(professionalTax({ stateCode: '33', month: '2026-06', gross: R(25_000), gender: null }), R(208), 'half-yearly, a sixth a month');
  assert.equal(professionalTax({ stateCode: '19', month: '2026-06', gross: R(30_000), gender: null }), R(150));
  assert.equal(professionalTax({ stateCode: '07', month: '2026-06', gross: R(90_000), gender: null }), 0, 'Delhi levies none');
  assert.deepEqual(labourWelfare('27', '2026-06'), { employee: R(25), employer: R(75) });
  assert.deepEqual(labourWelfare('27', '2026-07'), { employee: 0, employer: 0 });
});

test('income tax on salary: both regimes, the rebate and its marginal relief', () => {
  assert.equal(annualTax({ regime: 'new', grossSalary: R(12_75_000) }).tax, 0, 'up to ₹12 lakh taxable, nothing');
  assert.equal(annualTax({ regime: 'new', grossSalary: R(12_85_000) }).tax, R(10_400), 'marginal relief just above it');
  assert.equal(annualTax({ regime: 'new', grossSalary: R(13_75_000) }).tax, R(78_000));
  assert.equal(annualTax({ regime: 'old', grossSalary: R(10_00_000), deductions: R(1_50_000) }).tax, R(75_400));
  assert.equal(monthlyTds({ annualTax: R(78_000), deductedSoFar: 0, monthsLeft: 12 }), R(6_500));
  assert.equal(monthlyTds({ annualTax: R(78_000), deductedSoFar: R(80_000), monthsLeft: 3 }), 0, 'never negative');
  assert.deepEqual(['2026-04', '2026-06', '2027-01', '2027-03'].map(monthsLeftInFy), [12, 10, 3, 1]);
});

interface Fixture { trx: Trx; orgId: number; branchId: number; bankId: number; acc: Record<string, number>; ids: Record<string, number> }

async function withFixture(fn: (f: Fixture) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Pune Works' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'Pune', state_code: '27', is_primary: 1 }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const acc = await accountIds(trx, orgId);
      const bankId = Number((await trx.insertInto('bank_accounts').values({
        org_id: orgId, kind: 'bank', name: 'Salary account', ledger_account_id: acc[CODE.BANK_DEFAULT], opening_balance: '0.0000',
      }).executeTakeFirstOrThrow()).insertId);
      const emp = (code: string, joined: string, s: { basic: number; hra?: number; special?: number }) => createEmployee(trx, orgId, {
        branchId, code, name: `Employee ${code}`, dateOfJoining: joined,
      }, { basic: R(s.basic), da: 0, hra: R(s.hra ?? 0), special: R(s.special ?? 0), other: 0 });
      const ids = {
        a: await emp('A', '2025-01-01', { basic: 20_000, hra: 8_000, special: 7_000 }),
        b: await emp('B', '2025-01-01', { basic: 10_000, hra: 4_000, special: 2_000 }),
        c: await emp('C', '2026-06-16', { basic: 12_000, hra: 3_000 }),
        d: await emp('D', '2025-01-01', { basic: 1_00_000, hra: 40_000, special: 60_000 }),
      };
      await fn({ trx, orgId, branchId, bankId, acc, ids });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

const balance = async (f: Fixture, code: string) => toPaiseFromSql((await sql<{ b: string }>`
  SELECT COALESCE(SUM(debit - credit), 0) AS b FROM journal_lines WHERE account_id = ${f.acc[code]}
`.execute(f.trx)).rows[0].b);

test('a month: proration, loss of pay, every deduction, posting and paying', async () => {
  await withFixture(async (f) => {
    const runId = await prepareRun(f.trx, f.orgId, null, '2026-06', { [f.ids.b]: { lopDays: 3 } });
    const run = await runDetail(f.trx, f.orgId, runId);
    const line = (code: string) => run.lines.find((l) => l.code === code)!;

    const a = line('A');
    assert.equal(a.gross, R(35_000));
    assert.deepEqual([a.pfEmployee, a.esiEmployee, a.pt, a.lwfEmployee, a.tds, a.netPay], [R(1_800), 0, R(200), R(25), 0, R(32_975)]);

    const b = line('B');
    assert.equal(b.paidDays, 27);
    assert.equal(b.gross, R(14_400), 'three days without pay');
    assert.deepEqual([b.pfEmployee, b.pfEmployerEps, b.pfEmployerEpf], [R(1_080), R(750), R(330)]);
    assert.deepEqual([b.esiEmployee, b.esiEmployer], [R(108), R(468)]);
    assert.equal(b.netPay, R(12_987));

    const c = line('C');
    assert.equal(c.paidDays, 15, 'joined on the 16th');
    assert.equal(c.gross, R(7_500));
    assert.deepEqual([c.esiEmployee, c.esiEmployer, c.pt], [R(57), R(244), 0]);
    assert.equal(c.netPay, R(6_698));

    const d = line('D');
    assert.equal(d.tds, R(19_240), '₹1,92,400 on the ten months to March, a tenth now');
    assert.equal(d.netPay, R(1_78_735));

    await postRun(f.trx, f.orgId, null, runId);
    assert.equal(await balance(f, CODE.SALARIES), R(2_56_900));
    assert.equal(await balance(f, CODE.EMPLOYER_CONTRIBUTIONS), R(6_862));
    assert.equal(await balance(f, CODE.PF_PAYABLE), -R(11_250));
    assert.equal(await balance(f, CODE.ESI_PAYABLE), -R(877));
    assert.equal(await balance(f, CODE.PT_PAYABLE), -R(600));
    assert.equal(await balance(f, CODE.LWF_PAYABLE), -R(400));
    assert.equal(await balance(f, CODE.TDS_PAYABLE), -R(19_240));
    assert.equal(await balance(f, CODE.SALARIES_PAYABLE), -R(2_31_395));
    await assert.rejects(prepareRun(f.trx, f.orgId, null, '2026-06'), /already posted/);

    await reopenRun(f.trx, f.orgId, null, runId, 'B’s leave was wrong');
    assert.equal(await balance(f, CODE.SALARIES), 0, 'reversed, not deleted');
    await prepareRun(f.trx, f.orgId, null, '2026-06', { [f.ids.b]: { lopDays: 0 } });
    assert.equal((await runDetail(f.trx, f.orgId, runId)).lines.find((l) => l.code === 'A')!.netPay, R(32_975), 'the others kept as they were');
    await postRun(f.trx, f.orgId, null, runId);

    await assert.rejects(payRun(f.trx, f.orgId, null, runId, { bankAccountId: f.bankId, date: '2026-05-31' }), /before the month/);
    await payRun(f.trx, f.orgId, null, runId, { bankAccountId: f.bankId, date: '2026-07-01' });
    assert.equal(await balance(f, CODE.SALARIES_PAYABLE), 0);
    await assert.rejects(reopenRun(f.trx, f.orgId, null, runId, 'too late'), /have been paid/);

    // The files for the bank, EPFO and ESIC.
    await f.trx.updateTable('employees').set({ uan: '100200300400', bank_account_no: '50100012345678', bank_ifsc: 'HDFC0001234', esi_ip_number: '3112345678' })
      .where('id', '=', f.ids.b).execute();
    const lines = (await runDetail(f.trx, f.orgId, runId)).lines;
    const pfFile = ecr(lines);
    assert.equal(pfFile.text, '100200300400#~#EMPLOYEE B#~#16000#~#10000#~#10000#~#10000#~#1200#~#833#~#367#~#0#~#0', 'B, now with no days off');
    assert.deepEqual(pfFile.missing, ['A Employee A', 'C Employee C', 'D Employee D']);
    const bank = bankTransfers(lines, '2026-06');
    assert.deepEqual(bank.rows[1], ['Employee B', '50100012345678', 'HDFC0001234', lines.find((l) => l.code === 'B')!.netPay / 100, 'Salary Jun 2026']);
    assert.equal(bank.missing.length, 3);
    const esiRows = esiContributions(lines);
    assert.deepEqual(esiRows.rows[1], ['3112345678', 'Employee B', 30, 16000, 0, '']);
    assert.deepEqual(esiRows.missing, ['C Employee C']);

    const q = await salaryTdsQuarter(f.trx, f.orgId, 2026, 1);
    assert.equal(q.form, 'Form 138');
    assert.equal(q.rows.find((r) => r.code === 'D')?.tdsPaise, R(19_240));
  });
});

test('ESI coverage holds to the end of the contribution period, then lapses', async () => {
  await withFixture(async (f) => {
    await prepareRun(f.trx, f.orgId, null, '2026-06');
    await setSalary(f.trx, f.orgId, f.ids.b, { effectiveFrom: '2026-07-01', basic: R(15_000), da: 0, hra: R(6_000), special: R(4_000), other: 0 });
    const july = await runDetail(f.trx, f.orgId, await prepareRun(f.trx, f.orgId, null, '2026-07'));
    const b = july.lines.find((l) => l.code === 'B')!;
    assert.equal(b.gross, R(25_000));
    assert.deepEqual([b.esiEmployee, b.esiEmployer], [R(188), R(813)], 'covered in April–September, so still covered');
    const october = await runDetail(f.trx, f.orgId, await prepareRun(f.trx, f.orgId, null, '2026-10'));
    assert.equal(october.lines.find((l) => l.code === 'B')!.esiEmployer, 0, 'a new period, above the ceiling');
  });
});

test.after(async () => {
  await db.destroy();
});
