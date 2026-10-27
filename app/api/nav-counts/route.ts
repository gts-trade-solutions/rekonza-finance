import { db } from '@/lib/server/db';
import { route } from '@/lib/server/http';
import { hasPermission } from '@/lib/rbac';
import { msmeOpenBills } from '@/lib/server/services/msme';
import { complianceCalendar } from '@/lib/server/tax/compliance-calendar';
import '@/lib/server/jobs/boot';

// ─────────────────────────────────────────────────────────────────────────────
// The three numbers on the navigation rail.
//
// They used to be counted in the browser, over a seeded copy of the book. That
// worked while the store was the book; now that the ledger is in a database it
// would mean shipping every invoice and bank line to the client to count them,
// so they are counted where they live — three aggregates, no rows returned.
//
// Each is a piece of unfinished work with a deadline attached, which is the
// only kind of number worth putting on a navigation item:
//
//   einvoicePending  invoices with no IRN yet. The window is 30 days from the
//                    invoice date; after that the portal refuses it and the
//                    invoice has to be cancelled and reissued.
//   unmatched        statement lines not yet reconciled against the books.
//   msmeRisk         unpaid bills from micro and small suppliers within a week
//                    of, or past, their MSMED Act deadline (Section 43B(h)).
//   complianceDue    returns and payments overdue or due within a week, not
//                    yet marked done on the compliance calendar.
// ─────────────────────────────────────────────────────────────────────────────

export const GET = route(async ({ orgId, role }) => {
  const today = new Date().toISOString().slice(0, 10);

  const [einvoice, bank, msme, due] = await Promise.all([
    hasPermission(role, 'gst', 'view')
      ? db
          .selectFrom('einvoices')
          .select(({ fn }) => fn.countAll<number>().as('n'))
          .where('org_id', '=', orgId)
          .where('status', 'in', ['pending', 'failed'])
          .executeTakeFirst()
      : null,

    hasPermission(role, 'banking', 'view')
      ? db
          .selectFrom('bank_transactions')
          .select(({ fn }) => fn.countAll<number>().as('n'))
          .where('org_id', '=', orgId)
          .where('status', '=', 'unmatched')
          .executeTakeFirst()
      : null,

    hasPermission(role, 'purchases', 'view')
      ? msmeOpenBills(db, orgId, today).then((bills) => ({ n: bills.filter((b) => b.risk !== 'safe').length }))
      : null,

    hasPermission(role, 'gst', 'view')
      ? complianceCalendar(db, orgId, new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10),
        new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10), today)
        .then((c) => ({ n: c.rows.filter((r) => r.status === 'overdue' || r.status === 'due_soon').filter((r) => !r.optional).length }))
      : null,
  ]);

  return {
    einvoicePending: Number(einvoice?.n ?? 0),
    unmatched: Number(bank?.n ?? 0),
    msmeRisk: Number(msme?.n ?? 0),
    complianceDue: Number(due?.n ?? 0),
  };
});
