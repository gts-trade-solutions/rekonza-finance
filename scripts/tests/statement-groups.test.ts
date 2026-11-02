// The profit and loss and balance sheet grouped by category, as Zoho Books
// groups them (lib/server/reports/statement-groups.ts).
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/statement-groups.test.ts
//
// Pinned down: every account lands in one group; the groups add up to exactly
// the ordinary statements; other income and exchange losses are non-operating;
// a CA's Schedule III line moves an account here too; and the T-form's two
// sides agree.

import test from 'node:test';
import assert from 'node:assert/strict';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { postEntry } from '../../lib/server/ledger/posting';
import { createInvoice } from '../../lib/server/services/sales';
import { createBill } from '../../lib/server/services/purchases';
import { balanceSheet, profitAndLoss } from '../../lib/server/reports/statements';
import { groupedBalanceSheet, groupedProfitAndLoss } from '../../lib/server/reports/statement-groups';

test.after(() => db.destroy());

async function withBook(fn: (trx: Trx, orgId: number, acc: Record<string, number>) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Statement Groups Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1, gstin: '33AABCQ4040S1Z4' }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const acc = await accountIds(trx, orgId);
      const contact = async (kind: string, name: string) => Number((await trx.insertInto('contacts').values({ org_id: orgId, kind, display_name: name, state_code: '33', gst_treatment: 'unregistered' } as never).executeTakeFirstOrThrow()).insertId);
      const entry = (date: string, memo: string, lines: { accountId: number; debit?: number; credit?: number }[]) =>
        postEntry(trx, { orgId, branchId, date, memo, sourceType: 'manual', lines });

      await entry('2026-04-01', 'Capital', [{ accountId: acc[CODE.BANK_DEFAULT], debit: 5_00_000_00 }, { accountId: acc[CODE.CAPITAL], credit: 5_00_000_00 }]);
      await entry('2026-04-02', 'Term loan', [{ accountId: acc[CODE.BANK_DEFAULT], debit: 2_00_000_00 }, { accountId: acc[CODE.SECURED_LOANS], credit: 2_00_000_00 }]);
      await entry('2026-04-03', 'Machine', [{ accountId: acc[CODE.PLANT_MACHINERY], debit: 1_50_000_00 }, { accountId: acc[CODE.BANK_DEFAULT], credit: 1_50_000_00 }]);
      await entry('2026-05-01', 'Interest on deposit', [{ accountId: acc[CODE.BANK_DEFAULT], debit: 4_000_00 }, { accountId: acc[CODE.OTHER_INCOME], credit: 4_000_00 }]);
      await entry('2026-05-02', 'Exchange loss', [{ accountId: acc[CODE.FX_LOSS], debit: 1_500_00 }, { accountId: acc[CODE.BANK_DEFAULT], credit: 1_500_00 }]);
      await entry('2026-05-03', 'Rent', [{ accountId: acc[CODE.RENT], debit: 20_000_00 }, { accountId: acc[CODE.BANK_DEFAULT], credit: 20_000_00 }]);
      await entry('2026-05-04', 'Interest on late GST', [{ accountId: acc[CODE.TAX_INTEREST], debit: 700_00 }, { accountId: acc[CODE.BANK_DEFAULT], credit: 700_00 }]);
      await entry('2026-05-05', 'Petty cash', [{ accountId: acc[CODE.CASH], debit: 5_000_00 }, { accountId: acc[CODE.BANK_DEFAULT], credit: 5_000_00 }]);

      const customer = await contact('customer', 'Buyer');
      const vendor = await contact('vendor', 'Seller');
      await createInvoice(trx, orgId, null, { branchId, customerId: customer, date: '2026-06-01', dueDate: '2026-07-01', status: 'approved', lines: [{ description: 'Goods', qty: 1, ratePaise: 1_00_000_00, gstRatePct: 18 }] });
      await createBill(trx, orgId, null, { branchId, vendorId: vendor, vendorInvoiceNo: 'B-1', date: '2026-06-02', dueDate: '2026-07-02', status: 'open', lines: [{ description: 'Stock', qty: 1, ratePaise: 60_000_00, gstRatePct: 18 }] });
      await fn(trx, orgId, acc);
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

const names = (lines: { name: string }[]) => lines.map((l) => l.name);

test('the profit and loss groups add up to the statement, by category', async () => {
  await withBook(async (trx, orgId) => {
    const g = await groupedProfitAndLoss(trx, orgId, '2026-04-01', '2027-03-31');
    const pl = await profitAndLoss(trx, orgId, '2026-04-01', '2027-03-31');
    assert.equal(g.netProfitPaise, pl.netProfit);
    assert.deepEqual(names(g.operatingIncome.lines), ['Sales']);
    assert.equal(g.operatingIncome.totalPaise, 1_00_000_00);
    assert.deepEqual(names(g.nonOperatingIncome.lines), ['Other Income'], 'interest received is not operating income');
    assert.ok(names(g.costOfGoodsSold.lines).includes('Purchases – Trading Goods'));
    assert.deepEqual(names(g.nonOperatingExpense.lines).sort(), ['Foreign Exchange Loss', 'Interest & Fees on Late Taxes']);
    assert.deepEqual(names(g.operatingExpense.lines), ['Rent']);
    assert.equal(g.grossProfitPaise, g.operatingIncome.totalPaise - g.costOfGoodsSold.totalPaise);
    assert.equal(g.operatingProfitPaise, g.grossProfitPaise - g.operatingExpense.totalPaise);
  });
});

test('a CA’s Schedule III line moves an account between groups', async () => {
  await withBook(async (trx, orgId, acc) => {
    // Rent re-classed as a finance cost (it would not be, but it proves the point).
    await trx.updateTable('accounts').set({ schedule_iii_line: 'finance_costs' }).where('id', '=', acc[CODE.RENT]).execute();
    const g = await groupedProfitAndLoss(trx, orgId, '2026-04-01', '2027-03-31');
    assert.ok(names(g.nonOperatingExpense.lines).includes('Rent'));
    assert.equal(g.operatingExpense.lines.length, 0);
  });
});

test('the balance sheet groups add up and balance', async () => {
  await withBook(async (trx, orgId) => {
    const g = await groupedBalanceSheet(trx, orgId, '2026-06-30');
    const bs = await balanceSheet(trx, orgId, '2026-06-30');
    assert.equal(g.assets.totalPaise, bs.totalAssets);
    assert.equal(g.liabilities.totalPaise, bs.totalLiabilities);
    assert.equal(g.equities.totalPaise, bs.totalEquity);
    assert.equal(g.assets.totalPaise, g.totalLiabilitiesAndEquitiesPaise, 'assets equal liabilities and equities');
    const child = (key: string, from = g.assets) => {
      const find = (x: typeof from): typeof from | undefined => x.key === key ? x : (x.groups ?? []).map(find).find(Boolean);
      return find(from)!;
    };
    assert.deepEqual(names(child('cash').lines), ['Cash in Hand']);
    assert.deepEqual(names(child('bank').lines), ['Bank Account']);
    assert.deepEqual(names(child('accounts-receivable').lines), ['Accounts Receivable']);
    assert.deepEqual(names(child('fixed-assets').lines), ['Plant & Machinery']);
    assert.deepEqual(names(child('accounts-payable', g.liabilities).lines), ['Accounts Payable']);
    assert.deepEqual(names(child('long-term-liabilities', g.liabilities).lines), ['Secured Loans']);
    assert.ok(names(child('other-current-liabilities', g.liabilities).lines).includes('Output CGST Payable'));
    assert.ok(names(g.equities.lines).includes('Current Year Earnings'));
  });
});
