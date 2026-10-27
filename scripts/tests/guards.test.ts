// The book's own policies, applied as documents are saved: credit limits,
// negative stock, and cash over the limits of sections 269ST and 40A(3); and
// the reason every cancellation has to give.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/guards.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { createInvoice, voidInvoice } from '../../lib/server/services/sales';
import { makePayment, receivePayment, voidPayment } from '../../lib/server/services/payments';
import { createExpense } from '../../lib/server/services/purchases';
import { DEFAULT_POLICIES, getPolicies, setPolicies, type OrgPolicies } from '../../lib/server/services/org-settings';

interface Fixture {
  trx: Trx; orgId: number; branchId: number; acc: Record<string, number>; cashId: number;
  customer: number; vendor: number; transporter: number; itemId: number; serviceId: number;
}

async function withFixture(fn: (f: Fixture) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Guards Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1 }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const acc = await accountIds(trx, orgId);
      await trx.insertInto('hsn_codes').values([
        { org_id: orgId, code: '8708', kind: 'hsn', description: 'Parts', gst_rate_pct: 18, is_active: 1 },
        { org_id: orgId, code: '998714', kind: 'sac', description: 'Repairs', gst_rate_pct: 18, is_active: 1 },
      ]).execute();
      const mk = async (values: Record<string, unknown>) =>
        Number((await trx.insertInto('contacts').values({ org_id: orgId, state_code: '33', gst_treatment: 'unregistered', ...values } as never).executeTakeFirstOrThrow()).insertId);
      const item = async (values: Record<string, unknown>) => Number((await trx.insertInto('items').values({
        org_id: orgId, uqc: 'NOS', sale_price: '1000.0000', purchase_price: '600.0000', gst_rate_pct: 18, ...values,
      } as never).executeTakeFirstOrThrow()).insertId);
      await fn({
        trx, orgId, branchId, acc,
        cashId: Number((await trx.insertInto('bank_accounts').values({
          org_id: orgId, kind: 'cash', name: 'Cash', ledger_account_id: acc[CODE.CASH], opening_balance: '0.0000',
        }).executeTakeFirstOrThrow()).insertId),
        customer: await mk({ kind: 'customer', display_name: 'Limited Buyer', credit_limit: '1000.0000' }),
        vendor: await mk({ kind: 'vendor', display_name: 'Supplier' }),
        transporter: await mk({ kind: 'vendor', display_name: 'Lorry Co', tds_section: '194C' }),
        itemId: await item({ kind: 'goods', name: 'Disc', hsn_sac: '8708', track_inventory: 1 }),
        serviceId: await item({ kind: 'service', name: 'Fitting', hsn_sac: '998714', uqc: 'OTH', track_inventory: 0 }),
      });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

const policy = (f: Fixture, patch: Partial<OrgPolicies>) => setPolicies(f.trx, f.orgId, null, patch);
const sell = (f: Fixture, itemId: number, opts: { overrideLimits?: boolean; status?: 'draft' | 'approved' } = {}) =>
  createInvoice(f.trx, f.orgId, null, {
    branchId: f.branchId, customerId: f.customer, date: '2026-08-01', dueDate: '2026-08-31', status: opts.status ?? 'approved',
    overrideLimits: opts.overrideLimits,
    lines: [{ itemId, description: 'Sale', hsnSac: itemId === f.itemId ? '8708' : '998714', qty: 1, ratePaise: 1_000_00, gstRatePct: 18 }],
  });
const refused = (p: Promise<unknown>, re: RegExp) => assert.rejects(p, (e: Error & { status?: number }) => {
  assert.match(e.message, re);
  return true;
});

test('policies start safe, save one key at a time, and keep the rest', async () => {
  await withFixture(async (f) => {
    assert.deepEqual(await getPolicies(f.trx, f.orgId), DEFAULT_POLICIES);
    await policy(f, { creditLimit: 'block', features: { inventory: false } as OrgPolicies['features'] });
    const p = await getPolicies(f.trx, f.orgId);
    assert.equal(p.creditLimit, 'block');
    assert.equal(p.negativeStock, 'warn', 'untouched keys keep their default');
    assert.equal(p.features.inventory, false);
    assert.equal(p.features.fixedAssets, true, 'switching one part off leaves the others on');
    await assert.rejects(policy(f, { sessionIdleMinutes: 5000 }), /between 0/);
  });
});

test('credit limit: warn saves and says so, block refuses, an override lets it through', async () => {
  await withFixture(async (f) => {
    // ₹1,000 + 18% is ₹1,180, past the ₹1,000 limit.
    const warned = await sell(f, f.serviceId);
    assert.equal(warned.warnings?.length, 1);
    assert.match(warned.warnings![0], /credit limit of ₹1,000/);

    await policy(f, { creditLimit: 'block' });
    await refused(sell(f, f.serviceId), /owes ₹1,180; with this invoice that is ₹2,360/);
    const draft = await sell(f, f.serviceId, { status: 'draft' });
    assert.deepEqual(draft.warnings, [], 'a draft is not a sale yet');
    const forced = await sell(f, f.serviceId, { overrideLimits: true });
    assert.ok(forced.journalEntryId, 'the override saves and posts');
    assert.equal(forced.warnings?.length, 1, 'and still says what it passed');

    await policy(f, { creditLimit: 'off' });
    assert.deepEqual((await sell(f, f.serviceId)).warnings, []);
  });
});

test('negative stock: goods not on hand are flagged or refused; services are never counted', async () => {
  await withFixture(async (f) => {
    await policy(f, { creditLimit: 'off' });
    const warned = await sell(f, f.itemId);
    assert.deepEqual(warned.warnings, ['Not enough stock — Disc: 0 in stock, 1 going out.']);
    assert.deepEqual((await sell(f, f.serviceId)).warnings, []);

    await policy(f, { negativeStock: 'block' });
    await refused(sell(f, f.itemId), /Not enough stock/);
  });
});

test('section 269ST: cash of ₹2 lakh or more from one person in a day, added up across receipts', async () => {
  await withFixture(async (f) => {
    const receive = (amountPaise: number, date = '2026-08-05') => receivePayment(f.trx, f.orgId, null, {
      branchId: f.branchId, contactId: f.customer, date, mode: 'cash', amountPaise, bankAccountId: f.cashId,
    });
    assert.deepEqual((await receive(1_50_000_00)).warnings, []);
    assert.deepEqual((await receive(49_999_00, '2026-08-06')).warnings, [], 'another day starts again');
    const second = await receive(50_000_00);
    assert.match(second.warnings![0], /₹2,00,000 received in cash .* section 269ST/i);

    await policy(f, { cashLimits: 'block' });
    await refused(receive(10_00), /269ST/);
  });
});

test('section 40A(3): cash paid above ₹10,000 a day, ₹35,000 to a transporter, expenses included', async () => {
  await withFixture(async (f) => {
    const pay = (contactId: number, amountPaise: number) => makePayment(f.trx, f.orgId, null, {
      branchId: f.branchId, contactId, date: '2026-08-05', mode: 'cash', amountPaise, bankAccountId: f.cashId,
    });
    assert.deepEqual((await pay(f.vendor, 10_000_00)).warnings, [], '₹10,000 itself is allowed');
    assert.match((await pay(f.vendor, 1_00)).warnings![0], /₹10,001 paid in cash .* 40A\(3\)/);

    assert.deepEqual((await pay(f.transporter, 30_000_00)).warnings, []);
    assert.match((await pay(f.transporter, 6_000_00)).warnings![0], /above ₹35,000/i);

    const expense = await createExpense(f.trx, f.orgId, null, {
      branchId: f.branchId, date: '2026-08-07', accountId: f.acc[CODE.RENT],
      paidThroughBankAccountId: f.cashId, amountPaise: 12_000_00,
    });
    assert.match(expense.warnings![0], /₹12,000 paid in cash/);

    await policy(f, { cashLimits: 'off' });
    assert.deepEqual((await pay(f.vendor, 50_000_00)).warnings, []);
  });
});

test('a cancellation needs a reason, and the document keeps it', async () => {
  await withFixture(async (f) => {
    await policy(f, { creditLimit: 'off' });
    const inv = await sell(f, f.serviceId);
    await assert.rejects(voidInvoice(f.trx, f.orgId, null, inv.id), /Give a reason/);
    await assert.rejects(voidInvoice(f.trx, f.orgId, null, inv.id, '  x '), /Give a reason/, 'a token reason is not one');
    await voidInvoice(f.trx, f.orgId, null, inv.id, 'Raised to the wrong customer');
    const row = await f.trx.selectFrom('invoices').select(['status', 'void_reason', 'voided_at']).where('id', '=', inv.id).executeTakeFirstOrThrow();
    assert.equal(row.status, 'void');
    assert.equal(row.void_reason, 'Raised to the wrong customer');
    assert.ok(row.voided_at);
    const memo = await f.trx.selectFrom('journal_entries').select('memo').where('org_id', '=', f.orgId)
      .where('memo', 'like', 'Void of invoice%').executeTakeFirstOrThrow();
    assert.match(memo.memo ?? '', /Raised to the wrong customer/);

    const rcpt = await receivePayment(f.trx, f.orgId, null, {
      branchId: f.branchId, contactId: f.customer, date: '2026-08-05', mode: 'cash', amountPaise: 100_00, bankAccountId: f.cashId,
    });
    await assert.rejects(voidPayment(f.trx, f.orgId, null, rcpt.id, ''), /Give a reason/);
    await voidPayment(f.trx, f.orgId, null, rcpt.id, 'Entered twice');
    const p = await f.trx.selectFrom('payments').select(['void_reason']).where('id', '=', rcpt.id).executeTakeFirstOrThrow();
    assert.equal(p.void_reason, 'Entered twice');
  });
});

test.after(async () => {
  await db.destroy();
});
