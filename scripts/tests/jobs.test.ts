// The retry queue, against real MySQL, inside rolled-back transactions.
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/jobs.test.ts
//
// The handlers are stand-ins here. What is under test is the queue itself:
// when a retry runs, how many times, and what an outage, a refusal and a
// success each leave behind.

import test from 'node:test';
import assert from 'node:assert/strict';
import { db, type Trx } from '../../lib/server/db';
import { ApiError } from '../../lib/server/http';
import {
  RETRY_DELAYS_MIN, claimDueJob, enqueueRetry, queuedRetries, recoverStaleJobs, retryAfterOutage, settleJob,
  type ClaimedJob,
} from '../../lib/server/jobs/queue';
import { runJobHandler } from '../../lib/server/jobs/handlers';

const MIN = 60_000;
const NOW = new Date('2026-09-12T10:00:00+05:30');
const at = (minutes: number) => new Date(NOW.getTime() + minutes * MIN);

async function withOrg(fn: (f: { trx: Trx; orgId: number }) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const org = await trx.insertInto('organizations').values({ name: 'Jobs Test Co' }).executeTakeFirstOrThrow();
      await fn({ trx, orgId: Number(org.insertId) });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

const outage = () => new ApiError(503, 'The e-invoice portal did not answer.', 'portal_unavailable');

const queueOne = (trx: Trx, orgId: number, key = 'invoice:1') =>
  enqueueRetry(trx, {
    orgId, kind: 'einvoice.register', key, payload: { invoiceId: Number(key.split(':')[1]) }, userId: null, now: NOW,
  });

const statusOf = async (trx: Trx, id: number) =>
  trx.selectFrom('jobs').select(['status', 'attempts', 'run_after', 'last_error']).where('id', '=', id).executeTakeFirstOrThrow();

// ── Queueing ─────────────────────────────────────────────────────────────────

test('an outage queues one retry per document, however often it is reported', async () => {
  await withOrg(async ({ trx, orgId }) => {
    const first = await queueOne(trx, orgId);
    const again = await enqueueRetry(trx, {
      orgId, kind: 'einvoice.register', key: 'invoice:1', payload: { invoiceId: 1 }, userId: null, now: at(1),
    });
    assert.equal(again.id, first.id);
    assert.equal(first.runAfter.getTime(), at(RETRY_DELAYS_MIN[0]).getTime());

    // Counted as a person counts: their own attempt was the first try.
    const shown = (await queuedRetries(trx, orgId, 'einvoice.register')).get('invoice:1');
    assert.deepEqual(shown, { at: at(RETRY_DELAYS_MIN[0]).toISOString(), attempt: 2, of: 4 });
  });
});

test('a job waits for its time, and each claim counts an attempt', async () => {
  await withOrg(async ({ trx, orgId }) => {
    const { id } = await queueOne(trx, orgId);
    assert.equal(await claimDueJob(trx, 'test-worker', at(1), { orgId }), null, 'not due yet');

    const job = await claimDueJob(trx, 'test-worker', at(3), { orgId });
    assert.equal(job?.id, id);
    assert.equal(job?.attempts, 1);
    assert.deepEqual(job?.payload, { invoiceId: 1, key: 'invoice:1' });
    const row = await trx.selectFrom('jobs').select(['status', 'locked_by']).where('id', '=', id).executeTakeFirstOrThrow();
    assert.deepEqual({ ...row }, { status: 'running', locked_by: 'test-worker' });
    assert.equal(await claimDueJob(trx, 'test-worker', at(3), { orgId }), null, 'a running job is not claimed twice');
  });
});

// ── Settling ─────────────────────────────────────────────────────────────────

test('an outage is tried again later and later, then given up', async () => {
  await withOrg(async ({ trx, orgId }) => {
    const { id } = await queueOne(trx, orgId);

    let job = (await claimDueJob(trx, 'w', at(3), { orgId }))!;
    assert.equal(await settleJob(trx, job, { kind: 'retry', error: 'down' }, at(3)), 'queued');
    assert.equal((await statusOf(trx, id)).run_after?.getTime(), at(3 + RETRY_DELAYS_MIN[1]).getTime());

    job = (await claimDueJob(trx, 'w', at(14), { orgId }))!;
    assert.equal(await settleJob(trx, job, { kind: 'retry', error: 'down' }, at(14)), 'queued');
    assert.equal((await statusOf(trx, id)).run_after?.getTime(), at(14 + RETRY_DELAYS_MIN[2]).getTime());

    job = (await claimDueJob(trx, 'w', at(45), { orgId }))!;
    assert.equal(await settleJob(trx, job, { kind: 'retry', error: 'still down' }, at(45)), 'failed');
    const final = await statusOf(trx, id);
    assert.equal(final.status, 'failed');
    assert.equal(final.attempts, 3);
    assert.equal(final.last_error, 'still down');
  });
});

test('a success completes the job, and a refusal fails it at once', async () => {
  await withOrg(async ({ trx, orgId }) => {
    const ok = await queueOne(trx, orgId, 'invoice:1');
    const refused = await queueOne(trx, orgId, 'invoice:2');

    const a = (await claimDueJob(trx, 'w', at(3), { orgId }))!;
    const b = (await claimDueJob(trx, 'w', at(3), { orgId }))!;
    assert.deepEqual([a.id, b.id].sort(), [ok.id, refused.id].sort());

    const jobs = new Map([[a.id, a], [b.id, b]]);
    assert.equal(await settleJob(trx, jobs.get(ok.id)!, { kind: 'done', result: { irn: 'X' } }, at(3)), 'completed');
    assert.equal(await settleJob(trx, jobs.get(refused.id)!, { kind: 'fail', error: 'Refused.' }, at(3)), 'failed');
    assert.equal((await statusOf(trx, ok.id)).status, 'completed');
    assert.equal((await statusOf(trx, refused.id)).status, 'failed');
    assert.equal((await queuedRetries(trx, orgId, 'einvoice.register')).size, 0, 'nothing left waiting');
  });
});

test('a job whose worker went away is put back', async () => {
  await withOrg(async ({ trx, orgId }) => {
    const { id } = await queueOne(trx, orgId);
    await claimDueJob(trx, 'gone', at(3), { orgId });
    assert.equal(await recoverStaleJobs(trx, at(8), { orgId }), 0, 'five minutes is not stale');
    assert.equal(await recoverStaleJobs(trx, at(20), { orgId }), 1);
    assert.equal((await statusOf(trx, id)).status, 'queued');
  });
});

// ── Reading what a handler threw ─────────────────────────────────────────────

test('what a handler throws decides what happens next', async () => {
  const job: ClaimedJob = {
    id: 0, org_id: 0, kind: 'x', payload: {}, attempts: 1, max_attempts: 3, created_by_user_id: null,
  };
  const run = (handler: () => Promise<unknown>) => runJobHandler(job, { x: handler });

  assert.equal((await run(async () => { throw outage(); })).kind, 'retry');
  assert.equal(
    (await run(async () => { throw new ApiError(409, 'INV/1 already has an IRN.', 'conflict'); })).kind,
    'done',
    'registered by hand while the retry waited',
  );
  assert.equal((await run(async () => { throw new ApiError(422, 'The portal refused it.', 'portal_rejected'); })).kind, 'fail');
  assert.deepEqual(await run(async () => ({ irn: 'X' })), { kind: 'done', result: { irn: 'X' } });
  assert.equal((await runJobHandler({ ...job, kind: 'unknown' }, {})).kind, 'fail');
});

test('an outage at the door becomes a queued retry with its time; anything else passes through', async () => {
  await withOrg(async ({ trx, orgId }) => {
    const common = { orgId, kind: 'einvoice.register' as const, userId: null, ex: trx, now: NOW };

    await assert.rejects(
      retryAfterOutage(outage(), { ...common, key: 'invoice:9', payload: { invoiceId: 9 } }),
      (err: unknown) =>
        err instanceof ApiError && err.status === 503 && /tried again automatically at [0-9]{2}:[0-9]{2}/.test(err.message),
    );
    assert.ok((await queuedRetries(trx, orgId, 'einvoice.register')).has('invoice:9'));

    const refusal = new ApiError(422, 'Refused.', 'portal_rejected');
    await assert.rejects(
      retryAfterOutage(refusal, { ...common, key: 'invoice:10', payload: { invoiceId: 10 } }),
      (err: unknown) => err === refusal,
    );
    assert.ok(!(await queuedRetries(trx, orgId, 'einvoice.register')).has('invoice:10'));
  });
});

test.after(async () => {
  await db.destroy();
});
