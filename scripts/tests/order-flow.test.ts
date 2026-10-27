// The order flow, line by line: part-invoicing, challans, receipt notes and
// the three-way match.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/order-flow.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { createChallan, createEstimate, createSalesOrder, salesOrderFromEstimate } from '../../lib/server/services/sales-documents';
import { pendingPurchaseOrders, pendingSalesOrders } from '../../lib/server/reports/orders';
import { createPurchaseOrder } from '../../lib/server/services/purchase-documents';
import {
  acceptBillMismatch, billFromGoodsReceipt, billFromPurchaseOrder, cancelGoodsReceipt, challanFromSalesOrder,
  invoiceFromChallan, invoiceFromSalesOrder, receiveFromPurchaseOrder,
} from '../../lib/server/services/order-flow';
import { makePayment } from '../../lib/server/services/payments';
import { stockPosition } from '../../lib/server/reports/stock';
import { toPaiseFromSql } from '../../lib/server/money-sql';

interface Fixture {
  trx: Trx; orgId: number; branchId: number; acc: Record<string, number>; bankId: number;
  customer: number; vendor: number; itemId: number;
}

async function withFixture(fn: (f: Fixture) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Order Flow Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({
        org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1,
      }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const acc = await accountIds(trx, orgId);
      await trx.insertInto('hsn_codes').values({ org_id: orgId, code: '8708', kind: 'hsn', description: 'Parts', gst_rate_pct: 18, is_active: 1 }).execute();
      const mk = async (values: Record<string, unknown>) =>
        Number((await trx.insertInto('contacts').values({ org_id: orgId, state_code: '33', ...values } as never).executeTakeFirstOrThrow()).insertId);
      await fn({
        trx, orgId, branchId, acc,
        bankId: Number((await trx.insertInto('bank_accounts').values({
          org_id: orgId, kind: 'bank', name: 'Bank', ledger_account_id: acc[CODE.BANK_DEFAULT], opening_balance: '0.0000',
        }).executeTakeFirstOrThrow()).insertId),
        customer: await mk({ kind: 'customer', display_name: 'Buyer', gst_treatment: 'unregistered' }),
        vendor: await mk({ kind: 'vendor', display_name: 'Maker', gst_treatment: 'registered', gstin: '33AAACS3333S1Z3' }),
        itemId: Number((await trx.insertInto('items').values({
          org_id: orgId, kind: 'goods', name: 'Disc', hsn_sac: '8708', uqc: 'NOS', sale_price: '200.0000',
          purchase_price: '100.0000', gst_rate_pct: 18, track_inventory: 1,
        }).executeTakeFirstOrThrow()).insertId),
      });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

const lineIds = async (f: Fixture, table: 'sales_order_lines' | 'purchase_order_lines' | 'challan_lines' | 'goods_receipt_lines', fk: string, id: number) =>
  (await sql<{ id: number }>`SELECT id FROM ${sql.table(table)} WHERE ${sql.ref(fk)} = ${id} ORDER BY line_no`.execute(f.trx)).rows.map((r) => Number(r.id));
const balance = async (f: Fixture, code: string) => toPaiseFromSql((await sql<{ b: string }>`
  SELECT COALESCE(SUM(debit - credit), 0) AS b FROM journal_lines WHERE account_id = ${f.acc[code]}
`.execute(f.trx)).rows[0].b);
const onHand = async (f: Fixture, asOf = '2026-12-31') =>
  (await stockPosition(f.trx, f.orgId, asOf)).lines.find((l) => l.itemId === String(f.itemId))?.qty ?? 0;

test('an order is invoiced in parts, and never twice', async () => {
  await withFixture(async (f) => {
    const so = await createSalesOrder(f.trx, f.orgId, null, {
      branchId: f.branchId, customerId: f.customer, date: '2026-08-01', lines: [{ itemId: f.itemId, qty: 10 }],
    });
    const [line] = await lineIds(f, 'sales_order_lines', 'sales_order_id', so.id);
    await invoiceFromSalesOrder(f.trx, f.orgId, null, so.id, { date: '2026-08-02', dueDate: '2026-08-30', lines: [{ lineId: line, qty: 4 }] });
    let row = await f.trx.selectFrom('sales_orders').select(['status']).where('id', '=', so.id).executeTakeFirstOrThrow();
    assert.equal(row.status, 'partially_invoiced');

    await assert.rejects(
      invoiceFromSalesOrder(f.trx, f.orgId, null, so.id, { date: '2026-08-03', dueDate: '2026-08-30', lines: [{ lineId: line, qty: 7 }] }),
      /has 6 left/,
    );
    await invoiceFromSalesOrder(f.trx, f.orgId, null, so.id, { date: '2026-08-03', dueDate: '2026-08-30' });
    row = await f.trx.selectFrom('sales_orders').select(['status']).where('id', '=', so.id).executeTakeFirstOrThrow();
    assert.equal(row.status, 'invoiced');
    await assert.rejects(
      invoiceFromSalesOrder(f.trx, f.orgId, null, so.id, { date: '2026-08-04', dueDate: '2026-08-30' }),
      /invoiced|Nothing is left/,
    );
  });
});

test('order → challan → invoice: goods leave stock on the invoice, and the order keeps count', async () => {
  await withFixture(async (f) => {
    await f.trx.updateTable('items').set({ opening_stock_qty: '20', opening_stock_rate: '100.0000' }).where('id', '=', f.itemId).execute();
    const so = await createSalesOrder(f.trx, f.orgId, null, {
      branchId: f.branchId, customerId: f.customer, date: '2026-08-01', lines: [{ itemId: f.itemId, qty: 10 }],
    });
    const dc = await challanFromSalesOrder(f.trx, f.orgId, null, so.id, { date: '2026-08-02' });
    assert.equal(await onHand(f), 20, 'a challan alone does not take goods out of stock');

    // The order no longer offers what is on the challan.
    await assert.rejects(
      invoiceFromSalesOrder(f.trx, f.orgId, null, so.id, { date: '2026-08-03', dueDate: '2026-08-30' }),
      /Nothing is left/,
    );

    const [dcLine] = await lineIds(f, 'challan_lines', 'challan_id', dc.id);
    const inv = await invoiceFromChallan(f.trx, f.orgId, null, dc.id, { date: '2026-08-05', dueDate: '2026-09-05', lines: [{ lineId: dcLine, qty: 6 }] });
    assert.equal(await onHand(f), 14);
    const invLine = await f.trx.selectFrom('invoice_lines').select(['gst_rate_pct', 'source_line_type', 'rate']).where('invoice_id', '=', inv.id).executeTakeFirstOrThrow();
    assert.equal(Number(invLine.gst_rate_pct), 18, 'the order\'s rate');
    assert.equal(invLine.source_line_type, 'challan');

    const dcRow = await f.trx.selectFrom('delivery_challans').select(['status']).where('id', '=', dc.id).executeTakeFirstOrThrow();
    assert.equal(dcRow.status, 'partially_invoiced');
    const soLine = await f.trx.selectFrom('sales_order_lines').select(['qty_delivered', 'qty_invoiced']).where('sales_order_id', '=', so.id).executeTakeFirstOrThrow();
    assert.equal(Number(soLine.qty_delivered), 10);
    assert.equal(Number(soLine.qty_invoiced), 6);
  });
});

test('goods sent for job work are not invoiced', async () => {
  await withFixture(async (f) => {
    const dc = await createChallan(f.trx, f.orgId, null, {
      branchId: f.branchId, customerId: f.customer, date: '2026-08-01', challanType: 'job_work',
      lines: [{ itemId: f.itemId, qty: 2 }],
    });
    await assert.rejects(
      invoiceFromChallan(f.trx, f.orgId, null, dc.id, { date: '2026-08-02', dueDate: '2026-08-30' }),
      /job work/,
    );
  });
});

test('a receipt note brings goods in and accrues them; the bill clears the accrual', async () => {
  await withFixture(async (f) => {
    const po = await createPurchaseOrder(f.trx, f.orgId, null, {
      branchId: f.branchId, vendorId: f.vendor, date: '2026-08-01', lines: [{ itemId: f.itemId, qty: 10, ratePaise: 100_00 }],
    });
    const grn = await receiveFromPurchaseOrder(f.trx, f.orgId, null, po.id, {
      date: '2026-08-05', lines: [{ lineId: (await lineIds(f, 'purchase_order_lines', 'purchase_order_id', po.id))[0], qty: 6 }],
    });
    assert.equal(await onHand(f), 6, 'in stock the day it arrives');
    assert.equal(await balance(f, CODE.GOODS_RECEIVED_NOT_BILLED), -600_00, 'a liability of 600 until billed');
    assert.equal(await balance(f, CODE.PURCHASES), 600_00);

    // The rest of the order cannot be billed straight away while goods wait on the note.
    const [poLine] = await lineIds(f, 'purchase_order_lines', 'purchase_order_id', po.id);
    await assert.rejects(
      billFromPurchaseOrder(f.trx, f.orgId, null, po.id, { vendorInvoiceNo: 'M-1', date: '2026-08-06', dueDate: '2026-09-06', lines: [{ lineId: poLine, qty: 10 }] }),
      /receipt note .* still to be billed/,
    );

    const bill = await billFromGoodsReceipt(f.trx, f.orgId, null, grn.id, { vendorInvoiceNo: 'M-1', date: '2026-08-10', dueDate: '2026-09-10' });
    assert.equal(bill.match.status, 'matched');
    assert.equal(await balance(f, CODE.GOODS_RECEIVED_NOT_BILLED), 0, 'cleared by the bill');
    assert.equal(await balance(f, CODE.PURCHASES), 600_00, 'the cost counted once');
    assert.equal(await onHand(f), 6, 'and the goods counted once');

    const po2 = await f.trx.selectFrom('purchase_order_lines').select(['qty_received', 'qty_billed']).where('id', '=', poLine).executeTakeFirstOrThrow();
    assert.equal(Number(po2.qty_received), 6);
    assert.equal(Number(po2.qty_billed), 6);
  });
});

test('a bill dearer than its order is held from payment until accepted', async () => {
  await withFixture(async (f) => {
    const po = await createPurchaseOrder(f.trx, f.orgId, null, {
      branchId: f.branchId, vendorId: f.vendor, date: '2026-08-01', lines: [{ itemId: f.itemId, qty: 5, ratePaise: 100_00 }],
    });
    const grn = await receiveFromPurchaseOrder(f.trx, f.orgId, null, po.id, { date: '2026-08-02' });
    const [grnLine] = await lineIds(f, 'goods_receipt_lines', 'receipt_id', grn.id);
    const bill = await billFromGoodsReceipt(f.trx, f.orgId, null, grn.id, {
      vendorInvoiceNo: 'M-9', date: '2026-08-04', dueDate: '2026-09-04', lines: [{ lineId: grnLine, qty: 5, ratePaise: 110_00 }],
    });
    assert.equal(bill.match.status, 'exception');
    assert.match(bill.match.note ?? '', /billed at ₹110\.00, ordered at ₹100\.00/);

    const pay = () => makePayment(f.trx, f.orgId, null, {
      branchId: f.branchId, contactId: f.vendor, date: '2026-08-20', mode: 'neft', amountPaise: 100_00, bankAccountId: f.bankId,
      allocations: [{ targetType: 'bill', targetId: bill.id, amountPaise: 100_00 }],
    });
    await assert.rejects(pay(), /does not agree with its order/);
    await acceptBillMismatch(f.trx, f.orgId, null, bill.id, 'Steel price rise agreed by phone');
    await pay();
  });
});

test('a receipt note entered by mistake is cancelled, and the order offers the goods again', async () => {
  await withFixture(async (f) => {
    const po = await createPurchaseOrder(f.trx, f.orgId, null, {
      branchId: f.branchId, vendorId: f.vendor, date: '2026-08-01', lines: [{ itemId: f.itemId, qty: 3, ratePaise: 100_00 }],
    });
    const grn = await receiveFromPurchaseOrder(f.trx, f.orgId, null, po.id, { date: '2026-08-02' });
    await cancelGoodsReceipt(f.trx, f.orgId, null, grn.id, 'Wrong vendor');
    assert.equal(await onHand(f), 0);
    assert.equal(await balance(f, CODE.GOODS_RECEIVED_NOT_BILLED), 0);
    const line = await f.trx.selectFrom('purchase_order_lines').select(['qty_received']).where('purchase_order_id', '=', po.id).executeTakeFirstOrThrow();
    assert.equal(Number(line.qty_received), 0);
  });
});

test('a quote becomes an order, and the backlog shows what is left line by line', async () => {
  await withFixture(async (f) => {
    const est = await createEstimate(f.trx, f.orgId, null, {
      branchId: f.branchId, customerId: f.customer, date: '2026-07-20', expiryDate: '2026-08-20',
      lines: [{ itemId: f.itemId, qty: 10, ratePaise: 200_00 }],
    });
    const so = await salesOrderFromEstimate(f.trx, f.orgId, null, est.id, { date: '2026-08-01', expectedShipDate: '2026-08-10' });
    const e = await f.trx.selectFrom('estimates').select(['status', 'converted_to_type']).where('id', '=', est.id).executeTakeFirstOrThrow();
    assert.deepEqual([e.status, e.converted_to_type], ['converted', 'sales_order']);
    await assert.rejects(salesOrderFromEstimate(f.trx, f.orgId, null, est.id, { date: '2026-08-01' }), /already been converted/);

    const [line] = await lineIds(f, 'sales_order_lines', 'sales_order_id', so.id);
    await challanFromSalesOrder(f.trx, f.orgId, null, so.id, { date: '2026-08-05', lines: [{ lineId: line, qty: 6 }] });
    await invoiceFromSalesOrder(f.trx, f.orgId, null, so.id, { date: '2026-08-06', dueDate: '2026-09-05', lines: [{ lineId: line, qty: 4 }] });

    const p = await pendingSalesOrders(f.trx, f.orgId, '2026-08-15');
    assert.equal(p.orders.length, 1);
    const l = p.orders[0].lines[0];
    assert.deepEqual([l.ordered, l.moved, l.settled, l.toMove, l.toSettle], [10, 6, 4, 4, 6]);
    assert.equal(l.pendingPaise, 6 * 200_00);
    assert.equal(p.orders[0].overdue, true, 'four still to ship, five days past the date');
  });
});

test('a purchase order part-received is pending to receive and to bill', async () => {
  await withFixture(async (f) => {
    const po = await createPurchaseOrder(f.trx, f.orgId, null, {
      branchId: f.branchId, vendorId: f.vendor, date: '2026-08-01', lines: [{ itemId: f.itemId, qty: 8, ratePaise: 100_00 }],
    } as never);
    const [line] = await lineIds(f, 'purchase_order_lines', 'purchase_order_id', po.id);
    await receiveFromPurchaseOrder(f.trx, f.orgId, null, po.id, { date: '2026-08-03', lines: [{ lineId: line, qty: 5 }] } as never);
    const p = await pendingPurchaseOrders(f.trx, f.orgId, '2026-08-31');
    const l = p.orders[0].lines[0];
    assert.deepEqual([l.toMove, l.toSettle], [3, 8]);
    assert.equal(p.totalPendingPaise, 8 * 100_00);
  });
});

test.after(async () => {
  await db.destroy();
});
