// Voucher reversal as the auditors test it (status review 7, item 4): a
// journal reversed on a chosen date for a reason, linked both ways, once only;
// refused in a locked period or closed year with the first open date; under a
// journal approval rule, maker and checker; the auto-reversing accrual posted
// on its date; and every document voucher (sales, purchase, receipt, payment,
// contra) undone by a reversing entry, never by deleting its history.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/sr7-voucher-reversal.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { verifyLedgerBalances } from '../../lib/server/ledger/posting';
import { postManualJournal } from '../../lib/server/services/journals';
import { saveJournal, approveHeldJournal, releaseHeldJournal } from '../../lib/server/services/held-journals';
import { requestReversal, reversalRegister } from '../../lib/server/services/voucher-reversals';
import { saveRule } from '../../lib/server/services/approvals';
import { runScheduledPostings } from '../../lib/server/services/scheduler';
import { createInvoice, voidInvoice } from '../../lib/server/services/sales';
import { createBill, voidBill } from '../../lib/server/services/purchases';
import { makePayment, receivePayment, voidPayment } from '../../lib/server/services/payments';
import { createTransfer } from '../../lib/server/services/banking';
import { deleteTransfer } from '../../lib/server/services/banking-changes';
import { trialBalance, profitAndLoss } from '../../lib/server/reports/statements';
import { ApiError } from '../../lib/server/http';

interface Fixture {
  trx: Trx; orgId: number; branchId: number; acc: Record<string, number>;
  customer: number; vendor: number; bank: number; cash: number; maker: number; checker: number;
}

async function withFixture(fn: (f: Fixture) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Reversal Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1 }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const acc = await accountIds(trx, orgId);
      const mk = async (v: Record<string, unknown>) =>
        Number((await trx.insertInto('contacts').values({ org_id: orgId, state_code: '33', gst_treatment: 'unregistered', ...v } as never).executeTakeFirstOrThrow()).insertId);
      const bankAcc = async (name: string, code: string, kind: 'bank' | 'cash') =>
        Number((await trx.insertInto('bank_accounts').values({ org_id: orgId, kind, name, ledger_account_id: acc[code], opening_balance: '0', is_active: 1 } as never).executeTakeFirstOrThrow()).insertId);
      const user = async (name: string) =>
        Number((await trx.insertInto('users').values({ org_id: orgId, name, email: `${name}-${orgId}@example.test`, role: 'accountant' }).executeTakeFirstOrThrow()).insertId);
      await fn({
        trx, orgId, branchId, acc,
        customer: await mk({ kind: 'customer', display_name: 'Sharma Traders' }),
        vendor: await mk({ kind: 'vendor', display_name: 'Metro Supplies' }),
        bank: await bankAcc('HDFC Current', CODE.BANK_DEFAULT, 'bank'),
        cash: await bankAcc('Cash in Hand', CODE.CASH, 'cash'),
        maker: await user('maker'), checker: await user('checker'),
      });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

const rent = (f: Fixture, date: string, rupees: number, extra: Record<string, unknown> = {}) => postManualJournal(f.trx, f.orgId, f.maker, {
  branchId: f.branchId, date, memo: 'Office rent for October',
  lines: [{ accountId: f.acc[CODE.RENT], debitPaise: rupees * 100 }, { accountId: f.acc[CODE.BANK_DEFAULT], creditPaise: rupees * 100 }],
  ...extra,
});

const netOf = async (f: Fixture, code: string, to = '2099-12-31') => Number((await sql<{ n: string }>`
  SELECT COALESCE(SUM(debit - credit), 0) AS n FROM journal_lines WHERE org_id = ${f.orgId} AND account_id = ${f.acc[code]} AND entry_date <= ${to}`.execute(f.trx)).rows[0].n);

test('a journal reversed on a chosen date: Dr and Cr swapped, linked both ways, reason kept, once only, nets to nil', async () => {
  await withFixture(async (f) => {
    const jv = await rent(f, '2026-10-31', 50_000);
    const r = await requestReversal(f.trx, f.orgId, f.maker, jv.id, { date: '2026-11-05', reason: 'Rent was paid by the landlord deposit' });
    assert.equal(r.held, false);
    if (r.held) return;
    const rev = await f.trx.selectFrom('journal_entries').selectAll().where('id', '=', r.reversalId).executeTakeFirstOrThrow();
    assert.equal(rev.reversal_of_entry_id, jv.id, 'the reversal names the entry it reverses');
    assert.equal(String(rev.entry_date).slice(0, 10), '2026-11-05');
    assert.match(rev.memo ?? '', new RegExp(`Reversal of #${jv.entryNo}: Rent was paid`));
    const lines = await f.trx.selectFrom('journal_lines').select(['account_id', 'debit', 'credit']).where('entry_id', '=', r.reversalId).orderBy('line_no').execute();
    assert.equal(Number(lines[0].credit), 50_000, 'rent is credited back');
    assert.equal(Number(lines[1].debit), 50_000, 'and the bank debited back');
    // Reversed by: the original's other half is found from it.
    const by = await f.trx.selectFrom('journal_entries').select('entry_no').where('reversal_of_entry_id', '=', jv.id).executeTakeFirstOrThrow();
    assert.equal(by.entry_no, r.reversalNo);
    const kept = await f.trx.selectFrom('journal_reversals').selectAll().where('entry_id', '=', jv.id).executeTakeFirstOrThrow();
    assert.equal(kept.reason, 'Rent was paid by the landlord deposit');
    assert.equal(kept.requested_by_user_id, f.maker);
    // Once only.
    await assert.rejects(requestReversal(f.trx, f.orgId, f.maker, jv.id, { date: '2026-11-06', reason: 'again' }), /already been reversed by #/);
    await assert.rejects(requestReversal(f.trx, f.orgId, f.maker, r.reversalId, { date: '2026-11-06', reason: 'undo the undo' }), /itself the reversal/);
    // A reason is required; a reversal cannot come before its entry.
    const jv2 = await rent(f, '2026-10-31', 1_000);
    await assert.rejects(requestReversal(f.trx, f.orgId, f.maker, jv2.id, { date: '2026-11-05', reason: ' ' }), /Say why/);
    await assert.rejects(requestReversal(f.trx, f.orgId, f.maker, jv2.id, { date: '2026-10-01', reason: 'too early' }), /before the entry/);
    // GL, TB and P&L net to nil across the pair.
    assert.equal(await netOf(f, CODE.RENT, '2026-11-30') - 1_000, 0);
    const pl = await profitAndLoss(f.trx, f.orgId, '2026-10-01', '2026-11-30');
    assert.equal(pl.expenseRows.find((x) => x.code === CODE.RENT)?.balancePaise, 1_000_00, 'only the unreversed ₹1,000 remains');
    const tb = await trialBalance(f.trx, f.orgId, '2026-11-30');
    assert.ok(tb.balanced);
    assert.ok((await verifyLedgerBalances(f.trx, f.orgId)).balanced);
    // The register lists the pair with its reason and who did it.
    const reg = await reversalRegister(f.trx, f.orgId);
    const pair = reg.find((p) => p.entryId === String(jv.id))!;
    assert.equal(pair.reversalNo, r.reversalNo);
    assert.equal(pair.reason, 'Rent was paid by the landlord deposit');
    assert.equal(pair.requestedBy, 'maker');
    assert.equal(pair.kind, 'manual');
  });
});

test('a locked period or a closed year refuses the reversal and names the first open date', async () => {
  await withFixture(async (f) => {
    const jv = await rent(f, '2026-03-20', 10_000);
    // FY 2025-26 closed: every module locked to 31 March 2026.
    await f.trx.insertInto('transaction_locks').values({ org_id: f.orgId, module: 'accountant', locked_upto: '2026-03-31', reason: 'FY 2025-26 closed' } as never).execute();
    const err = await requestReversal(f.trx, f.orgId, f.maker, jv.id, { date: '2026-03-25', reason: 'wrong year' }).catch((e) => e);
    assert.ok(err instanceof ApiError);
    assert.equal(err.status, 423);
    assert.match(err.message, /locked up to 31 Mar 2026 \(FY 2025-26 closed\)/);
    assert.match(err.message, /first open date is 1 Apr 2026/);
    assert.deepEqual(err.details, { lockedUpto: '2026-03-31', firstOpenDate: '2026-04-01' });
    // On the first open date it goes through, in the new year.
    const ok = await requestReversal(f.trx, f.orgId, f.maker, jv.id, { date: '2026-04-01', reason: 'wrong year' });
    assert.equal(ok.held, false);
  });
});

test('with journal approval on, the reversal waits for a second person; the maker cannot approve it', async () => {
  await withFixture(async (f) => {
    await saveRule(f.trx, f.orgId, { documentType: 'journal', thresholdPaise: 10_000_00, approverRole: 'accountant', isActive: true });
    const lines = [{ accountId: f.acc[CODE.RENT], debitPaise: 50_000_00 }, { accountId: f.acc[CODE.BANK_DEFAULT], creditPaise: 50_000_00 }];
    // 1. The JV goes for approval, the checker approves, it posts.
    const saved = await saveJournal(f.trx, f.orgId, f.maker, { branchId: f.branchId, date: '2026-10-31', memo: 'Rent', lines });
    assert.equal(saved.held, true);
    if (!saved.held) return;
    await assert.rejects(approveHeldJournal(f.trx, f.orgId, { userId: f.maker, role: 'accountant' }, saved.id), /Someone else/);
    const jv = await approveHeldJournal(f.trx, f.orgId, { userId: f.checker, role: 'accountant' }, saved.id);
    // 2. Reversed on a date with a reason: held, not posted.
    const r = await requestReversal(f.trx, f.orgId, f.maker, jv.id, { date: '2026-11-10', reason: 'Duplicate of the October standing order' });
    assert.equal(r.held, true);
    if (!r.held) return;
    assert.equal(await f.trx.selectFrom('journal_entries').select('id').where('reversal_of_entry_id', '=', jv.id).executeTakeFirst(), undefined, 'nothing posted yet');
    await assert.rejects(requestReversal(f.trx, f.orgId, f.checker, jv.id, { date: '2026-11-10', reason: 'again' }), /waiting for approval/);
    const waiting = (await reversalRegister(f.trx, f.orgId)).find((p) => p.heldId === String(r.heldId))!;
    assert.equal(waiting.kind, 'waiting_approval');
    // 3. The maker cannot approve their own reversal; the checker can.
    await assert.rejects(approveHeldJournal(f.trx, f.orgId, { userId: f.maker, role: 'accountant' }, r.heldId), /You asked for this reversal/);
    const posted = await approveHeldJournal(f.trx, f.orgId, { userId: f.checker, role: 'accountant' }, r.heldId);
    const rev = await f.trx.selectFrom('journal_entries').selectAll().where('id', '=', posted.id).executeTakeFirstOrThrow();
    assert.equal(rev.reversal_of_entry_id, jv.id);
    assert.equal(String(rev.entry_date).slice(0, 10), '2026-11-10');
    const kept = await f.trx.selectFrom('journal_reversals').selectAll().where('entry_id', '=', jv.id).executeTakeFirstOrThrow();
    assert.equal(kept.kind, 'approved');
    assert.equal(kept.requested_by_user_id, f.maker);
    assert.equal(kept.approved_by_user_id, f.checker);
    assert.equal(kept.reason, 'Duplicate of the October standing order');
    assert.equal(await netOf(f, CODE.RENT), 0);
    const pair = (await reversalRegister(f.trx, f.orgId)).find((p) => p.entryId === String(jv.id) && p.reversalId)!;
    assert.equal(pair.approvedBy, 'checker');
  });
});

test('an auto-reversing journal waits for its date, then the scheduler (or a person) posts the reversal', async () => {
  await withFixture(async (f) => {
    // Today in India is before 1 December 2026 when this runs in November; the reversal date is in the future.
    const future = '2099-01-01';
    const accrual = await rent(f, '2098-12-31', 20_000, { reverseOn: future });
    assert.ok('scheduledReversalId' in accrual && accrual.scheduledReversalId);
    const heldId = Number((accrual as { scheduledReversalId: number }).scheduledReversalId);
    assert.equal(await f.trx.selectFrom('journal_entries').select('id').where('reversal_of_entry_id', '=', accrual.id).executeTakeFirst(), undefined, 'not posted ahead of its date');
    await assert.rejects(releaseHeldJournal(f.trx, f.orgId, f.maker, heldId), /due on 2099-01-01/);
    const reg = await reversalRegister(f.trx, f.orgId);
    assert.equal(reg.find((p) => p.heldId === String(heldId))?.kind, 'scheduled_pending');
    // The scheduler's run on the day posts it.
    const run = await runScheduledPostings({ now: new Date('2099-01-01T06:00:00Z'), trx: f.trx, orgId: f.orgId });
    assert.equal(run.posted, 1);
    const rev = await f.trx.selectFrom('journal_entries').selectAll().where('reversal_of_entry_id', '=', accrual.id).executeTakeFirstOrThrow();
    assert.equal(String(rev.entry_date).slice(0, 10), future);
    const kept = await f.trx.selectFrom('journal_reversals').selectAll().where('entry_id', '=', accrual.id).executeTakeFirstOrThrow();
    assert.equal(kept.kind, 'scheduled');
    assert.equal(await netOf(f, CODE.RENT, '2098-12-31'), 20_000, 'December carries the accrual');
    assert.equal(await netOf(f, CODE.RENT, future), 0, 'January opens with it undone');
    // A date already reached reverses at once, as before.
    const past = await rent(f, '2026-06-30', 5_000, { reverseOn: '2026-07-01' });
    assert.ok('reversalId' in past && past.reversalId);
  });
});

test('sales, purchase, receipt, payment and contra vouchers are undone by a reversing entry, never deleted', async () => {
  await withFixture(async (f) => {
    const inv = await createInvoice(f.trx, f.orgId, f.maker, {
      branchId: f.branchId, customerId: f.customer, date: '2026-11-01', dueDate: '2026-11-30', status: 'approved',
      lines: [{ description: 'Brake pads', qty: 1, ratePaise: 10_000_00, gstRatePct: 0 }],
    });
    const bill = await createBill(f.trx, f.orgId, f.maker, {
      branchId: f.branchId, vendorId: f.vendor, vendorInvoiceNo: 'MS-1', date: '2026-11-02', dueDate: '2026-11-30', status: 'open',
      lines: [{ description: 'Stock', qty: 1, ratePaise: 6_000_00, gstRatePct: 0 }],
    });
    const receipt = await receivePayment(f.trx, f.orgId, f.maker, { branchId: f.branchId, contactId: f.customer, date: '2026-11-03', mode: 'neft', amountPaise: 4_000_00, bankAccountId: f.bank });
    const payment = await makePayment(f.trx, f.orgId, f.maker, { branchId: f.branchId, contactId: f.vendor, date: '2026-11-04', mode: 'neft', amountPaise: 2_500_00, bankAccountId: f.bank });
    const contra = await createTransfer(f.trx, f.orgId, f.maker, { fromBankAccountId: f.bank, toBankAccountId: f.cash, date: '2026-11-05', amountPaise: 1_000_00 });
    const entries = {
      sales: Number(inv.journalEntryId), purchase: Number(bill.journalEntryId), receipt: receipt.journalEntryId, payment: payment.journalEntryId, contra: contra.journalEntryId,
    };
    // The journal screen sends each to its document.
    for (const [kind, id] of Object.entries(entries)) {
      await assert.rejects(requestReversal(f.trx, f.orgId, f.maker, id, { date: '2026-11-10', reason: 'test' }), /Void or delete that document/, kind);
    }
    await voidPayment(f.trx, f.orgId, f.maker, receipt.id, 'Cheque bounced');
    await voidPayment(f.trx, f.orgId, f.maker, payment.id, 'Paid to the wrong vendor');
    await voidInvoice(f.trx, f.orgId, f.maker, inv.id, 'Order cancelled');
    await voidBill(f.trx, f.orgId, f.maker, bill.id, 'Goods returned unopened');
    await deleteTransfer(f.trx, f.orgId, f.maker, contra.id, 'Entered twice');
    for (const [kind, id] of Object.entries(entries)) {
      const original = await f.trx.selectFrom('journal_entries').select('id').where('id', '=', id).executeTakeFirst();
      assert.ok(original, `${kind}: the original entry is kept`);
      const rev = await f.trx.selectFrom('journal_entries').select(['id', 'entry_no']).where('reversal_of_entry_id', '=', id).executeTakeFirst();
      assert.ok(rev, `${kind}: a reversing entry was posted`);
    }
    // Every account nets to nil; the books balance; the register lists all five as documents.
    for (const code of [CODE.AR, CODE.AP, CODE.SALES, CODE.BANK_DEFAULT, CODE.CASH]) assert.equal(await netOf(f, code), 0, code);
    assert.ok((await verifyLedgerBalances(f.trx, f.orgId)).balanced);
    const reg = await reversalRegister(f.trx, f.orgId);
    for (const id of Object.values(entries)) {
      const p = reg.find((x) => x.entryId === String(id));
      assert.ok(p && p.kind === 'document', `register lists entry ${id}`);
    }
  });
});

test.after(() => db.destroy());
