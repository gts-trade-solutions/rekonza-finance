// The rest of payroll: advances recovered by instalment, arrears from a
// back-dated revision, expense claims repaid with salary, investment
// declarations and proofs in TDS, and Form 16 Part B.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/payroll-more.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { toPaiseFromSql } from '../../lib/server/money-sql';
import { hraExemption, oldRegimeDeductions } from '../../lib/payroll/statutory';
import { createEmployee, setSalary } from '../../lib/server/payroll/employees';
import { employedDays, postRun, prepareRun, runDetail } from '../../lib/server/payroll/payroll';
import { giveLoan, listLoans } from '../../lib/server/payroll/loans';
import { reviewClaim, saveClaim } from '../../lib/server/payroll/claims';
import { deductionItems, reviewProof, saveDeclaration, submitProof } from '../../lib/server/payroll/declarations';
import { form16 } from '../../lib/server/payroll/form16';
import { createPayslipLink, openShareLink } from '../../lib/server/services/sharing';

const R = (rupees: number) => Math.round(rupees * 100);

async function withBook(fn: (f: { trx: Trx; orgId: number; branchId: number; bankId: number; acc: Record<string, number> }) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Delhi Traders', tan: 'DELD12345E' }).executeTakeFirstOrThrow()).insertId);
      // Delhi: no professional tax and no labour welfare fund, so the figures stay plain.
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'Delhi', state_code: '07', is_primary: 1 }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const acc = await accountIds(trx, orgId);
      const bankId = Number((await trx.insertInto('bank_accounts').values({
        org_id: orgId, kind: 'bank', name: 'Current', ledger_account_id: acc[CODE.BANK_DEFAULT], opening_balance: '0.0000',
      }).executeTakeFirstOrThrow()).insertId);
      await fn({ trx, orgId, branchId, bankId, acc });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

const ledger = async (trx: Trx, accountId: number) => toPaiseFromSql((await sql<{ b: string }>`
  SELECT COALESCE(SUM(debit - credit), 0) AS b FROM journal_lines WHERE account_id = ${accountId}
`.execute(trx)).rows[0].b);

test('an advance is recovered by instalment, never more than the month leaves, until it is gone', async () => {
  await withBook(async ({ trx, orgId, branchId, bankId, acc }) => {
    const b = await createEmployee(trx, orgId, { branchId, code: 'B', name: 'Bala', dateOfJoining: '2025-01-01' },
      { basic: R(20_000), da: 0, hra: R(8_000), special: R(7_000), other: 0 });
    const small = await createEmployee(trx, orgId, { branchId, code: 'S', name: 'Selvi', dateOfJoining: '2025-01-01' },
      { basic: R(5_000), da: 0, hra: 0, special: 0, other: 0 });
    await giveLoan(trx, orgId, null, { employeeId: b, kind: 'advance', amountPaise: R(10_000), instalmentPaise: R(4_000), givenOn: '2026-05-20', firstMonth: '2026-06', bankAccountId: bankId });
    await giveLoan(trx, orgId, null, { employeeId: small, kind: 'loan', amountPaise: R(20_000), instalmentPaise: R(10_000), givenOn: '2026-05-20', firstMonth: '2026-06', bankAccountId: bankId });
    assert.equal(await ledger(trx, acc[CODE.LOANS_ADVANCES]), R(30_000));

    const month = async (m: string) => {
      const id = await prepareRun(trx, orgId, null, m);
      const run = await runDetail(trx, orgId, id);
      await postRun(trx, orgId, null, id);
      return (code: string) => run.lines.find((l) => l.code === code)!;
    };
    const june = await month('2026-06');
    assert.equal(june('B').loanRecovery, R(4_000));
    assert.equal(june('B').netPay, R(35_000 - 1_800 - 4_000));
    assert.equal(june('S').loanRecovery, R(5_000 - 600), 'only what the month leaves after PF');
    assert.equal(june('S').netPay, 0);
    assert.equal((await month('2026-07'))('B').loanRecovery, R(4_000));
    assert.equal((await month('2026-08'))('B').loanRecovery, R(2_000), 'the last instalment is what is left');
    assert.equal((await month('2026-09'))('B').loanRecovery, 0);

    const loans = await listLoans(trx, orgId);
    assert.deepEqual(loans.find((l) => l.name === 'Bala')!.balancePaise, 0);
    assert.deepEqual(loans.find((l) => l.name === 'Selvi')!.balancePaise, R(20_000 - 4 * 4_400));
    assert.equal(await ledger(trx, acc[CODE.LOANS_ADVANCES]), R(20_000 - 4 * 4_400));
  });
});

test('a revision dated back owes arrears for the months already paid, once', async () => {
  await withBook(async ({ trx, orgId, branchId }) => {
    const a = await createEmployee(trx, orgId, { branchId, code: 'A', name: 'Anu', dateOfJoining: '2025-01-01' },
      { basic: R(20_000), da: 0, hra: R(8_000), special: R(7_000), other: 0 });
    await postRun(trx, orgId, null, await prepareRun(trx, orgId, null, '2026-05', { [a]: { lopDays: 1 } }));
    await postRun(trx, orgId, null, await prepareRun(trx, orgId, null, '2026-06'));
    // Agreed in July, from May.
    await setSalary(trx, orgId, a, { basic: R(22_000), da: 0, hra: R(8_800), special: R(7_000), other: 0, effectiveFrom: '2026-05-01' });

    const julyId = await prepareRun(trx, orgId, null, '2026-07');
    const july = (await runDetail(trx, orgId, julyId)).lines[0];
    // June in full: ₹2,800. May had 30 of 31 days paid: ₹2,800 × 30/31, to the rupee.
    const may = Math.round((R(22_000) * 30) / 31 / 100) * 100 + Math.round((R(8_800) * 30) / 31 / 100) * 100
      - (Math.round((R(20_000) * 30) / 31 / 100) * 100 + Math.round((R(8_000) * 30) / 31 / 100) * 100);
    assert.equal(july.arrears, R(2_800) + may);
    assert.equal(july.gross, R(37_800) + july.arrears);
    await postRun(trx, orgId, null, julyId);

    const aug = (await runDetail(trx, orgId, await prepareRun(trx, orgId, null, '2026-08'))).lines[0];
    assert.equal(aug.arrears, 0, 'made up already');
  });
});

test('approved claims are repaid with the month they fall in; once posted, they stay', async () => {
  await withBook(async ({ trx, orgId, branchId, acc }) => {
    const c = await createEmployee(trx, orgId, { branchId, code: 'C', name: 'Chitra', dateOfJoining: '2025-01-01' },
      { basic: R(20_000), da: 0, hra: 0, special: 0, other: 0 });
    const taxi = await saveClaim(trx, orgId, null, { employeeId: c, claimDate: '2026-06-10', category: 'Local conveyance', amountPaise: R(1_500) });
    const lunch = await saveClaim(trx, orgId, null, { employeeId: c, claimDate: '2026-06-12', category: 'Meals', amountPaise: R(900) });
    const later = await saveClaim(trx, orgId, null, { employeeId: c, claimDate: '2026-07-02', category: 'Travel', amountPaise: R(4_000) });
    await reviewClaim(trx, orgId, null, taxi, { approve: true });
    await reviewClaim(trx, orgId, null, later, { approve: true });
    await assert.rejects(reviewClaim(trx, orgId, null, lunch, { approve: false }), /why it is rejected/);
    await reviewClaim(trx, orgId, null, lunch, { approve: false, note: 'No bill' });

    // A hand-typed reimbursement sits beside the claims and survives a recompute.
    const juneId = await prepareRun(trx, orgId, null, '2026-06', { [c]: { reimbursementPaise: R(200) } });
    await prepareRun(trx, orgId, null, '2026-06');
    const june = (await runDetail(trx, orgId, juneId)).lines[0];
    assert.deepEqual([june.claims, june.reimbursement], [R(1_500), R(1_700)]);
    await postRun(trx, orgId, null, juneId);
    assert.equal(await ledger(trx, acc[CODE.STAFF_REIMBURSEMENTS]), R(1_700));
    await assert.rejects(reviewClaim(trx, orgId, null, taxi, { approve: false, note: 'Changed mind' }), /2026-06 payroll, which is posted/);

    const july = (await runDetail(trx, orgId, await prepareRun(trx, orgId, null, '2026-07'))).lines[0];
    assert.equal(july.claims, R(4_000));
  });
});

test('declarations decide old-regime TDS until December; accepted proofs from January; Form 16 from what was posted', async () => {
  // The HRA exemption: the least of the three.
  assert.equal(hraExemption({ hraReceived: R(2_40_000), basicDa: R(6_00_000), rentPaid: R(3_00_000), metro: true }), R(2_40_000));
  assert.equal(hraExemption({ hraReceived: R(2_40_000), basicDa: R(6_00_000), rentPaid: R(1_00_000), metro: true }), R(40_000));
  assert.equal(hraExemption({ hraReceived: R(2_40_000), basicDa: R(6_00_000), rentPaid: R(3_00_000), metro: false }), R(2_40_000));
  assert.deepEqual(oldRegimeDeductions([{ section: '80C', amount: R(2_00_000) }, { section: '80TTA', amount: R(15_000) }], { hraReceived: 0, basicDa: 0, metro: false }).total,
    R(1_50_000 + 10_000), 'each section capped');

  await withBook(async ({ trx, orgId, branchId }) => {
    const d = await createEmployee(trx, orgId, { branchId, code: 'D', name: 'Deepa', dateOfJoining: '2025-01-01', taxRegime: 'old', metroCity: true, pfMember: false },
      { basic: R(50_000), da: 0, hra: R(20_000), special: R(30_000), other: 0 });

    // Nothing declared: ₹12 lakh less ₹50,000 standard deduction.
    const bare = (await runDetail(trx, orgId, await prepareRun(trx, orgId, null, '2026-04'))).lines[0];
    assert.equal(bare.tds, R(13_650));

    const c80 = await saveDeclaration(trx, orgId, { employeeId: d, fyStart: 2026, section: '80C', declaredPaise: R(1_50_000) });
    const rent = await saveDeclaration(trx, orgId, { employeeId: d, fyStart: 2026, section: 'HRA', description: 'Rent, Lajpat Nagar', declaredPaise: R(3_00_000) });
    // ₹12 lakh − ₹50,000 − ₹1.5 lakh 80C − ₹2.4 lakh HRA = ₹7.6 lakh: ₹64,500 and cess, ₹67,080 a year.
    const aprId = await prepareRun(trx, orgId, null, '2026-04');
    const apr = (await runDetail(trx, orgId, aprId)).lines[0];
    assert.equal(apr.tds, R(5_590));
    await postRun(trx, orgId, null, aprId);

    // From January only accepted proofs count.
    assert.deepEqual((await deductionItems(trx, orgId, d, 2026, '2026-12'))!.map((i) => i.amount), [R(1_50_000), R(3_00_000)]);
    assert.deepEqual((await deductionItems(trx, orgId, d, 2026, '2027-01'))!.map((i) => i.amount), [0, 0]);
    await submitProof(trx, orgId, c80, R(1_20_000));
    await reviewProof(trx, orgId, null, c80, { accept: true });
    await submitProof(trx, orgId, rent, R(3_00_000));
    await assert.rejects(reviewProof(trx, orgId, null, rent, { accept: false }), /why the proof/);
    assert.deepEqual((await deductionItems(trx, orgId, d, 2026, '2027-01'))!.map((i) => i.amount), [R(1_20_000), 0]);
    await reviewProof(trx, orgId, null, rent, { accept: true });

    // Form 16 on the one month posted: ₹1 lakh, HRA exempt ₹20,000 (all of it), 80C ₹1.2 lakh.
    const f = await form16(trx, orgId, d, 2026);
    assert.equal(f.form, 'Form 130');
    assert.deepEqual([f.grossPaise, f.hraExemptPaise, f.standardDeductionPaise, f.chapterVIAPaise, f.taxablePaise, f.taxPaise],
      [R(1_00_000), R(20_000), R(50_000), R(1_20_000), 0, 0]);
    assert.equal(f.deductedPaise, R(5_590));
    assert.equal(f.balancePaise, -R(5_590), 'more deducted than due: refunded on the return');
    assert.deepEqual(f.quarters.map((q) => q.tdsPaise), [R(5_590), 0, 0, 0]);
    assert.equal(f.employee.from, '2026-04-01');
  });
});

test('attendance: the days on the books, for unpaid days from days present', () => {
  assert.deepEqual(employedDays({ date_of_joining: '2026-06-16', date_of_leaving: null }, '2026-06'), { daysInMonth: 30, employed: 15 });
  assert.deepEqual(employedDays({ date_of_joining: '2020-01-01', date_of_leaving: '2026-07-10' }, '2026-07'), { daysInMonth: 31, employed: 10 });
});

test('a payslip shared by link: the posted month only, that employee only', async () => {
  await withBook(async ({ trx, orgId, branchId }) => {
    const e = await createEmployee(trx, orgId, { branchId, code: 'P', name: 'Priya', dateOfJoining: '2025-01-01' }, { basic: R(20_000), da: 0, hra: 0, special: 0, other: 0 });
    const runId = await prepareRun(trx, orgId, null, '2026-06');
    await assert.rejects(createPayslipLink(trx, orgId, null, { runId, employeeId: e }), /draft payroll is not final/);
    await postRun(trx, orgId, null, runId);
    await assert.rejects(createPayslipLink(trx, orgId, null, { runId, employeeId: e + 999 }), /not on that payroll/);
    const link = await createPayslipLink(trx, orgId, null, { runId, employeeId: e });
    assert.deepEqual(await openShareLink(trx, link.path.replace('/share/', '')), { orgId, docType: 'payslip', docId: runId, subId: e });
  });
});

test.after(async () => {
  await db.destroy();
});
