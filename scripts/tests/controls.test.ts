// Internal controls, after an auditor's review: perpetual inventory, the
// exceptions register, segregation of duties, the credit hold, password rules,
// the reason behind a change, the error log, automatic IRN registration, bank
// matching against payments already entered, and risk analytics.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/controls.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { createInvoice, voidInvoice } from '../../lib/server/services/sales';
import { createBill } from '../../lib/server/services/purchases';
import { makePayment } from '../../lib/server/services/payments';
import { matchEnteredPayments } from '../../lib/server/services/banking';
import { balanceSheet, inventoryInLedger, profitAndLoss } from '../../lib/server/reports/statements';
import { stockPosition } from '../../lib/server/reports/stock';
import { setPolicies } from '../../lib/server/services/org-settings';
import { switchToPerpetual, trueUpStock } from '../../lib/server/services/stock-ledger';
import { actOnException, listExceptions, scanIn } from '../../lib/server/services/exceptions';
import { controlsOverview } from '../../lib/server/services/controls';
import { newPasswordProblems, recordPasswordSet, passwordExpired, MUST_CHANGE } from '../../lib/server/auth/password-policy';
import { hashPassword } from '../../lib/server/auth/password';
import { withChangeReason } from '../../lib/server/request-context';
import { logAudit } from '../../lib/server/audit';
import { fingerprint, recordError, updateError } from '../../lib/server/error-log';
import { queueIrns } from '../../lib/server/gst/auto-irn';
import { anomalies, customerRisk } from '../../lib/server/analytics/risk';

interface Fixture {
  trx: Trx; orgId: number; branchId: number; customerId: number; vendorId: number; itemId: number; bankId: number;
  admin: number; sales: number; accountant: number;
}

async function withFixture(fn: (f: Fixture) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Controls Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1 }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const acc = await accountIds(trx, orgId);
      const user = async (role: string) => Number((await trx.insertInto('users').values({
        org_id: orgId, name: `${role[0].toUpperCase()}${role.slice(1)}`, email: `${role}-${orgId}@example.test`, role,
      } as never).executeTakeFirstOrThrow()).insertId);
      const admin = await user('admin');
      const sales = await user('sales');
      const accountant = await user('accountant');
      const mk = async (values: Record<string, unknown>) =>
        Number((await trx.insertInto('contacts').values(values as never).executeTakeFirstOrThrow()).insertId);
      const customerId = await mk({ org_id: orgId, kind: 'customer', display_name: 'Sharma Traders', gst_treatment: 'unregistered', state_code: '33', owner_user_id: sales });
      const vendorId = await mk({ org_id: orgId, kind: 'vendor', display_name: 'Local Vendor', gst_treatment: 'unregistered', state_code: '33' });
      await trx.insertInto('hsn_codes').values({ org_id: orgId, code: '8708', kind: 'hsn', description: 'Parts', gst_rate_pct: 18, is_active: 1 }).execute();
      // Ten on the shelf when the books began, at ₹100 each.
      const itemId = Number((await trx.insertInto('items').values({
        org_id: orgId, kind: 'goods', name: 'Brake pad', sku: 'BP-1', hsn_sac: '8708', uqc: 'NOS',
        sale_price: '200.0000', purchase_price: '120.0000', gst_rate_pct: 18, track_inventory: 1,
        opening_stock_qty: '10', opening_stock_rate: '100.0000', sale_account_id: acc[CODE.SALES], purchase_account_id: acc[CODE.PURCHASES],
      }).executeTakeFirstOrThrow()).insertId);
      const bankId = Number((await trx.insertInto('bank_accounts').values({
        org_id: orgId, kind: 'bank', name: 'Main Bank', ledger_account_id: acc[CODE.BANK_DEFAULT], opening_balance: '0.0000', opening_date: null, is_primary: 1,
      }).executeTakeFirstOrThrow()).insertId);
      await fn({ trx, orgId, branchId, customerId, vendorId, itemId, bankId, admin, sales, accountant });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

const buy = (f: Fixture, date: string, qty: number, ratePaise: number, userId: number | null = null) =>
  createBill(f.trx, f.orgId, userId, {
    branchId: f.branchId, vendorId: f.vendorId, vendorInvoiceNo: `B-${date}-${qty}-${ratePaise}`, date, dueDate: date,
    lines: [{ itemId: f.itemId, qty, ratePaise }],
  });
const sell = (f: Fixture, date: string, qty: number, ratePaise: number, dueDate = date) =>
  createInvoice(f.trx, f.orgId, null, {
    branchId: f.branchId, customerId: f.customerId, date, dueDate, status: 'approved', lines: [{ itemId: f.itemId, qty, ratePaise }],
  });
const lineOn = async (trx: Trx, entryId: number, code: string) => {
  const { rows } = await sql<{ dr: string; cr: string }>`
    SELECT COALESCE(SUM(jl.debit), 0) AS dr, COALESCE(SUM(jl.credit), 0) AS cr FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
     WHERE jl.entry_id = ${entryId} AND a.code = ${code}`.execute(trx);
  return { dr: Math.round(Number(rows[0].dr) * 100), cr: Math.round(Number(rows[0].cr) * 100) };
};

// ── Perpetual inventory ─────────────────────────────────────────────────────

test('perpetual inventory: each sale posts its cost, purchases go to Inventory, profit as periodic', async () => {
  await withFixture(async (f) => {
    // Switching on 1 May takes the ₹1,000 on the shelf (10 × ₹100) into Inventory.
    const sw = await switchToPerpetual(f.trx, f.orgId, null, '2026-05-01');
    assert.equal(sw.openingPaise, 100_000);
    await assert.rejects(switchToPerpetual(f.trx, f.orgId, null, '2026-06-01'), /already on perpetual/);

    const bill = await buy(f, '2026-05-10', 10, 13_000); // ₹1,300 into Inventory, not Purchases
    const billEntry = await f.trx.selectFrom('bills').select('journal_entry_id').where('id', '=', bill.id).executeTakeFirstOrThrow();
    assert.equal((await lineOn(f.trx, billEntry.journal_entry_id!, CODE.INVENTORY)).dr, 130_000);
    assert.equal((await lineOn(f.trx, billEntry.journal_entry_id!, CODE.PURCHASES)).dr, 0);

    // Average (₹1,000 + ₹1,300) / 20 = ₹115; five sold cost ₹575.
    const inv = await sell(f, '2026-06-01', 5, 20_000);
    const invEntry = await f.trx.selectFrom('invoices').select('journal_entry_id').where('id', '=', inv.id).executeTakeFirstOrThrow();
    assert.deepEqual(await lineOn(f.trx, invEntry.journal_entry_id!, CODE.COGS), { dr: 57_500, cr: 0 });
    assert.deepEqual(await lineOn(f.trx, invEntry.journal_entry_id!, CODE.INVENTORY), { dr: 0, cr: 57_500 });

    // The ledger now carries exactly the stock: ₹1,000 + ₹1,300 − ₹575 = ₹1,725 = 15 × ₹115.
    assert.equal(await inventoryInLedger(f.trx, f.orgId, '2026-06-30'), 172_500);
    assert.equal((await stockPosition(f.trx, f.orgId, '2026-06-30')).totalValuePaise, 172_500);

    // Profit is what periodic gives: ₹1,000 sales − (₹1,300 + ₹1,000 − ₹1,725) = ₹425.
    const pl = await profitAndLoss(f.trx, f.orgId, '2026-04-01', '2026-06-30');
    assert.equal(pl.netProfit, 42_500);
    assert.equal(pl.closingStockPaise, 0, 'nothing left outside the ledger');
    const bs = await balanceSheet(f.trx, f.orgId, '2026-06-30');
    assert.ok(bs.balanced, 'still balances');
    assert.equal(bs.currentPeriodEarnings, 42_500);

    // A purchase dated before the sale moves the average; the statements stay right
    // before the month-end entry and after it.
    await buy(f, '2026-05-20', 10, 20_000);
    const stock = (await stockPosition(f.trx, f.orgId, '2026-06-30')).totalValuePaise;
    const expected = 100_000 - (130_000 + 200_000 + 100_000 - stock);
    assert.equal((await profitAndLoss(f.trx, f.orgId, '2026-04-01', '2026-06-30')).netProfit, expected, 'before the true-up');
    const moved = await trueUpStock(f.trx, f.orgId, null, '2026-06-30');
    assert.equal(moved, stock - 372_500, 'Inventory brought to the valuation');
    assert.equal(await trueUpStock(f.trx, f.orgId, null, '2026-06-30'), 0, 'once in line, nothing more');
    const after = await profitAndLoss(f.trx, f.orgId, '2026-04-01', '2026-06-30');
    assert.equal(after.netProfit, expected, 'after the true-up');
    assert.equal(after.closingStockPaise, 0);
    assert.ok((await balanceSheet(f.trx, f.orgId, '2026-06-30')).balanced);

    // Voiding the sale takes its cost back out of cost of goods sold.
    const before = await inventoryInLedger(f.trx, f.orgId, '2026-06-30');
    await voidInvoice(f.trx, f.orgId, null, inv.id, 'Entered against the wrong customer');
    assert.equal(await inventoryInLedger(f.trx, f.orgId, '2026-06-30'), before + 57_500);
  });
});

test('periodic books are untouched: no cost lines, statements as before', async () => {
  await withFixture(async (f) => {
    await buy(f, '2026-05-10', 10, 13_000);
    const inv = await sell(f, '2026-06-01', 5, 20_000);
    const entry = await f.trx.selectFrom('invoices').select('journal_entry_id').where('id', '=', inv.id).executeTakeFirstOrThrow();
    assert.deepEqual(await lineOn(f.trx, entry.journal_entry_id!, CODE.COGS), { dr: 0, cr: 0 });
    assert.equal(await inventoryInLedger(f.trx, f.orgId, '2026-06-30'), 0);
    const pl = await profitAndLoss(f.trx, f.orgId, '2026-04-01', '2026-06-30');
    assert.equal(pl.closingStockPaise, 172_500);
    assert.equal(pl.netProfit, 42_500);
  });
});

// ── Exceptions ──────────────────────────────────────────────────────────────

test('exceptions: raised to the account owner, escalated, closed by themselves, worked by people', async () => {
  await withFixture(async (f) => {
    // Dated from today: a person's "resolved" is stamped with the real clock.
    const now = new Date();
    const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString().slice(0, 10);
    // ₹1,000 that fell due 40 days ago.
    const inv = await sell(f, daysAgo(50), 5, 20_000, daysAgo(40));
    const first = await scanIn(f.trx, f.orgId, now);
    assert.ok(first.raised >= 1);
    const list = await listExceptions(f.trx, f.orgId);
    const overdue = list.exceptions.find((x) => x.kind === 'receivable_overdue');
    assert.ok(overdue, 'the overdue customer is raised');
    assert.equal(overdue!.ownerId, String(f.sales), 'to the customer\'s own account owner');
    assert.equal(overdue!.severity, 'medium', '30 days and more');
    const told = await f.trx.selectFrom('notifications').select('user_id').where('org_id', '=', f.orgId).where('kind', '=', 'exception').execute();
    assert.ok(told.some((n) => n.user_id === f.sales));

    // Seen again: one exception, not two.
    await scanIn(f.trx, f.orgId, now);
    assert.equal((await listExceptions(f.trx, f.orgId)).exceptions.filter((x) => x.kind === 'receivable_overdue').length, 1);

    // Past its date the owner is reminded; three days later, the admins hear.
    const id = Number(overdue!.id);
    await scanIn(f.trx, f.orgId, new Date(now.getTime() + 8 * 86_400_000));
    let row = await f.trx.selectFrom('exceptions').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    assert.equal(row.escalation_level, 1);
    await scanIn(f.trx, f.orgId, new Date(now.getTime() + 12 * 86_400_000));
    row = await f.trx.selectFrom('exceptions').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    assert.equal(row.escalation_level, 2);
    const admins = await f.trx.selectFrom('notifications').select('title').where('user_id', '=', f.admin).execute();
    assert.ok(admins.some((n) => n.title.startsWith('Escalated')));

    // Someone else's, and not a manager: refused. The owner works it.
    await assert.rejects(actOnException(f.trx, f.orgId, { userId: f.accountant, canManage: false }, id, { action: 'start' }), /someone else/);
    await assert.rejects(actOnException(f.trx, f.orgId, { userId: f.sales, canManage: false }, id, { action: 'waive', note: 'Agreed to wait' }), /needs a manager/);
    await actOnException(f.trx, f.orgId, { userId: f.sales, canManage: false }, id, { action: 'start' });
    await assert.rejects(actOnException(f.trx, f.orgId, { userId: f.sales, canManage: false }, id, { action: 'resolve' }), /what was done/);
    await actOnException(f.trx, f.orgId, { userId: f.sales, canManage: false }, id, { action: 'resolve', note: 'Promised payment by Friday' });

    // Still unpaid a day later: it was not resolved, so it reopens.
    await scanIn(f.trx, f.orgId, new Date(now.getTime() + 14 * 86_400_000));
    row = await f.trx.selectFrom('exceptions').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    assert.equal(row.status, 'open');

    // Paid: it closes by itself.
    await f.trx.updateTable('invoices').set({ amount_paid: sql`total`, status: 'paid' }).where('id', '=', inv.id).execute();
    const cleared = await scanIn(f.trx, f.orgId, new Date(now.getTime() + 15 * 86_400_000));
    assert.ok(cleared.cleared >= 1);
    row = await f.trx.selectFrom('exceptions').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    assert.equal(row.status, 'resolved');
    assert.equal(row.open_key, null);
    const events = await f.trx.selectFrom('exception_events').select('action').where('exception_id', '=', id).orderBy('id').execute();
    assert.deepEqual(events.map((e) => e.action), ['raised', 'escalated', 'escalated', 'started', 'resolved', 'reopened', 'cleared']);
  });
});

test('exceptions: concentration, a bad GSTIN, a document running out', async () => {
  await withFixture(async (f) => {
    const now = new Date('2026-08-10T06:00:00Z');
    const mk = async (name: string, gstin: string | null = null) => Number((await f.trx.insertInto('contacts').values({
      org_id: f.orgId, kind: 'customer', display_name: name, gst_treatment: gstin ? 'registered' : 'unregistered', state_code: '33', gstin,
    } as never).executeTakeFirstOrThrow()).insertId);
    const small1 = await mk('Small One');
    const small2 = await mk('Small Two');
    await mk('Typo Traders', '33AABCT1234A1ZX'); // check digit wrong
    const owe = (customerId: number, ratePaise: number) => createInvoice(f.trx, f.orgId, null, {
      branchId: f.branchId, customerId, date: '2026-08-01', dueDate: '2026-08-31', status: 'approved',
      lines: [{ description: 'Service', qty: 1, ratePaise, gstRatePct: 0 }],
    });
    await owe(f.customerId, 800_000);
    await owe(small1, 100_000);
    await owe(small2, 100_000);
    await f.trx.insertInto('documents').values({ org_id: f.orgId, title: 'Warehouse lease', category: 'contract', expires_on: '2026-08-25' }).execute();
    await scanIn(f.trx, f.orgId, now);
    const kinds = (await listExceptions(f.trx, f.orgId)).exceptions.map((x) => x.kind);
    assert.ok(kinds.includes('concentration'), 'one customer is 80% of receivables');
    assert.ok(kinds.includes('master_data'), 'a GSTIN failing its check digit');
    assert.ok(kinds.includes('document_expiring'), 'a lease running out in 15 days');
  });
});

// ── Segregation, credit hold ────────────────────────────────────────────────

test('segregation of duties: whoever entered a bill does not pay it', async () => {
  await withFixture(async (f) => {
    const bill = await buy(f, '2026-08-01', 2, 10_000, f.accountant);
    const pay = (userId: number) => makePayment(f.trx, f.orgId, userId, {
      branchId: f.branchId, contactId: f.vendorId, date: '2026-08-05', mode: 'neft', amountPaise: bill.totalPaise, bankAccountId: f.bankId,
      allocations: [{ targetType: 'bill', targetId: bill.id, amountPaise: bill.totalPaise }],
    });
    // By default a warning…
    await f.trx.executeQuery(sql`SAVEPOINT sod`.compile(f.trx));
    const warned = await pay(f.accountant);
    assert.ok(warned.warnings?.some((w) => /You entered/.test(w)));
    await f.trx.executeQuery(sql`ROLLBACK TO SAVEPOINT sod`.compile(f.trx));
    // …and set to block, a refusal; someone else pays it.
    await setPolicies(f.trx, f.orgId, null, { controls: { segregation: 'block' } as never });
    await assert.rejects(pay(f.accountant), /Someone else should pay it/);
    const ok = await pay(f.admin);
    assert.ok(!ok.warnings?.length);
  });
});

test('credit hold: a customer long past due is warned about, or stopped', async () => {
  await withFixture(async (f) => {
    await sell(f, '2026-03-01', 1, 20_000, '2026-03-31'); // 120+ days past due by August
    const again = () => sell(f, '2026-08-05', 1, 20_000);
    const warned = await again();
    assert.ok(warned.warnings?.some((w) => /more than 90 days past due/.test(w)));
    await setPolicies(f.trx, f.orgId, null, { controls: { creditHold: 'block' } as never });
    await assert.rejects(again(), /Collect it before supplying more/);
  });
});

// ── Passwords, reasons, errors ──────────────────────────────────────────────

test('password rules: the book\'s length, no reuse, expiry, and temporary passwords', async () => {
  await withFixture(async (f) => {
    await setPolicies(f.trx, f.orgId, null, { password: { minLength: 12, history: 3, expiryDays: 90 } });
    assert.match((await newPasswordProblems(f.trx, f.orgId, f.sales, 'Short1Pass')).join(' '), /at least 12/);
    assert.deepEqual(await newPasswordProblems(f.trx, f.orgId, f.sales, 'LongEnough2026x'), []);
    await recordPasswordSet(f.trx, f.sales, await hashPassword('LongEnough2026x'));
    assert.match((await newPasswordProblems(f.trx, f.orgId, f.sales, 'LongEnough2026x')).join(' '), /last 3/);
    assert.equal(passwordExpired(new Date(), 90), false);
    assert.equal(passwordExpired(new Date(Date.now() - 91 * 86_400_000), 90), true);
    assert.equal(passwordExpired(null, 90), false, 'no date: the clock starts when the rule is set');
    assert.equal(passwordExpired(MUST_CHANGE, 0), true, 'an admin\'s temporary password always has to change');
    await recordPasswordSet(f.trx, f.accountant, '', { temporary: true });
    const u = await f.trx.selectFrom('users').select('password_changed_at').where('id', '=', f.accountant).executeTakeFirstOrThrow();
    assert.equal(passwordExpired(u.password_changed_at, 0), true);
  });
});

test('the reason for a change is kept in the audit trail', async () => {
  await withFixture(async (f) => {
    await withChangeReason('GSTIN corrected from the certificate', () => logAudit({
      trx: f.trx, orgId: f.orgId, actorUserId: f.admin, action: 'update', targetType: 'contact', targetId: f.customerId, detail: 'Updated',
    }));
    const row = await f.trx.selectFrom('audit_log').select('reason').where('org_id', '=', f.orgId).orderBy('id', 'desc').executeTakeFirstOrThrow();
    assert.equal(row.reason, 'GSTIN corrected from the certificate');
  });
});

test('the error log: repeats share a row, a fix needs its cause', async () => {
  await withFixture(async (f) => {
    const boom = (id: number) => { try { JSON.parse(`{"id": ${id}, oops`); } catch (e) { return e; } return null; };
    assert.equal(fingerprint(boom(1)), fingerprint(boom(2)), 'the same fault whatever the numbers');
    const ctx = { orgId: f.orgId, userId: f.admin, method: 'POST', path: '/api/test' };
    const ref = await recordError(boom(1), ctx, f.trx);
    assert.match(ref ?? '', /^[0-9A-F]{8}$/);
    assert.equal(await recordError(boom(7), ctx, f.trx), ref, 'the same reference');
    const row = await f.trx.selectFrom('error_events').selectAll().where('ref', '=', ref!).executeTakeFirstOrThrow();
    assert.equal(row.occurrences, 2);
    await assert.rejects(updateError(f.trx, f.orgId, f.admin, row.id, { status: 'resolved' }), /what caused it/);
    await updateError(f.trx, f.orgId, f.admin, row.id, { status: 'resolved', rootCause: 'Bad JSON from a client', resolution: 'Validated the body' });
    // Back again after the fix: open again.
    await recordError(boom(3), ctx, f.trx);
    assert.equal((await f.trx.selectFrom('error_events').select('status').where('id', '=', row.id).executeTakeFirstOrThrow()).status, 'open');
  });
});

// ── IRNs, bank matching, analytics, the overview ────────────────────────────

test('automatic IRN: an untried invoice is queued once, and only once', async () => {
  await withFixture(async (f) => {
    const inv = await sell(f, '2026-08-05', 1, 20_000);
    // As for a B2B invoice above the threshold: waiting for its IRN, never tried.
    await f.trx.updateTable('einvoices').set({ status: 'pending', attempts: 0 }).where('invoice_id', '=', inv.id).execute();
    assert.equal(await queueIrns(f.trx, f.orgId), 1);
    assert.equal(await queueIrns(f.trx, f.orgId), 0, 'already waiting');
    const job = await f.trx.selectFrom('jobs').selectAll().where('org_id', '=', f.orgId).executeTakeFirstOrThrow();
    assert.equal(job.kind, 'einvoice.register');
    assert.ok(new Date(job.run_after!).getTime() <= Date.now() + 1000, 'to run now');
    await setPolicies(f.trx, f.orgId, null, { controls: { autoIrn: false } as never });
    await f.trx.deleteFrom('jobs').where('org_id', '=', f.orgId).execute();
    assert.equal(await queueIrns(f.trx, f.orgId), 0, 'switched off');
  });
});

test('bank matching: a statement line equal to one entered payment is matched; two alike are left', async () => {
  await withFixture(async (f) => {
    const bill = await buy(f, '2026-08-01', 2, 10_000);
    await makePayment(f.trx, f.orgId, null, {
      branchId: f.branchId, contactId: f.vendorId, date: '2026-08-05', mode: 'neft', amountPaise: bill.totalPaise, bankAccountId: f.bankId,
      allocations: [{ targetType: 'bill', targetId: bill.id, amountPaise: bill.totalPaise }],
    });
    const line = (date: string, amount: number) => f.trx.insertInto('bank_transactions').values({
      org_id: f.orgId, bank_account_id: f.bankId, txn_date: date, narration: 'NEFT', deposit: '0', withdrawal: (amount / 100).toFixed(4), dedupe_hash: `${date}-${amount}-${Math.random()}`,
    } as never).execute();
    await line('2026-08-06', bill.totalPaise);
    assert.equal(await matchEnteredPayments(f.trx, f.orgId, null, f.bankId), 1);
    // Two ₹500 payments the same week, one line: which is it? Left for a person.
    for (const d of ['2026-08-10', '2026-08-11']) {
      await makePayment(f.trx, f.orgId, null, { branchId: f.branchId, contactId: f.vendorId, date: d, mode: 'neft', amountPaise: 50_000, bankAccountId: f.bankId });
    }
    await line('2026-08-12', 50_000);
    assert.equal(await matchEnteredPayments(f.trx, f.orgId, null, f.bankId), 0);
  });
});

test('risk analytics: a duplicate payment found, and customers scored', async () => {
  await withFixture(async (f) => {
    for (const d of ['2026-08-03', '2026-08-06']) {
      await makePayment(f.trx, f.orgId, null, { branchId: f.branchId, contactId: f.vendorId, date: d, mode: 'neft', amountPaise: 75_000, bankAccountId: f.bankId });
    }
    const found = await anomalies(f.trx, f.orgId, '2026-04-01', '2026-08-31');
    assert.ok(found.some((a) => a.kind === 'duplicate_payment'));
    await sell(f, '2026-05-01', 3, 20_000, '2026-05-31');
    const risk = await customerRisk(f.trx, f.orgId, '2026-08-31');
    assert.equal(risk.length, 1);
    assert.equal(risk[0].oldestDaysOverdue, 92);
    assert.ok(risk[0].score >= 60, 'three months late is high risk');
    assert.equal(risk[0].band, 'high');
  });
});

test('the controls overview covers every area the auditor named', async () => {
  await withFixture(async (f) => {
    const controls = await controlsOverview(f.trx, f.orgId);
    assert.equal(controls.length, 20);
    assert.equal(new Set(controls.map((c) => c.key)).size, 20);
    const inv = controls.find((c) => c.key === 'inventory')!;
    assert.equal(inv.status, 'partial', 'stock is kept periodically until switched');
    await switchToPerpetual(f.trx, f.orgId, null, '2026-05-01');
    assert.equal((await controlsOverview(f.trx, f.orgId)).find((c) => c.key === 'inventory')!.status, 'in_place');
  });
});

test.after(() => db.destroy());
