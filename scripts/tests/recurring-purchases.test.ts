// Recurring bills and expenses, run by hand and by the scheduler, and mileage.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/recurring-purchases.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { runRecurringPurchase } from '../../lib/server/services/recurring';
import { runScheduledPostings } from '../../lib/server/services/scheduler';
import { createExpense } from '../../lib/server/services/purchases';

interface Book { trx: Trx; orgId: number; branchId: number; landlord: number; bankId: number; rent: number; internet: number; travel: number }

async function withBook(fn: (b: Book) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Rent Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1, gstin: '33AABCE4444E1Z1' }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const acc = await accountIds(trx, orgId);
      const landlord = Number((await trx.insertInto('contacts').values({ org_id: orgId, kind: 'vendor', display_name: 'Landlord', state_code: '33', gst_treatment: 'registered', gstin: '33AAACL1111L1Z1', pan: 'AAACL1111L' } as never).executeTakeFirstOrThrow()).insertId);
      const bankId = Number((await trx.insertInto('bank_accounts').values({ org_id: orgId, kind: 'bank', name: 'Current', ledger_account_id: acc[CODE.BANK_DEFAULT], opening_balance: '0.0000' }).executeTakeFirstOrThrow()).insertId);
      await fn({ trx, orgId, branchId, landlord, bankId, rent: acc[CODE.RENT], internet: acc[CODE.INTERNET], travel: acc[CODE.FUEL] });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

const profile = (b: Book, values: Record<string, unknown>) => b.trx.insertInto('recurring_purchases').values({
  org_id: b.orgId, branch_id: b.branchId, frequency: 'monthly', start_date: '2026-08-01', next_run: '2026-08-01', ...values,
} as never).executeTakeFirstOrThrow().then((r) => Number(r.insertId));

test('a recurring bill raises a bill with a placeholder number, and moves to next month', async () => {
  await withBook(async (b) => {
    const id = await profile(b, {
      kind: 'bill', profile_name: 'Office rent', vendor_id: b.landlord, due_days: 10,
      template: JSON.stringify([{ itemId: null, accountId: b.rent, description: 'Rent', qty: 1, ratePaise: 50_000_00, gstRatePct: 18, hsnSac: '997212' }]),
    });
    const r = await runRecurringPurchase(b.trx, b.orgId, null, id);
    assert.equal(r.made.kind, 'bill');
    const bill = await b.trx.selectFrom('bills').select(['vendor_invoice_no', 'bill_date', 'due_date', 'recurring_id', 'subtotal', 'status'])
      .where('id', '=', r.made.id).executeTakeFirstOrThrow();
    assert.equal(bill.vendor_invoice_no, `RB${id}/260801`);
    assert.equal(String(bill.bill_date).slice(0, 10), '2026-08-01');
    assert.equal(String(bill.due_date).slice(0, 10), '2026-08-11');
    assert.equal(bill.recurring_id, id);
    assert.equal(Number(bill.subtotal), 50_000);
    const next = await b.trx.selectFrom('recurring_purchases').select(['next_run', 'last_generated_at']).where('id', '=', id).executeTakeFirstOrThrow();
    assert.equal(String(next.next_run).slice(0, 10), '2026-09-01');
    assert.equal(String(next.last_generated_at).slice(0, 10), '2026-08-01');

    await b.trx.updateTable('recurring_purchases').set({ is_active: 0 }).where('id', '=', id).execute();
    await assert.rejects(runRecurringPurchase(b.trx, b.orgId, null, id), /paused/);
  });
});

test('a recurring expense is recorded as paid; the scheduler runs what is due and leaves what fell behind', async () => {
  await withBook(async (b) => {
    const due = await profile(b, {
      kind: 'expense', profile_name: 'Internet', paid_through_bank_account_id: b.bankId, auto_run: 1, next_run: '2026-10-05', start_date: '2026-10-05',
      template: JSON.stringify({ accountId: b.internet, amountPaise: 1_180_00, gstRatePct: 18, itcEligibility: 'eligible', notes: 'Fibre, October' }),
    });
    const behind = await profile(b, {
      kind: 'expense', profile_name: 'Old', paid_through_bank_account_id: b.bankId, auto_run: 1, next_run: '2026-07-05',
      template: JSON.stringify({ accountId: b.internet, amountPaise: 100_00, gstRatePct: 0, itcEligibility: 'eligible', notes: null }),
    });
    const sweep = await runScheduledPostings({ trx: b.trx, orgId: b.orgId, now: new Date('2026-10-05T06:00:00Z') });
    assert.equal(sweep.posted, 1);
    assert.equal(sweep.behind, 1);
    const exp = await b.trx.selectFrom('expenses').select(['total', 'cgst', 'sgst', 'recurring_id', 'notes']).where('recurring_id', '=', due).executeTakeFirstOrThrow();
    assert.deepEqual([Number(exp.total), Number(exp.cgst) + Number(exp.sgst), exp.notes], [1_180, 180, 'Fibre, October']);
    const old = await b.trx.selectFrom('recurring_purchases').select(['last_error', 'next_run']).where('id', '=', behind).executeTakeFirstOrThrow();
    assert.match(old.last_error ?? '', /Missed the run due 2026-07-05/);
    assert.equal(String(old.next_run).slice(0, 10), '2026-07-05', 'left where it was, for a person');
  });
});

test('mileage: the distance times the rate, with no GST in it', async () => {
  await withBook(async (b) => {
    const r = await createExpense(b.trx, b.orgId, null, {
      branchId: b.branchId, date: '2026-10-10', accountId: b.travel, paidThroughBankAccountId: b.bankId,
      amountPaise: 999_00, gstRatePct: 18, mileage: { km: 142.5, ratePaise: 12_00 }, notes: 'Chennai to Vellore',
    });
    assert.equal(r.totalPaise, 1_710_00, '142.5 km at ₹12, whatever amount was sent');
    const row = await b.trx.selectFrom('expenses').select(['total', 'cgst', 'sgst', 'gst_rate_pct', 'mileage_km', 'mileage_rate']).where('id', '=', r.id).executeTakeFirstOrThrow();
    assert.deepEqual([Number(row.total), Number(row.cgst) + Number(row.sgst), Number(row.gst_rate_pct), Number(row.mileage_km), Number(row.mileage_rate)], [1_710, 0, 0, 142.5, 12]);
    await assert.rejects(createExpense(b.trx, b.orgId, null, {
      branchId: b.branchId, date: '2026-10-10', accountId: b.travel, paidThroughBankAccountId: b.bankId, amountPaise: 0, mileage: { km: 0, ratePaise: 12_00 },
    }), /distance in kilometres/);
  });
});

test.after(() => db.destroy());
