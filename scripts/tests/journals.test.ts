// Bill-wise journals, bad debts and the provision for doubtful ones.
//
//   npx tsx --conditions=react-server --env-file=.env.local --test scripts/tests/journals.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';
import { db, type Trx } from '../../lib/server/db';
import { installChartOfAccounts, accountIds, CODE } from '../../lib/server/ledger/chart-of-accounts';
import { verifyLedgerBalances } from '../../lib/server/ledger/posting';
import { createInvoice } from '../../lib/server/services/sales';
import { createBill } from '../../lib/server/services/purchases';
import { adjustProvision, postManualJournal, provisionPlan, reverseJournal, writeOffInvoice } from '../../lib/server/services/journals';
import { ageing } from '../../lib/server/reports/statements';

interface Fixture { trx: Trx; orgId: number; branchId: number; acc: Record<string, number>; customer: number; vendor: number }

async function withFixture(fn: (f: Fixture) => Promise<void>) {
  const rollback = Symbol('rollback');
  try {
    await db.transaction().execute(async (trx) => {
      const orgId = Number((await trx.insertInto('organizations').values({ name: 'Journal Co' }).executeTakeFirstOrThrow()).insertId);
      const branchId = Number((await trx.insertInto('branches').values({ org_id: orgId, name: 'HQ', state_code: '33', is_primary: 1 }).executeTakeFirstOrThrow()).insertId);
      await installChartOfAccounts(trx, orgId);
      const acc = await accountIds(trx, orgId);
      const mk = async (v: Record<string, unknown>) =>
        Number((await trx.insertInto('contacts').values({ org_id: orgId, state_code: '33', gst_treatment: 'unregistered', ...v } as never).executeTakeFirstOrThrow()).insertId);
      await fn({
        trx, orgId, branchId, acc,
        customer: await mk({ kind: 'both', display_name: 'Trading Partner' }),
        vendor: await mk({ kind: 'vendor', display_name: 'Supplier' }),
      });
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

const invoice = (f: Fixture, date: string, due: string, rupees: number) => createInvoice(f.trx, f.orgId, null, {
  branchId: f.branchId, customerId: f.customer, date, dueDate: due, status: 'approved',
  lines: [{ description: 'Goods', qty: 1, ratePaise: rupees * 100, gstRatePct: 0 }],
});
const status = async (f: Fixture, id: number) =>
  (await f.trx.selectFrom('invoices').select(['status', 'amount_paid']).where('id', '=', id).executeTakeFirstOrThrow());

test('a journal against an invoice settles it; reversing the journal reopens it', async () => {
  await withFixture(async (f) => {
    const inv = await invoice(f, '2026-05-01', '2026-05-31', 10_000);
    const bill = await createBill(f.trx, f.orgId, null, {
      branchId: f.branchId, vendorId: f.customer, vendorInvoiceNo: 'TP-1', date: '2026-05-05', dueDate: '2026-06-04',
      lines: [{ description: 'Services', qty: 1, ratePaise: 4_000_00, gstRatePct: 0 }],
    });
    // The same party buys and sells: set the bill off against the invoice.
    const e = await postManualJournal(f.trx, f.orgId, null, {
      branchId: f.branchId, date: '2026-06-10', memo: 'Set-off of mutual dues',
      lines: [
        { accountId: f.acc[CODE.AP], debitPaise: 4_000_00, contactId: f.customer, against: [{ targetType: 'bill', targetId: bill.id, amountPaise: 4_000_00 }] },
        { accountId: f.acc[CODE.AR], creditPaise: 4_000_00, contactId: f.customer, against: [{ targetType: 'invoice', targetId: inv.id, amountPaise: 4_000_00 }] },
      ],
    });
    let s = await status(f, inv.id);
    assert.deepEqual([s.status, Number(s.amount_paid)], ['partially_paid', 4000]);
    const b = await f.trx.selectFrom('bills').select('status').where('id', '=', bill.id).executeTakeFirstOrThrow();
    assert.equal(b.status, 'paid');

    await reverseJournal(f.trx, f.orgId, null, e.id);
    s = await status(f, inv.id);
    assert.equal(Number(s.amount_paid), 0);
    assert.ok((await verifyLedgerBalances(f.trx, f.orgId)).balanced);
  });
});

test('only receivable credits and payable debits settle documents, and never more than the line', async () => {
  await withFixture(async (f) => {
    const inv = await invoice(f, '2026-05-01', '2026-05-31', 1_000);
    await assert.rejects(postManualJournal(f.trx, f.orgId, null, {
      branchId: f.branchId, date: '2026-06-01', memo: 'x',
      lines: [
        { accountId: f.acc[CODE.AR], debitPaise: 100_00, contactId: f.customer, against: [{ targetType: 'invoice', targetId: inv.id, amountPaise: 100_00 }] },
        { accountId: f.acc[CODE.CASH], creditPaise: 100_00 },
      ],
    }), /only a credit to Accounts Receivable/);
    await assert.rejects(postManualJournal(f.trx, f.orgId, null, {
      branchId: f.branchId, date: '2026-06-01', memo: 'x',
      lines: [
        { accountId: f.acc[CODE.CASH], debitPaise: 100_00 },
        { accountId: f.acc[CODE.AR], creditPaise: 100_00, contactId: f.customer, against: [{ targetType: 'invoice', targetId: inv.id, amountPaise: 200_00 }] },
      ],
    }), /more than the line/);
  });
});

test('an accrual reverses itself on the date given, and only a later plain entry may', async () => {
  await withFixture(async (f) => {
    const accrual = await postManualJournal(f.trx, f.orgId, null, {
      branchId: f.branchId, date: '2026-06-30', memo: 'Electricity for June', reverseOn: '2026-07-01',
      lines: [
        { accountId: f.acc[CODE.UTILITIES], debitPaise: 12_000_00 },
        { accountId: f.acc[CODE.PROVISIONS], creditPaise: 12_000_00 },
      ],
    });
    assert.ok('reversalId' in accrual && accrual.reversalId);
    const balance = async (to: string) => {
      const r = await f.trx.selectFrom('journal_lines')
        .select((eb) => eb.fn.sum<string>(eb('debit', '-', eb.ref('credit'))).as('net'))
        .where('org_id', '=', f.orgId).where('account_id', '=', f.acc[CODE.UTILITIES]).where('entry_date', '<=', to)
        .executeTakeFirstOrThrow();
      return Number(r.net ?? 0);
    };
    assert.equal(await balance('2026-06-30'), 12_000, 'June carries the expense');
    assert.equal(await balance('2026-07-01'), 0, 'and July opens with it undone');
    const rev = await f.trx.selectFrom('journal_entries').select(['entry_date', 'memo', 'reversal_of_entry_id']).where('id', '=', Number(accrual.reversalId)).executeTakeFirstOrThrow();
    assert.equal(rev.reversal_of_entry_id, accrual.id);
    assert.match(rev.memo ?? '', /Automatic reversal of: Electricity for June/);

    const lines = [{ accountId: f.acc[CODE.UTILITIES], debitPaise: 100_00 }, { accountId: f.acc[CODE.CASH], creditPaise: 100_00 }];
    await assert.rejects(postManualJournal(f.trx, f.orgId, null, { branchId: f.branchId, date: '2026-06-30', memo: 'x', reverseOn: '2026-06-30', lines }), /later date/);
    const inv = await invoice(f, '2026-05-01', '2026-05-31', 1_000);
    await assert.rejects(postManualJournal(f.trx, f.orgId, null, {
      branchId: f.branchId, date: '2026-06-01', memo: 'x', reverseOn: '2026-07-01',
      lines: [
        { accountId: f.acc[CODE.CASH], debitPaise: 100_00 },
        { accountId: f.acc[CODE.AR], creditPaise: 100_00, contactId: f.customer, against: [{ targetType: 'invoice', targetId: inv.id, amountPaise: 100_00 }] },
      ],
    }), /cannot reverse itself/);
    assert.ok((await verifyLedgerBalances(f.trx, f.orgId)).balanced);
  });
});

test('a bad debt is written off its invoice, and the provision follows the ageing', async () => {
  await withFixture(async (f) => {
    const old = await invoice(f, '2026-01-10', '2026-02-09', 20_000);
    const recent = await invoice(f, '2026-06-01', '2026-07-01', 10_000);

    let plan = await provisionPlan(f.trx, f.orgId, '2026-07-15');
    // 20,000 is over 60 days late: 25%; 10,000 is 14 days late: nothing.
    assert.equal(plan.targetPaise, 5_000_00);
    await adjustProvision(f.trx, f.orgId, null, f.branchId, '2026-07-15');
    plan = await provisionPlan(f.trx, f.orgId, '2026-07-15');
    assert.equal(plan.currentPaise, 5_000_00);
    assert.equal(plan.changePaise, 0);

    await writeOffInvoice(f.trx, f.orgId, null, old.id, { date: '2026-07-31', reason: 'Customer insolvent' });
    assert.equal((await status(f, old.id)).status, 'paid');
    const ag = await ageing(f.trx, f.orgId, 'receivable', '2026-07-31');
    assert.equal(ag.grandTotalPaise, 10_000_00, 'only the recent invoice is still owed');

    // The provision held against the old debt is released.
    plan = await provisionPlan(f.trx, f.orgId, '2026-07-31');
    assert.equal(plan.changePaise, -5_000_00);
    await assert.rejects(writeOffInvoice(f.trx, f.orgId, null, recent.id, { date: '2026-07-31', reason: 'x', amountPaise: 20_000_00 }), /no more than that/);
  });
});

test.after(async () => {
  await db.destroy();
});
