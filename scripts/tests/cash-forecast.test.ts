// Cash-flow forecast: today's cash, then what is due in and out, week by week.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/cash-forecast.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { postEntry } from '../../lib/server/ledger/posting';
import { createInvoice } from '../../lib/server/services/sales';
import { createBill } from '../../lib/server/services/purchases';
import { cashForecast } from '../../lib/server/reports/cash-forecast';

test('opening cash, invoices and bills by due date, recurring payments; overdue invoices only when asked', async () => {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Forecast Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1 }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const acc = await accountIds(trx, orgId);
      await trx.insertInto('bank_accounts').values({ org_id: orgId, kind: 'bank', name: 'Current', ledger_account_id: acc[CODE.BANK_DEFAULT], opening_balance: '0.0000' }).execute();
      await postEntry(trx, { orgId, branchId, date: '2026-09-01', memo: 'Capital', sourceType: 'manual', lines: [
        { accountId: acc[CODE.BANK_DEFAULT], debit: 1_00_000_00 }, { accountId: acc[CODE.CAPITAL], credit: 1_00_000_00 },
      ] });
      const contact = async (kind: string, name: string) => Number((await trx.insertInto('contacts').values({ org_id: orgId, kind, display_name: name, state_code: '33', gst_treatment: 'unregistered' } as never).executeTakeFirstOrThrow()).insertId);
      const customer = await contact('customer', 'Buyer');
      const vendor = await contact('vendor', 'Seller');
      const sell = (date: string, due: string, rupees: number) => createInvoice(trx, orgId, null, {
        branchId, customerId: customer, date, dueDate: due, status: 'approved', lines: [{ description: 'Goods', qty: 1, ratePaise: rupees * 100, gstRatePct: 0 }],
      });
      await sell('2026-10-01', '2026-11-05', 30_000); // week 2 from 1 Nov
      await sell('2026-09-01', '2026-10-01', 20_000); // already overdue
      await createBill(trx, orgId, null, { branchId, vendorId: vendor, vendorInvoiceNo: 'B-1', date: '2026-09-01', dueDate: '2026-10-15', status: 'open',
        lines: [{ description: 'Stock', qty: 1, ratePaise: 50_000_00, gstRatePct: 0 }] }); // overdue: week 1
      await trx.insertInto('recurring_journals').values({
        org_id: orgId, branch_id: branchId, name: 'Office rent', frequency: 'monthly', next_run: '2026-11-10',
        debit_account_id: acc[CODE.RENT], credit_account_id: acc[CODE.BANK_DEFAULT], amount: '15000.00', is_active: 1,
      } as never).execute();

      const f = await cashForecast(trx, orgId, { today: '2026-11-01', weeks: 4 });
      assert.equal(f.openingPaise, 1_00_000_00);
      assert.equal(f.overdueReceivablesPaise, 20_000_00);
      assert.equal(f.overduePayablesPaise, 50_000_00);
      assert.deepEqual(f.weeks.map((w) => [w.start, w.inPaise, w.outPaise]), [
        ['2026-11-01', 30_000_00, 50_000_00],
        ['2026-11-08', 0, 15_000_00],
        ['2026-11-15', 0, 0],
        ['2026-11-22', 0, 0],
      ]);
      assert.equal(f.weeks.at(-1)!.closingPaise, 65_000_00);
      assert.equal(f.lowestPaise, 65_000_00);

      const counted = await cashForecast(trx, orgId, { today: '2026-11-01', weeks: 4, countOverdueReceivables: true, lateDays: 7 });
      assert.deepEqual(counted.weeks.map((w) => w.inPaise), [20_000_00, 30_000_00, 0, 0], 'the overdue one now, the other a week late');

      // A post-dated cheque from the buyer pays the overdue invoice on the
      // cheque's date; a cheque given to the seller and not yet presented
      // pays part of the bill. Neither is counted twice.
      await trx.insertInto('cheques').values([
        { org_id: orgId, contact_id: customer, kind: 'received', cheque_no: '000111', amount: '20000.00', maturity_date: '2026-11-20', is_pdc: 1 },
        { org_id: orgId, contact_id: vendor, kind: 'issued', cheque_no: '500900', amount: '10000.00', maturity_date: '2026-10-30', is_pdc: 0 },
      ] as never).execute();
      const withCheques = await cashForecast(trx, orgId, { today: '2026-11-01', weeks: 4 });
      assert.equal(withCheques.overdueReceivablesPaise, 0, 'the overdue invoice is covered by the cheque');
      assert.deepEqual(withCheques.weeks.map((w) => [w.inPaise, w.outPaise]), [
        [30_000_00, 40_000_00 + 10_000_00],
        [0, 15_000_00],
        [20_000_00, 0],
        [0, 0],
      ]);
      assert.equal(withCheques.weeks.at(-1)!.closingPaise, 85_000_00);
      assert.ok(withCheques.weeks[2].items.some((i) => i.kind === 'cheque' && /000111 from Buyer, post-dated/.test(i.label)));
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
});

test.after(async () => {
  await db.destroy();
});
