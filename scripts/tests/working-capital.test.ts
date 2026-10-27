// Receivable, payable and inventory days on the dashboard.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/working-capital.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { createInvoice } from '../../lib/server/services/sales';
import { createBill } from '../../lib/server/services/purchases';
import { receivePayment } from '../../lib/server/services/payments';
import { workingCapitalDays } from '../../lib/server/reports/analytics';

test('days owed and owing, against the 90 days before', async () => {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'WC Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1 }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const acc = await accountIds(trx, orgId);
      await trx.insertInto('hsn_codes').values({ org_id: orgId, code: '998714', kind: 'sac', description: 'Repairs', gst_rate_pct: 18, is_active: 1 }).execute();
      const bankId = Number((await trx.insertInto('bank_accounts').values({
        org_id: orgId, kind: 'bank', name: 'Bank', ledger_account_id: acc[CODE.BANK_DEFAULT], opening_balance: '0.0000',
      }).executeTakeFirstOrThrow()).insertId);
      const mk = async (v: Record<string, unknown>) => Number((await trx.insertInto('contacts').values({ org_id: orgId, state_code: '33', gst_treatment: 'unregistered', ...v } as never).executeTakeFirstOrThrow()).insertId);
      const customer = await mk({ kind: 'customer', display_name: 'Buyer' });
      const vendor = await mk({ kind: 'vendor', display_name: 'Supplier' });

      assert.equal((await workingCapitalDays(trx, orgId, '2026-06-30')).receivableDays, null, 'nothing sold, nothing to measure');

      const inv = await createInvoice(trx, orgId, null, {
        branchId, customerId: customer, date: '2026-06-01', dueDate: '2026-06-30', status: 'approved',
        lines: [{ description: 'Repair', hsnSac: '998714', qty: 1, ratePaise: 10_000_00, gstRatePct: 18 }],
      });
      await createBill(trx, orgId, null, {
        branchId, vendorId: vendor, vendorInvoiceNo: 'S-1', date: '2026-06-02', dueDate: '2026-07-02',
        lines: [{ description: 'Parts', qty: 1, ratePaise: 5_000_00, gstRatePct: 18 }],
      });
      // Half the ₹11,800 collected: half of 90 days' sales is still owed.
      await receivePayment(trx, orgId, null, {
        branchId, contactId: customer, date: '2026-06-20', mode: 'neft', amountPaise: 5_900_00, bankAccountId: bankId,
        allocations: [{ targetType: 'invoice', targetId: inv.id, amountPaise: 5_900_00 }],
      });

      const wc = await workingCapitalDays(trx, orgId, '2026-06-30');
      assert.equal(wc.windowDays, 90);
      assert.equal(wc.receivableDays, 45);
      assert.equal(wc.payableDays, 90, 'the whole bill is unpaid');
      assert.equal(wc.inventoryDays, null, 'no cost of sales in the window');
      assert.equal(wc.cashCycleDays, -45);
      assert.equal(wc.previous.receivableDays, null, 'the window before had no sales');

      // A quarter later the sale has left the window; what is still owed is not measured against nothing.
      assert.equal((await workingCapitalDays(trx, orgId, '2026-10-15')).receivableDays, null);
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
});

test.after(async () => {
  await db.destroy();
});
