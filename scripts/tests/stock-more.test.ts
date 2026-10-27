// Valuation item by item, and stock by godown with goods in transit.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/stock-more.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts } from '../../lib/server/ledger/chart-of-accounts';
import { createInvoice } from '../../lib/server/services/sales';
import { createBill } from '../../lib/server/services/purchases';
import { createTransfer, receiveTransfer } from '../../lib/server/services/stock-transfers';
import { checkGodown } from '../../lib/server/services/godowns';
import { stockByGodown, stockPosition } from '../../lib/server/reports/stock';

async function rolledBack(fn: (trx: Trx) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => { await fn(trx); throw rollback; });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

async function book(trx: Trx) {
  const orgId = Number((await trx.insertInto('organizations').values({ name: 'Godown Co' }).executeTakeFirstOrThrow()).insertId);
  const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'Main', state_code: '33', is_primary: 1 }).executeTakeFirstOrThrow()).insertId);
  await installChartOfAccounts(trx, orgId);
  const vendor = Number((await trx.insertInto('contacts').values({ org_id: orgId, kind: 'vendor', display_name: 'Supplier', state_code: '33', gst_treatment: 'unregistered' } as never).executeTakeFirstOrThrow()).insertId);
  const customer = Number((await trx.insertInto('contacts').values({ org_id: orgId, kind: 'customer', display_name: 'Buyer', state_code: '33', gst_treatment: 'unregistered' } as never).executeTakeFirstOrThrow()).insertId);
  const item = async (name: string, method: 'fifo' | null) => Number((await trx.insertInto('items').values({
    org_id: orgId, kind: 'goods', name, uqc: 'NOS', track_inventory: 1, valuation_method: method,
  }).executeTakeFirstOrThrow()).insertId);
  return { orgId, branchId, vendor, customer, item };
}

test('an item valued first in, first out sits beside the book average', async () => {
  await rolledBack(async (trx) => {
    const { orgId, branchId, vendor, customer, item } = await book(trx);
    const avg = await item('Filter', null);
    const fifo = await item('Bearing', 'fifo');
    const buy = (no: string, rate: number) => createBill(trx, orgId, null, {
      branchId, vendorId: vendor, vendorInvoiceNo: no, date: '2026-06-01', dueDate: '2026-06-30', status: 'open',
      lines: [{ itemId: avg, qty: 10, ratePaise: rate, gstRatePct: 0 }, { itemId: fifo, qty: 10, ratePaise: rate, gstRatePct: 0 }],
    } as never);
    await buy('S-1', 100_00);
    await buy('S-2', 200_00);
    await createInvoice(trx, orgId, null, {
      branchId, customerId: customer, date: '2026-06-10', dueDate: '2026-06-10', status: 'approved',
      lines: [{ itemId: avg, qty: 10, ratePaise: 300_00, gstRatePct: 0 }, { itemId: fifo, qty: 10, ratePaise: 300_00, gstRatePct: 0 }],
    });
    const pos = await stockPosition(trx, orgId, '2026-06-30');
    const line = (id: number) => pos.lines.find((l) => l.itemId === String(id))!;
    assert.deepEqual([line(avg).valuation, line(avg).valuePaise], ['average', 1_500_00], 'ten at the average of 100 and 200');
    assert.deepEqual([line(fifo).valuation, line(fifo).valuePaise], ['fifo', 2_000_00], 'ten left from the last purchase, at 200');
  });
});

test('stock by godown: each document at its godown, goods on the road in transit, the total the same', async () => {
  await rolledBack(async (trx) => {
    const { orgId, branchId, vendor, customer, item } = await book(trx);
    const tyre = await item('Tyre', null);
    const wh = async (name: string, primary: number) => Number((await trx.insertInto('warehouses').values({ org_id: orgId, branch_id: branchId, name, is_primary: primary } as never).executeTakeFirstOrThrow()).insertId);
    const shop = await wh('Shop', 1);
    const yard = await wh('Yard', 0);

    await createBill(trx, orgId, null, {
      branchId, warehouseId: yard, vendorId: vendor, vendorInvoiceNo: 'T-1', date: '2026-06-01', dueDate: '2026-06-30', status: 'open',
      lines: [{ itemId: tyre, qty: 10, ratePaise: 1_000_00, gstRatePct: 0 }],
    } as never);
    await createInvoice(trx, orgId, null, {
      branchId, customerId: customer, date: '2026-06-02', dueDate: '2026-06-02', status: 'approved',
      lines: [{ itemId: tyre, qty: 3, ratePaise: 1_500_00, gstRatePct: 0 }],
    });
    const moved = await createTransfer(trx, orgId, null, { fromWarehouseId: yard, toWarehouseId: shop, date: '2026-06-03', lines: [{ itemId: tyre, qty: 4 }] });

    let g = await stockByGodown(trx, orgId, '2026-06-05');
    let row = g.rows.find((r) => r.itemId === String(tyre))!;
    assert.deepEqual([row.byGodown[String(shop)], row.byGodown[String(yard)], row.inTransit, row.total], [-3, 6, 4, 7],
      'sold from the shop, which named no godown; four on the road from the yard');
    const pos = await stockPosition(trx, orgId, '2026-06-05');
    assert.equal(pos.lines.find((l) => l.itemId === String(tyre))!.qty, row.total, 'the same stock, counted two ways');

    await receiveTransfer(trx, orgId, moved.id, '2026-06-06');
    g = await stockByGodown(trx, orgId, '2026-06-07');
    row = g.rows.find((r) => r.itemId === String(tyre))!;
    assert.deepEqual([row.byGodown[String(shop)], row.byGodown[String(yard)], row.inTransit], [1, 6, 0]);

    const other = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'Bengaluru', state_code: '29' }).executeTakeFirstOrThrow()).insertId);
    const far = Number((await trx.insertInto('warehouses').values({ org_id: orgId, branch_id: other, name: 'Far', is_primary: 0 } as never).executeTakeFirstOrThrow()).insertId);
    await assert.rejects(checkGodown(trx, orgId, branchId, far), /belongs to another branch/);
  });
});

test.after(async () => {
  await db.destroy();
});
