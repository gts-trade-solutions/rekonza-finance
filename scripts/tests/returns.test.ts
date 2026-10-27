// GSTR-3B set-off, the annual GSTR-9 and IFF, worked from documents.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/returns.test.ts
//
// The rules pinned down here are the ones that decide how much cash a business
// pays: reverse-charge tax is never met by credit, credit notes reduce output
// tax, expenses carry credit too, and CGST or SGST credit left over may clear
// IGST — but never each other.

import test from 'node:test';
import assert from 'node:assert/strict';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { createInvoice } from '../../lib/server/services/sales';
import { createBill, createExpense } from '../../lib/server/services/purchases';
import { createCreditNote } from '../../lib/server/services/sales-documents';
import { gstr3b, iff } from '../../lib/server/gst/returns';
import { gstr9 } from '../../lib/server/gst/gstr9';

interface Fixture {
  trx: Trx; orgId: number; branchId: number; bankId: number; acc: Record<string, number>;
  localCustomer: number; otherStateCustomer: number; consumer: number;
  vendor: number; unregisteredVendor: number;
}

async function withFixture(fn: (f: Fixture) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Returns Test Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({
        org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1, gstin: '33AABCR1234M1Z5',
      }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const acc = await accountIds(trx, orgId);
      const mk = async (values: Record<string, unknown>) =>
        Number((await trx.insertInto('contacts').values({ org_id: orgId, ...values } as never).executeTakeFirstOrThrow()).insertId);
      const f: Fixture = {
        trx, orgId, branchId, acc,
        bankId: Number((await trx.insertInto('bank_accounts').values({
          org_id: orgId, kind: 'bank', name: 'Bank', ledger_account_id: acc[CODE.BANK_DEFAULT], opening_balance: '0.0000',
        }).executeTakeFirstOrThrow()).insertId),
        localCustomer: await mk({ kind: 'customer', display_name: 'Local Co', gst_treatment: 'registered', state_code: '33', gstin: '33AAACL1111L1Z1' }),
        otherStateCustomer: await mk({ kind: 'customer', display_name: 'Kerala Co', gst_treatment: 'registered', state_code: '32', gstin: '32AAACK2222K1Z2' }),
        consumer: await mk({ kind: 'customer', display_name: 'Walk-in', gst_treatment: 'unregistered', state_code: '33' }),
        vendor: await mk({ kind: 'vendor', display_name: 'Supplier', gst_treatment: 'registered', state_code: '33', gstin: '33AAACS3333S1Z3' }),
        unregisteredVendor: await mk({ kind: 'vendor', display_name: 'Lorry owner', gst_treatment: 'unregistered', state_code: '33' }),
      };
      await fn(f);
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

const sell = (f: Fixture, customerId: number, date: string, rupees: number) =>
  createInvoice(f.trx, f.orgId, null, {
    branchId: f.branchId, customerId, date, dueDate: date, status: 'approved',
    lines: [{ description: 'Goods', qty: 1, ratePaise: rupees * 100, gstRatePct: 18 }],
  });
const buy = (f: Fixture, vendorId: number, no: string, date: string, rupees: number, isRcm = false) =>
  createBill(f.trx, f.orgId, null, {
    branchId: f.branchId, vendorId, vendorInvoiceNo: no, date, dueDate: date, isRcm,
    lines: [{ description: 'Stock', qty: 1, ratePaise: rupees * 100, gstRatePct: 18 }],
  });
const head = (g: Awaited<ReturnType<typeof gstr3b>>, h: 'IGST' | 'CGST' | 'SGST' | 'CESS') =>
  g.setOff.find((s) => s.head === h)!;

test('reverse-charge tax is paid in cash even when credit is left over', async () => {
  await withFixture(async (f) => {
    await sell(f, f.localCustomer, '2026-08-05', 10_000);          // CGST 900, SGST 900
    await buy(f, f.vendor, 'S-1', '2026-08-06', 20_000);           // credit 1,800 + 1,800
    await buy(f, f.unregisteredVendor, 'R-1', '2026-08-07', 1_000, true); // RCM 90 + 90

    const g = await gstr3b(f.trx, f.orgId, '2026-08');
    const c = head(g, 'CGST');
    assert.equal(c.liabilityPaise, 990_00, '900 on sales + 90 under reverse charge');
    assert.equal(c.rcmPaise, 90_00);
    assert.equal(c.creditUsedPaise, 900_00, 'credit meets the sales tax only');
    assert.equal(c.cashPaise, 90_00, 'the reverse-charge tax is cash');
    assert.equal(g.totalCashPaise, 180_00);
    // And it is claimed back as credit in the same return.
    assert.equal(g.itc.cgstPaise, 1_890_00);
  });
});

test('a credit note issued in the month reduces the output tax', async () => {
  await withFixture(async (f) => {
    await sell(f, f.localCustomer, '2026-08-05', 10_000);
    await createCreditNote(f.trx, f.orgId, null, {
      branchId: f.branchId, customerId: f.localCustomer, date: '2026-08-20', reason: 'Short supply',
      lines: [{ description: 'Goods', qty: 1, ratePaise: 2_000_00, gstRatePct: 18 }],
    });
    const g = await gstr3b(f.trx, f.orgId, '2026-08');
    assert.equal(g.outward.taxablePaise, 8_000_00);
    assert.equal(g.outward.cgstPaise, 720_00);
  });
});

test('CGST and SGST credit clear IGST left over, and expenses carry credit', async () => {
  await withFixture(async (f) => {
    await sell(f, f.otherStateCustomer, '2026-08-05', 10_000);      // IGST 1,800
    await buy(f, f.vendor, 'S-1', '2026-08-06', 5_000);             // CGST 450, SGST 450
    await createExpense(f.trx, f.orgId, null, {
      branchId: f.branchId, date: '2026-08-07', accountId: f.acc[CODE.RENT],
      paidThroughBankAccountId: f.bankId, amountPaise: 1_180_00, gstRatePct: 18,
    });                                                              // CGST 90, SGST 90

    const g = await gstr3b(f.trx, f.orgId, '2026-08');
    assert.equal(g.itc.cgstPaise, 540_00, 'the expense’s credit is counted');
    const i = head(g, 'IGST');
    assert.equal(i.creditUsedPaise, 1_080_00, 'CGST 540 and SGST 540 both meet IGST');
    assert.equal(i.cashPaise, 720_00);
  });
});

test('GSTR-9 splits the year’s supplies, and table 9 adds up the monthly returns', async () => {
  await withFixture(async (f) => {
    await sell(f, f.localCustomer, '2026-05-10', 10_000);
    await sell(f, f.consumer, '2026-11-10', 5_000);
    await sell(f, f.otherStateCustomer, '2027-02-10', 2_000);
    await buy(f, f.vendor, 'S-1', '2026-06-01', 4_000);
    await buy(f, f.unregisteredVendor, 'R-1', '2026-07-01', 1_000, true);

    const y = await gstr9(f.trx, f.orgId, 2026);
    assert.equal(y.fy, '2026-27');
    assert.equal(y.table4.b2b.taxablePaise, 12_000_00, 'both registered buyers');
    assert.equal(y.table4.b2c.taxablePaise, 5_000_00);
    assert.equal(y.table4.rcmInward.taxablePaise, 1_000_00);
    assert.equal(y.table6.inputs.cgstPaise, 360_00);
    assert.equal(y.table6.rcmUnregistered.cgstPaise, 90_00);

    const months = ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11',
      '2026-12', '2027-01', '2027-02', '2027-03'];
    let cash = 0;
    for (const m of months) cash += (await gstr3b(f.trx, f.orgId, m)).totalCashPaise;
    assert.equal(y.table9.reduce((t, r) => t + r.paidInCashPaise, 0), cash, 'the annual and monthly figures agree');
  });
});

test('IFF is the B2B part of GSTR-1, and warns in the last month of a quarter', async () => {
  await withFixture(async (f) => {
    await sell(f, f.localCustomer, '2026-07-10', 10_000);
    await sell(f, f.consumer, '2026-07-11', 5_000);
    const july = await iff(f.trx, f.orgId, '2026-07');
    assert.equal(july.b2b.length, 1, 'the consumer sale is not in IFF');
    assert.ok(!july.issues.some((i) => /last month of a quarter/.test(i.message)));

    const september = await iff(f.trx, f.orgId, '2026-09');
    assert.ok(september.issues.some((i) => /last month of a quarter/.test(i.message)));
  });
});

test.after(async () => {
  await db.destroy();
});
