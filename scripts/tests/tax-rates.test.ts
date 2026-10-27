// Tax rates by date: GST on HSN codes, and TCS on invoices.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/tax-rates.test.ts
//
// A document is taxed at the rate in force on its own date. These tests pin
// that down across a rate change, and check TCS is collected only where it
// still applies, at the book's rate, with its threshold and no-PAN rate.

import test from 'node:test';
import assert from 'node:assert/strict';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { createInvoice } from '../../lib/server/services/sales';
import { createBill } from '../../lib/server/services/purchases';
import { adoptShippedRates, tcsRateOn, tdsRateOn } from '../../lib/server/tax/rates';
import { DEFAULT_TCS_RATES, rateOn, sectionLabel } from '../../lib/tax/statutory-rates';
import { hsnRateOn } from '../../lib/tax/gst';
import { toPaiseFromSql } from '../../lib/server/money-sql';

interface Fixture { trx: Trx; orgId: number; branchId: number; customerId: number; noPanCustomerId: number; vendorId: number; codeId: number }

async function withFixture(fn: (f: Fixture) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Rates Test Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches')
        .values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1 }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);

      const mk = async (values: Record<string, unknown>) =>
        Number((await trx.insertInto('contacts').values(values as never).executeTakeFirstOrThrow()).insertId);
      const customerId = await mk({ org_id: orgId, kind: 'customer', display_name: 'Scrap Buyer', gst_treatment: 'registered', state_code: '33', pan: 'AAACB1234C' });
      const noPanCustomerId = await mk({ org_id: orgId, kind: 'customer', display_name: 'Walk-in', gst_treatment: 'unregistered', state_code: '33' });
      const vendorId = await mk({ org_id: orgId, kind: 'vendor', display_name: 'Supplier', gst_treatment: 'registered', state_code: '33', pan: 'AAACS1234C' });

      // A code whose rate fell from 12% to 5% on 22 September 2025.
      const codeId = Number((await trx.insertInto('hsn_codes').values({
        org_id: orgId, code: '9403', kind: 'hsn', description: 'Furniture', gst_rate_pct: 5, is_active: 1,
      }).executeTakeFirstOrThrow()).insertId);
      await trx.insertInto('hsn_rate_history').values([
        { org_id: orgId, hsn_code_id: codeId, effective_from: '2017-07-01', gst_rate_pct: '12', cess_rate_pct: '0' },
        { org_id: orgId, hsn_code_id: codeId, effective_from: '2025-09-22', gst_rate_pct: '5', cess_rate_pct: '0' },
      ]).execute();
      await trx.insertInto('hsn_codes').values({
        org_id: orgId, code: '7204', kind: 'hsn', description: 'Ferrous scrap', gst_rate_pct: 18, is_active: 1,
      }).execute();
      await trx.insertInto('hsn_codes').values({
        org_id: orgId, code: '8703', kind: 'hsn', description: 'Motor cars', gst_rate_pct: 40, is_active: 1,
      }).execute();

      await fn({ trx, orgId, branchId, customerId, noPanCustomerId, vendorId, codeId });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

test('the row in force is the latest that had started', () => {
  const rows = [
    { code: 'X', effectiveFrom: '2025-04-01', v: 1 },
    { code: 'X', effectiveFrom: '2026-04-01', v: 2 },
    { code: 'Y', effectiveFrom: '2025-04-01', v: 9 },
  ];
  assert.equal(rateOn(rows, 'X', '2026-03-31')?.v, 1);
  assert.equal(rateOn(rows, 'X', '2026-04-01')?.v, 2);
  assert.equal(rateOn(rows, 'X', '2025-03-31'), null, 'nothing is guessed before the first row');
  assert.equal(sectionLabel({ code: '194C', actRef: '393(1) Table Sl. 6(i)' }, '2026-05-01'), '393(1) Table Sl. 6(i) (earlier 194C)');
  assert.equal(sectionLabel({ code: '194C', actRef: '393(1) Table Sl. 6(i)' }, '2026-03-01'), '194C');
  assert.deepEqual(hsnRateOn({ gstRatePct: 18 }, '2026-01-01'), { gstRatePct: 18, cessRatePct: 0 });
});

test('a line with no rate takes the one in force on the document date', async () => {
  await withFixture(async ({ trx, orgId, branchId, customerId }) => {
    const sell = (date: string) => createInvoice(trx, orgId, null, {
      branchId, customerId, date, dueDate: date, status: 'approved',
      lines: [{ description: 'Table', hsnSac: '9403', qty: 1, ratePaise: 100_000 }],
    });
    const before = await sell('2025-09-21');
    const after = await sell('2025-09-22');
    assert.equal(before.totalPaise, 112_000, '12% the day before the change');
    assert.equal(after.totalPaise, 105_000, '5% from the day it took effect');

    // A rate the user chose is used as given.
    const chosen = await createInvoice(trx, orgId, null, {
      branchId, customerId, date: '2025-10-01', dueDate: '2025-10-01', status: 'approved',
      lines: [{ description: 'Table', hsnSac: '9403', qty: 1, ratePaise: 100_000, gstRatePct: 18 }],
    });
    assert.equal(chosen.totalPaise, 118_000);
  });
});

test('bills follow the same dated rate', async () => {
  await withFixture(async ({ trx, orgId, branchId, vendorId }) => {
    const bill = await createBill(trx, orgId, null, {
      branchId, vendorId, vendorInvoiceNo: 'F-1', date: '2025-09-01', dueDate: '2025-09-01',
      lines: [{ description: 'Chairs', hsnSac: '9403', qty: 1, ratePaise: 100_000 }],
    });
    assert.equal(bill.totalPaise, 112_000);
  });
});

test('TCS on scrap is collected at the book’s rate on the invoice date', async () => {
  await withFixture(async ({ trx, orgId, branchId, customerId }) => {
    const inv = await createInvoice(trx, orgId, null, {
      branchId, customerId, date: '2026-05-01', dueDate: '2026-05-01', status: 'approved',
      tcsCode: 'TCS-SCRAP',
      lines: [{ description: 'MS scrap', hsnSac: '7204', qty: 1, ratePaise: 1_00_000_00 }],
    });
    // ₹1,00,000 + 18% GST = ₹1,18,000; 2% TCS on that is ₹2,360.
    const row = await trx.selectFrom('invoices').select(['tcs', 'tcs_code', 'total'])
      .where('id', '=', inv.id).executeTakeFirstOrThrow();
    assert.equal(toPaiseFromSql(row.tcs), 2_360_00);
    assert.equal(row.tcs_code, 'TCS-SCRAP');
    assert.equal(inv.totalPaise, 1_20_360_00);

    const lines = await trx.selectFrom('journal_lines')
      .innerJoin('accounts', 'accounts.id', 'journal_lines.account_id')
      .select(['accounts.code', 'journal_lines.credit'])
      .where('journal_lines.entry_id', '=', inv.journalEntryId!).execute();
    assert.equal(toPaiseFromSql(lines.find((l) => l.code === CODE.TCS_PAYABLE)!.credit), 2_360_00);
  });
});

test('a TCS threshold collects on the whole sale above it, and nothing below', async () => {
  await withFixture(async ({ trx, orgId, branchId, customerId, noPanCustomerId }) => {
    const car = (customer: number, rupees: number) => createInvoice(trx, orgId, null, {
      branchId, customerId: customer, date: '2026-05-01', dueDate: '2026-05-01', status: 'approved',
      tcsCode: 'TCS-VEHICLE',
      lines: [{ description: 'Car', hsnSac: '8703', qty: 1, ratePaise: rupees * 100, gstRatePct: 40 }],
    });
    const tcsOf = async (id: number) => toPaiseFromSql((await trx.selectFrom('invoices').select('tcs')
      .where('id', '=', id).executeTakeFirstOrThrow()).tcs);

    // ₹6 lakh + 40% = ₹8.4 lakh: under ₹10 lakh, so no TCS.
    assert.equal(await tcsOf((await car(customerId, 6_00_000)).id), 0);
    // ₹10 lakh + 40% = ₹14 lakh: 1% of all of it.
    assert.equal(await tcsOf((await car(customerId, 10_00_000)).id), 14_000_00);
    // The same sale to a buyer with no PAN: 5%.
    assert.equal(await tcsOf((await car(noPanCustomerId, 10_00_000)).id), 70_000_00);
  });
});

test('there is no TCS head for a date before any rate started', async () => {
  await withFixture(async ({ trx, orgId, branchId, customerId }) => {
    await assert.rejects(
      createInvoice(trx, orgId, null, {
        branchId, customerId, date: '2025-06-01', dueDate: '2025-06-01', status: 'approved',
        tcsCode: 'TCS-SCRAP',
        lines: [{ description: 'Scrap', hsnSac: '7204', qty: 1, ratePaise: 10_000_00 }],
      }),
      /no TCS rate/i,
    );
  });
});

test('a book uses the shipped rates until it adopts its own, then only its own', async () => {
  await withFixture(async ({ trx, orgId }) => {
    assert.equal((await tcsRateOn(trx, orgId, 'TCS-SCRAP', '2026-05-01'))?.ratePct, 2);
    await adoptShippedRates(trx, orgId);
    const copied = await trx.selectFrom('tcs_rates').select('code').where('org_id', '=', orgId).execute();
    assert.equal(copied.length, DEFAULT_TCS_RATES.length, 'the whole list is copied, not a part of it');

    await trx.updateTable('tcs_rates').set({ rate_pct: '1.5' })
      .where('org_id', '=', orgId).where('code', '=', 'TCS-SCRAP').execute();
    assert.equal((await tcsRateOn(trx, orgId, 'TCS-SCRAP', '2026-05-01'))?.ratePct, 1.5);
    assert.equal((await tdsRateOn(trx, orgId, '194C', '2026-05-01'))?.rateOtherPct, 2);
  });
});

test.after(async () => {
  await db.destroy();
});
