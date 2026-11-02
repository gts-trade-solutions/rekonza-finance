// The rest of Zoho Books' report list (lib/server/reports/zoho-reports.ts),
// checked against a small book whose figures are known: purchases by item,
// order and credit details, expenses by customer and project, billable
// expenses, timesheets and projects, the receivable and payable registers,
// sales summary, ABC classification, inventory valuation, committed stock,
// bank reconciliation status, exchange gain or loss, and system mails.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/zoho-reports.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { createInvoice } from '../../lib/server/services/sales';
import { createBill, createExpense } from '../../lib/server/services/purchases';
import { createCreditNote, createSalesOrder } from '../../lib/server/services/sales-documents';
import { createPurchaseOrder, createVendorCredit } from '../../lib/server/services/purchase-documents';
import { logTime, saveProject } from '../../lib/server/services/projects';
import {
  abcClassification, billableExpenseDetails, committedStock, expensesBy, inventoryValuation, partyRegister, projectSummary,
  purchaseOrderDetails, purchasesByItem, realisedFx, reconciliationStatus, salesSummary, systemMails, timesheetDetails, unrealisedFx,
  vendorCreditDetails,
} from '../../lib/server/reports/zoho-reports';

const W = { from: '2026-09-01', to: '2026-09-30' };

test('Zoho’s longer report list, against a book whose figures are known', async () => {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Report Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1, gstin: '33AABCR7171R1Z3' }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const acc = await accountIds(trx, orgId);
      const contact = (kind: string, name: string) => trx.insertInto('contacts').values({ org_id: orgId, kind, display_name: name, state_code: '33', gst_treatment: 'unregistered' } as never)
        .executeTakeFirstOrThrow().then((r) => Number(r.insertId));
      const item = (name: string, track: number, buy: string, sell: string) => trx.insertInto('items').values({ org_id: orgId, name, kind: 'goods', track_inventory: track, uqc: 'NOS', purchase_price: buy, sale_price: sell } as never)
        .executeTakeFirstOrThrow().then((r) => Number(r.insertId));
      const customer = await contact('customer', 'Kumar Stores');
      const vendor = await contact('vendor', 'Steel Co');
      const pads = await item('Brake pad', 1, '60.0000', '100.0000');
      const oil = await item('Engine oil', 1, '200.0000', '300.0000');
      const wiper = await item('Wiper', 0, '50.0000', '100.0000');
      const bankId = Number((await trx.insertInto('bank_accounts').values({ org_id: orgId, kind: 'bank', name: 'Current', ledger_account_id: acc[CODE.BANK_DEFAULT], opening_balance: '0.0000' }).executeTakeFirstOrThrow()).insertId);
      const userId = Number((await trx.insertInto('users').values({ org_id: orgId, name: 'Ravi', email: `ravi-${orgId}@example.test`, role: 'staff' }).executeTakeFirstOrThrow()).insertId);

      // Bought: 10 pads at ₹60, 5 oil at ₹200. A ₹100 credit from the vendor; an order for 4 more pads.
      const bill = await createBill(trx, orgId, null, { branchId, vendorId: vendor, vendorInvoiceNo: 'SC-77', date: '2026-09-02', dueDate: '2026-09-20', lines: [
        { itemId: pads, qty: 10, ratePaise: 60_00, gstRatePct: 0 }, { itemId: oil, qty: 5, ratePaise: 200_00, gstRatePct: 0 },
      ] });
      await createVendorCredit(trx, orgId, null, { branchId, vendorId: vendor, date: '2026-09-05', reason: 'Two pads damaged', againstBillId: bill.id, amountPaise: 100_00, gstRatePct: 0 });
      await createPurchaseOrder(trx, orgId, null, { branchId, vendorId: vendor, date: '2026-09-06', lines: [{ itemId: pads, qty: 4, ratePaise: 60_00, gstRatePct: 0 }] });

      // Sold: 6 pads (₹600), 1 oil (₹300), 1 wiper (₹100). A ₹100 credit note, with no goods back. 3 pads still on order.
      await createInvoice(trx, orgId, null, { branchId, customerId: customer, date: '2026-09-10', dueDate: '2026-09-25', status: 'approved', lines: [
        { itemId: pads, qty: 6, ratePaise: 100_00, gstRatePct: 0 }, { itemId: oil, qty: 1, ratePaise: 300_00, gstRatePct: 0 }, { itemId: wiper, qty: 1, ratePaise: 100_00, gstRatePct: 0 },
      ] });
      await createCreditNote(trx, orgId, null, { branchId, customerId: customer, date: '2026-09-12', reason: 'Late delivery', lines: [{ description: 'Discount for late delivery', qty: 1, ratePaise: 100_00, gstRatePct: 0 }] });
      await createSalesOrder(trx, orgId, null, { branchId, customerId: customer, date: '2026-09-14', lines: [{ itemId: pads, qty: 3, ratePaise: 100_00, gstRatePct: 0 }] });

      // A project: 2 hours billable, 1 not; a ₹500 billable expense on it, and ₹200 of other spending.
      const projectId = await saveProject(trx, orgId, null, { customerId: customer, name: 'Fleet servicing', billingMethod: 'project_hours', ratePaise: 1_000_00 });
      await logTime(trx, orgId, null, { projectId, userId, date: '2026-09-15', minutes: 120, billable: true, notes: 'Inspection' });
      await logTime(trx, orgId, null, { projectId, userId, date: '2026-09-16', minutes: 60, billable: false });
      await createExpense(trx, orgId, null, { branchId, date: '2026-09-15', accountId: acc[CODE.FUEL], paidThroughBankAccountId: bankId, amountPaise: 500_00, isBillable: true, billableCustomerId: customer, projectId });
      await createExpense(trx, orgId, null, { branchId, date: '2026-09-16', accountId: acc[CODE.OFFICE], paidThroughBankAccountId: bankId, amountPaise: 200_00 });

      // ── Purchases
      const byItem = await purchasesByItem(trx, orgId, W);
      assert.deepEqual(byItem.map((r) => [r.name, r.qty, r.amountPaise, r.averagePaise, r.bills]), [['Engine oil', 5, 1_000_00, 200_00, 1], ['Brake pad', 10, 600_00, 60_00, 1]]);
      const credits = await vendorCreditDetails(trx, orgId, W);
      assert.deepEqual(credits.map((c) => [c.vendor, c.againstBill, c.totalPaise, c.reason]), [['Steel Co', (await trx.selectFrom('bills').select('internal_no').where('id', '=', bill.id).executeTakeFirstOrThrow()).internal_no, 100_00, 'Two pads damaged']]);
      const orders = await purchaseOrderDetails(trx, orgId, W);
      assert.deepEqual(orders.map((o) => [o.vendor, o.orderedQty, o.receivedQty, o.totalPaise, o.status]), [['Steel Co', 4, 0, 240_00, 'open']]);
      const payables = await partyRegister(trx, orgId, 'vendor', W);
      assert.deepEqual(payables.map((r) => [r.kind, r.totalPaise]).sort(), [['Bill', 1_600_00], ['Vendor credit', -100_00]]);

      // ── Expenses and projects
      const byCustomer = await expensesBy(trx, orgId, 'customer', W);
      assert.deepEqual(byCustomer.map((r) => [r.name, r.count, r.amountPaise, r.billablePaise]), [['Kumar Stores', 1, 500_00, 500_00], ['No customer', 1, 200_00, 0]]);
      const byProject = await expensesBy(trx, orgId, 'project', W);
      assert.deepEqual(byProject.map((r) => [r.name, r.amountPaise]), [['Fleet servicing', 500_00], ['No project', 200_00]]);
      const billable = await billableExpenseDetails(trx, orgId, W);
      assert.deepEqual(billable.map((r) => [r.customer, r.project, r.totalPaise, r.invoice]), [['Kumar Stores', 'Fleet servicing', 500_00, null]]);
      const time = await timesheetDetails(trx, orgId, W);
      assert.deepEqual(time.map((t) => [t.date, t.hours, t.billable, t.user]), [['2026-09-16', 1, false, 'Ravi'], ['2026-09-15', 2, true, 'Ravi']]);
      const projects = await projectSummary(trx, orgId, W);
      assert.deepEqual(projects.map((p) => [p.name, p.hours, p.billableHours, p.billedHours, p.expensesPaise, p.marginPaise]), [['Fleet servicing', 3, 2, 0, 500_00, -500_00]]);

      // ── Sales
      const receivables = await partyRegister(trx, orgId, 'customer', W);
      assert.deepEqual(receivables.map((r) => [r.kind, r.totalPaise, r.balancePaise]).sort(), [['Credit note', -100_00, -100_00], ['Invoice', 1_000_00, 1_000_00]]);
      const summary = await salesSummary(trx, orgId, W);
      assert.deepEqual(summary.map((s) => [s.month, s.invoices, s.taxablePaise, s.creditNotes, s.creditTaxablePaise, s.netSalesPaise]), [['2026-09', 1, 1_000_00, 1, 100_00, 900_00]]);
      const abc = await abcClassification(trx, orgId, W);
      assert.deepEqual(abc.map((r) => [r.name, r.amountPaise, r.klass]), [['Brake pad', 600_00, 'A'], ['Engine oil', 300_00, 'A'], ['Wiper', 100_00, 'C']]);
      assert.equal(Math.round(abc[2].cumulativePct), 100);

      // ── Stock: 4 pads and 4 oil on hand; 3 pads promised on the open order.
      const value = await inventoryValuation(trx, orgId, '2026-09-30');
      assert.deepEqual(value.rows.map((r) => [r.name, r.qty, r.valuePaise]), [['Engine oil', 4, 800_00], ['Brake pad', 4, 240_00]]);
      assert.equal(value.totalValuePaise, 1_040_00);
      const committed = await committedStock(trx, orgId, '2026-09-30');
      assert.deepEqual(committed.map((c) => [c.name, c.onHandQty, c.committedQty, c.availableQty, c.orders]), [['Brake pad', 4, 3, 1, 1]]);

      // ── Banking: one statement line matched, one not.
      await trx.insertInto('bank_transactions').values([
        { org_id: orgId, bank_account_id: bankId, txn_date: '2026-09-15', narration: 'FUEL', withdrawal: '500.0000', deposit: '0.0000', status: 'matched', running_balance: '-500.0000', dedupe_hash: `a-${orgId}` },
        { org_id: orgId, bank_account_id: bankId, txn_date: '2026-09-16', narration: 'OFFICE', withdrawal: '200.0000', deposit: '0.0000', status: 'unmatched', running_balance: '-700.0000', dedupe_hash: `b-${orgId}` },
      ] as never).execute();
      const recon = await reconciliationStatus(trx, orgId, '2026-09-30');
      const current = recon.find((r) => r.name === 'Current')!;
      assert.deepEqual([current.lines, current.matched, current.unmatched, current.unmatchedOutPaise], [2, 1, 1, 200_00]);
      assert.equal(current.bookBalancePaise, -700_00, 'the books: ₹500 and ₹200 out');
      assert.equal(current.statementBalancePaise, -700_00);
      assert.equal(current.differencePaise, 0);

      // ── Exchange: nothing foreign here; the reports say so rather than fail.
      assert.deepEqual(await realisedFx(trx, orgId, W), []);
      assert.deepEqual(await unrealisedFx(trx, orgId, '2026-09-30'), []);

      // ── System mails
      await trx.insertInto('email_log').values({ org_id: orgId, to_address: 'kumar@x.test', subject: 'Invoice INV-1', status: 'failed', error: 'SMTP refused', doc_type: 'invoice', created_at: new Date('2026-09-10T06:00:00Z') } as never).execute();
      const mails = await systemMails(trx, orgId, W);
      assert.deepEqual(mails.map((m) => [m.to, m.subject, m.status, m.error]), [['kumar@x.test', 'Invoice INV-1', 'failed', 'SMTP refused']]);
      assert.deepEqual(await systemMails(trx, orgId, { from: '2026-10-01', to: '2026-10-31' }), []);

      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
});

test.after(() => db.destroy());
