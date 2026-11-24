// What Zoho Books has on Retainer (Service) Invoices and Recurring Invoices that
// the first copies left out (migration 125): a retainer's ⋯ → Refund, and a
// recurring profile's Select Price List, Associate Project(s) Hours,
// Associate Payment Options and per-line discounts
// (services/retainers.ts, recurring.ts, recurring-profiles.ts).
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/sales-extras.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { verifyLedgerBalances } from '../../lib/server/ledger/posting';
import { createRetainerZoho, deleteRetainer, deleteRetainerRefund, refundRetainer, retainerDetail, updateRetainer } from '../../lib/server/services/retainers';
import { applyRetainer } from '../../lib/server/services/sales-documents';
import { createInvoice } from '../../lib/server/services/sales';
import { receivePayment } from '../../lib/server/services/payments';
import { runRecurringInvoice } from '../../lib/server/services/recurring';
import { createProfile, profileDetail, type ProfileInput } from '../../lib/server/services/recurring-profiles';
import { logTime, saveProject } from '../../lib/server/services/projects';
import { savePriceList } from '../../lib/server/services/price-lists';
import { saveGateway, setPaymentLinkApi } from '../../lib/server/services/payment-links';
import { listRate } from '../../lib/price-list-rate';
import { toPaiseFromSql } from '../../lib/server/money-sql';

const savedKey = process.env.INTEGRATION_KEY;
test.after(async () => {
  setPaymentLinkApi(null);
  if (savedKey === undefined) delete process.env.INTEGRATION_KEY; else process.env.INTEGRATION_KEY = savedKey;
  await db.destroy();
});

interface Fixture { trx: Trx; orgId: number; branchId: number; customerId: number; otherCustomerId: number; bankId: number; userId: number; acc: Record<string, number> }

async function withFixture(fn: (f: Fixture) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Sales Extras Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1, gstin: '33AAACR4849R1ZK' }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const acc = await accountIds(trx, orgId);
      const mk = async (name: string) => Number((await trx.insertInto('contacts').values({
        org_id: orgId, kind: 'customer', display_name: name, gst_treatment: 'registered', state_code: '33',
      } as never).executeTakeFirstOrThrow()).insertId);
      const customerId = await mk('Bonita');
      const otherCustomerId = await mk('Marina');
      const bankId = Number((await trx.insertInto('bank_accounts').values({
        org_id: orgId, kind: 'bank', name: 'ICICI', ledger_account_id: acc[CODE.BANK_DEFAULT], opening_balance: '0.0000',
      }).executeTakeFirstOrThrow()).insertId);
      const userId = Number((await trx.insertInto('users').values({ org_id: orgId, email: `u-${orgId}@sales-extras.example`, name: 'Asha', role: 'admin', password_hash: 'x' } as never).executeTakeFirstOrThrow()).insertId);
      await fn({ trx, orgId, branchId, customerId, otherCustomerId, bankId, userId, acc: acc as unknown as Record<string, number> });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}
async function balance(trx: Trx, orgId: number, accountId: number): Promise<number> {
  const { rows } = await sql<{ v: string }>`SELECT COALESCE(SUM(debit - credit), 0) AS v FROM journal_lines WHERE org_id = ${orgId} AND account_id = ${accountId}`.execute(trx);
  return toPaiseFromSql(rows[0].v);
}

test('a retainer refunds only what was paid and not applied; the refund reverses unearned revenue against the bank', async () => {
  await withFixture(async (f) => {
    const { trx, orgId, acc } = f;
    const r = await createRetainerZoho(trx, orgId, null, { branchId: f.branchId, customerId: f.customerId, date: '2026-11-01', lines: [{ description: 'Advance', amountPaise: 500_000 }] });
    await assert.rejects(refundRetainer(trx, orgId, null, r.id, { date: '2026-11-05', bankAccountId: f.bankId }), /nothing to refund/, 'unpaid: nothing to give back');
    await receivePayment(trx, orgId, null, {
      branchId: f.branchId, contactId: f.customerId, date: '2026-11-02', mode: 'neft', amountPaise: 500_000, bankAccountId: f.bankId,
      allocations: [{ targetType: 'retainer', targetId: r.id, amountPaise: 500_000 }],
    });
    const inv = await createInvoice(trx, orgId, null, { branchId: f.branchId, customerId: f.customerId, date: '2026-11-03', dueDate: '2026-11-30', status: 'approved', lines: [{ itemId: null, description: 'Work', qty: 1, ratePaise: 200_000, gstRatePct: 0 }] } as never);
    await applyRetainer(trx, orgId, null, r.id, Number(inv.id), 200_000);
    await assert.rejects(refundRetainer(trx, orgId, null, r.id, { date: '2026-11-05', amountPaise: 400_000, bankAccountId: f.bankId }), /Only 3000\.00/, '₹3,000 paid and not applied');
    await assert.rejects(refundRetainer(trx, orgId, null, r.id, { date: '2026-10-30', bankAccountId: f.bankId }), /before the retainer invoice/);
    const bankBefore = await balance(trx, orgId, acc[CODE.BANK_DEFAULT]);
    const unearnedBefore = await balance(trx, orgId, acc[CODE.UNEARNED]);
    const done = await refundRetainer(trx, orgId, null, r.id, { date: '2026-11-06', amountPaise: 100_000, bankAccountId: f.bankId, mode: 'neft', reference: 'UTR55' });
    assert.deepEqual([done.refundedPaise, done.unappliedPaise], [100_000, 200_000]);
    assert.equal(await balance(trx, orgId, acc[CODE.BANK_DEFAULT]), bankBefore - 100_000, 'the money left the bank');
    assert.equal(await balance(trx, orgId, acc[CODE.UNEARNED]), unearnedBefore + 100_000, 'we hold that much less');
    const d = await retainerDetail(trx, orgId, r.id);
    assert.deepEqual([d.refundedPaise, d.unappliedPaise, d.refunds.length, d.refunds[0].amountPaise], [100_000, 200_000, 1, 100_000]);
    // What was refunded cannot be applied as well.
    const inv2 = await createInvoice(trx, orgId, null, { branchId: f.branchId, customerId: f.customerId, date: '2026-11-07', dueDate: '2026-11-30', status: 'approved', lines: [{ itemId: null, description: 'More work', qty: 1, ratePaise: 900_000, gstRatePct: 0 }] } as never);
    await assert.rejects(applyRetainer(trx, orgId, null, r.id, Number(inv2.id), 250_000), /Only 2000\.00/);
    // Paid: no Edit or Delete, as before.
    await assert.rejects(updateRetainer(trx, orgId, null, r.id, { branchId: f.branchId, customerId: f.customerId, date: '2026-11-01', lines: [{ description: 'X', amountPaise: 1 }] }), /paid or applied/);
    await assert.rejects(deleteRetainer(trx, orgId, null, r.id), /paid or applied/);
    // Deleting the refund reverses it.
    const back = await deleteRetainerRefund(trx, orgId, null, r.id, Number(d.refunds[0].entryId));
    assert.equal(back.unappliedPaise, 300_000);
    assert.equal(await balance(trx, orgId, acc[CODE.BANK_DEFAULT]), bankBefore, 'reversed');
    assert.equal((await retainerDetail(trx, orgId, r.id)).refunds.length, 0);
    await assert.rejects(deleteRetainerRefund(trx, orgId, null, r.id, Number(d.refunds[0].entryId)), /already deleted/);
    assert.equal((await verifyLedgerBalances(trx, orgId)).balanced, true);
  });
});

test('a price list prices an item as the server does: a percentage, a named rate, the best discount rule', () => {
  const pct = { id: '1', name: 'Dealers', basis: 'percent' as const, percent: -10, isActive: true, items: [], discounts: [{ itemId: null, minQty: 10, discountPct: 5 }] };
  assert.deepEqual(listRate(pct, '7', 100_000, 1), { ratePaise: 90_000, discountPct: 0 });
  assert.deepEqual(listRate(pct, '7', 100_000, 12), { ratePaise: 90_000, discountPct: 5 });
  const per = { id: '2', name: 'Fleet', basis: 'per_item' as const, percent: 0, isActive: true, items: [{ itemId: '7', ratePaise: 80_000 }], discounts: [{ itemId: '7', minQty: 0, discountPct: 2 }, { itemId: '7', minQty: 5, discountPct: 4 }] };
  assert.deepEqual(listRate(per, '7', 100_000, 6), { ratePaise: 80_000, discountPct: 4 });
  assert.deepEqual(listRate(per, '8', 55_000, 1), { ratePaise: 55_000, discountPct: 0 }, 'an item the list does not name keeps its own price');
});

const profile = (f: Fixture, extra: Partial<ProfileInput> = {}): ProfileInput => ({
  branchId: f.branchId, customerId: f.customerId, name: 'AMC – Bonita', frequency: 'monthly', every: 1, startDate: '2026-11-02', paymentTerms: 'net_15',
  lines: [{ itemId: null, description: 'Annual maintenance', qty: 2, ratePaise: 100_000, gstRatePct: 18, hsnSac: '998713', discountPct: 10 }], ...extra,
});

test('a recurring profile keeps its price list, its projects and its payment option; each line keeps its own discount', async () => {
  await withFixture(async (f) => {
    const listId = await savePriceList(f.trx, f.orgId, { name: 'Dealers', basis: 'percent', percent: -10 });
    const pid = await saveProject(f.trx, f.orgId, null, { customerId: f.customerId, name: 'Website', billingMethod: 'project_hours', ratePaise: 150_000, sacCode: '998314', gstRatePct: 18 });
    const other = await saveProject(f.trx, f.orgId, null, { customerId: f.otherCustomerId, name: 'Marina app', billingMethod: 'project_hours', ratePaise: 150_000 });
    await assert.rejects(createProfile(f.trx, f.orgId, profile(f, { projectIds: [other] })), /another customer's project/);
    await assert.rejects(createProfile(f.trx, f.orgId, profile(f, { priceListId: 999_999 })), /price list does not exist/);
    await assert.rejects(createProfile(f.trx, f.orgId, profile(f, { lines: [{ itemId: null, description: 'x', qty: 1, ratePaise: 1, gstRatePct: 0, hsnSac: null, discountPct: 120 }] })), /0% to 100%/);
    const id = await createProfile(f.trx, f.orgId, profile(f, { priceListId: listId, projectIds: [pid], paymentLink: true }));
    const d = await profileDetail(f.trx, f.orgId, id, '2026-11-02');
    assert.deepEqual([d.priceListName, d.projects.map((x) => x.name), d.paymentLink, d.lines[0].discountPct], ['Dealers', ['Website'], true, 10]);
    assert.equal(d.amountPaise, 212_400, '2 × ₹1,000 less 10%, plus 18%');

    // Two hours on the project before the run, one after.
    await logTime(f.trx, f.orgId, null, { projectId: pid, userId: f.userId, date: '2026-10-30', minutes: 120, billable: true });
    await logTime(f.trx, f.orgId, null, { projectId: pid, userId: f.userId, date: '2026-11-10', minutes: 60, billable: true });
    // No gateway connected: the invoice is raised, and why there is no link is kept on the profile.
    const run = await runRecurringInvoice(f.trx, f.orgId, null, id);
    const lines = await f.trx.selectFrom('invoice_lines').select(['description', 'qty', 'rate', 'discount_pct']).where('invoice_id', '=', Number(run.invoice.id)).orderBy('line_no').execute();
    assert.equal(lines.length, 2, 'the template line and the project hours');
    assert.deepEqual([Number(lines[0].discount_pct), Number(lines[0].rate)], [10, 1000], 'the discount kept apart from the rate');
    assert.match(lines[1].description ?? '', /^Website: .* — 2 h$/);
    assert.deepEqual([Number(lines[1].qty), Number(lines[1].rate)], [2, 1500]);
    assert.equal(run.hoursBilled, 1, 'one time entry billed');
    const billed = await f.trx.selectFrom('time_entries').select(['entry_date', 'invoice_id']).where('project_id', '=', pid).orderBy('entry_date').execute();
    assert.deepEqual(billed.map((b) => b.invoice_id === null ? null : Number(b.invoice_id)), [Number(run.invoice.id), null], 'the hour after the run date waits for the next invoice');
    const after = await f.trx.selectFrom('recurring_invoices').select('last_error').where('id', '=', id).executeTakeFirstOrThrow();
    assert.match(after.last_error ?? '', /online payments are not connected/);
    // Connected: each issued invoice gets a link.
    process.env.INTEGRATION_KEY = randomBytes(32).toString('hex');
    const asked: unknown[] = [];
    setPaymentLinkApi(async (_id, _secret, body) => { asked.push(body); return { id: `plink_${asked.length}`, short_url: `https://rzp.io/i/r${asked.length}` }; });
    await saveGateway(f.trx, f.orgId, { keyId: 'rzp_test_abc123', keySecret: 'secret_0123456789', webhookSecret: 'whsec_123', depositBankAccountId: f.bankId });
    const run2 = await runRecurringInvoice(f.trx, f.orgId, null, id);
    assert.equal(run2.paymentLink, 'https://rzp.io/i/r1');
    assert.equal(asked.length, 1);
    const cleared = await f.trx.selectFrom('recurring_invoices').select('last_error').where('id', '=', id).executeTakeFirstOrThrow();
    assert.equal(cleared.last_error, null);
    // A draft gets no link (Razorpay can only take payment on an issued invoice).
    const draftId = await createProfile(f.trx, f.orgId, profile(f, { paymentLink: true, createAsDraft: true }));
    const run3 = await runRecurringInvoice(f.trx, f.orgId, null, draftId);
    assert.equal(run3.paymentLink, null);
    assert.equal(asked.length, 1);
    assert.equal((await verifyLedgerBalances(f.trx, f.orgId)).balanced, true);
  });
});
