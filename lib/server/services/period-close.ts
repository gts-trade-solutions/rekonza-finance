import 'server-only';

// ─────────────────────────────────────────────────────────────────────────────
// Is a period ready to close?
//
// Every count here is a live query, not a stored checklist somebody ticks off.
// A checklist you tick is a record of what you believed at the time; these are
// what is actually true right now, which is the only version worth blocking a
// close on. A month is closed with a transaction lock; a year with the
// year-end close in year-end.ts, which asks these same questions and two more.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from 'kysely';
import type { Executor } from '../db';
import { trialBalance } from '../reports/statements';
import { nextRunFrom } from './fixed-assets';
import { openingSummary } from './opening-balances';
import { CODE } from '../ledger/chart-of-accounts';
import { rule37 } from '../gst/itc-reversals';

export interface CloseCheck {
  id: string;
  label: string;
  detail: string;
  count: number;
  href: string;
  /** A blocker stops the close; the rest are worth a look. */
  blocking: boolean;
}

/**
 * The checks for closing everything up to `to`. Most look at all that is still
 * open by then, not only what falls inside the period, so `_from` is kept for
 * the screens that show a range but does not narrow anything.
 */
export async function closeChecks(
  ex: Executor, orgId: number, _from: string, to: string, opts: { yearEnd?: boolean } = {},
): Promise<{ checks: CloseCheck[]; passed: number; blockers: number }> {
  const count = async (fn: () => Promise<{ n: string } | undefined>) => Number((await fn())?.n ?? 0);

  const [tb, unreconciled, drafts, noIrn, itcRisk, unapplied, openBills] = await Promise.all([
    trialBalance(ex, orgId, to),
    count(() => ex.selectFrom('bank_transactions').select(sql<string>`COUNT(*)`.as('n'))
      .where('org_id', '=', orgId).where('status', '=', 'unmatched').where('txn_date', '<=', to).executeTakeFirst()),
    count(() => ex.selectFrom('invoices').select(sql<string>`COUNT(*)`.as('n'))
      .where('org_id', '=', orgId).where('status', '=', 'draft').where('invoice_date', '<=', to).executeTakeFirst()),
    count(() => ex.selectFrom('einvoices').innerJoin('invoices', 'invoices.id', 'einvoices.invoice_id')
      .select(sql<string>`COUNT(*)`.as('n'))
      .where('einvoices.org_id', '=', orgId).where('einvoices.status', 'in', ['pending', 'failed'])
      .where('invoices.invoice_date', '<=', to).executeTakeFirst()),
    count(() => ex.selectFrom('gstr2b_entries').select(sql<string>`COUNT(*)`.as('n'))
      .where('org_id', '=', orgId).where('match_status', '<>', 'matched').executeTakeFirst()),
    count(() => ex.selectFrom('payments').select(sql<string>`COUNT(*)`.as('n'))
      .where('org_id', '=', orgId).where('status', '<>', 'void').where('unapplied_amount', '>', '0')
      .where('payment_date', '<=', to).executeTakeFirst()),
    count(() => ex.selectFrom('bills').select(sql<string>`COUNT(*)`.as('n'))
      .where('org_id', '=', orgId).where('status', '=', 'draft').where('bill_date', '<=', to).executeTakeFirst()),
  ]);

  const checks: CloseCheck[] = [
    {
      id: 'balance', label: 'Trial balance agrees',
      detail: tb.balanced ? 'Debits and credits match to the paisa.' : 'The books do not balance — this must be fixed before closing.',
      count: tb.balanced ? 0 : 1, href: '/reports/trial-balance', blocking: true,
    },
    {
      id: 'recon', label: 'Bank accounts reconciled',
      detail: unreconciled ? `${unreconciled} statement line(s) still unmatched.` : 'Every bank line is accounted for.',
      count: unreconciled, href: '/banking/reconcile', blocking: true,
    },
    {
      id: 'irn', label: 'E-invoices registered',
      detail: noIrn ? `${noIrn} invoice(s) have no IRN. The 30-day window applies.` : 'Every B2B invoice carries a valid IRN.',
      count: noIrn, href: '/gst/einvoices', blocking: true,
    },
    {
      id: 'drafts', label: 'No draft invoices left',
      detail: drafts ? `${drafts} invoice(s) still in draft and not posted.` : 'All invoices are approved and posted.',
      count: drafts, href: '/sales/invoices', blocking: false,
    },
    {
      id: 'draft-bills', label: 'No draft bills left',
      detail: openBills ? `${openBills} supplier bill(s) still in draft.` : 'Every bill received has been entered.',
      count: openBills, href: '/purchases/bills', blocking: false,
    },
    {
      id: 'itc', label: 'Input credit reconciled to GSTR-2B',
      detail: itcRisk ? `${itcRisk} mismatch(es) between your books and the government's record.` : 'Books agree with GSTR-2B.',
      count: itcRisk, href: '/gst/itc-reconciliation', blocking: false,
    },
    {
      id: 'unapplied', label: 'Payments fully applied',
      detail: unapplied ? `${unapplied} payment(s) sitting on account, not matched to an invoice.` : 'No unapplied receipts.',
      count: unapplied, href: '/sales/payments', blocking: false,
    },
  ];

  // Credit on suppliers unpaid for 180 days has to come out of the return (Rule 37).
  const rule37Due = (await rule37(ex, orgId, to)).filter((r) => r.status === 'due').length;
  checks.push({
    id: 'rule37', label: 'Credit reversed on suppliers unpaid after 180 days',
    detail: rule37Due ? `${rule37Due} bill(s) are past 180 days unpaid; reverse their credit in this month's return.` : 'No credit is owed back under Rule 37.',
    count: rule37Due, href: '/gst/itc-reversals', blocking: false,
  });

  // An entry parked in Suspense is one nobody has finished. Tolerable between
  // months; not in a set of accounts that someone will sign.
  const suspense = tb.rows.find((r) => r.code === CODE.SUSPENSE && r.subtype === 'suspense')?.balancePaise ?? 0;
  checks.push({
    id: 'suspense', label: 'Suspense account cleared',
    detail: suspense
      ? `₹${(Math.abs(suspense) / 100).toLocaleString('en-IN')} is still in Suspense. Move each entry to the ledger it belongs in.`
      : 'Nothing is parked in Suspense.',
    count: suspense ? 1 : 0, href: '/reports/trial-balance', blocking: !!opts.yearEnd,
  });

  if (opts.yearEnd) {
    // Depreciation for the whole year is part of the year's profit.
    const branches = await ex.selectFrom('branches').select(['id', 'name']).where('org_id', '=', orgId).execute();
    const behind: string[] = [];
    for (const b of branches) {
      const from2 = await nextRunFrom(ex, orgId, b.id);
      if (from2 && from2 <= to) behind.push(b.name);
    }
    checks.push({
      id: 'depreciation', label: 'Depreciation charged to the year end',
      detail: behind.length ? `Not yet run to ${to} at ${behind.join(', ')}.` : 'Every asset in use is depreciated to the year end.',
      count: behind.length, href: '/accountant/fixed-assets', blocking: true,
    });
    const openings = await openingSummary(ex, orgId);
    checks.push({
      id: 'openings', label: 'Opening balances agree',
      detail: openings.differencePaise
        ? `A difference of ₹${(Math.abs(openings.differencePaise) / 100).toLocaleString('en-IN')} is still in Opening Balance Equity.`
        : 'Opening Balance Equity holds only the opening stock.',
      count: openings.differencePaise ? 1 : 0, href: '/accountant/opening-balances', blocking: false,
    });
  }

  return {
    checks,
    passed: checks.filter((c) => c.count === 0).length,
    blockers: checks.filter((c) => c.blocking && c.count > 0).length,
  };
}
