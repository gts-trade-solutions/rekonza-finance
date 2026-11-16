// The figures on Home's Zoho cards: receivables and payables split into
// current and overdue, the year's cash flow month by month, and income against
// expense (lib/server/reports/home.ts).
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/home-figures.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { createInvoice } from '../../lib/server/services/sales';
import { createBill } from '../../lib/server/services/purchases';
import { receivePayment } from '../../lib/server/services/payments';
import { homeFigures } from '../../lib/server/reports/home';

test('receivables, payables, cash flow and income against expense for the year', async () => {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Home Co' }).executeTakeFirstOrThrow()).insertId);
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

      const empty = await homeFigures(trx, orgId, '2026-04-01', '2026-06-30');
      assert.equal(empty.receivables.totalPaise, 0, 'a new book owes and is owed nothing');
      assert.equal(empty.cashFlow.months.length, 12, 'the whole financial year, April to March');
      assert.equal(empty.cashFlow.months[0].month, '2026-04');
      assert.equal(empty.cashFlow.months[11].month, '2027-03');
      assert.equal(empty.cashFlow.to, '2027-03-31');

      // ₹11,800 invoiced in May, due 31 May: overdue by the end of June.
      const late = await createInvoice(trx, orgId, null, {
        branchId, customerId: customer, date: '2026-05-01', dueDate: '2026-05-31', status: 'approved',
        lines: [{ description: 'Repair', hsnSac: '998714', qty: 1, ratePaise: 10_000_00, gstRatePct: 18 }],
      });
      // ₹5,900 invoiced in June, due in July: still current.
      await createInvoice(trx, orgId, null, {
        branchId, customerId: customer, date: '2026-06-10', dueDate: '2026-07-10', status: 'approved',
        lines: [{ description: 'Repair', hsnSac: '998714', qty: 1, ratePaise: 5_000_00, gstRatePct: 18 }],
      });
      // A ₹5,900 bill in June, due in May's past: overdue.
      await createBill(trx, orgId, null, {
        branchId, vendorId: vendor, vendorInvoiceNo: 'S-1', date: '2026-06-02', dueDate: '2026-06-15',
        lines: [{ description: 'Parts', qty: 1, ratePaise: 5_000_00, gstRatePct: 18 }],
      });
      // ₹5,900 of the late invoice collected in June, into the bank.
      await receivePayment(trx, orgId, null, {
        branchId, contactId: customer, date: '2026-06-20', mode: 'neft', amountPaise: 5_900_00, bankAccountId: bankId,
        allocations: [{ targetType: 'invoice', targetId: late.id, amountPaise: 5_900_00 }],
      });

      const h = await homeFigures(trx, orgId, '2026-04-01', '2026-06-30');
      assert.deepEqual(h.receivables, { totalPaise: 11_800_00, currentPaise: 5_900_00, overduePaise: 5_900_00 });
      assert.deepEqual(h.payables, { totalPaise: 5_900_00, currentPaise: 0, overduePaise: 5_900_00 });

      const june = h.cashFlow.months.find((m) => m.month === '2026-06')!;
      assert.equal(june.incomingPaise, 5_900_00, 'the receipt came into the bank in June');
      assert.equal(june.outgoingPaise, 0);
      assert.equal(june.closingPaise, 5_900_00);
      assert.equal(h.cashFlow.openingPaise, 0);
      assert.equal(h.cashFlow.closingPaise, 5_900_00, 'the year ends on what is in the bank');
      assert.equal(h.cashFlow.incomingPaise - h.cashFlow.outgoingPaise, h.cashFlow.closingPaise - h.cashFlow.openingPaise);

      // Income is net of GST: ₹10,000 in May and ₹5,000 in June. The bill is an expense of ₹5,000.
      const may = h.incomeExpense.months.find((m) => m.month === '2026-05')!;
      assert.equal(may.incomePaise, 10_000_00);
      assert.equal(h.incomeExpense.incomePaise, 15_000_00);
      assert.equal(h.incomeExpense.expensePaise, 5_000_00);
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
});

test.after(async () => {
  await db.destroy();
});
