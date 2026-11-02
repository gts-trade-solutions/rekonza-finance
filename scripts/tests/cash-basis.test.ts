// Zoho's "Report basis: Cash" on the profit and loss, balance sheet and trial
// balance (lib/server/reports/statements.ts): a sale counts when it is paid,
// in the share paid and on the day paid; a cost when it is paid; everything
// paid at once counts on its own date; and the statements still tie.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/cash-basis.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { createInvoice } from '../../lib/server/services/sales';
import { createBill, createExpense } from '../../lib/server/services/purchases';
import { createCreditNote, refundCreditNote } from '../../lib/server/services/sales-documents';
import { makePayment, receivePayment } from '../../lib/server/services/payments';
import { balanceSheet, profitAndLoss, trialBalance } from '../../lib/server/reports/statements';

interface Book { trx: Trx; orgId: number; branchId: number; customer: number; vendor: number; bankId: number; acc: Record<string, number> }

async function withBook(fn: (b: Book) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Cash Basis Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1, gstin: '33AABCC9393C1Z2' }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const acc = await accountIds(trx, orgId) as Record<string, number>;
      const bankId = Number((await trx.insertInto('bank_accounts').values({ org_id: orgId, kind: 'bank', name: 'Current', ledger_account_id: acc[CODE.BANK_DEFAULT], opening_balance: '0.0000' }).executeTakeFirstOrThrow()).insertId);
      const mk = (kind: string, name: string) => trx.insertInto('contacts').values({ org_id: orgId, kind, display_name: name, state_code: '33', gst_treatment: 'unregistered' } as never)
        .executeTakeFirstOrThrow().then((r) => Number(r.insertId));
      await fn({ trx, orgId, branchId, bankId, acc, customer: await mk('customer', 'Kumar Stores'), vendor: await mk('vendor', 'Steel Co') });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

const sum = (rows: { balancePaise: number }[]) => rows.reduce((t, r) => t + r.balancePaise, 0);
const row = (rows: { code: string; balancePaise: number }[], code: string) => rows.find((r) => r.code === code)?.balancePaise ?? 0;

test('a sale counts as it is paid, a bill when paid, an expense paid at once on its day', async () => {
  await withBook(async ({ trx, orgId, branchId, customer, vendor, bankId, acc }) => {
    // ₹1,000 + 18% GST invoiced in September; half of it paid in October.
    const inv = await createInvoice(trx, orgId, null, {
      branchId, customerId: customer, date: '2026-09-05', dueDate: '2026-09-30', status: 'approved',
      lines: [{ description: 'Goods', qty: 1, ratePaise: 1_000_00, gstRatePct: 18 }],
    });
    await receivePayment(trx, orgId, null, {
      branchId, contactId: customer, date: '2026-10-10', mode: 'neft', amountPaise: 590_00, bankAccountId: bankId,
      allocations: [{ targetType: 'invoice', targetId: inv.id, amountPaise: 590_00 }],
    });
    // A ₹500 bill in September, paid the same month; ₹200 spent straight from the bank.
    const bill = await createBill(trx, orgId, null, {
      branchId, vendorId: vendor, vendorInvoiceNo: 'SC-1', date: '2026-09-10', dueDate: '2026-10-10', status: 'open',
      lines: [{ description: 'Steel', qty: 1, ratePaise: 500_00, gstRatePct: 0 }],
    } as never);
    await makePayment(trx, orgId, null, {
      branchId, contactId: vendor, date: '2026-09-20', mode: 'neft', amountPaise: 500_00, bankAccountId: bankId,
      allocations: [{ targetType: 'bill', targetId: bill.id, amountPaise: 500_00 }],
    });
    await createExpense(trx, orgId, null, { branchId, date: '2026-09-15', accountId: acc[CODE.RENT], paidThroughBankAccountId: bankId, amountPaise: 200_00 });

    const accrualSep = await profitAndLoss(trx, orgId, '2026-09-01', '2026-09-30');
    assert.equal(accrualSep.basis, 'accrual');
    assert.equal(accrualSep.totalIncome, 1_000_00);
    assert.equal(accrualSep.totalExpense, 700_00);

    const cashSep = await profitAndLoss(trx, orgId, '2026-09-01', '2026-09-30', undefined, 'cash');
    assert.equal(cashSep.basis, 'cash');
    assert.equal(cashSep.totalIncome, 0, 'nothing received in September');
    assert.equal(cashSep.totalExpense, 700_00, 'the bill was paid, the rent was paid');

    const cashOct = await profitAndLoss(trx, orgId, '2026-10-01', '2026-10-31', undefined, 'cash');
    assert.equal(cashOct.totalIncome, 500_00, 'half the invoice paid: half its sale, in October');
    assert.equal(cashOct.totalExpense, 0);

    const both = await profitAndLoss(trx, orgId, '2026-09-01', '2026-10-31', undefined, 'cash');
    assert.equal(both.totalIncome, cashSep.totalIncome + cashOct.totalIncome, 'periods add up');

    // The position at the end of October, cash basis: still balanced; half the GST, nothing owed either way.
    const bs = await balanceSheet(trx, orgId, '2026-10-31', undefined, 'cash');
    assert.equal(bs.basis, 'cash');
    assert.ok(bs.balanced, `assets ${bs.totalAssets} = liabilities ${bs.totalLiabilities} + equity ${bs.totalEquity}`);
    assert.equal(row(bs.assetRows, CODE.AR), 0, 'receivables leave the cash basis');
    assert.equal(row(bs.liabilityRows, CODE.AP), 0, 'and payables');
    assert.equal(row(bs.liabilityRows, CODE.GST_CGST) + row(bs.liabilityRows, CODE.GST_SGST), 90_00, 'tax on what was paid');
    assert.equal(row(bs.assetRows, CODE.BANK_DEFAULT), 590_00 - 500_00 - 200_00, 'the bank is the bank on either basis');
    assert.equal(bs.currentPeriodEarnings, 500_00 - 700_00);

    const accrualBs = await balanceSheet(trx, orgId, '2026-10-31');
    assert.equal(row(accrualBs.assetRows, CODE.AR), 590_00, 'the accrual sheet still shows the half owed');

    const tb = await trialBalance(trx, orgId, '2026-10-31', undefined, 'cash');
    assert.ok(tb.balanced);
    assert.equal(tb.totalDebit, tb.totalCredit);
  });
});

test('a payment made before its invoice counts from the invoice date; a credit note set off counts for nothing, refunded it counts when refunded', async () => {
  await withBook(async ({ trx, orgId, branchId, customer, bankId }) => {
    // An advance in August, applied to an invoice raised in September.
    const advance = await receivePayment(trx, orgId, null, { branchId, contactId: customer, date: '2026-08-20', mode: 'upi', amountPaise: 300_00, bankAccountId: bankId });
    const inv = await createInvoice(trx, orgId, null, {
      branchId, customerId: customer, date: '2026-09-02', dueDate: '2026-09-30', status: 'approved',
      lines: [{ description: 'Service', qty: 1, ratePaise: 300_00, gstRatePct: 0 }],
    });
    await trx.insertInto('payment_allocations').values({ org_id: orgId, payment_id: advance.id, target_type: 'invoice', target_id: inv.id, amount: '300.0000', applied_on: '2026-09-02' } as never).execute();
    assert.equal((await profitAndLoss(trx, orgId, '2026-08-01', '2026-08-31', undefined, 'cash')).totalIncome, 0, 'not a sale before there was one');
    assert.equal((await profitAndLoss(trx, orgId, '2026-09-01', '2026-09-30', undefined, 'cash')).totalIncome, 300_00);

    // ₹1,000 invoiced, ₹200 credited against it, ₹800 paid: ₹800 of sales on the cash basis.
    const inv2 = await createInvoice(trx, orgId, null, {
      branchId, customerId: customer, date: '2026-10-01', dueDate: '2026-10-31', status: 'approved',
      lines: [{ description: 'Goods', qty: 1, ratePaise: 1_000_00, gstRatePct: 0 }],
    });
    await createCreditNote(trx, orgId, null, { branchId, customerId: customer, date: '2026-10-03', reason: 'Short supply', againstInvoiceId: inv2.id, lines: [{ description: 'Goods', qty: 1, ratePaise: 200_00, gstRatePct: 0 }] });
    await receivePayment(trx, orgId, null, {
      branchId, contactId: customer, date: '2026-10-15', mode: 'neft', amountPaise: 800_00, bankAccountId: bankId,
      allocations: [{ targetType: 'invoice', targetId: inv2.id, amountPaise: 800_00 }],
    });
    const oct = await profitAndLoss(trx, orgId, '2026-10-01', '2026-10-31', undefined, 'cash');
    assert.equal(oct.totalIncome, 800_00);
    assert.equal(sum(oct.incomeRows), 800_00);

    // A credit note for goods returned after paying, refunded in November: the refund is the sale coming back.
    const cn = await createCreditNote(trx, orgId, null, { branchId, customerId: customer, date: '2026-11-02', reason: 'Returned', lines: [{ description: 'Goods', qty: 1, ratePaise: 100_00, gstRatePct: 0 }] });
    assert.equal((await profitAndLoss(trx, orgId, '2026-11-01', '2026-11-30', undefined, 'cash')).totalIncome, 0, 'an unused credit is no money');
    await refundCreditNote(trx, orgId, null, cn.id, { date: '2026-11-05', amountPaise: 100_00, bankAccountId: bankId, mode: 'neft' } as never);
    assert.equal((await profitAndLoss(trx, orgId, '2026-11-01', '2026-11-30', undefined, 'cash')).totalIncome, -100_00);

    const bs = await balanceSheet(trx, orgId, '2026-11-30', undefined, 'cash');
    assert.ok(bs.balanced);
    assert.equal(row(bs.assetRows, CODE.AR), 0);
    assert.ok((await trialBalance(trx, orgId, '2026-11-30', undefined, 'cash')).balanced);
  });
});

test('stock bought on credit and not yet paid for is no cash-basis profit, and the sheet still ties', async () => {
  await withBook(async ({ trx, orgId, branchId, vendor, bankId }) => {
    const item = Number((await trx.insertInto('items').values({ org_id: orgId, name: 'Pump', kind: 'goods', track_inventory: 1, uqc: 'NOS', purchase_price: '0.0000', sale_price: '0.0000' } as never).executeTakeFirstOrThrow()).insertId);
    const bill = await createBill(trx, orgId, null, {
      branchId, vendorId: vendor, vendorInvoiceNo: 'PW-1', date: '2026-09-05', dueDate: '2026-10-05', status: 'open',
      lines: [{ itemId: item, qty: 10, ratePaise: 250_00, gstRatePct: 0 }],
    } as never);
    // ₹2,500 of pumps, ₹200 paid.
    await makePayment(trx, orgId, null, {
      branchId, contactId: vendor, date: '2026-09-20', mode: 'neft', amountPaise: 200_00, bankAccountId: bankId,
      allocations: [{ targetType: 'bill', targetId: bill.id, amountPaise: 200_00 }],
    });
    const accrual = await profitAndLoss(trx, orgId, '2026-09-01', '2026-09-30');
    assert.equal(accrual.closingStockPaise, 2_500_00);
    assert.equal(accrual.netProfit, 0, 'bought and still on hand: no profit or loss');

    const cash = await profitAndLoss(trx, orgId, '2026-09-01', '2026-09-30', undefined, 'cash');
    assert.equal(cash.closingStockPaise, 0, 'no stock valued from the documents on the cash basis');
    assert.equal(cash.netProfit, -200_00, 'what was paid out, not the goods unpaid for');

    const bs = await balanceSheet(trx, orgId, '2026-09-30', undefined, 'cash');
    assert.equal(bs.closingStockPaise, 0);
    assert.ok(bs.balanced, `assets ${bs.totalAssets} = liabilities ${bs.totalLiabilities} + equity ${bs.totalEquity}`);
  });
});

test.after(async () => {
  await db.destroy();
});
