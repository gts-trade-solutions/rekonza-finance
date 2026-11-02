// The timer and timesheet approval (migration 097): a timer per person that
// logs its time when stopped; and, with approval on, time that waits for
// someone else's approval before it can be billed.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/timesheet-timer.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts } from '../../lib/server/ledger/chart-of-accounts';
import { setPolicies } from '../../lib/server/services/org-settings';
import { decideTime, logTime, runningTimer, saveProject, startTimer, stopTimer, unbilled } from '../../lib/server/services/projects';

interface Book { trx: Trx; orgId: number; projectId: number; ravi: number; anita: number }

async function withBook(fn: (b: Book) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Hours Co' }).executeTakeFirstOrThrow()).insertId);
      await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1, gstin: '33AABCH4242H1Z7' }).execute();
      await installChartOfAccounts(trx, orgId);
      const customer = Number((await trx.insertInto('contacts').values({ org_id: orgId, kind: 'customer', display_name: 'Apex', state_code: '33', gst_treatment: 'unregistered' } as never).executeTakeFirstOrThrow()).insertId);
      const user = (name: string) => trx.insertInto('users').values({ org_id: orgId, name, email: `${name.toLowerCase()}-${orgId}@example.test`, role: 'staff' }).executeTakeFirstOrThrow().then((r) => Number(r.insertId));
      const projectId = await saveProject(trx, orgId, null, { customerId: customer, name: 'Audit support', billingMethod: 'project_hours', ratePaise: 1_000_00 });
      await fn({ trx, orgId, projectId, ravi: await user('Ravi'), anita: await user('Anita') });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

test('timer: one per person; stopping logs the minutes on the day it started; discarding logs nothing', async () => {
  await withBook(async ({ trx, orgId, projectId, ravi, anita }) => {
    assert.equal(await runningTimer(trx, orgId, ravi), null);
    const t = await startTimer(trx, orgId, ravi, { projectId, notes: 'Vouching' });
    assert.equal(t?.projectName, 'Audit support');
    await assert.rejects(startTimer(trx, orgId, ravi, { projectId }), /already running/);
    await startTimer(trx, orgId, anita, { projectId }); // someone else's runs alongside

    // Started 95 minutes ago (as the clock sees it): stopping logs 95 minutes.
    const started = new Date((await trx.selectFrom('time_timers').select('started_at').where('user_id', '=', ravi).executeTakeFirstOrThrow()).started_at);
    const r = await stopTimer(trx, orgId, ravi, { now: new Date(started.getTime() + 95 * 60_000 + 20_000) });
    assert.equal(r.minutes, 95);
    const entry = await trx.selectFrom('time_entries').select(['minutes', 'notes', 'user_id', 'entry_date', 'approval_status']).where('id', '=', r.entryId!).executeTakeFirstOrThrow();
    assert.deepEqual([entry.minutes, entry.notes, entry.user_id, entry.approval_status], [95, 'Vouching', ravi, null]);
    assert.equal(String(entry.entry_date).slice(0, 10), new Date(started.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10), 'the India date it started');
    assert.equal(await runningTimer(trx, orgId, ravi), null);
    await assert.rejects(stopTimer(trx, orgId, ravi), /not running/);

    const d = await stopTimer(trx, orgId, anita, { discard: true });
    assert.deepEqual(d, { entryId: null, minutes: 0 });
    assert.equal((await trx.selectFrom('time_entries').select('id').where('user_id', '=', anita).execute()).length, 0);
  });
});

test('approval: with it on, time waits; only someone else approves; turned-back time needs a reason; only approved time bills', async () => {
  await withBook(async ({ trx, orgId, projectId, ravi, anita }) => {
    const before = await logTime(trx, orgId, ravi, { projectId, userId: ravi, date: '2026-10-01', minutes: 60 });
    await setPolicies(trx, orgId, null, { controls: { timesheetApproval: true } as never });
    const a = await logTime(trx, orgId, ravi, { projectId, userId: ravi, date: '2026-10-02', minutes: 120 });
    const b = await logTime(trx, orgId, ravi, { projectId, userId: ravi, date: '2026-10-03', minutes: 30 });
    const status = async (id: number) => (await trx.selectFrom('time_entries').select('approval_status').where('id', '=', id).executeTakeFirstOrThrow()).approval_status;
    assert.equal(await status(before), null, 'time logged while approval was off bills as before');
    assert.equal(await status(a), 'pending');

    const minutesToBill = async () => (await unbilled(trx, orgId, projectId)).time.reduce((t, l) => t + l.minutes, 0);
    assert.equal(await minutesToBill(), 60, 'pending time is not billed');

    await assert.rejects(decideTime(trx, orgId, ravi, [a], 'approved'), /approved by someone else/);
    await assert.rejects(decideTime(trx, orgId, anita, [b], 'rejected'), /Say why/);
    assert.deepEqual(await decideTime(trx, orgId, anita, [a], 'approved'), { count: 1, people: [ravi] });
    await decideTime(trx, orgId, anita, [b], 'rejected', 'Wrong project');
    await assert.rejects(decideTime(trx, orgId, anita, [a], 'rejected', 'x'), /Only time waiting/);
    assert.equal(await status(b), 'rejected');
    assert.equal(await minutesToBill(), 180, 'approved and pre-approval time bill; turned-back time does not');
  });
});

test.after(() => db.destroy());
