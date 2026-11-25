// Edit and Delete in Banking (services/banking-changes.ts, the cash book's
// recount, and report rows reaching their documents: reports/entry-refs.ts),
// against real MySQL inside rolled-back transactions.
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/banking-edit-delete.test.ts
//
// What has to hold: a transfer or a cash count is changed by reversing what it
// posted on its own date and posting the corrected one, never by touching the
// entry, and deleted by the reversal alone, with deleted_documents keeping it;
// anything a bank statement line is matched to is refused until the match is
// undone; a statement line is corrected or deleted only while uncategorised;
// a cheque in the register only while it is still paper.

import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { postEntry, verifyLedgerBalances } from '../../lib/server/ledger/posting';
import { toPaiseFromSql } from '../../lib/server/money-sql';
import { createTransfer } from '../../lib/server/services/banking';
import {
  deleteCashCount, deleteCheque, deleteStatementLine, deleteTransfer, editCheque, editStatementLine, editTransfer,
} from '../../lib/server/services/banking-changes';
import { countCash, recountCash } from '../../lib/server/reports/cash-book';
import { entryLinks, missingSourceIds } from '../../lib/server/reports/entry-refs';
import { addBankTransaction } from '../../lib/server/services/bank-match';
import { deleteJournal } from '../../lib/server/services/journals';

interface Fixture { trx: Trx; orgId: number; branchId: number; acc: Record<string, number>; bankId: number; cashId: number; customer: number; vendor: number }

async function withFixture(fn: (f: Fixture) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Banking Edit Delete Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1 }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const acc = await accountIds(trx, orgId);
      const bankId = Number((await trx.insertInto('bank_accounts').values({
        org_id: orgId, kind: 'bank', name: 'Current', ledger_account_id: acc[CODE.BANK_DEFAULT], opening_balance: '0.0000',
      }).executeTakeFirstOrThrow()).insertId);
      const cashId = Number((await trx.insertInto('bank_accounts').values({
        org_id: orgId, kind: 'cash', name: 'Counter cash', ledger_account_id: acc[CODE.CASH], opening_balance: '0.0000',
      }).executeTakeFirstOrThrow()).insertId);
      const mk = async (v: Record<string, unknown>) =>
        Number((await trx.insertInto('contacts').values({ org_id: orgId, state_code: '33', gst_treatment: 'unregistered', ...v } as never).executeTakeFirstOrThrow()).insertId);
      await fn({
        trx, orgId, branchId, acc, bankId, cashId,
        customer: await mk({ kind: 'customer', display_name: 'Ravi Motors' }),
        vendor: await mk({ kind: 'vendor', display_name: 'Steel Mart' }),
      });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

test.after(() => db.destroy());

const balance = async (f: Fixture, code: string) => toPaiseFromSql((await sql<{ b: string }>`
  SELECT COALESCE(SUM(debit - credit), 0) AS b FROM journal_lines WHERE org_id = ${f.orgId} AND account_id = ${f.acc[code]}
`.execute(f.trx)).rows[0].b);
const fund = (f: Fixture, paise: number) => postEntry(f.trx, {
  orgId: f.orgId, branchId: f.branchId, date: '2026-04-01', sourceType: 'manual', module: 'accountant',
  lines: [{ accountId: f.acc[CODE.BANK_DEFAULT], debit: paise }, { accountId: f.acc[CODE.CAPITAL], credit: paise }],
});
const statementLine = async (f: Fixture, v: Record<string, unknown>) => Number((await f.trx.insertInto('bank_transactions').values({
  org_id: f.orgId, bank_account_id: f.bankId, txn_date: '2026-10-05', narration: 'NEFT IN', deposit: '0.0000', withdrawal: '0.0000',
  dedupe_hash: `h${Math.random()}`, ...v,
} as never).executeTakeFirstOrThrow()).insertId);

test('a transfer names itself on its entry; edited by reverse and repost; deleted by reversal; refused while a bank line is matched to it', async () => {
  await withFixture(async (f) => {
    await fund(f, 50_000_00);
    const t = await createTransfer(f.trx, f.orgId, null, { fromBankAccountId: f.bankId, toBankAccountId: f.cashId, date: '2026-10-01', amountPaise: 10_000_00 });
    const entry = await f.trx.selectFrom('journal_entries').select(['source_type', 'source_id']).where('id', '=', t.journalEntryId).executeTakeFirstOrThrow();
    assert.deepEqual(entry, { source_type: 'transfer', source_id: t.id }, 'the entry reaches the transfer');
    assert.equal(await balance(f, CODE.CASH), 10_000_00);

    await editTransfer(f.trx, f.orgId, null, t.id, { fromBankAccountId: f.bankId, toBankAccountId: f.cashId, date: '2026-10-02', amountPaise: 12_500_00, reference: 'Petty cash' });
    assert.equal(await balance(f, CODE.CASH), 12_500_00);
    assert.equal(await balance(f, CODE.BANK_DEFAULT), 37_500_00);
    const row = await f.trx.selectFrom('bank_transfers').selectAll().where('id', '=', t.id).executeTakeFirstOrThrow();
    assert.equal(toPaiseFromSql(row.amount), 12_500_00);
    assert.equal(String(row.transfer_date).slice(0, 10), '2026-10-02');
    assert.notEqual(row.journal_entry_id, t.journalEntryId, 'on the same row, a new entry');
    const links = await entryLinks(f.trx, f.orgId, [t.journalEntryId]);
    assert.ok(links.get(t.journalEntryId)?.reversedBy, 'the old entry shows as reversed');

    // A statement line matched to it: refused until unmatched.
    const lineId = await statementLine(f, { withdrawal: '12500.0000', status: 'matched', matched_type: 'transfer', matched_id: t.id });
    await assert.rejects(deleteTransfer(f.trx, f.orgId, null, t.id), /matched to a bank statement line/);
    await assert.rejects(editTransfer(f.trx, f.orgId, null, t.id, { fromBankAccountId: f.bankId, toBankAccountId: f.cashId, date: '2026-10-02', amountPaise: 1_00 }), /matched/);
    await f.trx.updateTable('bank_transactions').set({ status: 'unmatched', matched_type: null, matched_id: null }).where('id', '=', lineId).execute();

    await deleteTransfer(f.trx, f.orgId, null, t.id, 'Never happened');
    assert.equal(await balance(f, CODE.CASH), 0);
    assert.equal(await balance(f, CODE.BANK_DEFAULT), 50_000_00);
    assert.equal((await f.trx.selectFrom('bank_transfers').select('id').where('id', '=', t.id).execute()).length, 0);
    const kept = await f.trx.selectFrom('deleted_documents').select(['doc_type', 'reason']).where('org_id', '=', f.orgId).execute();
    assert.deepEqual(kept, [{ doc_type: 'transfer', reason: 'Never happened' }]);
    assert.equal((await verifyLedgerBalances(f.trx, f.orgId)).balanced, true);
  });
});

test('an older transfer whose entry names no document is still found from the transfer', async () => {
  await withFixture(async (f) => {
    const e = await postEntry(f.trx, {
      orgId: f.orgId, branchId: f.branchId, date: '2026-09-01', sourceType: 'transfer', module: 'banking',
      lines: [{ accountId: f.acc[CODE.CASH], debit: 1_000_00 }, { accountId: f.acc[CODE.BANK_DEFAULT], credit: 1_000_00 }],
    });
    const id = Number((await f.trx.insertInto('bank_transfers').values({
      org_id: f.orgId, from_bank_account_id: f.bankId, to_bank_account_id: f.cashId, transfer_date: '2026-09-01', amount: '1000.0000', journal_entry_id: e.id,
    }).executeTakeFirstOrThrow()).insertId);
    const found = await missingSourceIds(f.trx, f.orgId, [{ entryId: e.id, sourceType: 'transfer', sourceId: null }]);
    assert.equal(found.get(e.id), String(id));
  });
});

test('a cheque edited while in hand, refused once cleared; deleted unless cleared or returned', async () => {
  await withFixture(async (f) => {
    const mk = async (status: string, extra: Record<string, unknown> = {}) => Number((await f.trx.insertInto('cheques').values({
      org_id: f.orgId, kind: 'received', contact_id: f.customer, cheque_no: `C${status}`, amount: '5000.0000', maturity_date: '2026-12-01', status, ...extra,
    } as never).executeTakeFirstOrThrow()).insertId);
    const inHand = await mk('in_hand');
    await editCheque(f.trx, f.orgId, inHand, {
      kind: 'received', contactId: f.customer, chequeNo: '000777', bankName: 'SBI', amountPaise: 6_000_00, maturityDate: '2026-12-15', notes: 'PDC',
    }, '2026-11-25');
    const c = await f.trx.selectFrom('cheques').selectAll().where('id', '=', inHand).executeTakeFirstOrThrow();
    assert.equal(c.cheque_no, '000777');
    assert.equal(toPaiseFromSql(c.amount), 6_000_00);
    assert.equal(c.is_pdc, 1, 'dated after today: post-dated');

    const cleared = await mk('cleared');
    await assert.rejects(editCheque(f.trx, f.orgId, cleared, {
      kind: 'received', contactId: f.customer, chequeNo: 'x', amountPaise: 1_00, maturityDate: '2026-12-01',
    }), /only a cheque in hand or deposited/);
    await assert.rejects(deleteCheque(f.trx, f.orgId, cleared), /has cleared/);
    await assert.rejects(deleteCheque(f.trx, f.orgId, await mk('bounced')), /came back/);
    assert.equal((await deleteCheque(f.trx, f.orgId, inHand)).chequeNo, '000777');
    assert.equal((await deleteCheque(f.trx, f.orgId, await mk('cancelled'))).chequeNo, 'Ccancelled');
  });
});

test('a statement line corrected and deleted while uncategorised; its import follows; refused once categorised', async () => {
  await withFixture(async (f) => {
    const imp = Number((await f.trx.insertInto('bank_statement_imports').values({
      org_id: f.orgId, bank_account_id: f.bankId, filename: 'oct.csv', rows_total: 2, rows_imported: 2, rows_duplicate: 0,
    } as never).executeTakeFirstOrThrow()).insertId);
    const a = await statementLine(f, { deposit: '1200.0000', import_batch_id: imp });
    const b = await statementLine(f, { deposit: '300.0000', import_batch_id: imp });
    await editStatementLine(f.trx, f.orgId, a, { date: '2026-10-06', narration: 'NEFT IN RAVI MOTORS', reference: 'UTR9', depositPaise: 0, withdrawalPaise: 1_200_00 });
    const l = await f.trx.selectFrom('bank_transactions').selectAll().where('id', '=', a).executeTakeFirstOrThrow();
    assert.equal(l.narration, 'NEFT IN RAVI MOTORS');
    assert.equal(toPaiseFromSql(l.withdrawal), 1_200_00);
    assert.equal(toPaiseFromSql(l.deposit), 0);
    await assert.rejects(editStatementLine(f.trx, f.orgId, a, { date: '2026-10-06', narration: 'x', depositPaise: 1_00, withdrawalPaise: 1_00 }), /either money in/);

    await deleteStatementLine(f.trx, f.orgId, a);
    assert.equal((await f.trx.selectFrom('bank_statement_imports').select('rows_imported').where('id', '=', imp).executeTakeFirstOrThrow()).rows_imported, 1);
    await f.trx.updateTable('bank_transactions').set({ status: 'matched', matched_type: 'journal_entry', matched_id: 1 }).where('id', '=', b).execute();
    await assert.rejects(deleteStatementLine(f.trx, f.orgId, b), /categorised or matched/);
    await assert.rejects(editStatementLine(f.trx, f.orgId, b, { date: '2026-10-06', narration: 'x', depositPaise: 1_00, withdrawalPaise: 0 }), /Uncategorize/);
    await f.trx.updateTable('bank_transactions').set({ status: 'excluded', matched_type: null, matched_id: null }).where('id', '=', b).execute();
    await deleteStatementLine(f.trx, f.orgId, b);
    assert.equal((await f.trx.selectFrom('bank_statement_imports').select('id').where('id', '=', imp).execute()).length, 0, 'the import, left empty, goes too');
  });
});

test('a cash count names itself on its short entry; recounted (edited) and deleted by reversal', async () => {
  await withFixture(async (f) => {
    await postEntry(f.trx, {
      orgId: f.orgId, branchId: f.branchId, date: '2026-06-01', sourceType: 'manual', module: 'banking',
      lines: [{ accountId: f.acc[CODE.CASH], debit: 4_000_00 }, { accountId: f.acc[CODE.BANK_DEFAULT], credit: 4_000_00 }],
    });
    const short = await countCash(f.trx, f.orgId, null, { bankAccountId: f.cashId, date: '2026-06-30', pieces: { 500: 7 } });
    assert.equal(short.differencePaise, -500_00);
    const e = await f.trx.selectFrom('journal_entries').select(['source_type', 'source_id']).where('id', '=', Number(short.journalEntryId)).executeTakeFirstOrThrow();
    assert.deepEqual(e, { source_type: 'cash_count', source_id: Number(short.id) });
    assert.equal(await balance(f, CODE.CASH), 3_500_00);

    // Counted again: the first count is undone, the cash agrees.
    const again = await recountCash(f.trx, f.orgId, null, Number(short.id), { date: '2026-06-30', pieces: { 500: 8 } });
    assert.equal(again.differencePaise, 0);
    assert.equal(await balance(f, CODE.CASH), 4_000_00);
    assert.equal(await balance(f, CODE.CASH_SHORT_EXCESS), 0);
    assert.equal((await f.trx.selectFrom('cash_counts').select('id').where('org_id', '=', f.orgId).execute()).length, 1);

    const excess = await countCash(f.trx, f.orgId, null, { bankAccountId: f.cashId, date: '2026-07-01', pieces: { 500: 9 } });
    assert.equal(await balance(f, CODE.CASH), 4_500_00);
    const gone = await deleteCashCount(f.trx, f.orgId, null, Number(excess.id), 'Counted twice');
    assert.equal(gone.reversed, true);
    assert.equal(await balance(f, CODE.CASH), 4_000_00);
    assert.deepEqual(await f.trx.selectFrom('deleted_documents').select(['doc_type', 'reason']).where('org_id', '=', f.orgId).execute(),
      [{ doc_type: 'cash_count', reason: 'Counted twice' }]);
    assert.equal((await verifyLedgerBalances(f.trx, f.orgId)).balanced, true);
  });
});

test('money typed in on a bank account (Add Transaction) is deleted as a journal: its entry reversed', async () => {
  await withFixture(async (f) => {
    const r = await addBankTransaction(f.trx, f.orgId, null, f.bankId, {
      category: 'owner_contribution', date: '2026-10-03', amountPaise: 25_000_00, accountId: f.acc[CODE.CAPITAL], notes: 'Capital brought in',
    });
    assert.equal(r.targetType, 'journal_entry');
    assert.equal(await balance(f, CODE.BANK_DEFAULT), 25_000_00);
    const src = await f.trx.selectFrom('journal_entries').select('source_type').where('id', '=', r.targetId).executeTakeFirstOrThrow();
    assert.equal(src.source_type, 'bank_entry');
    await deleteJournal(f.trx, f.orgId, null, r.targetId, 'Entered on the wrong account');
    assert.equal(await balance(f, CODE.BANK_DEFAULT), 0);
  });
});
