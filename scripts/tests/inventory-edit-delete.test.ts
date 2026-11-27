// Edit and Delete on the stock screens (services/stock-changes.ts): adjustments,
// transfers, production runs, bills of materials, batches and warehouses,
// against real MySQL inside rolled-back transactions.
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/inventory-edit-delete.test.ts
//
// What has to hold: stock is worked out from the documents, so an edit or a
// delete moves it exactly as if the document had been entered that way (or
// never); nothing already sold, used or moved since is taken out from under the
// documents that moved it (the negative-stock rule decides: refused when it
// blocks, a warning when it warns); a piece named on an adjustment that has
// moved since keeps the adjustment; every deleted document leaves a
// deleted_documents row; a master in use is refused with `in_use`.

import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { postEntry } from '../../lib/server/ledger/posting';
import { stockPosition } from '../../lib/server/reports/stock';
import { setPolicies } from '../../lib/server/services/org-settings';
import { createTransfer, receiveTransfer, cancelTransfer } from '../../lib/server/services/stock-transfers';
import { recordProduction, saveBom, voidProduction } from '../../lib/server/services/manufacturing';
import { batchStock } from '../../lib/server/services/batches';
import { ApiError } from '../../lib/server/http';
import {
  adjustmentForEdit, createAdjustment, deleteAdjustment, deleteBatch, deleteBom, deleteProduction, deleteTransfer,
  deleteWarehouse, productionForEdit, setBomActive, transferForEdit, updateAdjustment, updateBatch, updateProduction,
  updateTransfer, updateWarehouse, type AdjustmentInput,
} from '../../lib/server/services/stock-changes';

interface Fixture {
  trx: Trx; orgId: number; branchId: number; branch2Id: number; acc: Record<string, number>;
  w1: number; w2: number; w3: number; itemId: number; partId: number; serialItemId: number; batchItemId: number;
}

const goods = (trx: Trx, orgId: number, name: string, extra: Record<string, unknown> = {}) => trx.insertInto('items').values({
  org_id: orgId, kind: 'goods', name, sku: name.slice(0, 8), hsn_sac: '8708', uqc: 'NOS',
  sale_price: '200.0000', purchase_price: '100.0000', gst_rate_pct: 18, track_inventory: 1, ...extra,
}).executeTakeFirstOrThrow().then((r) => Number(r.insertId));

async function withFixture(fn: (f: Fixture) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Stock Edit Delete Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1, gstin: '33AAACR4849R1ZK' }).executeTakeFirstOrThrow()).insertId);
      // A second branch under the same registration: transfers between them move branch stock.
      const branch2Id = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'Depot', state_code: '33', is_primary: 0 }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const acc = await accountIds(trx, orgId);
      const wh = (name: string, branch: number | null, primary = 0) => trx.insertInto('warehouses')
        .values({ org_id: orgId, name, branch_id: branch, is_primary: primary, is_active: 1 }).executeTakeFirstOrThrow().then((r) => Number(r.insertId));
      const w1 = await wh('Main store', branchId, 1);
      const w2 = await wh('Depot store', branch2Id);
      const w3 = await wh('Spare shed', branchId);
      const itemId = await goods(trx, orgId, 'Disc');
      const partId = await goods(trx, orgId, 'Pad');
      const serialItemId = await goods(trx, orgId, 'Pump', { track_serials: 1 });
      const batchItemId = await goods(trx, orgId, 'Oil', { track_batches: 1 });
      await fn({ trx, orgId, branchId, branch2Id, acc, w1, w2, w3, itemId, partId, serialItemId, batchItemId });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

test.after(() => db.destroy());

/** On hand for an item: the whole business, or one branch, on a date. */
const qty = async (f: Fixture, itemId: number, branchId?: number, date = '2026-12-31') =>
  (await stockPosition(f.trx, f.orgId, date, { branchId, includeArchived: true })).lines.find((l) => l.itemId === String(itemId))?.qty ?? 0;
const adjust = (f: Fixture, input: Partial<AdjustmentInput> & { qtyDelta: number }) =>
  createAdjustment(f.trx, f.orgId, null, { itemId: f.itemId, warehouseId: f.w1, date: '2026-10-01', reason: 'stocktake', ...input });
const block = (f: Fixture) => setPolicies(f.trx, f.orgId, null, { negativeStock: 'block' });
const deletedRows = async (f: Fixture, docType: string, docId: number) =>
  (await sql<{ n: number }>`SELECT COUNT(*) AS n FROM deleted_documents WHERE org_id = ${f.orgId} AND doc_type = ${docType} AND doc_id = ${docId}`.execute(f.trx)).rows[0].n;
const code = (e: unknown) => (e instanceof ApiError ? e.code : String(e));

// ── Adjustments ─────────────────────────────────────────────────────────────

test('an adjustment edited in place moves stock as if entered that way; deleted, it leaves nothing but its record', async () => {
  await withFixture(async (f) => {
    const a = await adjust(f, { qtyDelta: 10, notes: 'count' });
    assert.equal(await qty(f, f.itemId), 10);
    const done = await updateAdjustment(f.trx, f.orgId, null, a.id, { itemId: f.itemId, warehouseId: f.w1, date: '2026-10-02', qtyDelta: 6, reason: 'stocktake', notes: 'recount' });
    assert.equal(done.id, a.id);
    assert.equal(await qty(f, f.itemId), 6);
    const now = await adjustmentForEdit(f.trx, f.orgId, a.id);
    assert.equal(now.qtyDelta, 6);
    assert.equal(now.date, '2026-10-02');
    assert.equal(now.notes, 'recount');
    // The item itself can change: the stock moves from one to the other.
    await updateAdjustment(f.trx, f.orgId, null, a.id, { itemId: f.partId, warehouseId: f.w1, date: '2026-10-02', qtyDelta: 6, reason: 'stocktake' });
    assert.equal(await qty(f, f.itemId), 0);
    assert.equal(await qty(f, f.partId), 6);

    await deleteAdjustment(f.trx, f.orgId, null, a.id, 'typed twice');
    assert.equal(await qty(f, f.partId), 0);
    assert.equal(Number(await deletedRows(f, 'stock_adjustment', a.id)), 1);
    const kept = await f.trx.selectFrom('deleted_documents').select(['reason']).where('org_id', '=', f.orgId).where('doc_id', '=', a.id).executeTakeFirstOrThrow();
    assert.equal(kept.reason, 'typed twice');
    assert.equal(await f.trx.selectFrom('stock_adjustments').select('id').where('id', '=', a.id).executeTakeFirst(), undefined);
  });
});

test('taking back stock that has been used since is refused when the book blocks negative stock, and warned when it warns', async () => {
  await withFixture(async (f) => {
    const found = await adjust(f, { qtyDelta: 10 });
    await adjust(f, { qtyDelta: -8, date: '2026-10-10', reason: 'damage' });
    assert.equal(await qty(f, f.itemId), 2);

    // The default rule warns: the delete goes through, with the warning.
    const warned = await deleteAdjustment(f.trx, f.orgId, null, found.id);
    assert.match(warned.warnings.join(' '), /too little stock: Disc would be at -8/);
    assert.equal(await qty(f, f.itemId), -8);

    const again = await adjust(f, { qtyDelta: 10 });
    await block(f);
    await assert.rejects(deleteAdjustment(f.trx, f.orgId, null, again.id), /too little stock: Disc would be at -8/);
    await assert.rejects(
      updateAdjustment(f.trx, f.orgId, null, again.id, { itemId: f.itemId, warehouseId: f.w1, date: '2026-10-01', qtyDelta: 5, reason: 'stocktake' }),
      /Disc would be at -3/,
    );
    // Upward is always fine, and a write-off can be taken back.
    await updateAdjustment(f.trx, f.orgId, null, again.id, { itemId: f.itemId, warehouseId: f.w1, date: '2026-10-01', qtyDelta: 12, reason: 'stocktake' });
    assert.equal(await qty(f, f.itemId), -4 + 8);
  });
});

test('an adjustment whose numbered pieces have moved since cannot be edited or deleted', async () => {
  await withFixture(async (f) => {
    const found = await adjust(f, { itemId: f.serialItemId, qtyDelta: 2, serials: ['P-1', 'P-2'] });
    const edit = await adjustmentForEdit(f.trx, f.orgId, found.id);
    assert.deepEqual(edit.serials, ['P-1', 'P-2']);
    const off = await adjust(f, { itemId: f.serialItemId, qtyDelta: -1, serials: ['P-1'], date: '2026-10-05', reason: 'damage' });
    await assert.rejects(deleteAdjustment(f.trx, f.orgId, null, found.id), (e) => code(e) === 'locked_document' && /P-1/.test((e as Error).message));
    await assert.rejects(
      updateAdjustment(f.trx, f.orgId, null, found.id, { itemId: f.serialItemId, warehouseId: f.w1, date: '2026-10-01', qtyDelta: 2, reason: 'stocktake', serials: ['P-1', 'P-2'] }),
      (e) => code(e) === 'locked_document',
    );
    // The later one goes first; then the first is free.
    await deleteAdjustment(f.trx, f.orgId, null, off.id);
    await updateAdjustment(f.trx, f.orgId, null, found.id, { itemId: f.serialItemId, warehouseId: f.w1, date: '2026-10-01', qtyDelta: 1, reason: 'stocktake', serials: ['P-9'] });
    assert.deepEqual((await adjustmentForEdit(f.trx, f.orgId, found.id)).serials, ['P-9']);
    await deleteAdjustment(f.trx, f.orgId, null, found.id);
    assert.equal(await qty(f, f.serialItemId), 0);
  });
});

test('an old adjustment that posted an entry has it reversed, never erased, when deleted', async () => {
  await withFixture(async (f) => {
    const a = await adjust(f, { qtyDelta: -2, reason: 'damage' });
    const entry = await postEntry(f.trx, {
      orgId: f.orgId, branchId: f.branchId, date: '2026-10-01', memo: 'Legacy write-off', sourceType: 'stock_adjustment', sourceId: a.id, module: 'accountant',
      lines: [{ accountId: f.acc[CODE.PURCHASES], debit: 200_00 }, { accountId: f.acc[CODE.INVENTORY], credit: 200_00 }],
    });
    await f.trx.updateTable('stock_adjustments').set({ journal_entry_id: entry.id }).where('id', '=', a.id).execute();
    await deleteAdjustment(f.trx, f.orgId, null, a.id);
    const kept = await f.trx.selectFrom('deleted_documents').select(['journal_entry_id', 'reversal_entry_id']).where('org_id', '=', f.orgId).where('doc_id', '=', a.id).executeTakeFirstOrThrow();
    assert.equal(kept.journal_entry_id, entry.id);
    assert.ok(kept.reversal_entry_id);
    const rev = await f.trx.selectFrom('journal_entries').select('reversal_of_entry_id').where('id', '=', kept.reversal_entry_id!).executeTakeFirstOrThrow();
    assert.equal(rev.reversal_of_entry_id, entry.id);
    const { rows } = await sql<{ b: string }>`SELECT COALESCE(SUM(debit - credit), 0) AS b FROM journal_lines WHERE org_id = ${f.orgId} AND account_id = ${f.acc[CODE.INVENTORY]}`.execute(f.trx);
    assert.equal(Number(rows[0].b), 0);
  });
});

// ── Transfers ───────────────────────────────────────────────────────────────

test('a transfer edited keeps its number and moves the stock between branches as entered; deleted, the goods are back', async () => {
  await withFixture(async (f) => {
    await adjust(f, { qtyDelta: 10 });
    const t = await createTransfer(f.trx, f.orgId, null, { fromWarehouseId: f.w1, toWarehouseId: f.w2, date: '2026-10-02', lines: [{ itemId: f.itemId, qty: 4 }] });
    await receiveTransfer(f.trx, f.orgId, t.id, '2026-10-03');
    assert.equal(await qty(f, f.itemId, f.branchId), 6);
    assert.equal(await qty(f, f.itemId, f.branch2Id), 4);

    const done = await updateTransfer(f.trx, f.orgId, t.id, {
      fromWarehouseId: f.w1, toWarehouseId: f.w2, date: '2026-10-02', receivedDate: '2026-10-04', lines: [{ itemId: f.itemId, qty: 3 }], vehicleNo: 'TN01AB1234',
    });
    assert.equal(done.number, t.number);
    const after = await transferForEdit(f.trx, f.orgId, t.id);
    assert.equal(after.status, 'received');
    assert.equal(after.receivedDate, '2026-10-04');
    assert.equal(after.vehicleNo, 'TN01AB1234');
    assert.equal(await qty(f, f.itemId, f.branchId), 7);
    assert.equal(await qty(f, f.itemId, f.branch2Id), 3);
    await assert.rejects(updateTransfer(f.trx, f.orgId, t.id, {
      fromWarehouseId: f.w1, toWarehouseId: f.w2, date: '2026-10-05', receivedDate: '2026-10-04', lines: [{ itemId: f.itemId, qty: 3 }],
    }), /cannot arrive before/);

    await deleteTransfer(f.trx, f.orgId, null, t.id, 'wrong godown');
    assert.equal(await qty(f, f.itemId, f.branchId), 10);
    assert.equal(await qty(f, f.itemId, f.branch2Id), 0);
    assert.equal(Number(await deletedRows(f, 'stock_transfer', t.id)), 1);
  });
});

test('a received transfer whose goods have gone on from the other godown cannot be taken back while the book blocks', async () => {
  await withFixture(async (f) => {
    await adjust(f, { qtyDelta: 10 });
    const t = await createTransfer(f.trx, f.orgId, null, { fromWarehouseId: f.w1, toWarehouseId: f.w2, date: '2026-10-02', lines: [{ itemId: f.itemId, qty: 4 }] });
    await receiveTransfer(f.trx, f.orgId, t.id, '2026-10-03');
    await adjust(f, { qtyDelta: -4, warehouseId: f.w2, date: '2026-10-06', reason: 'issued' });
    await block(f);
    await assert.rejects(deleteTransfer(f.trx, f.orgId, null, t.id), /Disc would be at -4/);
    await assert.rejects(updateTransfer(f.trx, f.orgId, t.id, {
      fromWarehouseId: f.w1, toWarehouseId: f.w2, date: '2026-10-02', lines: [{ itemId: f.itemId, qty: 2 }],
    }), /Disc would be at -2/);
    // Sending more than is there is refused the same way.
    await assert.rejects(updateTransfer(f.trx, f.orgId, t.id, {
      fromWarehouseId: f.w1, toWarehouseId: f.w2, date: '2026-10-02', lines: [{ itemId: f.itemId, qty: 14 }],
    }), /Disc would be at -4/);

    const c = await createTransfer(f.trx, f.orgId, null, { fromWarehouseId: f.w1, toWarehouseId: f.w3, date: '2026-10-07', lines: [{ itemId: f.itemId, qty: 1 }] });
    await cancelTransfer(f.trx, f.orgId, c.id);
    await assert.rejects(updateTransfer(f.trx, f.orgId, c.id, {
      fromWarehouseId: f.w1, toWarehouseId: f.w3, date: '2026-10-07', lines: [{ itemId: f.itemId, qty: 1 }],
    }), (e) => code(e) === 'locked_document');
    await deleteTransfer(f.trx, f.orgId, null, c.id);
    assert.equal(Number(await deletedRows(f, 'stock_transfer', c.id)), 1);
  });
});

// ── Production and bills of materials ───────────────────────────────────────

test('a production run edited is costed again under its own number; deleted, its components are back and its goods gone', async () => {
  await withFixture(async (f) => {
    await adjust(f, { itemId: f.partId, qtyDelta: 10 });
    const bomId = await saveBom(f.trx, f.orgId, { itemId: f.itemId, name: 'Standard', outputQty: 1, lines: [{ itemId: f.partId, qty: 2 }] });
    const run = await recordProduction(f.trx, f.orgId, null, { bomId, qty: 3, date: '2026-10-05', branchId: f.branchId, overheadPaise: 30_00 });
    assert.equal(await qty(f, f.partId), 4);
    assert.equal(await qty(f, f.itemId), 3);

    const done = await updateProduction(f.trx, f.orgId, null, run.id, { bomId, qty: 2, date: '2026-10-06', branchId: f.branchId, overheadPaise: 10_00, notes: 'two only' });
    assert.equal(done.id, run.id);
    assert.equal(done.number, run.number);
    assert.equal(await qty(f, f.partId), 6);
    assert.equal(await qty(f, f.itemId), 2);
    const edit = await productionForEdit(f.trx, f.orgId, run.id);
    assert.equal(edit.qty, 2);
    assert.equal(edit.date, '2026-10-06');
    assert.equal(edit.overheadPaise, 10_00);
    assert.deepEqual(edit.lines.map((l) => l.qty), [4]);
    // The components at their cost on the new day, plus the new overhead.
    assert.equal(done.costPaise, edit.lines[0].costPaise + 10_00);

    // Marked not in use since, the run keeps its bill of materials.
    await setBomActive(f.trx, f.orgId, bomId, false);
    await updateProduction(f.trx, f.orgId, null, run.id, { bomId, qty: 1, date: '2026-10-06', branchId: f.branchId });
    assert.equal(await qty(f, f.itemId), 1);

    await assert.rejects(deleteBom(f.trx, f.orgId, bomId), (e) => code(e) === 'in_use');
    await deleteProduction(f.trx, f.orgId, null, run.id, 'test run');
    assert.equal(await qty(f, f.partId), 10);
    assert.equal(await qty(f, f.itemId), 0);
    assert.equal(Number(await deletedRows(f, 'production', run.id)), 1);
    // Nothing made from it any more: it can go.
    await deleteBom(f.trx, f.orgId, bomId);
    assert.equal(await f.trx.selectFrom('boms').select('id').where('id', '=', bomId).executeTakeFirst(), undefined);
  });
});

test('a run whose goods have been used since, or a void one, cannot be edited away', async () => {
  await withFixture(async (f) => {
    await adjust(f, { itemId: f.partId, qtyDelta: 10 });
    const bomId = await saveBom(f.trx, f.orgId, { itemId: f.itemId, name: 'Standard', outputQty: 1, lines: [{ itemId: f.partId, qty: 2 }] });
    const run = await recordProduction(f.trx, f.orgId, null, { bomId, qty: 3, date: '2026-10-05', branchId: f.branchId });
    await adjust(f, { qtyDelta: -3, date: '2026-10-08', reason: 'issued' });
    await block(f);
    await assert.rejects(deleteProduction(f.trx, f.orgId, null, run.id), /Disc would be at -3/);
    await assert.rejects(updateProduction(f.trx, f.orgId, null, run.id, { bomId, qty: 1, date: '2026-10-05', branchId: f.branchId }), /Disc would be at -2/);
    // Making more needs the components: refused by the same rule as recording it.
    await assert.rejects(updateProduction(f.trx, f.orgId, null, run.id, { bomId, qty: 6, date: '2026-10-05', branchId: f.branchId }), /Not enough stock/);

    const other = await recordProduction(f.trx, f.orgId, null, { bomId, qty: 1, date: '2026-10-09', branchId: f.branchId });
    await voidProduction(f.trx, f.orgId, other.id);
    await assert.rejects(updateProduction(f.trx, f.orgId, null, other.id, { bomId, qty: 1, date: '2026-10-09', branchId: f.branchId }), (e) => code(e) === 'locked_document');
    // A void run moved nothing: it goes without a stock check.
    await deleteProduction(f.trx, f.orgId, null, other.id);
    assert.equal(Number(await deletedRows(f, 'production', other.id)), 1);
  });
});

// ── Batches ─────────────────────────────────────────────────────────────────

test('a batch is corrected in place; it is deleted only once no document names it', async () => {
  await withFixture(async (f) => {
    await adjust(f, { itemId: f.batchItemId, qtyDelta: 5, batch: { batchNo: 'B-1', expiryDate: '2027-01-31' } });
    const b = await f.trx.selectFrom('batches').select('id').where('org_id', '=', f.orgId).where('batch_no', '=', 'B-1').executeTakeFirstOrThrow();
    await updateBatch(f.trx, f.orgId, b.id, { batchNo: 'B-1A', mfgDate: '2026-09-01', expiryDate: '2027-03-31' });
    const stock = (await batchStock(f.trx, f.orgId, '2026-12-31', f.batchItemId)).find((x) => x.batchId === String(b.id))!;
    assert.equal(stock.batchNo, 'B-1A');
    assert.equal(stock.expiryDate, '2027-03-31');
    assert.equal(stock.qty, 5);
    await assert.rejects(updateBatch(f.trx, f.orgId, b.id, { batchNo: 'B-1A', mfgDate: '2027-04-01', expiryDate: '2027-03-31' }), /expires before it was made/);

    const orphan = Number((await f.trx.insertInto('batches').values({ org_id: f.orgId, item_id: f.batchItemId, batch_no: 'B-2' }).executeTakeFirstOrThrow()).insertId);
    await assert.rejects(updateBatch(f.trx, f.orgId, orphan, { batchNo: 'B-1A' }), /already has a batch B-1A/);
    await assert.rejects(deleteBatch(f.trx, f.orgId, b.id), (e) => code(e) === 'in_use' && /1 adjustment/.test((e as Error).message));
    await deleteBatch(f.trx, f.orgId, orphan);
    assert.equal(await f.trx.selectFrom('batches').select('id').where('id', '=', orphan).executeTakeFirst(), undefined);
  });
});

// ── Warehouses ──────────────────────────────────────────────────────────────

test('a warehouse in use is refused with in_use and can be marked inactive; an unused one is deleted', async () => {
  await withFixture(async (f) => {
    await adjust(f, { qtyDelta: 1, warehouseId: f.w2 });
    await assert.rejects(deleteWarehouse(f.trx, f.orgId, f.w2), (e) => code(e) === 'in_use' && /1 adjustment/.test((e as Error).message));
    await updateWarehouse(f.trx, f.orgId, f.w2, { name: 'Depot store', branchId: f.branch2Id, isActive: false });
    const w2 = await f.trx.selectFrom('warehouses').select(['is_active']).where('id', '=', f.w2).executeTakeFirstOrThrow();
    assert.equal(w2.is_active, 0);
    // Named on a document, its branch stays: that is the registration the stock was recorded under.
    await assert.rejects(updateWarehouse(f.trx, f.orgId, f.w2, { name: 'Depot store', branchId: f.branchId }), /its branch stays/);
    await assert.rejects(updateWarehouse(f.trx, f.orgId, f.w3, { name: 'Main store', branchId: f.branchId }), /already a warehouse called Main store/);

    // The default stays in use, and is not deleted while another could be.
    await assert.rejects(updateWarehouse(f.trx, f.orgId, f.w1, { name: 'Main store', branchId: f.branchId, isActive: false }), /default/);
    await assert.rejects(deleteWarehouse(f.trx, f.orgId, f.w1), /default/);
    await updateWarehouse(f.trx, f.orgId, f.w3, { name: 'Spare shed', code: 'SH', address: 'Back lane', branchId: f.branchId, isPrimary: true });
    const rows = await f.trx.selectFrom('warehouses').select(['id', 'is_primary', 'code']).where('org_id', '=', f.orgId).orderBy('id').execute();
    assert.deepEqual(rows.map((r) => r.is_primary), [0, 0, 1]);
    assert.equal(rows[2].code, 'SH');

    await deleteWarehouse(f.trx, f.orgId, f.w1);
    assert.equal(await f.trx.selectFrom('warehouses').select('id').where('id', '=', f.w1).executeTakeFirst(), undefined);
  });
});
