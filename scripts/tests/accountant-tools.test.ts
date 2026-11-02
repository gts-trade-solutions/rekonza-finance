// Zoho's Accountant tools (migration 095): journal templates, and bulk update —
// lines moved from one account to another by one reclassification journal,
// never by rewriting what was posted.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/accountant-tools.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { createExpense } from '../../lib/server/services/purchases';
import { reverseEntry } from '../../lib/server/ledger/posting';
import {
  bulkReclassify, deleteJournalTemplate, listJournalTemplates, reclassCandidates, saveJournalTemplate,
} from '../../lib/server/services/accountant-tools';

interface Book { trx: Trx; orgId: number; branchId: number; bankId: number; acc: Record<string, number> }

async function withBook(fn: (b: Book) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Tools Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1, gstin: '33AABCT9595T1Z8' }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const acc = await accountIds(trx, orgId) as Record<string, number>;
      const bankId = Number((await trx.insertInto('bank_accounts').values({ org_id: orgId, kind: 'bank', name: 'Current', ledger_account_id: acc[CODE.BANK_DEFAULT], opening_balance: '0.0000' }).executeTakeFirstOrThrow()).insertId);
      await fn({ trx, orgId, branchId, bankId, acc });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

const balance = async (trx: Trx, orgId: number, accountId: number) => {
  const { rows } = await sql<{ n: string | null }>`SELECT SUM(debit) - SUM(credit) AS n FROM journal_lines WHERE org_id = ${orgId} AND account_id = ${accountId}`.execute(trx);
  return Math.round(Number(rows[0].n ?? 0) * 100);
};

test('journal templates: saved with or without amounts, balanced when with; names unique; deleted', async () => {
  await withBook(async ({ trx, orgId, acc }) => {
    const rent = { name: 'Monthly rent accrual', memo: 'Rent for the month', withAmounts: true, lines: [
      { accountId: acc[CODE.RENT], debitPaise: 50_000_00, creditPaise: 0, description: 'Rent', contactId: null, costCentreId: null },
      { accountId: acc[CODE.PROVISIONS], debitPaise: 0, creditPaise: 50_000_00, description: null, contactId: null, costCentreId: null },
    ] };
    const id = await saveJournalTemplate(trx, orgId, null, rent);
    await assert.rejects(saveJournalTemplate(trx, orgId, null, rent), /already a template called/);
    await assert.rejects(saveJournalTemplate(trx, orgId, null, { ...rent, name: 'Lopsided', lines: [rent.lines[0], { ...rent.lines[1], creditPaise: 40_000_00 }] }), /must balance/);
    await assert.rejects(saveJournalTemplate(trx, orgId, null, { ...rent, name: 'One line', lines: [rent.lines[0]] }), /at least two lines/);
    await assert.rejects(saveJournalTemplate(trx, orgId, null, { ...rent, name: 'Both', lines: [{ ...rent.lines[0], creditPaise: 1 }, rent.lines[1]] }), /debit or a credit/);
    // Without amounts, only the accounts are kept, whatever was typed.
    const shape = await saveJournalTemplate(trx, orgId, null, { ...rent, name: 'Salary provision', withAmounts: false, lines: [
      { ...rent.lines[0], accountId: acc[CODE.SALARIES], debitPaise: 123 }, { ...rent.lines[1], accountId: acc[CODE.SALARIES_PAYABLE], creditPaise: 7 },
    ] });
    const list = await listJournalTemplates(trx, orgId);
    assert.deepEqual(list.map((t) => [t.name, t.withAmounts, t.totalPaise]), [['Monthly rent accrual', true, 50_000_00], ['Salary provision', false, 0]]);
    assert.equal(list[0].lines[0].accountName, 'Rent');
    assert.deepEqual(list[1].lines.map((l) => [l.debitPaise, l.creditPaise]), [[0, 0], [0, 0]]);

    await saveJournalTemplate(trx, orgId, null, { ...rent, id, name: 'Rent accrual', memo: 'Changed' });
    assert.deepEqual((await listJournalTemplates(trx, orgId)).map((t) => t.name), ['Rent accrual', 'Salary provision']);
    assert.equal(await deleteJournalTemplate(trx, orgId, shape), 'Salary provision');
    await assert.rejects(deleteJournalTemplate(trx, orgId, shape), /not found/);
  });
});

test('bulk update: chosen lines move by one reclassification journal; the originals stay; moved lines are not offered again until reversed', async () => {
  await withBook(async ({ trx, orgId, branchId, bankId, acc }) => {
    const spend = (date: string, paise: number, notes: string) => createExpense(trx, orgId, null, { branchId, date, accountId: acc[CODE.OFFICE], paidThroughBankAccountId: bankId, amountPaise: paise, notes });
    await spend('2026-09-03', 2_000_00, 'Diesel for the van');
    await spend('2026-09-10', 1_500_00, 'Petrol');
    await spend('2026-09-12', 800_00, 'Printer paper');
    await spend('2026-10-02', 900_00, 'Diesel, October');

    const all = await reclassCandidates(trx, orgId, { fromAccountId: acc[CODE.OFFICE], from: '2026-09-01', to: '2026-09-30' });
    assert.equal(all.length, 3, 'only September, only the office account');
    const fuelish = all.filter((l) => l.debitPaise !== 800_00);
    assert.deepEqual(fuelish.map((l) => l.debitPaise), [2_000_00, 1_500_00]);
    const searched = await reclassCandidates(trx, orgId, { fromAccountId: acc[CODE.OFFICE], from: '2026-09-01', to: '2026-10-31', search: 'diesel' });
    assert.equal(searched.length, 2, 'the search finds the narration');

    const before = await trx.selectFrom('journal_lines').select(['id', 'account_id', 'debit']).where('org_id', '=', orgId).where('account_id', '=', acc[CODE.OFFICE]).execute();
    const r = await bulkReclassify(trx, orgId, null, { fromAccountId: acc[CODE.OFFICE], toAccountId: acc[CODE.FUEL], lineIds: fuelish.map((l) => Number(l.id)), date: '2026-09-30' });
    assert.equal(r.entries.length, 1);
    assert.equal(r.movedPaise, 3_500_00);
    assert.equal(await balance(trx, orgId, acc[CODE.FUEL]), 3_500_00);
    assert.equal(await balance(trx, orgId, acc[CODE.OFFICE]), 1_700_00, '₹800 paper and ₹900 October stay');
    const after = await trx.selectFrom('journal_lines').select(['id', 'account_id', 'debit']).where('id', 'in', before.map((b) => b.id)).execute();
    assert.deepEqual(after.map((a) => a.account_id), before.map((b) => b.account_id), 'the posted lines are untouched');
    const entry = await trx.selectFrom('journal_entries').select(['source_type', 'memo', 'entry_date']).where('id', '=', r.entries[0].id).executeTakeFirstOrThrow();
    assert.equal(entry.source_type, 'reclassification');
    assert.match(entry.memo ?? '', /2 line\(s\) moved from Office Supplies to Fuel/);

    const left = await reclassCandidates(trx, orgId, { fromAccountId: acc[CODE.OFFICE], from: '2026-09-01', to: '2026-09-30' });
    assert.deepEqual(left.map((l) => l.debitPaise), [800_00], 'moved lines, and the reclassification itself, are not offered');
    await assert.rejects(bulkReclassify(trx, orgId, null, { fromAccountId: acc[CODE.OFFICE], toAccountId: acc[CODE.FUEL], lineIds: [Number(fuelish[0].id)], date: '2026-09-30' }), /moved already/);

    // Sub-ledger accounts cannot be moved into or out of.
    await assert.rejects(bulkReclassify(trx, orgId, null, { fromAccountId: acc[CODE.OFFICE], toAccountId: acc[CODE.AR], lineIds: [Number(left[0].id)], date: '2026-09-30' }), /sub-ledger/);
    await assert.rejects(reclassCandidates(trx, orgId, { fromAccountId: acc[CODE.BANK_DEFAULT], from: '2026-09-01', to: '2026-09-30' }), /sub-ledger|bank or cash/);
    await assert.rejects(bulkReclassify(trx, orgId, null, { fromAccountId: acc[CODE.OFFICE], toAccountId: acc[CODE.OFFICE], lineIds: [Number(left[0].id)], date: '2026-09-30' }), /different account/);
    await assert.rejects(bulkReclassify(trx, orgId, null, { fromAccountId: acc[CODE.RENT], toAccountId: acc[CODE.FUEL], lineIds: [Number(left[0].id)], date: '2026-09-30' }), /not on Rent/);

    // Reversing the reclassification puts everything back and frees the lines.
    await reverseEntry(trx, orgId, r.entries[0].id, { date: '2026-09-30', memo: 'Undo', userId: null, module: 'accountant' });
    assert.equal(await balance(trx, orgId, acc[CODE.FUEL]), 0);
    assert.equal((await reclassCandidates(trx, orgId, { fromAccountId: acc[CODE.OFFICE], from: '2026-09-01', to: '2026-09-30' })).length, 3);
  });
});

test.after(() => db.destroy());
