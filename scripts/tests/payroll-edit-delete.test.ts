// Edit and Delete across payroll (lib/server/payroll/changes.ts), against real
// MySQL inside rolled-back transactions.
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/payroll-edit-delete.test.ts
//
// What has to hold: what posted is reversed, never erased, and the ledger nets
// to nothing after a delete; an edit leaves the books as if it had been right
// the first time, on the same record; what payroll leans on (an employee on a
// pay run, PF paid for a month, an advance part-recovered, unpaid leave in a
// posted month) is refused with the way out; and a draft payroll that took in
// a changed claim or advance is worked out again.

import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { verifyLedgerBalances } from '../../lib/server/ledger/posting';
import { toPaiseFromSql } from '../../lib/server/money-sql';
import { createEmployee } from '../../lib/server/payroll/employees';
import { payRun, postRun, prepareRun, reopenRun, runDetail } from '../../lib/server/payroll/payroll';
import { giveLoan, listLoans } from '../../lib/server/payroll/loans';
import { reviewClaim, saveClaim } from '../../lib/server/payroll/claims';
import { saveDeclaration, reviewProof, submitProof } from '../../lib/server/payroll/declarations';
import { grantLeave, leaveBalances, listLeaveTypes, recordLeave, saveLeaveType } from '../../lib/server/payroll/leave';
import { listFnf, payFnf, postFnf } from '../../lib/server/payroll/fnf';
import { payStatutory, statutoryRegister } from '../../lib/server/payroll/statutory-dues';
import {
  deleteClaim, deleteDeclaration, deleteEmployee, deleteFnf, deleteLeaveEntry, deleteLeaveType, deleteLoan, deleteRun,
  deleteStatutoryPayment, unpayRun, updateClaim, updateFnf, updateLeaveEntry, updateLoan, updateStatutoryPayment,
} from '../../lib/server/payroll/changes';

const R = (rupees: number) => Math.round(rupees * 100);

interface Fixture { trx: Trx; orgId: number; branchId: number; bankId: number; acc: Record<string, number>; a: number; b: number }

async function withFixture(fn: (f: Fixture) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Payroll Changes Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'Pune', state_code: '27', is_primary: 1 }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const acc = await accountIds(trx, orgId);
      const bankId = Number((await trx.insertInto('bank_accounts').values({
        org_id: orgId, kind: 'bank', name: 'Salary account', ledger_account_id: acc[CODE.BANK_DEFAULT], opening_balance: '0.0000',
      }).executeTakeFirstOrThrow()).insertId);
      const emp = (code: string, joined: string, basic: number) => createEmployee(trx, orgId, {
        branchId, code, name: `Employee ${code}`, dateOfJoining: joined,
      }, { basic: R(basic), da: 0, hra: R(basic * 0.4), special: 0, other: 0 });
      const a = await emp('A', '2019-01-01', 20_000);
      const b = await emp('B', '2025-01-01', 10_000);
      await fn({ trx, orgId, branchId, bankId, acc, a, b });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

test.after(() => db.destroy());

const balance = async (f: Fixture, code: string) => toPaiseFromSql((await sql<{ b: string }>`
  SELECT COALESCE(SUM(debit - credit), 0) AS b FROM journal_lines WHERE org_id = ${f.orgId} AND account_id = ${f.acc[code]}
`.execute(f.trx)).rows[0].b);
const deleted = (f: Fixture, type: string) => f.trx.selectFrom('deleted_documents').selectAll()
  .where('org_id', '=', f.orgId).where('doc_type', '=', type).execute();
const reversals = async (f: Fixture) => Number((await sql<{ n: number }>`
  SELECT COUNT(*) AS n FROM journal_entries WHERE org_id = ${f.orgId} AND reversal_of_entry_id IS NOT NULL
`.execute(f.trx)).rows[0].n);

test('an employee nobody has paid is deleted; one on a payroll is refused, with the leaving date offered', async () => {
  await withFixture(async (f) => {
    const types = await listLeaveTypes(f.trx, f.orgId);
    await grantLeave(f.trx, f.orgId, null, { employeeId: f.b, leaveTypeId: Number(types[0].id), kind: 'opening', days: 5, date: '2026-04-01' });
    const r = await deleteEmployee(f.trx, f.orgId, f.b);
    assert.equal(r.code, 'B');
    assert.equal(await f.trx.selectFrom('employees').select('id').where('id', '=', f.b).executeTakeFirst(), undefined);
    assert.equal((await f.trx.selectFrom('employee_salaries').select('employee_id').where('employee_id', '=', f.b).execute()).length, 0, 'salary rows go with them');

    await prepareRun(f.trx, f.orgId, null, '2026-06');
    await assert.rejects(deleteEmployee(f.trx, f.orgId, f.a), /1 payroll month.*leaving date/s);
  });
});

test('a pay run: a draft goes; a posted one is reversed and kept; a paid one has its payment undone first or with it', async () => {
  await withFixture(async (f) => {
    const draft = await prepareRun(f.trx, f.orgId, null, '2026-05');
    await deleteRun(f.trx, f.orgId, null, draft, null);
    assert.equal(await f.trx.selectFrom('payroll_runs').select('id').where('id', '=', draft).executeTakeFirst(), undefined);
    assert.equal((await deleted(f, 'payroll_run')).length, 0, 'a draft posted nothing, so nothing is kept for it');

    const run = await prepareRun(f.trx, f.orgId, null, '2026-06');
    await postRun(f.trx, f.orgId, null, run);
    await payRun(f.trx, f.orgId, null, run, { bankAccountId: f.bankId, date: '2026-07-01' });
    const bankBefore = await balance(f, CODE.BANK_DEFAULT);
    assert.ok(bankBefore < 0);

    // Undo the payment, then reopen: the paid month can be corrected.
    await unpayRun(f.trx, f.orgId, null, run, 'paid from the wrong account');
    assert.equal(await balance(f, CODE.BANK_DEFAULT), 0);
    assert.equal((await runDetail(f.trx, f.orgId, run)).status, 'posted');
    await reopenRun(f.trx, f.orgId, null, run, 'leave days were wrong');
    await postRun(f.trx, f.orgId, null, run);
    await payRun(f.trx, f.orgId, null, run, { bankAccountId: f.bankId, date: '2026-07-01' });

    // PF paid against the month keeps it.
    const { dues } = await statutoryRegister(f.trx, f.orgId, '2026-06', '2026-06');
    const pf = dues.find((d) => d.component === 'pf')!;
    const paid = await payStatutory(f.trx, f.orgId, null, { component: 'pf', period: '2026-06', amountPaise: pf.duePaise, date: '2026-07-10', bankAccountId: f.bankId });
    await assert.rejects(deleteRun(f.trx, f.orgId, null, run, null), /Provident Fund for Jun 2026 has been paid/);
    await deleteStatutoryPayment(f.trx, f.orgId, null, paid.id, 'wrong month');

    // A bank line matched to the salary payment keeps it too.
    const payEntry = (await f.trx.selectFrom('payroll_runs').select('payment_entry_id').where('id', '=', run).executeTakeFirstOrThrow()).payment_entry_id!;
    const line = Number((await f.trx.insertInto('bank_transactions').values({
      org_id: f.orgId, bank_account_id: f.bankId, txn_date: '2026-07-01', narration: 'SALARY', withdrawal: '1.0000', deposit: '0.0000', dedupe_hash: 'payroll-edit-delete-1',
      status: 'matched', matched_type: 'journal_entry', matched_id: payEntry,
    } as never).executeTakeFirstOrThrow()).insertId);
    await assert.rejects(deleteRun(f.trx, f.orgId, null, run, null), /matched to a line of the bank statement/);
    await f.trx.deleteFrom('bank_transactions').where('id', '=', line).execute();

    await deleteRun(f.trx, f.orgId, null, run, 'run twice by mistake');
    for (const code of [CODE.SALARIES, CODE.SALARIES_PAYABLE, CODE.PF_PAYABLE, CODE.BANK_DEFAULT]) assert.equal(await balance(f, code), 0, `${code} nets to nothing`);
    const kept = await deleted(f, 'payroll_run');
    assert.equal(kept.length, 1);
    assert.equal(kept[0].reason, 'run twice by mistake');
    assert.ok(kept[0].reversal_entry_id, 'the posting is reversed, not erased');
    assert.equal((await verifyLedgerBalances(f.trx, f.orgId)).balanced, true);
  });
});

test('an advance: edited in place (the money reposted), deleted while unrecovered, refused once payroll has recovered some', async () => {
  await withFixture(async (f) => {
    const id = await giveLoan(f.trx, f.orgId, null, {
      employeeId: f.a, kind: 'advance', amountPaise: R(12_000), instalmentPaise: R(2_000), givenOn: '2026-05-10', firstMonth: '2026-06', bankAccountId: f.bankId,
    });
    const run = await prepareRun(f.trx, f.orgId, null, '2026-06');
    const recovery = async () => (await runDetail(f.trx, f.orgId, run)).lines.find((l) => l.code === 'A')!.loanRecovery;
    assert.equal(await recovery(), R(2_000));

    const r = await updateLoan(f.trx, f.orgId, null, id, {
      employeeId: f.a, kind: 'advance', amountPaise: R(9_000), instalmentPaise: R(3_000), givenOn: '2026-05-12', firstMonth: '2026-06', bankAccountId: f.bankId,
    });
    assert.equal(r.reposted, true);
    assert.equal(await balance(f, CODE.LOANS_ADVANCES), R(9_000), 'the old entry reversed, the new one posted');
    assert.equal(await recovery(), R(3_000), 'the draft payroll was worked out again');

    // Only the terms: no new entry.
    const before = await reversals(f);
    assert.equal((await updateLoan(f.trx, f.orgId, null, id, {
      employeeId: f.a, kind: 'advance', amountPaise: R(9_000), instalmentPaise: R(1_500), givenOn: '2026-05-12', firstMonth: '2026-06', bankAccountId: f.bankId, notes: 'smaller',
    })).reposted, false);
    assert.equal(await reversals(f), before);

    await postRun(f.trx, f.orgId, null, run);
    await assert.rejects(deleteLoan(f.trx, f.orgId, null, id, null), /has been recovered through payroll/);
    await assert.rejects(updateLoan(f.trx, f.orgId, null, id, {
      employeeId: f.b, kind: 'advance', amountPaise: R(9_000), instalmentPaise: R(1_500), givenOn: '2026-05-12', firstMonth: '2026-06', bankAccountId: f.bankId,
    }), /stays theirs/);
    await assert.rejects(updateLoan(f.trx, f.orgId, null, id, {
      employeeId: f.a, kind: 'advance', amountPaise: R(1_000), instalmentPaise: R(500), givenOn: '2026-05-12', firstMonth: '2026-06', bankAccountId: f.bankId,
    }), /cannot be less/);

    const second = await giveLoan(f.trx, f.orgId, null, {
      employeeId: f.b, kind: 'loan', amountPaise: R(5_000), instalmentPaise: R(1_000), givenOn: '2026-07-01', firstMonth: '2026-08', bankAccountId: f.bankId,
    });
    await deleteLoan(f.trx, f.orgId, null, second, 'given twice');
    assert.equal((await listLoans(f.trx, f.orgId)).some((l) => l.id === String(second)), false);
    assert.equal((await deleted(f, 'employee_loan')).length, 1);
    assert.equal((await verifyLedgerBalances(f.trx, f.orgId)).balanced, true);
  });
});

test('a claim: edited back to waiting, deleted from the draft that repaid it, kept once a posted payroll repaid it', async () => {
  await withFixture(async (f) => {
    const id = await saveClaim(f.trx, f.orgId, null, { employeeId: f.a, claimDate: '2026-06-05', category: 'Travel', amountPaise: R(1_200) });
    await reviewClaim(f.trx, f.orgId, null, id, { approve: true });
    const run = await prepareRun(f.trx, f.orgId, null, '2026-06');
    const claims = async () => (await runDetail(f.trx, f.orgId, run)).lines.find((l) => l.code === 'A')!.claims;
    assert.equal(await claims(), R(1_200));

    const r = await updateClaim(f.trx, f.orgId, null, id, { employeeId: f.a, claimDate: '2026-06-05', category: 'Travel', amountPaise: R(1_500) });
    assert.equal(r.reopened, true);
    assert.equal(await claims(), 0, 'off the draft until approved again');
    await reviewClaim(f.trx, f.orgId, null, id, { approve: true });
    await prepareRun(f.trx, f.orgId, null, '2026-06');
    assert.equal(await claims(), R(1_500));

    await deleteClaim(f.trx, f.orgId, null, id);
    assert.equal(await claims(), 0, 'the draft worked out again without it');

    const kept = await saveClaim(f.trx, f.orgId, null, { employeeId: f.a, claimDate: '2026-06-06', category: 'Meals', amountPaise: R(300) });
    await reviewClaim(f.trx, f.orgId, null, kept, { approve: true });
    await prepareRun(f.trx, f.orgId, null, '2026-06');
    await postRun(f.trx, f.orgId, null, run);
    await assert.rejects(deleteClaim(f.trx, f.orgId, null, kept), /repaid with the Jun 2026 payroll/);
    await assert.rejects(updateClaim(f.trx, f.orgId, null, kept, { employeeId: f.a, claimDate: '2026-06-06', category: 'Meals', amountPaise: R(1) }), /Reopen that payroll/);
  });
});

test('a declaration is deleted until its proof is accepted', async () => {
  await withFixture(async (f) => {
    const id = await saveDeclaration(f.trx, f.orgId, { employeeId: f.a, fyStart: 2026, section: '80C', declaredPaise: R(1_50_000) });
    const other = await saveDeclaration(f.trx, f.orgId, { employeeId: f.a, fyStart: 2026, section: '80D', declaredPaise: R(25_000) });
    await deleteDeclaration(f.trx, f.orgId, other);
    await submitProof(f.trx, f.orgId, id, R(1_50_000));
    await reviewProof(f.trx, f.orgId, null, id, { accept: true });
    await assert.rejects(deleteDeclaration(f.trx, f.orgId, id), /proof has been accepted/);
  });
});

test('leave: taken leave edited within the balance, unpaid leave in a posted month kept, a used kind switched off not deleted', async () => {
  await withFixture(async (f) => {
    const types = await listLeaveTypes(f.trx, f.orgId);
    const t = (code: string) => Number(types.find((x) => x.code === code)!.id);
    await grantLeave(f.trx, f.orgId, null, { employeeId: f.a, leaveTypeId: t('CL'), kind: 'opening', days: 4, date: '2026-04-01' });
    const taken = await recordLeave(f.trx, f.orgId, null, { employeeId: f.a, leaveTypeId: t('CL'), from: '2026-05-04', to: '2026-05-06' });
    // Its own three days count back: four days in all is within the four held.
    await updateLeaveEntry(f.trx, f.orgId, taken, { from: '2026-05-04', to: '2026-05-07' });
    await assert.rejects(updateLeaveEntry(f.trx, f.orgId, taken, { from: '2026-05-04', to: '2026-05-08' }), /4 day\(s\) of casual leave/);
    const grant = await f.trx.selectFrom('leave_entries').select('id').where('employee_id', '=', f.a).where('kind', '=', 'opening').executeTakeFirstOrThrow();
    await assert.rejects(deleteLeaveEntry(f.trx, f.orgId, grant.id), /has taken leave against it/);

    const lop = await recordLeave(f.trx, f.orgId, null, { employeeId: f.a, leaveTypeId: t('LOP'), from: '2026-06-10', to: '2026-06-11' });
    const run = await prepareRun(f.trx, f.orgId, null, '2026-06');
    await postRun(f.trx, f.orgId, null, run);
    await assert.rejects(deleteLeaveEntry(f.trx, f.orgId, lop), /Jun 2026 payroll is posted/);
    await deleteLeaveEntry(f.trx, f.orgId, taken);
    assert.equal((await leaveBalances(f.trx, f.orgId, '2026-05-31')).get(f.a)!.get(t('CL')), 4, 'the days are back');

    await assert.rejects(deleteLeaveType(f.trx, f.orgId, t('CL')), /Mark it as inactive/);
    const spare = await saveLeaveType(f.trx, f.orgId, { code: 'ML', name: 'Marriage leave', paid: true, annualDays: 3, accrual: 'yearly', carryForwardMax: 0, encashable: false });
    await deleteLeaveType(f.trx, f.orgId, spare);
  });
});

test('a full and final settlement: edited in place while unpaid, deleted with its payment, its encashed leave given back', async () => {
  await withFixture(async (f) => {
    const types = await listLeaveTypes(f.trx, f.orgId);
    await grantLeave(f.trx, f.orgId, null, { employeeId: f.a, leaveTypeId: Number(types.find((x) => x.code === 'EL')!.id), kind: 'opening', days: 20, date: '2026-04-01' });
    const posted = await postFnf(f.trx, f.orgId, null, { employeeId: f.a, lastDay: '2026-06-30', encashDays: 10 });
    const gratuity = await balance(f, CODE.GRATUITY);
    assert.ok(gratuity > 0);

    const edited = await updateFnf(f.trx, f.orgId, null, posted.id, { employeeId: f.a, lastDay: '2026-06-30', encashDays: 5 });
    assert.equal(edited.id, posted.id, 'the same record');
    assert.equal(await balance(f, CODE.GRATUITY), gratuity, 'gratuity once, not twice');
    const encashed = await f.trx.selectFrom('leave_entries').select('days').where('employee_id', '=', f.a).where('kind', '=', 'encashed').execute();
    assert.deepEqual(encashed.map((e) => Number(e.days)), [5], 'the first encashment taken back');

    await payFnf(f.trx, f.orgId, null, posted.id, { bankAccountId: f.bankId, date: '2026-07-05' });
    await assert.rejects(updateFnf(f.trx, f.orgId, null, posted.id, { employeeId: f.a, lastDay: '2026-06-30' }), /paid on 2026-07-05/);
    await deleteFnf(f.trx, f.orgId, null, posted.id, 'worked out on the wrong salary');
    for (const code of [CODE.GRATUITY, CODE.SALARIES_PAYABLE, CODE.BANK_DEFAULT]) assert.equal(await balance(f, code), 0);
    assert.equal((await listFnf(f.trx, f.orgId)).length, 0);
    assert.equal((await f.trx.selectFrom('leave_entries').select('id').where('employee_id', '=', f.a).where('kind', '=', 'encashed').execute()).length, 0);
    assert.equal((await deleted(f, 'fnf')).length, 1);
  });
});

test('a statutory payment: edited within what is due, reversed on delete', async () => {
  await withFixture(async (f) => {
    const run = await prepareRun(f.trx, f.orgId, null, '2026-06');
    await postRun(f.trx, f.orgId, null, run);
    const pf = (await statutoryRegister(f.trx, f.orgId, '2026-06', '2026-06')).dues.find((d) => d.component === 'pf')!;
    const paid = await payStatutory(f.trx, f.orgId, null, { component: 'pf', period: '2026-06', amountPaise: R(1_000), date: '2026-07-10', bankAccountId: f.bankId });
    // The whole due can now be paid on the same record: what it paid before does not count against it.
    await updateStatutoryPayment(f.trx, f.orgId, null, paid.id, { component: 'pf', period: '2026-06', amountPaise: pf.duePaise, date: '2026-07-12', bankAccountId: f.bankId, reference: 'TRRN 1' });
    await assert.rejects(updateStatutoryPayment(f.trx, f.orgId, null, paid.id, {
      component: 'pf', period: '2026-06', amountPaise: pf.duePaise + 1, date: '2026-07-12', bankAccountId: f.bankId,
    }), /left to pay/);
    assert.equal(await balance(f, CODE.PF_PAYABLE), 0, 'the due cleared once');
    await deleteStatutoryPayment(f.trx, f.orgId, null, paid.id, null);
    assert.equal(await balance(f, CODE.PF_PAYABLE), -pf.duePaise, 'owed again');
    assert.equal(await balance(f, CODE.BANK_DEFAULT), 0);
    assert.equal((await verifyLedgerBalances(f.trx, f.orgId)).balanced, true);
  });
});
