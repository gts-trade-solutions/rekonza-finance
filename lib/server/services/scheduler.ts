import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// The scheduler: what posts itself when its day comes.
//
//   post-dated journals    posted on their date (held-journals.ts)
//   recurring journals     run on their next date, if set to run on their own
//   recurring invoices     the same
//
// Each item runs in its own transaction, as the person it stands in for would,
// so one locked period or missing account stops that item and nothing else.
// What stopped it is kept on the row for the screen to show, and it is tried
// again on the next sweep: unlocking the period is enough to let it through.
//
// A recurring profile more than one period behind is not caught up: the
// scheduler marks it and leaves it, for the same reason "Run now" posts one
// period at a time. Six back-dated invoices arriving at once help nobody.
// ─────────────────────────────────────────────────────────────────────────────

import { db, transaction, type Trx } from '../db';
import { logAudit } from '../audit';
import { indiaToday, releaseHeldJournal } from './held-journals';
import { advancePeriod, runRecurringInvoice, runRecurringJournal, type Frequency } from './recurring';

const ACTOR = 'Scheduler';
const message = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 500);

export interface SweepResult { posted: number; held: number; failed: number; behind: number }

/**
 * Run everything due today. `trx` and `orgId` confine the sweep to one
 * transaction and one organisation, which is how the tests drive it.
 */
export async function runScheduledPostings(opts: { now?: Date; trx?: Trx; orgId?: number } = {}): Promise<SweepResult> {
  const today = indiaToday(opts.now);
  const ex = opts.trx ?? db;
  const run = <T>(fn: (trx: Trx) => Promise<T>) => (opts.trx ? fn(opts.trx) : transaction(fn));
  const result: SweepResult = { posted: 0, held: 0, failed: 0, behind: 0 };

  let held = ex.selectFrom('held_journals').select(['id', 'org_id', 'memo'])
    .where('status', '=', 'held').where('kind', '=', 'post_dated').where('entry_date', '<=', today);
  if (opts.orgId) held = held.where('org_id', '=', opts.orgId);
  for (const h of await held.execute()) {
    try {
      const out = await run(async (trx) => {
        const r = await releaseHeldJournal(trx, h.org_id, null, h.id);
        await logAudit({
          trx, orgId: h.org_id, actorUserId: null, actorName: ACTOR, action: 'create',
          targetType: r.posted ? 'journal_entry' : 'held_journal', targetId: r.posted ? r.entry.id : h.id,
          detail: r.posted ? `Post-dated entry posted on its date: ${h.memo}` : `Post-dated entry due today sent for ${r.approverRole} approval: ${h.memo}`,
        });
        return r;
      });
      if (out.posted) result.posted++; else result.held++;
    } catch (err) {
      result.failed++;
      await ex.updateTable('held_journals').set({ last_error: message(err) }).where('id', '=', h.id).execute();
    }
  }

  for (const table of ['recurring_journals', 'recurring_invoices'] as const) {
    let due = ex.selectFrom(table).select(['id', 'org_id', 'next_run', 'end_date', 'frequency', 'last_error'])
      .where('is_active', '=', 1).where('auto_run', '=', 1).where('next_run', '<=', today);
    if (opts.orgId) due = due.where('org_id', '=', opts.orgId);
    for (const p of await due.execute()) {
      const next = String(p.next_run).slice(0, 10);
      if (p.end_date && next > String(p.end_date).slice(0, 10)) continue;
      if (advancePeriod(next, p.frequency as Frequency) <= today) {
        result.behind++;
        const note = `Missed the run due ${next}, and more since. Run the missed periods by hand; the scheduler carries on from the current one.`;
        if (p.last_error !== note) await ex.updateTable(table).set({ last_error: note }).where('id', '=', p.id).execute();
        continue;
      }
      try {
        await run(async (trx) => {
          if (table === 'recurring_journals') {
            const r = await runRecurringJournal(trx, p.org_id, null, p.id);
            await logAudit({
              trx, orgId: p.org_id, actorUserId: null, actorName: ACTOR, action: 'create',
              targetType: 'recurring_journal', targetId: p.id, targetLabel: r.name,
              detail: `Posted JE #${r.entry.entryNo} for ${(r.amountPaise / 100).toFixed(2)} on ${r.runDate}`,
            });
          } else {
            const r = await runRecurringInvoice(trx, p.org_id, null, p.id);
            await logAudit({
              trx, orgId: p.org_id, actorUserId: null, actorName: ACTOR, action: 'create',
              targetType: 'recurring_invoice', targetId: p.id, targetLabel: r.name,
              detail: `Generated invoice ${r.invoice.number} for ${(r.invoice.totalPaise / 100).toFixed(2)}`,
            });
          }
        });
        result.posted++;
      } catch (err) {
        result.failed++;
        await ex.updateTable(table).set({ last_error: message(err) }).where('id', '=', p.id).execute();
      }
    }
  }
  return result;
}
