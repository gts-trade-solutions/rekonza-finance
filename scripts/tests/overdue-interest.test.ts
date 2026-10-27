// Interest on overdue invoices: simple interest from the day after the due
// date and any grace, billed on a draft invoice at the principal's GST rate,
// never charged twice for the same day.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/overdue-interest.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../../lib/server/db';
import { installChartOfAccounts } from '../../lib/server/ledger/chart-of-accounts';
import { createInvoice } from '../../lib/server/services/sales';
import { overdueInterest, raiseInterestInvoice } from '../../lib/server/services/overdue-interest';

test('interest to a date, raised once, then from the day after', async () => {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Interest Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1 }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      await trx.insertInto('hsn_codes').values({ org_id: orgId, code: '8708', kind: 'hsn', description: 'Parts', gst_rate_pct: 18, is_active: 1 }).execute();
      const customer = Number((await trx.insertInto('contacts').values({
        org_id: orgId, kind: 'customer', display_name: 'Slow Payer', state_code: '33', gst_treatment: 'consumer',
      } as never).executeTakeFirstOrThrow()).insertId);
      const inv = await createInvoice(trx, orgId, null, {
        branchId, customerId: customer, date: '2026-04-01', dueDate: '2026-04-30', status: 'approved',
        lines: [{ description: 'Parts', hsnSac: '8708', qty: 1, ratePaise: 10_000_00, gstRatePct: 18 }],
      });

      assert.deepEqual(await overdueInterest(trx, orgId, '2026-04-30', 18, 0), [], 'not overdue on the due date');
      assert.deepEqual(await overdueInterest(trx, orgId, '2026-05-10', 18, 15), [], 'inside the grace days');

      const [row] = await overdueInterest(trx, orgId, '2026-05-30', 18, 0);
      assert.equal(row.invoiceId, String(inv.id));
      assert.deepEqual([row.from, row.to, row.days], ['2026-05-01', '2026-05-30', 30]);
      assert.equal(row.interestPaise, 17_458, '₹11,800 at 18% for 30 days');
      assert.deepEqual([row.hsnSac, row.gstRatePct], ['8708', 18]);

      const charge = await raiseInterestInvoice(trx, orgId, null, { customerId: customer, asOf: '2026-05-30', ratePct: 18, graceDays: 0, branchId });
      assert.equal(charge.totalPaise, 206_00, 'interest plus GST at the invoice’s rate, rounded to the rupee');
      const draft = await trx.selectFrom('invoices').select(['status', 'subtotal']).where('id', '=', charge.id).executeTakeFirstOrThrow();
      assert.equal(draft.status, 'draft', 'for someone to check before it goes out');
      assert.deepEqual(await overdueInterest(trx, orgId, '2026-05-30', 18, 0), [], 'nothing left to that date');

      const [next] = await overdueInterest(trx, orgId, '2026-06-29', 18, 0);
      assert.deepEqual([next.from, next.days], ['2026-05-31', 30], 'the day after the last charge');
      await assert.rejects(raiseInterestInvoice(trx, orgId, null, { customerId: customer, asOf: '2026-05-30', ratePct: 18, graceDays: 0, branchId }), /no interest to charge/);
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
});

test.after(async () => {
  await db.destroy();
});
