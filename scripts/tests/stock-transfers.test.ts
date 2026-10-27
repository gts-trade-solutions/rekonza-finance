// Moving stock between godowns: out on dispatch, in on receipt, in transit
// between, and never between two GST registrations.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/stock-transfers.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../../lib/server/db';
import { installChartOfAccounts } from '../../lib/server/ledger/chart-of-accounts';
import { stockPosition } from '../../lib/server/reports/stock';
import { cancelTransfer, createTransfer, listTransfers, receiveTransfer } from '../../lib/server/services/stock-transfers';

test('out on dispatch, in on receipt, the business’s throughout', async () => {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Two Godowns' }).executeTakeFirstOrThrow()).insertId);
      const branch = async (name: string, gstin: string | null, primary: number) => Number((await trx.insertInto('branches').values({
        org_id: orgId, name, state_code: '33', gstin, is_primary: primary,
      }).executeTakeFirstOrThrow()).insertId);
      const chennai = await branch('Chennai', '33AAACT1111T1Z1', 1);
      // A depot under the same registration carries no GSTIN of its own.
      const hosur = await branch('Hosur', null, 0);
      const other = await branch('Other GSTIN', '33AAACT2222T1Z2', 0);
      await installChartOfAccounts(trx, orgId);
      const godown = async (name: string, branchId: number) =>
        Number((await trx.insertInto('warehouses').values({ org_id: orgId, name, branch_id: branchId }).executeTakeFirstOrThrow()).insertId);
      const w1 = await godown('Chennai main', chennai);
      const w2 = await godown('Hosur store', hosur);
      const w3 = await godown('Elsewhere', other);
      const itemId = Number((await trx.insertInto('items').values({
        org_id: orgId, kind: 'goods', name: 'Clutch plate', uqc: 'NOS', sale_price: '500.0000', purchase_price: '300.0000',
        gst_rate_pct: 18, track_inventory: 1, opening_stock_qty: '10', opening_stock_rate: '300.0000',
      }).executeTakeFirstOrThrow()).insertId);
      const qty = async (date: string, branchId?: number) => (await stockPosition(trx, orgId, date, { branchId })).lines[0].qty;

      const t = await createTransfer(trx, orgId, null, { fromWarehouseId: w1, toWarehouseId: w2, date: '2026-06-01', lines: [{ itemId, qty: 4 }] });
      assert.match(t.number, /^ST\//);
      assert.deepEqual([await qty('2026-06-02', chennai), await qty('2026-06-02', hosur), await qty('2026-06-02')], [6, 0, 10], 'four in transit');
      assert.equal((await stockPosition(trx, orgId, '2026-06-02')).totalValuePaise, 3_000_00, 'value unchanged by moving it');

      await assert.rejects(receiveTransfer(trx, orgId, t.id, '2026-05-30'), /before they were sent/);
      await receiveTransfer(trx, orgId, t.id, '2026-06-05');
      assert.deepEqual([await qty('2026-06-05', chennai), await qty('2026-06-05', hosur)], [6, 4]);
      await assert.rejects(cancelTransfer(trx, orgId, t.id), /record a transfer back/);

      await assert.rejects(createTransfer(trx, orgId, null, { fromWarehouseId: w1, toWarehouseId: w3, date: '2026-06-06', lines: [{ itemId, qty: 1 }] }), /tax invoice/);
      const back = await createTransfer(trx, orgId, null, { fromWarehouseId: w2, toWarehouseId: w1, date: '2026-06-07', lines: [{ itemId, qty: 1 }] });
      await cancelTransfer(trx, orgId, back.id);
      assert.equal(await qty('2026-06-08', hosur), 4, 'a cancelled transfer moves nothing');
      const list = await listTransfers(trx, orgId);
      assert.deepEqual(list.map((x) => x.status), ['cancelled', 'received']);
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
});

test.after(async () => {
  await db.destroy();
});
