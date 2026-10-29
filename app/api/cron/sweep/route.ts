import { NextResponse } from 'next/server';
import { runDueJobs } from '@/lib/server/jobs/worker';
import { deliverDueWebhooks } from '@/lib/server/integrations/webhooks';
import { runScheduledPostings } from '@/lib/server/services/scheduler';
import { runDueReports } from '@/lib/server/services/report-schedules';
import { runStockAlerts } from '@/lib/server/services/stock-alerts';
import { runReminders } from '@/lib/server/services/reminders';
import { runExceptions } from '@/lib/server/services/exceptions';
import { runAutoIrn } from '@/lib/server/gst/auto-irn';
import { runAutoDepreciation } from '@/lib/server/services/fixed-assets';
import { runStockTrueUp } from '@/lib/server/services/stock-ledger';

// ─────────────────────────────────────────────────────────────────────────────
// The background work, run on a schedule where no server stays up between
// requests (Vercel). The same work the worker loop does on a long-running
// server: retries of queued jobs, webhooks, post-dated and recurring entries,
// scheduled reports, stock alerts, payment reminders, IRNs for new invoices,
// month-end depreciation and stock, and the exceptions register.
//
// Vercel's scheduler calls it with "Authorization: Bearer <CRON_SECRET>"; any
// other caller is refused, and with no CRON_SECRET set everyone is.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Not allowed.' }, { status: 401 });
  }
  const done: Record<string, unknown> = {};
  // Each part on its own: one failing does not stop the rest.
  const step = async (name: string, fn: () => Promise<unknown>) => {
    try { done[name] = await fn(); } catch (err) { done[name] = { error: err instanceof Error ? err.message : String(err) }; }
  };
  // IRNs first, so the jobs step below registers them in the same call.
  await step('autoIrn', () => runAutoIrn());
  await step('jobs', () => runDueJobs(25));
  await step('webhooks', () => deliverDueWebhooks(50));
  await step('scheduled', () => runScheduledPostings());
  await step('reports', () => runDueReports());
  await step('stockAlerts', () => runStockAlerts());
  await step('reminders', () => runReminders());
  await step('depreciation', () => runAutoDepreciation());
  await step('stock', () => runStockTrueUp());
  await step('exceptions', () => runExceptions());
  return NextResponse.json({ ok: true, ...done });
}
