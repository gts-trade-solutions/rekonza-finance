// Purchase and payment posting, against real MySQL, inside rolled-back
// transactions.
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/purchases.test.ts
//
// These cover the three things the buy side does that the sell side does not:
// input credit that is sometimes blocked, reverse charge, and TDS.

import test from 'node:test';
import { sql } from 'kysely';
import assert from 'node:assert/strict';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { verifyLedgerBalances } from '../../lib/server/ledger/posting';
import { createBill, createExpense, voidBill } from '../../lib/server/services/purchases';
import { receivePayment, makePayment, voidPayment } from '../../lib/server/services/payments';
import { createInvoice } from '../../lib/server/services/sales';
import {
  convertPoToBill, createPurchaseOrder, createVendorCredit,
  refundVendorCredit, voidVendorCredit,
} from '../../lib/server/services/purchase-documents';
import { toPaiseFromSql } from '../../lib/server/money-sql';

interface Fixture {
  trx: Trx;
  orgId: number;
  branchId: number;
  acc: Record<string, number>;
  customerId: number;
  vendorId: number;
  compositionVendorId: number;
  bankId: number;
  itemId: number;
}

async function withFixture(fn: (f: Fixture) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const org = await trx.insertInto('organizations')
        .values({ name: 'Purchase Test Co' }).executeTakeFirstOrThrow();
      const orgId = Number(org.insertId);

      const branch = await trx.insertInto('branches')
        .values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1 })
        .executeTakeFirstOrThrow();
      const branchId = Number(branch.insertId);

      await installChartOfAccounts(trx, orgId);
      const acc = await accountIds(trx, orgId);

      const mk = async (values: Record<string, unknown>) =>
        Number((await trx.insertInto('contacts').values(values as never).executeTakeFirstOrThrow()).insertId);

      const customerId = await mk({
        org_id: orgId, kind: 'customer', display_name: 'Local Customer',
        gst_treatment: 'registered', state_code: '33', pan: 'AAAAA1111A',
      });
      const vendorId = await mk({
        org_id: orgId, kind: 'vendor', display_name: 'Regular Vendor',
        gst_treatment: 'registered', state_code: '33', pan: 'BBBBB2222B',
      });
      const compositionVendorId = await mk({
        org_id: orgId, kind: 'vendor', display_name: 'Composition Vendor',
        gst_treatment: 'registered_composition', state_code: '33', pan: 'CCCCC3333C',
      });

      const bank = await trx.insertInto('bank_accounts')
        .values({
          org_id: orgId, kind: 'bank', name: 'Test Bank',
          ledger_account_id: acc[CODE.BANK_DEFAULT], opening_balance: '0.0000',
        })
        .executeTakeFirstOrThrow();
      const bankId = Number(bank.insertId);

      const item = await trx.insertInto('items')
        .values({
          org_id: orgId, kind: 'goods', name: 'Widget', sku: 'W-1', hsn_sac: '8708',
          uqc: 'NOS', sale_price: '1000.0000', purchase_price: '600.0000',
          gst_rate_pct: 18, purchase_account_id: acc[CODE.PURCHASES],
          sale_account_id: acc[CODE.SALES],
        })
        .executeTakeFirstOrThrow();
      const itemId = Number(item.insertId);

      await trx.insertInto('hsn_codes').values({
        org_id: orgId, code: '8708', kind: 'hsn', description: 'Motor vehicle parts',
        gst_rate_pct: 18, is_active: 1,
      }).execute();

      await fn({ trx, orgId, branchId, acc, customerId, vendorId, compositionVendorId, bankId, itemId });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

/** Sum a posted entry's lines per account code. */
async function entryByCode(trx: Trx, entryId: number) {
  const rows = await trx
    .selectFrom('journal_lines')
    .innerJoin('accounts', 'accounts.id', 'journal_lines.account_id')
    .select(['accounts.code', 'journal_lines.debit', 'journal_lines.credit'])
    .where('journal_lines.entry_id', '=', entryId)
    .execute();
  const out: Record<string, { dr: number; cr: number }> = {};
  for (const r of rows) {
    out[r.code] ??= { dr: 0, cr: 0 };
    out[r.code].dr += toPaiseFromSql(r.debit);
    out[r.code].cr += toPaiseFromSql(r.credit);
  }
  return out;
}

test('a normal bill claims input credit as an asset', async () => {
  await withFixture(async ({ trx, orgId, branchId, vendorId, itemId }) => {
    const bill = await createBill(trx, orgId, null, {
      branchId, vendorId, vendorInvoiceNo: 'V-001',
      date: '2026-08-07', dueDate: '2026-09-06',
      lines: [{ itemId, qty: 10, ratePaise: 60_000 }],
    });

    // 10 x 600 = 6,000 taxable; 18% intra-state splits 9% / 9%.
    assert.equal(bill.totalPaise, 708_000);

    const e = await entryByCode(trx, bill.journalEntryId!);
    assert.equal(e[CODE.PURCHASES].dr, 600_000, 'cost excludes recoverable tax');
    assert.equal(e[CODE.ITC_CGST].dr, 54_000);
    assert.equal(e[CODE.ITC_SGST].dr, 54_000);
    assert.equal(e[CODE.AP].cr, 708_000);

    assert.ok((await verifyLedgerBalances(trx, orgId)).balanced);
  });
});

test('blocked input credit becomes part of the cost instead of an asset', async () => {
  await withFixture(async ({ trx, orgId, branchId, vendorId, itemId }) => {
    const bill = await createBill(trx, orgId, null, {
      branchId, vendorId, vendorInvoiceNo: 'V-002',
      date: '2026-08-07', dueDate: '2026-09-06',
      lines: [{ itemId, qty: 10, ratePaise: 60_000, itcEligibility: 'ineligible' }],
    });

    const e = await entryByCode(trx, bill.journalEntryId!);
    // The whole 7,080 is cost — nothing is recoverable, so nothing is an asset.
    assert.equal(e[CODE.PURCHASES].dr, 708_000);
    assert.equal(e[CODE.ITC_CGST], undefined, 'no input credit claimed');
    assert.equal(e[CODE.ITC_SGST], undefined);
    assert.equal(e[CODE.AP].cr, 708_000);
  });
});

test('a composition vendor charges no GST, so there is nothing to claim', async () => {
  await withFixture(async ({ trx, orgId, branchId, compositionVendorId, itemId }) => {
    const bill = await createBill(trx, orgId, null, {
      branchId, vendorId: compositionVendorId, vendorInvoiceNo: 'C-001',
      date: '2026-08-07', dueDate: '2026-09-06',
      lines: [{ itemId, qty: 10, ratePaise: 60_000 }],
    });

    assert.equal(bill.totalPaise, 600_000, 'no tax added');
    const e = await entryByCode(trx, bill.journalEntryId!);
    assert.equal(e[CODE.PURCHASES].dr, 600_000);
    assert.equal(e[CODE.ITC_CGST], undefined);
  });
});

test('reverse charge posts both the liability and the credit', async () => {
  await withFixture(async ({ trx, orgId, branchId, vendorId }) => {
    const bill = await createBill(trx, orgId, null, {
      branchId, vendorId, vendorInvoiceNo: 'RCM-001',
      date: '2026-08-07', dueDate: '2026-09-06',
      isRcm: true,
      lines: [{ description: 'Godown rent', qty: 1, ratePaise: 100_000, gstRatePct: 18 }],
    });

    // The vendor is owed the rent only — we account for the GST ourselves.
    assert.equal(bill.totalPaise, 100_000);

    const e = await entryByCode(trx, bill.journalEntryId!);
    assert.equal(e[CODE.AP].cr, 100_000, 'vendor is owed the base amount');
    // Both halves present and equal: we owe the tax and may claim it back.
    assert.equal(e[CODE.ITC_CGST].dr, 9_000);
    assert.equal(e[CODE.ITC_SGST].dr, 9_000);
    // The tax owed sits in its own ledger, because it is paid in cash and
    // input credit cannot settle it. Output GST is untouched.
    assert.equal(e[CODE.RCM_PAYABLE].cr, 18_000);
    assert.equal(e[CODE.GST_CGST], undefined);
    assert.equal(e[CODE.GST_SGST], undefined);

    assert.ok((await verifyLedgerBalances(trx, orgId)).balanced);
  });
});

test('cess on a purchase is input credit of its own, and reverse charge owes it too', async () => {
  await withFixture(async ({ trx, orgId, branchId, vendorId }) => {
    await trx.insertInto('hsn_codes').values({
      org_id: orgId, code: '2402', kind: 'hsn', description: 'Cigars and cigarettes',
      gst_rate_pct: 28, cess_rate_pct: 5, is_active: 1,
    }).execute();

    const bill = await createBill(trx, orgId, null, {
      branchId, vendorId, vendorInvoiceNo: 'CESS-001',
      date: '2026-08-07', dueDate: '2026-09-06',
      lines: [{ description: 'Stock', hsnSac: '2402', qty: 1, ratePaise: 100_000, gstRatePct: 28 }],
    });
    // 1,000 + 28% GST (280) + 5% cess (50).
    assert.equal(bill.totalPaise, 133_000);

    const e = await entryByCode(trx, bill.journalEntryId!);
    assert.equal(e[CODE.ITC_CESS].dr, 5_000);
    assert.equal(e[CODE.PURCHASES].dr, 100_000, 'cess claimed is not part of the cost');
    assert.equal(e[CODE.AP].cr, 133_000);

    const rcm = await createBill(trx, orgId, null, {
      branchId, vendorId, vendorInvoiceNo: 'CESS-RCM',
      date: '2026-08-07', dueDate: '2026-09-06', isRcm: true,
      lines: [{ description: 'Stock', hsnSac: '2402', qty: 1, ratePaise: 100_000, gstRatePct: 28 }],
    });
    const r = await entryByCode(trx, rcm.journalEntryId!);
    assert.equal(r[CODE.ITC_CESS].dr, 5_000);
    assert.equal(r[CODE.RCM_PAYABLE].cr, 33_000, 'GST and cess are both owed under reverse charge');

    assert.ok((await verifyLedgerBalances(trx, orgId)).balanced);
  });
});

test('TDS is withheld from the vendor and becomes a liability', async () => {
  await withFixture(async ({ trx, orgId, branchId, vendorId }) => {
    // 194J: professional fees at 10%, once the year exceeds 50,000.
    const bill = await createBill(trx, orgId, null, {
      branchId, vendorId, vendorInvoiceNo: 'PROF-001',
      date: '2026-08-07', dueDate: '2026-09-06',
      tdsSectionOverride: '194J',
      lines: [{ description: 'Audit fee', qty: 1, ratePaise: 60_000_00, gstRatePct: 18 }],
    });

    const e = await entryByCode(trx, bill.journalEntryId!);
    const tds = e[CODE.TDS_PAYABLE]?.cr ?? 0;
    // Deducted on the taxable value, never on the GST — the tax is the
    // government's already, and withholding tax on tax would double-count it.
    assert.equal(tds, 6_000_00, '10% of 60,000');
    // The vendor is credited the full bill less what we withheld.
    assert.equal(e[CODE.AP].cr, 70_800_00 - 6_000_00);
    assert.ok((await verifyLedgerBalances(trx, orgId)).balanced);
  });
});

test('a bill below the section threshold deducts nothing', async () => {
  await withFixture(async ({ trx, orgId, branchId, vendorId }) => {
    // 194J starts above 50,000 for the year. Deducting on a 5,000 bill would
    // take money off a vendor who owes none, and they would have to reclaim it.
    const bill = await createBill(trx, orgId, null, {
      branchId, vendorId, vendorInvoiceNo: 'PROF-SMALL',
      date: '2026-08-07', dueDate: '2026-09-06',
      tdsSectionOverride: '194J',
      lines: [{ description: 'Small advisory', qty: 1, ratePaise: 5_000_00, gstRatePct: 18 }],
    });

    const e = await entryByCode(trx, bill.journalEntryId!);
    assert.equal(e[CODE.TDS_PAYABLE], undefined, 'nothing withheld below the threshold');
    assert.equal(e[CODE.AP].cr, 5_900_00, 'the vendor is owed the whole bill');
  });
});

test('the threshold is annual, so later bills catch up once it is crossed', async () => {
  await withFixture(async ({ trx, orgId, branchId, vendorId }) => {
    // Six bills of 10,000 each. The first is under 50,000 for the year; by the
    // sixth the vendor is past it, and deduction begins. Judging each bill in
    // isolation would under-deduct, and the shortfall is recovered from us.
    const deducted: number[] = [];
    for (let i = 0; i < 6; i++) {
      const bill = await createBill(trx, orgId, null, {
        branchId, vendorId, vendorInvoiceNo: `PROF-RUN-${i}`,
        date: '2026-08-07', dueDate: '2026-09-06',
        tdsSectionOverride: '194J',
        lines: [{ description: 'Retainer', qty: 1, ratePaise: 10_000_00, gstRatePct: 18 }],
      });
      const e = await entryByCode(trx, bill.journalEntryId!);
      deducted.push(e[CODE.TDS_PAYABLE]?.cr ?? 0);
    }

    assert.equal(deducted[0], 0, 'first bill is under the threshold');
    assert.ok(
      deducted.some((d) => d > 0),
      `deduction starts once the year crosses 50,000 — got ${deducted.join(', ')}`,
    );
    assert.ok((await verifyLedgerBalances(trx, orgId)).balanced);
  });
});

test('a contractor who is an individual is deducted at the lower rate', async () => {
  await withFixture(async ({ trx, orgId, branchId }) => {
    // The PAN's fourth letter says what the payee is: P for a person.
    const person = Number((await trx.insertInto('contacts').values({
      org_id: orgId, kind: 'vendor', display_name: 'Ravi (painter)',
      gst_treatment: 'unregistered', state_code: '33', pan: 'ABCPK1234L',
    }).executeTakeFirstOrThrow()).insertId);
    const firm = Number((await trx.insertInto('contacts').values({
      org_id: orgId, kind: 'vendor', display_name: 'Painters Pvt Ltd',
      gst_treatment: 'unregistered', state_code: '33', pan: 'ABCCK1234L',
    }).executeTakeFirstOrThrow()).insertId);

    const job = (vendorId: number, no: string) => createBill(trx, orgId, null, {
      branchId, vendorId, vendorInvoiceNo: no, date: '2026-08-07', dueDate: '2026-09-06',
      tdsSectionOverride: '194C',
      lines: [{ description: 'Painting', qty: 1, ratePaise: 40_000_00, gstRatePct: 0 }],
    });
    const a = await entryByCode(trx, (await job(person, 'P-1')).journalEntryId!);
    const b = await entryByCode(trx, (await job(firm, 'F-1')).journalEntryId!);
    assert.equal(a[CODE.TDS_PAYABLE].cr, 400_00, '1% of 40,000');
    assert.equal(b[CODE.TDS_PAYABLE].cr, 800_00, '2% of 40,000');
  });
});

test('purchase of goods is deducted only on what the year exceeds ₹50 lakh by', async () => {
  await withFixture(async ({ trx, orgId, branchId, vendorId }) => {
    const buy = (no: string, rupees: number) => createBill(trx, orgId, null, {
      branchId, vendorId, vendorInvoiceNo: no, date: '2026-08-07', dueDate: '2026-09-06',
      tdsSectionOverride: '194Q',
      lines: [{ description: 'Steel', qty: 1, ratePaise: rupees * 100, gstRatePct: 0 }],
    });
    const first = await entryByCode(trx, (await buy('Q-1', 45_00_000)).journalEntryId!);
    const second = await entryByCode(trx, (await buy('Q-2', 10_00_000)).journalEntryId!);
    assert.equal(first[CODE.TDS_PAYABLE], undefined, '₹45 lakh is under the threshold');
    // The year reaches ₹55 lakh; only ₹5 lakh is above it. 0.1% of that is ₹500.
    assert.equal(second[CODE.TDS_PAYABLE].cr, 500_00);
  });
});

test('a bill is deducted at the book’s own rate in force on its date', async () => {
  await withFixture(async ({ trx, orgId, branchId, vendorId }) => {
    const { adoptShippedRates } = await import('../../lib/server/tax/rates');
    await adoptShippedRates(trx, orgId);
    // The CA records a change: professional fees at 7.5% from 1 January 2027.
    await trx.insertInto('tds_rates').values({
      org_id: orgId, code: '194J', act_ref: '393(1) Table Sl. 6(iii)(b)', nature: 'Professional fees',
      effective_from: '2027-01-01', rate_individual_pct: 7.5, rate_other_pct: 7.5, rate_no_pan_pct: 20,
      threshold_single: null, threshold_annual: '50000.0000', on_excess_only: 0,
    }).execute();

    const fee = (no: string, date: string) => createBill(trx, orgId, null, {
      branchId, vendorId, vendorInvoiceNo: no, date, dueDate: date, tdsSectionOverride: '194J',
      lines: [{ description: 'Fee', qty: 1, ratePaise: 1_00_000_00, gstRatePct: 0 }],
    });
    const before = await entryByCode(trx, (await fee('J-1', '2026-12-15')).journalEntryId!);
    const after = await entryByCode(trx, (await fee('J-2', '2027-01-15')).journalEntryId!);
    assert.equal(before[CODE.TDS_PAYABLE].cr, 10_000_00, '10% before the change');
    assert.equal(after[CODE.TDS_PAYABLE].cr, 7_500_00, '7.5% after it');
  });
});

test('an expense extracts the GST from the amount actually paid', async () => {
  await withFixture(async ({ trx, orgId, branchId, bankId, acc }) => {
    const exp = await createExpense(trx, orgId, null, {
      branchId,
      date: '2026-08-07',
      accountId: acc[CODE.FUEL],
      paidThroughBankAccountId: bankId,
      amountPaise: 118_000, // 1,180 paid at the pump
      gstRatePct: 18,
    });

    const e = await entryByCode(trx, exp.journalEntryId);
    assert.equal(e[CODE.FUEL].dr, 100_000, 'the fuel itself cost 1,000');
    assert.equal(e[CODE.ITC_CGST].dr + e[CODE.ITC_SGST].dr, 18_000);
    assert.equal(e[CODE.BANK_DEFAULT].cr, 118_000, 'the bank lost what was paid');
  });
});

test('a receipt clears the invoice and moves it to paid', async () => {
  await withFixture(async ({ trx, orgId, branchId, customerId, itemId, bankId }) => {
    const inv = await createInvoice(trx, orgId, null, {
      branchId, customerId, date: '2026-08-07', dueDate: '2026-09-06',
      status: 'approved', lines: [{ itemId, qty: 1, ratePaise: 100_000 }],
    });

    await receivePayment(trx, orgId, null, {
      branchId, contactId: customerId, date: '2026-08-10', mode: 'neft',
      amountPaise: inv.totalPaise, bankAccountId: bankId,
      allocations: [{ targetType: 'invoice', targetId: inv.id, amountPaise: inv.totalPaise }],
    });

    const after = await trx.selectFrom('invoices')
      .select(['status', 'amount_paid']).where('id', '=', inv.id).executeTakeFirstOrThrow();
    assert.equal(after.status, 'paid');
    assert.equal(toPaiseFromSql(after.amount_paid), inv.totalPaise);
    assert.ok((await verifyLedgerBalances(trx, orgId)).balanced);
  });
});

test('a part payment leaves the invoice partly paid', async () => {
  await withFixture(async ({ trx, orgId, branchId, customerId, itemId, bankId }) => {
    const inv = await createInvoice(trx, orgId, null, {
      branchId, customerId, date: '2026-08-07', dueDate: '2026-09-06',
      status: 'approved', lines: [{ itemId, qty: 1, ratePaise: 100_000 }],
    });
    const half = Math.floor(inv.totalPaise / 2);

    await receivePayment(trx, orgId, null, {
      branchId, contactId: customerId, date: '2026-08-10', mode: 'upi',
      amountPaise: half, bankAccountId: bankId,
      allocations: [{ targetType: 'invoice', targetId: inv.id, amountPaise: half }],
    });

    const after = await trx.selectFrom('invoices')
      .select(['status', 'amount_paid']).where('id', '=', inv.id).executeTakeFirstOrThrow();
    assert.equal(after.status, 'partially_paid');
    assert.equal(toPaiseFromSql(after.amount_paid), half);
  });
});

test('TDS withheld by a customer still settles the invoice', async () => {
  await withFixture(async ({ trx, orgId, branchId, customerId, itemId, bankId }) => {
    const inv = await createInvoice(trx, orgId, null, {
      branchId, customerId, date: '2026-08-07', dueDate: '2026-09-06',
      status: 'approved', lines: [{ itemId, qty: 1, ratePaise: 100_000 }],
    });

    // The customer keeps 2,000 as TDS and sends the rest.
    const tds = 2_000;
    const cash = inv.totalPaise - tds;

    const pay = await receivePayment(trx, orgId, null, {
      branchId, contactId: customerId, date: '2026-08-10', mode: 'neft',
      amountPaise: cash, tdsPaise: tds, bankAccountId: bankId,
      allocations: [{ targetType: 'invoice', targetId: inv.id, amountPaise: inv.totalPaise }],
    });

    const after = await trx.selectFrom('invoices')
      .select(['status']).where('id', '=', inv.id).executeTakeFirstOrThrow();
    assert.equal(after.status, 'paid', 'settled even though less cash arrived');

    const e = await entryByCode(trx, pay.journalEntryId);
    assert.equal(e[CODE.BANK_DEFAULT].dr, cash, 'only the cash reached the bank');
    assert.equal(e[CODE.TDS_RECEIVABLE].dr, tds, 'the rest is recoverable from the government');
    assert.equal(e[CODE.AR].cr, inv.totalPaise, 'the customer owes nothing further');
  });
});

test('money with nothing to match becomes an advance, not a guess', async () => {
  await withFixture(async ({ trx, orgId, branchId, customerId, bankId }) => {
    const pay = await receivePayment(trx, orgId, null, {
      branchId, contactId: customerId, date: '2026-08-10', mode: 'neft',
      amountPaise: 50_000, bankAccountId: bankId,
    });
    assert.equal(pay.unappliedPaise, 50_000);
  });
});

test('refuses to allocate more than the invoice is worth', async () => {
  await withFixture(async ({ trx, orgId, branchId, customerId, itemId, bankId }) => {
    const inv = await createInvoice(trx, orgId, null, {
      branchId, customerId, date: '2026-08-07', dueDate: '2026-09-06',
      status: 'approved', lines: [{ itemId, qty: 1, ratePaise: 100_000 }],
    });

    await assert.rejects(
      () => receivePayment(trx, orgId, null, {
        branchId, contactId: customerId, date: '2026-08-10', mode: 'neft',
        amountPaise: inv.totalPaise * 2, bankAccountId: bankId,
        allocations: [
          { targetType: 'invoice', targetId: inv.id, amountPaise: inv.totalPaise * 2 },
        ],
      }),
      /more than invoice .* is worth|Leave the extra on account/,
    );
  });
});

test('refuses to allocate more than the payment carries', async () => {
  await withFixture(async ({ trx, orgId, branchId, customerId, itemId, bankId }) => {
    const inv = await createInvoice(trx, orgId, null, {
      branchId, customerId, date: '2026-08-07', dueDate: '2026-09-06',
      status: 'approved', lines: [{ itemId, qty: 1, ratePaise: 100_000 }],
    });
    await assert.rejects(
      () => receivePayment(trx, orgId, null, {
        branchId, contactId: customerId, date: '2026-08-10', mode: 'neft',
        amountPaise: 1_000, bankAccountId: bankId,
        allocations: [{ targetType: 'invoice', targetId: inv.id, amountPaise: inv.totalPaise }],
      }),
      /allocated .* against a payment worth/,
    );
  });
});

test('voiding a receipt puts the invoice back to unpaid', async () => {
  await withFixture(async ({ trx, orgId, branchId, customerId, itemId, bankId }) => {
    const inv = await createInvoice(trx, orgId, null, {
      branchId, customerId, date: '2026-08-07', dueDate: '2026-09-06',
      status: 'approved', lines: [{ itemId, qty: 1, ratePaise: 100_000 }],
    });
    const pay = await receivePayment(trx, orgId, null, {
      branchId, contactId: customerId, date: '2026-08-10', mode: 'neft',
      amountPaise: inv.totalPaise, bankAccountId: bankId,
      allocations: [{ targetType: 'invoice', targetId: inv.id, amountPaise: inv.totalPaise }],
    });

    await voidPayment(trx, orgId, null, pay.id, 'Cheque bounced');

    const after = await trx.selectFrom('invoices')
      .select(['status', 'amount_paid']).where('id', '=', inv.id).executeTakeFirstOrThrow();
    // The part that is easy to get wrong: a reversed receipt that leaves the
    // invoice marked paid is money nobody will ever chase.
    assert.equal(toPaiseFromSql(after.amount_paid), 0);
    assert.notEqual(after.status, 'paid');
    assert.ok((await verifyLedgerBalances(trx, orgId)).balanced);
  });
});

test('a bill with a payment against it cannot be voided', async () => {
  await withFixture(async ({ trx, orgId, branchId, vendorId, itemId, bankId }) => {
    const bill = await createBill(trx, orgId, null, {
      branchId, vendorId, vendorInvoiceNo: 'V-900',
      date: '2026-08-07', dueDate: '2026-09-06',
      lines: [{ itemId, qty: 1, ratePaise: 60_000 }],
    });
    await makePayment(trx, orgId, null, {
      branchId, contactId: vendorId, date: '2026-08-10', mode: 'neft',
      amountPaise: bill.totalPaise, bankAccountId: bankId,
      allocations: [{ targetType: 'bill', targetId: bill.id, amountPaise: bill.totalPaise }],
    });

    await assert.rejects(() => voidBill(trx, orgId, null, bill.id), /has payments against it/);
  });
});

test('the ledger still ties after a full buy-and-sell cycle', async () => {
  await withFixture(async ({ trx, orgId, branchId, customerId, vendorId, itemId, bankId, acc }) => {
    for (let i = 0; i < 15; i++) {
      const bill = await createBill(trx, orgId, null, {
        branchId, vendorId, vendorInvoiceNo: `CYC-${i}`,
        date: '2026-08-07', dueDate: '2026-09-06',
        isRcm: i % 5 === 0,
        lines: [{ itemId, qty: 3 + i, ratePaise: 60_000 + i * 137 }],
      });
      await makePayment(trx, orgId, null, {
        branchId, contactId: vendorId, date: '2026-08-09', mode: 'neft',
        amountPaise: bill.totalPaise, bankAccountId: bankId,
        allocations: [{ targetType: 'bill', targetId: bill.id, amountPaise: bill.totalPaise }],
      });

      const inv = await createInvoice(trx, orgId, null, {
        branchId, customerId, date: '2026-08-08', dueDate: '2026-09-07',
        status: 'approved', lines: [{ itemId, qty: 3 + i, ratePaise: 100_000 + i * 211 }],
      });
      await receivePayment(trx, orgId, null, {
        branchId, contactId: customerId, date: '2026-08-11', mode: 'neft',
        amountPaise: inv.totalPaise, bankAccountId: bankId,
        allocations: [{ targetType: 'invoice', targetId: inv.id, amountPaise: inv.totalPaise }],
      });
    }

    await createExpense(trx, orgId, null, {
      branchId, date: '2026-08-12', accountId: acc[CODE.RENT],
      paidThroughBankAccountId: bankId, amountPaise: 8_50_000, gstRatePct: 18,
    });

    const check = await verifyLedgerBalances(trx, orgId);
    assert.ok(check.balanced, 'the whole book still ties');
    assert.equal(check.unbalancedEntries, 0);
    assert.equal(check.totalDebit, check.totalCredit);
  });
});

// ── Purchase orders and vendor credits ──────────────────────────────────────

test('a purchase order posts nothing — a commitment is not a payable', async () => {
  await withFixture(async ({ trx, orgId, branchId, vendorId, itemId, acc }) => {
    const po = await createPurchaseOrder(trx, orgId, null, {
      branchId, vendorId, date: '2026-08-07', lines: [{ itemId, qty: 10 }],
    });

    // 10 x 600 (the purchase price, not the sale price) = 6,000 + 18%.
    assert.equal(po.totalPaise, 708_000);
    assert.equal(po.journalEntryId, null);

    const { rows } = await sql<{ n: string }>`
      SELECT COUNT(*) AS n FROM journal_lines
       WHERE org_id = ${orgId} AND account_id = ${acc[CODE.AP]}
    `.execute(trx);
    assert.equal(Number(rows[0].n), 0, 'nothing has reached payables');
  });
});

test("converting a purchase order needs the supplier's own invoice number", async () => {
  await withFixture(async ({ trx, orgId, branchId, vendorId, itemId }) => {
    const po = await createPurchaseOrder(trx, orgId, null, {
      branchId, vendorId, date: '2026-08-01', lines: [{ itemId, qty: 5 }],
    });
    await assert.rejects(
      () => convertPoToBill(trx, orgId, null, po.id, {
        vendorInvoiceNo: '  ', date: '2026-08-07', dueDate: '2026-09-06',
      }),
      /invoice number is needed/,
    );
  });
});

test('converting a purchase order creates the payable and marks it billed', async () => {
  await withFixture(async ({ trx, orgId, branchId, vendorId, itemId }) => {
    const po = await createPurchaseOrder(trx, orgId, null, {
      branchId, vendorId, date: '2026-08-01', lines: [{ itemId, qty: 10 }],
    });
    const bill = await convertPoToBill(trx, orgId, null, po.id, {
      vendorInvoiceNo: 'SUP-991', date: '2026-08-07', dueDate: '2026-09-06',
    });

    assert.equal(bill.totalPaise, po.totalPaise);
    const row = await trx.selectFrom('purchase_orders').select(['status', 'billed_amount'])
      .where('id', '=', po.id).executeTakeFirstOrThrow();
    assert.equal(row.status, 'billed');
    assert.equal(toPaiseFromSql(row.billed_amount), po.totalPaise);
  });
});

test('a vendor credit reverses the cost and gives back the input credit', async () => {
  await withFixture(async ({ trx, orgId, branchId, vendorId, itemId }) => {
    await createBill(trx, orgId, null, {
      branchId, vendorId, vendorInvoiceNo: 'V-100',
      date: '2026-08-01', dueDate: '2026-09-01',
      lines: [{ itemId, qty: 10, ratePaise: 60_000 }],
    });

    const vc = await createVendorCredit(trx, orgId, null, {
      branchId, vendorId, date: '2026-08-07',
      reason: 'Short supply', amountPaise: 100_000, gstRatePct: 18,
    });

    assert.ok(vc.journalEntryId);
    const e = await entryByCode(trx, vc.journalEntryId!);
    assert.equal(e[CODE.AP].dr, 118_000, 'we owe them that much less');
    assert.equal(e[CODE.PURCHASES].cr, 100_000, 'the cost comes back out');
    assert.equal(e[CODE.ITC_CGST].cr, 9_000, 'and the credit claimed is given back');
    assert.equal(e[CODE.ITC_SGST].cr, 9_000);
  });
});

test('a vendor credit on a blocked purchase takes the tax out of the cost, not the credit pot', async () => {
  await withFixture(async ({ trx, orgId, branchId, vendorId }) => {
    const vc = await createVendorCredit(trx, orgId, null, {
      branchId, vendorId, date: '2026-08-07',
      reason: 'Return on a blocked expense', amountPaise: 100_000, gstRatePct: 18,
      itcClaimed: false,
    });

    const e = await entryByCode(trx, vc.journalEntryId!);
    assert.equal(e[CODE.ITC_CGST]?.cr ?? 0, 0, 'no credit was ever claimed to give back');
    assert.equal(e[CODE.PURCHASES].cr, 118_000, 'the whole cost including tax reverses');
  });
});

test('a vendor credit applied to a bill settles it', async () => {
  await withFixture(async ({ trx, orgId, branchId, vendorId, itemId }) => {
    const bill = await createBill(trx, orgId, null, {
      branchId, vendorId, vendorInvoiceNo: 'V-101',
      date: '2026-08-01', dueDate: '2026-09-01',
      lines: [{ itemId, qty: 1, ratePaise: 100_000 }],
    });

    await createVendorCredit(trx, orgId, null, {
      branchId, vendorId, date: '2026-08-07', reason: 'Whole lot returned',
      againstBillId: bill.id, amountPaise: 100_000, gstRatePct: 18,
    });

    const row = await trx.selectFrom('bills').select(['status', 'total', 'amount_paid'])
      .where('id', '=', bill.id).executeTakeFirstOrThrow();
    assert.equal(row.status, 'paid');
    assert.equal(toPaiseFromSql(row.amount_paid), toPaiseFromSql(row.total));
  });
});

test('a refund on a vendor credit brings cash back in', async () => {
  await withFixture(async ({ trx, orgId, branchId, vendorId, bankId }) => {
    const vc = await createVendorCredit(trx, orgId, null, {
      branchId, vendorId, date: '2026-08-07', reason: 'Cash back requested',
      amountPaise: 100_000, gstRatePct: 18,
    });

    const refund = await refundVendorCredit(trx, orgId, null, vc.id, {
      bankAccountId: bankId, date: '2026-08-08',
    });
    assert.equal(refund.refundedPaise, 118_000);

    const e = await entryByCode(trx, refund.journalEntryId);
    assert.equal(e[CODE.BANK_DEFAULT].dr, 118_000, 'the money comes in');
    assert.equal(e[CODE.AP].cr, 118_000, 'and we no longer hold a credit');
  });
});

test('voiding a vendor credit gives the bill its balance back', async () => {
  await withFixture(async ({ trx, orgId, branchId, vendorId, itemId }) => {
    const bill = await createBill(trx, orgId, null, {
      branchId, vendorId, vendorInvoiceNo: 'V-102',
      date: '2026-08-01', dueDate: '2026-09-01',
      lines: [{ itemId, qty: 1, ratePaise: 100_000 }],
    });
    const vc = await createVendorCredit(trx, orgId, null, {
      branchId, vendorId, date: '2026-08-07', reason: 'Raised in error',
      againstBillId: bill.id, amountPaise: 100_000, gstRatePct: 18,
    });

    await voidVendorCredit(trx, orgId, null, vc.id, 'Wrong vendor');

    const row = await trx.selectFrom('bills').select(['amount_paid'])
      .where('id', '=', bill.id).executeTakeFirstOrThrow();
    assert.equal(toPaiseFromSql(row.amount_paid), 0);

    const check = await verifyLedgerBalances(trx, orgId);
    assert.ok(check.balanced);
  });
});

test.after(async () => {
  await db.destroy();
});
