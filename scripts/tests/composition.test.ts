// The composition scheme: bills of supply with no tax, no input credit, tax on
// turnover by CMP-08, and GSTR-4.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/composition.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { createInvoice } from '../../lib/server/services/sales';
import { createBill } from '../../lib/server/services/purchases';
import { bookCmp08, cmp08, compositionTax, gstr4 } from '../../lib/server/gst/composition';
import { toPaiseFromSql } from '../../lib/server/money-sql';

interface Fixture {
  trx: Trx; orgId: number; branchId: number; acc: Record<string, number>;
  local: number; outOfState: number; vendor: number; unregistered: number; taxable: number; exempt: number;
}

async function withFixture(fn: (f: Fixture) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({
        name: 'Corner Store', gst_registration_type: 'composition', composition_category: 'trader',
      }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({
        org_id: orgId, name: 'Shop', state_code: '33', gstin: '33AAACC1111C1Z1', is_primary: 1,
      }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const acc = await accountIds(trx, orgId);
      await trx.insertInto('hsn_codes').values([
        { org_id: orgId, code: '8708', kind: 'hsn', description: 'Parts', gst_rate_pct: 18, is_active: 1 },
        { org_id: orgId, code: '0401', kind: 'hsn', description: 'Milk', gst_rate_pct: 0, is_active: 1 },
      ]).execute();
      const contact = async (v: Record<string, unknown>) =>
        Number((await trx.insertInto('contacts').values({ org_id: orgId, state_code: '33', ...v } as never).executeTakeFirstOrThrow()).insertId);
      const item = async (v: Record<string, unknown>) => Number((await trx.insertInto('items').values({
        org_id: orgId, kind: 'goods', uqc: 'NOS', sale_price: '100.0000', purchase_price: '80.0000', track_inventory: 0, ...v,
      } as never).executeTakeFirstOrThrow()).insertId);
      await fn({
        trx, orgId, branchId, acc,
        local: await contact({ kind: 'customer', display_name: 'Local Buyer', gst_treatment: 'unregistered' }),
        outOfState: await contact({ kind: 'customer', display_name: 'Bengaluru Buyer', gst_treatment: 'registered', gstin: '29AAACB2222B1Z2', state_code: '29' }),
        vendor: await contact({ kind: 'vendor', display_name: 'Wholesaler', gst_treatment: 'registered', gstin: '33AAACW3333W1Z3' }),
        unregistered: await contact({ kind: 'vendor', display_name: 'Lorry Owner', gst_treatment: 'unregistered' }),
        taxable: await item({ name: 'Brake pad', hsn_sac: '8708', gst_rate_pct: 18 }),
        exempt: await item({ name: 'Milk', hsn_sac: '0401', gst_rate_pct: 0 }),
      });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

const balance = async (f: Fixture, code: string) => toPaiseFromSql((await sql<{ b: string }>`
  SELECT COALESCE(SUM(debit - credit), 0) AS b FROM journal_lines WHERE account_id = ${f.acc[code]}
`.execute(f.trx)).rows[0].b);

test('the rate splits half and half, the odd paisa to central tax', () => {
  assert.deepEqual(compositionTax(1_00_000_00, 1), { cgst: 500_00, sgst: 500_00 });
  assert.deepEqual(compositionTax(1_001, 1), { cgst: 5, sgst: 5 });
  assert.deepEqual(compositionTax(3_00, 1), { cgst: 2, sgst: 1 });
});

test('a composition dealer sells on a bill of supply, within the state only', async () => {
  await withFixture(async (f) => {
    const inv = await createInvoice(f.trx, f.orgId, null, {
      branchId: f.branchId, customerId: f.local, date: '2026-05-10', dueDate: '2026-05-10', status: 'approved',
      lines: [
        { itemId: f.taxable, description: 'Brake pad', hsnSac: '8708', qty: 100, ratePaise: 100_00, gstRatePct: 18 },
        { itemId: f.exempt, description: 'Milk', hsnSac: '0401', qty: 40, ratePaise: 50_00, gstRatePct: 0 },
      ],
    });
    assert.equal(inv.totalPaise, 12_000_00, 'no tax on a bill of supply');
    const row = await f.trx.selectFrom('invoices').select(['supply_type', 'cgst', 'sgst']).where('id', '=', inv.id).executeTakeFirstOrThrow();
    assert.equal(row.supply_type, 'nil_or_exempt');
    assert.equal(toPaiseFromSql(row.cgst), 0);
    assert.equal(await balance(f, CODE.GST_CGST), 0);

    await assert.rejects(createInvoice(f.trx, f.orgId, null, {
      branchId: f.branchId, customerId: f.outOfState, date: '2026-05-11', dueDate: '2026-05-11', status: 'approved',
      lines: [{ itemId: f.taxable, description: 'Brake pad', hsnSac: '8708', qty: 1, ratePaise: 100_00, gstRatePct: 18 }],
    }), /cannot make an inter-state supply/);
  });
});

test('no input credit: the tax is part of the cost, reverse charge included', async () => {
  await withFixture(async (f) => {
    await createBill(f.trx, f.orgId, null, {
      branchId: f.branchId, vendorId: f.vendor, vendorInvoiceNo: 'W-1', date: '2026-05-02', dueDate: '2026-05-30', status: 'open',
      lines: [{ itemId: f.taxable, description: 'Brake pads', hsnSac: '8708', qty: 100, ratePaise: 80_00, gstRatePct: 18 }],
    } as never);
    assert.equal(await balance(f, CODE.ITC_CGST), 0);
    assert.equal(await balance(f, CODE.ITC_SGST), 0);
    assert.equal(await balance(f, CODE.PURCHASES), 9_440_00, '₹8,000 and its ₹1,440 GST');

    await createBill(f.trx, f.orgId, null, {
      branchId: f.branchId, vendorId: f.unregistered, vendorInvoiceNo: 'GTA-7', date: '2026-05-03', dueDate: '2026-05-03', status: 'open',
      isRcm: true, lines: [{ description: 'Freight (GTA)', qty: 1, ratePaise: 1_000_00, gstRatePct: 5, accountId: f.acc[CODE.FREIGHT] }],
    } as never);
    assert.equal(await balance(f, CODE.ITC_CGST), 0, 'no credit under reverse charge either');
    assert.equal(await balance(f, CODE.RCM_PAYABLE), -50_00, 'but the reverse charge is owed');
    assert.equal(await balance(f, CODE.FREIGHT), 1_050_00);
  });
});

test('CMP-08: 1% of a trader’s taxable turnover, plus reverse charge; booked once', async () => {
  await withFixture(async (f) => {
    await createInvoice(f.trx, f.orgId, null, {
      branchId: f.branchId, customerId: f.local, date: '2026-05-10', dueDate: '2026-05-10', status: 'approved',
      lines: [
        { itemId: f.taxable, description: 'Brake pad', hsnSac: '8708', qty: 100, ratePaise: 100_00, gstRatePct: 18 },
        { itemId: f.exempt, description: 'Milk', hsnSac: '0401', qty: 40, ratePaise: 50_00, gstRatePct: 0 },
      ],
    });
    await createBill(f.trx, f.orgId, null, {
      branchId: f.branchId, vendorId: f.unregistered, vendorInvoiceNo: 'GTA-7', date: '2026-05-03', dueDate: '2026-05-03', status: 'open',
      isRcm: true, lines: [{ description: 'Freight (GTA)', qty: 1, ratePaise: 1_000_00, gstRatePct: 5, accountId: f.acc[CODE.FREIGHT] }],
    } as never);

    const c = await cmp08(f.trx, f.orgId, 2026, 1);
    assert.equal(c.ratePct, 1);
    assert.equal(c.turnoverPaise, 10_000_00);
    assert.equal(c.exemptPaise, 2_000_00, 'a trader pays nothing on exempt sales');
    assert.deepEqual(c.outward, { cgst: 50_00, sgst: 50_00 });
    assert.equal(c.reverseCharge.cgst + c.reverseCharge.sgst, 50_00);
    assert.equal(c.totalPaise, 150_00);
    assert.equal(c.dueDate, '2026-07-18');

    await bookCmp08(f.trx, f.orgId, null, 2026, 1);
    assert.equal(await balance(f, CODE.COMPOSITION_TAX), 100_00);
    assert.equal(await balance(f, CODE.GST_CGST), -50_00);
    await assert.rejects(bookCmp08(f.trx, f.orgId, null, 2026, 1), /already booked/);

    await f.trx.updateTable('organizations').set({ composition_category: 'manufacturer' }).where('id', '=', f.orgId).execute();
    assert.equal((await cmp08(f.trx, f.orgId, 2026, 1)).turnoverPaise, 12_000_00, 'a manufacturer pays on all of it');
  });
});

test('GSTR-4 lists inward supplies by kind and the year’s quarters', async () => {
  await withFixture(async (f) => {
    await createBill(f.trx, f.orgId, null, {
      branchId: f.branchId, vendorId: f.vendor, vendorInvoiceNo: 'W-1', date: '2026-05-02', dueDate: '2026-05-30', status: 'open',
      lines: [{ itemId: f.taxable, description: 'Brake pads', hsnSac: '8708', qty: 100, ratePaise: 80_00, gstRatePct: 18 }],
    } as never);
    await createBill(f.trx, f.orgId, null, {
      branchId: f.branchId, vendorId: f.unregistered, vendorInvoiceNo: 'GTA-7', date: '2026-05-03', dueDate: '2026-05-03', status: 'open',
      isRcm: true, lines: [{ description: 'Freight (GTA)', qty: 1, ratePaise: 1_000_00, gstRatePct: 5, accountId: f.acc[CODE.FREIGHT] }],
    } as never);
    const g = await gstr4(f.trx, f.orgId, 2026);
    assert.equal(g.dueDate, '2027-06-30');
    assert.equal(g.inward.registered.length, 1);
    assert.equal(g.inward.registered[0].gstin, '33AAACW3333W1Z3');
    assert.equal(g.inward.registered[0].taxablePaise, 8_000_00);
    assert.equal(g.inward.unregistered.bills, 1);
    assert.equal(g.quarters.length, 4);
  });
});

test.after(async () => {
  await db.destroy();
});
