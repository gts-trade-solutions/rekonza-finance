// The client's unresolved checklist points: fund flow, stock ledger and
// ageing, collections, balance confirmations, bank statements in any layout,
// and the checklist page's evidence.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/checklist-gaps.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { postEntry } from '../../lib/server/ledger/posting';
import { createInvoice } from '../../lib/server/services/sales';
import { createBill } from '../../lib/server/services/purchases';
import { fundFlow } from '../../lib/server/reports/fund-flow';
import { stockAgeing, stockLedger } from '../../lib/server/reports/stock-movement';
import { collectionsWorkbench, logFollowUp } from '../../lib/server/services/collections';
import { recordReply, requestConfirmation } from '../../lib/server/services/balance-confirmations';
import { checklist } from '../../lib/server/services/checklist';
import { readStatementGrid, statementDate } from '../../lib/bank-statement';

interface Book { trx: Trx; orgId: number; branchId: number; customer: number; vendor: number; item: number }

async function withBook(fn: (b: Book) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Checklist Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1 }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const mk = (kind: string, name: string) => trx.insertInto('contacts').values({ org_id: orgId, kind, display_name: name, state_code: '33', gst_treatment: 'unregistered' } as never)
        .executeTakeFirstOrThrow().then((r) => Number(r.insertId));
      const item = Number((await trx.insertInto('items').values({ org_id: orgId, name: 'Brake pad', kind: 'goods', track_inventory: 1, uqc: 'NOS', sale_price: '500.0000', purchase_price: '300.0000' } as never).executeTakeFirstOrThrow()).insertId);
      await fn({ trx, orgId, branchId, customer: await mk('customer', 'Kumar'), vendor: await mk('vendor', 'Steel Co'), item });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

test('fund flow: sources equal applications; capital, the asset bought and depreciation in their places', async () => {
  await withBook(async ({ trx, orgId, branchId, customer }) => {
    const acc = await accountIds(trx, orgId);
    const post = (date: string, lines: { code: string; debit?: number; credit?: number }[]) => postEntry(trx, {
      orgId, branchId, date, memo: 'test', sourceType: 'manual', userId: null, module: 'accountant',
      lines: lines.map((l) => ({ accountId: acc[l.code], debit: l.debit, credit: l.credit })),
    });
    await post('2026-04-01', [{ code: CODE.BANK_DEFAULT, debit: 10_00_000_00 }, { code: CODE.CAPITAL, credit: 10_00_000_00 }]);
    await post('2026-05-10', [{ code: CODE.PLANT_MACHINERY, debit: 2_00_000_00 }, { code: CODE.BANK_DEFAULT, credit: 2_00_000_00 }]);
    await post('2026-09-30', [{ code: CODE.DEPRECIATION, debit: 20_000_00 }, { code: CODE.ACCUMULATED_DEPRECIATION, credit: 20_000_00 }]);
    await createInvoice(trx, orgId, null, { branchId, customerId: customer, date: '2026-06-01', dueDate: '2026-06-30', status: 'approved', lines: [{ description: 'Service', qty: 1, ratePaise: 1_00_000_00, gstRatePct: 0 }] });
    const f = await fundFlow(trx, orgId, '2026-04-01', '2027-03-31');
    assert.equal(f.balanced, true);
    assert.equal(f.operations.depreciationPaise, 20_000_00);
    assert.equal(f.operations.profitPaise, 80_000_00);
    assert.equal(f.operations.totalPaise, 1_00_000_00, 'profit with depreciation added back');
    assert.ok(f.sources.some((s) => /brought in/.test(s.label) && s.amountPaise === 10_00_000_00), 'capital brought in');
    assert.ok(f.applications.some((a) => /bought/.test(a.label) && a.amountPaise === 2_00_000_00), 'the asset, at cost');
    assert.equal(f.workingCapital.changePaise, 9_00_000_00, 'bank up ₹8 lakh, the receivable ₹1 lakh');
  });
});

test('stock ledger runs from the opening to the summary’s closing; ageing lays stock on the newest receipts', async () => {
  await withBook(async ({ trx, orgId, branchId, customer, vendor, item }) => {
    const acc = await accountIds(trx, orgId);
    await trx.insertInto('stock_adjustments').values({ org_id: orgId, item_id: item, adjust_date: '2026-01-01', qty_delta: '5.000', reason: 'opening' } as never).execute();
    await createBill(trx, orgId, null, { branchId, vendorId: vendor, vendorInvoiceNo: 'S-1', date: '2026-08-01', dueDate: '2026-08-31', lines: [{ itemId: item, qty: 10, ratePaise: 300_00, gstRatePct: 0, accountId: acc[CODE.PURCHASES] }] });
    await createInvoice(trx, orgId, null, { branchId, customerId: customer, date: '2026-09-01', dueDate: '2026-09-30', status: 'approved', lines: [{ itemId: item, qty: 4, ratePaise: 500_00, gstRatePct: 0 }] });
    await trx.insertInto('stock_adjustments').values({ org_id: orgId, item_id: item, adjust_date: '2026-09-15', qty_delta: '-2.000', reason: 'issued' } as never).execute();

    const l = await stockLedger(trx, orgId, item, '2026-04-01', '2026-10-31');
    assert.ok(l);
    assert.equal(l.openingQty, 5);
    assert.deepEqual(l.lines.map((x) => [x.kind, x.qtyIn, x.qtyOut, x.balanceQty]), [['Purchase', 10, 0, 15], ['Sale', 0, 4, 11], ['Adjustment: issued', 0, 2, 9]]);
    assert.equal(l.closingQty, 9, 'what the stock summary says');

    const a = await stockAgeing(trx, orgId, '2026-10-31');
    const row = a.rows.find((r) => r.itemId === String(item));
    assert.ok(row);
    assert.equal(row.qty, 9);
    // The 9 left are from the 1 August purchase: 91 days old on 31 October.
    assert.deepEqual(row.buckets, [0, 0, 0, 9, 0]);
  });
});

test('collections: a passed promise with money still owed is broken; balance confirmations agree or show the difference', async () => {
  await withBook(async ({ trx, orgId, branchId, customer, vendor }) => {
    const acc = await accountIds(trx, orgId);
    await createInvoice(trx, orgId, null, { branchId, customerId: customer, date: '2026-08-01', dueDate: '2026-08-31', status: 'approved', lines: [{ description: 'Goods', qty: 1, ratePaise: 50_000_00, gstRatePct: 0 }] });
    await assert.rejects(logFollowUp(trx, orgId, { id: null, name: 'A' }, { contactId: customer, kind: 'call', note: ' ' }), /Say what happened/);
    await logFollowUp(trx, orgId, { id: null, name: 'Asha' }, { contactId: customer, kind: 'call', note: 'Will pay by the 10th', promisedDate: '2026-10-10', promisedPaise: 50_000_00 });
    const w = await collectionsWorkbench(trx, orgId, '2026-10-20');
    assert.equal(w.length, 1);
    assert.equal(w[0].overduePaise, 50_000_00);
    assert.equal(w[0].oldestDays, 50);
    assert.deepEqual(w[0].promise, { date: '2026-10-10', amountPaise: 50_000_00, broken: true });
    assert.equal(w[0].dueToday, true, 'the chase date (the promise date) has come');

    await createBill(trx, orgId, null, { branchId, vendorId: vendor, vendorInvoiceNo: 'V-9', date: '2026-09-01', dueDate: '2026-09-30', lines: [{ accountId: acc[CODE.OFFICE], description: 'Steel', qty: 1, ratePaise: 30_000_00, gstRatePct: 0 }] });
    const c = await requestConfirmation(trx, orgId, null, { contactId: vendor, side: 'vendor', asOf: '2026-09-30' });
    assert.equal(c.ourBalancePaise, 30_000_00);
    await assert.rejects(requestConfirmation(trx, orgId, null, { contactId: vendor, side: 'vendor', asOf: '2026-09-30' }), /already recorded/);
    assert.deepEqual(await recordReply(trx, orgId, c.id, { theirBalancePaise: 31_500_00, notes: 'Their freight bill not with us' }), { agreed: false, differencePaise: -1_500_00 });
    assert.deepEqual(await recordReply(trx, orgId, c.id, { theirBalancePaise: 30_000_00 }), { agreed: true, differencePaise: 0 });
  });
});

test('bank statements in a bank’s own layout: header found below account details, Indian dates, Dr/Cr amounts', () => {
  assert.equal(statementDate('01/10/2026'), '2026-10-01');
  assert.equal(statementDate('5-11-26'), '2026-11-05');
  assert.equal(statementDate('07 Oct 2026'), '2026-10-07');
  assert.equal(statementDate('31/13/2026'), null);
  const hdfc = readStatementGrid([
    ['HDFC BANK Ltd.'], ['Account No : 50100012345678'], [],
    ['Date', 'Narration', 'Chq./Ref.No.', 'Value Dt', 'Withdrawal Amt.', 'Deposit Amt.', 'Closing Balance'],
    ['01/10/26', 'NEFT-KUMAR STORES', 'N274', '01/10/26', '', '1,18,000.00', '2,18,000.00'],
    ['03/10/26', 'CHQ PAID-STEEL CO', '000123', '03/10/26', '30,000.00', '', '1,88,000.00'],
  ]);
  assert.equal(hdfc.problem, null);
  assert.deepEqual(hdfc.rows.map((r) => [r.date, r.depositPaise, r.withdrawalPaise, r.reference]), [['2026-10-01', 1_18_000_00, 0, 'N274'], ['2026-10-03', 0, 30_000_00, '000123']]);
  const oneColumn = readStatementGrid([
    ['Txn Date', 'Description', 'Amount', 'Dr/Cr'],
    ['02-10-2026', 'UPI/RAVI', '500.00', 'CR'],
    ['04-10-2026', 'ATM WDL', '2000.00', 'DR'],
  ]);
  assert.deepEqual(oneColumn.rows.map((r) => [r.depositPaise, r.withdrawalPaise]), [[500_00, 0], [0, 2000_00]]);
  assert.match(readStatementGrid([['a', 'b'], ['1', '2']]).problem ?? '', /No header row/);
});

test('the checklist answers every area with evidence and somewhere to see it', async () => {
  await withBook(async ({ trx, orgId }) => {
    const areas = await checklist(trx, orgId);
    assert.deepEqual(areas.map((a) => a.area), [
      'Organisation, Exports & Roles', 'Company Management', 'Security & Audit Trail', 'Master Data', 'Accounting Vouchers', 'Inventory', 'Banking',
      'Accounts Receivable', 'Accounts Payable', 'Fixed Assets', 'Payroll', 'GST & Compliance', 'Budgeting & Costing', 'Reporting', 'Integration',
    ]);
    for (const a of areas) {
      assert.ok(a.evidence.length >= 2 || a.key === 'assets', `${a.area} has evidence`);
      assert.ok(a.screens.length >= 1, `${a.area} links to a screen`);
    }
  });
});

test.after(() => db.destroy());
