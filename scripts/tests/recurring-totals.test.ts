// Zoho's New Recurring Invoice, the parts recorded on 2026-11-24 (migration
// 126): the Entity type (Invoice / Bill Of Supply), the totals' Shipping
// Charges and adjustment, and the Rounding Off Preference — on the profile,
// on its record and on every invoice it raises. Against real MySQL inside
// rolled-back transactions.
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/recurring-totals.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { verifyLedgerBalances } from '../../lib/server/ledger/posting';
import { runRecurringInvoice } from '../../lib/server/services/recurring';
import { createProfile, profileAmount, profileDetail, updateProfile, type ProfileInput } from '../../lib/server/services/recurring-profiles';
import { toPaiseFromSql } from '../../lib/server/money-sql';

interface Fixture { trx: Trx; orgId: number; branchId: number; customerId: number; acc: Record<string, number> }

async function withFixture(fn: (f: Fixture) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Recurring Totals Test Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1, gstin: '33AAACR4849R1ZK' }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const acc = await accountIds(trx, orgId);
      const customerId = Number((await trx.insertInto('contacts').values({
        org_id: orgId, kind: 'customer', display_name: 'Bonita', gst_treatment: 'registered', state_code: '33', pan: 'AAAAA1111A', gstin: '33AAAAA1111A1Z5',
      }).executeTakeFirstOrThrow()).insertId);
      await fn({ trx, orgId, branchId, customerId, acc });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}
test.after(() => db.destroy());

/** ₹1,000.33 at 18% inside the state: ₹1,180.39 before shipping, so a total with paise. */
const profile = (f: Fixture, extra: Partial<ProfileInput> = {}): ProfileInput => ({
  branchId: f.branchId, customerId: f.customerId, name: 'AMC – Bonita', frequency: 'monthly', every: 1, startDate: '2026-11-02',
  paymentTerms: 'net_15', lines: [{ itemId: null, description: 'Annual maintenance', qty: 1, ratePaise: 100_033, gstRatePct: 18, hsnSac: '998713' }], ...extra,
});

async function balance(trx: Trx, orgId: number, accountId: number): Promise<number> {
  const { rows } = await sql<{ v: string }>`SELECT COALESCE(SUM(debit - credit), 0) AS v FROM journal_lines WHERE org_id = ${orgId} AND account_id = ${accountId}`.execute(trx);
  return toPaiseFromSql(rows[0].v);
}

test('profileAmount: discounts, tax, shipping, a negative adjustment, and either rounding', () => {
  const lines = [{ itemId: null, description: 'A', qty: 2, ratePaise: 50_000, gstRatePct: 18, hsnSac: null, discountPct: 10 }];
  const none = profileAmount({ lines, entityType: 'invoice', shippingPaise: 15_050, adjustmentPaise: -2_025, roundOff: 'none' });
  assert.deepEqual(none, { subTotalPaise: 90_000, taxPaise: 16_200, roundOffPaise: 0, totalPaise: 119_225 });
  const whole = profileAmount({ lines, entityType: 'invoice', shippingPaise: 15_050, adjustmentPaise: -2_025, roundOff: 'whole' });
  assert.deepEqual(whole, { subTotalPaise: 90_000, taxPaise: 16_200, roundOffPaise: -25, totalPaise: 119_200 });
  const bos = profileAmount({ lines: [{ ...lines[0], gstRatePct: 0 }], entityType: 'bill_of_supply', shippingPaise: 0, adjustmentPaise: 0, roundOff: 'none' });
  assert.equal(bos.taxPaise, 0);
  assert.equal(bos.totalPaise, 90_000);
});

test('a new profile starts on "No Rounding"; its invoice keeps the paise and carries shipping and the adjustment', async () => {
  await withFixture(async (f) => {
    const id = await createProfile(f.trx, f.orgId, profile(f, { shippingChargePaise: 25_000, adjustmentPaise: -1_000, adjustmentLabel: 'Loyalty discount' }));
    const row = await f.trx.selectFrom('recurring_invoices').select(['round_off', 'entity_type', 'shipping_charge', 'adjustment', 'adjustment_label']).where('id', '=', id).executeTakeFirstOrThrow();
    assert.equal(row.round_off, 'none', 'Zoho\'s new form says (No Rounding)');
    assert.equal(row.entity_type, 'invoice');
    assert.equal(toPaiseFromSql(row.shipping_charge), 25_000);
    assert.equal(toPaiseFromSql(row.adjustment), -1_000);
    assert.equal(row.adjustment_label, 'Loyalty discount');

    const d = await profileDetail(f.trx, f.orgId, id, '2026-11-02');
    // 1,000.33 + 18% (180.06) + 250.00 − 10.00 = 1,420.39, not rounded.
    assert.equal(d.amountPaise, 142_039);
    assert.equal(d.roundOffPaise, 0);
    assert.equal(d.adjustmentLabel, 'Loyalty discount');

    const r = await runRecurringInvoice(f.trx, f.orgId, null, id);
    const inv = await f.trx.selectFrom('invoices').select(['total', 'round_off', 'shipping_charge', 'adjustment', 'adjustment_label', 'bill_of_supply'])
      .where('id', '=', Number(r.invoice.id)).executeTakeFirstOrThrow();
    assert.equal(toPaiseFromSql(inv.total), 142_039, 'the paise stay: No Rounding');
    assert.equal(toPaiseFromSql(inv.round_off), 0);
    assert.equal(toPaiseFromSql(inv.shipping_charge), 25_000);
    assert.equal(toPaiseFromSql(inv.adjustment), -1_000);
    assert.equal(inv.adjustment_label, 'Loyalty discount');
    assert.equal(inv.bill_of_supply, 0);
    // Posted as any invoice posts them: receivable for the whole total, shipping to Shipping Income.
    assert.equal(await balance(f.trx, f.orgId, f.acc[CODE.AR]), 142_039);
    await verifyLedgerBalances(f.trx, f.orgId);
  });
});

test('"Round off the total to the nearest whole number" rounds every invoice it raises, as the record says', async () => {
  await withFixture(async (f) => {
    const id = await createProfile(f.trx, f.orgId, profile(f, { roundOff: 'whole' }));
    const d = await profileDetail(f.trx, f.orgId, id, '2026-11-02');
    // 1,180.39 rounds to 1,180.00: −0.39.
    assert.equal(d.amountPaise, 118_000);
    assert.equal(d.roundOffPaise, -39);
    const r = await runRecurringInvoice(f.trx, f.orgId, null, id);
    const inv = await f.trx.selectFrom('invoices').select(['total', 'round_off']).where('id', '=', Number(r.invoice.id)).executeTakeFirstOrThrow();
    assert.equal(toPaiseFromSql(inv.total), 118_000);
    assert.equal(toPaiseFromSql(inv.round_off), -39);
    await verifyLedgerBalances(f.trx, f.orgId);
  });
});

test('a Bill Of Supply profile raises bills of supply; a taxable line is refused, as on the invoice', async () => {
  await withFixture(async (f) => {
    await assert.rejects(
      createProfile(f.trx, f.orgId, profile(f, { entityType: 'bill_of_supply' })),
      /A bill of supply carries no tax: every line must be exempt, nil-rated or non-GST/,
    );
    const id = await createProfile(f.trx, f.orgId, profile(f, {
      entityType: 'bill_of_supply', roundOff: 'whole',
      lines: [{ itemId: null, description: 'Fresh vegetables', qty: 3, ratePaise: 12_525, gstRatePct: 0, hsnSac: '0702' }],
    }));
    const d = await profileDetail(f.trx, f.orgId, id, '2026-11-02');
    assert.equal(d.entityType, 'bill_of_supply');
    assert.equal(d.taxPaise, 0);
    assert.equal(d.amountPaise, 37_600, '375.75 rounds to 376.00');
    const r = await runRecurringInvoice(f.trx, f.orgId, null, id);
    const inv = await f.trx.selectFrom('invoices').select(['bill_of_supply', 'total', 'cgst', 'sgst', 'igst']).where('id', '=', Number(r.invoice.id)).executeTakeFirstOrThrow();
    assert.equal(inv.bill_of_supply, 1);
    assert.equal(toPaiseFromSql(inv.total), 37_600);
    assert.equal(toPaiseFromSql(inv.cgst) + toPaiseFromSql(inv.sgst) + toPaiseFromSql(inv.igst), 0);
  });
});

test('Edit changes the totals from the next invoice; an edit that does not say keeps the rounding', async () => {
  await withFixture(async (f) => {
    const id = await createProfile(f.trx, f.orgId, profile(f, { roundOff: 'whole' }));
    const first = await runRecurringInvoice(f.trx, f.orgId, null, id);
    await updateProfile(f.trx, f.orgId, id, profile(f, { shippingChargePaise: 5_000, roundOff: undefined }));
    const row = await f.trx.selectFrom('recurring_invoices').select(['round_off', 'shipping_charge']).where('id', '=', id).executeTakeFirstOrThrow();
    assert.equal(row.round_off, 'whole', 'not said, so kept');
    assert.equal(toPaiseFromSql(row.shipping_charge), 5_000);
    const second = await runRecurringInvoice(f.trx, f.orgId, null, id);
    const a = await f.trx.selectFrom('invoices').select(['total', 'shipping_charge']).where('id', '=', Number(first.invoice.id)).executeTakeFirstOrThrow();
    const b = await f.trx.selectFrom('invoices').select(['total', 'shipping_charge']).where('id', '=', Number(second.invoice.id)).executeTakeFirstOrThrow();
    assert.equal(toPaiseFromSql(a.shipping_charge), 0, 'the first invoice is not changed');
    assert.equal(toPaiseFromSql(b.shipping_charge), 5_000);
    assert.equal(toPaiseFromSql(b.total), 123_000, '1,180.39 + 50.00 = 1,230.39, rounded to 1,230.00');
    await assert.rejects(updateProfile(f.trx, f.orgId, id, profile(f, { shippingChargePaise: -1 })), /Shipping charges cannot be below zero/);
  });
});
