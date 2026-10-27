// Optional and post-dated journals, journal approvals, and the scheduler.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/held-journals.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { verifyLedgerBalances } from '../../lib/server/ledger/posting';
import { postManualJournal } from '../../lib/server/services/journals';
import { approveHeldJournal, discardHeldJournal, indiaToday, listHeldJournals, rejectHeldJournal, releaseHeldJournal, saveJournal } from '../../lib/server/services/held-journals';
import { pendingApprovals, saveRule } from '../../lib/server/services/approvals';
import { advancePeriod } from '../../lib/server/services/recurring';
import { runScheduledPostings } from '../../lib/server/services/scheduler';

interface Fixture { trx: Trx; orgId: number; branchId: number; acc: Record<string, number>; maker: number; checker: number }

async function withFixture(fn: (f: Fixture) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Held Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1 }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const user = async (name: string, role: 'admin' | 'accountant') =>
        Number((await trx.insertInto('users').values({ org_id: orgId, name, email: `${name}-${orgId}@example.test`, role }).executeTakeFirstOrThrow()).insertId);
      await fn({ trx, orgId, branchId, acc: await accountIds(trx, orgId), maker: await user('maker', 'accountant'), checker: await user('checker', 'admin') });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

const rent = (f: Fixture, date: string, rupees: number) => ({
  branchId: f.branchId, date, memo: `Rent ${date}`,
  lines: [{ accountId: f.acc[CODE.RENT], debitPaise: rupees * 100 }, { accountId: f.acc[CODE.CASH], creditPaise: rupees * 100 }],
});
const entries = async (f: Fixture) =>
  Number((await f.trx.selectFrom('journal_entries').select((eb) => eb.fn.countAll<string>().as('n')).where('org_id', '=', f.orgId).executeTakeFirstOrThrow()).n);

test('India keeps its own date; periods roll to month ends', () => {
  assert.equal(indiaToday(new Date('2026-10-25T19:00:00Z')), '2026-10-26', 'half past midnight in India is already the 26th');
  assert.equal(advancePeriod('2026-01-31', 'monthly'), '2026-02-28');
  assert.equal(advancePeriod('2026-11-30', 'quarterly'), '2027-02-28');
  assert.equal(advancePeriod('2026-12-29', 'weekly'), '2027-01-05');
});

test('an optional voucher counts nowhere until posted; a discarded one never does', async () => {
  await withFixture(async (f) => {
    const kept = await saveJournal(f.trx, f.orgId, f.maker, rent(f, '2026-06-30', 5_000), 'optional');
    const dropped = await saveJournal(f.trx, f.orgId, f.maker, rent(f, '2026-06-30', 7_000), 'optional');
    assert.ok(kept.held && dropped.held);
    assert.equal(await entries(f), 0);
    assert.equal((await listHeldJournals(f.trx, f.orgId)).length, 2);
    await assert.rejects(saveJournal(f.trx, f.orgId, f.maker, { ...rent(f, '2026-06-30', 1), lines: [{ accountId: f.acc[CODE.RENT], debitPaise: 100 }, { accountId: f.acc[CODE.CASH], creditPaise: 90 }] }, 'optional'), /do not agree/);

    const r = await releaseHeldJournal(f.trx, f.orgId, f.maker, kept.id);
    assert.ok(r.posted);
    await discardHeldJournal(f.trx, f.orgId, f.maker, dropped.id);
    assert.equal(await entries(f), 1);
    await assert.rejects(releaseHeldJournal(f.trx, f.orgId, f.maker, dropped.id), /already discarded/);
    assert.equal((await listHeldJournals(f.trx, f.orgId)).length, 0);
  });
});

test('a post-dated voucher waits for its day; the scheduler posts it then, and keeps what stopped it', async () => {
  await withFixture(async (f) => {
    const today = indiaToday();
    await assert.rejects(saveJournal(f.trx, f.orgId, f.maker, rent(f, today, 100), 'post_dated'), /dated after today/);
    const later = advancePeriod(today, 'monthly');
    const pd = await saveJournal(f.trx, f.orgId, f.maker, rent(f, later, 9_000), 'post_dated');
    assert.ok(pd.held);

    assert.deepEqual(await runScheduledPostings({ trx: f.trx, orgId: f.orgId }), { posted: 0, held: 0, failed: 0, behind: 0 }, 'not yet');
    const onTheDay = new Date(`${later}T06:00:00Z`);
    // A lock on the period stops it, and it is tried again once lifted.
    await f.trx.insertInto('transaction_locks').values({ org_id: f.orgId, module: 'accountant', locked_upto: later, reason: 'Audit' } as never).execute();
    assert.equal((await runScheduledPostings({ trx: f.trx, orgId: f.orgId, now: onTheDay })).failed, 1);
    assert.match((await listHeldJournals(f.trx, f.orgId))[0].lastError ?? '', /lock|closed/i);
    await f.trx.deleteFrom('transaction_locks').where('org_id', '=', f.orgId).execute();
    assert.equal((await runScheduledPostings({ trx: f.trx, orgId: f.orgId, now: onTheDay })).posted, 1);
    const je = await f.trx.selectFrom('journal_entries').select(['entry_date', 'posted_by_user_id']).where('org_id', '=', f.orgId).executeTakeFirstOrThrow();
    assert.equal(String(je.entry_date).slice(0, 10), later);
    assert.equal(je.posted_by_user_id, f.maker, 'posted in the name of whoever entered it');
  });
});

test('a journal rule holds big entries for a second person; nothing goes round it', async () => {
  await withFixture(async (f) => {
    await saveRule(f.trx, f.orgId, { documentType: 'journal', thresholdPaise: 1_00_000_00, approverRole: 'admin', isActive: true });
    const small = await saveJournal(f.trx, f.orgId, f.maker, rent(f, '2026-06-30', 50_000));
    assert.equal(small.held, false, 'below the line it posts as ever');

    await assert.rejects(postManualJournal(f.trx, f.orgId, f.maker, rent(f, '2026-06-30', 2_00_000)), /need approval/);
    const big = await saveJournal(f.trx, f.orgId, f.maker, rent(f, '2026-06-30', 2_00_000));
    assert.ok(big.held && big.kind === 'approval' && big.approverRole === 'admin');
    const pending = await pendingApprovals(f.trx, f.orgId);
    assert.deepEqual(pending.map((p) => [p.documentType, p.totalPaise]), [['journal', 2_00_000_00]]);

    await assert.rejects(approveHeldJournal(f.trx, f.orgId, { userId: f.maker, role: 'admin' }, big.id), /Someone else/);
    await assert.rejects(approveHeldJournal(f.trx, f.orgId, { userId: 999_999, role: 'accountant' }, big.id), /needs approval by an admin/);
    await approveHeldJournal(f.trx, f.orgId, { userId: f.checker, role: 'admin' }, big.id, 'Agreed with the lease');
    assert.equal(await entries(f), 2);

    // An optional voucher caught by the rule goes for approval when released.
    const opt = await saveJournal(f.trx, f.orgId, f.maker, rent(f, '2026-07-31', 3_00_000), 'optional');
    assert.ok(opt.held);
    const released = await releaseHeldJournal(f.trx, f.orgId, f.maker, opt.id);
    assert.equal(released.posted, false);
    await rejectHeldJournal(f.trx, f.orgId, { userId: f.checker, role: 'admin' }, opt.id, 'Not agreed yet');
    assert.equal(await entries(f), 2);
    assert.equal((await pendingApprovals(f.trx, f.orgId)).length, 0);
    assert.ok((await verifyLedgerBalances(f.trx, f.orgId)).balanced);
  });
});

test('the scheduler runs recurring profiles set to run on their own, one period at a time', async () => {
  await withFixture(async (f) => {
    const today = indiaToday();
    const profile = async (nextRun: string, autoRun: number) => Number((await f.trx.insertInto('recurring_journals').values({
      org_id: f.orgId, branch_id: f.branchId, name: `Depreciation ${nextRun}`, frequency: 'monthly', next_run: nextRun,
      debit_account_id: f.acc[CODE.RENT], credit_account_id: f.acc[CODE.CASH], amount: '1000.00', is_active: 1, auto_run: autoRun,
    } as never).executeTakeFirstOrThrow()).insertId);
    const due = await profile(today, 1);
    await profile(today, 0); // by hand only
    const behind = await profile('2020-01-31', 1);

    const r = await runScheduledPostings({ trx: f.trx, orgId: f.orgId });
    assert.deepEqual([r.posted, r.behind, r.failed], [1, 1, 0]);
    const after = await f.trx.selectFrom('recurring_journals').select(['id', 'next_run', 'last_error']).where('id', 'in', [due, behind]).orderBy('id').execute();
    assert.equal(String(after[0].next_run).slice(0, 10), advancePeriod(today, 'monthly'));
    assert.match(after[1].last_error ?? '', /Missed the run due 2020-01-31/);
    assert.equal((await runScheduledPostings({ trx: f.trx, orgId: f.orgId })).posted, 0, 'and not twice the same day');
  });
});

test.after(async () => {
  await db.destroy();
});
