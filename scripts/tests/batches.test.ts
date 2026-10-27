// Batches: named on every purchase, picked first-expiry-first-out on sales,
// and flagged when sold past expiry.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/batches.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../../lib/server/db';
import { installChartOfAccounts } from '../../lib/server/ledger/chart-of-accounts';
import { createInvoice } from '../../lib/server/services/sales';
import { createBill } from '../../lib/server/services/purchases';
import { batchStock } from '../../lib/server/services/batches';
import { billFromGoodsReceipt, receiveGoods } from '../../lib/server/services/order-flow';
import { createCreditNote } from '../../lib/server/services/sales-documents';

test('received into a batch, billed from the note without counting twice, and returned into the batch it was sold from', async () => {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Pharma Two' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'Store', state_code: '33', is_primary: 1 }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      await trx.insertInto('hsn_codes').values({ org_id: orgId, code: '3004', kind: 'hsn', description: 'Medicaments', gst_rate_pct: 12, is_active: 1 }).execute();
      const itemId = Number((await trx.insertInto('items').values({
        org_id: orgId, kind: 'goods', name: 'Tablets', hsn_sac: '3004', uqc: 'BOX', sale_price: '100.0000', purchase_price: '60.0000',
        gst_rate_pct: 12, track_inventory: 1, track_batches: 1,
      }).executeTakeFirstOrThrow()).insertId);
      const vendor = Number((await trx.insertInto('contacts').values({ org_id: orgId, kind: 'vendor', display_name: 'Distributor', state_code: '33', gst_treatment: 'unregistered' } as never).executeTakeFirstOrThrow()).insertId);
      const customer = Number((await trx.insertInto('contacts').values({ org_id: orgId, kind: 'customer', display_name: 'Clinic', state_code: '33', gst_treatment: 'consumer' } as never).executeTakeFirstOrThrow()).insertId);
      const qtyOf = async (batchNo: string) => (await batchStock(trx, orgId, '2026-12-31', itemId)).find((b) => b.batchNo === batchNo)?.qty ?? 0;

      await assert.rejects(receiveGoods(trx, orgId, null, { branchId, vendorId: vendor, date: '2026-06-01', lines: [{ itemId, qty: 5 }] }), /batch number/);
      const grn = await receiveGoods(trx, orgId, null, {
        branchId, vendorId: vendor, date: '2026-06-01', lines: [{ itemId, qty: 20, ratePaise: 60_00, gstRatePct: 12, batch: { batchNo: 'TB-1', expiryDate: '2027-01-31' } }],
      });
      assert.equal(await qtyOf('TB-1'), 20, 'in stock from the day it arrived');
      await billFromGoodsReceipt(trx, orgId, null, grn.id, { vendorInvoiceNo: 'DST-9', date: '2026-06-05', dueDate: '2026-07-05', lines: [{ lineId: Number((await trx.selectFrom('goods_receipt_lines').select('id').where('receipt_id', '=', grn.id).executeTakeFirstOrThrow()).id), qty: 12 }] });
      assert.equal(await qtyOf('TB-1'), 20, 'twelve on the bill, eight still on the note: not counted twice');
      const billLine = await trx.selectFrom('bill_lines').innerJoin('batches', 'batches.id', 'bill_lines.batch_id').select('batches.batch_no').where('bill_lines.org_id', '=', orgId).executeTakeFirstOrThrow();
      assert.equal(billLine.batch_no, 'TB-1', 'the bill carries the batch on');

      const inv = await createInvoice(trx, orgId, null, {
        branchId, customerId: customer, date: '2026-06-10', dueDate: '2026-06-10', status: 'approved',
        lines: [{ itemId, description: 'Tablets', hsnSac: '3004', qty: 4, ratePaise: 100_00, gstRatePct: 12 }],
      });
      assert.equal(await qtyOf('TB-1'), 16);
      await createCreditNote(trx, orgId, null, {
        branchId, customerId: customer, date: '2026-06-12', reason: 'Damaged in transit', againstInvoiceId: inv.id,
        lines: [{ itemId, description: 'Tablets', hsnSac: '3004', qty: 1, ratePaise: 100_00, gstRatePct: 12 }],
      });
      assert.equal(await qtyOf('TB-1'), 17, 'back into the batch it was sold from');
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
});

test('bought by batch, sold first-expiry-first-out', async () => {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Pharma' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'Store', state_code: '33', is_primary: 1 }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      await trx.insertInto('hsn_codes').values({ org_id: orgId, code: '3004', kind: 'hsn', description: 'Medicaments', gst_rate_pct: 12, is_active: 1 }).execute();
      const itemId = Number((await trx.insertInto('items').values({
        org_id: orgId, kind: 'goods', name: 'Syrup', hsn_sac: '3004', uqc: 'BTL', sale_price: '100.0000', purchase_price: '60.0000',
        gst_rate_pct: 12, track_inventory: 1, track_batches: 1,
      }).executeTakeFirstOrThrow()).insertId);
      const vendor = Number((await trx.insertInto('contacts').values({ org_id: orgId, kind: 'vendor', display_name: 'Distributor', state_code: '33', gst_treatment: 'unregistered' } as never).executeTakeFirstOrThrow()).insertId);
      const customer = Number((await trx.insertInto('contacts').values({ org_id: orgId, kind: 'customer', display_name: 'Clinic', state_code: '33', gst_treatment: 'consumer' } as never).executeTakeFirstOrThrow()).insertId);

      const buy = (no: string, batchNo: string, expiryDate: string) => createBill(trx, orgId, null, {
        branchId, vendorId: vendor, vendorInvoiceNo: no, date: '2026-06-01', dueDate: '2026-06-01', status: 'open',
        lines: [{ itemId, qty: 10, ratePaise: 60_00, gstRatePct: 12, batch: { batchNo, mfgDate: '2026-01-01', expiryDate } }],
      } as never);
      await buy('D-1', 'SY-AUG', '2026-08-31');
      await buy('D-2', 'SY-DEC', '2026-12-31');
      await assert.rejects(createBill(trx, orgId, null, {
        branchId, vendorId: vendor, vendorInvoiceNo: 'D-3', date: '2026-06-01', dueDate: '2026-06-01', status: 'open',
        lines: [{ itemId, qty: 1, ratePaise: 60_00, gstRatePct: 12 }],
      } as never), /batch number/);

      const sell = (date: string, qty: number, batchId?: number) => createInvoice(trx, orgId, null, {
        branchId, customerId: customer, date, dueDate: date, status: 'approved',
        lines: [{ itemId, description: 'Syrup', hsnSac: '3004', qty, ratePaise: 100_00, gstRatePct: 12, batchId }],
      });
      const qtyOf = async (batchNo: string) => (await batchStock(trx, orgId, '2026-12-31', itemId)).find((b) => b.batchNo === batchNo)!.qty;

      await sell('2026-06-10', 6);
      assert.deepEqual([await qtyOf('SY-AUG'), await qtyOf('SY-DEC')], [4, 10], 'the August batch went first');
      await sell('2026-06-11', 6);
      assert.deepEqual([await qtyOf('SY-AUG'), await qtyOf('SY-DEC')], [4, 4], 'too few left in August, so December');

      const aug = (await batchStock(trx, orgId, '2026-12-31', itemId)).find((b) => b.batchNo === 'SY-AUG')!;
      const late = await sell('2026-09-15', 2, Number(aug.batchId));
      assert.ok(late.warnings?.some((w) => /expired on 2026-08-31/.test(w)), 'selling an expired batch is flagged');
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
});

test.after(async () => {
  await db.destroy();
});
