// Fixed assets: the register, Schedule II depreciation, CWIP, disposal, and the
// Income-tax block schedule.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/fixed-assets.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { verifyLedgerBalances } from '../../lib/server/ledger/posting';
import { setBooksStartDate } from '../../lib/server/services/opening-balances';
import { createBill } from '../../lib/server/services/purchases';
import {
  addAsset, addCost, assetRegister, depreciationFor, disposeAsset, ensureAssetClasses, itDepreciation,
  listAssetClasses, minimumGstOnSale, previewDepreciation, putToUse, reverseLatestRun, runDepreciation, setItOpening,
} from '../../lib/server/services/fixed-assets';

interface Fixture {
  trx: Trx; orgId: number; branchId: number; acc: Record<string, number>; bankLedger: number;
  customer: number; vendor: number; cls: Record<string, number>;
}

async function withFixture(fn: (f: Fixture) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Assets Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({
        org_id: orgId, name: 'Plant', state_code: '33', is_primary: 1,
      }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      await ensureAssetClasses(trx, orgId);
      const acc = await accountIds(trx, orgId);
      const classes = await listAssetClasses(trx, orgId);
      const mk = async (v: Record<string, unknown>) =>
        Number((await trx.insertInto('contacts').values({ org_id: orgId, state_code: '33', ...v } as never).executeTakeFirstOrThrow()).insertId);
      await fn({
        trx, orgId, branchId, acc, bankLedger: acc[CODE.BANK_DEFAULT],
        customer: await mk({ kind: 'customer', display_name: 'Scrap Buyer', gst_treatment: 'unregistered' }),
        vendor: await mk({ kind: 'vendor', display_name: 'Machine Maker', gst_treatment: 'registered', gstin: '33BBBBB0000B1Z5' }),
        cls: Object.fromEntries(classes.map((c) => [c.name, Number(c.id)])),
      });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

async function balance(f: Fixture, code: string) {
  const { rows } = await sql<{ v: string }>`
    SELECT COALESCE(SUM(l.debit - l.credit), 0) AS v FROM journal_lines l JOIN accounts a ON a.id = l.account_id
     WHERE l.org_id = ${f.orgId} AND a.code = ${code}`.execute(f.trx);
  return Math.round(Number(rows[0].v) * 100);
}

test('the arithmetic: straight line, written-down value, and GST on a used asset', () => {
  const basis = { costPaise: 1_00_000_00, residualPaise: 5_000_00, lifeYears: 5, method: 'slm' as const, putToUseOn: '2026-10-01' };
  // 95,000 over five years is 19,000 a year; 182 days of it.
  assert.equal(depreciationFor(basis, '2026-04-01', '2027-03-31', 0).amountPaise, Math.round(1_900_000 * 182 / 365));
  assert.equal(depreciationFor(basis, '2026-04-01', '2026-09-30', 0).amountPaise, 0, 'nothing before it is in use');
  // Never below the residual value.
  assert.equal(depreciationFor(basis, '2026-10-01', '2040-03-31', 90_000_00).amountPaise, 5_000_00);

  const wdv = { ...basis, method: 'wdv' as const, putToUseOn: '2026-04-01' };
  const rate = 1 - Math.pow(0.05, 1 / 5); // about 45.07%
  assert.equal(depreciationFor(wdv, '2026-04-01', '2027-03-31', 0).amountPaise, Math.round(1_00_000_00 * rate));

  // Credit of 18,000 taken; sold seven months later: three quarters, 15% off.
  assert.equal(minimumGstOnSale(18_000_00, '2026-04-10', '2026-11-05'), 15_300_00);
  assert.equal(minimumGstOnSale(18_000_00, '2026-04-10', '2026-04-10'), 17_100_00, 'a part quarter counts');
  assert.equal(minimumGstOnSale(18_000_00, '2020-04-10', '2026-04-11'), 0, 'twenty quarters wipe it out');
});

test('bought, depreciated in runs, and the runs post', async () => {
  await withFixture(async (f) => {
    const { id, tagNo } = await addAsset(f.trx, f.orgId, null, {
      branchId: f.branchId, classId: f.cls['Plant & Machinery'], name: 'CNC lathe', acquiredOn: '2026-09-20',
      putToUseOn: '2026-10-01', costPaise: 15_00_000_00, usefulLifeYears: 15, source: { kind: 'paid', fromAccountId: f.bankLedger },
    });
    assert.equal(tagNo, 'FA-0001');
    assert.equal(await balance(f, CODE.PLANT_MACHINERY), 15_00_000_00);

    const p = await previewDepreciation(f.trx, f.orgId, f.branchId, '2026-12-31');
    assert.equal(p.from, '2026-10-01');
    // (15,00,000 − 5%) ÷ 15 = 95,000 a year; 92 days.
    assert.equal(p.totalPaise, Math.round(95_000_00 * 92 / 365));

    const r1 = await runDepreciation(f.trx, f.orgId, null, f.branchId, '2026-12-31');
    await assert.rejects(runDepreciation(f.trx, f.orgId, null, f.branchId, '2026-12-31'), /already charged up to 2026-12-31/);
    const r2 = await runDepreciation(f.trx, f.orgId, null, f.branchId, '2027-03-31');
    assert.equal(r2.from, '2027-01-01');
    assert.equal(await balance(f, CODE.DEPRECIATION), r1.totalPaise + r2.totalPaise);
    assert.equal(await balance(f, CODE.ACCUMULATED_DEPRECIATION), -(r1.totalPaise + r2.totalPaise));

    // The latest run can be taken back, and run again.
    await reverseLatestRun(f.trx, f.orgId, null, f.branchId);
    assert.equal(await balance(f, CODE.DEPRECIATION), r1.totalPaise);
    const again = await runDepreciation(f.trx, f.orgId, null, f.branchId, '2027-03-31');
    assert.equal(again.totalPaise, r2.totalPaise);

    const reg = await assetRegister(f.trx, f.orgId, '2027-03-31');
    assert.equal(reg[0].id, String(id));
    assert.equal(reg[0].netPaise, 15_00_000_00 - r1.totalPaise - r2.totalPaise);
    assert.ok(reg[0].flags.includes('Not verified in a year'));
  });
});

test('built in CWIP, put to use, then depreciated only from that day', async () => {
  await withFixture(async (f) => {
    const { id } = await addAsset(f.trx, f.orgId, null, {
      branchId: f.branchId, classId: f.cls['Buildings'], name: 'New shed', acquiredOn: '2026-05-01',
      costPaise: 10_00_000_00, source: { kind: 'paid', fromAccountId: f.bankLedger },
    });
    await addCost(f.trx, f.orgId, null, id, { date: '2026-07-15', amountPaise: 2_00_000_00, fromAccountId: f.bankLedger, description: 'Roofing' });
    assert.equal(await balance(f, CODE.CWIP), 12_00_000_00);
    assert.equal((await previewDepreciation(f.trx, f.orgId, f.branchId, '2026-12-31')).totalPaise, 0, 'CWIP is not depreciated');

    await assert.rejects(putToUse(f.trx, f.orgId, null, id, '2026-07-01'), /cannot be in use before/);
    await putToUse(f.trx, f.orgId, null, id, '2026-08-01');
    assert.equal(await balance(f, CODE.CWIP), 0);
    assert.equal(await balance(f, CODE.BUILDINGS), 12_00_000_00);
    await assert.rejects(addCost(f.trx, f.orgId, null, id, { date: '2026-09-01', amountPaise: 1_00, fromAccountId: f.bankLedger }), /already in use/);

    const p = await previewDepreciation(f.trx, f.orgId, f.branchId, '2027-03-31');
    assert.equal(p.from, '2026-08-01');
    assert.equal(p.lines[0].days, 243);
  });
});

test('a bill to a fixed-asset ledger is capitalised without posting twice', async () => {
  await withFixture(async (f) => {
    const bill = await createBill(f.trx, f.orgId, null, {
      branchId: f.branchId, vendorId: f.vendor, vendorInvoiceNo: 'MM-9', date: '2026-06-10', dueDate: '2026-07-10',
      lines: [{ description: 'Laptops', qty: 2, ratePaise: 60_000_00, gstRatePct: 18, accountId: f.acc[CODE.COMPUTERS], itcEligibility: 'capital_goods' }],
    } as never);
    const before = await balance(f, CODE.COMPUTERS);
    const r = await addAsset(f.trx, f.orgId, null, {
      branchId: f.branchId, classId: f.cls['Computers & Peripherals'], name: 'Laptop 1', acquiredOn: '2026-06-10',
      putToUseOn: '2026-06-12', costPaise: 60_000_00, source: { kind: 'bill', billId: bill.id },
    });
    assert.equal(r.entryId, null, 'already in the right ledger');
    assert.equal(await balance(f, CODE.COMPUTERS), before);
    const row = await f.trx.selectFrom('fixed_assets').select(['itc_claimed', 'vendor_id']).where('id', '=', r.id).executeTakeFirstOrThrow();
    assert.equal(Number(row.itc_claimed), 10_800, 'half the bill, half its credit');
    assert.equal(row.vendor_id, f.vendor);
  });
});

test('sold by invoice: gain or loss, and the clearing account empties', async () => {
  await withFixture(async (f) => {
    await f.trx.insertInto('hsn_codes').values({ org_id: f.orgId, code: '8704', kind: 'hsn', description: 'Goods vehicles', gst_rate_pct: '18' }).execute();
    const { id } = await addAsset(f.trx, f.orgId, null, {
      branchId: f.branchId, classId: f.cls['Vehicles'], name: 'Delivery van', acquiredOn: '2026-04-01',
      putToUseOn: '2026-04-01', costPaise: 8_00_000_00, itcClaimedPaise: 0, hsnSac: '8704',
      source: { kind: 'paid', fromAccountId: f.bankLedger },
    });
    await runDepreciation(f.trx, f.orgId, null, f.branchId, '2026-09-30');
    const r = await disposeAsset(f.trx, f.orgId, null, id, {
      date: '2026-11-15', kind: 'sold', customerId: f.customer, salePaise: 7_50_000_00, gstRatePct: 18,
    });
    assert.ok(r.invoiceNumber?.startsWith('INV/'));
    // Depreciation to 14 November was charged at disposal; 7,50,000 against
    // what is left after it.
    assert.equal(r.gainPaise, 7_50_000_00 + r.accumulatedPaise - 8_00_000_00);
    assert.equal(await balance(f, CODE.ASSET_DISPOSAL), 0);
    assert.equal(await balance(f, CODE.VEHICLES), 0);
    assert.equal(await balance(f, CODE.ACCUMULATED_DEPRECIATION), 0);
    assert.equal(await balance(f, CODE.SALES), 0, 'an asset sale is not revenue');
    const inv = await f.trx.selectFrom('invoices').select(['igst', 'cgst', 'subtotal']).where('id', '=', r.invoiceId!).executeTakeFirstOrThrow();
    assert.equal(Number(inv.subtotal), 7_50_000);
    assert.ok((await verifyLedgerBalances(f.trx, f.orgId)).balanced);
    await assert.rejects(disposeAsset(f.trx, f.orgId, null, id, { date: '2026-12-01', kind: 'scrapped' }), /already disposed/);
  });
});

test('opening assets carry their depreciation, and the Income-tax book follows the blocks', async () => {
  await withFixture(async (f) => {
    await setBooksStartDate(f.trx, f.orgId, '2026-04-01');
    await addAsset(f.trx, f.orgId, null, {
      branchId: f.branchId, classId: f.cls['Plant & Machinery'], name: 'Old press', acquiredOn: '2022-04-01', putToUseOn: '2022-04-01',
      costPaise: 5_00_000_00, source: { kind: 'opening', accumulatedPaise: 1_20_000_00 },
    });
    assert.equal(await balance(f, CODE.ACCUMULATED_DEPRECIATION), -1_20_000_00);
    assert.equal(await balance(f, CODE.OPENING_BALANCE_EQUITY), -3_80_000_00);

    // The tax return carried the block at 3,00,000.
    await setItOpening(f.trx, f.orgId, { fyStart: 2026, block: 'Plant & machinery (general)', ratePct: 15, openingPaise: 3_00_000_00 });
    // One machine bought in May (full rate), one in December (half rate).
    await addAsset(f.trx, f.orgId, null, {
      branchId: f.branchId, classId: f.cls['Plant & Machinery'], name: 'Drill', acquiredOn: '2026-05-10', putToUseOn: '2026-05-10',
      costPaise: 1_00_000_00, source: { kind: 'paid', fromAccountId: f.bankLedger },
    });
    await addAsset(f.trx, f.orgId, null, {
      branchId: f.branchId, classId: f.cls['Plant & Machinery'], name: 'Grinder', acquiredOn: '2026-12-01', putToUseOn: '2026-12-01',
      costPaise: 40_000_00, source: { kind: 'paid', fromAccountId: f.bankLedger },
    });
    const [pm] = (await itDepreciation(f.trx, f.orgId, 2026)).filter((b) => b.block.startsWith('Plant'));
    assert.equal(pm.openingPaise, 3_00_000_00);
    assert.equal(pm.additionsFullPaise, 1_00_000_00);
    assert.equal(pm.additionsHalfPaise, 40_000_00);
    assert.equal(pm.depreciationPaise, 60_000_00 + 3_000_00, '15% of 4,00,000 and 7.5% of 40,000');
    assert.equal(pm.closingPaise, 4_40_000_00 - 63_000_00);

    // The next year opens where this one closed.
    const [next] = (await itDepreciation(f.trx, f.orgId, 2027)).filter((b) => b.block.startsWith('Plant'));
    assert.equal(next.openingPaise, pm.closingPaise);
  });
});

test.after(async () => {
  await db.destroy();
});
