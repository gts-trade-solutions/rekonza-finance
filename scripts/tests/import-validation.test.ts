// Bulk import validation (status review 7, item 3) and bulk payment rows
// (item 6), as the auditors test them: a file of good and bad rows gives every
// bad row with its row number, field and reason, counts valid, invalid and
// duplicate rows, keeps the valid rows when asked (each failed row leaving
// nothing behind), applies the very rules the single-record form applies, and
// is kept in an import history that an unused import of masters can be undone
// from.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/import-validation.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { runImport, type ImportRowError } from '../../lib/server/imports/run';
import { contactProblems, itemProblems, phoneProblem, pinProblem, unitProblem } from '../../lib/validation/masters';
import { isValidGstin, GST_RATES } from '../../lib/tax/gst';
import { recordImportBatch, undoImport, listImportBatches } from '../../lib/server/services/import-history';
import { createInvoice } from '../../lib/server/services/sales';

interface Fixture { trx: Trx; orgId: number; branchId: number; userId: number }

async function withFixture(fn: (f: Fixture) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Import Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1 }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const acc = await accountIds(trx, orgId);
      await trx.insertInto('bank_accounts').values({ org_id: orgId, kind: 'bank', name: 'HDFC Current', ledger_account_id: acc[CODE.BANK_DEFAULT], opening_balance: '0.0000' }).execute();
      const userId = Number((await trx.insertInto('users').values({ org_id: orgId, name: 'Priya', email: `p-${orgId}@example.test`, role: 'accountant' } as never).executeTakeFirstOrThrow()).insertId);
      await fn({ trx, orgId, branchId, userId });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}
const ctx = (f: Fixture, onDuplicate: 'skip' | 'error' = 'error') => ({ orgId: f.orgId, userId: f.userId, branchId: f.branchId, onDuplicate, requireBalancedOpenings: true });
/** A GSTIN with a good check digit, from its first fourteen characters. */
const goodGstin = (first14: string) => [...'0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map((c) => first14 + c).find(isValidGstin)!;
const at = (errors: ImportRowError[], row: number, field?: string) => errors.find((e) => e.row === row && (!field || e.field === field));

test('the shared rules: GSTIN check digit and state, PAN, email, phone, PIN, unit', () => {
  const g = goodGstin('33AABCS1234F1Z');
  assert.deepEqual(contactProblems({ gstin: g, stateCode: '33', gstTreatment: 'registered' }), []);
  const bad = `${g.slice(0, 14)}${g[14] === '9' ? '8' : '9'}`;
  assert.match(contactProblems({ gstin: bad, stateCode: '33' })[0].message, /fails the GSTIN check digit/);
  assert.match(contactProblems({ gstin: g, stateCode: '29' })[0].message, /registered in state 33 .* not 29/);
  assert.match(contactProblems({ pan: 'ABCDE12345' })[0].message, /is not a PAN/);
  assert.match(contactProblems({ email: 'accounts@' })[0].message, /not an email address/);
  assert.equal(phoneProblem('+91 98400 12345'), null);
  assert.equal(phoneProblem('044-2345 6789'), null);
  assert.match(phoneProblem('98400')!.message, /5 digits/);
  assert.match(phoneProblem('call me')!.message, /not a phone number/);
  assert.equal(pinProblem('600 002'), null);
  assert.match(pinProblem('060002')!.message, /six digits, and does not start with 0/);
  assert.equal(pinProblem('94105', 'US'), null, 'a PIN code is checked only in India');
  assert.equal(unitProblem('kg').unit, 'KGS');
  assert.match(unitProblem('BUCKET').problem!.message, /not a GST unit/);
  assert.match(itemProblems({ kind: 'goods', hsnSac: '87A8' }, { hsnDigits: 4, gstRates: GST_RATES })[0].message, /digit|HSN/i);
  assert.match(itemProblems({ kind: 'goods', gstRatePct: 7 }, { hsnDigits: 4, gstRates: GST_RATES })[0].message, /not a GST rate/);
});

test('customers: every bad row named by row, field and reason; duplicates counted; the good rows kept', async () => {
  await withFixture(async (f) => {
    const g = goodGstin('33AABCS1234F1Z');
    const bad = `${g.slice(0, 14)}${g[14] === '9' ? '8' : '9'}`;
    const kar = goodGstin('29AACCB5678G1Z');
    await runImport(f.trx, ctx(f), 'contacts', [{ type: 'customer', name: 'Already Here', state: '33', __line: '2' }]);
    const rows = [
      { type: 'customer', name: 'Good One', gstin: g, email: 'a@good.in', phone: '9840012345', pincode: '600002', __line: '2' },
      { type: 'customer', name: '', state: '33', __line: '3' },
      { type: 'customer', name: 'Bad GSTIN', gstin: bad, __line: '4' },
      { type: 'customer', name: 'Bad PAN', state: '33', pan: 'ABCDE12345', __line: '5' },
      { type: 'customer', name: 'Wrong State', gstin: kar, state: '33', __line: '6' },
      { type: 'customer', name: 'Bad Contact', state: '33', email: 'nope@', phone: '12345', pincode: '06002', __line: '7' },
      { type: 'customer', name: 'Good One', state: '33', __line: '8' },
      { type: 'customer', name: 'Already Here', state: '33', __line: '9' },
      { type: 'customer', name: 'Good Two', state: 'Tamil Nadu', __line: '10' },
    ];
    const out = await runImport(f.trx, ctx(f), 'contacts', rows);
    assert.equal(out.created, 2, 'the two good rows went in');
    assert.equal(out.valid, 2);
    assert.match(at(out.errors, 3, 'Name')!.message, /Name is missing/);
    assert.equal(at(out.errors, 4, 'GSTIN')!.value, bad);
    assert.match(at(out.errors, 4, 'GSTIN')!.message, /fails the GSTIN check digit/);
    assert.match(at(out.errors, 5, 'PAN')!.message, /not a PAN/);
    assert.match(at(out.errors, 6, 'GSTIN')!.message, /registered in state 29/);
    // One row, all three problems.
    assert.ok(at(out.errors, 7, 'Email') && at(out.errors, 7, 'Phone') && at(out.errors, 7, 'PIN code'));
    assert.match(at(out.errors, 8, 'Name')!.message, /already on row 2 of this file/);
    assert.equal(at(out.errors, 8)!.duplicate, true);
    assert.match(at(out.errors, 9, 'Name')!.message, /already in your books/);
    assert.equal(out.duplicates, 2);
    // A failed row left nothing behind.
    const names = (await f.trx.selectFrom('contacts').select('display_name').where('org_id', '=', f.orgId).execute()).map((c) => c.display_name).sort();
    assert.deepEqual(names, ['Already Here', 'Good One', 'Good Two']);
    // Skip Duplicates: the one already in the books is skipped and listed, not an error.
    const skip = await runImport(f.trx, ctx(f, 'skip'), 'contacts', [{ type: 'customer', name: 'Already Here', state: '33', __line: '2' }]);
    assert.equal(skip.skipped, 1);
    assert.equal(skip.errors.length, 0);
    assert.equal(skip.skippedRows!.length, 1);
  });
});

test('items: unit, HSN, rate and negative stock checked as the item form checks them', async () => {
  await withFixture(async (f) => {
    const out = await runImport(f.trx, ctx(f), 'items', [
      { name: 'Brake pad', kind: 'goods', hsn_sac: '8708', unit: 'pcs', gst_rate: '18', opening_qty: '10', __line: '2' },
      { name: 'Bucket item', unit: 'BUCKET', __line: '3' },
      { name: 'Bad HSN', hsn_sac: '87A8', __line: '4' },
      { name: 'Odd rate', gst_rate: '7', __line: '5' },
      { name: 'Minus stock', opening_qty: '-3', __line: '6' },
      { name: 'Bad number', sale_price: 'abc', __line: '7' },
      { name: 'Service with HSN', kind: 'service', hsn_sac: '8708', __line: '8' },
    ]);
    assert.equal(out.created, 1);
    assert.equal(at(out.errors, 3, 'Unit')!.value, 'BUCKET');
    assert.ok(at(out.errors, 4, 'HSN/SAC'));
    assert.match(at(out.errors, 5, 'GST rate')!.message, /not a GST rate/);
    assert.match(at(out.errors, 6, 'Opening quantity')!.message, /negative/);
    assert.match(at(out.errors, 7, 'Sale price')!.message, /not a number/);
    assert.ok(at(out.errors, 8, 'HSN/SAC'), 'a service takes a SAC');
    const unit = await f.trx.selectFrom('items').select('uqc').where('org_id', '=', f.orgId).where('name', '=', 'Brake pad').executeTakeFirstOrThrow();
    assert.equal(unit.uqc, 'PCS');
  });
});

test('opening balances that do not balance are refused, naming the difference', async () => {
  await withFixture(async (f) => {
    const out = await runImport(f.trx, ctx(f), 'opening-ledger', [
      { account_code: CODE.CAPITAL, credit: '500000', __line: '2' },
      { account_code: CODE.LOANS_ADVANCES, debit: '450000', __line: '3' },
      { account_code: '9999', debit: '1', __line: '4' },
    ]);
    assert.equal(out.created, 0);
    assert.match(at(out.errors, 4, 'Account code')!.message, /not in your chart/);
    const unbalanced = await runImport(f.trx, ctx(f), 'opening-ledger', [
      { account_code: CODE.CAPITAL, credit: '500000', __line: '2' },
      { account_code: CODE.LOANS_ADVANCES, debit: '450000', __line: '3' },
    ]);
    assert.match(unbalanced.errors[0].message, /do not balance: debits ₹4,50,000.00, credits ₹5,00,000.00, a difference of ₹50,000.00/);
    // Naming Opening Balance Adjustments accepts the difference.
    const accepted = await runImport(f.trx, ctx(f), 'opening-ledger', [
      { account_code: CODE.CAPITAL, credit: '500000', __line: '2' },
      { account_code: CODE.LOANS_ADVANCES, debit: '450000', __line: '3' },
      { account_code: CODE.OPENING_BALANCE_EQUITY, debit: '50000', __line: '4' },
    ]);
    assert.equal(accepted.errors.length, 0, JSON.stringify(accepted.errors));
  });
});

test('invoices: a bad date, a negative quantity and an unknown customer, each on its own row', async () => {
  await withFixture(async (f) => {
    await runImport(f.trx, ctx(f), 'contacts', [{ type: 'customer', name: 'Buyer', state: '33' }]);
    const out = await runImport(f.trx, ctx(f), 'invoices', [
      { invoice_no: 'IMP-1', date: '2026-04-10', customer: 'Buyer', description: 'Service', qty: '1', rate: '1000', gst_rate: '18', __line: '2' },
      { invoice_no: 'IMP-2', date: '31-02-2026', customer: 'Buyer', description: 'Service', qty: '1', rate: '1000', __line: '3' },
      { invoice_no: 'IMP-3', date: '2026-04-10', customer: 'Buyer', description: 'Part', qty: '2', rate: '500', __line: '4' },
      { invoice_no: 'IMP-3', date: '2026-04-10', customer: 'Buyer', description: 'Part', qty: '-2', rate: '500', __line: '5' },
      { invoice_no: 'IMP-4', date: '2026-04-10', customer: 'Nobody', description: 'Part', qty: '1', rate: '500', __line: '6' },
    ]);
    assert.equal(out.created, 1);
    assert.match(at(out.errors, 3, 'Date')!.message, /not a real date/);
    assert.match(at(out.errors, 5, 'Quantity')!.message, /more than zero/, 'the bad line names its own row');
    assert.match(at(out.errors, 6, 'Customer')!.message, /not one of your customers/);
  });
});

test('customer receipts: applied to the right invoices; unknown customer, paid invoice, over the balance, unknown bank, duplicate reference refused row by row', async () => {
  await withFixture(async (f) => {
    await runImport(f.trx, ctx(f), 'contacts', [{ type: 'customer', name: 'Buyer', state: '33' }, { type: 'customer', name: 'Other', state: '33' }]);
    const buyer = await f.trx.selectFrom('contacts').select('id').where('org_id', '=', f.orgId).where('display_name', '=', 'Buyer').executeTakeFirstOrThrow();
    const sell = (number: string, ratePaise: number) => createInvoice(f.trx, f.orgId, null, {
      branchId: f.branchId, customerId: buyer.id, number, date: '2026-04-01', dueDate: '2026-04-30', status: 'approved', lines: [{ description: 'Service', qty: 1, ratePaise, gstRatePct: 0 }],
    });
    await sell('S-1', 100_000);
    await sell('S-2', 50_000);
    await sell('S-3', 20_000);
    const r = (o: Record<string, string>) => ({ date: '2026-04-15', mode: 'NEFT', account: 'HDFC Current', ...o });
    const out = await runImport(f.trx, ctx(f), 'payments-received', [
      r({ customer: 'Buyer', amount: '1,500', invoice: 'S-1; S-2', reference: 'UTR001', __line: '2' }),
      r({ customer: 'Nobody', amount: '100', reference: 'UTR002', __line: '3' }),
      r({ customer: 'Buyer', amount: '100', invoice: 'S-1', reference: 'UTR003', __line: '4' }),
      r({ customer: 'Buyer', amount: '₹ 300', invoice: 'S-3', reference: 'UTR004', __line: '5' }),
      r({ customer: 'Buyer', amount: '100', account: 'SBI Savings', reference: 'UTR005', __line: '6' }),
      r({ customer: 'Buyer', amount: '50', invoice: 'S-3', reference: 'UTR001', __line: '7' }),
      r({ customer: 'Buyer', amount: '200', invoice: 'S-3', reference: 'UTR006', __line: '8' }),
    ]);
    assert.equal(out.created, 2, 'the two good receipts');
    assert.match(at(out.errors, 3, 'Customer')!.message, /not one of your customers/);
    assert.match(at(out.errors, 4, 'Invoice')!.message, /paid already/);
    assert.match(at(out.errors, 5, 'Amount')!.message, /more than the ₹200.00 still owed on S-3/);
    assert.match(at(out.errors, 6, 'Deposited to')!.message, /not one of your bank or cash accounts/);
    assert.match(at(out.errors, 7, 'Reference')!.message, /"UTR001" is already on row 2 of this file/);
    const invs = await f.trx.selectFrom('invoices').select(['number', 'status', 'amount_paid']).where('org_id', '=', f.orgId).orderBy('number').execute();
    assert.deepEqual(invs.map((i) => [i.number, i.status]), [['S-1', 'paid'], ['S-2', 'paid'], ['S-3', 'paid']]);
  });
});

test('import history: kept with its rows left out; an unused import of masters is undone, a used one refused', async () => {
  await withFixture(async (f) => {
    const out = await runImport(f.trx, ctx(f), 'contacts', [
      { type: 'customer', name: 'Kept A', state: '33', __line: '2' },
      { type: 'customer', name: 'Kept B', state: '33', __line: '3' },
      { type: 'customer', name: '', state: '33', __line: '4' },
    ]);
    const id = await recordImportBatch(f.trx, f.orgId, f.userId, { module: 'customers', kind: 'contacts', fileName: 'customers.xlsx', fileFormat: 'xlsx', mode: 'valid_only', outcome: out });
    const [b] = await listImportBatches(f.trx, f.orgId, { module: 'customers' });
    assert.equal(b.id, String(id));
    assert.deepEqual([b.rowsTotal, b.imported, b.failed, b.by, b.fileName, b.undoable], [3, 2, 1, 'Priya', 'customers.xlsx', true]);
    // Used: refused by name.
    const kept = await f.trx.selectFrom('contacts').select('id').where('org_id', '=', f.orgId).where('display_name', '=', 'Kept A').executeTakeFirstOrThrow();
    const inv = await createInvoice(f.trx, f.orgId, null, { branchId: f.branchId, customerId: kept.id, date: '2026-04-01', dueDate: '2026-04-01', status: 'approved', lines: [{ description: 'x', qty: 1, ratePaise: 100, gstRatePct: 0 }] });
    await assert.rejects(undoImport(f.trx, f.orgId, f.userId, id), /Kept A has documents or entries/);
    await f.trx.deleteFrom('journal_lines').where('org_id', '=', f.orgId).execute();
    await f.trx.deleteFrom('einvoices').where('invoice_id', '=', inv.id).execute();
    await f.trx.deleteFrom('invoice_lines').where('invoice_id', '=', inv.id).execute();
    await f.trx.deleteFrom('invoices').where('id', '=', inv.id).execute();
    const done = await undoImport(f.trx, f.orgId, f.userId, id);
    assert.deepEqual(done.deleted, { contacts: 2 });
    const [after] = await listImportBatches(f.trx, f.orgId);
    assert.deepEqual([after.status, after.undoneBy, after.undoable], ['undone', 'Priya', false]);
    await assert.rejects(undoImport(f.trx, f.orgId, f.userId, id), /undone already/);
  });
});

test.after(() => db.destroy());
