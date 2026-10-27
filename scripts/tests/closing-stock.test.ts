// Closing stock: valued from the documents, carried into the statements.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/closing-stock.test.ts
//
// Every figure below is worked out by hand in the comment beside it. The point
// of these tests is that the profit and loss and the balance sheet tell the
// same story about stock, and that the balance sheet still balances once stock
// is in it — including across a financial year end, where profit becomes
// retained earnings without any entry moving it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { createInvoice } from '../../lib/server/services/sales';
import { createBill } from '../../lib/server/services/purchases';
import { createCreditNote } from '../../lib/server/services/sales-documents';
import { balanceSheet, profitAndLoss } from '../../lib/server/reports/statements';
import { stockPosition, fyStartFor, dayBefore } from '../../lib/server/reports/stock';
import { setPolicies } from '../../lib/server/services/org-settings';

interface Fixture {
  trx: Trx;
  orgId: number;
  branchId: number;
  customerId: number;
  vendorId: number;
  itemId: number;
}

async function withFixture(fn: (f: Fixture) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const org = await trx.insertInto('organizations')
        .values({ name: 'Stock Test Co' }).executeTakeFirstOrThrow();
      const orgId = Number(org.insertId);

      const branch = await trx.insertInto('branches')
        .values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1 })
        .executeTakeFirstOrThrow();
      const branchId = Number(branch.insertId);

      await installChartOfAccounts(trx, orgId);
      const acc = await accountIds(trx, orgId);

      const mk = async (values: Record<string, unknown>) =>
        Number((await trx.insertInto('contacts').values(values as never).executeTakeFirstOrThrow()).insertId);
      const customerId = await mk({
        org_id: orgId, kind: 'customer', display_name: 'Local Customer',
        gst_treatment: 'registered', state_code: '33',
      });
      const vendorId = await mk({
        org_id: orgId, kind: 'vendor', display_name: 'Local Vendor',
        gst_treatment: 'registered', state_code: '33',
      });

      await trx.insertInto('hsn_codes').values({
        org_id: orgId, code: '8708', kind: 'hsn', description: 'Motor vehicle parts',
        gst_rate_pct: 18, is_active: 1,
      }).execute();

      // Ten on the shelf when the books began, carried at ₹100 each.
      const item = await trx.insertInto('items').values({
        org_id: orgId, kind: 'goods', name: 'Brake pad', sku: 'BP-1', hsn_sac: '8708',
        uqc: 'NOS', sale_price: '200.0000', purchase_price: '120.0000', gst_rate_pct: 18,
        track_inventory: 1, opening_stock_qty: '10', opening_stock_rate: '100.0000',
        sale_account_id: acc[CODE.SALES], purchase_account_id: acc[CODE.PURCHASES],
      }).executeTakeFirstOrThrow();
      const itemId = Number(item.insertId);

      await fn({ trx, orgId, branchId, customerId, vendorId, itemId });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

const buy = (f: Fixture, date: string, qty: number, ratePaise: number) =>
  createBill(f.trx, f.orgId, null, {
    branchId: f.branchId, vendorId: f.vendorId, vendorInvoiceNo: `B-${date}-${qty}`,
    date, dueDate: date, lines: [{ itemId: f.itemId, qty, ratePaise }],
  });

const sell = (f: Fixture, date: string, qty: number, ratePaise: number) =>
  createInvoice(f.trx, f.orgId, null, {
    branchId: f.branchId, customerId: f.customerId, date, dueDate: date, status: 'approved',
    lines: [{ itemId: f.itemId, qty, ratePaise }],
  });

test('dates: the financial year and the day before', () => {
  assert.equal(fyStartFor('2026-06-30', 4), '2026-04-01');
  assert.equal(fyStartFor('2027-03-31', 4), '2026-04-01');
  assert.equal(fyStartFor('2027-01-15', 1), '2027-01-01');
  assert.equal(dayBefore('2026-04-01'), '2026-03-31');
  assert.equal(dayBefore('2024-03-01'), '2024-02-29');
});

test('opening stock alone: an asset, balanced by opening equity, and no profit', async () => {
  await withFixture(async (f) => {
    const bs = await balanceSheet(f.trx, f.orgId, '2026-08-31');
    assert.equal(bs.closingStockPaise, 100_000, '10 × ₹100');
    assert.equal(bs.equityRows.find((r) => r.accountId === 'opening-stock')?.balancePaise, 100_000);
    assert.equal(bs.currentPeriodEarnings, 0, 'stock that only sat there earned nothing');
    assert.equal(bs.priorYearsEarnings, 0);
    assert.ok(bs.balanced);
  });
});

test('FIFO values what is left at the latest purchases; average at the year’s mean', async () => {
  await withFixture(async (f) => {
    await buy(f, '2026-05-10', 10, 13_000);
    await buy(f, '2026-06-10', 10, 15_000);
    await sell(f, '2026-06-20', 15, 20_000);
    // 15 left of 30: (₹1,000 + ₹1,300 + ₹1,500) / 30 = ₹126.67 each on average.
    assert.equal((await stockPosition(f.trx, f.orgId, '2026-06-30')).totalValuePaise, 190_000);
    await setPolicies(f.trx, f.orgId, null, { stockValuation: 'fifo' });
    // The last ten at ₹150 and five of the ten at ₹130.
    const fifo = await stockPosition(f.trx, f.orgId, '2026-06-30');
    assert.equal(fifo.totalValuePaise, 215_000);
    assert.equal(fifo.lines[0].unitCostPaise, 14_333);
    // Sold down below the purchases, what is left is the opening stock’s.
    await sell(f, '2026-06-25', 13, 20_000);
    assert.equal((await stockPosition(f.trx, f.orgId, '2026-06-30')).totalValuePaise, 30_000, 'two left, at ₹150');
  });
});

test('the profit and loss turns purchases into the cost of what was sold', async () => {
  await withFixture(async (f) => {
    await buy(f, '2026-05-10', 10, 13_000);   // 10 × ₹130 = ₹1,300
    await sell(f, '2026-06-01', 5, 20_000);   // 5 × ₹200 = ₹1,000

    // Average for the year: (₹1,000 opening + ₹1,300 bought) / 20 = ₹115.
    // On hand: 10 + 10 − 5 = 15, worth ₹1,725.
    const stock = await stockPosition(f.trx, f.orgId, '2026-06-30');
    assert.equal(stock.lines[0].qty, 15);
    assert.equal(stock.lines[0].unitCostPaise, 11_500);
    assert.equal(stock.totalValuePaise, 172_500);

    const pl = await profitAndLoss(f.trx, f.orgId, '2026-04-01', '2026-06-30');
    assert.equal(pl.totalIncome, 100_000);
    assert.equal(pl.totalExpense, 130_000, 'the bill is expensed in full');
    assert.equal(pl.openingStockPaise, 100_000);
    assert.equal(pl.closingStockPaise, 172_500);
    // ₹1,300 + ₹1,000 − ₹1,725 = ₹575, which is 5 sold × ₹115.
    assert.equal(pl.costOfGoodsSoldPaise, 57_500);
    assert.equal(pl.grossProfit, 42_500);
    assert.equal(pl.netProfit, 42_500);

    const bs = await balanceSheet(f.trx, f.orgId, '2026-06-30');
    assert.equal(bs.closingStockPaise, 172_500);
    assert.equal(bs.currentPeriodEarnings, pl.netProfit, 'the two statements agree on the year');
    assert.ok(bs.balanced);
  });
});

test('across a year end, last year’s profit becomes retained earnings and the average starts afresh', async () => {
  await withFixture(async (f) => {
    await buy(f, '2026-05-10', 10, 13_000);
    await sell(f, '2026-06-01', 5, 20_000);
    // Next year: 5 more at ₹160.
    await buy(f, '2027-05-01', 5, 16_000);

    // The new year opens with 15 at ₹115 (₹1,725) and adds ₹800:
    // (₹1,725 + ₹800) / 20 = ₹126.25 — last year's ₹100 no longer dilutes it.
    const stock = await stockPosition(f.trx, f.orgId, '2027-06-30');
    assert.equal(stock.lines[0].qty, 20);
    assert.equal(stock.lines[0].unitCostPaise, 12_625);
    assert.equal(stock.totalValuePaise, 252_500);

    const bs = await balanceSheet(f.trx, f.orgId, '2027-06-30');
    assert.equal(bs.fyStart, '2027-04-01');
    assert.equal(bs.priorYearsEarnings, 42_500, 'FY 2026-27 profit, carried forward');
    // This year: ₹800 bought and nothing sold, so cost equals the stock added.
    assert.equal(bs.currentPeriodEarnings, 0);
    assert.ok(bs.balanced);

    const pl = await profitAndLoss(f.trx, f.orgId, '2027-04-01', '2027-06-30');
    assert.equal(pl.openingStockPaise, 172_500, 'this year opens with last year’s closing stock');
    assert.equal(pl.netProfit, 0);
  });
});

test('an adjustment changes quantity only; the loss arrives through closing stock', async () => {
  await withFixture(async (f) => {
    await f.trx.insertInto('stock_adjustments').values({
      org_id: f.orgId, item_id: f.itemId, adjust_date: '2026-07-01',
      qty_delta: '-2', reason: 'damage',
    }).execute();

    const entries = await f.trx.selectFrom('journal_entries').select('id')
      .where('org_id', '=', f.orgId).execute();
    assert.equal(entries.length, 0, 'nothing was posted');

    const pl = await profitAndLoss(f.trx, f.orgId, '2026-04-01', '2026-07-31');
    // 8 left at ₹100: the ₹200 lost shows as a smaller closing stock.
    assert.equal(pl.closingStockPaise, 80_000);
    assert.equal(pl.netProfit, -20_000);
    assert.ok((await balanceSheet(f.trx, f.orgId, '2026-07-31')).balanced);
  });
});

test('opening stock added by adjustment is opening equity, not a gain', async () => {
  await withFixture(async (f) => {
    await f.trx.insertInto('stock_adjustments').values({
      org_id: f.orgId, item_id: f.itemId, adjust_date: '2026-09-15',
      qty_delta: '5', reason: 'opening', notes: 'Found in the second godown',
    }).execute();

    const bs = await balanceSheet(f.trx, f.orgId, '2026-09-30');
    assert.equal(bs.closingStockPaise, 150_000, '15 × ₹100');
    assert.equal(bs.equityRows.find((r) => r.accountId === 'opening-stock')?.balancePaise, 150_000);
    assert.equal(bs.currentPeriodEarnings, 0);
    assert.ok(bs.balanced);
  });
});

test('goods taken back on a credit note are on the shelf again', async () => {
  await withFixture(async (f) => {
    await sell(f, '2026-06-01', 4, 20_000);
    await createCreditNote(f.trx, f.orgId, null, {
      branchId: f.branchId, customerId: f.customerId, date: '2026-06-05',
      reason: 'One returned', lines: [{ itemId: f.itemId, qty: 1, ratePaise: 20_000 }],
    });

    const stock = await stockPosition(f.trx, f.orgId, '2026-06-30');
    assert.equal(stock.lines[0].qty, 7, '10 − 4 + 1');
    assert.equal(stock.lines[0].returnedQty, 1);
    assert.ok((await balanceSheet(f.trx, f.orgId, '2026-06-30')).balanced);
  });
});

test('goods that do not track stock carry none', async () => {
  await withFixture(async (f) => {
    await f.trx.updateTable('items').set({ track_inventory: 0 }).where('id', '=', f.itemId).execute();
    await buy(f, '2026-05-10', 10, 13_000);

    const pl = await profitAndLoss(f.trx, f.orgId, '2026-04-01', '2026-06-30');
    assert.equal(pl.closingStockPaise, 0);
    assert.equal(pl.netProfit, -130_000, 'the purchase is simply a cost');
    assert.ok((await balanceSheet(f.trx, f.orgId, '2026-06-30')).balanced);
  });
});

test('a branch balance sheet carries only that branch’s stock, and still balances', async () => {
  await withFixture(async (f) => {
    const second = await f.trx.insertInto('branches')
      .values({ org_id: f.orgId, name: 'Bengaluru', state_code: '33', is_primary: 0 })
      .executeTakeFirstOrThrow();
    const secondId = Number(second.insertId);

    await createBill(f.trx, f.orgId, null, {
      branchId: secondId, vendorId: f.vendorId, vendorInvoiceNo: 'BLR-1',
      date: '2026-05-10', dueDate: '2026-05-10', lines: [{ itemId: f.itemId, qty: 4, ratePaise: 13_000 }],
    });

    const hq = await balanceSheet(f.trx, f.orgId, '2026-06-30', f.branchId);
    const blr = await balanceSheet(f.trx, f.orgId, '2026-06-30', secondId);
    // Opening stock lives at the primary branch; the bill is Bengaluru's.
    assert.equal(hq.closingStockPaise, 100_000);
    assert.equal(blr.closingStockPaise, 52_000, '4 × ₹130');
    assert.ok(hq.balanced);
    assert.ok(blr.balanced);
  });
});

test.after(async () => {
  await db.destroy();
});
