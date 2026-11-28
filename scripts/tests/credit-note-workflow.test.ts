// The credit note workflow as the auditors test it (status review 7, item 7):
// an invoice, a credit note from it with part of the goods returned and a
// price cut, approval when a rule covers credit notes, applying it to the same
// and another invoice, refunding what is left, voiding one (entry reversed,
// applications undone), output tax in the GL, GSTR-1 with the original
// invoice's number and date, the s.34 time limit, and the quantity cap.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/credit-note-workflow.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { createInvoice } from '../../lib/server/services/sales';
import { applyCreditNote, createCreditNote, refundCreditNote, section34Deadline, voidCreditNote } from '../../lib/server/services/sales-documents';
import { openCreditNote } from '../../lib/server/services/sales-extras';
import { approve, pendingApprovals, reject, saveRule } from '../../lib/server/services/approvals';
import { gstr1 } from '../../lib/server/gst/returns';

interface Fixture { trx: Trx; orgId: number; branchId: number; customerId: number; itemId: number; bankId: number; admin: number; accountant: number }

async function withFixture(fn: (f: Fixture) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'CN Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1, gstin: '33AAAAA0000A1Z5' }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const acc = await accountIds(trx, orgId);
      const user = async (role: string) => Number((await trx.insertInto('users').values({ org_id: orgId, name: role, email: `${role}-${orgId}@example.test`, role } as never).executeTakeFirstOrThrow()).insertId);
      const admin = await user('admin');
      const accountant = await user('accountant');
      const customerId = Number((await trx.insertInto('contacts').values({
        org_id: orgId, kind: 'customer', display_name: 'Registered Buyer', gst_treatment: 'registered', state_code: '33', gstin: '33BBBBB1111B1Z5',
      } as never).executeTakeFirstOrThrow()).insertId);
      await trx.insertInto('hsn_codes').values({ org_id: orgId, code: '8708', kind: 'hsn', description: 'Parts', gst_rate_pct: 18, is_active: 1 }).execute();
      const itemId = Number((await trx.insertInto('items').values({
        org_id: orgId, kind: 'goods', name: 'Brake pad', hsn_sac: '8708', uqc: 'NOS', sale_price: '1000.0000', purchase_price: '600.0000',
        gst_rate_pct: 18, track_inventory: 0, sale_account_id: acc[CODE.SALES], purchase_account_id: acc[CODE.PURCHASES],
      }).executeTakeFirstOrThrow()).insertId);
      const bankId = Number((await trx.insertInto('bank_accounts').values({ org_id: orgId, kind: 'bank', name: 'Bank', ledger_account_id: acc[CODE.BANK_DEFAULT], opening_balance: '0.0000' }).executeTakeFirstOrThrow()).insertId);
      await fn({ trx, orgId, branchId, customerId, itemId, bankId, admin, accountant });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

const sell = (f: Fixture, date: string, qty: number) => createInvoice(f.trx, f.orgId, f.admin, {
  branchId: f.branchId, customerId: f.customerId, date, dueDate: date, status: 'approved', lines: [{ itemId: f.itemId, qty, ratePaise: 100_000 }],
});
const balanceOf = async (f: Fixture, id: number) => {
  const r = await f.trx.selectFrom('invoices').select(['total', 'amount_paid', 'status']).where('id', '=', id).executeTakeFirstOrThrow();
  return { owed: Math.round((Number(r.total) - Number(r.amount_paid)) * 100), status: r.status };
};
const cnRow = (f: Fixture, id: number) => f.trx.selectFrom('credit_notes').select(['status', 'total', 'applied_amount', 'approval_status', 'journal_entry_id']).where('id', '=', id).executeTakeFirstOrThrow();
const outputTax = async (f: Fixture) => {
  const { rows } = await sql<{ v: string }>`SELECT COALESCE(SUM(jl.credit - jl.debit), 0) AS v FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
    WHERE jl.org_id = ${f.orgId} AND a.code IN (${CODE.GST_CGST}, ${CODE.GST_SGST}, ${CODE.GST_IGST})`.execute(f.trx);
  return Math.round(Number(rows[0].v) * 100);
};

test('credit note from an invoice: part returned and a price cut, approved, applied, the rest refunded, another voided', async () => {
  await withFixture(async (f) => {
    // 1. An invoice: 10 at ₹1,000 + 18% = ₹11,800. Output tax ₹1,800.
    const inv = await sell(f, '2026-04-10', 10);
    assert.equal(inv.totalPaise, 1_180_000);
    assert.equal(await outputTax(f), 180_000);

    // 3. A rule: credit notes of ₹1,000 and above need an accountant.
    await saveRule(f.trx, f.orgId, { documentType: 'credit_note', thresholdPaise: 100_000, approverRole: 'accountant', isActive: true });

    // 2. From the invoice: 3 returned, and ₹50 off each of the 7 kept: (3,000 + 350) + 18% = ₹3,953.
    const cn = await createCreditNote(f.trx, f.orgId, f.admin, {
      branchId: f.branchId, customerId: f.customerId, date: '2026-04-15', reason: 'Sales return and rate cut', againstInvoiceId: inv.id,
      lines: [{ itemId: f.itemId, qty: 3, ratePaise: 100_000 }, { description: 'Rate reduction agreed: ₹50 on each of 7', qty: 7, ratePaise: 5_000, gstRatePct: 18 }],
    });
    assert.equal(cn.heldForApproval, true, 'caught by the rule');
    assert.equal(cn.totalPaise, 395_300);
    let row = await cnRow(f, cn.id);
    assert.equal(row.status, 'draft');
    assert.equal(row.approval_status, 'pending');
    assert.equal(row.journal_entry_id, null, 'nothing posted while it waits');
    assert.equal((await balanceOf(f, inv.id)).owed, 1_180_000);
    const waiting = await pendingApprovals(f.trx, f.orgId);
    assert.ok(waiting.some((p) => p.documentType === 'credit_note' && p.id === String(cn.id) && p.approverRole === 'accountant'));
    // The maker cannot approve their own; converting it to open is refused too.
    await assert.rejects(approve(f.trx, f.orgId, { userId: f.admin, role: 'admin' }, 'credit_note', cn.id, openCreditNote), /Someone else has to approve/);
    await assert.rejects(openCreditNote(f.trx, f.orgId, f.admin, cn.id), /waiting for approval/);
    await approve(f.trx, f.orgId, { userId: f.accountant, role: 'accountant' }, 'credit_note', cn.id, openCreditNote, 'Checked against the returned goods');

    // 4. Posted and applied to its invoice: the invoice owes ₹7,847, the note is used up.
    row = await cnRow(f, cn.id);
    assert.equal(row.status, 'applied');
    assert.equal(row.approval_status, 'approved');
    assert.ok(row.journal_entry_id);
    assert.deepEqual(await balanceOf(f, inv.id), { owed: 784_700, status: 'partially_paid' });
    // Output tax down by the note's GST (₹603).
    assert.equal(await outputTax(f), 180_000 - 60_300);

    // More goods back than went out is refused.
    await assert.rejects(createCreditNote(f.trx, f.orgId, f.admin, {
      branchId: f.branchId, customerId: f.customerId, date: '2026-04-16', reason: 'Return', againstInvoiceId: inv.id,
      lines: [{ itemId: f.itemId, qty: 8, ratePaise: 100_000 }],
    }), /Only 7 of Brake pad can come back/);

    // A paid invoice can still be credited: the credit stays open, then goes to another invoice and the rest is refunded.
    const paid = await sell(f, '2026-04-12', 2);
    await f.trx.updateTable('invoices').set({ amount_paid: '2360.0000', status: 'paid' }).where('id', '=', paid.id).execute();
    await f.trx.deleteFrom('approval_rules').where('org_id', '=', f.orgId).execute();
    const cn2 = await createCreditNote(f.trx, f.orgId, f.admin, {
      branchId: f.branchId, customerId: f.customerId, date: '2026-04-18', reason: 'Goods returned', againstInvoiceId: paid.id,
      lines: [{ itemId: f.itemId, qty: 1, ratePaise: 100_000 }],
    });
    row = await cnRow(f, cn2.id);
    assert.equal(row.status, 'open');
    assert.equal(Number(row.applied_amount), 0);
    const other = await sell(f, '2026-04-20', 1);
    await applyCreditNote(f.trx, f.orgId, f.admin, cn2.id, { date: '2026-04-21', allocations: [{ invoiceId: other.id, amountPaise: 50_000 }] });
    assert.deepEqual(await balanceOf(f, other.id), { owed: 68_000, status: 'partially_paid' });
    // 5. Refund the rest (₹680) by bank.
    const refund = await refundCreditNote(f.trx, f.orgId, f.admin, cn2.id, { bankAccountId: f.bankId, date: '2026-04-22' });
    assert.equal(refund.refundedPaise, 68_000);
    assert.equal((await cnRow(f, cn2.id)).status, 'refunded');

    // 6. Void a credit note: entry reversed, applications undone, the invoice owes again.
    const cn3 = await createCreditNote(f.trx, f.orgId, f.admin, {
      branchId: f.branchId, customerId: f.customerId, date: '2026-04-25', reason: 'Raised by mistake', againstInvoiceId: inv.id,
      lines: [{ itemId: f.itemId, qty: 1, ratePaise: 100_000 }],
    });
    assert.equal((await balanceOf(f, inv.id)).owed, 784_700 - 118_000);
    const taxBefore = await outputTax(f);
    await voidCreditNote(f.trx, f.orgId, f.admin, cn3.id, 'Raised by mistake');
    assert.equal((await balanceOf(f, inv.id)).owed, 784_700);
    assert.equal(await outputTax(f), taxBefore + 18_000, 'its GST back on the output tax account');
    const apps = await f.trx.selectFrom('credit_note_applications').select('id').where('credit_note_id', '=', cn3.id).execute();
    assert.equal(apps.length, 0, 'its applications undone');
    const reversed = await f.trx.selectFrom('journal_entries').select('id').where('reversal_of_entry_id', '=', (await cnRow(f, cn3.id)).journal_entry_id!).executeTakeFirst();
    assert.ok(reversed, 'its entry reversed, not erased');

    // GSTR-1: the notes to a registered buyer are reported with the original invoice's number and date.
    const g = await gstr1(f.trx, f.orgId, '2026-04');
    const reported = g.creditNotes.find((n) => n.id === String(cn.id));
    assert.ok(reported && reported.gstin === '33BBBBB1111B1Z5');
    assert.equal(reported!.againstNumber, inv.number);
    assert.equal(reported!.againstDate, '2026-04-10');
    assert.ok(!g.creditNotes.some((n) => n.id === String(cn3.id)), 'a void note is not reported');
  });
});

test('a credit note sent back by the approver stays a draft, posting nothing', async () => {
  await withFixture(async (f) => {
    const inv = await sell(f, '2026-04-10', 5);
    await saveRule(f.trx, f.orgId, { documentType: 'credit_note', thresholdPaise: 0, approverRole: 'admin', isActive: true });
    const cn = await createCreditNote(f.trx, f.orgId, f.accountant, {
      branchId: f.branchId, customerId: f.customerId, date: '2026-04-15', reason: 'Return', againstInvoiceId: inv.id,
      lines: [{ itemId: f.itemId, qty: 1, ratePaise: 100_000 }],
    });
    await reject(f.trx, f.orgId, { userId: f.admin, role: 'admin' }, 'credit_note', cn.id, 'Goods not received back yet');
    const row = await cnRow(f, cn.id);
    assert.equal(row.status, 'draft');
    assert.equal(row.approval_status, 'rejected');
    assert.equal((await balanceOf(f, inv.id)).owed, 590_000);
  });
});

test('the s.34 time limit: 30 November after the year of the invoice, warned past it', async () => {
  await withFixture(async (f) => {
    assert.equal((await section34Deadline(f.trx, f.orgId, '2025-05-10')).deadline, '2026-11-30');
    assert.equal((await section34Deadline(f.trx, f.orgId, '2026-03-31')).deadline, '2026-11-30');
    assert.equal((await section34Deadline(f.trx, f.orgId, '2026-04-01')).deadline, '2027-11-30');
    // The annual return filed earlier brings it forward.
    await f.trx.insertInto('compliance_filings').values({ org_id: f.orgId, item_key: 'gstr9', period: '2025', done_on: '2026-08-14' }).execute();
    assert.deepEqual(await section34Deadline(f.trx, f.orgId, '2025-05-10'), { deadline: '2026-08-14', why: 'the annual return for 2025-26 was filed on 2026-08-14' });
    const inv = await sell(f, '2025-05-10', 2);
    const late = await createCreditNote(f.trx, f.orgId, f.admin, {
      branchId: f.branchId, customerId: f.customerId, date: '2026-09-01', reason: 'Rate cut', againstInvoiceId: inv.id,
      lines: [{ itemId: f.itemId, qty: 1, ratePaise: 10_000 }],
    });
    assert.ok(late.warnings?.some((w) => /s\.34\(2\)/.test(w) && /2026-08-14/.test(w)));
  });
});

test.after(() => db.destroy());
