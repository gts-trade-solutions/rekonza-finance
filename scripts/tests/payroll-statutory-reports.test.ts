// Status review 7, items 10 and 14 (payroll side): the statutory deduction
// reports, TDS challans and Form 24Q, Form 16 Part A, salaries paid employee by
// employee, and the salary journal by component — each tied to the pay runs
// and to the general ledger.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/payroll-statutory-reports.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { toPaiseFromSql } from '../../lib/server/money-sql';
import { verifyLedgerBalances } from '../../lib/server/ledger/posting';
import { createEmployee } from '../../lib/server/payroll/employees';
import { postRun, prepareRun, reopenRun, runDetail } from '../../lib/server/payroll/payroll';
import { payStatutory, statutoryRegister } from '../../lib/server/payroll/statutory-dues';
import { esiReport, lwfReport, pfReport, ptReport, tdsRegister } from '../../lib/server/payroll/statutory-reports';
import { deleteSalaryChallan, form16PartA, form24Q, recordSalaryChallan, salaryTdsMonths, setReturnReceipt } from '../../lib/server/payroll/salary-tds';
import { paySalaries, reverseSalaryPayment, salaryBankFile, salaryPayments } from '../../lib/server/payroll/salary-payments';
import { form16 } from '../../lib/server/payroll/form16';
import { deleteRun, unpayRun } from '../../lib/server/payroll/changes';
import { setTodayForTests } from '../../lib/server/payroll/paid-dates';

const R = (rupees: number) => Math.round(rupees * 100);

interface Fixture { trx: Trx; orgId: number; bankId: number; acc: Record<string, number>; ids: Record<string, number>; cc: number }

async function withFixture(fn: (f: Fixture) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Statutory Co', tan: 'CHEA12345B', pan: 'AABCS1234Q', tds_rp_name: 'R Rao', tds_rp_pan: 'ABCPR1234K', tds_rp_designation: 'Director' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'Chennai', state_code: '33', is_primary: 1 }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const acc = await accountIds(trx, orgId);
      const bankId = Number((await trx.insertInto('bank_accounts').values({
        org_id: orgId, kind: 'bank', name: 'Salary account', ledger_account_id: acc[CODE.BANK_DEFAULT], opening_balance: '0.0000', account_number: '50200099887766',
      }).executeTakeFirstOrThrow()).insertId);
      const cc = Number((await trx.insertInto('cost_centres').values({ org_id: orgId, code: 'SAL', name: 'Sales' }).executeTakeFirstOrThrow()).insertId);
      let n = 0;
      const emp = (code: string, state: string | null, s: { basic: number; hra: number; special: number }, extra: Record<string, unknown> = {}) => createEmployee(trx, orgId, {
        branchId, code, name: `Employee ${code}`, dateOfJoining: '2025-01-01', workStateCode: state, uan: `10090000${String(++n).padStart(4, '0')}`,
        esiIpNumber: `31000000${String(n).padStart(2, '0')}`, pan: `ABCDE${String(1000 + n)}F`, bankAccountNo: `1234567890${n}`, bankIfsc: 'HDFC0000123', gender: 'male', ...extra,
      }, { basic: R(s.basic), da: 0, hra: R(s.hra), special: R(s.special), other: 0 });
      const ids = {
        // Basic above the ₹15,000 PF ceiling; gross above the ₹21,000 ESI ceiling; works in Maharashtra.
        // An EPS member since before 1 September 2014 (UAN carried over), so EPS is capped, not taken away.
        a: await emp('A', '27', { basic: 20_000, hra: 8_000, special: 7_000 }, { costCentreId: cc, epsBeforeSep2014: true }),
        // Below both ceilings; Karnataka, under its ₹25,000 PT threshold.
        b: await emp('B', '29', { basic: 10_000, hra: 5_000, special: 3_000 }),
        // Below both; the branch's own Tamil Nadu (half-yearly PT).
        c: await emp('C', null, { basic: 12_000, hra: 4_000, special: 4_000 }),
        // High salary, Telangana, old regime with ₹1.5 lakh declared.
        d: await emp('D', '36', { basic: 1_00_000, hra: 40_000, special: 60_000 }, { taxRegime: 'old', declaredDeductionsPaise: R(1_50_000) }),
        // West Bengal, gross ₹25,000 (out of ESI, PT ₹130).
        e: await emp('E', '19', { basic: 14_000, hra: 6_000, special: 5_000 }),
        // Karnataka at ₹30,000: PT ₹200.
        g: await emp('G', '29', { basic: 15_000, hra: 8_000, special: 7_000 }),
      };
      await fn({ trx, orgId, bankId, acc, ids, cc });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

const balance = async (f: Fixture, code: string) => toPaiseFromSql((await sql<{ b: string }>`
  SELECT COALESCE(SUM(debit - credit), 0) AS b FROM journal_lines WHERE org_id = ${f.orgId} AND account_id = ${f.acc[code]}`.execute(f.trx)).rows[0].b);

async function runMonths(f: Fixture, months: string[]) {
  const runs: number[] = [];
  for (const m of months) {
    const id = await prepareRun(f.trx, f.orgId, null, m);
    await postRun(f.trx, f.orgId, null, id);
    runs.push(id);
  }
  return runs;
}

test('PF, ESI, PT and LWF reports: the ceilings, the ECR line, the states, and the tie to the ledger', async () => {
  await withFixture(async (f) => {
    await runMonths(f, ['2026-04', '2026-05', '2026-06']);
    const pf = await pfReport(f.trx, f.orgId, '2026-04', '2026-06');
    const a = pf.rows.find((r) => r.code === 'A' && r.month === '2026-04')!;
    // Basic ₹20,000: contributions on the ₹15,000 ceiling; EPS 8.33% capped at ₹1,250; the employer's difference ₹550.
    assert.equal(a.epfWagesPaise, R(15_000));
    assert.equal(a.epsPaise, R(1_250));
    assert.equal(a.eePaise, R(1_800));
    assert.equal(a.erDiffPaise, R(550));
    assert.equal(a.edliWagesPaise, R(15_000));
    const b = pf.rows.find((r) => r.code === 'B' && r.month === '2026-04')!;
    assert.equal(b.epfWagesPaise, R(10_000));
    assert.equal(b.epsPaise, R(833));
    // ECR 2.0: UAN#~#NAME#~#gross#~#EPF#~#EPS#~#EDLI#~#EE#~#EPS#~#ER#~#NCP#~#refund, whole rupees.
    const april = pf.ecr.find((e) => e.month === '2026-04')!;
    const lineA = april.text.split('\n').find((l) => l.startsWith('100900000001'))!;
    assert.equal(lineA, '100900000001#~#EMPLOYEE A#~#35000#~#15000#~#15000#~#15000#~#1800#~#1250#~#550#~#0#~#0');
    assert.equal(april.members, 6);
    assert.ok(pf.tie.ok, JSON.stringify(pf.tie));

    const esi = await esiReport(f.trx, f.orgId, '2026-04', '2026-06');
    const covered = [...new Set(esi.rows.map((r) => r.code))].sort();
    assert.deepEqual(covered, ['B', 'C'], 'gross ₹21,000 or less is covered');
    const bE = esi.rows.find((r) => r.code === 'B' && r.month === '2026-04')!;
    assert.equal(bE.eePaise, R(135), '0.75% of ₹18,000');
    assert.equal(bE.erPaise, R(585), '3.25% of ₹18,000');
    assert.equal(esi.uploads[0].rows[1][3], 18_000);
    assert.ok(esi.tie.ok);

    const pt = await ptReport(f.trx, f.orgId, '2026-04', '2026-06');
    const st = Object.fromEntries(pt.byState.map((s) => [s.state, s.months[0].slabs.map((x) => [x.ratePaise / 100, x.count])]));
    assert.deepEqual(st['Maharashtra'], [[200, 1]]);
    assert.deepEqual(st['Karnataka'], [[0, 1], [200, 1]], 'one under the threshold, one at ₹200');
    assert.deepEqual(st['Tamil Nadu'], [[208, 1]], 'half-yearly ₹1,250 a sixth a month');
    assert.deepEqual(st['Telangana'], [[200, 1]]);
    assert.deepEqual(st['West Bengal'], [[130, 1]]);
    assert.ok(pt.tie.ok);

    const lwf = await lwfReport(f.trx, f.orgId, '2026-04', '2026-06');
    const june = Object.fromEntries(lwf.periods.map((x) => [x.state, [x.eePaise, x.erPaise]]));
    assert.deepEqual(june['Maharashtra'], [R(25), R(75)]);
    assert.deepEqual(june['West Bengal'], [R(3), R(15)]);
    assert.equal(lwf.periods.find((x) => x.state === 'Maharashtra')!.period, 'January–June 2026');
    assert.ok(lwf.tie.ok);

    // Paying April's dues clears each liability; the ties count what was paid.
    const { dues } = await statutoryRegister(f.trx, f.orgId, '2026-04', '2026-04');
    for (const d of dues) await payStatutory(f.trx, f.orgId, null, { component: d.component, period: '2026-04', amountPaise: d.balancePaise, date: '2026-05-12', bankAccountId: f.bankId, reference: `${d.component.toUpperCase()}-APR` });
    const pf2 = await pfReport(f.trx, f.orgId, '2026-04', '2026-06');
    assert.equal(pf2.tie.paidPaise, dues.find((d) => d.component === 'pf')!.duePaise);
    assert.ok(pf2.tie.ok);
    assert.equal(-(await balance(f, CODE.PF_PAYABLE)), pf2.totalPaise - pf2.tie.paidPaise, 'PF Payable holds May and June only');
    assert.ok((await esiReport(f.trx, f.orgId, '2026-04', '2026-06')).tie.ok);
  });
});

test('TDS on salary: challans with BSR code and serial, deductions linked, 24Q Annexure I and II, Form 16 Part A', async (t) => {
  // The whole year to March 2027 is run and deposited: stand after it, as a future challan is refused.
  setTodayForTests('2027-06-30');
  t.after(() => setTodayForTests(null));
  await withFixture(async (f) => {
    const months = ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11', '2026-12', '2027-01', '2027-02', '2027-03'];
    await runMonths(f, months);
    const reg = await tdsRegister(f.trx, f.orgId, '2026-04', '2027-03');
    assert.ok(reg.rows.some((r) => r.code === 'D'), 'the high earner has tax deducted');
    // Deposit each month's tax by challan.
    let serial = 10;
    for (const m of months) {
      const due = (await salaryTdsMonths(f.trx, f.orgId, [m]))[0];
      if (!due?.deductedPaise) continue;
      const [y, mo] = m.split('-').map(Number);
      const date = mo === 3 ? `${y}-04-25` : `${mo === 12 ? y + 1 : y}-${String(mo === 12 ? 1 : mo + 1).padStart(2, '0')}-06`;
      const r = await recordSalaryChallan(f.trx, f.orgId, null, { forMonth: m, date, bsrCode: '0510308', serial: String(serial++), taxPaise: due.deductedPaise, bankAccountId: f.bankId });
      assert.equal(r.unallocatedPaise, 0, 'the challan covers the month exactly');
    }
    await assert.rejects(recordSalaryChallan(f.trx, f.orgId, null, { forMonth: '2026-04', date: '2026-05-06', bsrCode: '0510308', serial: '10', taxPaise: 100, bankAccountId: f.bankId }), /already recorded/);
    await assert.rejects(recordSalaryChallan(f.trx, f.orgId, null, { forMonth: '2026-04', date: '2026-05-06', bsrCode: '510308', serial: '99', taxPaise: 100, bankAccountId: f.bankId }), /7 digits/);
    assert.equal(await balance(f, CODE.TDS_PAYABLE), 0, 'every month deposited: TDS Payable clears');
    assert.ok((await tdsRegister(f.trx, f.orgId, '2026-04', '2027-03')).tie.ok);

    const q1 = await form24Q(f.trx, f.orgId, 2026, 1);
    assert.equal(q1.unlinked.length, 0);
    assert.equal(q1.totals.linkedPaise, q1.totals.deductedPaise);
    assert.equal(q1.challans.length, 3, 'one challan a month');
    const c = q1.challans[0];
    assert.equal(c.bsrCode, '0510308');
    assert.equal(c.deductees.reduce((t, d) => t + d.depositedPaise, 0), c.taxPaise);
    // Not paid yet: no payment date is reported (section 192 deducts at payment), and the return says so.
    assert.ok(c.deductees.every((d) => d.pan && d.paymentDate === null));
    assert.ok(q1.issues.some((i) => /no salary payment recorded/.test(i.message)), JSON.stringify(q1.issues));
    // April's salaries paid on 30 April: that is the date Annexure I reports, for each employee.
    const aprRun = (await f.trx.selectFrom('payroll_runs').select('id').where('org_id', '=', f.orgId).where('month', '=', '2026-04').executeTakeFirstOrThrow()).id;
    await paySalaries(f.trx, f.orgId, null, aprRun, { bankAccountId: f.bankId, date: '2026-04-30', employeeIds: null });
    const q1paid = await form24Q(f.trx, f.orgId, 2026, 1);
    assert.ok(q1paid.challans[0].deductees.every((d) => d.paymentDate === '2026-04-30'));
    assert.equal(q1.annexureII, null, 'Annexure II is for the fourth quarter');
    assert.ok(!q1.issues.some((i) => i.level === 'error'), JSON.stringify(q1.issues));

    const q4 = await form24Q(f.trx, f.orgId, 2026, 4);
    assert.equal(q4.annexureII?.length, 6);
    const dII = q4.annexureII!.find((x) => x.employee.code === 'D')!;
    const dYear = await form16(f.trx, f.orgId, f.ids.d, 2026);
    assert.equal(dII.taxPaise, dYear.taxPaise);
    assert.equal(dII.deductedPaise, reg.rows.filter((r) => r.code === 'D').reduce((t, r) => t + r.tdsPaise, 0));
    assert.equal(dII.employee.regime, 'old');
    assert.equal(dII.chapterVIAPaise, R(1_50_000));

    // Form 16 Part A from the same links, with the receipt numbers.
    await setReturnReceipt(f.trx, f.orgId, null, 2026, 1, 'QWERTYUI1234567', '2026-07-20');
    const partA = await form16PartA(f.trx, f.orgId, f.ids.d, 2026);
    assert.equal(partA.quarters[0].receiptNo, 'QWERTYUI1234567');
    assert.equal(partA.totals.deductedPaise, dII.deductedPaise);
    assert.equal(partA.totals.depositedPaise, partA.totals.deductedPaise, 'everything deducted is deposited');
    assert.equal(partA.challans.length, 12);

    // A challan deleted: its entry reversed, its deductions unlinked, the 24Q says so.
    const aprChallan = q1.challans[0];
    await deleteSalaryChallan(f.trx, f.orgId, null, Number(aprChallan.id), 'wrong serial');
    const again = await form24Q(f.trx, f.orgId, 2026, 1);
    assert.ok(again.unlinked.length > 0 && again.issues.some((i) => /not linked/.test(i.message)));
    assert.equal(-(await balance(f, CODE.TDS_PAYABLE)), aprChallan.taxPaise);
    assert.ok((await verifyLedgerBalances(f.trx, f.orgId)).balanced);
  });
});

test('salaries paid employee by employee: Salaries Payable clears person by person, a payment taken back alone, the bank file', async () => {
  await withFixture(async (f) => {
    const [run] = await runMonths(f, ['2026-04']);
    const detail = await runDetail(f.trx, f.orgId, run);
    const net = Object.fromEntries(detail.lines.map((l) => [l.code, l.netPay]));
    const total = Object.values(net).reduce((t, v) => t + v, 0);
    assert.equal(-(await balance(f, CODE.SALARIES_PAYABLE)), total);

    await paySalaries(f.trx, f.orgId, null, run, { bankAccountId: f.bankId, date: '2026-05-01', employeeIds: [f.ids.a] });
    assert.equal(-(await balance(f, CODE.SALARIES_PAYABLE)), total - net.A);
    let s = await salaryPayments(f.trx, f.orgId, run);
    assert.equal(s.status, 'posted', 'others still unpaid');
    const file = await salaryBankFile(f.trx, f.orgId, run, { bankAccountId: f.bankId, date: '2026-05-02' });
    assert.equal(file.rows.length, 5, 'the file has only those unpaid');
    assert.equal(file.rows[0][0], 'NEFT');
    assert.equal(file.rows[0][6], '50200099887766');
    await assert.rejects(reopenRun(f.trx, f.orgId, null, run, 'fix days'), /Undo those payments first/);

    const rest = await paySalaries(f.trx, f.orgId, null, run, { bankAccountId: f.bankId, date: '2026-05-02', employeeIds: null, reference: 'BULK-0502' });
    assert.equal(rest.employees, 5);
    assert.ok(rest.fullyPaid);
    assert.equal(await balance(f, CODE.SALARIES_PAYABLE), 0);
    s = await salaryPayments(f.trx, f.orgId, run);
    assert.equal(s.status, 'paid');
    // The bulk entry has a Salaries Payable line per employee, naming them.
    const { rows: lines } = await sql<{ description: string }>`SELECT description FROM journal_lines WHERE entry_id = ${rest.entryId} AND account_id = ${f.acc[CODE.SALARIES_PAYABLE]}`.execute(f.trx);
    assert.equal(lines.length, 5);
    assert.ok(lines.some((l) => /Employee B \(B\)/.test(l.description)));

    // B's transfer bounced: take back B alone.
    const bPay = s.rows.find((r) => r.code === 'B')!.payments[0];
    await reverseSalaryPayment(f.trx, f.orgId, null, Number(bPay.id), 'account closed');
    assert.equal(-(await balance(f, CODE.SALARIES_PAYABLE)), net.B);
    s = await salaryPayments(f.trx, f.orgId, run);
    assert.equal(s.status, 'posted');
    assert.equal(s.rows.find((r) => r.code === 'B')!.unpaidPaise, net.B);
    await paySalaries(f.trx, f.orgId, null, run, { bankAccountId: f.bankId, date: '2026-05-05', employeeIds: [f.ids.b] });
    assert.equal(await balance(f, CODE.SALARIES_PAYABLE), 0);

    // Undo all, then delete: everything reversed, nothing left anywhere.
    await unpayRun(f.trx, f.orgId, null, run, 'paid from the wrong account');
    assert.equal(-(await balance(f, CODE.SALARIES_PAYABLE)), total);
    await deleteRun(f.trx, f.orgId, null, run, 'test');
    for (const code of [CODE.SALARIES, CODE.SALARIES_PAYABLE, CODE.BANK_DEFAULT, CODE.PF_PAYABLE]) assert.equal(await balance(f, code), 0);
    assert.ok((await verifyLedgerBalances(f.trx, f.orgId)).balanced);
  });
});

test('the salary journal: gross by component and cost centre, employer PF, ESI and LWF apart, every liability', async () => {
  await withFixture(async (f) => {
    const [run] = await runMonths(f, ['2026-06']);
    const r = await f.trx.selectFrom('payroll_runs').select('journal_entry_id').where('id', '=', run).executeTakeFirstOrThrow();
    const { rows } = await sql<{ code: string; description: string; debit: string; credit: string; cost_centre_id: number | null }>`
      SELECT a.code, l.description, l.debit, l.credit, l.cost_centre_id FROM journal_lines l JOIN accounts a ON a.id = l.account_id
       WHERE l.entry_id = ${r.journal_entry_id} ORDER BY l.line_no`.execute(f.trx);
    const detail = await runDetail(f.trx, f.orgId, run);
    const sum = (k: keyof (typeof detail.lines)[number]) => detail.lines.reduce((t, l) => t + Number(l[k]), 0);
    const dr = (re: RegExp, cc?: number | null) => rows.filter((x) => re.test(x.description ?? '') && (cc === undefined || x.cost_centre_id === cc)).reduce((t, x) => t + Math.round(Number(x.debit) * 100), 0);
    assert.equal(dr(/^Basic/), sum('basic'));
    assert.equal(dr(/^House rent allowance/), sum('hra'));
    assert.equal(dr(/^Special allowance/), sum('special'));
    assert.equal(dr(/^Basic — Sales/, f.cc), detail.lines.find((l) => l.code === 'A')!.basic, 'A’s salary on the Sales cost centre');
    assert.equal(dr(/^Employer PF/), sum('pfEmployerEpf') + sum('pfEmployerEps') + sum('pfAdmin') + sum('pfEdli'));
    assert.equal(dr(/^Employer ESI/), sum('esiEmployer'));
    assert.equal(dr(/^Employer LWF/), sum('lwfEmployer'));
    const cr = (code: string) => rows.filter((x) => x.code === code).reduce((t, x) => t + Math.round(Number(x.credit) * 100), 0);
    assert.equal(cr(CODE.PF_PAYABLE), sum('pfEmployee') + sum('pfEmployerEpf') + sum('pfEmployerEps') + sum('pfAdmin') + sum('pfEdli'));
    assert.equal(cr(CODE.ESI_PAYABLE), sum('esiEmployee') + sum('esiEmployer'));
    assert.equal(cr(CODE.PT_PAYABLE), sum('pt'));
    assert.equal(cr(CODE.LWF_PAYABLE), sum('lwfEmployee') + sum('lwfEmployer'));
    assert.equal(cr(CODE.TDS_PAYABLE), sum('tds'));
    assert.equal(cr(CODE.SALARIES_PAYABLE), sum('netPay'));
    assert.equal(await balance(f, CODE.SALARIES), sum('gross'));
  });
});

test.after(async () => {
  await db.destroy();
});
