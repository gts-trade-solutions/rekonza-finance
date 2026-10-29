import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// The worker that runs queued retries, inside the server process.
//
// The same shape as the email app's: started once per process, ticking on a
// timer, claiming one due job at a time. A retry is due minutes after it was
// queued, so a tick every fifteen seconds runs it close enough to its time.
//
// JOBS_WORKER=off keeps it from starting, for a process that should only serve
// pages while another one runs the queue.
// ─────────────────────────────────────────────────────────────────────────────

import { randomUUID } from 'node:crypto';
import { db, transaction } from '../db';
import { claimDueJob, recoverStaleJobs, settleJob } from './queue';
import { runJobHandler } from './handlers';
import { runScheduledPostings } from '../services/scheduler';
import { deliverDueWebhooks } from '../integrations/webhooks';
import { runDueReports } from '../services/report-schedules';
import { runStockAlerts } from '../services/stock-alerts';
import { runReminders } from '../services/reminders';
import { runExceptions } from '../services/exceptions';
import { runAutoIrn } from '../gst/auto-irn';
import { runAutoDepreciation } from '../services/fixed-assets';
import { runStockTrueUp } from '../services/stock-ledger';

const TICK_MS = Number(process.env.JOBS_TICK_MS) || 15_000;
/** How often the scheduler looks for post-dated entries and recurring profiles due. */
const SCHEDULE_MS = Number(process.env.SCHEDULER_TICK_MS) || 10 * 60_000;
let lastSweep = 0;
/** Names this process on the rows it claims, so a stuck row says whose it was. */
export const WORKER_ID = `${process.pid}:${randomUUID().slice(0, 8)}`;

/** Run what is due now, up to `limit` jobs. Returns how many ran. */
export async function runDueJobs(limit = 10): Promise<number> {
  await recoverStaleJobs(db);
  let ran = 0;
  while (ran < limit) {
    const job = await transaction((trx) => claimDueJob(trx, WORKER_ID, new Date()));
    if (!job) break;
    const outcome = await runJobHandler(job);
    const status = await settleJob(db, job, outcome);
    if (status !== 'completed') {
      console.warn(`[jobs] ${job.kind} #${job.id} ${status} after attempt ${job.attempts}:`, 'error' in outcome ? outcome.error : '');
    }
    ran++;
  }
  return ran;
}

export function startJobWorker(): void {
  const g = globalThis as typeof globalThis & { __rekonzaJobWorker?: boolean };
  // On Vercel nothing keeps a process alive between requests: the cron route
  // (app/api/cron/sweep) runs the same work on a schedule instead.
  if (g.__rekonzaJobWorker || process.env.JOBS_WORKER === 'off' || process.env.VERCEL) return;
  g.__rekonzaJobWorker = true;

  const tick = async () => {
    try {
      await runDueJobs();
    } catch (err) {
      console.error('[jobs] tick failed', err);
    }
    try {
      await deliverDueWebhooks();
    } catch (err) {
      console.error('[webhooks] delivery failed', err);
    }
    try {
      if (Date.now() - lastSweep >= SCHEDULE_MS) {
        lastSweep = Date.now();
        // Invoices the routes did not queue for their IRN (recurring, approved
        // later): queued here and registered on the next tick.
        const irns = await runAutoIrn();
        if (irns) console.info('[auto-irn] queued:', irns);
        const r = await runScheduledPostings();
        if (r.posted || r.held || r.failed || r.behind) console.info('[scheduler]', r);
        const reports = await runDueReports();
        if (reports) console.info('[scheduler] reports made:', reports);
        const alerts = await runStockAlerts();
        if (alerts) console.info('[scheduler] stock alerts sent:', alerts);
        const reminders = await runReminders();
        if (reminders) console.info('[scheduler] payment reminders queued:', reminders);
        const depreciation = await runAutoDepreciation();
        if (depreciation) console.info('[scheduler] depreciation runs posted:', depreciation);
        const stock = await runStockTrueUp();
        if (stock) console.info('[scheduler] stock brought into line:', stock);
        // Last, so it sees what the rest of the sweep did.
        const raised = await runExceptions();
        if (raised) console.info('[scheduler] exceptions raised:', raised);
      }
    } catch (err) {
      console.error('[scheduler] sweep failed', err);
    } finally {
      setTimeout(tick, TICK_MS).unref?.();
    }
  };
  setTimeout(tick, TICK_MS).unref?.();
}
