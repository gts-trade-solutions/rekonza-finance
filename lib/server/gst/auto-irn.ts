import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// IRNs without anyone pressing Register.
//
// An invoice that needs an IRN is not a valid tax invoice until it has one,
// and waiting for someone to open the e-invoice register is how thirty of them
// pile up. With the book's control on (Settings → Controls, on by default),
// every invoice that needs an IRN and has never been tried is queued for the
// same registration job a failed attempt is retried by: the worker runs it
// within seconds, an outage is tried again on the usual schedule, and a
// refusal is left for a person — it becomes an "IRN refused" exception with
// the IRP's reason (services/exceptions.ts).
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import { db, type Executor } from '../db';
import { enqueueNow } from '../jobs/queue';
import { getPolicies } from '../services/org-settings';

/** Queue every untried invoice of one book. Returns how many were queued. */
export async function queueIrns(ex: Executor, orgId: number, opts: { invoiceId?: number; userId?: number | null } = {}): Promise<number> {
  if (!(await getPolicies(ex, orgId)).controls.autoIrn) return 0;
  const waiting = await ex.selectFrom('einvoices as e').innerJoin('invoices as i', 'i.id', 'e.invoice_id')
    .select('i.id').where('e.org_id', '=', orgId).where('e.status', '=', 'pending').where('e.attempts', '=', 0)
    .where('i.status', 'not in', ['draft', 'void'])
    .$if(!!opts.invoiceId, (q) => q.where('i.id', '=', opts.invoiceId!))
    .limit(200).execute();
  // One automatic attempt per invoice. A job that gave up (no GST connection,
  // say) is not queued again every sweep: the invoice stays pending, and after
  // a day it is an exception for a person (services/exceptions.ts).
  const tried = new Set((await ex.selectFrom('jobs').select(sql<string>`JSON_UNQUOTE(JSON_EXTRACT(payload, '$.key'))`.as('k'))
    .where('org_id', '=', orgId).where('kind', '=', 'einvoice.register').execute()).map((j) => j.k));
  let queued = 0;
  for (const w of waiting) {
    if (tried.has(`invoice:${w.id}`)) continue;
    const id = await enqueueNow(ex, {
      orgId, kind: 'einvoice.register', key: `invoice:${w.id}`, payload: { invoiceId: w.id }, userId: opts.userId ?? null,
    });
    if (id) queued++;
  }
  return queued;
}

/** Every book, from the scheduler. */
export async function runAutoIrn(): Promise<number> {
  const orgs = await db.selectFrom('organizations').select('id').execute();
  let n = 0;
  for (const o of orgs) {
    try {
      n += await queueIrns(db, Number(o.id));
    } catch (err) {
      console.error(`[auto-irn] org ${o.id} failed`, err);
    }
  }
  return n;
}
