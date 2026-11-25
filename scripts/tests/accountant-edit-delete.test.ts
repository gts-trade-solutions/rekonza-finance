// Edit and Delete on what the accountant keeps (services/accountant-changes.ts
// and editOpeningDocument), against real MySQL inside rolled-back transactions.
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/accountant-edit-delete.test.ts
//
// What has to hold: a master in use is refused (code 'in_use', so the screen
// can offer Mark as inactive), never deleted out from under its history; what
// posted is reversed on its own date, never erased, and leaves the ledger as
// if it had never been entered; a plan or a setting (a budget line, a rate, a
// profile) changes or goes without touching the ledger.

import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { postEntry, verifyLedgerBalances } from '../../lib/server/ledger/posting';
import { toPaiseFromSql } from '../../lib/server/money-sql';
import {
  deleteAccount, deleteAsset, deleteAssetClass, deleteBudgetLine, deleteBusinessDocument, deleteConfirmation, deleteCostCentre,
  deleteRate, deleteRecurringJournal, deleteRestatement, editRate, listRestatements, setBudgetLine, updateConfirmation,
  updateRecurringJournal,
} from '../../lib/server/services/accountant-changes';
import { saveCostCentre } from '../../lib/server/services/cost-centres';
import { addAsset, ensureAssetClasses, listAssetClasses, reverseLatestRun, runDepreciation } from '../../lib/server/services/fixed-assets';
import { addOpeningDocument, editOpeningDocument, setBooksStartDate } from '../../lib/server/services/opening-balances';
import { requestConfirmation } from '../../lib/server/services/balance-confirmations';
import { createInvoice } from '../../lib/server/services/sales';
import { receivePayment } from '../../lib/server/services/payments';
import { revalue, setRate } from '../../lib/server/services/fx';

interface Fixture { trx: Trx; orgId: number; branchId: number; acc: Record<string, number>; customer: number; vendor: number; overseas: number; bankId: number }

async function withFixture(fn: (f: Fixture) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({
        name: 'Accountant Edit Delete Co', lut_declared: 1, lut_arn: 'AD330426012345X', lut_valid_from: '2024-04-01', lut_valid_to: '2028-03-31',
      }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1, gstin: '33AAACR4849R1ZK' }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      await ensureAssetClasses(trx, orgId);
      const acc = await accountIds(trx, orgId);
      await trx.insertInto('hsn_codes').values({ org_id: orgId, code: '8708', kind: 'hsn', description: 'Parts', gst_rate_pct: 18, is_active: 1 }).execute();
      const bankId = Number((await trx.insertInto('bank_accounts').values({
        org_id: orgId, kind: 'bank', name: 'Current', ledger_account_id: acc[CODE.BANK_DEFAULT], opening_balance: '0.0000',
      }).executeTakeFirstOrThrow()).insertId);
      const mk = async (v: Record<string, unknown>) =>
        Number((await trx.insertInto('contacts').values({ org_id: orgId, state_code: '33', ...v } as never).executeTakeFirstOrThrow()).insertId);
      await fn({
        trx, orgId, branchId, acc, bankId,
        customer: await mk({ kind: 'customer', display_name: 'Ravi Motors', gst_treatment: 'unregistered' }),
        vendor: await mk({ kind: 'vendor', display_name: 'Steel Mart', gst_treatment: 'unregistered' }),
        overseas: await mk({ kind: 'customer', display_name: 'Detroit Motors', gst_treatment: 'overseas', state_code: '96', currency: 'USD' }),
      });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

test.after(() => db.destroy());

const balance = async (f: Fixture, code: string, upTo = '2099-12-31') => toPaiseFromSql((await sql<{ b: string }>`
  SELECT COALESCE(SUM(debit - credit), 0) AS b FROM journal_lines WHERE org_id = ${f.orgId} AND account_id = ${f.acc[code]} AND entry_date <= ${upTo}
`.execute(f.trx)).rows[0].b);
const code = (e: unknown) => (e as { code?: string }).code;
const newAccount = async (f: Fixture, c: string, type = 'expense') =>
  Number((await f.trx.insertInto('accounts').values({ org_id: f.orgId, code: c, name: `Account ${c}`, type, is_system: 0, is_active: 1 } as never).executeTakeFirstOrThrow()).insertId);

test('an account: unused goes; with postings or named on an item it is refused as in use; a system one is refused', async () => {
  await withFixture(async (f) => {
    const spare = await newAccount(f, '6991');
    assert.deepEqual(await deleteAccount(f.trx, f.orgId, spare), { code: '6991', name: 'Account 6991' });
    assert.equal((await f.trx.selectFrom('accounts').select('id').where('id', '=', spare).execute()).length, 0);

    const used = await newAccount(f, '6992');
    await postEntry(f.trx, {
      orgId: f.orgId, branchId: f.branchId, date: '2026-10-01', sourceType: 'manual', module: 'accountant',
      lines: [{ accountId: used, debit: 500_00 }, { accountId: f.acc[CODE.BANK_DEFAULT], credit: 500_00 }],
    });
    await assert.rejects(deleteAccount(f.trx, f.orgId, used), (e) => code(e) === 'in_use' && /1 posting.*Mark it as inactive/.test((e as Error).message));

    const onItem = await newAccount(f, '4991', 'income');
    await f.trx.insertInto('items').values({ org_id: f.orgId, kind: 'service', name: 'Fitting', sale_account_id: onItem, sale_price: '10.0000', gst_rate_pct: 18 } as never).execute();
    await assert.rejects(deleteAccount(f.trx, f.orgId, onItem), (e) => code(e) === 'in_use' && /named on an item/.test((e as Error).message));

    await assert.rejects(deleteAccount(f.trx, f.orgId, f.acc[CODE.AR]), /system account/);
  });
});

test('a budget line: its figure and note edited, then deleted; the ledger does not move', async () => {
  await withFixture(async (f) => {
    const rent = f.acc[CODE.RENT] ?? await newAccount(f, '6993');
    await setBudgetLine(f.trx, f.orgId, null, { fy: '2026-27', accountId: rent, amountPaise: 1_20_000_00, notes: 'Lease' });
    await setBudgetLine(f.trx, f.orgId, null, { fy: '2026-27', accountId: rent, amountPaise: 1_44_000_00, notes: 'Lease, after the rise' });
    const row = await f.trx.selectFrom('budgets').select(['amount', 'notes']).where('org_id', '=', f.orgId).where('account_id', '=', rent).execute();
    assert.equal(row.length, 1, 'edited in place, not added again');
    assert.equal(toPaiseFromSql(row[0].amount), 1_44_000_00);
    assert.equal(row[0].notes, 'Lease, after the rise');
    await assert.rejects(setBudgetLine(f.trx, f.orgId, null, { fy: '2026-27', accountId: f.acc[CODE.AR], amountPaise: 1_00 }), /income or expense/);

    const gone = await deleteBudgetLine(f.trx, f.orgId, { fy: '2026-27', accountId: rent });
    assert.equal(gone.amountPaise, 1_44_000_00);
    assert.equal((await f.trx.selectFrom('budgets').select('id').where('org_id', '=', f.orgId).execute()).length, 0);
    await assert.rejects(deleteBudgetLine(f.trx, f.orgId, { fy: '2026-27', accountId: rent }), /no budget/);
  });
});

test('a cost centre: unused goes; one on a ledger line is refused as in use (retire it instead)', async () => {
  await withFixture(async (f) => {
    const spare = await saveCostCentre(f.trx, f.orgId, { code: 'SPARE', name: 'Spare' });
    assert.equal((await deleteCostCentre(f.trx, f.orgId, spare)).code, 'SPARE');

    const north = await saveCostCentre(f.trx, f.orgId, { code: 'NORTH', name: 'North depot' });
    const exp = await newAccount(f, '6994');
    await postEntry(f.trx, {
      orgId: f.orgId, branchId: f.branchId, date: '2026-10-01', sourceType: 'manual', module: 'accountant',
      lines: [{ accountId: exp, debit: 300_00, costCentreId: north }, { accountId: f.acc[CODE.BANK_DEFAULT], credit: 300_00 }],
    });
    await assert.rejects(deleteCostCentre(f.trx, f.orgId, north), (e) => code(e) === 'in_use' && /Retire it instead/.test((e as Error).message));
    // Edited (code, name) in place.
    await saveCostCentre(f.trx, f.orgId, { id: north, code: 'NTH', name: 'North yard', isActive: true });
    const c = await f.trx.selectFrom('cost_centres').select(['code', 'name']).where('id', '=', north).executeTakeFirstOrThrow();
    assert.deepEqual(c, { code: 'NTH', name: 'North yard' });
  });
});

test('a recurring journal profile: edited (accounts, amount, schedule), then deleted; nothing posts either way', async () => {
  await withFixture(async (f) => {
    const exp = await newAccount(f, '6995');
    const id = Number((await f.trx.insertInto('recurring_journals').values({
      org_id: f.orgId, branch_id: f.branchId, name: 'Rent accrual', frequency: 'monthly', next_run: '2026-11-30',
      debit_account_id: exp, credit_account_id: f.acc[CODE.BANK_DEFAULT], amount: '1000.0000', is_active: 1,
    }).executeTakeFirstOrThrow()).insertId);
    await updateRecurringJournal(f.trx, f.orgId, id, {
      name: 'Rent accrual, new lease', frequency: 'quarterly', nextRun: '2026-12-31', endDate: '2027-12-31',
      debitAccountId: exp, creditAccountId: f.acc[CODE.AP], amountPaise: 3_000_00, memo: 'Rent',
    });
    const p = await f.trx.selectFrom('recurring_journals').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    assert.equal(p.name, 'Rent accrual, new lease');
    assert.equal(p.frequency, 'quarterly');
    assert.equal(p.credit_account_id, f.acc[CODE.AP]);
    assert.equal(toPaiseFromSql(p.amount), 3_000_00);
    await assert.rejects(updateRecurringJournal(f.trx, f.orgId, id, {
      name: 'x', frequency: 'monthly', nextRun: '2026-12-31', debitAccountId: exp, creditAccountId: exp, amountPaise: 1_00,
    }), /different accounts/);
    await deleteRecurringJournal(f.trx, f.orgId, id);
    assert.equal((await f.trx.selectFrom('recurring_journals').select('id').where('id', '=', id).execute()).length, 0);
    assert.equal((await f.trx.selectFrom('journal_entries').select('id').where('org_id', '=', f.orgId).execute()).length, 0);
  });
});

test('a balance confirmation: the reply edited (agreed, disputed, cleared back to awaited), then deleted', async () => {
  await withFixture(async (f) => {
    const { id } = await requestConfirmation(f.trx, f.orgId, null, { contactId: f.customer, side: 'customer', asOf: '2026-09-30' });
    assert.equal((await updateConfirmation(f.trx, f.orgId, id, { theirBalancePaise: 0, notes: 'Nil both sides' })).status, 'agreed');
    assert.equal((await updateConfirmation(f.trx, f.orgId, id, { theirBalancePaise: 500_00 })).status, 'disputed');
    assert.equal((await updateConfirmation(f.trx, f.orgId, id, { theirBalancePaise: null })).status, 'requested');
    const row = await f.trx.selectFrom('balance_confirmations').select(['their_balance', 'responded_at']).where('id', '=', id).executeTakeFirstOrThrow();
    assert.equal(row.their_balance, null);
    assert.equal(row.responded_at, null);
    await deleteConfirmation(f.trx, f.orgId, id);
    await assert.rejects(deleteConfirmation(f.trx, f.orgId, id), /does not exist/);
  });
});

test('an exchange rate edited and deleted; a restatement deleted nets every day back, and the date can be restated again', async () => {
  await withFixture(async (f) => {
    await setRate(f.trx, f.orgId, { currency: 'USD', date: '2026-06-29', rate: 83.5 });
    await setRate(f.trx, f.orgId, { currency: 'USD', date: '2026-06-30', rate: 84 });
    const [r29, r30] = await f.trx.selectFrom('exchange_rates').select(['id', 'rate_date']).where('org_id', '=', f.orgId).orderBy('rate_date').execute();
    await assert.rejects(editRate(f.trx, f.orgId, r29.id, { date: '2026-06-30', rate: 83.6 }), /already a USD rate/);
    await editRate(f.trx, f.orgId, r29.id, { date: '2026-06-28', rate: 83.6 });
    assert.equal((await deleteRate(f.trx, f.orgId, r29.id)).rate, 83.6);

    await createInvoice(f.trx, f.orgId, null, {
      branchId: f.branchId, customerId: f.overseas, date: '2026-06-01', dueDate: '2026-06-01', status: 'approved', currency: 'USD', exchangeRate: 83,
      lines: [{ description: 'Brake discs', hsnSac: '8708', qty: 1, ratePaise: 1_000_00, gstRatePct: 18 }],
    });
    const before = { ar30: await balance(f, CODE.AR, '2026-06-30'), ar: await balance(f, CODE.AR) };
    const r = await revalue(f.trx, f.orgId, null, '2026-06-30');
    assert.equal(await balance(f, CODE.FX_GAIN, '2026-06-30'), -1_000_00, 'a gain of ₹1,000 in June');
    const listed = await listRestatements(f.trx, f.orgId);
    assert.deepEqual(listed.map((x) => [x.entryId, x.date, x.reversedOn]), [[String(r.entryId), '2026-06-30', '2026-07-01']]);

    const gone = await deleteRestatement(f.trx, f.orgId, null, r.entryId, 'Wrong date');
    assert.equal(gone.date, '2026-06-30');
    assert.equal(await balance(f, CODE.FX_GAIN, '2026-06-30'), 0, 'June nets back to nothing');
    assert.equal(await balance(f, CODE.FX_GAIN), 0, 'and so does every day after');
    assert.equal(await balance(f, CODE.AR, '2026-06-30'), before.ar30);
    assert.equal(await balance(f, CODE.AR), before.ar);
    assert.deepEqual(await listRestatements(f.trx, f.orgId), [], 'no longer listed');
    const kept = await f.trx.selectFrom('deleted_documents').select(['doc_type', 'reason']).where('org_id', '=', f.orgId).execute();
    assert.deepEqual(kept, [{ doc_type: 'fx_restatement', reason: 'Wrong date' }]);
    await assert.rejects(deleteRestatement(f.trx, f.orgId, null, r.entryId), /already deleted/);

    // The date is free again.
    const again = await revalue(f.trx, f.orgId, null, '2026-06-30');
    assert.equal(again.netPaise, 1_000_00);
    assert.equal(await balance(f, CODE.FX_GAIN, '2026-06-30'), -1_000_00);
    assert.equal(r30.rate_date.slice(0, 10), '2026-06-30');
    assert.equal((await verifyLedgerBalances(f.trx, f.orgId)).balanced, true);
  });
});

test('an opening bill edited: its entry reversed and reposted on the same row; refused once paid against', async () => {
  await withFixture(async (f) => {
    await setBooksStartDate(f.trx, f.orgId, '2026-04-01');
    const { id } = await addOpeningDocument(f.trx, f.orgId, null, {
      branchId: f.branchId, contactId: f.customer, kind: 'receivable', refNo: 'OB-1', docDate: '2026-03-10', dueDate: '2026-04-09', amountPaise: 10_000_00,
    });
    assert.equal(await balance(f, CODE.AR), 10_000_00);
    // Only its dates: nothing reposts.
    const dates = await editOpeningDocument(f.trx, f.orgId, null, id, {
      contactId: f.customer, kind: 'receivable', refNo: 'OB-1', docDate: '2026-03-12', dueDate: '2026-04-30', amountPaise: 10_000_00,
    });
    assert.equal(dates.reposted, false);
    // The amount: reversed and reposted.
    const r = await editOpeningDocument(f.trx, f.orgId, null, id, {
      contactId: f.customer, kind: 'receivable', refNo: 'OB-1A', docDate: '2026-03-12', dueDate: '2026-04-30', amountPaise: 12_500_00,
    });
    assert.equal(r.reposted, true);
    assert.equal(await balance(f, CODE.AR), 12_500_00);
    assert.equal(await balance(f, CODE.OPENING_BALANCE_EQUITY), -12_500_00);
    const row = await f.trx.selectFrom('opening_documents').select(['ref_no', 'amount', 'due_date', 'journal_entry_id']).where('id', '=', id).executeTakeFirstOrThrow();
    assert.equal(row.ref_no, 'OB-1A');
    assert.equal(toPaiseFromSql(row.amount), 12_500_00);
    const entries = await f.trx.selectFrom('journal_entries').select(['id', 'reversal_of_entry_id']).where('org_id', '=', f.orgId).where('source_type', '=', 'opening_document').execute();
    assert.equal(entries.length, 3, 'the first, its reversal, the corrected one');
    assert.equal(entries.filter((e) => !e.reversal_of_entry_id).at(-1)!.id, row.journal_entry_id);

    await receivePayment(f.trx, f.orgId, null, {
      branchId: f.branchId, contactId: f.customer, date: '2026-05-02', mode: 'neft', amountPaise: 2_000_00, bankAccountId: f.bankId,
      allocations: [{ targetType: 'opening', targetId: id, amountPaise: 2_000_00 }],
    } as never);
    await assert.rejects(editOpeningDocument(f.trx, f.orgId, null, id, {
      contactId: f.customer, kind: 'receivable', refNo: 'OB-1A', docDate: '2026-03-12', dueDate: '2026-04-30', amountPaise: 9_000_00,
    }), /paid against/);
    assert.equal((await verifyLedgerBalances(f.trx, f.orgId)).balanced, true);
  });
});

test('a fixed asset deleted: what adding it posted is reversed; refused while depreciation stands; a class holding it is kept', async () => {
  await withFixture(async (f) => {
    const cls = Number((await listAssetClasses(f.trx, f.orgId)).find((c) => c.name === 'Computers & Peripherals')!.id);
    const a = await addAsset(f.trx, f.orgId, null, {
      branchId: f.branchId, classId: cls, name: 'Laptop', acquiredOn: '2026-04-10', putToUseOn: '2026-04-10',
      costPaise: 90_000_00, source: { kind: 'paid', fromAccountId: f.acc[CODE.BANK_DEFAULT] },
    });
    await f.trx.insertInto('asset_verifications').values({ org_id: f.orgId, asset_id: a.id, verified_on: '2026-05-01', found: 1 } as never).execute();
    await runDepreciation(f.trx, f.orgId, null, f.branchId, '2026-06-30');
    await assert.rejects(deleteAsset(f.trx, f.orgId, null, a.id), /Undo those depreciation runs first/);
    await assert.rejects(deleteAssetClass(f.trx, f.orgId, cls), /holds 1 asset/);
    await reverseLatestRun(f.trx, f.orgId, null, f.branchId);

    const gone = await deleteAsset(f.trx, f.orgId, null, a.id, 'Bought by the director personally');
    assert.equal(gone.reversed, 1);
    assert.equal(await balance(f, CODE.BANK_DEFAULT), 0, 'the bank has its money back in the books');
    assert.equal(await balance(f, CODE.COMPUTERS), 0);
    assert.equal(await balance(f, CODE.ACCUMULATED_DEPRECIATION), 0);
    assert.equal((await f.trx.selectFrom('fixed_assets').select('id').where('id', '=', a.id).execute()).length, 0);
    assert.equal((await f.trx.selectFrom('asset_costs').select('id').where('asset_id', '=', a.id).execute()).length, 0);
    const kept = await f.trx.selectFrom('deleted_documents').select(['doc_type', 'number', 'reason']).where('org_id', '=', f.orgId).execute();
    assert.deepEqual(kept, [{ doc_type: 'fixed_asset', number: a.tagNo, reason: 'Bought by the director personally' }]);
    // The class is now empty and can go.
    assert.equal((await deleteAssetClass(f.trx, f.orgId, cls)).name, 'Computers & Peripherals');
    assert.equal((await verifyLedgerBalances(f.trx, f.orgId)).balanced, true);
  });
});

test('a business document deleted: its files go back to the inbox, unattached; the record is kept', async () => {
  await withFixture(async (f) => {
    const id = Number((await f.trx.insertInto('documents').values({ org_id: f.orgId, title: 'Warehouse lease', category: 'agreement', reference: 'L-7' }).executeTakeFirstOrThrow()).insertId);
    const fileId = Number((await f.trx.insertInto('files').values({
      org_id: f.orgId, filename: 'lease.pdf', content_type: 'application/pdf', size_bytes: 10, storage_key: `k-${id}`, attached_to_type: 'document', attached_to_id: id,
    } as never).executeTakeFirstOrThrow()).insertId);
    const gone = await deleteBusinessDocument(f.trx, f.orgId, null, id, 'Lease ended');
    assert.deepEqual(gone, { title: 'Warehouse lease', filesKept: 1 });
    const file = await f.trx.selectFrom('files').select(['attached_to_type', 'attached_to_id']).where('id', '=', fileId).executeTakeFirstOrThrow();
    assert.deepEqual(file, { attached_to_type: null, attached_to_id: null });
    assert.equal((await f.trx.selectFrom('documents').select('id').where('id', '=', id).execute()).length, 0);
    const kept = await f.trx.selectFrom('deleted_documents').select(['doc_type', 'number']).where('org_id', '=', f.orgId).execute();
    assert.deepEqual(kept, [{ doc_type: 'business_document', number: 'L-7' }]);
  });
});
