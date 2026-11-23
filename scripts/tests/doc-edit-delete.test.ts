// Edit and Delete, as Zoho Books has them, against real MySQL inside rolled-back
// transactions (migration 118, services/doc-delete.ts).
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/doc-edit-delete.test.ts
//
// What has to hold: an edit leaves the ledger exactly as if the document had
// been entered right the first time (the old entry reversed, never erased); a
// delete leaves nothing in the ledger but a reversed pair, keeps the number for
// GSTR-1 table 13, and is refused while money rests on the document.

import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { verifyLedgerBalances } from '../../lib/server/ledger/posting';
import { createInvoice, deleteInvoice, updateInvoice, type CreateInvoiceInput } from '../../lib/server/services/sales';
import { deletePayment, receivePayment, updatePayment } from '../../lib/server/services/payments';
import { createCreditNote, createEstimate, createSalesOrder, deleteSalesDocument, updateSalesDocument } from '../../lib/server/services/sales-documents';
import { createExpense, deleteExpense, updateExpense } from '../../lib/server/services/purchases';
import { deleteJournal, editJournal, postManualJournal } from '../../lib/server/services/journals';
import { gstr1PortalFile } from '../../lib/server/gst/gstr1-json';
import { toPaiseFromSql } from '../../lib/server/money-sql';

interface Fixture { trx: Trx; orgId: number; branchId: number; acc: Record<string, number>; customerId: number; bankId: number; itemId: number }

async function withFixture(fn: (f: Fixture) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Edit Delete Test Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1, gstin: '33AAACR4849R1ZK' }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const acc = await accountIds(trx, orgId);
      const customerId = Number((await trx.insertInto('contacts').values({
        org_id: orgId, kind: 'customer', display_name: 'Bonita', gst_treatment: 'registered', state_code: '33', pan: 'AAAAA1111A', gstin: '33AAAAA1111A1Z5',
      }).executeTakeFirstOrThrow()).insertId);
      const bankId = Number((await trx.insertInto('bank_accounts').values({
        org_id: orgId, kind: 'bank', name: 'ICICI', ledger_account_id: acc[CODE.BANK_DEFAULT], opening_balance: '0.0000',
      }).executeTakeFirstOrThrow()).insertId);
      const itemId = Number((await trx.insertInto('items').values({
        org_id: orgId, kind: 'goods', name: 'Widget', sku: 'W-1', hsn_sac: '8708', uqc: 'NOS',
        sale_price: '1000.0000', purchase_price: '600.0000', gst_rate_pct: 18, sale_account_id: acc[CODE.SALES],
      }).executeTakeFirstOrThrow()).insertId);
      await trx.insertInto('hsn_codes').values({ org_id: orgId, code: '8708', kind: 'hsn', description: 'Motor vehicle parts', gst_rate_pct: 18, is_active: 1 }).execute();
      await fn({ trx, orgId, branchId, acc, customerId, bankId, itemId });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

/** An account's balance (debit minus credit) over the whole ledger. */
async function balance(trx: Trx, orgId: number, accountId: number): Promise<number> {
  const { rows } = await sql<{ v: string }>`
    SELECT COALESCE(SUM(debit - credit), 0) AS v FROM journal_lines WHERE org_id = ${orgId} AND account_id = ${accountId}`.execute(trx);
  return toPaiseFromSql(rows[0].v);
}

test.after(() => db.destroy());

const sale = (f: Fixture, qty: number, extra: Partial<CreateInvoiceInput> = {}): CreateInvoiceInput => ({
  branchId: f.branchId, customerId: f.customerId, date: '2026-10-05', dueDate: '2026-11-04',
  status: 'approved', lines: [{ itemId: f.itemId, qty, ratePaise: 100_000, gstRatePct: 18 }], ...extra,
});

test('editing an issued invoice rewrites it in place and the ledger is as if it were right first time', async () => {
  await withFixture(async (f) => {
    const { trx, orgId, acc } = f;
    const inv = await createInvoice(trx, orgId, null, sale(f, 2));
    assert.equal(await balance(trx, orgId, acc[CODE.AR]), 236_000);

    const edited = await updateInvoice(trx, orgId, null, inv.id, { ...sale(f, 5), notes: 'Five, not two' });
    assert.equal(edited.id, inv.id, 'same row');
    assert.equal(edited.number, inv.number, 'same number');
    assert.equal(edited.totalPaise, 590_000);
    const row = await trx.selectFrom('invoices').select(['status', 'total', 'notes', 'journal_entry_id']).where('id', '=', inv.id).executeTakeFirstOrThrow();
    assert.equal(row.status, 'approved', 'an issued invoice stays issued');
    assert.equal(row.notes, 'Five, not two');
    assert.notEqual(row.journal_entry_id, inv.journalEntryId, 'posted afresh');
    const lines = await trx.selectFrom('invoice_lines').select(['qty']).where('invoice_id', '=', inv.id).execute();
    assert.deepEqual(lines.map((l) => Number(l.qty)), [5]);

    // The old entry reversed, never removed.
    const reversal = await trx.selectFrom('journal_entries').select('id').where('reversal_of_entry_id', '=', inv.journalEntryId!).executeTakeFirst();
    assert.ok(reversal, 'the original entry has a reversal');
    assert.ok(await trx.selectFrom('journal_entries').select('id').where('id', '=', inv.journalEntryId!).executeTakeFirst(), 'and is still there');
    assert.equal(await balance(trx, orgId, acc[CODE.AR]), 590_000);
    assert.equal(await balance(trx, orgId, acc[CODE.SALES]), -500_000);
    assert.equal(await balance(trx, orgId, acc[CODE.GST_CGST]), -45_000);
    assert.ok((await verifyLedgerBalances(trx, orgId)).balanced);
    assert.ok(edited.before, 'the old version is handed to the audit trail');
  });
});

test('a draft stays a draft through an edit and posts nothing', async () => {
  await withFixture(async (f) => {
    const { trx, orgId, acc } = f;
    const inv = await createInvoice(trx, orgId, null, sale(f, 1, { status: 'draft' }));
    const edited = await updateInvoice(trx, orgId, null, inv.id, sale(f, 3, { status: 'draft' }));
    const row = await trx.selectFrom('invoices').select(['status', 'journal_entry_id']).where('id', '=', inv.id).executeTakeFirstOrThrow();
    assert.equal(row.status, 'draft');
    assert.equal(row.journal_entry_id, null);
    assert.equal(edited.totalPaise, 354_000);
    assert.equal(await balance(trx, orgId, acc[CODE.AR]), 0);
    // Saved and sent from the edit, it posts then.
    await updateInvoice(trx, orgId, null, inv.id, sale(f, 3, { status: 'approved' }));
    assert.equal(await balance(trx, orgId, acc[CODE.AR]), 354_000);
  });
});

test('payments stay with an edited invoice, and the total cannot drop below them', async () => {
  await withFixture(async (f) => {
    const { trx, orgId } = f;
    const inv = await createInvoice(trx, orgId, null, sale(f, 2));
    await receivePayment(trx, orgId, null, {
      branchId: f.branchId, contactId: f.customerId, date: '2026-10-06', mode: 'neft', amountPaise: 100_000, bankAccountId: f.bankId,
      allocations: [{ targetType: 'invoice', targetId: inv.id, amountPaise: 100_000 }],
    });
    await updateInvoice(trx, orgId, null, inv.id, sale(f, 3));
    const row = await trx.selectFrom('invoices').select(['status', 'amount_paid', 'total']).where('id', '=', inv.id).executeTakeFirstOrThrow();
    assert.equal(row.status, 'partially_paid');
    assert.equal(toPaiseFromSql(row.amount_paid), 100_000);
    assert.equal(toPaiseFromSql(row.total), 354_000);
    await assert.rejects(
      updateInvoice(trx, orgId, null, inv.id, { ...sale(f, 1), lines: [{ itemId: f.itemId, qty: 1, ratePaise: 50_000, gstRatePct: 18 }] }),
      /already been received/,
    );
  });
});

test('a closed period refuses the edit', async () => {
  await withFixture(async (f) => {
    const { trx, orgId } = f;
    const inv = await createInvoice(trx, orgId, null, sale(f, 2));
    await trx.insertInto('transaction_locks').values({ org_id: orgId, module: 'sales', locked_upto: '2026-10-31', reason: 'GSTR-1 filed' }).execute();
    await assert.rejects(updateInvoice(trx, orgId, null, inv.id, sale(f, 4)), /lock|closed|filed/i);
    await assert.rejects(deleteInvoice(trx, orgId, null, inv.id), /lock|closed|filed/i);
  });
});

test('deleting an invoice reverses its entry, keeps the record and counts the number as cancelled', async () => {
  await withFixture(async (f) => {
    const { trx, orgId, acc } = f;
    const keep = await createInvoice(trx, orgId, null, sale(f, 1));
    const inv = await createInvoice(trx, orgId, null, sale(f, 2));
    await trx.insertInto('comments').values({ org_id: orgId, target_type: 'invoice', target_id: inv.id, author_name: 'Tester', body: 'check rate' }).execute();
    const gone = await deleteInvoice(trx, orgId, null, inv.id, 'Raised twice');
    assert.equal(gone.number, inv.number);
    assert.equal(await trx.selectFrom('invoices').select('id').where('id', '=', inv.id).executeTakeFirst(), undefined);
    assert.equal((await trx.selectFrom('invoice_lines').select('id').where('invoice_id', '=', inv.id).execute()).length, 0);
    assert.equal((await trx.selectFrom('comments').select('id').where('target_type', '=', 'invoice').where('target_id', '=', inv.id).execute()).length, 0);
    const record = await trx.selectFrom('deleted_documents').selectAll().where('org_id', '=', orgId).executeTakeFirstOrThrow();
    assert.equal(record.doc_type, 'invoice');
    assert.equal(record.number, inv.number);
    assert.equal(record.reason, 'Raised twice');
    assert.ok(record.reversal_entry_id, 'its entry was reversed');
    const snap = (typeof record.snapshot === 'string' ? JSON.parse(record.snapshot) : record.snapshot) as { lines: unknown[] };
    assert.equal(snap.lines.length, 1, 'the document is kept as it stood');
    // Only the invoice that stays is in receivables.
    assert.equal(await balance(trx, orgId, acc[CODE.AR]), toPaiseFromSql((await trx.selectFrom('invoices').select('total').where('id', '=', keep.id).executeTakeFirstOrThrow()).total));
    assert.ok((await verifyLedgerBalances(trx, orgId)).balanced);

    // GSTR-1 table 13: two numbers issued, one cancelled.
    const file = await gstr1PortalFile(trx, orgId, '2026-10');
    const docIssue = (file as { doc_issue?: { doc_det: { doc_num: number; docs: { totnum: number; cancel: number }[] }[] } }).doc_issue;
    const series = docIssue?.doc_det.find((d) => d.doc_num === 1)?.docs[0];
    assert.equal(series?.totnum, 2);
    assert.equal(series?.cancel, 1);
  });
});

test('an invoice with money against it cannot be deleted; a draft can', async () => {
  await withFixture(async (f) => {
    const { trx, orgId } = f;
    const inv = await createInvoice(trx, orgId, null, sale(f, 2));
    await receivePayment(trx, orgId, null, {
      branchId: f.branchId, contactId: f.customerId, date: '2026-10-06', mode: 'upi', amountPaise: 50_000, bankAccountId: f.bankId,
      allocations: [{ targetType: 'invoice', targetId: inv.id, amountPaise: 50_000 }],
    });
    await assert.rejects(deleteInvoice(trx, orgId, null, inv.id), /Payments or credits/);

    const draft = await createInvoice(trx, orgId, null, sale(f, 1, { status: 'draft' }));
    await deleteInvoice(trx, orgId, null, draft.id);
    const rec = await trx.selectFrom('deleted_documents').select(['reversal_entry_id', 'number']).where('doc_id', '=', draft.id).executeTakeFirstOrThrow();
    assert.equal(rec.reversal_entry_id, null, 'a draft had nothing to reverse');
    assert.equal(rec.number, draft.number);
  });
});

test('a payment received can be edited and deleted; what it paid is owed again', async () => {
  await withFixture(async (f) => {
    const { trx, orgId, acc } = f;
    const inv = await createInvoice(trx, orgId, null, sale(f, 2));
    const pay = { branchId: f.branchId, contactId: f.customerId, date: '2026-10-06', mode: 'neft' as const, bankAccountId: f.bankId };
    const p = await receivePayment(trx, orgId, null, { ...pay, amountPaise: 100_000, allocations: [{ targetType: 'invoice', targetId: inv.id, amountPaise: 100_000 }] });
    // Edited to the full amount: the invoice is paid, same receipt number.
    const edited = await updatePayment(trx, orgId, null, p.id, { ...pay, amountPaise: 236_000, allocations: [{ targetType: 'invoice', targetId: inv.id, amountPaise: 236_000 }] });
    assert.equal(edited.number, p.number);
    let row = await trx.selectFrom('invoices').select(['status', 'amount_paid']).where('id', '=', inv.id).executeTakeFirstOrThrow();
    assert.equal(row.status, 'paid');
    assert.equal(toPaiseFromSql(row.amount_paid), 236_000);
    assert.equal(await balance(trx, orgId, acc[CODE.BANK_DEFAULT]), 236_000);
    // Deleted: owed in full again, the bank back to nothing.
    await deletePayment(trx, orgId, null, p.id, 'Wrong customer');
    row = await trx.selectFrom('invoices').select(['status', 'amount_paid']).where('id', '=', inv.id).executeTakeFirstOrThrow();
    assert.equal(toPaiseFromSql(row.amount_paid), 0);
    assert.notEqual(row.status, 'paid');
    assert.equal(await balance(trx, orgId, acc[CODE.BANK_DEFAULT]), 0);
    assert.equal(await balance(trx, orgId, acc[CODE.AR]), 236_000);
    assert.equal(await trx.selectFrom('payments').select('id').where('id', '=', p.id).executeTakeFirst(), undefined);
    assert.ok((await verifyLedgerBalances(trx, orgId)).balanced);
    // Now the invoice can go too.
    await deleteInvoice(trx, orgId, null, inv.id);
  });
});

test('quotes and sales orders are edited in place and deleted', async () => {
  await withFixture(async (f) => {
    const { trx, orgId } = f;
    const lines = [{ itemId: f.itemId, qty: 2, ratePaise: 100_000, gstRatePct: 18 }];
    const est = await createEstimate(trx, orgId, null, { branchId: f.branchId, customerId: f.customerId, date: '2026-10-05', expiryDate: '2026-10-20', lines });
    const e2 = await updateSalesDocument(trx, orgId, null, est.id, { kind: 'estimate', input: { branchId: f.branchId, customerId: f.customerId, date: '2026-10-05', expiryDate: '2026-10-25', lines: [{ ...lines[0], qty: 4 }] } });
    assert.equal(e2.number, est.number);
    assert.equal(e2.totalPaise, 472_000);
    assert.deepEqual((await trx.selectFrom('estimate_lines').select('qty').where('estimate_id', '=', est.id).execute()).map((l) => Number(l.qty)), [4]);

    const so = await createSalesOrder(trx, orgId, null, { branchId: f.branchId, customerId: f.customerId, date: '2026-10-05', lines });
    await updateSalesDocument(trx, orgId, null, so.id, { kind: 'sales-order', input: { branchId: f.branchId, customerId: f.customerId, date: '2026-10-06', lines: [{ ...lines[0], qty: 3 }] } });
    const soRow = await trx.selectFrom('sales_orders').select(['order_date', 'total', 'status']).where('id', '=', so.id).executeTakeFirstOrThrow();
    assert.equal(String(soRow.order_date).slice(0, 10), '2026-10-06');
    assert.equal(toPaiseFromSql(soRow.total), 354_000);
    assert.equal(soRow.status, 'open');
    await deleteSalesDocument(trx, orgId, null, 'sales-order', so.id);
    await deleteSalesDocument(trx, orgId, null, 'estimate', est.id);
    assert.equal(await trx.selectFrom('estimates').select('id').where('id', '=', est.id).executeTakeFirst(), undefined);
    assert.equal((await trx.selectFrom('deleted_documents').select('doc_type').where('org_id', '=', orgId).execute()).length, 2);
  });
});

test('a credit note applied to its invoice can be edited and deleted, and the invoice follows', async () => {
  await withFixture(async (f) => {
    const { trx, orgId, acc } = f;
    const inv = await createInvoice(trx, orgId, null, sale(f, 2));
    const cnInput = { branchId: f.branchId, customerId: f.customerId, date: '2026-10-07', reason: 'Damaged', againstInvoiceId: inv.id, lines: [{ itemId: f.itemId, qty: 1, ratePaise: 100_000, gstRatePct: 18 }] };
    const cn = await createCreditNote(trx, orgId, null, cnInput);
    assert.equal(toPaiseFromSql((await trx.selectFrom('invoices').select('amount_paid').where('id', '=', inv.id).executeTakeFirstOrThrow()).amount_paid), 118_000);
    // Edited to a smaller credit: applied again to its invoice, at the new amount.
    const e = await updateSalesDocument(trx, orgId, null, cn.id, { kind: 'credit-note', input: { ...cnInput, lines: [{ ...cnInput.lines[0], ratePaise: 50_000 }] } });
    assert.equal(e.number, cn.number);
    assert.equal(toPaiseFromSql((await trx.selectFrom('invoices').select('amount_paid').where('id', '=', inv.id).executeTakeFirstOrThrow()).amount_paid), 59_000);
    assert.equal(await balance(trx, orgId, acc[CODE.AR]), 236_000 - 59_000);
    await deleteSalesDocument(trx, orgId, null, 'credit-note', cn.id);
    assert.equal(toPaiseFromSql((await trx.selectFrom('invoices').select('amount_paid').where('id', '=', inv.id).executeTakeFirstOrThrow()).amount_paid), 0);
    assert.equal(await balance(trx, orgId, acc[CODE.AR]), 236_000);
    assert.ok((await verifyLedgerBalances(trx, orgId)).balanced);
    // GSTR-1 table 13: the credit note's number counts as cancelled.
    const file = await gstr1PortalFile(trx, orgId, '2026-10');
    const docIssue = (file as { doc_issue?: { doc_det: { doc_num: number; docs: { totnum: number; cancel: number }[] }[] } }).doc_issue;
    assert.equal(docIssue?.doc_det.find((d) => d.doc_num === 5)?.docs[0]?.cancel, 1);
  });
});

test('an expense is edited and deleted, its entry following', async () => {
  await withFixture(async (f) => {
    const { trx, orgId, acc } = f;
    const base = { branchId: f.branchId, date: '2026-10-08', accountId: acc[CODE.FUEL], paidThroughBankAccountId: f.bankId };
    const x = await createExpense(trx, orgId, null, { ...base, amountPaise: 118_000, gstRatePct: 18 });
    const e = await updateExpense(trx, orgId, null, x.id, { ...base, amountPaise: 50_000, gstRatePct: 0, notes: 'Diesel' });
    assert.equal(e.number, x.number);
    assert.equal(await balance(trx, orgId, acc[CODE.FUEL]), 50_000);
    assert.equal(await balance(trx, orgId, acc[CODE.ITC_CGST]), 0);
    assert.equal(await balance(trx, orgId, acc[CODE.BANK_DEFAULT]), -50_000);
    await deleteExpense(trx, orgId, null, x.id);
    assert.equal(await balance(trx, orgId, acc[CODE.FUEL]), 0);
    assert.equal(await balance(trx, orgId, acc[CODE.BANK_DEFAULT]), 0);
    assert.ok((await verifyLedgerBalances(trx, orgId)).balanced);
  });
});

test('a manual journal is edited (reversed and posted again) and deleted (reversed)', async () => {
  await withFixture(async (f) => {
    const { trx, orgId, acc } = f;
    const j = await postManualJournal(trx, orgId, null, { branchId: f.branchId, date: '2026-10-09', memo: 'Owner brought cash', lines: [
      { accountId: acc[CODE.BANK_DEFAULT], debitPaise: 500_000 }, { accountId: acc[CODE.CAPITAL], creditPaise: 500_000 },
    ] });
    const e = await editJournal(trx, orgId, null, j.id, { branchId: f.branchId, date: '2026-10-09', memo: 'Owner brought cash', lines: [
      { accountId: acc[CODE.BANK_DEFAULT], debitPaise: 700_000 }, { accountId: acc[CODE.CAPITAL], creditPaise: 700_000 },
    ] });
    assert.equal(e.replacedEntryNo, j.entryNo);
    assert.equal(await balance(trx, orgId, acc[CODE.BANK_DEFAULT]), 700_000);
    await assert.rejects(editJournal(trx, orgId, null, j.id, { branchId: f.branchId, date: '2026-10-09', memo: 'x', lines: [
      { accountId: acc[CODE.BANK_DEFAULT], debitPaise: 1 }, { accountId: acc[CODE.CAPITAL], creditPaise: 1 },
    ] }), /already been reversed/);
    await deleteJournal(trx, orgId, null, e.entry.id, 'Not ours');
    assert.equal(await balance(trx, orgId, acc[CODE.BANK_DEFAULT]), 0);
    assert.ok((await verifyLedgerBalances(trx, orgId)).balanced);
  });
});
