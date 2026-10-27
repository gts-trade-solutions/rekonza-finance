// The Schedule III statements tell the same story as the ordinary ones.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/schedule-iii.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { createInvoice } from '../../lib/server/services/sales';
import { createBill } from '../../lib/server/services/purchases';
import { balanceSheet, profitAndLoss } from '../../lib/server/reports/statements';
import { defaultLine, scheduleIIIBalanceSheet, scheduleIIIProfitAndLoss } from '../../lib/server/reports/schedule-iii';
import { STANDARD_ACCOUNTS } from '../../lib/server/ledger/chart-of-accounts';

interface Fixture { trx: Trx; orgId: number; branchId: number; customerId: number; msmeVendor: number; vendor: number; itemId: number }

async function withFixture(fn: (f: Fixture) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Sch III Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches')
        .values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1 }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const acc = await accountIds(trx, orgId);
      const mk = async (v: Record<string, unknown>) =>
        Number((await trx.insertInto('contacts').values({ org_id: orgId, state_code: '33', ...v } as never).executeTakeFirstOrThrow()).insertId);
      await trx.insertInto('hsn_codes').values({ org_id: orgId, code: '8708', kind: 'hsn', description: 'Parts', gst_rate_pct: 18, is_active: 1 }).execute();
      const itemId = Number((await trx.insertInto('items').values({
        org_id: orgId, kind: 'goods', name: 'Pad', hsn_sac: '8708', uqc: 'NOS', sale_price: '200.0000',
        purchase_price: '100.0000', gst_rate_pct: 18, track_inventory: 1, opening_stock_qty: '5', opening_stock_rate: '100.0000',
        sale_account_id: acc[CODE.SALES], purchase_account_id: acc[CODE.PURCHASES],
      }).executeTakeFirstOrThrow()).insertId);
      await fn({
        trx, orgId, branchId, itemId,
        customerId: await mk({ kind: 'customer', display_name: 'Buyer', gst_treatment: 'registered' }),
        msmeVendor: await mk({ kind: 'vendor', display_name: 'Small Works', gst_treatment: 'registered', is_msme: 1, msme_udyam_no: 'UDYAM-TN-01-0000001' }),
        vendor: await mk({ kind: 'vendor', display_name: 'Big Supplier', gst_treatment: 'registered' }),
      });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

test('Schedule III balances, and agrees with the ordinary statements', async () => {
  await withFixture(async (f) => {
    await createBill(f.trx, f.orgId, null, {
      branchId: f.branchId, vendorId: f.msmeVendor, vendorInvoiceNo: 'SW-1', date: '2025-06-01', dueDate: '2025-07-01',
      lines: [{ itemId: f.itemId, qty: 10, ratePaise: 10_000 }],
    });
    await createBill(f.trx, f.orgId, null, {
      branchId: f.branchId, vendorId: f.vendor, vendorInvoiceNo: 'BS-1', date: '2026-05-01', dueDate: '2026-06-01',
      lines: [{ itemId: f.itemId, qty: 10, ratePaise: 10_000 }],
    });
    await createInvoice(f.trx, f.orgId, null, {
      branchId: f.branchId, customerId: f.customerId, date: '2026-06-10', dueDate: '2026-07-10', status: 'approved',
      lines: [{ itemId: f.itemId, qty: 8, ratePaise: 20_000 }],
    });

    const asOf = '2027-03-31';
    const s3 = await scheduleIIIBalanceSheet(f.trx, f.orgId, asOf);
    const bs = await balanceSheet(f.trx, f.orgId, asOf);
    assert.ok(s3.balanced, 'both years balance');
    assert.equal(s3.totals.assets[0], bs.totalAssets);

    const line = (k: string) => [...s3.assets, ...s3.equityAndLiabilities].find((l) => l.key === k)!;
    assert.equal(line('inventories').currentPaise, bs.closingStockPaise, 'closing stock is the inventory line');
    assert.equal(line('trade_payables').currentPaise, 2 * 1_180_00);

    // Ageing adds up to the control accounts, payables split MSME and others.
    assert.equal(s3.receivablesAgeing.totalPaise, line('trade_receivables').currentPaise);
    assert.equal(s3.payablesAgeing.totalPaise, line('trade_payables').currentPaise);
    assert.equal(s3.msmePayablesPaise, 1_180_00);
    // The MSME bill fell due on 1 July 2025: more than a year before 31 March 2027.
    assert.equal(s3.payablesAgeing.rows[0].amounts[1], 1_180_00, 'MSME, 1–2 years');
    assert.equal(s3.payablesAgeing.rows[1].amounts[0], 1_180_00, 'others, under a year');

    const p3 = await scheduleIIIProfitAndLoss(f.trx, f.orgId, '2026-04-01', '2027-03-31');
    const pl = await profitAndLoss(f.trx, f.orgId, '2026-04-01', '2027-03-31');
    assert.equal(p3.profitForThePeriod[0], pl.netProfit, 'the same profit, laid out differently');
    assert.equal(p3.previous.from, '2025-04-01');
  });
});

test('every standard ledger has its Schedule III line', () => {
  const line = (code: string) => {
    const a = STANDARD_ACCOUNTS.find((x) => x.code === code)!;
    return defaultLine({ code, type: a.type, subtype: a.subtype ?? null });
  };
  assert.equal(line(CODE.BANK_OD), 'short_term_borrowings');
  assert.equal(line(CODE.SECURED_LOANS), 'long_term_borrowings');
  assert.equal(line(CODE.UNSECURED_LOANS), 'long_term_borrowings');
  assert.equal(line(CODE.PROVISIONS), 'short_term_provisions');
  assert.equal(line(CODE.INCOME_TAX_PROVISION), 'short_term_provisions');
  assert.equal(line(CODE.DEPOSITS_RECEIVED), 'other_long_term_liabilities');
  assert.equal(line(CODE.SECURITY_DEPOSITS), 'long_term_loans_advances');
  assert.equal(line(CODE.LOANS_ADVANCES), 'short_term_loans_advances');
  assert.equal(line(CODE.INVESTMENTS), 'non_current_investments');
  assert.equal(line(CODE.CURRENT_INVESTMENTS), 'current_investments');
  assert.equal(line(CODE.MISC_EXPENSES_ASSET), 'other_non_current_assets');
  assert.equal(line(CODE.TCS_RECEIVABLE), 'other_current_assets');
  assert.equal(line(CODE.SUSPENSE), 'other_current_assets');
  assert.equal(line(CODE.DRAWINGS), 'share_capital', 'netted against the capital it came out of');
  assert.equal(line(CODE.DISCOUNT_RECEIVED), 'other_income');
  const codes = STANDARD_ACCOUNTS.map((a) => a.code);
  assert.equal(new Set(codes).size, codes.length, 'no code is used twice');
});

test('a CA can move an account to another Schedule III line', async () => {
  await withFixture(async (f) => {
    const loan = Number((await f.trx.insertInto('accounts').values({
      org_id: f.orgId, code: '2690', name: 'Loan from director', type: 'liability', schedule_iii_line: 'long_term_borrowings',
    }).executeTakeFirstOrThrow()).insertId);
    const acc = await accountIds(f.trx, f.orgId);
    const { postEntry } = await import('../../lib/server/ledger/posting');
    await postEntry(f.trx, {
      orgId: f.orgId, branchId: f.branchId, date: '2026-05-01', memo: 'Loan received',
      sourceType: 'manual', userId: null,
      lines: [{ accountId: acc[CODE.BANK_DEFAULT], debit: 5_00_000_00 }, { accountId: loan, credit: 5_00_000_00 }],
    });
    const s3 = await scheduleIIIBalanceSheet(f.trx, f.orgId, '2026-06-30');
    assert.equal(s3.equityAndLiabilities.find((l) => l.key === 'long_term_borrowings')!.currentPaise, 5_00_000_00);
    assert.ok(s3.balanced);
  });
});

test.after(async () => {
  await db.destroy();
});
